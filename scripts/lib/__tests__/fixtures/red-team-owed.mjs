import { renderRedTeamComment } from '../../../operations/review-extra-seats.mjs';

export const runIdentity = { runId: 'red-team-fixture', order: 0 };
export const completedExecution = head => ({ ...runIdentity, head, status: 'finished',
  result: { ...runIdentity, status: 'ran', foldedVerdict: 'accept', findings: [] } });
export const completedRuns = () => Object.fromEntries(['result', 'comment', 'seats', 'execution', 'verdict', 'carry']
  .map(key => [key, key === 'carry' ? [] : [{ ...runIdentity, outcome: 'complete' }]]));

export const reviewedRead = (head, files = ['scripts/example.mjs']) => ({
  netBasis: { rev: head }, diffScored: true,
  diffText: `diff --git a/${files[0]} b/${files[0]}\n+reviewed change\n`,
  netChangedFiles: files, netRenameSources: [],
});
export const completedSeat = (head, extra = {}) => ({
  ...runIdentity, rubricVersion: 'v1', subjectClass: 'work-agent', provider: 'fixture', model: 'fixture',
  dispatchKind: 'review-seat', seat: 'red-team', repo: 'fixture/repo', pr: 42, rev: head,
  criteriaEvaluated: 1, score: 100, deductions: [], valid: true, status: 'ok', seatStatus: 'ok', ...extra,
});
export const completedComment = (pr, head, findings = []) => ({ author: { login: 'web-everything' },
  body: renderRedTeamComment({ pr, rev: head, findings, runId: runIdentity.runId, provider: 'fixture', model: 'fixture',
    recheckStatus: 'ok', foldedVerdict: findings.length ? 'changes' : 'accept' }),
});

// An explicitly read empty status/journal/queue, for tests of unrelated admission behavior.
export const idleEvidence = () => ({ ok: true, status: null, carry: null, queued: false,
  inFlight: false, recorded: false, scheduled: false, skipCardOnly: true, seats: [] });
export const exemptInput = head => ({ head, read: reviewedRead(head, ['backlog/123-card.md']),
  seats: [], result: null, carry: null, runs: { result: [], comment: [], seats: [], execution: [], verdict: [], carry: [] }, ok: true, carryConflict: false, hasBreak: false, blocked: false, storedVerdict: null, breakResolved: false, pendingPublish: false,
  scheduling: { skipCardOnly: true, settingsReadable: true, commentsReadable: true, sealClear: true,
    execution: 'none', inFlight: false, queued: false, scheduled: false, recorded: false } });
