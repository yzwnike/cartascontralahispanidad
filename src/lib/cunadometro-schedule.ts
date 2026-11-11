import { randomInt } from 'node:crypto';
import { duelsPerPlayer, type GameLength } from './cunadometro-length';

export { type GameLength } from './cunadometro-length';
export type GamePhase = 'opening_duels' | 'middle_general' | 'closing_duels' | 'final_general';

export type ScheduledRound = {
  mode: 'duel' | 'all_play';
  phase: GamePhase;
  duelPlayerIds: string[];
};

function shuffle<T>(values: T[]): T[] {
  const shuffled = [...values];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const swapIndex = randomInt(index + 1);
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function evenPlayerMatchings(players: string[]): string[][][] {
  const rotation = [...players];
  const matchings: string[][][] = [];

  for (let round = 0; round < players.length - 1; round++) {
    const pairs: string[][] = [];
    for (let index = 0; index < players.length / 2; index++) {
      pairs.push([rotation[index], rotation[rotation.length - 1 - index]]);
    }
    matchings.push(pairs);
    rotation.splice(1, 0, rotation.pop()!);
  }

  return matchings;
}

function pairPlayers(players: string[], countPerPlayer: number): string[][] {
  const shuffledPlayers = shuffle(players);

  if (shuffledPlayers.length % 2 === 0) {
    const matchings = evenPlayerMatchings(shuffledPlayers);
    return Array.from({ length: countPerPlayer }, (_, index) => matchings[index % matchings.length])
      .flatMap((matching) => matching.map((pair) => [...pair]));
  }

  const cycles: string[][][] = [];
  for (let offset = 1; offset <= Math.floor((shuffledPlayers.length - 1) / 2); offset++) {
    cycles.push(shuffledPlayers.map((player, index) => [
      player,
      shuffledPlayers[(index + offset) % shuffledPlayers.length],
    ]));
  }

  const pairs: string[][] = [];
  for (let played = 0; played < countPerPlayer; played += 2) {
    const cycle = cycles[(played / 2) % cycles.length];
    pairs.push(...cycle.map((pair) => [...pair]));
  }
  return shuffle(pairs);
}

export function createGameSchedule(playerIds: string[], length: GameLength): ScheduledRound[] {
  const perHalf = duelsPerPlayer(length, playerIds.length);
  const createDuelRounds = (phase: 'opening_duels' | 'closing_duels') =>
    pairPlayers(playerIds, perHalf).map((duelPlayerIds) => ({ mode: 'duel' as const, phase, duelPlayerIds }));

  return [
    ...createDuelRounds('opening_duels'),
    { mode: 'all_play', phase: 'middle_general', duelPlayerIds: [] },
    ...createDuelRounds('closing_duels'),
    { mode: 'all_play', phase: 'final_general', duelPlayerIds: [] },
  ];
}
