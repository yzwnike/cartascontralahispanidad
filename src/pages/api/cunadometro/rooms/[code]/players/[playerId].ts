import type { APIRoute } from 'astro';
import { apiError } from '../../../../../../lib/api';
import { leaveCunadometroRoom } from '../../../../../../lib/cunadometro-service';
import { authenticatePlayer } from '../../../../../../lib/player-auth';

export const DELETE: APIRoute = async ({ params, request }) => {
  try {
    const playerId = params.playerId ?? '';
    authenticatePlayer(request, playerId);
    await leaveCunadometroRoom(params.code ?? '', playerId);
    return Response.json({ success: true });
  } catch (error) {
    return apiError(error);
  }
};
