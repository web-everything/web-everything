/**
 * @file scripts/lib/lane-pool-origin.mjs
 * @description LANE-POOL-WRONG-REPO: pure origin comparison. A lane whose origin differs from its pool's
 *   configured origin is wrong-origin. Unknown (null/empty) never marks a lane wrong.
 */
const norm = (u) => String(u || '').trim().replace(/\.git$/, '').replace(/^[a-z+]+:\/\/(?:[^@/]+@)?/i, '').replace(/^[^@/]+@/, '').replace(/^([^:/]+):/, '$1/').toLowerCase();

/** @param {string|null} a @param {string|null} b */
export function originsDiffer(a, b) {
  return Boolean(a && b && norm(a) !== norm(b));
}
