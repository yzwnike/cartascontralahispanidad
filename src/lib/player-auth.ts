import { createHmac, timingSafeEqual } from 'node:crypto';
import { GameServiceError } from './game-errors';

const TOKEN_LIFETIME_SECONDS = 60 * 60 * 24 * 30;

function tokenSecret() {
  const secret = process.env.PLAYER_TOKEN_SECRET;
  if (!secret || secret.length < 32) {
    throw new GameServiceError('Configura PLAYER_TOKEN_SECRET con al menos 32 caracteres en el entorno del servidor.', 503);
  }
  return secret;
}

function signature(payload: string) {
  return createHmac('sha256', tokenSecret()).update(payload).digest('base64url');
}

export function createPlayerToken(playerId: string) {
  const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_LIFETIME_SECONDS;
  const payload = `${playerId}.${expiresAt}`;
  return `${payload}.${signature(payload)}`;
}

export function authenticatePlayer(request: Request, expectedPlayerId: string) {
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) throw new GameServiceError('La sesión de jugador no es válida. Vuelve a unirte a la sala.', 401);
  const [playerId, expiresAt, suppliedSignature, extra] = token.split('.');
  if (!playerId || !expiresAt || !suppliedSignature || extra || playerId !== expectedPlayerId) {
    throw new GameServiceError('La sesión no corresponde a este jugador.', 401);
  }
  const expiry = Number(expiresAt);
  if (!Number.isSafeInteger(expiry) || expiry < Math.floor(Date.now() / 1000)) {
    throw new GameServiceError('La sesión ha caducado. Vuelve a unirte a la sala.', 401);
  }
  const expectedSignature = signature(`${playerId}.${expiry}`);
  const supplied = Buffer.from(suppliedSignature);
  const expected = Buffer.from(expectedSignature);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new GameServiceError('La sesión de jugador no es válida.', 401);
  }
}
