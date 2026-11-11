import type { APIRoute } from 'astro';
import { apiError, readJson } from '../../../../lib/api';
import { GameServiceError } from '../../../../lib/game-errors';
import { kickPlayer } from '../../../../lib/game-service';
import { authenticatePlayer } from '../../../../lib/player-auth';

export const POST: APIRoute = async ({ params, request }) => {
  try {
    const { playerId, targetId } = await readJson(request);
    if (typeof playerId !== 'string' || typeof targetId !== 'string') {
      throw new GameServiceError('Falta el identificador del anfitrión o del jugador a expulsar.');
    }
    authenticatePlayer(request, playerId);
    return Response.json({ room: await kickPlayer(params.code ?? '', playerId, targetId) });
  } catch (error) {
    return apiError(error);
  }
};
