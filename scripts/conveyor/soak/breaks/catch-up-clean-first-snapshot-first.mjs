/** Replay 2026-11-19: blocked heads consumed the first slots and all children listed live. */
import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
export default {
  id: 'catch-up-clean-first-snapshot-first',
  title: 'catch-up gives clean heads the first slots and reuses the first listing snapshot',
  card: '2026-11-19 PRs #6945 #7107 #7117 ahead of #7127 #7148 #7159 #7175',
  fixedBy: { sha: 'HEAD', where: 'catch-up ordering and first-listing', paths: ['scripts/lib/enqueue-on-event.mjs'] },
  fixPresent(root) {
    try {
      const source = readFileSync(join(root, 'scripts/lib/enqueue-on-event.mjs'), 'utf8');
      return source.includes('cleanFirst: true') && source.includes('snapshotFirst: true');
    } catch { return false; }
  },
  async run({ sourceRoot = process.env.SOAK_TREE_ROOT || ROOT, log = () => {} } = {}) {
    const { createEnqueueOnEvent, resolveEnqueueOnEventSetting } = await import(pathToFileURL(join(sourceRoot, 'scripts/lib/enqueue-on-event.mjs')).href);
    const violations = [];
    const check = (ok, message) => { if (!ok) violations.push(message); };
    const labels = [{ name: 'ready-to-merge' }];
    const numbers = [6945, 7107, 7117, 7127, 7148, 7159, 7175];
    const clean = numbers.slice(3);
    const starts = [], children = [], snapshots = [], queued = new Set();
    let active = 0, peak = 0;
    const prs = numbers.map((num, i) => ({ num, readyAt: i, baseRefName: 'main', labels,
      mergeStateStatus: clean.includes(num) ? (num === 7148 ? 'HAS_HOOKS' : 'CLEAN') : 'BLOCKED' }));
    const setting = resolveEnqueueOnEventSetting({ env: {}, platform: {}, tool: {
      enabled: true, catchUp: { enabled: true, maxQueued: 7, concurrency: 3 },
    } });
    const handle = createEnqueueOnEvent({
      cwd: sourceRoot, localSlug: 'example-owner/example-repo', defaultBranch: 'main', env: {}, now: () => 1000,
      resolveSetting: () => setting, log,
      execFileSyncImpl: () => { throw Error('unexpected external IO'); },
      refreshPending: () => ({ pending: false }), readPendingChange: () => ({ ok: true, paths: [] }),
      readCodeVersion: () => 'a'.repeat(40),
      readCandidates: async () => ({ ok: true, prs, queued: 0 }),
      readCapacity: () => ({ capacity: 7, source: 'soak' }), readPriorities: () => ({}),
      readQueueDepth: async () => ({ ok: true, queued: queued.size, queuedNums: [...queued] }),
      readPr: async ({ num }) => ({ ...prs.find(p => p.num === num), state: 'OPEN', isDraft: false,
        statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }] }),
      readMembership: async ({ num }) => ({ ok: true, inQueue: queued.has(num) }),
      spawnImpl: (_command, args) => {
        const num = Number(args.find(a => a.startsWith('--only=')).slice(7));
        starts.push(num);
        snapshots.push(args.find(a => a.startsWith('--listing-snapshot='))?.slice(19));
        active++; peak = Math.max(peak, active);
        const child = new EventEmitter();
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        let done = false;
        child.finish = () => {
          if (done) return;
          done = true; active--; queued.add(num);
          child.stdout.emit('data', JSON.stringify({ toMerge: [{ num }] }));
          child.emit('close', 0);
        };
        child.kill = () => { child.finish(); return true; };
        children.push(child);
        return child;
      },
    });
    const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
    const round = handle.catchUp();
    try {
      await flush();
      check(starts.join(',') === '7127', 'only the highest-priority clean head should start before the snapshot');
      if (snapshots[0]) writeFileSync(snapshots[0], '{}');
      children[0]?.finish();
      await flush();
      check(starts.join(',') === '7127,7148,7159,7175', 'normal concurrency should fill with the remaining clean heads');
      check(active === 3, 'catchUp.concurrency=3 should be honoured after snapshot publication');
      for (let i = 1; i < numbers.length; i++) { children[i]?.finish(); await flush(); }
      await round;
      check(starts.join(',') === [...clean, ...numbers.slice(0, 3)].join(','), 'blocked heads must still run after all clean heads');
      check(queued.size === 7, 'every candidate should reach the injected queue');
      check(peak === 3, 'active drains exceeded or failed to reach the configured concurrency');
      check(snapshots.length === 7 && snapshots.every(p => p && p === snapshots[0]), 'all children must reuse the round snapshot');
    } finally { handle.kill(); }
    return { violations };
  },
  judge(report) { return report.violations; },
};
