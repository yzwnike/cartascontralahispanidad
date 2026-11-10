import type { APIRoute } from 'astro';
import { apiError, readJson } from '../../../lib/api';
import { createRoom } from '../../../lib/game-service';

export const POST: APIRoute = async ({ request }) => {
  try {
    const { name } = await readJson(request);
    return Response.json(await createRoom(name), { status: 201 });
  } catch (error) {
    return apiError(error);
  }
};
