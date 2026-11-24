import { parseEscalationReason } from '../review-detail.mjs';

/** Routing evidence shared by ordinary and fast review dispatch. */
export function reviewDispatchContext(subject) {
  return {
    escalationReason: parseEscalationReason(subject?.body ?? ''),
    scopePaths: (subject?.files ?? []).map(f => typeof f === 'string' ? f : f.path),
  };
}
