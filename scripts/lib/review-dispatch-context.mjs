import { parseEscalationReason } from '../review-detail.mjs';

/** Routing evidence shared by ordinary and fast review dispatch. */
export function reviewDispatchContext(subject) {
  // Missing or possibly-capped file evidence is unknown scope: keep the mandatory high-risk (Opus) routing.
  const files = Array.isArray(subject?.files) ? subject.files : null;
  const unknownScope = !files || files.length >= 100;
  return {
    escalationReason: parseEscalationReason(subject?.body ?? ''),
    scopePaths: (files ?? []).map(f => typeof f === 'string' ? f : f.path),
    ...(unknownScope ? { careLevel: 'high' } : {}),
  };
}
