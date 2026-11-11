import type { APIRoute } from 'astro';
import { apiError, readJson } from '../../../../lib/api';
import { GameServiceError } from '../../../../lib/game-errors';
import { prepareRoom } from '../../../../lib/game-service';
import { authenticatePlayer } from '../../../../lib/player-auth';

export const POST: APIRoute = async ({ params, request }) => {
  try {
    const { playerId } = await readJson(request);
    if (typeof playerId !== 'string') throw new GameServiceError('Falta el identificador del anfitrión.');
    authenticatePlayer(request, playerId);
    return Response.json({ room: await prepareRoom(params.code ?? '', playerId) });
  } catch (error) {
    return apiError(error);
  }
};
