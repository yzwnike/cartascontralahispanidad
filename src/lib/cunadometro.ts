import { GameApiError } from './game';

export type CunadometroMode = 'duel' | 'all_play';
export type CunadometroStage =
  | 'lobby'
  | 'legacy'
  | 'opening_answers'
  | 'opening_reveal'
  | 'middle_general'
  | 'middle_ranking'
  | 'closing_answers'
  | 'closing_reveal'
  | 'final_general'
  | 'final_ranking';
export type CunadometroPhase = 'opening_duels' | 'middle_general' | 'closing_duels' | 'final_general' | 'legacy';
export type CunadometroDuelTask = {
  number: number;
  prompt: string;
  answerText: string | null;
};
export type CunadometroPlayer = {
  id: string;
  name: string;
  score: number;
  isHost: boolean;
  duelsPlayed: number;
};
export type CunadometroAnswer = {
  id: string;
  playerId: string | null;
  text: string;
  isWinner: boolean;
};
export type CunadometroVote = {
  voterId: string;
  voterName: string;
  answerId: string;
};
export type CunadometroRound = {
  number: number;
  mode: CunadometroMode;
  phase: CunadometroPhase;
  prompt: string;
  status: 'answering' | 'voting' | 'resolved';
  duelPlayerIds: string[];
  revealStartedAt: string | null;
  answers: CunadometroAnswer[];
  submittedCount: number;
  eligibleVoterCount: number;
  votesSubmittedCount: number;
  myDuelTasks: CunadometroDuelTask[];
  phaseSubmittedCount: number;
  phaseExpectedCount: number;
  myAnswerId: string | null;
  myVoteId: string | null;
  votesRevealed: boolean;
  voteCounts: Record<string, number>;
  publicVotes: CunadometroVote[];
  winnerIds: string[];
};
export type CunadometroRoom = {
  id: string;
  code: string;
  status: 'waiting' | 'playing' | 'finished';
  gameLength: 5 | 10 | 20;
  gameStage: CunadometroStage;
  roundsLimit: number;
  players: CunadometroPlayer[];
  round: CunadometroRound | null;
};
export type CunadometroSession = {
  room: CunadometroRoom;
  playerId: string;
  playerToken: string;
};

async function request<T>(url: string, playerToken?: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(playerToken ? { authorization: `Bearer ${playerToken}` } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new Error('No se pudo contactar con Cuñadómetro. Comprueba tu conexión e inténtalo otra vez.');
  }
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) throw new GameApiError(payload?.error ?? `La petición falló (${response.status}).`, response.status);
  if (!payload) throw new Error('El servidor devolvió una respuesta vacía.');
  return payload as T;
}

export async function createCunadometroRoom(name: string) {
  return request<CunadometroSession>('/api/cunadometro/rooms', undefined, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

export async function joinCunadometroRoom(code: string, name: string) {
  return request<CunadometroSession>(`/api/cunadometro/rooms/${encodeURIComponent(code)}/join`, undefined, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

export async function getCunadometroRoom(code: string, playerId: string, playerToken: string) {
  const query = new URLSearchParams({ playerId });
  return request<{ room: CunadometroRoom }>(`/api/cunadometro/rooms/${encodeURIComponent(code)}?${query}`, playerToken);
}

function postRoomAction(code: string, playerId: string, playerToken: string, action: string, fields: Record<string, unknown> = {}) {
  return request<{ room: CunadometroRoom }>(
    `/api/cunadometro/rooms/${encodeURIComponent(code)}/${action}`,
    playerToken,
    { method: 'POST', body: JSON.stringify({ playerId, ...fields }) },
  );
}

export function startCunadometroRoom(code: string, playerId: string, token: string, roundsLimit: 5 | 10 | 20) {
  return postRoomAction(code, playerId, token, 'start', { roundsLimit });
}

export function submitCunadometroAnswer(
  code: string,
  playerId: string,
  token: string,
  text: string,
  roundNumber?: number,
) {
  return postRoomAction(code, playerId, token, 'answer', { text, ...(roundNumber ? { roundNumber } : {}) });
}

export function voteCunadometroAnswer(code: string, playerId: string, token: string, answerId: string) {
  return postRoomAction(code, playerId, token, 'vote', { answerId });
}

export function nextCunadometroRound(code: string, playerId: string, token: string) {
  return postRoomAction(code, playerId, token, 'next');
}

export async function leaveCunadometroRoom(code: string, playerId: string, token: string) {
  return request<{ success: true }>(
    `/api/cunadometro/rooms/${encodeURIComponent(code)}/players/${encodeURIComponent(playerId)}`,
    token,
    { method: 'DELETE' },
  );
}
