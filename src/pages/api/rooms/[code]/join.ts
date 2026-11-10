import type { APIRoute } from 'astro';
import { apiError, readJson } from '../../../../lib/api';
import { joinRoom } from '../../../../lib/game-service';

export const POST: APIRoute = async ({ params, request }) => {
  try {
    const { name } = await readJson(request);
    return Response.json(await joinRoom(params.code ?? '', name), { status: 201 });
  } catch (error) {
    return apiError(error);
  }
};
