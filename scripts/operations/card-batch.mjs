/** Pure card-batch admission and recovery plans; IO supplies verified remote history. */
import {
  loadCardBatchPolicy, validateCardBatchPolicy, cardOnlyEligibility, CARD_BATCH_KINDS,
} from '../lib/card-batch-policy.mjs';

const refuse = reason => ({ action: 'refuse', reason });
const millis = value => typeof value === 'number' ? value : Date.parse(value);

/** Merge by idempotency key, preserving the original member and input arrays. */
export function mergeMembers(members = [], additions = []) {
  const merged = [...members];
  for (const member of additions) {
    if (!merged.some(existing => existing.idemKey === member.idemKey)) merged.push(member);
  }
  return merged;
}

/** Entries must be oldest first, with tree/message evidence already checked by the IO shell. */
export function planReconcile(state, remoteLogEntries) {
  let headSha = state.headSha;
  let members = [...state.members];
  for (const entry of remoteLogEntries) {
    if (entry.parentSha !== headSha || entry.batchRef !== state.batchRef
      || !entry.member?.idemKey || !entry.member?.cardId
      || entry.member.commitSha !== entry.commitSha
      || members.some(member => member.idemKey === entry.member.idemKey)
      || !cardOnlyEligibility([{ status: 'A', mode: '100644', path: entry.cardPath }]).ok) {
      return refuse('head-mismatch');
    }
    members = mergeMembers(members, [entry.member]);
    headSha = entry.commitSha;
  }
  return { action: 'reconcile', state: { ...state, headSha, members } };
}

/** A sealed state is terminal; a successor starts with its predecessor's seq and no batchRef. */
export function planAdmit({ state, input, policy, now, owner }) {
  if (!CARD_BATCH_KINDS.includes(input.kind)) return refuse('unknown-kind');
  const checked = validateCardBatchPolicy(policy === undefined ? loadCardBatchPolicy() : policy);
  if (!checked.ok) return refuse('invalid-policy');
  if (!checked.policy[input.kind].enabled) return refuse('kind-disabled');
  if (!cardOnlyEligibility([{ status: 'A', mode: '100644', path: input.cardPath }]).ok) {
    return refuse('ineligible-change');
  }
  if (state?.lease && state.lease.owner !== owner && millis(state.lease.expiresAt) > millis(now)) {
    return refuse('lease-held');
  }
  if (Object.hasOwn(input, 'remoteHead') && state?.batchRef && input.remoteHead !== state.headSha) {
    if (!state.sealedAt && input.remoteLogEntries?.length) {
      const recovery = planReconcile(state, input.remoteLogEntries);
      if (recovery.action === 'reconcile' && recovery.state.headSha === input.remoteHead) return recovery;
    }
    return refuse('head-mismatch');
  }
  const member = state?.members?.find(member => member.idemKey === input.idemKey);
  if (member) return { action: 'dedupe', member, batchRef: state.batchRef };
  if (state?.sealedAt) return refuse('batch-sealed');
  const seq = state?.batchRef ? state.seq : (state?.seq ?? 0) + 1;
  return { action: 'admit', batchRef: state?.batchRef ?? `lane/card-batch-${input.kind}-${seq}`, seq };
}
