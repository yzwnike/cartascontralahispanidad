import type { APIRoute } from 'astro';
import { apiError, readJson } from '../../../../lib/api';
import { submitCards } from '../../../../lib/game-service';
import { GameServiceError } from '../../../../lib/game-errors';
import { authenticatePlayer } from '../../../../lib/player-auth';

export const POST: APIRoute = async ({ params, request }) => {
  try {
    const { playerId, cards } = await readJson(request);
    if (typeof playerId !== 'string') throw new GameServiceError('Falta el identificador de jugador.');
    authenticatePlayer(request, playerId);
    return Response.json({ room: await submitCards(params.code ?? '', playerId, cards) });
  } catch (error) {
    return apiError(error);
  }
};
