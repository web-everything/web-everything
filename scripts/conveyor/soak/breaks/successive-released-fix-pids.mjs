/** PR #5968: a second release at an unchanged head must not revive the first fixer's lingering PID. */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const CORE = 'scripts/conveyor/reconcile-core.mjs';
const HEAD = 'aa11bb22cc33dd44ee55ff6677889900aabbccdd';
const AUTHOR = { login: 'web-everything' };

export default {
  id: 'successive-released-fix-pids',
  title: 'successive releases at one head keep every released fixer PID finished',
  card: 'PR #5968 / 5726 item 1',
  fixedBy: { sha: 'HEAD', where: 'lane/port-1023a-j', paths: [CORE] },
  fixPresent(root) {
    return readFileSync(join(root, CORE), 'utf8').includes('releasesBySession');
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const { planReconcile } = await import(pathToFileURL(join(sourceRoot, CORE)).href);
    const { buildFixBeginComment, buildFixEndComment } = await import(pathToFileURL(join(sourceRoot, 'scripts/conveyor/fix-procedure.mjs')).href);
    const violations = [];
    const comments = [{ body: '🔁 human review — changes requested\n\nRepair the release history.' }];
    const agents = [];
    const plan = () => planReconcile({
      prs: [{ number: 5968, state: 'OPEN', headRefName: 'lane/port-1023a-j', headRefOid: HEAD,
        labels: [{ name: 'review:changes' }], comments, mergeStateStatus: 'CLEAN',
        statusCheckRollup: [{ name: 'gate', status: 'completed', conclusion: 'success' }] }],
      agents, durableCounts: {}, requiredChecks: ['gate'], reviewTiming: { startAfter: 'ci-green' },
      now: Date.parse('2026-10-20T23:30:00Z'),
    });
    for (const [sessionId, pid, hour] of [['s-first', 101, 20], ['s-second', 102, 22]]) {
      comments.push(
        { author: AUTHOR, createdAt: `2026-10-20T${hour}:10:00Z`, body: buildFixBeginComment({ who: sessionId, headSha: HEAD, branch: 'lane/port-1023a-j' }) },
        { author: AUTHOR, createdAt: `2026-10-20T${hour + 1}:00:00Z`, body: buildFixEndComment({ who: sessionId, headSha: HEAD }) },
      );
      agents.push({ sessionId, pid, pidAlive: true, cwd: '/dispatch/released-fixer', laneHeadOid: HEAD,
        startedAt: Date.parse(`2026-10-20T${hour}:00:00Z`) });
      const result = plan();
      const live = result.refusals.find(r => r.kind === 'live-process');
      const dispatched = result.dispatch.some(d => d.kind === 'fix' && d.prNumber === 5968);
      const ignored = result.notes.filter(n => n.kind === 'released-claim-session-ignored').length;
      log?.(`${sessionId} released: live-process=${live?.pid ?? 'none'}, dispatched=${dispatched}, ignored=${ignored}\n`);
      if (live || !dispatched || ignored !== agents.length) violations.push(`${sessionId}: released PIDs block dispatch or lack decision evidence`);
    }
    // A newly acquired claim still blocks both lingering PIDs.
    comments.push({ author: AUTHOR, createdAt: '2026-10-20T23:10:00Z',
      body: buildFixBeginComment({ who: 's-third', headSha: HEAD, branch: 'lane/port-1023a-j' }) });
    if (!plan().refusals.some(r => r.kind === 'live-process')) violations.push('renewed claim failed to keep live workers busy');
    return { violations };
  },
  judge: report => report.violations,
};
