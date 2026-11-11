import type { APIRoute } from 'astro';
import { apiError, readJson } from '../../../../lib/api';
import { GameServiceError } from '../../../../lib/game-errors';
import { rerollCard } from '../../../../lib/game-service';
import { authenticatePlayer } from '../../../../lib/player-auth';

export const POST: APIRoute = async ({ params, request }) => {
  try {
    const { playerId, cardIndex } = await readJson(request);
    if (typeof playerId !== 'string') throw new GameServiceError('Falta el identificador de jugador.');
    authenticatePlayer(request, playerId);
    return Response.json({ room: await rerollCard(params.code ?? '', playerId, cardIndex) });
  } catch (error) {
    return apiError(error);
  }
};
