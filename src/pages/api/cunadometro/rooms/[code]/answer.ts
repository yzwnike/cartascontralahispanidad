import type { APIRoute } from 'astro';
import { apiError, readJson } from '../../../../../lib/api';
import { GameServiceError } from '../../../../../lib/game-errors';
import { submitCunadometroAnswer } from '../../../../../lib/cunadometro-service';
import { authenticatePlayer } from '../../../../../lib/player-auth';

export const POST: APIRoute = async ({ params, request }) => {
  try {
    const { playerId, text } = await readJson(request);
    if (typeof playerId !== 'string') throw new GameServiceError('Falta el identificador de jugador.');
    authenticatePlayer(request, playerId);
    return Response.json({ room: await submitCunadometroAnswer(params.code ?? '', playerId, text) });
  } catch (error) {
    return apiError(error);
  }
};
