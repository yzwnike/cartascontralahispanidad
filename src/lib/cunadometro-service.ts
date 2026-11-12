import { randomInt, randomUUID } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import { getDb } from './db';
import { GameServiceError } from './game-errors';
import type { CunadometroMode, CunadometroPhase, CunadometroRoom, CunadometroStage } from './cunadometro';
import { createPlayerToken } from './player-auth';
import type { GameLength } from './cunadometro-length';
import { getRevealVoteDelay } from './cunadometro-reveal';
import { createGameSchedule } from './cunadometro-schedule';

const MAX_PLAYERS = 12;

type RoundPlayer = { id: string; duels_played: number };
type Transaction = TransactionSql;

async function reassignUnansweredDuels(
  tx: Transaction,
  roomId: string,
  leavingPlayerId: string,
  activePlayerIds: string[],
  phases: CunadometroPhase[],
) {
  for (const phase of phases) {
    const appearances = new Map(activePlayerIds.map((id) => [id, 0]));
    const rounds = await tx<Array<{
      round_number: number; duel_player_ids: string[]; status: 'answering' | 'voting' | 'resolved';
    }>>`
      SELECT round_number, duel_player_ids, status FROM cunadometro_rounds
      WHERE room_id = ${roomId} AND phase = ${phase}
      ORDER BY round_number
    `;
    for (const round of rounds) {
      for (const id of round.duel_player_ids) {
        if (id !== leavingPlayerId && appearances.has(id)) appearances.set(id, (appearances.get(id) ?? 0) + 1);
      }
    }
    for (const round of rounds) {
      if (round.status !== 'answering') continue;
      if (!round.duel_player_ids.includes(leavingPlayerId)) continue;
      const opponent = round.duel_player_ids.find((id) => id !== leavingPlayerId);
      const candidates = activePlayerIds.filter((id) => id !== opponent);
      if (!opponent || candidates.length === 0) continue;
      const fewest = Math.min(...candidates.map((id) => appearances.get(id) ?? 0));
      const eligible = candidates.filter((id) => (appearances.get(id) ?? 0) === fewest);
      const replacement = eligible[randomInt(eligible.length)];
      const duelPlayerIds = round.duel_player_ids.map((id) => id === leavingPlayerId ? replacement : id);
      await tx`
        UPDATE cunadometro_rounds SET duel_player_ids = ${duelPlayerIds}::uuid[]
        WHERE room_id = ${roomId} AND round_number = ${round.round_number}
      `;
      await tx`
        DELETE FROM cunadometro_answers
        WHERE room_id = ${roomId} AND round_number = ${round.round_number}
      `;
      appearances.set(replacement, (appearances.get(replacement) ?? 0) + 1);
    }
  }
  await tx`
    UPDATE cunadometro_players p
    SET duels_played = (
      SELECT count(*)::int FROM cunadometro_rounds r
      WHERE r.room_id = p.room_id AND p.id = ANY(r.duel_player_ids)
    )
    WHERE p.room_id = ${roomId} AND p.is_active = true
  `;
}

async function resolveRound(tx: Transaction, roomId: string, roundNumber: number) {
  const tallies = await tx<Array<{ player_id: string; vote_count: number }>>`
    SELECT a.player_id, count(v.answer_id)::int AS vote_count
    FROM cunadometro_answers a
    LEFT JOIN cunadometro_votes v
      ON v.room_id = a.room_id AND v.round_number = a.round_number AND v.answer_id = a.id
    WHERE a.room_id = ${roomId} AND a.round_number = ${roundNumber}
    GROUP BY a.player_id
    ORDER BY vote_count DESC
  `;
  const highest = tallies[0]?.vote_count ?? 0;
  const winners = tallies.filter((entry) => entry.vote_count === highest).map((entry) => entry.player_id);
  if (winners.length === 0) throw new GameServiceError('No hay votos para resolver esta ronda.', 409);
  await tx`
    UPDATE cunadometro_answers SET is_winner = (player_id = ANY(${winners}::uuid[]))
    WHERE room_id = ${roomId} AND round_number = ${roundNumber}
  `;
  await tx`
    UPDATE cunadometro_players SET score = score + 1
    WHERE room_id = ${roomId} AND id = ANY(${winners}::uuid[]) AND is_active = true
  `;
  await tx`
    UPDATE cunadometro_rounds SET status = 'resolved'
    WHERE room_id = ${roomId} AND round_number = ${roundNumber}
  `;
}

function shufflePrompts(prompts: string[]) {
  const shuffled = [...prompts];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const swapIndex = randomInt(index + 1);
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

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
  if (!/^\d{3}$/.test(code) && !/^[A-Z2-9]{6}$/.test(code)) {
    throw new GameServiceError('El código de sala debe tener tres dígitos.');
  }
  return code;
}

function newCode(activeCodes: string[]) {
  const active = new Set(activeCodes);
  const available = Array.from({ length: 1000 }, (_, value) => String(value).padStart(3, '0'))
    .filter((code) => !active.has(code));
  if (available.length === 0) throw new GameServiceError('No quedan códigos libres para crear una sala.', 503);
  return available[randomInt(available.length)];
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
  const promptRows = await tx<Array<{ prompt_text: string }>>`
    SELECT prompt_text FROM cunadometro_prompts
    WHERE mode = ${mode} AND is_active = true
  `;
  const candidates = promptRows
    .map((row) => row.prompt_text)
    .filter((prompt) => !used.has(prompt.trim().toLowerCase()));
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

  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      let code = '';
      await db.begin(async (tx) => {
        await tx`
          DELETE FROM cunadometro_rooms
          WHERE status = 'finished' AND finished_at < now() - interval '24 hours'
        `;
        const existingRooms = await tx<Array<{ code: string }>>`SELECT code FROM cunadometro_rooms`;
        code = newCode(existingRooms.map((room) => room.code));
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
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505' && attempt < 49) continue;
      return normalizeDatabaseError(error);
    }
  }
  throw new GameServiceError('No se pudo generar un código de sala único.', 503);
}

export async function joinCunadometroRoom(rawCode: string, rawName: unknown) {
  const code = cleanCode(rawCode);
  if (!/^\d{3}$/.test(code)) throw new GameServiceError('El código de sala debe tener tres dígitos.');
  const name = cleanName(rawName);
  const playerId = randomUUID();
  const playerToken = createPlayerToken(playerId);
  try {
    await getDb().begin(async (tx) => {
      const [room] = await tx<Array<{ id: string; status: string }>>`
        SELECT id, status FROM cunadometro_rooms WHERE code = ${code} AND status = 'waiting' FOR UPDATE
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
    const [room] = await db<Array<{
      id: string; code: string; status: CunadometroRoom['status']; rounds_limit: GameLength;
      round_number: number; game_stage: CunadometroStage;
    }>>`
      SELECT id, code, status, rounds_limit, round_number, game_stage
      FROM cunadometro_rooms
      WHERE code = ${code}
        AND EXISTS (
          SELECT 1 FROM cunadometro_players p WHERE p.room_id = cunadometro_rooms.id AND p.id = ${rawPlayerId}::uuid
        )
    `;
    if (!room) throw new GameServiceError('No encontramos esa sala.', 404);
    const players = await db<Array<{ id: string; name: string; score: number; is_host: boolean; duels_played: number; is_active: boolean }>>`
      SELECT id, name, score, is_host, duels_played, is_active
      FROM cunadometro_players
      WHERE room_id = ${room.id}
      ORDER BY created_at, id
    `;
    const me = players.find((player) => player.id === rawPlayerId);
    if (!me || !me.is_active) throw new GameServiceError('No formas parte de esta sala.', 403);
    const activePlayers = players.filter((player) => player.is_active);
    const publicPlayers = players.map((player) => ({
      id: player.id,
      name: player.name,
      score: player.score,
      isHost: player.is_host,
      duelsPlayed: player.duels_played,
      isActive: player.is_active,
    }));

    if (room.status === 'waiting') {
      return {
        id: room.id, code: room.code, status: room.status, gameLength: room.rounds_limit,
        gameStage: 'lobby', roundsLimit: room.rounds_limit, players: publicPlayers, round: null,
      };
    }

    const [round] = await db<Array<{
      round_number: number; mode: CunadometroMode; phase: CunadometroPhase; prompt_text: string;
      status: 'answering' | 'voting' | 'resolved'; duel_player_ids: string[]; reveal_started_at: Date | null;
    }>>`
      SELECT round_number, mode, phase, prompt_text, status, duel_player_ids, reveal_started_at
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
        WHERE v.room_id = ${room.id} AND v.round_number = ${room.round_number} AND p.is_active = true
      `,
    ]);
    const [scheduledRounds] = await db<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM cunadometro_rounds WHERE room_id = ${room.id}
    `;

    const legacy = room.game_stage === 'legacy';
    const phase: CunadometroPhase = legacy ? 'legacy' : round.phase;
    const duelTasks = !legacy && (room.game_stage === 'opening_answers' || room.game_stage === 'closing_answers')
      ? await db<Array<{ round_number: number; prompt_text: string; answer_text: string | null }>>`
        SELECT r.round_number, r.prompt_text, a.answer_text
        FROM cunadometro_rounds r
        JOIN unnest(r.duel_player_ids) AS assigned(player_id) ON assigned.player_id = ${rawPlayerId}::uuid
        LEFT JOIN cunadometro_answers a
          ON a.room_id = r.room_id AND a.round_number = r.round_number AND a.player_id = ${rawPlayerId}::uuid
        WHERE r.room_id = ${room.id}
          AND r.phase = ${room.game_stage === 'opening_answers' ? 'opening_duels' : 'closing_duels'}
        ORDER BY r.round_number
      `
      : [];
    const phaseAnswers = !legacy && (room.game_stage === 'opening_answers' || room.game_stage === 'closing_answers')
      ? await db<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM cunadometro_answers a
        JOIN cunadometro_rounds r ON r.room_id = a.room_id AND r.round_number = a.round_number
        WHERE a.room_id = ${room.id}
          AND r.phase = ${room.game_stage === 'opening_answers' ? 'opening_duels' : 'closing_duels'}
      `
      : [];
    const phaseRounds = !legacy && (room.game_stage === 'opening_answers' || room.game_stage === 'closing_answers')
      ? await db<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM cunadometro_rounds
        WHERE room_id = ${room.id}
          AND phase = ${room.game_stage === 'opening_answers' ? 'opening_duels' : 'closing_duels'}
      `
      : [];
    const duelPlayerIds = round.duel_player_ids ?? [];
    const activeDuelPlayerCount = duelPlayerIds.filter((id) => activePlayers.some((player) => player.id === id)).length;
    const eligibleVoterCount = round.mode === 'duel'
      ? activePlayers.length - activeDuelPlayerCount
      : activePlayers.length;
    const expectedAnswerCount = round.mode === 'duel' ? activeDuelPlayerCount : activePlayers.length;
    const allAnswersIn = round.status !== 'answering' || answers.length === expectedAnswerCount;
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
      gameLength: room.rounds_limit,
      gameStage: room.game_stage,
      roundsLimit: legacy ? room.rounds_limit : scheduledRounds.count,
      players: publicPlayers,
      round: {
        number: round.round_number,
        mode: round.mode,
        phase,
        prompt: round.prompt_text,
        status: round.status,
        duelPlayerIds,
        revealStartedAt: round.reveal_started_at?.toISOString() ?? null,
        answers: allAnswersIn && round.status !== 'answering'
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
        myDuelTasks: duelTasks.map((task) => ({
          number: task.round_number,
          prompt: task.prompt_text,
          answerText: task.answer_text,
        })),
        phaseSubmittedCount: phaseAnswers[0]?.count ?? 0,
        phaseExpectedCount: (phaseRounds[0]?.count ?? 0) * 2,
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
    throw new GameServiceError('Elige una partida rápida, media o larga.');
  }
  try {
    await getDb().begin(async (tx) => {
      const [room] = await tx<Array<{ id: string; status: string }>>`
        SELECT id, status FROM cunadometro_rooms WHERE code = ${code} AND status <> 'finished' FOR UPDATE
      `;
      if (!room) throw new GameServiceError('No encontramos esa sala.', 404);
      const [host] = await tx<Array<{ is_host: boolean }>>`
        SELECT is_host FROM cunadometro_players
        WHERE id = ${rawPlayerId} AND room_id = ${room.id} AND is_active = true
      `;
      if (!host) throw new GameServiceError('No formas parte de esta sala.', 403);
      if (!host.is_host) throw new GameServiceError('Solo quien creó la sala puede empezar.', 403);
      if (room.status !== 'waiting') throw new GameServiceError('La partida ya ha empezado.', 409);
      const players = await tx<RoundPlayer[]>`
        SELECT id, duels_played FROM cunadometro_players
        WHERE room_id = ${room.id} AND is_active = true ORDER BY created_at, id
      `;
      if (players.length < 3) throw new GameServiceError('Para jugar hace falta un mínimo de 3 personas.', 409);

      const gameLength = rawRoundsLimit as GameLength;
      const schedule = createGameSchedule(players.map((player) => player.id), gameLength);
      const usedPrompts = await tx<Array<{ prompt_text: string }>>`
        SELECT prompt_text FROM cunadometro_rounds WHERE room_id = ${room.id}
      `;
      const used = new Set(usedPrompts.map((row) => row.prompt_text.trim().toLowerCase()));
      const promptRows = await tx<Array<{ mode: CunadometroMode; prompt_text: string }>>`
        SELECT mode, prompt_text FROM cunadometro_prompts WHERE is_active = true
      `;
      const promptPool = {
        duel: promptRows
          .filter((row) => row.mode === 'duel' && !used.has(row.prompt_text.trim().toLowerCase()))
          .map((row) => row.prompt_text),
        all_play: promptRows
          .filter((row) => row.mode === 'all_play' && !used.has(row.prompt_text.trim().toLowerCase()))
          .map((row) => row.prompt_text),
      };
      const required = {
        duel: schedule.filter((entry) => entry.mode === 'duel').length,
        all_play: schedule.filter((entry) => entry.mode === 'all_play').length,
      };
      if (promptPool.duel.length < required.duel || promptPool.all_play.length < required.all_play) {
        throw new GameServiceError('No hay suficientes consignas distintas para esa duración. Elige una partida más corta.', 409);
      }

      const shuffledPrompts = {
        duel: shufflePrompts(promptPool.duel),
        all_play: shufflePrompts(promptPool.all_play),
      };
      await tx`
        UPDATE cunadometro_rooms
        SET status = 'playing', game_stage = 'opening_answers', round_number = 1, rounds_limit = ${rawRoundsLimit}
        WHERE id = ${room.id}
      `;
      const promptOffsets = { duel: 0, all_play: 0 };
      for (const [index, entry] of schedule.entries()) {
        const prompt = shuffledPrompts[entry.mode][promptOffsets[entry.mode]++];
        await tx`
          INSERT INTO cunadometro_rounds
            (room_id, round_number, mode, phase, prompt_text, status, duel_player_ids)
          VALUES
            (${room.id}, ${index + 1}, ${entry.mode}, ${entry.phase}, ${prompt}, 'answering', ${entry.duelPlayerIds}::uuid[])
        `;
      }
      await tx`
        UPDATE cunadometro_players SET duels_played = ${schedule.filter((entry) => entry.mode === 'duel').length * 2 / players.length}
        WHERE room_id = ${room.id}
      `;
    });
    return getCunadometroRoom(code, rawPlayerId);
  } catch (error) {
    return normalizeDatabaseError(error);
  }
}

export async function submitCunadometroAnswer(
  rawCode: string,
  rawPlayerId: string,
  rawText: unknown,
  rawRoundNumber?: unknown,
) {
  const code = cleanCode(rawCode);
  assertUuid(rawPlayerId);
  const text = cleanAnswer(rawText);
  if (rawRoundNumber !== undefined && (typeof rawRoundNumber !== 'number' || !Number.isInteger(rawRoundNumber) || rawRoundNumber < 1)) {
    throw new GameServiceError('Número de ronda no válido.');
  }
  try {
    await getDb().begin(async (tx) => {
      const [room] = await tx<Array<{ id: string; status: string; round_number: number; game_stage: CunadometroStage }>>`
        SELECT id, status, round_number, game_stage FROM cunadometro_rooms
        WHERE code = ${code} AND status <> 'finished' FOR UPDATE
      `;
      if (!room || room.status !== 'playing') throw new GameServiceError('Esta partida no acepta respuestas.', room ? 409 : 404);
      const roundNumber = rawRoundNumber === undefined ? room.round_number : Number(rawRoundNumber);
      const [round] = await tx<Array<{
        mode: CunadometroMode; phase: CunadometroPhase; status: string; duel_player_ids: string[];
      }>>`
        SELECT mode, phase, status, duel_player_ids FROM cunadometro_rounds
        WHERE room_id = ${room.id} AND round_number = ${roundNumber} FOR UPDATE
      `;
      if (!round || round.status !== 'answering') throw new GameServiceError('La fase de respuestas ya se ha cerrado.', 409);
      if (room.game_stage === 'legacy' && roundNumber !== room.round_number) {
        throw new GameServiceError('La fase de respuestas ya se ha cerrado.', 409);
      }
      const [player] = await tx<Array<{ id: string }>>`
        SELECT id FROM cunadometro_players
        WHERE room_id = ${room.id} AND id = ${rawPlayerId} AND is_active = true
      `;
      if (!player) throw new GameServiceError('No formas parte de esta sala.', 403);
      if (round.mode === 'duel' && !round.duel_player_ids.includes(rawPlayerId)) {
        throw new GameServiceError('Este duelo no te corresponde.', 409);
      }
      if (room.game_stage === 'opening_answers' && round.phase !== 'opening_duels') {
        throw new GameServiceError('Aún no se ha abierto esta fase de duelos.', 409);
      }
      if (room.game_stage === 'closing_answers' && round.phase !== 'closing_duels') {
        throw new GameServiceError('Aún no se ha abierto esta fase de duelos.', 409);
      }
      if (
        ['opening_reveal', 'middle_ranking', 'closing_reveal', 'final_ranking', 'lobby'].includes(room.game_stage)
        || (round.mode === 'all_play' && roundNumber !== room.round_number)
        || (round.mode === 'all_play' && !['middle_general', 'final_general', 'legacy'].includes(room.game_stage))
        || (round.mode === 'duel' && !['opening_answers', 'closing_answers', 'legacy'].includes(room.game_stage))
      ) {
        throw new GameServiceError('Esta fase no está aceptando respuestas.', 409);
      }
      await tx`
        INSERT INTO cunadometro_answers (room_id, round_number, player_id, answer_text)
        VALUES (${room.id}, ${roundNumber}, ${rawPlayerId}, ${text})
      `;
      if (round.phase === 'opening_duels' || round.phase === 'closing_duels') {
        const [phaseCounts] = await tx<Array<{ answer_count: number; expected_count: number; first_round: number }>>`
          SELECT
            (SELECT count(*)::int FROM cunadometro_answers a
              JOIN cunadometro_rounds r ON r.room_id = a.room_id AND r.round_number = a.round_number
              WHERE a.room_id = ${room.id} AND r.phase = ${round.phase}) AS answer_count,
            (SELECT count(*)::int * 2 FROM cunadometro_rounds
              WHERE room_id = ${room.id} AND phase = ${round.phase}) AS expected_count,
            (SELECT min(round_number)::int FROM cunadometro_rounds
              WHERE room_id = ${room.id} AND phase = ${round.phase}) AS first_round
        `;
        if (phaseCounts.answer_count === phaseCounts.expected_count) {
          const nextStage = round.phase === 'opening_duels' ? 'opening_reveal' : 'closing_reveal';
          await tx`
            UPDATE cunadometro_rounds SET status = 'voting', reveal_started_at = now()
            WHERE room_id = ${room.id} AND round_number = ${phaseCounts.first_round}
          `;
          await tx`
            UPDATE cunadometro_rooms
            SET game_stage = ${nextStage}, round_number = ${phaseCounts.first_round}
            WHERE id = ${room.id}
          `;
        }
      } else {
        const [count] = await tx<Array<{ count: number }>>`
          SELECT count(*)::int AS count FROM cunadometro_answers
          WHERE room_id = ${room.id} AND round_number = ${roundNumber}
        `;
        const [expectedCounts] = await tx<Array<{ active_players: number; active_duelists: number }>>`
          SELECT
            (SELECT count(*)::int FROM cunadometro_players WHERE room_id = ${room.id} AND is_active = true) AS active_players,
            (SELECT count(*)::int FROM unnest(${round.duel_player_ids}::uuid[]) AS assigned(id)
              JOIN cunadometro_players p ON p.id = assigned.id
              WHERE p.room_id = ${room.id} AND p.is_active = true) AS active_duelists
        `;
        const expected = round.mode === 'duel' ? expectedCounts.active_duelists : expectedCounts.active_players;
        if (count.count === expected) {
          await tx`
            UPDATE cunadometro_rounds SET status = 'voting', reveal_started_at = now()
            WHERE room_id = ${room.id} AND round_number = ${roundNumber}
          `;
        }
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
      const [room] = await tx<Array<{ id: string; status: string; round_number: number; game_stage: CunadometroStage }>>`
        SELECT id, status, round_number, game_stage FROM cunadometro_rooms
        WHERE code = ${code} AND status <> 'finished' FOR UPDATE
      `;
      if (!room || room.status !== 'playing') throw new GameServiceError('La partida no está en votación.', room ? 409 : 404);
      const [round] = await tx<Array<{
        mode: CunadometroMode; phase: CunadometroPhase; status: string;
        duel_player_ids: string[]; reveal_started_at: Date | null;
      }>>`
        SELECT mode, phase, status, duel_player_ids, reveal_started_at FROM cunadometro_rounds
        WHERE room_id = ${room.id} AND round_number = ${room.round_number} FOR UPDATE
      `;
      if (!round || round.status !== 'voting') throw new GameServiceError('Aún no se puede votar.', 409);
      if (round.reveal_started_at && room.game_stage !== 'legacy') {
        const [answerCount] = await tx<Array<{ count: number }>>`
          SELECT count(*)::int AS count FROM cunadometro_answers
          WHERE room_id = ${room.id} AND round_number = ${room.round_number}
        `;
        const revealDelay = getRevealVoteDelay(round.mode, answerCount.count);
        const [revealClock] = await tx<Array<{ elapsed_ms: number }>>`
          SELECT floor(extract(epoch FROM (now() - reveal_started_at)) * 1000)::int AS elapsed_ms
          FROM cunadometro_rounds
          WHERE room_id = ${room.id} AND round_number = ${room.round_number}
        `;
        if (revealClock.elapsed_ms < revealDelay) {
          throw new GameServiceError('Espera a que se revelen todas las respuestas.', 409);
        }
      }
      const [voter] = await tx<Array<{ id: string }>>`
        SELECT id FROM cunadometro_players
        WHERE room_id = ${room.id} AND id = ${rawPlayerId} AND is_active = true
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
      const [eligibleCounts] = await tx<Array<{ active_players: number; active_duelists: number }>>`
        SELECT
          (SELECT count(*)::int FROM cunadometro_players WHERE room_id = ${room.id} AND is_active = true) AS active_players,
          (SELECT count(*)::int FROM unnest(${round.duel_player_ids}::uuid[]) AS assigned(id)
            JOIN cunadometro_players p ON p.id = assigned.id
            WHERE p.room_id = ${room.id} AND p.is_active = true) AS active_duelists
      `;
      const eligibleCount = round.mode === 'duel'
        ? eligibleCounts.active_players - eligibleCounts.active_duelists
        : eligibleCounts.active_players;
      const [voteCount] = await tx<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM cunadometro_votes
        WHERE room_id = ${room.id} AND round_number = ${room.round_number}
      `;
      if (voteCount.count !== eligibleCount) return;

      await resolveRound(tx, room.id, room.round_number);
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
      const [room] = await tx<Array<{
        id: string; status: string; round_number: number; rounds_limit: number; game_stage: CunadometroStage;
      }>>`
        SELECT id, status, round_number, rounds_limit, game_stage
        FROM cunadometro_rooms WHERE code = ${code} AND status <> 'finished' FOR UPDATE
      `;
      if (!room) throw new GameServiceError('No encontramos esa sala.', 404);
      const [player] = await tx<Array<{ is_host: boolean }>>`
        SELECT is_host FROM cunadometro_players
        WHERE id = ${rawPlayerId} AND room_id = ${room.id} AND is_active = true
      `;
      if (!player) throw new GameServiceError('No formas parte de esta sala.', 403);
      if (!player.is_host) throw new GameServiceError('Solo el anfitrión puede avanzar la partida.', 403);
      if (room.status !== 'playing') throw new GameServiceError('Esta partida ya está cerrada.', 409);
      if (room.game_stage === 'middle_ranking') {
        const [firstClosingDuel] = await tx<Array<{ round_number: number }>>`
          SELECT round_number FROM cunadometro_rounds
          WHERE room_id = ${room.id} AND phase = 'closing_duels'
          ORDER BY round_number LIMIT 1
        `;
        if (!firstClosingDuel) throw new GameServiceError('No encontramos la segunda fase de duelos.', 500);
        await tx`
          UPDATE cunadometro_rooms
          SET game_stage = 'closing_answers', round_number = ${firstClosingDuel.round_number}
          WHERE id = ${room.id}
        `;
        return;
      }
      const [round] = await tx<Array<{ status: string }>>`
        SELECT status FROM cunadometro_rounds
        WHERE room_id = ${room.id} AND round_number = ${room.round_number}
      `;
      if (round?.status !== 'resolved') throw new GameServiceError('Primero debe terminar la votación.', 409);
      if (room.game_stage !== 'legacy') {
        const [current] = await tx<Array<{ phase: CunadometroPhase }>>`
          SELECT phase FROM cunadometro_rounds
          WHERE room_id = ${room.id} AND round_number = ${room.round_number}
        `;
        if (current.phase === 'middle_general') {
          await tx`UPDATE cunadometro_rooms SET game_stage = 'middle_ranking' WHERE id = ${room.id}`;
          return;
        }
        if (current.phase === 'final_general') {
          await tx`
            UPDATE cunadometro_rooms
            SET game_stage = 'final_ranking', status = 'finished', finished_at = now()
            WHERE id = ${room.id}
          `;
          return;
        }
        if (current.phase !== 'opening_duels' && current.phase !== 'closing_duels') {
          throw new GameServiceError('No hay otra ronda de duelos que avanzar.', 409);
        }
        const [nextDuel] = await tx<Array<{ round_number: number }>>`
          SELECT round_number FROM cunadometro_rounds
          WHERE room_id = ${room.id} AND phase = ${current.phase} AND round_number > ${room.round_number}
          ORDER BY round_number LIMIT 1
        `;
        if (nextDuel) {
          await tx`
            UPDATE cunadometro_rounds SET status = 'voting', reveal_started_at = now()
            WHERE room_id = ${room.id} AND round_number = ${nextDuel.round_number}
          `;
          await tx`UPDATE cunadometro_rooms SET round_number = ${nextDuel.round_number} WHERE id = ${room.id}`;
          return;
        }
        const nextPhase = current.phase === 'opening_duels' ? 'middle_general' : 'final_general';
        const [nextGeneral] = await tx<Array<{ round_number: number }>>`
          SELECT round_number FROM cunadometro_rounds
          WHERE room_id = ${room.id} AND phase = ${nextPhase}
          ORDER BY round_number LIMIT 1
        `;
        if (!nextGeneral) throw new GameServiceError('No encontramos la ronda general.', 500);
        await tx`
          UPDATE cunadometro_rooms
          SET game_stage = ${nextPhase}, round_number = ${nextGeneral.round_number}
          WHERE id = ${room.id}
        `;
        return;
      }
      if (room.round_number >= room.rounds_limit) {
        await tx`UPDATE cunadometro_rooms SET status = 'finished', finished_at = now() WHERE id = ${room.id}`;
        return;
      }
      const players = await tx<RoundPlayer[]>`
        SELECT id, duels_played FROM cunadometro_players
        WHERE room_id = ${room.id} AND is_active = true ORDER BY created_at, id
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
      const [room] = await tx<Array<{
        id: string; status: string; round_number: number; game_stage: CunadometroStage;
      }>>`
        SELECT id, status, round_number, game_stage
        FROM cunadometro_rooms
        WHERE code = ${code}
          AND EXISTS (
            SELECT 1 FROM cunadometro_players p WHERE p.room_id = cunadometro_rooms.id AND p.id = ${rawPlayerId}::uuid
          )
        FOR UPDATE
      `;
      if (!room) return;
      const [player] = await tx<Array<{ is_host: boolean; is_active: boolean }>>`
        SELECT is_host, is_active FROM cunadometro_players
        WHERE room_id = ${room.id} AND id = ${rawPlayerId} FOR UPDATE
      `;
      if (!player) return;
      if (room.status === 'waiting') {
        await tx`DELETE FROM cunadometro_players WHERE room_id = ${room.id} AND id = ${rawPlayerId}`;
        const remaining = await tx<Array<{ id: string }>>`
          SELECT id FROM cunadometro_players
          WHERE room_id = ${room.id} AND is_active = true
          ORDER BY created_at, id
        `;
        if (remaining.length === 0) {
          await tx`DELETE FROM cunadometro_rooms WHERE id = ${room.id}`;
        } else if (player.is_host) {
          await tx`
            UPDATE cunadometro_players SET is_host = (id = ${remaining[0].id})
            WHERE room_id = ${room.id}
          `;
        }
        return;
      }
      if (!player.is_active) return;

      await tx`
        UPDATE cunadometro_players SET is_active = false, is_host = false
        WHERE room_id = ${room.id} AND id = ${rawPlayerId}
      `;
      const activePlayers = await tx<Array<{ id: string }>>`
        SELECT id FROM cunadometro_players
        WHERE room_id = ${room.id} AND is_active = true
        ORDER BY created_at, id
      `;
      if (player.is_host && activePlayers.length > 0) {
        await tx`
          UPDATE cunadometro_players SET is_host = (id = ${activePlayers[0].id})
          WHERE room_id = ${room.id}
        `;
      }
      if (room.status !== 'playing') return;

      await tx`
        DELETE FROM cunadometro_votes
        WHERE room_id = ${room.id} AND round_number = ${room.round_number} AND voter_player_id = ${rawPlayerId}
      `;
      if (activePlayers.length < 3) {
        await tx`
          UPDATE cunadometro_rooms
          SET status = 'finished', game_stage = 'final_ranking', finished_at = now()
          WHERE id = ${room.id}
        `;
        return;
      }

      const [round] = await tx<Array<{
        mode: CunadometroMode; phase: CunadometroPhase; status: 'answering' | 'voting' | 'resolved';
        duel_player_ids: string[];
      }>>`
        SELECT mode, phase, status, duel_player_ids FROM cunadometro_rounds
        WHERE room_id = ${room.id} AND round_number = ${room.round_number} FOR UPDATE
      `;
      let phasesToReassign: CunadometroPhase[] = [];
      if (room.game_stage === 'opening_answers') {
        phasesToReassign = ['opening_duels', 'closing_duels'];
      } else if (['opening_reveal', 'middle_general', 'middle_ranking'].includes(room.game_stage)) {
        phasesToReassign = ['closing_duels'];
      } else if (room.game_stage === 'closing_answers') {
        phasesToReassign = ['closing_duels'];
      }
      if (phasesToReassign.length > 0) {
        await reassignUnansweredDuels(
          tx,
          room.id,
          rawPlayerId,
          activePlayers.map((activePlayer) => activePlayer.id),
          phasesToReassign,
        );
      }

      if (!round || round.status === 'resolved') return;
      if (round.status === 'answering' && round.mode === 'all_play') {
        await tx`
          DELETE FROM cunadometro_answers
          WHERE room_id = ${room.id} AND round_number = ${room.round_number} AND player_id = ${rawPlayerId}
        `;
        const [answerCount] = await tx<Array<{ count: number }>>`
          SELECT count(*)::int AS count FROM cunadometro_answers
          WHERE room_id = ${room.id} AND round_number = ${room.round_number}
        `;
        if (answerCount.count === activePlayers.length) {
          await tx`
            UPDATE cunadometro_rounds SET status = 'voting', reveal_started_at = now()
            WHERE room_id = ${room.id} AND round_number = ${room.round_number}
          `;
        }
        return;
      }
      if (round.status === 'answering' && round.mode === 'duel' && room.game_stage === 'legacy') {
        const duelPlayerIds = round.duel_player_ids.filter((id) => id !== rawPlayerId);
        await tx`
          UPDATE cunadometro_rounds SET duel_player_ids = ${duelPlayerIds}::uuid[]
          WHERE room_id = ${room.id} AND round_number = ${room.round_number}
        `;
        await tx`
          DELETE FROM cunadometro_answers
          WHERE room_id = ${room.id} AND round_number = ${room.round_number} AND player_id = ${rawPlayerId}
        `;
        const [answerCount] = await tx<Array<{ count: number }>>`
          SELECT count(*)::int AS count FROM cunadometro_answers
          WHERE room_id = ${room.id} AND round_number = ${room.round_number}
        `;
        if (answerCount.count === duelPlayerIds.length) {
          await tx`
            UPDATE cunadometro_rounds SET status = 'voting', reveal_started_at = now()
            WHERE room_id = ${room.id} AND round_number = ${room.round_number}
          `;
        }
        return;
      }
      if (round.status === 'voting') {
        const activeDuelists = round.duel_player_ids.filter((id) =>
          activePlayers.some((activePlayer) => activePlayer.id === id),
        ).length;
        const eligibleCount = round.mode === 'duel'
          ? activePlayers.length - activeDuelists
          : activePlayers.length;
        const [voteCount] = await tx<Array<{ count: number }>>`
          SELECT count(*)::int AS count FROM cunadometro_votes
          WHERE room_id = ${room.id} AND round_number = ${room.round_number}
        `;
        if (voteCount.count === eligibleCount) {
          await resolveRound(tx, room.id, room.round_number);
        }
      }
    });
  } catch (error) {
    return normalizeDatabaseError(error);
  }
}
