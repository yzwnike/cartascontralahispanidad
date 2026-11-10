import type { APIRoute } from 'astro';
import { apiError } from '../../../../../lib/api';
import { authenticatePlayer } from '../../../../../lib/player-auth';
import { leaveRoom } from '../../../../../lib/game-service';

export const DELETE: APIRoute = async ({ params, request }) => {
  try {
    authenticatePlayer(request, params.playerId ?? '');
    await leaveRoom(params.code ?? '', params.playerId ?? '');
    return Response.json({ success: true });
  } catch (error) {
    return apiError(error);
  }
};
