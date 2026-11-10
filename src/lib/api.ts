import { GameServiceError } from './game-errors';

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new GameServiceError('El cuerpo de la petición debe ser un objeto JSON.');
    }
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof GameServiceError) throw error;
    throw new GameServiceError('El cuerpo de la petición no contiene JSON válido.');
  }
}

export function apiError(error: unknown): Response {
  if (error instanceof GameServiceError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof Error && error.message.startsWith('Falta DATABASE_URL')) {
    return Response.json({ error: error.message }, { status: 503 });
  }
  console.error('Error inesperado en la API de Cartas Caos:', error);
  return Response.json({ error: 'Error interno del servidor. Consulta los registros de Astro.' }, { status: 500 });
}
