/** Replay 2026-11-19: blocked heads consumed the first slots and all children listed live. */
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
export default {
  id: 'catch-up-clean-first-snapshot-first',
  title: 'catch-up gives clean heads the first slots and reuses the first listing snapshot',
  card: '2026-11-19 PRs #6945 #7107 #7117 ahead of #7127 #7148 #7159 #7175',
  fixedBy: { sha: 'HEAD', where: 'catch-up ordering and first-listing', paths: ['scripts/lib/enqueue-on-event.mjs'] },
  fixPresent(root) {
    // Exercise this replay against the requested tree, including its real defaults.
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e',
      `const { default: b } = await import(process.argv[1]);
       const report = await b.run({ sourceRoot: process.argv[2] });
       process.exit(b.judge(report).length === 0 ? 0 : 1);`, import.meta.url, root],
    { timeout: 15000, maxBuffer: 65536, encoding: 'utf8' });
    return !probe.error && probe.status === 0;
  },
  async run({ sourceRoot = process.env.SOAK_TREE_ROOT || ROOT, log = () => {} } = {}) {
    const { createEnqueueOnEvent, resolveEnqueueOnEventSetting, planCatchUp } = await import(pathToFileURL(join(sourceRoot, 'scripts/lib/enqueue-on-event.mjs')).href);
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
    const plan = planCatchUp({ prs, queued: 0, capacity: 7 });
    check([...plan.run.map(p => p.num), ...plan.later].join(',') === [...clean, ...numbers.slice(0, 3)].join(','),
      'planCatchUp defaults must put clean heads first');
    const incidentPrs = [{ ...prs[0], num: 99 }, { ...prs[3], num: 7 }];
    const incident = planCatchUp({ prs: incidentPrs, queued: 0, capacity: 1,
      repo: 'web-everything/web-everything', priority: { mode: 'enforce' }, mainFix: { repo: 'we', pr: 99 } });
    check(incident.run[0]?.num === 99, 'BLOCKED P0 incident fix must beat ordinary CLEAN at capacity one');
    const cleanIncidentPrs = [{ ...incidentPrs[0], mergeStateStatus: 'CLEAN', readyAt: 900 },
      { ...incidentPrs[1], readyAt: 0 }];
    const priorityInput = { prs: cleanIncidentPrs, queued: 0, capacity: 1,
      repo: 'web-everything/web-everything', priority: { mode: 'enforce' }, mainFix: { repo: 'we', pr: 99 } };
    check(planCatchUp({ ...priorityInput, deprioritize: [99] }).run[0]?.num === 7,
      'recently missed CLEAN P0 must stay behind unmissed CLEAN P3');
    check(planCatchUp({ ...priorityInput, order: 'oldest-ready' }).run[0]?.num === 7,
      'oldest-ready must select older CLEAN P3 before newer CLEAN P0');
    const missed = planCatchUp({ prs: incidentPrs, queued: 0, capacity: 1, deprioritize: [7] });
    check(missed.run[0]?.num === 99, 'recently missed CLEAN must stay behind non-missed BLOCKED');
    const held = planCatchUp({ prs: incidentPrs, queued: 0, capacity: 1, now: 1000,
      declines: new Map([[7, { reason: 'held', at: 1000 }]]) });
    check(held.run[0]?.num === 99, 'known-held CLEAN must stay behind non-held BLOCKED');
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
      if (snapshots[0]) writeFileSync(snapshots[0], JSON.stringify({ repo: 'example-owner/example-repo', writtenAt: 1000, rows: [], defaultBranch: 'main' }));
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
