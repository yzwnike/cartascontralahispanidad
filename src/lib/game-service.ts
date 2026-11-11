import { randomInt, randomUUID } from 'node:crypto';
import { getDb } from './db';
import { GameServiceError } from './game-errors';
import type { GameRoom, Player, Submission } from './game';
import { createPlayerToken } from './player-auth';

const CODE_CHARACTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const HAND_SIZE = 7;

type RoomRow = {
  id: string;
  code: string;
  status: GameRoom['status'];
  current_black_card_id: number;
  round_number: number;
  rounds_limit: 5 | 10 | 20;
  judge_player_id: string | null;
  black_card: string;
  pick: number;
};

function assertUuid(value: string, label = 'Identificador de jugador') {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new GameServiceError(`${label} no es válido.`);
  }
}

function cleanName(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > 50) {
    throw new GameServiceError('El nombre debe tener entre 1 y 50 caracteres.');
  }
  return value.trim();
}

function cleanCustomCard(value: unknown): string {
  if (typeof value !== 'string') throw new GameServiceError('Escribe una carta de respuesta válida.');
  const text = value.trim().replace(/\s+/g, ' ');
  if (text.length < 3 || text.length > 160) {
    throw new GameServiceError('Tu carta debe tener entre 3 y 160 caracteres.');
  }
  return text;
}

function cleanCode(value: string): string {
  const code = value.trim().toUpperCase();
  if (!/^[A-Z2-9]{6}$/.test(code)) throw new GameServiceError('El código de sala debe tener 6 caracteres.');
  return code;
}

function readHand(value: unknown): string[] {
  let hand: unknown = value;
  if (typeof hand === 'string') {
    try {
      hand = JSON.parse(hand);
    } catch {
      throw new GameServiceError('La mano guardada en Neon no contiene JSON válido.', 500);
    }
  }
  if (!Array.isArray(hand) || hand.some((card) => typeof card !== 'string')) {
    throw new GameServiceError('La mano guardada en Neon no tiene el formato esperado.', 500);
  }
  return hand;
}

function newCode() {
  return Array.from({ length: 6 }, () => CODE_CHARACTERS[randomInt(CODE_CHARACTERS.length)]).join('');
}

function normalizeDatabaseError(error: unknown): never {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String(error.code);
    if (code === '23505') throw new GameServiceError('Ese código de sala ya existe; inténtalo de nuevo.', 409);
    if (code === '23503') throw new GameServiceError('La sala o el jugador indicado ya no existe.', 404);
    if (code === '23502' || code === '22P02') throw new GameServiceError('Los datos enviados no son válidos.');
    if (
      code.startsWith('08')
      || code === '57P01'
      || code === 'ECONNREFUSED'
      || code === 'ECONNRESET'
      || code === 'ETIMEDOUT'
      || code === 'ENOTFOUND'
      || code === 'CONNECTION_TIMEOUT'
    ) {
      throw new GameServiceError('No se pudo conectar con Neon. Comprueba DATABASE_URL y vuelve a intentarlo.', 503);
    }
  }
  throw error;
}

async function roomRow(code: string, db = getDb()): Promise<RoomRow> {
  const [room] = await db<RoomRow[]>`
    SELECT r.id, r.code, r.status, r.current_black_card_id, r.round_number, r.rounds_limit,
           r.judge_player_id, c.text AS black_card, c.pick
    FROM rooms r
    JOIN cards c ON c.id = r.current_black_card_id AND c.type = 'black'
    WHERE r.code = ${code}
  `;
  if (!room) throw new GameServiceError('No encontramos esa sala.', 404);
  return room;
}

export async function getRoomState(rawCode: string, rawPlayerId: string): Promise<GameRoom> {
  const code = cleanCode(rawCode);
  assertUuid(rawPlayerId);
  try {
    const db = getDb();
    const room = await roomRow(code, db);
    const [players, rows] = await Promise.all([
      db<Array<{ id: string; name: string; score: number; is_host: boolean; hand: unknown; custom_card_text: string | null; custom_card_submitted: boolean; is_ready: boolean }>>`
        SELECT p.id, p.name, p.score, p.is_host,
               CASE WHEN p.id = ${rawPlayerId}::uuid THEN p.hand ELSE '[]'::jsonb END AS hand,
               CASE WHEN p.id = ${rawPlayerId}::uuid THEN cc.card_text ELSE NULL END AS custom_card_text,
               (cc.player_id IS NOT NULL) AS custom_card_submitted,
               COALESCE(cc.is_ready, false) AS is_ready
        FROM players p
        LEFT JOIN room_custom_cards cc ON cc.room_id = p.room_id AND cc.player_id = p.id
        WHERE p.room_id = ${room.id}
        ORDER BY p.created_at, p.id
      `,
      db<Array<{ submission_id: string; player_id: string; card_text: string; is_winner: boolean }>>`
        SELECT submission_id, player_id, card_text, is_winner
        FROM played_cards
        WHERE room_id = ${room.id} AND round_number = ${room.round_number}
        ORDER BY submission_id, id
      `,
    ]);
    if (!players.some((player) => player.id === rawPlayerId)) {
      throw new GameServiceError('No formas parte de esta sala.', 403);
    }

    const grouped = new Map<string, { playerId: string; cards: string[]; isWinner: boolean }>();
    for (const row of rows) {
      if (!row.submission_id) continue;
      const current = grouped.get(row.submission_id) ?? {
        playerId: row.player_id,
        cards: [],
        isWinner: false,
      };
      current.cards.push(row.card_text);
      current.isWinner ||= row.is_winner;
      grouped.set(row.submission_id, current);
    }

    const voteRows = await db<Array<{ vote_number: number; voter_player_id: string; voter_name: string; submission_id: string }>>`
      SELECT rv.vote_number, rv.voter_player_id, p.name AS voter_name, rv.submission_id
      FROM round_votes rv
      JOIN players p ON p.id = rv.voter_player_id
      WHERE rv.room_id = ${room.id} AND rv.round_number = ${room.round_number}
    `;
    const allResponsesSubmitted = grouped.size === players.length && players.length >= 2;
    const winnerIds = Array.from(new Set(
      Array.from(grouped.values()).filter((item) => item.isWinner).map((item) => item.playerId),
    ));
    const revealed = winnerIds.length > 0;
    const voteNumber = room.status === 'sudden_vote' || voteRows.some((vote) => vote.vote_number === 2) ? 2 : 1;
    const currentVotes = voteRows.filter((vote) => vote.vote_number === voteNumber);
    const firstVoteCounts = new Map<string, number>();
    for (const vote of voteRows.filter((item) => item.vote_number === 1)) {
      firstVoteCounts.set(vote.submission_id, (firstVoteCounts.get(vote.submission_id) ?? 0) + 1);
    }
    const currentVoteCounts = new Map<string, number>();
    for (const vote of currentVotes) {
      currentVoteCounts.set(vote.submission_id, (currentVoteCounts.get(vote.submission_id) ?? 0) + 1);
    }
    const suddenCandidates = room.status === 'sudden_vote'
      ? (() => {
          const highest = Math.max(0, ...firstVoteCounts.values());
          return Array.from(firstVoteCounts)
            .filter(([, count]) => count === highest)
            .map(([submissionId]) => submissionId);
        })()
      : [];
    const voteOptions = room.status === 'sudden_vote'
      ? suddenCandidates
      : Array.from(grouped.keys());
    const voteCounts = allResponsesSubmitted
      ? Object.fromEntries(Array.from(grouped.keys(), (submissionId) => [
          submissionId,
          currentVoteCounts.get(submissionId) ?? 0,
        ]))
      : {};
    const publicVotes = allResponsesSubmitted
      ? currentVotes.map((vote) => ({
          voterId: vote.voter_player_id,
          voterName: vote.voter_name,
          submissionId: vote.submission_id,
        }))
      : [];
    const submissions: Submission[] = allResponsesSubmitted
      ? Array.from(grouped, ([id, item]) => ({
          id,
          playerId: revealed ? item.playerId : null,
          cards: item.cards,
        }))
      : [];
    const gamePlayers: Player[] = players.map((player) => ({
      id: player.id,
      name: player.name,
      score: player.score,
      isHost: player.is_host,
      hand: readHand(player.hand),
      customCardText: player.custom_card_text,
      customCardSubmitted: player.custom_card_submitted,
      ready: player.is_ready,
    }));
    const customCardsSubmitted = gamePlayers.filter((player) => player.customCardSubmitted).length;
    const allPlayersReady = gamePlayers.length >= 2
      && customCardsSubmitted === gamePlayers.length
      && gamePlayers.every((player) => player.ready);

    return {
      id: room.id,
      code: room.code,
      status: room.status,
      hostId: gamePlayers.find((player) => player.isHost)?.id ?? '',
      judgeId: room.judge_player_id ?? '',
      round: room.round_number,
      roundsLimit: room.rounds_limit,
      blackCard: room.black_card,
      pick: room.pick,
      players: gamePlayers,
      customCardsSubmitted,
      allPlayersReady,
      submissions,
      submittedCount: grouped.size,
      mySubmissionId: Array.from(grouped).find(([, item]) => item.playerId === rawPlayerId)?.[0] ?? null,
      votesSubmittedCount: currentVotes.length,
      eligibleVoterCount: allResponsesSubmitted ? players.length : 0,
      myVoteId: currentVotes.find((vote) => vote.voter_player_id === rawPlayerId)?.submission_id ?? null,
      voteOptions,
      voteCounts,
      publicVotes,
      winnerIds,
      winnerId: winnerIds[0] ?? null,
    };
  } catch (error) {
    return normalizeDatabaseError(error);
  }
}

export async function createRoom(rawName: unknown): Promise<{ room: GameRoom; playerId: string; playerToken: string }> {
  const name = cleanName(rawName);
  const playerId = randomUUID();
  const playerToken = createPlayerToken(playerId);
  const db = getDb();

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newCode();
    try {
      await db.begin(async (tx) => {
        const [black] = await tx<Array<{ id: number }>>`
          SELECT id FROM cards WHERE type = 'black' ORDER BY random() LIMIT 1
        `;
        const whites = await tx<Array<{ text: string }>>`
          SELECT text FROM cards WHERE type = 'white' ORDER BY random() LIMIT ${HAND_SIZE}
        `;
        if (!black || whites.length < HAND_SIZE) {
          throw new GameServiceError('Faltan cartas en Neon. Ejecuta db/schema.sql en la base de datos.', 503);
        }

        const [room] = await tx<Array<{ id: string }>>`
          INSERT INTO rooms (code, status, current_black_card_id, round_number)
          VALUES (${code}, 'waiting', ${black.id}, 1)
          RETURNING id
        `;
        await tx`
          INSERT INTO players (id, room_id, name, score, is_host, hand)
          VALUES (${playerId}, ${room.id}, ${name}, 0, true, ${JSON.stringify(whites.map((card) => card.text))}::jsonb)
        `;
      });
      return { room: await getRoomState(code, playerId), playerId, playerToken };
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505' && attempt < 4) continue;
      return normalizeDatabaseError(error);
    }
  }
  throw new GameServiceError('No se pudo generar un código de sala único.', 503);
}

export async function joinRoom(rawCode: string, rawName: unknown) {
  const code = cleanCode(rawCode);
  const name = cleanName(rawName);
  const playerId = randomUUID();
  const playerToken = createPlayerToken(playerId);
  try {
    await getDb().begin(async (tx) => {
      const [room] = await tx<Array<{ id: string; status: string; round_number: number; judge_player_id: string | null }>>`
        SELECT id, status, round_number, judge_player_id FROM rooms WHERE code = ${code} FOR UPDATE
      `;
      if (!room) throw new GameServiceError('No encontramos esa sala.', 404);
      if (room.status !== 'waiting') throw new GameServiceError('La partida ya ha empezado y no admite más jugadores.', 409);
      const [duplicate] = await tx<Array<{ exists: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM players WHERE room_id = ${room.id} AND lower(name) = lower(${name})
        ) AS exists
      `;
      if (duplicate?.exists) throw new GameServiceError('Ya hay alguien con ese nombre en la sala.', 409);
      const whites = await tx<Array<{ text: string }>>`
        SELECT text FROM cards WHERE type = 'white' ORDER BY random() LIMIT ${HAND_SIZE}
      `;
      if (whites.length < HAND_SIZE) {
        throw new GameServiceError('Faltan cartas blancas en Neon. Ejecuta db/schema.sql en la base de datos.', 503);
      }
      await tx`
        INSERT INTO players (id, room_id, name, score, is_host, hand)
        VALUES (${playerId}, ${room.id}, ${name}, 0, false, ${JSON.stringify(whites.map((card) => card.text))}::jsonb)
      `;
    });
    return { room: await getRoomState(code, playerId), playerId, playerToken };
  } catch (error) {
    return normalizeDatabaseError(error);
  }
}

export async function prepareRoom(rawCode: string, rawHostId: string) {
  const code = cleanCode(rawCode);
  assertUuid(rawHostId);
  try {
    await getDb().begin(async (tx) => {
      const [room] = await tx<Array<{ id: string; status: string }>>`
        SELECT id, status FROM rooms WHERE code = ${code} FOR UPDATE
      `;
      if (!room) throw new GameServiceError('No encontramos esa sala.', 404);
      if (room.status !== 'waiting') throw new GameServiceError('La sala ya está preparando la partida.', 409);

      const [host] = await tx<Array<{ is_host: boolean }>>`
        SELECT is_host FROM players WHERE id = ${rawHostId} AND room_id = ${room.id}
      `;
      if (!host) throw new GameServiceError('No formas parte de esta sala.', 403);
      if (!host.is_host) throw new GameServiceError('Solo el anfitrión puede abrir la creación de cartas.', 403);

      const [roster] = await tx<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM players WHERE room_id = ${room.id}
      `;
      if (roster.count < 2) throw new GameServiceError('Hace falta al menos otra persona para jugar.', 409);
      await tx`UPDATE rooms SET status = 'card_creation' WHERE id = ${room.id}`;
    });
    return getRoomState(code, rawHostId);
  } catch (error) {
    return normalizeDatabaseError(error);
  }
}

export async function submitCustomCard(rawCode: string, rawPlayerId: string, rawCardText: unknown) {
  const code = cleanCode(rawCode);
  assertUuid(rawPlayerId);
  const cardText = cleanCustomCard(rawCardText);
  try {
    await getDb().begin(async (tx) => {
      const [room] = await tx<Array<{ id: string; status: string }>>`
        SELECT id, status FROM rooms WHERE code = ${code} FOR UPDATE
      `;
      if (!room) throw new GameServiceError('No encontramos esa sala.', 404);
      if (room.status !== 'card_creation') {
        throw new GameServiceError('La creación de cartas no está abierta.', 409);
      }

      const [player] = await tx<Array<{ id: string }>>`
        SELECT id FROM players WHERE id = ${rawPlayerId} AND room_id = ${room.id}
      `;
      if (!player) throw new GameServiceError('No formas parte de esta sala.', 403);

      const [duplicate] = await tx<Array<{ exists: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM room_custom_cards
          WHERE room_id = ${room.id} AND player_id <> ${rawPlayerId}
            AND lower(btrim(card_text)) = lower(${cardText})
        ) AS exists
      `;
      if (duplicate?.exists) throw new GameServiceError('Esa carta ya la ha escrito otra persona. Prueba otra.', 409);

      await tx`
        INSERT INTO room_custom_cards (room_id, player_id, card_text, is_ready)
        VALUES (${room.id}, ${rawPlayerId}, ${cardText}, false)
        ON CONFLICT (room_id, player_id)
        DO UPDATE SET card_text = EXCLUDED.card_text, is_ready = false
      `;
    });
    return getRoomState(code, rawPlayerId);
  } catch (error) {
    return normalizeDatabaseError(error);
  }
}

export async function setPlayerReady(rawCode: string, rawPlayerId: string, ready: boolean) {
  const code = cleanCode(rawCode);
  assertUuid(rawPlayerId);
  try {
    await getDb().begin(async (tx) => {
      const [room] = await tx<Array<{ id: string; status: string }>>`
        SELECT id, status FROM rooms WHERE code = ${code} FOR UPDATE
      `;
      if (!room) throw new GameServiceError('No encontramos esa sala.', 404);
      if (room.status !== 'card_creation') {
        throw new GameServiceError('Ya no se puede cambiar el estado de preparación.', 409);
      }

      const [card] = await tx<Array<{ player_id: string }>>`
        SELECT player_id FROM room_custom_cards
        WHERE room_id = ${room.id} AND player_id = ${rawPlayerId}
      `;
      if (!card) throw new GameServiceError('Primero escribe y guarda tu carta blanca.', 409);
      await tx`
        UPDATE room_custom_cards SET is_ready = ${ready}
        WHERE room_id = ${room.id} AND player_id = ${rawPlayerId}
      `;
    });
    return getRoomState(code, rawPlayerId);
  } catch (error) {
    return normalizeDatabaseError(error);
  }
}

export async function startRoom(rawCode: string, rawPlayerId: string, rawRoundsLimit: unknown) {
  const code = cleanCode(rawCode);
  assertUuid(rawPlayerId);
  if (rawRoundsLimit !== 5 && rawRoundsLimit !== 10 && rawRoundsLimit !== 20) {
    throw new GameServiceError('Elige una partida de 5, 10 o 20 rondas.');
  }
  try {
    await getDb().begin(async (tx) => {
      const [room] = await tx<Array<{ id: string; status: string }>>`
        SELECT id, status FROM rooms WHERE code = ${code} FOR UPDATE
      `;
      if (!room) throw new GameServiceError('No encontramos esa sala.', 404);
      const [host] = await tx<Array<{ is_host: boolean }>>`
        SELECT is_host FROM players WHERE id = ${rawPlayerId} AND room_id = ${room.id}
      `;
      if (!host) throw new GameServiceError('No formas parte de esta sala.', 403);
      if (!host.is_host) throw new GameServiceError('Solo el anfitrión puede empezar la partida.', 403);
      if (room.status !== 'card_creation') {
        throw new GameServiceError('Primero hay que abrir la fase de creación de cartas.', 409);
      }
      const players = await tx<Array<{ id: string }>>`
        SELECT id FROM players WHERE room_id = ${room.id} ORDER BY created_at, id
      `;
      if (players.length < 2) throw new GameServiceError('Hace falta al menos otra persona para poder votar.', 409);
      const customCards = await tx<Array<{ player_id: string; card_text: string }>>`
        SELECT player_id, card_text FROM room_custom_cards
        WHERE room_id = ${room.id} AND is_ready = true
      `;
      if (customCards.length !== players.length) {
        throw new GameServiceError('Todo el mundo debe escribir una carta y marcar que está listo.', 409);
      }

      const cardsByAuthor = new Map(customCards.map((card) => [card.player_id, card.card_text]));
      if (players.some((player) => !cardsByAuthor.has(player.id))) {
        throw new GameServiceError('Falta la carta de respuesta de alguien en la sala.', 409);
      }
      const normalCardsNeeded = players.length * (HAND_SIZE - 1);
      const normalCards = await tx<Array<{ text: string }>>`
        SELECT text FROM cards WHERE type = 'white' ORDER BY random() LIMIT ${normalCardsNeeded}
      `;
      if (normalCards.length < normalCardsNeeded) {
        throw new GameServiceError('No hay suficientes cartas blancas para repartir.', 503);
      }

      const customOffset = randomInt(1, players.length);
      for (let authorIndex = 0; authorIndex < players.length; authorIndex++) {
        const author = players[authorIndex];
        const recipient = players[(authorIndex + customOffset) % players.length];
        const handStart = authorIndex * (HAND_SIZE - 1);
        const hand = [
          ...normalCards.slice(handStart, handStart + HAND_SIZE - 1).map((card) => card.text),
          cardsByAuthor.get(author.id)!,
        ];
        await tx`
          UPDATE players SET hand = ${JSON.stringify(hand)}::jsonb
          WHERE id = ${recipient.id} AND room_id = ${room.id}
        `;
      }
      await tx`
        UPDATE rooms
        SET status = 'playing', judge_player_id = NULL, round_number = 1, rounds_limit = ${rawRoundsLimit}
        WHERE id = ${room.id}
      `;
    });
    return getRoomState(code, rawPlayerId);
  } catch (error) {
    return normalizeDatabaseError(error);
  }
}

export async function submitCards(rawCode: string, rawPlayerId: string, rawCards: unknown) {
  const code = cleanCode(rawCode);
  assertUuid(rawPlayerId);
  if (!Array.isArray(rawCards) || rawCards.some((card) => typeof card !== 'string') || rawCards.length < 1 || rawCards.length > 10) {
    throw new GameServiceError('Selecciona una o más cartas válidas.');
  }
  const selected = rawCards as string[];

  try {
    await getDb().begin(async (tx) => {
      const [room] = await tx<Array<{ id: string; status: string; round_number: number; current_black_card_id: number; judge_player_id: string | null }>>`
        SELECT id, status, round_number, current_black_card_id, judge_player_id
        FROM rooms WHERE code = ${code} FOR UPDATE
      `;
      if (!room) throw new GameServiceError('No encontramos esa sala.', 404);
      if (room.status !== 'playing' && room.status !== 'judging') throw new GameServiceError('Esta ronda no acepta respuestas.', 409);
      const [black] = await tx<Array<{ pick: number }>>`
        SELECT pick FROM cards WHERE id = ${room.current_black_card_id} AND type = 'black'
      `;
      if (!black || selected.length !== black.pick) {
        throw new GameServiceError(`Esta carta negra requiere ${black?.pick ?? 1} carta(s) blanca(s).`, 400);
      }
      const [player] = await tx<Array<{ hand: unknown }>>`
        SELECT hand FROM players WHERE id = ${rawPlayerId} AND room_id = ${room.id} FOR UPDATE
      `;
      if (!player) throw new GameServiceError('No formas parte de esta sala.', 403);
      const remaining = [...readHand(player.hand)];
      for (const card of selected) {
        const index = remaining.indexOf(card);
        if (index < 0) throw new GameServiceError('Una de las cartas seleccionadas ya no está en tu mano.', 409);
        remaining.splice(index, 1);
      }
      const [alreadySubmitted] = await tx<Array<{ exists: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM played_cards
          WHERE room_id = ${room.id} AND round_number = ${room.round_number} AND player_id = ${rawPlayerId}
        ) AS exists
      `;
      if (alreadySubmitted?.exists) throw new GameServiceError('Ya has enviado una respuesta en esta ronda.', 409);
      const submissionId = randomUUID();
      const needed = Math.max(0, HAND_SIZE - remaining.length);
      const replacements = needed > 0
        ? await tx<Array<{ text: string }>>`
            SELECT text FROM cards WHERE type = 'white' ORDER BY random() LIMIT ${needed}
          `
        : [];
      if (replacements.length < needed) throw new GameServiceError('No hay suficientes cartas blancas para reponer tu mano.', 503);
      await tx`
        UPDATE players
        SET hand = ${JSON.stringify([...remaining, ...replacements.map((card) => card.text)])}::jsonb
        WHERE id = ${rawPlayerId}
      `;
      for (const card of selected) {
        await tx`
          INSERT INTO played_cards (room_id, player_id, card_text, is_winner, round_number, submission_id)
          VALUES (${room.id}, ${rawPlayerId}, ${card}, false, ${room.round_number}, ${submissionId})
        `;
      }
      const [submitted] = await tx<Array<{ count: number }>>`
        SELECT count(DISTINCT player_id)::int AS count
        FROM played_cards WHERE room_id = ${room.id} AND round_number = ${room.round_number}
      `;
      const [roster] = await tx<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM players WHERE room_id = ${room.id}
      `;
      if (submitted.count === roster.count) {
        await tx`UPDATE rooms SET status = 'judging' WHERE id = ${room.id}`;
      }
    });
    return getRoomState(code, rawPlayerId);
  } catch (error) {
    return normalizeDatabaseError(error);
  }
}

export async function castVote(rawCode: string, rawPlayerId: string, rawSubmissionId: string) {
  const code = cleanCode(rawCode);
  assertUuid(rawPlayerId);
  assertUuid(rawSubmissionId, 'Identificador de respuesta');
  try {
    await getDb().begin(async (tx) => {
      const [room] = await tx<Array<{ id: string; status: string; round_number: number; rounds_limit: number }>>`
        SELECT id, status, round_number, rounds_limit FROM rooms WHERE code = ${code} FOR UPDATE
      `;
      if (!room) throw new GameServiceError('No encontramos esa sala.', 404);
      if (room.status !== 'judging' && room.status !== 'sudden_vote') {
        throw new GameServiceError('La votación todavía no está abierta.', 409);
      }
      const [voter] = await tx<Array<{ id: string }>>`
        SELECT id FROM players WHERE id = ${rawPlayerId} AND room_id = ${room.id}
      `;
      if (!voter) throw new GameServiceError('No formas parte de esta sala.', 403);
      const voteNumber = room.status === 'sudden_vote' ? 2 : 1;
      const [submission] = await tx<Array<{ player_id: string }>>`
        SELECT player_id FROM played_cards
        WHERE room_id = ${room.id} AND round_number = ${room.round_number} AND submission_id = ${rawSubmissionId}
        LIMIT 1
      `;
      if (!submission) throw new GameServiceError('La respuesta elegida no pertenece a esta ronda.', 404);
      if (submission.player_id === rawPlayerId) throw new GameServiceError('No puedes votar tu propia respuesta.', 403);
      if (voteNumber === 2) {
        const [eligibleSubmission] = await tx<Array<{ exists: boolean }>>`
          SELECT EXISTS (
            SELECT 1
            FROM round_votes
            WHERE room_id = ${room.id} AND round_number = ${room.round_number} AND vote_number = 1
            GROUP BY submission_id
            HAVING count(*) = (
              SELECT max(vote_count) FROM (
                SELECT count(*) AS vote_count
                FROM round_votes
                WHERE room_id = ${room.id} AND round_number = ${room.round_number} AND vote_number = 1
                GROUP BY submission_id
              ) tallies
            ) AND submission_id = ${rawSubmissionId}::uuid
          ) AS exists
        `;
        if (!eligibleSubmission?.exists) {
          throw new GameServiceError('En la votación súbita solo se puede votar una respuesta empatada.', 409);
        }
      }
      await tx`
        INSERT INTO round_votes (room_id, round_number, vote_number, voter_player_id, submission_id)
        VALUES (${room.id}, ${room.round_number}, ${voteNumber}, ${rawPlayerId}, ${rawSubmissionId})
      `;
      const [roster] = await tx<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM players WHERE room_id = ${room.id}
      `;
      const [ballots] = await tx<Array<{ count: number }>>`
        SELECT count(*)::int AS count
        FROM round_votes
        WHERE room_id = ${room.id} AND round_number = ${room.round_number} AND vote_number = ${voteNumber}
      `;
      if (ballots.count < roster.count) return;

      const tallies = await tx<Array<{ submission_id: string; vote_count: number }>>`
        SELECT submission_id, count(*)::int AS vote_count
        FROM round_votes
        WHERE room_id = ${room.id} AND round_number = ${room.round_number} AND vote_number = ${voteNumber}
        GROUP BY submission_id
        ORDER BY vote_count DESC
      `;
      const topCount = tallies[0]?.vote_count ?? 0;
      const leaders = tallies.filter((item) => item.vote_count === topCount).map((item) => item.submission_id);
      if (leaders.length === 0) throw new GameServiceError('No se han recibido votos válidos.', 409);
      if (voteNumber === 1 && leaders.length > 1) {
        await tx`UPDATE rooms SET status = 'sudden_vote' WHERE id = ${room.id}`;
        return;
      }

      await tx`
        UPDATE played_cards SET is_winner = false
        WHERE room_id = ${room.id} AND round_number = ${room.round_number}
      `;
      const winners = await tx<Array<{ player_id: string }>>`
        SELECT DISTINCT player_id FROM played_cards
        WHERE room_id = ${room.id} AND round_number = ${room.round_number}
          AND submission_id = ANY(${leaders}::uuid[])
      `;
      for (const submissionId of leaders) {
        await tx`
          UPDATE played_cards SET is_winner = true
          WHERE room_id = ${room.id} AND round_number = ${room.round_number} AND submission_id = ${submissionId}
        `;
      }
      for (const winner of winners) {
        await tx`UPDATE players SET score = score + 1 WHERE id = ${winner.player_id}`;
      }
      if (room.round_number >= room.rounds_limit) {
        await tx`UPDATE rooms SET status = 'finished' WHERE id = ${room.id}`;
      }
    });
    return getRoomState(code, rawPlayerId);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
      throw new GameServiceError('Ya has votado en esta votación.', 409);
    }
    return normalizeDatabaseError(error);
  }
}

export async function nextRound(rawCode: string, rawPlayerId: string) {
  const code = cleanCode(rawCode);
  assertUuid(rawPlayerId);
  try {
    await getDb().begin(async (tx) => {
      const [room] = await tx<Array<{ id: string; status: string; round_number: number }>>`
        SELECT id, status, round_number FROM rooms WHERE code = ${code} FOR UPDATE
      `;
      if (!room) throw new GameServiceError('No encontramos esa sala.', 404);
      const [player] = await tx<Array<{ id: string }>>`
        SELECT id FROM players WHERE id = ${rawPlayerId} AND room_id = ${room.id}
      `;
      if (!player) throw new GameServiceError('No formas parte de esta sala.', 403);
      if (room.status !== 'judging') throw new GameServiceError('Esta ronda aún no se puede cerrar.', 409);
      const [winner] = await tx<Array<{ player_id: string }>>`
        SELECT player_id FROM played_cards
        WHERE room_id = ${room.id} AND round_number = ${room.round_number} AND is_winner = true
        LIMIT 1
      `;
      if (!winner) throw new GameServiceError('Primero hay que elegir la respuesta ganadora.', 409);

      const players = await tx<Array<{ id: string; hand: unknown }>>`
        SELECT id, hand FROM players WHERE room_id = ${room.id} ORDER BY created_at, id
      `;
      if (players.length === 0) throw new GameServiceError('La sala ya no tiene jugadores.', 409);
      const [black] = await tx<Array<{ id: number }>>`
        SELECT id FROM cards WHERE type = 'black' ORDER BY random() LIMIT 1
      `;
      if (!black) throw new GameServiceError('Faltan cartas negras en Neon.', 503);

      for (const player of players) {
        const hand = readHand(player.hand);
        const needed = Math.max(0, HAND_SIZE - hand.length);
        if (needed === 0) continue;
        const cards = await tx<Array<{ text: string }>>`
          SELECT text FROM cards WHERE type = 'white' ORDER BY random() LIMIT ${needed}
        `;
        if (cards.length < needed) throw new GameServiceError('No hay suficientes cartas blancas para repartir.', 503);
        await tx`
          UPDATE players SET hand = ${JSON.stringify([...hand, ...cards.map((card) => card.text)])}::jsonb
          WHERE id = ${player.id}
        `;
      }
      await tx`
        UPDATE rooms
        SET current_black_card_id = ${black.id},
            judge_player_id = NULL,
            round_number = round_number + 1,
            status = 'playing'
        WHERE id = ${room.id}
      `;
    });
    return getRoomState(code, rawPlayerId);
  } catch (error) {
    return normalizeDatabaseError(error);
  }
}

export async function leaveRoom(rawCode: string, rawPlayerId: string) {
  const code = cleanCode(rawCode);
  assertUuid(rawPlayerId);
  try {
    await getDb().begin(async (tx) => {
      const [room] = await tx<Array<{ id: string; judge_player_id: string | null }>>`
        SELECT id, judge_player_id FROM rooms WHERE code = ${code} FOR UPDATE
      `;
      if (!room) return;
      const [player] = await tx<Array<{ is_host: boolean }>>`
        SELECT is_host FROM players WHERE id = ${rawPlayerId} AND room_id = ${room.id} FOR UPDATE
      `;
      if (!player) return;
      await tx`DELETE FROM players WHERE id = ${rawPlayerId} AND room_id = ${room.id}`;
      const remaining = await tx<Array<{ id: string }>>`
        SELECT id FROM players WHERE room_id = ${room.id} ORDER BY created_at, id
      `;
      if (remaining.length === 0) {
        await tx`DELETE FROM rooms WHERE id = ${room.id}`;
        return;
      }
      if (room.judge_player_id === rawPlayerId) {
        await tx`UPDATE rooms SET judge_player_id = ${remaining[0].id} WHERE id = ${room.id}`;
      }
      if (player.is_host) {
        await tx`UPDATE players SET is_host = (id = ${remaining[0].id}) WHERE room_id = ${room.id}`;
      }
    });
  } catch (error) {
    return normalizeDatabaseError(error);
  }
}

export async function kickPlayer(rawCode: string, rawHostId: string, rawTargetId: string) {
  const code = cleanCode(rawCode);
  assertUuid(rawHostId);
  assertUuid(rawTargetId, 'Identificador del jugador expulsado');
  if (rawHostId === rawTargetId) {
    throw new GameServiceError('No puedes expulsarte a ti mismo; usa «Salir de la sala».', 400);
  }

  try {
    await getDb().begin(async (tx) => {
      const [room] = await tx<Array<{ id: string; status: string }>>`
        SELECT id, status FROM rooms WHERE code = ${code} FOR UPDATE
      `;
      if (!room) throw new GameServiceError('No encontramos esa sala.', 404);
      if (room.status !== 'waiting' && room.status !== 'card_creation') {
        throw new GameServiceError('Solo puedes expulsar jugadores antes de empezar la partida.', 409);
      }

      const [host] = await tx<Array<{ is_host: boolean }>>`
        SELECT is_host FROM players WHERE id = ${rawHostId} AND room_id = ${room.id} FOR UPDATE
      `;
      if (!host) throw new GameServiceError('No formas parte de esta sala.', 403);
      if (!host.is_host) throw new GameServiceError('Solo el anfitrión puede expulsar jugadores.', 403);

      const [target] = await tx<Array<{ id: string; is_host: boolean }>>`
        SELECT id, is_host FROM players WHERE id = ${rawTargetId} AND room_id = ${room.id} FOR UPDATE
      `;
      if (!target) throw new GameServiceError('Ese jugador ya no está en la sala.', 404);
      if (target.is_host) throw new GameServiceError('No puedes expulsar al anfitrión de la sala.', 403);

      await tx`DELETE FROM players WHERE id = ${rawTargetId} AND room_id = ${room.id}`;
    });
    return getRoomState(code, rawHostId);
  } catch (error) {
    return normalizeDatabaseError(error);
  }
}
