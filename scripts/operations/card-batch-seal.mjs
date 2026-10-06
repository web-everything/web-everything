/** Pure publication and terminal seal plans for card-only batches (#4703, x2fvt08). */
import { shouldSeal } from '../lib/card-batch-policy.mjs';

export function planPublish({ state, kind, policy, now }) {
  return { action: state.pr ? 'refresh-body' : 'open-draft',
    reason: state.sealedAt ? null : shouldSeal({ count: state.members.length, openedAt: state.openedAt, now }, policy[kind]) };
}

export function renderBatchBody(state) {
  return `Card-only batch ${state.batchRef}\n\n${state.members.map(member =>
    `- ${member.cardId} — ${member.source.repo}#${member.source.pr}`).join('\n')}\n`;
}

/** Steps name completed durable boundaries; unknown progress is never treated as green. */
export function planSeal({ state, reason }) {
  if (state.sealFailure) return { action: 'held', reason: state.sealFailure.reason, steps: [] };
  const steps = ['record-sealed', 'verify', 'remove-hold', 'ready', 'label-on-green'];
  const completed = state.seal?.step ?? (state.sealedAt ? 'record-sealed' : null);
  if (completed && !steps.includes(completed)) throw new Error('unknown seal step');
  return { action: 'seal', reason: state.seal?.reason ?? reason, steps: steps.slice(steps.indexOf(completed) + 1) };
}
