import type { APIRoute } from 'astro';
import { apiError, readJson } from '../../../../../lib/api';
import { GameServiceError } from '../../../../../lib/game-errors';
import { startCunadometroRoom } from '../../../../../lib/cunadometro-service';
import { authenticatePlayer } from '../../../../../lib/player-auth';

export const POST: APIRoute = async ({ params, request }) => {
  try {
    const { playerId, roundsLimit } = await readJson(request);
    if (typeof playerId !== 'string') throw new GameServiceError('Falta el identificador de jugador.');
    authenticatePlayer(request, playerId);
    return Response.json({ room: await startCunadometroRoom(params.code ?? '', playerId, roundsLimit) });
  } catch (error) {
    return apiError(error);
  }
};
