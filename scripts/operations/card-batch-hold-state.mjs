/** Is this withdrawn draft an OPEN card batch still collecting cards (or waiting out a verify-capacity pause)? */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cardBatchStateDir } from './card-batch-io.mjs';
import { CARD_BATCH_KINDS, shouldSeal } from '../lib/card-batch-policy.mjs';
import { effectiveCardBatchPolicy } from '../lib/card-batch-settings.mjs';

const GRACE_MS = 60 * 60_000;
const ms = value => typeof value === 'number' ? value : Date.parse(value);

/** PURE: a batch is quiet only while it is inside its window, holds no seal failure and is not overdue to retry. */
export function batchHoldIsExpected(state, { now, policy }) {
  if (!state?.batchRef || state.sealFailure) return false;
  if (state.verifyRetryAfter) return now < ms(state.verifyRetryAfter) + GRACE_MS;
  if (state.sealedAt || state.seal) return false;
  const kind = state.kind ?? CARD_BATCH_KINDS.find(k => state.batchRef.includes(`card-batch-${k}-`));
  if (!kind || !policy?.[kind]) return false;
  try { return shouldSeal({ count: state.members?.length ?? 0, openedAt: state.openedAt, now }, policy[kind]) === null; }
  catch { return false; }
}

/** IO: any active state file whose recorded PR is `repo#number` and whose hold is expected. Fails open (false). */
export function isCollectingBatchPr(repo, number, { stateDir = cardBatchStateDir(), now = Date.now(), policy } = {}) {
  try {
    policy ??= effectiveCardBatchPolicy();
    for (const file of readdirSync(stateDir).filter(f => f.endsWith('.json'))) {
      let state;
      try { state = JSON.parse(readFileSync(join(stateDir, file), 'utf8')); } catch { continue; }
      const stateRepo = state.repo ?? state.members?.[0]?.source?.repo;
      if (Number(state.pr) === Number(number) && stateRepo === repo && batchHoldIsExpected(state, { now, policy })) return true;
    }
  } catch { /* unreadable state: keep alerting */ }
  return false;
}
