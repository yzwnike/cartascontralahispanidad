import { randomInt, randomUUID } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import { getDb } from './db';
import { GameServiceError } from './game-errors';
import type { CunadometroMode, CunadometroRoom } from './cunadometro';
import { cunadometroPrompts } from './cunadometro-prompts';
import { createPlayerToken } from './player-auth';

const CODE_CHARACTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_PLAYERS = 12;

type RoundPlayer = { id: string; duels_played: number };
type Transaction = TransactionSql;

function assertUuid(value: string, label = 'Identificador de jugador') {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new GameServiceError(`${label} no válido.`);
  }
}

function cleanName(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > 20) {
    throw new GameServiceError('El alias debe tener entre 1 y 20 caracteres.');
  }
  return value.trim();
}

function cleanCode(value: string) {
  const code = value.trim().toUpperCase();
  if (!/^[A-Z2-9]{6}$/.test(code)) throw new GameServiceError('El código de sala debe tener 6 caracteres.');
  return code;
}

function newCode() {
  return Array.from({ length: 6 }, () => CODE_CHARACTERS[randomInt(CODE_CHARACTERS.length)]).join('');
}

function cleanAnswer(value: unknown) {
  if (typeof value !== 'string') throw new GameServiceError('Escribe una respuesta.');
  const answer = value.trim().replace(/\s+/g, ' ');
  if (answer.length < 2 || answer.length > 180) {
    throw new GameServiceError('La respuesta debe tener entre 2 y 180 caracteres.');
  }
  return answer;
}

function normalizeDatabaseError(error: unknown): never {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String(error.code);
    if (code === '23505') throw new GameServiceError('Ya has realizado esta acción.', 409);
    if (code === '23503') throw new GameServiceError('La sala o el jugador indicado ya no existe.', 404);
    if (code === '23502' || code === '22P02') throw new GameServiceError('Los datos enviados no son válidos.');
    if (code.startsWith('08') || ['57P01', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'].includes(code)) {
      throw new GameServiceError('No se pudo conectar con Neon. Comprueba la conexión e inténtalo otra vez.', 503);
    }
  }
  throw error;
}

async function createRound(tx: Transaction, roomId: string, roundNumber: number, players: RoundPlayer[]) {
  const mode: CunadometroMode = roundNumber % 2 === 1 ? 'duel' : 'all_play';
  const usedPrompts = await tx<Array<{ prompt_text: string }>>`
    SELECT prompt_text FROM cunadometro_rounds
    WHERE room_id = ${roomId} AND mode = ${mode}
  `;
  const used = new Set(usedPrompts.map((row) => row.prompt_text.trim().toLowerCase()));
  const candidates = cunadometroPrompts[mode].filter((prompt) => !used.has(prompt.trim().toLowerCase()));
  if (candidates.length === 0) throw new GameServiceError('Se han agotado las consignas de esta modalidad.', 503);
  const prompt = candidates[randomInt(candidates.length)];
  let duelPlayerIds: string[] = [];

  if (mode === 'duel') {
    const fewestDuels = Math.min(...players.map((player) => player.duels_played));
    const eligible = players.filter((player) => player.duels_played === fewestDuels);
    const first = eligible.splice(randomInt(eligible.length), 1)[0];
    if (eligible.length === 0) {
      const nextFewest = Math.min(...players.filter((player) => player.id !== first.id).map((player) => player.duels_played));
      eligible.push(...players.filter((player) => player.id !== first.id && player.duels_played === nextFewest));
    }
    const second = eligible[randomInt(eligible.length)];
    duelPlayerIds = [first.id, second.id];
    await tx`
      UPDATE cunadometro_players SET duels_played = duels_played + 1
      WHERE id = ANY(${duelPlayerIds}::uuid[]) AND room_id = ${roomId}
    `;
  }

  await tx`
    INSERT INTO cunadometro_rounds
      (room_id, round_number, mode, prompt_text, status, duel_player_ids)
    VALUES (${roomId}, ${roundNumber}, ${mode}, ${prompt}, 'answering', ${duelPlayerIds}::uuid[])
  `;
}

export async function createCunadometroRoom(rawName: unknown) {
  const name = cleanName(rawName);
  const playerId = randomUUID();
  const playerToken = createPlayerToken(playerId);
  const db = getDb();

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newCode();
    try {
      await db.begin(async (tx) => {
        const [room] = await tx<Array<{ id: string }>>`
          INSERT INTO cunadometro_rooms (code, status, rounds_limit)
          VALUES (${code}, 'waiting', 10)
          RETURNING id
        `;
        await tx`
          INSERT INTO cunadometro_players (id, room_id, name, score, is_host, duels_played)
          VALUES (${playerId}, ${room.id}, ${name}, 0, true, 0)
        `;
      });
      return { room: await getCunadometroRoom(code, playerId), playerId, playerToken };
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505' && attempt < 4) continue;
      return normalizeDatabaseError(error);
    }
  }
  throw new GameServiceError('No se pudo generar un código de sala único.', 503);
}

export async function joinCunadometroRoom(rawCode: string, rawName: unknown) {
  const code = cleanCode(rawCode);
  const name = cleanName(rawName);
  const playerId = randomUUID();
  const playerToken = createPlayerToken(playerId);
  try {
    await getDb().begin(async (tx) => {
      const [room] = await tx<Array<{ id: string; status: string }>>`
        SELECT id, status FROM cunadometro_rooms WHERE code = ${code} FOR UPDATE
      `;
      if (!room) throw new GameServiceError('No encontramos esa sala.', 404);
      if (room.status !== 'waiting') throw new GameServiceError('La partida ya ha empezado y no admite más gente.', 409);
      const [duplicate] = await tx<Array<{ exists: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM cunadometro_players
          WHERE room_id = ${room.id} AND lower(name) = lower(${name})
        ) AS exists
      `;
      if (duplicate?.exists) throw new GameServiceError('Ya hay alguien con ese alias en la sala.', 409);
      const [count] = await tx<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM cunadometro_players WHERE room_id = ${room.id}
      `;
      if (count.count >= MAX_PLAYERS) throw new GameServiceError('La sala está llena (máximo 12 personas).', 409);
      await tx`
        INSERT INTO cunadometro_players (id, room_id, name, score, is_host, duels_played)
        VALUES (${playerId}, ${room.id}, ${name}, 0, false, 0)
      `;
    });
    return { room: await getCunadometroRoom(code, playerId), playerId, playerToken };
  } catch (error) {
    return normalizeDatabaseError(error);
  }
}

export async function getCunadometroRoom(rawCode: string, rawPlayerId: string): Promise<CunadometroRoom> {
  const code = cleanCode(rawCode);
  assertUuid(rawPlayerId);
  try {
    const db = getDb();
    const [room] = await db<Array<{ id: string; code: string; status: CunadometroRoom['status']; rounds_limit: 5 | 10 | 20; round_number: number }>>`
      SELECT id, code, status, rounds_limit, round_number
      FROM cunadometro_rooms WHERE code = ${code}
    `;
    if (!room) throw new GameServiceError('No encontramos esa sala.', 404);
    const players = await db<Array<{ id: string; name: string; score: number; is_host: boolean; duels_played: number }>>`
      SELECT id, name, score, is_host, duels_played
      FROM cunadometro_players
      WHERE room_id = ${room.id}
      ORDER BY created_at, id
    `;
    const me = players.find((player) => player.id === rawPlayerId);
    if (!me) throw new GameServiceError('No formas parte de esta sala.', 403);
    const publicPlayers = players.map((player) => ({
      id: player.id,
      name: player.name,
      score: player.score,
      isHost: player.is_host,
      duelsPlayed: player.duels_played,
    }));

    if (room.status === 'waiting') {
      return { id: room.id, code: room.code, status: room.status, roundsLimit: room.rounds_limit, players: publicPlayers, round: null };
    }

    const [round] = await db<Array<{
      round_number: number; mode: CunadometroMode; prompt_text: string; status: 'answering' | 'voting' | 'resolved';
      duel_player_ids: string[];
    }>>`
      SELECT round_number, mode, prompt_text, status, duel_player_ids
      FROM cunadometro_rounds
      WHERE room_id = ${room.id} AND round_number = ${room.round_number}
    `;
    if (!round) throw new GameServiceError('No encontramos la ronda actual.', 500);

    const [answers, votes] = await Promise.all([
      db<Array<{ id: string; player_id: string; text: string; is_winner: boolean }>>`
        SELECT id, player_id, answer_text AS text, is_winner
        FROM cunadometro_answers
        WHERE room_id = ${room.id} AND round_number = ${room.round_number}
        ORDER BY created_at, id
      `,
      db<Array<{ voter_player_id: string; voter_name: string; answer_id: string }>>`
        SELECT v.voter_player_id, p.name AS voter_name, v.answer_id
        FROM cunadometro_votes v
        JOIN cunadometro_players p ON p.id = v.voter_player_id
        WHERE v.room_id = ${room.id} AND v.round_number = ${room.round_number}
      `,
    ]);

    const duelPlayerIds = round.duel_player_ids ?? [];
    const eligibleVoterCount = round.mode === 'duel'
      ? players.length - duelPlayerIds.length
      : players.length;
    const expectedAnswerCount = round.mode === 'duel' ? duelPlayerIds.length : players.length;
    const allAnswersIn = answers.length === expectedAnswerCount;
    const votesRevealed = round.status === 'resolved' && votes.length === eligibleVoterCount;
    const voteCounts: Record<string, number> = {};
    for (const answer of answers) voteCounts[answer.id] = 0;
    if (votesRevealed) {
      for (const vote of votes) voteCounts[vote.answer_id] = (voteCounts[vote.answer_id] ?? 0) + 1;
    }

    return {
      id: room.id,
      code: room.code,
      status: room.status,
      roundsLimit: room.rounds_limit,
      players: publicPlayers,
      round: {
        number: round.round_number,
        mode: round.mode,
        prompt: round.prompt_text,
        status: round.status,
        duelPlayerIds,
        answers: allAnswersIn
          ? answers.map((answer) => ({
              id: answer.id,
              playerId: round.status === 'resolved' ? answer.player_id : null,
              text: answer.text,
              isWinner: answer.is_winner,
            }))
          : [],
        submittedCount: answers.length,
        eligibleVoterCount,
        votesSubmittedCount: votes.length,
        myAnswerId: answers.find((answer) => answer.player_id === rawPlayerId)?.id ?? null,
        myVoteId: votes.find((vote) => vote.voter_player_id === rawPlayerId)?.answer_id ?? null,
        votesRevealed,
        voteCounts: votesRevealed ? voteCounts : {},
        publicVotes: votesRevealed
          ? votes.map((vote) => ({ voterId: vote.voter_player_id, voterName: vote.voter_name, answerId: vote.answer_id }))
          : [],
        winnerIds: votesRevealed ? answers.filter((answer) => answer.is_winner).map((answer) => answer.player_id) : [],
      },
    };
  } catch (error) {
    return normalizeDatabaseError(error);
  }
}

export async function startCunadometroRoom(rawCode: string, rawPlayerId: string, rawRoundsLimit: unknown) {
  const code = cleanCode(rawCode);
  assertUuid(rawPlayerId);
  if (rawRoundsLimit !== 5 && rawRoundsLimit !== 10 && rawRoundsLimit !== 20) {
    throw new GameServiceError('Elige una partida de 5, 10 o 20 rondas.');
  }
  try {
    await getDb().begin(async (tx) => {
      const [room] = await tx<Array<{ id: string; status: string }>>`
        SELECT id, status FROM cunadometro_rooms WHERE code = ${code} FOR UPDATE
      `;
      if (!room) throw new GameServiceError('No encontramos esa sala.', 404);
      const [host] = await tx<Array<{ is_host: boolean }>>`
        SELECT is_host FROM cunadometro_players WHERE id = ${rawPlayerId} AND room_id = ${room.id}
      `;
      if (!host) throw new GameServiceError('No formas parte de esta sala.', 403);
      if (!host.is_host) throw new GameServiceError('Solo quien creó la sala puede empezar.', 403);
      if (room.status !== 'waiting') throw new GameServiceError('La partida ya ha empezado.', 409);
      const players = await tx<RoundPlayer[]>`
        SELECT id, duels_played FROM cunadometro_players
        WHERE room_id = ${room.id} ORDER BY created_at, id
      `;
      if (players.length < 3) throw new GameServiceError('Para jugar hace falta un mínimo de 3 personas.', 409);
      await tx`
        UPDATE cunadometro_rooms
        SET status = 'playing', round_number = 1, rounds_limit = ${rawRoundsLimit}
        WHERE id = ${room.id}
      `;
      await createRound(tx, room.id, 1, players);
    });
    return getCunadometroRoom(code, rawPlayerId);
  } catch (error) {
    return normalizeDatabaseError(error);
  }
}

export async function submitCunadometroAnswer(rawCode: string, rawPlayerId: string, rawText: unknown) {
  const code = cleanCode(rawCode);
  assertUuid(rawPlayerId);
  const text = cleanAnswer(rawText);
  try {
    await getDb().begin(async (tx) => {
      const [room] = await tx<Array<{ id: string; status: string; round_number: number }>>`
        SELECT id, status, round_number FROM cunadometro_rooms WHERE code = ${code} FOR UPDATE
      `;
      if (!room || room.status !== 'playing') throw new GameServiceError('Esta partida no acepta respuestas.', room ? 409 : 404);
      const [round] = await tx<Array<{ mode: CunadometroMode; status: string; duel_player_ids: string[] }>>`
        SELECT mode, status, duel_player_ids FROM cunadometro_rounds
        WHERE room_id = ${room.id} AND round_number = ${room.round_number} FOR UPDATE
      `;
      if (!round || round.status !== 'answering') throw new GameServiceError('La fase de respuestas ya se ha cerrado.', 409);
      const [player] = await tx<Array<{ id: string }>>`
        SELECT id FROM cunadometro_players WHERE room_id = ${room.id} AND id = ${rawPlayerId}
      `;
      if (!player) throw new GameServiceError('No formas parte de esta sala.', 403);
      if (round.mode === 'duel' && !round.duel_player_ids.includes(rawPlayerId)) {
        throw new GameServiceError('Esta ronda es un duelo: esta vez te toca votar.', 409);
      }
      await tx`
        INSERT INTO cunadometro_answers (room_id, round_number, player_id, answer_text)
        VALUES (${room.id}, ${room.round_number}, ${rawPlayerId}, ${text})
      `;
      const expected = round.mode === 'duel' ? round.duel_player_ids.length : (await tx<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM cunadometro_players WHERE room_id = ${room.id}
      `)[0].count;
      const [count] = await tx<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM cunadometro_answers
        WHERE room_id = ${room.id} AND round_number = ${room.round_number}
      `;
      if (count.count === expected) {
        await tx`
          UPDATE cunadometro_rounds SET status = 'voting'
          WHERE room_id = ${room.id} AND round_number = ${room.round_number}
        `;
      }
    });
    return getCunadometroRoom(code, rawPlayerId);
  } catch (error) {
    return normalizeDatabaseError(error);
  }
}

export async function voteCunadometroAnswer(rawCode: string, rawPlayerId: string, rawAnswerId: string) {
  const code = cleanCode(rawCode);
  assertUuid(rawPlayerId);
  assertUuid(rawAnswerId, 'Identificador de respuesta');
  try {
    await getDb().begin(async (tx) => {
      const [room] = await tx<Array<{ id: string; status: string; round_number: number }>>`
        SELECT id, status, round_number FROM cunadometro_rooms WHERE code = ${code} FOR UPDATE
      `;
      if (!room || room.status !== 'playing') throw new GameServiceError('La partida no está en votación.', room ? 409 : 404);
      const [round] = await tx<Array<{ mode: CunadometroMode; status: string; duel_player_ids: string[] }>>`
        SELECT mode, status, duel_player_ids FROM cunadometro_rounds
        WHERE room_id = ${room.id} AND round_number = ${room.round_number} FOR UPDATE
      `;
      if (!round || round.status !== 'voting') throw new GameServiceError('Aún no se puede votar.', 409);
      const [voter] = await tx<Array<{ id: string }>>`
        SELECT id FROM cunadometro_players WHERE room_id = ${room.id} AND id = ${rawPlayerId}
      `;
      if (!voter) throw new GameServiceError('No formas parte de esta sala.', 403);
      if (round.mode === 'duel' && round.duel_player_ids.includes(rawPlayerId)) {
        throw new GameServiceError('Quienes juegan el duelo no votan esa ronda.', 403);
      }
      const [answer] = await tx<Array<{ player_id: string }>>`
        SELECT player_id FROM cunadometro_answers
        WHERE room_id = ${room.id} AND round_number = ${room.round_number} AND id = ${rawAnswerId}
      `;
      if (!answer) throw new GameServiceError('Esa respuesta no pertenece a esta ronda.', 404);
      if (answer.player_id === rawPlayerId) throw new GameServiceError('No puedes votar tu propia respuesta.', 403);
      await tx`
        INSERT INTO cunadometro_votes (room_id, round_number, voter_player_id, answer_id)
        VALUES (${room.id}, ${room.round_number}, ${rawPlayerId}, ${rawAnswerId})
      `;
      const eligibleCount = round.mode === 'duel'
        ? (await tx<Array<{ count: number }>>`SELECT count(*)::int AS count FROM cunadometro_players WHERE room_id = ${room.id}`)[0].count - 2
        : (await tx<Array<{ count: number }>>`SELECT count(*)::int AS count FROM cunadometro_players WHERE room_id = ${room.id}`)[0].count;
      const [voteCount] = await tx<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM cunadometro_votes
        WHERE room_id = ${room.id} AND round_number = ${room.round_number}
      `;
      if (voteCount.count !== eligibleCount) return;

      const tallies = await tx<Array<{ player_id: string; vote_count: number }>>`
        SELECT a.player_id, count(v.answer_id)::int AS vote_count
        FROM cunadometro_answers a
        LEFT JOIN cunadometro_votes v
          ON v.room_id = a.room_id AND v.round_number = a.round_number AND v.answer_id = a.id
        WHERE a.room_id = ${room.id} AND a.round_number = ${room.round_number}
        GROUP BY a.player_id
        ORDER BY vote_count DESC
      `;
      const highest = tallies[0]?.vote_count ?? 0;
      const winners = tallies.filter((entry) => entry.vote_count === highest).map((entry) => entry.player_id);
      if (winners.length === 0) throw new GameServiceError('No hay votos para resolver esta ronda.', 409);
      await tx`
        UPDATE cunadometro_answers SET is_winner = (player_id = ANY(${winners}::uuid[]))
        WHERE room_id = ${room.id} AND round_number = ${room.round_number}
      `;
      await tx`
        UPDATE cunadometro_players SET score = score + 1
        WHERE room_id = ${room.id} AND id = ANY(${winners}::uuid[])
      `;
      await tx`
        UPDATE cunadometro_rounds SET status = 'resolved'
        WHERE room_id = ${room.id} AND round_number = ${room.round_number}
      `;
    });
    return getCunadometroRoom(code, rawPlayerId);
  } catch (error) {
    return normalizeDatabaseError(error);
  }
}

export async function nextCunadometroRound(rawCode: string, rawPlayerId: string) {
  const code = cleanCode(rawCode);
  assertUuid(rawPlayerId);
  try {
    await getDb().begin(async (tx) => {
      const [room] = await tx<Array<{ id: string; status: string; round_number: number; rounds_limit: number }>>`
        SELECT id, status, round_number, rounds_limit
        FROM cunadometro_rooms WHERE code = ${code} FOR UPDATE
      `;
      if (!room) throw new GameServiceError('No encontramos esa sala.', 404);
      const [player] = await tx<Array<{ id: string }>>`
        SELECT id FROM cunadometro_players WHERE id = ${rawPlayerId} AND room_id = ${room.id}
      `;
      if (!player) throw new GameServiceError('No formas parte de esta sala.', 403);
      if (room.status !== 'playing') throw new GameServiceError('Esta partida ya está cerrada.', 409);
      const [round] = await tx<Array<{ status: string }>>`
        SELECT status FROM cunadometro_rounds
        WHERE room_id = ${room.id} AND round_number = ${room.round_number}
      `;
      if (round?.status !== 'resolved') throw new GameServiceError('Primero debe terminar la votación.', 409);
      if (room.round_number >= room.rounds_limit) {
        await tx`UPDATE cunadometro_rooms SET status = 'finished' WHERE id = ${room.id}`;
        return;
      }
      const players = await tx<RoundPlayer[]>`
        SELECT id, duels_played FROM cunadometro_players
        WHERE room_id = ${room.id} ORDER BY created_at, id
      `;
      const nextNumber = room.round_number + 1;
      await tx`UPDATE cunadometro_rooms SET round_number = ${nextNumber} WHERE id = ${room.id}`;
      await createRound(tx, room.id, nextNumber, players);
    });
    return getCunadometroRoom(code, rawPlayerId);
  } catch (error) {
    return normalizeDatabaseError(error);
  }
}

export async function leaveCunadometroRoom(rawCode: string, rawPlayerId: string) {
  const code = cleanCode(rawCode);
  assertUuid(rawPlayerId);
  try {
    await getDb().begin(async (tx) => {
      const [room] = await tx<Array<{ id: string; status: string }>>`
        SELECT id, status FROM cunadometro_rooms WHERE code = ${code} FOR UPDATE
      `;
      if (!room) return;
      if (room.status === 'playing') {
        throw new GameServiceError('No puedes abandonar una partida en curso. Puedes volver a esta sala desde este dispositivo.', 409);
      }
      const [player] = await tx<Array<{ is_host: boolean }>>`
        SELECT is_host FROM cunadometro_players WHERE room_id = ${room.id} AND id = ${rawPlayerId} FOR UPDATE
      `;
      if (!player) return;
      await tx`DELETE FROM cunadometro_players WHERE room_id = ${room.id} AND id = ${rawPlayerId}`;
      const remaining = await tx<Array<{ id: string }>>`
        SELECT id FROM cunadometro_players WHERE room_id = ${room.id} ORDER BY created_at, id
      `;
      if (remaining.length === 0) {
        await tx`DELETE FROM cunadometro_rooms WHERE id = ${room.id}`;
      } else if (player.is_host) {
        await tx`
          UPDATE cunadometro_players SET is_host = (id = ${remaining[0].id})
          WHERE room_id = ${room.id}
        `;
      }
    });
  } catch (error) {
    return normalizeDatabaseError(error);
  }
}
