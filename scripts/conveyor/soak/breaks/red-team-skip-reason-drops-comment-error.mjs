/** Red-team skip reason dropped redTeam.comment.reason (card red-team-comment-error, 18x): the real cause was invisible. */
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export default {
  id: 'red-team-skip-reason-drops-comment-error',
  title: 'unpublished red-team skip reason carries the result-comment error',
  card: 'red-team-comment-error',
  fixedBy: { sha: '0'.repeat(40), where: 'lane/red-team-skip-reason', paths: ['scripts/operations/review-job.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/operations/review-job.mjs'), 'utf8').includes('commentReasonSuffix(redTeam?.comment?.reason');
  },
  async run({ sourceRoot } = {}) {
    const root = sourceRoot ?? resolve(fileURLToPath(import.meta.url), '../../../../..');
    const { CONSTELLATION_REPOS } = await import(pathToFileURL(join(root, 'scripts/lib/constellation-repos.mjs')).href);
    const { runReviewJob } = await import(pathToFileURL(join(root, 'scripts/operations/review-job.mjs')).href);
    const head = 'a'.repeat(40), loopPayload = { runId: 'review-pr-soak', stopped: 'complete',
      verdict: { verdict: 'accept', loop: { outcome: 'converged' }, findings: [], admittedFindings: [] },
      findings: { read: { title: 'Update card', body: '', diffText: 'diff --git a/backlog/1.md b/backlog/1.md\n+x\n',
        netChangedFiles: ['backlog/1.md'], netRenameSources: [], netBasis: { rev: head } } } };
    const reasonFor = (comment) => {
      let seen = null;
      const io = {
        root: process.cwd(), now: () => 1_000, newActorId: () => 'actor', readPrevCompletion: () => null,
        claim: () => ({ ok: true }), updateRecord() {}, unclaim() {}, acquireLane: () => ({ lanePath: '/nonexistent/soak-lane' }),
        releaseLane() {}, prepareLane: () => ({ head }), report() {}, log() {},
        runLoop: () => ({ status: 0, stdout: JSON.stringify(loopPayload), stderr: '' }),
        readRedTeamOnlyPayload: () => ({ head, loopPayload }), fetchRedTeamHead: () => ({ head }),
        runExtraSeats() {}, speculativeRedTeamSetting: () => ({ enabled: false }),
        runRedTeam: () => ({ status: 'ran', comment }),
        settleRedTeamSkip: (input) => { seen = input.redTeam.reason; return { outcome: 'non-policy' }; },
        runRedTeamGate: () => ({ status: 'ok', outcome: 'advisory' }), redTeamStatus() {}, clearRedTeamQueued() {},
      };
      runReviewJob({ repo: CONSTELLATION_REPOS.we.slug, pr: 1 }, io);
      return seen;
    };
    const violations = [];
    if (reasonFor({ status: 'error', reason: 'gh: HTTP 502' }) !== 'red team ran but its result comment is error (gh: HTTP 502)') violations.push('skip reason omits redTeam.comment.reason');
    if (reasonFor({ status: 'error' }) !== 'red team ran but its result comment is error') violations.push('missing reason must leave the text unchanged');
    return { violations };
  },
  judge(report) { return report.violations; },
};
