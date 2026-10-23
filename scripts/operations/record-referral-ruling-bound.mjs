/**
 * @file scripts/operations/record-referral-ruling-bound.mjs
 * @description `record-referral-ruling`'s sinks with the operator ruling BOUND to the authenticated poster (audit of
 *   59bcf94): before the ruling comment is posted, the `gh` identity under the operator channel must be a human on the
 *   operator allowlist and equal `--actor`, and the comment is posted AS that identity (App tokens removed). The
 *   automatic-policy actor is untouched. The unbound factory stays for its own tests; `run.mjs` should bind this one
 *   (`sinks: createBoundRecordReferralRulingSinks()`, one line; `run.mjs` was held by other PRs).
 */
import { AUTO_POLICY_ACTOR } from '../lib/jury-core.mjs';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { assertHumanOperator, operatorGhEnv, resolveOperatorIdentity } from '../lib/operator-identity.mjs';
import { createRecordReferralRulingSinks } from './record-referral-ruling-io.mjs';
import { OPERATOR_RULING_POST_EFFECT } from './record-referral-ruling.mjs';

export function createBoundRecordReferralRulingSinks({ env = process.env, resolveIdentity = () => resolveOperatorIdentity({ env }), post, ...rest } = {}) {
  const sinks = createRecordReferralRulingSinks({ ...rest, env,
    post: post ?? ((repo, pr, body) => execFileSyncThrottled('gh', ['pr', 'comment', String(pr), '--repo', repo, '--body', body],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, env: operatorGhEnv(env) })) });
  const inner = sinks[OPERATOR_RULING_POST_EFFECT];
  sinks[OPERATOR_RULING_POST_EFFECT] = async (payload) => {
    if (String(payload?.actor ?? '').toLowerCase() !== AUTO_POLICY_ACTOR) assertHumanOperator(resolveIdentity(), payload?.actor);
    return inner(payload);
  };
  return sinks;
}
