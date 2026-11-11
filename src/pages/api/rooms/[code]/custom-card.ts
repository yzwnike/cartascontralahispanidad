import type { APIRoute } from 'astro';
import { apiError, readJson } from '../../../../lib/api';
import { GameServiceError } from '../../../../lib/game-errors';
import { submitCustomCard } from '../../../../lib/game-service';
import { authenticatePlayer } from '../../../../lib/player-auth';

export const POST: APIRoute = async ({ params, request }) => {
  try {
    const { playerId, cardText } = await readJson(request);
    if (typeof playerId !== 'string') throw new GameServiceError('Falta el identificador de jugador.');
    authenticatePlayer(request, playerId);
    return Response.json({ room: await submitCustomCard(params.code ?? '', playerId, cardText) });
  } catch (error) {
    return apiError(error);
  }
};
