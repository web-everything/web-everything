/** Pure publication and terminal seal plans for card-only batches (#4703, x2fvt08). */
import { shouldSeal } from '../lib/card-batch-policy.mjs';

export function planPublish({ state, kind, policy, now }) {
  return { action: state.pr ? 'refresh-body' : 'open-draft',
    reason: state.sealedAt ? null : shouldSeal({ count: state.members.length, openedAt: state.openedAt, now }, policy[kind]) };
}

/** A member's source: the PR it came from when there is one, else the filer's note, else the repo alone. */
export function memberSource(source = {}) {
  const pr = source.pr != null && source.pr !== '' ? `${source.repo}#${source.pr}` : source.repo;
  return [pr, source.note].filter(Boolean).join(' — ');
}

export function renderBatchBody(state) {
  return `Card-only batch ${state.batchRef} (${state.members.length} card${state.members.length === 1 ? '' : 's'}, one commit each)\n\n${
    state.members.map(member => `- ${member.cardId} — ${memberSource(member.source)}${
      member.commitSha ? ` (${String(member.commitSha).slice(0, 9)})` : ''}`).join('\n')}\n`;
}

/** Steps name completed durable boundaries; unknown progress is never treated as green. */
export function planSeal({ state, reason }) {
  if (state.sealFailure) return { action: 'held', reason: state.sealFailure.reason, steps: [] };
  const steps = ['record-sealed', 'verify', 'remove-hold', 'ready', 'label-on-green'];
  const completed = state.seal?.step ?? (state.sealedAt ? 'record-sealed' : null);
  if (completed && !steps.includes(completed)) throw new Error('unknown seal step');
  return { action: 'seal', reason: state.seal?.reason ?? reason, steps: steps.slice(steps.indexOf(completed) + 1) };
}
