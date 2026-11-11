import type { APIRoute } from 'astro';
import { apiError, readJson } from '../../../../../lib/api';
import { joinCunadometroRoom } from '../../../../../lib/cunadometro-service';

export const POST: APIRoute = async ({ params, request }) => {
  try {
    const { name } = await readJson(request);
    return Response.json(await joinCunadometroRoom(params.code ?? '', name), { status: 201 });
  } catch (error) {
    return apiError(error);
  }
};
