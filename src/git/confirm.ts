/**
 * Confirmation tokens for destructive operations.
 *
 * A blanket `{ confirmed: true }` inside the git layer would make the runner's
 * safety gate decorative: every call would arrive pre-approved, and a future
 * caller could reach `branch -D` or a force push without the user ever seeing a
 * warning. A token has to be minted where the user actually answered — the UI —
 * and carries what they were told, so the reason can be logged or shown.
 */

import { GitError } from './errors';

const TOKEN = Symbol('krakenless.confirmation');

export interface Confirmation {
  readonly [TOKEN]: true;
  /** What the user agreed to, in the words they saw. */
  readonly reason: string;
}

/**
 * Mints a confirmation. Call this **only** from the code path that showed the
 * user what will happen and got an explicit answer.
 */
export function userConfirmed(reason: string): Confirmation {
  if (reason.trim().length === 0) {
    throw new Error('A confirmation must say what the user agreed to');
  }
  return { [TOKEN]: true, reason };
}

/** Type guard used by the git layer before running anything destructive. */
export function isConfirmation(value: unknown): value is Confirmation {
  return typeof value === 'object' && value !== null && TOKEN in value;
}

/**
 * Turns a token into the runner's gate.
 *
 * The reason is re-checked here rather than trusted from minting time: this is
 * the last point before a destructive command runs, and a token whose reason
 * was emptied says the user agreed to nothing.
 */
export function approve(confirmation: Confirmation): { confirmed: true } {
  // The token symbol is re-checked too, not just the reason: this is the last
  // gate, and an object cast into the type never passed through
  // `userConfirmed`, so nobody was ever asked.
  if (!isConfirmation(confirmation) || confirmation.reason.length === 0) {
    throw new GitError('needs-confirmation', 'Confirmation is missing its reason');
  }
  return { confirmed: true };
}
