/** Shared seat policy must not import the review operation or its label/merge graph. */
import { liveStatusFor as liveProbationStatusFor } from '../lib/model-probation.mjs';
import { ANTIGRAVITY_MODEL } from '../lib/antigravity-judge-spawn.mjs';

export const ANTIGRAVITY_REVIEW_ENV_VAR = 'REVIEW_PR_ANTIGRAVITY_REVIEW';

export function antigravityReviewFromEnv(env = process.env, { isOnProbation = defaultAntigravityReviewProbationCheck } = {}) {
  if (env && Object.hasOwn(env, ANTIGRAVITY_REVIEW_ENV_VAR)) return env[ANTIGRAVITY_REVIEW_ENV_VAR] === '1';
  return isOnProbation();
}

export function defaultAntigravityReviewProbationCheck() {
  const status = liveProbationStatusFor({ provider: 'antigravity', model: ANTIGRAVITY_MODEL, role: 'advisory-review' });
  return status === 'probation' || status === 'trusted';
}

