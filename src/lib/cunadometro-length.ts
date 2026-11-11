export type GameLength = 5 | 10 | 20;

export function duelsPerPlayer(length: GameLength, playerCount: number): number {
  const oddPlayers = playerCount % 2 !== 0;
  if (length === 5) return oddPlayers ? 2 : 1;
  if (length === 10) return oddPlayers ? 4 : 2;
  return oddPlayers ? 6 : 4;
}

export function totalGameRounds(length: GameLength, playerCount: number): number {
  return playerCount * duelsPerPlayer(length, playerCount) + 2;
}
