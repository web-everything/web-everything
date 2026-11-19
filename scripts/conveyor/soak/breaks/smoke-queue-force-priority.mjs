/** A forced rebuild exhausted its 900s queue wait behind routine smokes. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export default {
  id: 'smoke-queue-force-priority',
  title: 'forced rebuilds overtake routine smoke waiters without preempting holders or starving aged waiters',
  card: 'lane/smoke-queue-force-priority',
  fixedBy: {
    sha: 'smoke-queue-force-priority',
    where: 'lane/smoke-queue-force-priority',
    paths: ['scripts/lib/daemon-smoke-slots.mjs', 'scripts/lib/daemon-rebuild/rebuild.mjs'],
  },
  fixPresent(root) {
    try {
      const source = readFileSync(join(root, 'scripts/lib/daemon-smoke-slots.mjs'), 'utf8');
      return /priority\s*=\s*false/.test(source)
        && /waiterOrder/.test(source) && /PRIORITY_OVERTAKE_AGE_MS/.test(source);
    } catch { return false; }
  },
  async run({ sourceRoot } = {}) {
    const fresh = await scenario({ sourceRoot });
    const aged = await scenario({ sourceRoot, ageMs: 10 * 60_000 + 1 });
    return { violations: [...fresh.violations, ...aged.violations] };
  },
  judge(report) { return report.violations; },
};

export async function scenario({ sourceRoot, ageMs = 0 } = {}) {
  const root = sourceRoot ?? resolve(fileURLToPath(import.meta.url), '../../../../..');
  const { acquireSmokeSlot } = await import(pathToFileURL(join(root, 'scripts/lib/daemon-smoke-slots.mjs')).href);
  const stateDir = mkdtempSync(join(tmpdir(), 'soak-smoke-queue-force-priority-'));
  let time = 1_000;
  const common = {
    stateDir, log: {}, now: () => time, isAlive: () => true,
    env: { WE_DAEMON_SMOKE_MAX_CONCURRENT: '1', WE_DAEMON_SMOKE_QUEUE_MAX_WAIT_MS: '900000' },
  };
  const stopped = new Error('end isolated queue observation');
  const waiters = [];
  let holder;
  // Pause at the first occupied poll, after persistence. No timers or daemons.
  async function enqueue(pid, priority = false) {
    let reached, stop;
    const waiting = new Promise(resolve => { reached = resolve; });
    let pause;
    const result = acquireSmokeSlot({ ...common, pid, priority, sleep: () => {
      pause = new Promise((resolve, reject) => { stop = () => reject(stopped); });
      reached();
      return pause;
    } }).then(slot => ({ slot }), error => ({ error }));
    waiters.push({ result, stop: () => stop?.() });
    // An incorrect immediate grant/error also terminates observation, never hangs it.
    await Promise.race([waiting, result]);
  }
  try {
    holder = await acquireSmokeSlot({ ...common, pid: 11 });
    if (!holder.acquired) throw new Error('isolated holder could not acquire capacity');
    await enqueue(12);
    time += ageMs;
    await enqueue(13, true);
    const state = JSON.parse(readFileSync(join(stateDir, 'smoke-slots.json'), 'utf8'));
    const violations = [];
    const expected = ageMs > 10 * 60_000 ? [12, 13] : [13, 12];
    if (JSON.stringify(state.waiters.map(e => e.pid)) !== JSON.stringify(expected)) {
      violations.push(`${ageMs ? 'aged' : 'fresh'} routine: persisted queue must be ${expected.join(',')}`);
    }
    if (state.holders.length !== 1 || state.holders[0].pid !== 11) {
      violations.push('priority waiter preempted the holder or exceeded cap 1');
    }
    return { violations };
  } finally {
    try {
      // Unwind sequentially so cleanup never contends for the state lock.
      for (const waiter of waiters.reverse()) {
        waiter.stop();
        const outcome = await waiter.result;
        if (outcome.slot) await outcome.slot.release();
        else if (outcome.error !== stopped) throw outcome.error;
      }
    } finally {
      await holder?.release();
      rmSync(stateDir, { recursive: true, force: true });
    }
  }
}
