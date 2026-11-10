import type { APIRoute } from 'astro';
import { apiError, readJson } from '../../../../lib/api';
import { castVote } from '../../../../lib/game-service';
import { GameServiceError } from '../../../../lib/game-errors';
import { authenticatePlayer } from '../../../../lib/player-auth';

export const POST: APIRoute = async ({ params, request }) => {
  try {
    const { playerId, submissionId } = await readJson(request);
    if (typeof playerId !== 'string' || typeof submissionId !== 'string') {
      throw new GameServiceError('Falta el identificador del jugador o de la respuesta.');
    }
    authenticatePlayer(request, playerId);
    return Response.json({ room: await castVote(params.code ?? '', playerId, submissionId) });
  } catch (error) {
    return apiError(error);
  }
};
