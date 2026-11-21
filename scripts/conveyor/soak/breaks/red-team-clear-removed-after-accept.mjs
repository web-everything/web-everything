/** #7289: numbering moved the accepted head, clearance was removed, and a refused carry posted no proof. */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const SAFETY = 'scripts/lib/drain-queue-safety.mjs';
const STRATEGY = 'scripts/lib/drain-merge-strategy.mjs';

export default {
  id: 'red-team-clear-removed-after-accept',
  title: 'removed red-team clearance and a refused carry hold admission and dequeue the unproved live head',
  card: 'A0 / PR #7289 exact-head red-team proof',
  fixedBy: { sha: 'working-tree', where: 'current tree', paths: [SAFETY, STRATEGY] },
  fixPresent(root) {
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import b from ${JSON.stringify(import.meta.url)}; const r = await b.run({ sourceRoot: ${JSON.stringify(root)} }); process.exit(b.judge(r).length ? 1 : 0);`],
    { encoding: 'utf8', timeout: 30_000, maxBuffer: 65536, env: { ...process.env, WE_UNDER_TEST: '1' } });
    return !probe.error && probe.status === 0;
  },
  async run({ sourceRoot = ROOT } = {}) {
    const { redTeamEnqueueHold } = await import(pathToFileURL(join(sourceRoot, SAFETY)).href);
    const { createDrainMergeStrategy } = await import(pathToFileURL(join(sourceRoot, STRATEGY)).href);
    const fixture = JSON.parse(readFileSync(new URL('../../../lib/__tests__/fixtures/pr7289-red-team.json', import.meta.url), 'utf8'));
    const repo = 'example/project', violations = [];
    let queued = true, enqueued = false;
    const exec = (_command, args) => {
      if (args.includes('--slurp')) return JSON.stringify([fixture.comments]);
      if (args.some(a => a.includes('mergeQueue(branch:'))) return JSON.stringify({ data: { repository: { mergeQueue: { entries: {
        nodes: queued ? [{ pullRequest: { id: 'PR7289', number: 7289 } }] : [], pageInfo: { hasNextPage: false },
      } } } } });
      if (args.some(a => a.includes('isInMergeQueue'))) return JSON.stringify({ data: { repository: { pullRequest: { isInMergeQueue: queued, headRefOid: fixture.head } } } });
      if (args.some(a => a.includes('dequeuePullRequest'))) { queued = false; return JSON.stringify({ data: { dequeuePullRequest: { clientMutationId: null } } }); }
      if (args.some(a => a.includes('enqueuePullRequest'))) { enqueued = true; throw Error('unproved PR reached enqueue mutation'); }
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ id: 'PR7289', number: 7289, state: 'OPEN', headRefOid: fixture.head, labels: fixture.labels });
      if (args[0] === 'pr' && ['comment', 'edit'].includes(args[1])) return '';
      if (args[0] === 'label') return '';
      throw Error(`unexpected fixture IO: ${args.join(' ')}`);
    };
    const strategy = () => createDrainMergeStrategy({ exec, localSlug: repo, env: { WE_UNDER_TEST: '1' },
      resolved: { policy: { strategy: 'github-merge-queue' }, note: null },
      queueSafety: { value: { waitForRedTeamBeforeEnqueue: true, dequeueOnSendBack: true, queueRebuildMax: 3 } },
      statePath: join(tmpdir(), 'a0-soak-hermetic-state.json'),
      readFile: () => JSON.stringify({ pending: [{ repo, num: 7289, headSha: fixture.earlierHead }], followedUp: [] }),
      writeState() {}, writeFile() {}, readRedTeamEvidence: () => ({ loopPayload: fixture.loopPayload, scheduled: false }),
      cancelObsoleteRuns() {}, batching: { observe() {} }, log: { write() {} },
    });
    const hold = redTeamEnqueueHold({ ...fixture, scheduled: false, env: {} });
    if (!hold?.includes('unknown(missing)')) violations.push('refused carry did not hold the live head as unknown(missing)');
    try {
      const result = strategy().enqueue({ repo, num: 7289 }, fixture.head);
      if (result.enqueued || !result.reason?.includes('unknown(missing)')) violations.push('admission did not defer the unproved head');
    } catch (error) { violations.push(`admission probe failed: ${error.message}`); }
    if (enqueued) violations.push('unproved head reached enqueue mutation');
    for (const path of ['sweep', 'follow-up']) {
      queued = true;
      const s = strategy();
      if (path === 'sweep') s.dequeueSendBacks([{ number: 7289, labels: fixture.labels }]);
      else s.collectQueueMerged({ merged: [], landedThisPass: new Set() });
      if (queued) violations.push(`${path} left the unproved head queued`);
    }
    return { violations };
  },
  judge: report => report.violations,
};
