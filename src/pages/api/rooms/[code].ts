import type { APIRoute } from 'astro';
import { apiError } from '../../../lib/api';
import { getRoomState } from '../../../lib/game-service';
import { GameServiceError } from '../../../lib/game-errors';
import { authenticatePlayer } from '../../../lib/player-auth';

export const GET: APIRoute = async ({ params, request }) => {
  try {
    const playerId = new URL(request.url).searchParams.get('playerId');
    if (!playerId) throw new GameServiceError('Falta el identificador de jugador.');
    authenticatePlayer(request, playerId);
    return Response.json({ room: await getRoomState(params.code ?? '', playerId) });
  } catch (error) {
    return apiError(error);
  }
};
