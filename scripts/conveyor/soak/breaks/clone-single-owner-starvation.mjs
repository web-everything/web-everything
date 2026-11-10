/**
 * @file breaks/clone-single-owner-starvation.mjs — sibling pass-daemons used to rebuild before every
 * reader tick. Only the owner may rebuild now; continuous pass ticks must yield for its ready adoption.
 * The scenario checks the real withSelfSync boundary and exclusive movement without special writer policy.
 */
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { runSoak } from '../soak.mjs';

export async function runOwnerPressure(lock, withSelfSync, root, lockRoot, { passDaemons = 10, boundMs = 5000 } = {}) {
  mkdirSync(root, { recursive: true });
  const env = { WE_DAEMON_CLONE_LOCK_ROOT: lockRoot, WE_DAEMON_CLONE_OWNER_ENTRY: 'review-daemon.mjs' };
  const opts = { lockRoot, readerPriorityAfter: 3, writerPriorityAfter: 1, writerPriorityMaxSkips: 2 };
  let running = true, moving = false, head = 'boot', overlap = false, workerError = null;
  let nonOwnerRebuilds = 0, nonOwnerWriterSlots = 0, passTicks = 0, ownerRebuilds = 0, moved = false;
  const held = new Set();
  const starts = Array.from({ length: passDaemons }, () => Promise.withResolvers());
  const ready = { prevHead: 'boot', adopt: { finalSha: 'next' }, passedAt: new Date().toISOString() };
  const config = (owner) => ({ root, env, entries: [owner === 'owner' ? 'review-daemon.mjs' : `${owner}.mjs`],
    readHead: () => head, readOriginRef: () => null, readState: () => ({}), readReady: () => ready,
    versions: null, background: null, rebuildAsJob: false, tickProgress: null, minRestartIntervalMs: 0,
    maxAdoptWaitTicks: 2, priorityWaitMs: 25, cloneIdentity: () => 'soak-clone',
    onRestart: () => 'restarted', log: { error() {} },
    diffFiles: () => ['shared.mjs'], importClosure: () => ({ complete: true, files: new Set(['shared.mjs']), jsonNames: new Set() }),
    acquireRead: (r, o) => lock.acquireRead(r, { ...o, ...opts, owner }),
    releaseRead: (r) => lock.releaseRead(r, { lockRoot, owner }),
  });
  // Establish a live owner before any sibling starts, so fallback ownership cannot hide a regression.
  lock.touchOwnerHeartbeat(root, { lockRoot });
  const workers = starts.map(async (start, i) => {
    const owner = `pass-${i}`;
    const daemon = withSelfSync({ tickOnce: async () => {
      held.add(owner); passTicks += 1; start.resolve();
      if (moving) overlap = true;
      try { await delay(20 + i); }
      finally { held.delete(owner); }
      return 'ticked';
    } }, { ...config(owner), rebuild: async () => {
      nonOwnerRebuilds += 1;
      const r = await lock.acquireWrite(root, { ...opts, owner, waitMs: 25, pollMs: 1 });
      if (r.ok) { nonOwnerWriterSlots += 1; lock.releaseWrite(root, { lockRoot, owner }); }
      return { moved: false, reason: 'up-to-date' };
    } });
    try {
      // Keep daemon ticks continuous on a fixed cadence, including when a read slot is refused.
      while (running) { await daemon.tickOnce(); await delay(10); }
    } catch (error) { workerError = error; }
    finally { start.resolve(); lock.releaseRead(root, { lockRoot, owner }); }
  });
  const owner = withSelfSync({ tickOnce: () => 'owner-tick' }, { ...config('owner'), rebuild: async () => {
    ownerRebuilds += 1;
    const r = await lock.acquireWrite(root, { ...opts, owner: 'owner', waitMs: 100, pollMs: 1 });
    if (!r.ok) return { moved: false, reason: r.reason };
    moving = true;
    try {
      const snap = lock.inspectCloneLock(root, opts);
      if (held.size || snap.readers.some((reader) => reader.live)) overlap = true;
      await delay(30); // Siblings continue attempting ticks throughout the move.
      if (held.size || lock.inspectCloneLock(root, opts).readers.some((reader) => reader.live)) overlap = true;
      head = 'next'; moved = true;
      return { moved: true, reason: 'adopted' };
    } finally { moving = false; lock.releaseWrite(root, { lockRoot, owner: 'owner' }); }
  } });
  const began = performance.now();
  let startTimer, elapsed;
  try {
    const started = await Promise.race([
      Promise.all(starts.map((s) => s.promise)).then(() => true),
      new Promise((resolve) => { startTimer = setTimeout(() => resolve(false), boundMs); }),
    ]);
    clearTimeout(startTimer);
    if (started && !nonOwnerRebuilds && !workerError) {
      while (!moved && performance.now() - began < boundMs) { await owner.tickOnce(); await delay(1); }
    }
    elapsed = performance.now() - began;
  } finally {
    clearTimeout(startTimer); running = false;
    await Promise.all(workers);
    lock.releaseWrite(root, { lockRoot, owner: 'owner' });
  }
  const reason = nonOwnerWriterSlots ? 'non-owner-writer'
    : nonOwnerRebuilds ? 'non-owner-rebuilt' : workerError ? `pass-crashed:${workerError.message}`
    : overlap ? 'reader-during-move' : !moved || elapsed >= boundMs ? 'owner-starved' : 'owner-moved';
  return { ok: reason === 'owner-moved', reason, elapsed, moved, passTicks, ownerRebuilds, nonOwnerRebuilds, nonOwnerWriterSlots };
}
export default {
  id: 'clone-single-owner-starvation',
  title: 'continuous non-owner ticks never rebuild or reserve writes while the owner adopts within five seconds',
  card: 'clone-single-owner-starvation',
  fixedBy: { sha: 'clone-single-owner-starvation', where: 'lane/clone-single-owner-starvation',
    paths: ['scripts/lib/daemon-clone-lock.mjs', 'scripts/lib/daemon-self-sync.mjs'] },
  fixPresent(root) {
    try {
      return /function resolveCloneOwnership/.test(readFileSync(join(root, 'scripts/lib/daemon-clone-lock.mjs'), 'utf8'))
        && /clone-non-owner/.test(readFileSync(join(root, 'scripts/lib/daemon-self-sync.mjs'), 'utf8'));
    } catch { return false; }
  },
  async run({ log } = {}) {
    return runSoak({ name: 'break:clone-single-owner-starvation', rounds: 1, daemons: [], mainEvery: 0, fleet: false, log,
      async perRound(w, _round, _ctx, api) {
        const lock = await import(pathToFileURL(join(w.simCloneRoot, 'scripts/lib/daemon-clone-lock.mjs')).href);
        const { withSelfSync } = await import(pathToFileURL(join(w.simCloneRoot, 'scripts/lib/daemon-self-sync.mjs')).href);
        const result = await runOwnerPressure(lock, withSelfSync, w.simCloneRoot, join(w.root, 'clone-lock'));
        api.say(`single owner: ${result.reason}, ${Math.round(result.elapsed)}ms; pass ticks=${result.passTicks}; non-owner writes=${result.nonOwnerWriterSlots}`);
        if (!result.ok) api.violation('clone-writer-starved', result.reason);
      },
    });
  },
  judge(report) {
    return [...(report.fatal ? [report.fatal] : []), ...report.violations
      .filter((v) => ['clone-writer-starved', 'crash'].includes(v.invariant)).map((v) => `${v.invariant}: ${v.detail}`)];
  },
};
