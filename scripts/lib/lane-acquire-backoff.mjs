/** Spread concurrent acquire polls around the base interval. */
export function jitteredDelayMs(baseMs, rng = Math.random) {
  return baseMs * (0.5 + rng());
}
