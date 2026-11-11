import type { APIRoute } from 'astro';
import { apiError, readJson } from '../../../../../lib/api';
import { GameServiceError } from '../../../../../lib/game-errors';
import { voteCunadometroAnswer } from '../../../../../lib/cunadometro-service';
import { authenticatePlayer } from '../../../../../lib/player-auth';

export const POST: APIRoute = async ({ params, request }) => {
  try {
    const { playerId, answerId } = await readJson(request);
    if (typeof playerId !== 'string' || typeof answerId !== 'string') {
      throw new GameServiceError('Falta el jugador o la respuesta que quieres votar.');
    }
    authenticatePlayer(request, playerId);
    return Response.json({ room: await voteCunadometroAnswer(params.code ?? '', playerId, answerId) });
  } catch (error) {
    return apiError(error);
  }
};
