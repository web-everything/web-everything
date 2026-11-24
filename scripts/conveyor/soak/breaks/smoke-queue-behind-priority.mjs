/** A daemon five commits behind main exhausted its queue wait behind routine smokes. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export default {
  id: 'smoke-queue-behind-priority',
  title: 'behind daemons overtake routine smoke waiters without preempting holders or starving aged waiters',
  card: 'lane/smoke-queue-behind-priority',
  fixedBy: {
    sha: 'smoke-queue-behind-priority',
    where: 'lane/smoke-queue-behind-priority',
    paths: ['scripts/lib/daemon-smoke-slots.mjs', 'scripts/lib/daemon-rebuild/rebuild.mjs'],
  },
  fixPresent(root) {
    // Replay this harness against the requested tree, including rebuild's actual wiring.
    const probe = `
      const { scenario } = await import(process.argv[1]);
      const reports = await Promise.all([{}, {ageMs: 600001}, {behind: 4}].map(opts => scenario({ sourceRoot: process.argv[2], ...opts })));
      process.exit(reports.every(r => r.violations.length === 0) ? 0 : 1);`;
    try {
      return spawnSync(process.execPath, ['--input-type=module', '-e', probe,
        import.meta.url, root],
      { timeout: 5000, maxBuffer: 4096, encoding: 'utf8' }).status === 0;
    } catch { return false; }
  },
  async run({ sourceRoot } = {}) {
    const fresh = await scenario({ sourceRoot });
    const aged = await scenario({ sourceRoot, ageMs: 10 * 60_000 + 1 });
    const routine = await scenario({ sourceRoot, behind: 4 });
    return { violations: [...fresh.violations, ...aged.violations, ...routine.violations] };
  },
  judge(report) { return report.violations; },
};

export async function scenario({ sourceRoot, ageMs = 0, behind = 5, forceRequest = null } = {}) {
  const root = sourceRoot ?? resolve(fileURLToPath(import.meta.url), '../../../../..');
  const { acquireSmokeSlot, behindMainPriority } = await import(pathToFileURL(join(root, 'scripts/lib/daemon-smoke-slots.mjs')).href);
  const source = readFileSync(join(root, 'scripts/lib/daemon-rebuild/rebuild.mjs'), 'utf8');
  const start = source.indexOf('const forced = readForceAdopt(root, stEnv, now);');
  const end = source.indexOf('const waitSmokeSlotMs =', start);
  if (start < 0 || end < 0) throw new Error('missing rebuild queue wiring');
  // Execute the production probe through its real acquisition call; only surrounding IO is stubbed.
  const rebuildQueue = new Function('io', `return (async () => {
    const {root, stEnv, now, sleep, log, run, acquireSmokeSlot, behindMainPriority, forceRequest} = io;
    const prevHead = 'a'.repeat(40), plan = {mainSha: 'b'.repeat(40)};
    const readForceAdopt = () => forceRequest, lease = {token: 'test'}, finalLockOpts = {};
    const readRebuildState = () => ({}), writeRebuildState = () => {};
    const withWriteLock = async (_root, action) => ({ok: true, value: await action()});
    ${source.slice(start, end)}
    return {...slot, forcedValid};
  })()`);
  const stateDir = mkdtempSync(join(tmpdir(), 'soak-smoke-queue-behind-priority-'));
  let time = 1_000;
  const common = {
    stateDir, log: {}, now: () => time, isAlive: () => true,
    env: { WE_DAEMON_SMOKE_BEHIND_PRIORITY_THRESHOLD: '5', WE_DAEMON_SMOKE_MAX_CONCURRENT: '1', WE_DAEMON_SMOKE_QUEUE_MAX_WAIT_MS: '900000' },
  };
  const stopped = new Error('end isolated queue observation');
  const waiters = [];
  let holder;
  // Pause at the first occupied poll, after persistence. No timers or daemons.
  async function enqueue(pid, rebuild = false) {
    let reached, stop, resume;
    const waiting = new Promise(resolve => { reached = resolve; });
    let pause;
    const options = { ...common, pid, sleep: () => {
      pause = new Promise((resolve, reject) => { resume = resolve; stop = () => reject(stopped); });
      reached();
      return pause;
    } };
    const result = (rebuild ? rebuildQueue({ ...options, root, stEnv: common.env, behindMainPriority, forceRequest,
      run: args => ({ status: 0, stdout: args.join(' ') === `rev-list --count ${'a'.repeat(40)}..${'b'.repeat(40)}` ? String(behind) : '' }),
      acquireSmokeSlot: opts => acquireSmokeSlot({ ...options, ...opts }),
    }) : acquireSmokeSlot(options)).then(slot => ({ slot }), error => ({ error }));
    waiters.push({ pid, result, resume: () => resume?.(), stop: () => stop?.() });
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
    const expected = behind < 5 || ageMs > 10 * 60_000 ? [12, 13] : [13, 12];
    if (JSON.stringify(state.waiters.map(e => e.pid)) !== JSON.stringify(expected)) {
      violations.push(`${ageMs ? 'aged' : 'fresh'} routine: persisted queue must be ${expected.join(',')}`);
    }
    if (state.holders.length !== 1 || state.holders[0].pid !== 11) {
      violations.push('priority waiter preempted the holder or exceeded cap 1');
    }
    await holder.release();
    // Poll in reverse expected order first: a waiter must not bypass the actual queue head.
    for (const pid of [...expected].reverse()) {
      waiters.find(w => w.pid === pid).resume();
      await new Promise(resolve => setImmediate(resolve));
    }
    const admitted = JSON.parse(readFileSync(join(stateDir, 'smoke-slots.json'), 'utf8')).holders;
    if (admitted.length !== 1 || admitted[0].pid !== expected[0]) return { violations: [...violations, 'incorrect first admission'] };
    for (const pid of expected) {
      const waiter = waiters.find(w => w.pid === pid);
      waiter.resume();
      const outcome = await waiter.result;
      const holders = JSON.parse(readFileSync(join(stateDir, 'smoke-slots.json'), 'utf8')).holders;
      if (holders.length !== 1 || holders[0].pid !== pid) violations.push('incorrect admission order');
      if (!outcome.slot?.acquired) throw outcome.error ?? new Error('waiter was not admitted');
      if (pid === 13 && outcome.slot.forcedValid !== false) violations.push('invalid force request authorized');
      await outcome.slot.release();
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
