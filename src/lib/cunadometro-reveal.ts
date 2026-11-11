import type { CunadometroMode } from './cunadometro';

export const REVEAL_PROMPT_DURATION_MS = 4000;
export const DUEL_ANSWER_STAGGER_MS = 2000;
export const GROUP_ANSWER_STAGGER_MS = 350;
export const REVEAL_BOARD_TRANSITION_MS = 420;
export const ANSWER_REVEAL_DURATION_MS = 550;
export const REVEAL_VOTE_BUFFER_MS = 350;

export function getRevealVoteDelay(mode: CunadometroMode, answerCount: number) {
  const stagger = mode === 'duel' ? DUEL_ANSWER_STAGGER_MS : GROUP_ANSWER_STAGGER_MS;
  return REVEAL_PROMPT_DURATION_MS
    + REVEAL_BOARD_TRANSITION_MS
    + Math.max(0, answerCount - 1) * stagger
    + ANSWER_REVEAL_DURATION_MS
    + REVEAL_VOTE_BUFFER_MS;
}

export function getAnswerRevealStart(mode: CunadometroMode, index: number) {
  const stagger = mode === 'duel' ? DUEL_ANSWER_STAGGER_MS : GROUP_ANSWER_STAGGER_MS;
  return REVEAL_PROMPT_DURATION_MS + REVEAL_BOARD_TRANSITION_MS + index * stagger;
}
