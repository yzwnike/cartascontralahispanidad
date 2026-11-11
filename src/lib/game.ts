export type Player = {
  id: string;
  name: string;
  score: number;
  isHost: boolean;
  hand: string[];
  customCardText: string | null;
  customCardSubmitted: boolean;
  ready: boolean;
};

export type Submission = {
  id: string;
  playerId: string | null;
  cards: string[];
};

export type PublicVote = {
  voterId: string;
  voterName: string;
  submissionId: string;
};

export type GameRoom = {
  id: string;
  code: string;
  status: 'waiting' | 'card_creation' | 'playing' | 'judging' | 'sudden_vote' | 'finished';
  hostId: string;
  judgeId: string;
  round: number;
  roundsLimit: 5 | 10 | 20;
  blackCard: string;
  pick: number;
  players: Player[];
  customCardsSubmitted: number;
  allPlayersReady: boolean;
  submissions: Submission[];
  submittedCount: number;
  mySubmissionId: string | null;
  votesSubmittedCount: number;
  eligibleVoterCount: number;
  myVoteId: string | null;
  voteOptions: string[];
  voteCounts: Record<string, number>;
  publicVotes: PublicVote[];
  winnerIds: string[];
  winnerId: string | null;
};

export type RoomResponse = {
  room: GameRoom;
  playerId: string;
  playerToken: string;
};

export class GameApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'GameApiError';
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: { 'content-type': 'application/json', ...init?.headers },
    });
  } catch {
    throw new Error('No se pudo contactar con el servidor. Comprueba tu conexión e inténtalo otra vez.');
  }

  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) {
    throw new GameApiError(payload?.error ?? `La petición falló (${response.status}).`, response.status);
  }
  if (!payload) throw new Error('El servidor devolvió una respuesta vacía.');
  return payload as T;
}

export async function createRoom(name: string) {
  return request<RoomResponse>('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

export async function joinRoom(code: string, name: string) {
  return request<RoomResponse>(`/api/rooms/${encodeURIComponent(code)}/join`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

function authenticated(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` };
}

export async function getRoom(code: string, playerId: string, playerToken: string) {
  const query = new URLSearchParams({ playerId });
  return request<{ room: GameRoom }>(`/api/rooms/${encodeURIComponent(code)}?${query}`, {
    headers: authenticated(playerToken),
  });
}

export async function submitCards(code: string, playerId: string, playerToken: string, cards: string[]) {
  return request<{ room: GameRoom }>(`/api/rooms/${encodeURIComponent(code)}/submissions`, {
    method: 'POST',
    headers: authenticated(playerToken),
    body: JSON.stringify({ playerId, cards }),
  });
}

export async function voteForSubmission(code: string, playerId: string, playerToken: string, submissionId: string) {
  return request<{ room: GameRoom }>(`/api/rooms/${encodeURIComponent(code)}/vote`, {
    method: 'POST',
    headers: authenticated(playerToken),
    body: JSON.stringify({ playerId, submissionId }),
  });
}

export async function nextRound(code: string, playerId: string, playerToken: string) {
  return request<{ room: GameRoom }>(`/api/rooms/${encodeURIComponent(code)}/next`, {
    method: 'POST',
    headers: authenticated(playerToken),
    body: JSON.stringify({ playerId }),
  });
}

export async function startRoom(code: string, playerId: string, playerToken: string, roundsLimit: 5 | 10 | 20) {
  return request<{ room: GameRoom }>(`/api/rooms/${encodeURIComponent(code)}/start`, {
    method: 'POST',
    headers: authenticated(playerToken),
    body: JSON.stringify({ playerId, roundsLimit }),
  });
}

export async function prepareRoom(code: string, playerId: string, playerToken: string) {
  return request<{ room: GameRoom }>(`/api/rooms/${encodeURIComponent(code)}/prepare`, {
    method: 'POST',
    headers: authenticated(playerToken),
    body: JSON.stringify({ playerId }),
  });
}

export async function submitCustomCard(code: string, playerId: string, playerToken: string, cardText: string) {
  return request<{ room: GameRoom }>(`/api/rooms/${encodeURIComponent(code)}/custom-card`, {
    method: 'POST',
    headers: authenticated(playerToken),
    body: JSON.stringify({ playerId, cardText }),
  });
}

export async function setReady(code: string, playerId: string, playerToken: string, ready: boolean) {
  return request<{ room: GameRoom }>(`/api/rooms/${encodeURIComponent(code)}/ready`, {
    method: 'POST',
    headers: authenticated(playerToken),
    body: JSON.stringify({ playerId, ready }),
  });
}

export async function leaveRoom(code: string, playerId: string, playerToken: string) {
  return request<{ success: true }>(`/api/rooms/${encodeURIComponent(code)}/players/${encodeURIComponent(playerId)}`, {
    method: 'DELETE',
    headers: authenticated(playerToken),
  });
}

export async function kickRoomPlayer(code: string, playerId: string, playerToken: string, targetId: string) {
  return request<{ room: GameRoom }>(`/api/rooms/${encodeURIComponent(code)}/kick`, {
    method: 'POST',
    headers: authenticated(playerToken),
    body: JSON.stringify({ playerId, targetId }),
  });
}
