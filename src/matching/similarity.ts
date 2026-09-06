import { isDegenerateTitle, normalizeTitle, titleTokens } from "./normalize.js";

/**
 * Token-set Dice coefficient, 0..1.
 *
 * Two titles that normalize to nothing score 0, never 1: an absent title is
 * not evidence of a match. This is the specific behaviour that upstream's
 * exact-equality check got wrong for Hebrew.
 */
export function titleSimilarity(a: string, b: string): number {
  if (isDegenerateTitle(a) || isDegenerateTitle(b)) return 0;
  if (normalizeTitle(a) === normalizeTitle(b)) return 1;

  const setA = new Set(titleTokens(a));
  const setB = new Set(titleTokens(b));
  if (setA.size === 0 || setB.size === 0) return 0;

  let shared = 0;
  for (const token of setA) if (setB.has(token)) shared += 1;
  return (2 * shared) / (setA.size + setB.size);
}

/**
 * Duration agreement, 0..1. Podcast feeds and directories routinely disagree
 * by a few seconds on the same file, so small gaps stay near 1.
 */
export function durationSimilarity(a: number, b: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return 0;
  const delta = Math.abs(a - b);
  if (delta <= 5) return 1;
  if (delta <= 30) return 0.85;
  if (delta <= 120) return 0.5;
  return 0;
}

/** Publication-date agreement, 0..1. Time zones make same-day the useful unit. */
export function dateSimilarity(a: string, b: string): number {
  const parsedA = Date.parse(a);
  const parsedB = Date.parse(b);
  if (!Number.isFinite(parsedA) || !Number.isFinite(parsedB)) return 0;
  const deltaDays = Math.abs(parsedA - parsedB) / 86_400_000;
  if (deltaDays <= 1) return 1;
  if (deltaDays <= 2) return 0.6;
  return 0;
}
