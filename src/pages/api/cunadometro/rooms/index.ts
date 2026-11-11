import type { APIRoute } from 'astro';
import { apiError, readJson } from '../../../../lib/api';
import { createCunadometroRoom } from '../../../../lib/cunadometro-service';

export const POST: APIRoute = async ({ request }) => {
  try {
    const { name } = await readJson(request);
    return Response.json(await createCunadometroRoom(name), { status: 201 });
  } catch (error) {
    return apiError(error);
  }
};
