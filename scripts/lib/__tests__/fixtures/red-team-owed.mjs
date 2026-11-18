import { renderRedTeamComment } from '../../../operations/review-extra-seats.mjs';

export const reviewedRead = (head, files = ['scripts/example.mjs']) => ({
  netBasis: { rev: head }, diffScored: true,
  diffText: `diff --git a/${files[0]} b/${files[0]}\n+reviewed change\n`,
  netChangedFiles: files, netRenameSources: [],
});
export const completedSeat = (head, extra = {}) => ({
  rubricVersion: 'v1', subjectClass: 'work-agent', provider: 'fixture', model: 'fixture',
  dispatchKind: 'review-seat', seat: 'red-team', repo: 'fixture/repo', pr: 42, rev: head,
  criteriaEvaluated: 1, score: 100, deductions: [], valid: true, status: 'ok', seatStatus: 'ok', ...extra,
});
export const completedComment = (pr, head, findings = []) => ({ author: { login: 'web-everything' },
  body: renderRedTeamComment({ pr, rev: head, findings, provider: 'fixture', model: 'fixture',
    recheckStatus: 'ok', foldedVerdict: findings.length ? 'changes' : 'accept' }),
});
