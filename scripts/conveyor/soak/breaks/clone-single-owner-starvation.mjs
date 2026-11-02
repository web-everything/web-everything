/**
 * @file breaks/clone-single-owner-starvation.mjs — continuous sibling ticks used the skip cap and
 * older-reader priority to make rebuild writers back off indefinitely. A bounded hard claim must
 * drain existing readers, win within five seconds, and never move with a live read slot.
 * Registered automatically by breaks/index.mjs; the scenario imports the lock from the tree under test.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { runSoak } from '../soak.mjs';

export async function runReaderPressure(lock, root, lockRoot) {
  const opts = { lockRoot, readerPriorityAfter: 3, writerPriorityAfter: 1, writerPriorityMaxSkips: 2 };
  let running = true;
  const held = new Set();
  const starts = Array.from({ length: 10 }, () => Promise.withResolvers());
  const workers = starts.map(async (start, i) => {
    const owner = `soak-reader-${i}`;
    let first = true;
    try {
      while (running) {
        const r = lock.acquireRead(root, { ...opts, owner, readerKey: owner });
        if (!r.ok) { await delay(1); continue; }
        held.add(owner);
        const holdMs = first ? 20 + i * 2 : 20;
        if (first) { first = false; start.resolve(); }
        try { await delay(holdMs); }
        finally { lock.releaseRead(root, { lockRoot, owner }); held.delete(owner); }
      }
    } catch (error) { start.reject(error); throw error; }
    finally { lock.releaseRead(root, { lockRoot, owner }); held.delete(owner); }
  });
  try {
    await Promise.all(starts.map((s) => s.promise));
    const began = performance.now();
    const result = await lock.acquireWrite(root, { ...opts, owner: 'soak-rebuild-job', hardClaim: true, waitMs: 4900, pollMs: 10 });
    const elapsed = performance.now() - began;
    if (!result.ok || elapsed >= 5000) return { ok: false, reason: `writer-starved:${result.reason ?? 'deadline'}`, elapsed };
    const snap = lock.inspectCloneLock(root, opts);
    if (!snap.writerLive || held.size || snap.readers.some((r) => r.live)) return { ok: false, reason: 'reader-during-move', elapsed };
    await delay(30); // Readers keep retrying while the writer owns the tree.
    const overlap = held.size || lock.inspectCloneLock(root, opts).readers.some((r) => r.live);
    return { ok: !overlap, reason: overlap ? 'reader-during-move' : 'writer-won', elapsed };
  } finally {
    running = false;
    lock.releaseWrite(root, { lockRoot, owner: 'soak-rebuild-job' });
    await Promise.all(workers);
  }
}
export default {
  id: 'clone-single-owner-starvation',
  title: 'continuous sibling readers must drain for a hard rebuild writer within five seconds',
  card: 'clone-single-owner-starvation',
  fixedBy: { sha: 'clone-single-owner-starvation', where: 'lane/clone-single-owner-starvation', paths: ['scripts/lib/daemon-clone-lock.mjs'] },
  fixPresent(root) {
    try { return /function claimIsHard/.test(readFileSync(join(root, 'scripts/lib/daemon-clone-lock.mjs'), 'utf8')); }
    catch { return false; }
  },
  async run({ log } = {}) {
    return runSoak({ name: 'break:clone-single-owner-starvation', rounds: 1, daemons: [], mainEvery: 0, fleet: false, log,
      async perRound(w, _round, _ctx, api) {
        const lock = await import(pathToFileURL(join(w.simCloneRoot, 'scripts/lib/daemon-clone-lock.mjs')).href);
        const result = await runReaderPressure(lock, w.simCloneRoot, join(w.root, 'clone-lock'));
        api.say(`hard writer: ${result.reason}, ${Math.round(result.elapsed)}ms`);
        if (!result.ok) api.violation('clone-writer-starved', result.reason);
      },
    });
  },
  judge(report) {
    return [...(report.fatal ? [report.fatal] : []), ...report.violations
      .filter((v) => ['clone-writer-starved', 'crash'].includes(v.invariant)).map((v) => `${v.invariant}: ${v.detail}`)];
  },
};
