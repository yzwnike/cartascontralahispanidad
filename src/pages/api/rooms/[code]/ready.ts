import type { APIRoute } from 'astro';
import { apiError, readJson } from '../../../../lib/api';
import { GameServiceError } from '../../../../lib/game-errors';
import { setPlayerReady } from '../../../../lib/game-service';
import { authenticatePlayer } from '../../../../lib/player-auth';

export const POST: APIRoute = async ({ params, request }) => {
  try {
    const { playerId, ready } = await readJson(request);
    if (typeof playerId !== 'string' || typeof ready !== 'boolean') {
      throw new GameServiceError('Falta el jugador o el estado de preparación.');
    }
    authenticatePlayer(request, playerId);
    return Response.json({ room: await setPlayerReady(params.code ?? '', playerId, ready) });
  } catch (error) {
    return apiError(error);
  }
};
