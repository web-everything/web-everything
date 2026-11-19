import { renderRedTeamComment } from '../../../operations/review-extra-seats.mjs';
import { redTeamGateMarker, liveResultGateState } from '../../../lib/red-team-gate.mjs';
import { REARM_COMMENT_MARKER } from '../../rearm-round-count.mjs';

/** #7031 repair-loop shape: a trusted send-back and three proven mechanical-only rounds. */
export function acceptedRedTeamRepair(number = 7031) {
  const head = 'a'.repeat(40), author = { login: 'web-everything' };
  const comments = [1, 2, 3].map(hour => ({ author, body: REARM_COMMENT_MARKER,
    createdAt: `2026-11-18T0${hour}:30:00Z` }));
  comments.push({ author, body: renderRedTeamComment({ pr: number, rev: head, provider: 'codex', model: 'm',
    recheckStatus: 'ok', foldedVerdict: 'changes', findings: [{ summary: 'Gate break to repair',
      category: 'edge-case', impactIfUnfixed: 'broken', file: 'scripts/example.mjs', line: 1, confirmedByRecheck: true }] }) });
  comments.push({ author, body: redTeamGateMarker(number, head, 'sent-back', liveResultGateState(comments, number, head).resultId) });
  const commits = ['a', 'b', 'c'].map((letter, i) => ({ sha: letter.repeat(40),
    parents: [String.fromCharCode(letter.charCodeAt(0) + 1).repeat(40), 'e'.repeat(40)],
    subject: 'Merge main', authoredAt: `2026-11-18T0${3 - i}:00:00Z`, mergesPrWork: false }));
  return { number, state: 'OPEN', headRefName: `lane/${number}-repair`, headRefOid: head, baseRefName: 'main',
    labels: ['review:accepted', 'red-team:blocked'], isDraft: false, mergeStateStatus: 'CLEAN',
    comments, commentsComplete: true, files: ['scripts/example.mjs'], statusCheckRollup: [],
    roundCommits: { head, commits } };
}

export function failingRedTeamRepair(number = 7031) {
  const pr = acceptedRedTeamRepair(number);
  pr.comments = pr.comments.slice(3);
  delete pr.roundCommits;
  pr.statusCheckRollup = [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', headSha: pr.headRefOid }];
  return pr;
}

/** Ordinary planner paths keep the accepted/blocked labels without selecting red-team accounting. */
export function ordinaryAcceptedRedTeamRepair(kind, evidence = 'current') {
  const pr = kind === 'ci-heal' ? failingRedTeamRepair(7) : acceptedRedTeamRepair(7);
  pr.comments = pr.comments.slice(kind === 'ci-heal' ? 0 : 3);
  delete pr.roundCommits;
  pr.title = 'Accepted repair fixture';
  pr.body = 'Preserve the branch work while repairing the PR';
  if (evidence === 'missing') pr.comments = [];
  if (evidence === 'stale') pr.headRefOid = 'b'.repeat(40);
  if (kind === 'conflict') {
    pr.baseRefName = 'lane/base'; // The planner owns stacked-base conflicts; the drain owns main-base conflicts.
    pr.mergeStateStatus = 'DIRTY';
    pr.mergeable = 'CONFLICTING';
  } else if (kind === 'ordinary') {
    pr.labels.push('review:changes');
    pr.comments.push({ author: { login: 'web-everything' }, body: '🔁 review — changes requested\nOrdinary repair evidence' });
  }
  return pr;
}

/** Raw git IO for the real commit reader, including its clean-merge proof. */
export function roundCommitGitOutput(pr, args) {
  if (args[0] === 'fetch') return '';
  if (args[0] === 'log') return pr.roundCommits.commits.map(c =>
    [c.sha, c.parents.join(' '), 'f'.repeat(40), c.authoredAt, c.subject].join('\0')).join('\n');
  if (args[0] === 'merge-tree') return `${'f'.repeat(40)}\0`;
  throw new Error(`unexpected commit IO: ${args.join(' ')}`);
}
