/**
 * @file scripts/operations/pre-pr-check-io.mjs
 * @description The one real read behind the `pre-pr-check` operation: `checkPrePrReview` over the given lane
 *   checkout (read-only git plumbing plus the receipt file), exactly what `open-pr` runs. Bound only in run.mjs.
 */
import { resolve } from 'node:path';
import { checkPrePrReview } from '../lib/pre-pr-review.mjs';

export function createPrePrCheckReader({ check = checkPrePrReview } = {}) {
  return ({ checkout }) => check({ cwd: resolve(String(checkout || '')), base: 'main', sha: 'HEAD' });
}
