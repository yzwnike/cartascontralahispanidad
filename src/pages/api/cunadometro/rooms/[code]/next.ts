import type { APIRoute } from 'astro';
import { apiError, readJson } from '../../../../../lib/api';
import { GameServiceError } from '../../../../../lib/game-errors';
import { nextCunadometroRound } from '../../../../../lib/cunadometro-service';
import { authenticatePlayer } from '../../../../../lib/player-auth';

export const POST: APIRoute = async ({ params, request }) => {
  try {
    const { playerId } = await readJson(request);
    if (typeof playerId !== 'string') throw new GameServiceError('Falta el identificador de jugador.');
    authenticatePlayer(request, playerId);
    return Response.json({ room: await nextCunadometroRound(params.code ?? '', playerId) });
  } catch (error) {
    return apiError(error);
  }
};
