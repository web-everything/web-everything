/** PR #5973: snapshot deletion must not consume the tick watchdog before a job has a child. */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJobStore, enqueueJob, launchJob, reattachTick } from '../../../lib/daemon-jobs-runtime.mjs';
import { defineJobKind, kindRegistry, markClaimed, markLaunching } from '../../../lib/daemon-jobs.mjs';
import { ensureCodeSnapshot, evictSnapshots, snapshotsRoot } from '../../../lib/daemon-job-snapshots.mjs';
import { formatJobHandle } from '../../../operations/job-record.mjs';
import { runPath } from '../../../operations/run-store.mjs';

const SOURCE = 'scripts/lib/daemon-jobs-runtime.mjs';

async function corruptRecordCase(dir, kindDef) {
  const store = createJobStore(dir);
  for (const type of ['code', 'node-modules']) {
    for (const [i, key] of ['running', 'old', 'recent', 'newest'].entries()) {
      const path = join(snapshotsRoot(dir), type, key);
      if (type === 'code') ensureCodeSnapshot({ jobsDir: dir, codeSha: key, materialize: () => {} });
      else mkdirSync(path, { recursive: true });
      utimesSync(path, 1000 + i, 1000 + i);
    }
  }
  enqueueJob({ store, kindDef, id: 'running', codeSha: 'running' });
  const at = new Date().toISOString();
  store.update('running', (r) => markClaimed(markLaunching(r, {
    at, snapshotKeys: ['code:running', 'node-modules:running'],
  }), { at, handle: formatJobHandle({ host: 'h', pid: 99, procStart: 'x' }), host: 'h', pid: 99, procStart: 'x' }));
  writeFileSync(runPath('running', dir), '{"job":');
  enqueueJob({ store, kindDef, id: 'next', codeSha: 'current' });
  let spawns = 0;
  const tick = await reattachTick({
    store, kinds: kindRegistry([kindDef]), maxConcurrent: 1,
    observation: { now: Date.now(), slept: false, gapMs: 0 }, log: () => {},
    launch: (options) => launchJob({
      ...options, snapshot: { materialize: () => {} }, spawnFn: () => { spawns++; return 4242; },
    }),
  });
  const violations = [];
  if (tick.corrupt.length !== 1 || tick.corrupt[0] !== 'running') violations.push('torn running record was not reported');
  if (spawns !== 1 || store.read('next').job.timeline.at(-1)?.pid !== 4242) violations.push('corrupt record blocked durable spawn');
  for (const type of ['code', 'node-modules']) {
    const expected = type === 'code' ? ['current', 'newest', 'old', 'recent', 'running'] : ['newest', 'old', 'recent', 'running'];
    if (JSON.stringify(readdirSync(join(snapshotsRoot(dir), type)).sort()) !== JSON.stringify(expected)) {
      violations.push(`${type} snapshots deleted despite a corrupt running record`);
    }
  }
  return violations;
}

export default {
  id: 'snapshot-eviction-blocks-job-spawn',
  title: 'launch-time cleanup preserves durable spawn and skips deletion with corrupt job records',
  card: 'PR #5973',
  fixedBy: { sha: 'HEAD', where: 'lane/jobs-snapshot-evict', paths: [SOURCE] },
  fixPresent(root) {
    const source = readFileSync(join(root, SOURCE), 'utf8');
    return source.includes('const spawned = store.update(id, (r) => markSpawned')
      && source.includes('if (corrupt.length > 0) return spawned;');
  },
  async run({ log } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'soak-launch-eviction-'));
    try {
      const store = createJobStore(dir);
      const kindDef = defineJobKind({ kind: 'noop', entry: 'job.mjs' });
      for (const type of ['code', 'node-modules']) {
        for (const [i, key] of ['old', 'recent', 'newest'].entries()) {
          const path = join(snapshotsRoot(dir), type, key);
          if (type === 'code') ensureCodeSnapshot({ jobsDir: dir, codeSha: key, materialize: () => {} });
          else mkdirSync(path, { recursive: true });
          utimesSync(path, 1000 + i, 1000 + i);
        }
      }
      enqueueJob({ store, kindDef, id: 'watchdog-launch', codeSha: 'current' });
      const violations = [];
      const events = [];
      let clock = Date.now();
      const tick = await reattachTick({
        store, kinds: kindRegistry([kindDef]), maxConcurrent: 1,
        observation: { now: clock, slept: false, gapMs: 0 },
        launch: (options) => launchJob({
          ...options, now: () => clock, snapshot: { materialize: () => {} },
          spawnFn: () => { events.push('spawn'); return 4242; },
          evict: (options) => {
            const { evicted } = evictSnapshots({ ...options, dryRun: true });
            if (!evicted.some((ref) => ref.startsWith('code:')) || !evicted.some((ref) => ref.startsWith('node-modules:'))) {
              violations.push('fixture did not select victims of both snapshot types');
            }
            // A slow-delete stub: inspect the durable state at the watchdog boundary, then abort cleanup.
            // No real sleep: the old path already strands the job at the FIRST delete, before any spawn.
            events.push('delete');
            clock += 180_001;
            const record = store.read('watchdog-launch');
            if (events[0] !== 'spawn') violations.push('delete began before spawn');
            if (record.job.timeline.findLast((e) => e.event === 'spawned')?.pid !== 4242) {
              violations.push('watchdog reached a launching record without a persisted child');
            }
            throw new Error('slow delete exceeded tick watchdog');
          },
        }),
      });
      if (tick.actions.filter((a) => a.action === 'launch').length !== 1) violations.push('tick did not launch exactly one job');
      if (events.filter((e) => e === 'spawn').length !== 1) violations.push('job did not spawn exactly once');
      if (events.filter((e) => e === 'delete').length !== 1) violations.push('cleanup did not reach the slow-delete stub');
      violations.push(...await corruptRecordCase(join(dir, 'corrupt-case'), kindDef));
      log?.(`launch/cleanup order: ${events.join(', ')}; ${violations.length} violations`);
      return { violations, events };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  judge(report) { return report.violations; },
};
