/** Exercise the CLI's actual effects wiring in a subprocess that exits like main(). */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, dir, mode] = process.argv.slice(2);
const runner = await import(pathToFileURL(join(root, 'skills-src/conveyor/runner.mjs')));
const { runPassAsTimedJob, runPassDaemonLoop } = await import(pathToFileURL(join(root, 'skills-src/conveyor/pass-daemon.mjs')));
const { createJobStore } = await import(pathToFileURL(join(root, 'scripts/lib/daemon-jobs-runtime.mjs')));
const { CONSTELLATION_REPOS } = await import(pathToFileURL(join(root, 'scripts/lib/constellation-repos.mjs')));
const store = createJobStore(join(dir, 'jobs'));
const children = new Map();
const launched = [];
const results = [];
const snapshotDirs = [];
let ticks = 0;
let released = false;
let overlapped = false;
let signalSent = false;
let ticksAtSignal;
const ports = {
  root: dir, store, codeSha: 'fixture', snapshot: { materialize() {} },
  host: 'fixture-host', readStart: () => 'fixture-start',
  spawnFn: (...args) => {
    const child = spawn(...args);
    children.set(child.pid, child);
    writeFileSync(join(dir, 'pids.json'), JSON.stringify([...children.keys()]));
    return child;
  },
  probe: handle => {
    const child = children.get(Number(handle.split(':')[1]));
    return child && child.exitCode === null && child.signalCode === null ? 'alive' : 'dead';
  },
  // Fixture-owned children: stop() SIGKILLs the whole group and awaits close, so a dead owner here means the group is gone.
  reapGroup: handle => {
    const child = children.get(Number(handle.split(':')[1]));
    return !child || (child.exitCode !== null || child.signalCode !== null);
  },
  stop: async handle => {
    const child = children.get(Number(handle.split(':')[1]));
    await new Promise(resolve => {
      child.once('close', resolve);
      process.kill(-child.pid, 'SIGKILL');
    });
    return { gone: true, signal: 'SIGKILL' };
  },
  policyOptions: { platform: null, tool: { timeoutMs: 150 }, env: {}, log() {} },
  log() {}, alert() {},
};
const tickOnce = () => {
  ticks++;
  if (ticks === 2) overlapped = store.list().records.some(r => r.job.status === 'running');
  if (mode === 'error' && ticks === 2) throw new Error('fixture tick failure');
  return { decisions: { idleStop: mode === 'idle-stop' }, nextState: {} };
};
// Extract just the CLI factory so the probe cannot accidentally test a safer,
// hand-copied wrapper. External IO is injected; loop, passes and timed jobs are real.
const source = readFileSync(join(root, 'skills-src/conveyor/runner.mjs'), 'utf8');
const factory = source.slice(source.indexOf('const buildEffects = (owner) => {'),
  source.indexOf('// #2702 SINGLETON LOCK'));
const bindings = {
  ...runner,
  makeCliMechanicalPasses: options => runner.makeCliMechanicalPasses({ ...options,
    runPass: pass => {
      launched.push(pass.passName);
      const snapshot = pass.passName === 'open-pr-snapshot';
      if (snapshot) snapshotDirs.push(pass.entry.args.find(arg => arg.startsWith('--output=')).slice(9));
      const pending = runPassAsTimedJob({ ...pass, entry: {
        script: snapshot ? 'snapshot.mjs' : 'hung.mjs', args: pass.entry.args, quiet: true,
      } }, { ...ports, ...(snapshot ? {
        policyOptions: { ...ports.policyOptions, tool: { timeoutMs: 1000 } },
      } : {}) }).then(result => { results.push({ passName: pass.passName, result }); return result; });
      if (pass.passName === 'infra-blocked' && mode.startsWith('SIG') && !signalSent) {
        signalSent = true;
        setImmediate(() => {
          const signal = mode.split('-')[0];
          process.kill(process.pid, signal);
          if (mode.endsWith('-twice')) setTimeout(() => process.kill(process.pid, signal), 25);
        });
      }
      return pending;
    },
  }),
  makeCliTickOnce: () => tickOnce,
  makeCliEmit: () => () => {
    if (mode === 'emit-error' && ticks === 2) throw new Error('fixture emit failure');
  },
  wireSelfSyncAndAppAuth: ({ tickOnce: tick, onRestart }) => async () => {
    if (mode === 'restart' && ticks === 1) {
      overlapped = store.list().records.some(r => r.job.status === 'running');
      return onRestart();
    }
    return tick();
  },
  releaseRunnerLeaseIfOwned: () => { released = true; },
  RUNNER_LOCK_ROOT: dir, REPO_ROOT: dir, SCRIPTS_DIR: join(dir, 'scripts'), TICK_CORE: '',
  STATUS_PATH: null, TRACE_DIR: null, repo: CONSTELLATION_REPOS.we.slug,
  hiccupSession: undefined, json: false, selfSync: mode === 'restart', intervalMs: 1,
  maxTicks: mode.includes('SIG') ? Infinity : mode === 'once' ? 1 : 2,
  skipPasses: new Set(runner.MECHANICAL_PASS_NAMES.filter(name =>
    !['infra-blocked', 'parked-pr-progress-watch'].includes(name))),
};
const buildEffects = new Function(...Object.keys(bindings), `${factory}\nreturn buildEffects;`)(...Object.values(bindings));
process.on('exit', () => writeFileSync(join(dir, 'report.json'), JSON.stringify({
  ticks, ticksAtSignal, released, overlapped, launched, results, snapshotDirs, pids: [...children.keys()],
  jobs: store.list().records.map(r => ({ status: r.job.status, result: r.job.passResult })),
})));
try {
  if (mode.startsWith('daemon-')) {
    let isAlive = () => true;
    await runPassDaemonLoop({
      runPass: () => {
        launched.push('infra-blocked');
        const activePass = runPassAsTimedJob({ passName: 'infra-blocked', repo: 'fixture/repo',
          entry: { script: 'hung.mjs', quiet: true } }, ports)
          .then(result => { results.push({ passName: 'infra-blocked', result }); return result; });
        if (mode.includes('SIG')) {
          const daemonSource = readFileSync(join(root, 'skills-src/conveyor/pass-daemon.mjs'), 'utf8');
          const handler = daemonSource.slice(daemonSource.indexOf('let stopping = false;'),
            daemonSource.indexOf('// xdpemd4 — self-sync this watcher'));
          isAlive = new Function('activePass', 'alive', 'heartbeatTimer', 'releaseRunnerLeaseIfOwned',
            'RUNNER_LOCK_ROOT', 'owner', 'key', 'passName', `${handler}\nreturn () => alive;`)(
            activePass, true, undefined, () => { released = true; }, dir, 'fixture', 'fixture', 'fixture');
          setImmediate(() => process.kill(process.pid, mode.slice(7)));
        }
        return activePass;
      },
      sleep: async () => {
        if (mode === 'daemon-sleep-error') throw new Error('fixture sleep failure');
        await new Promise(resolve => setTimeout(resolve, 1000));
      },
      isAlive: () => isAlive(), intervalMs: 1000, maxRuns: 2, tickWhileRunning: true,
    });
    process.exit(0);
  }
  await runner.driveConveyor({
    lockRoot: dir, owner: 'fixture', buildEffects: owner => {
      const effects = buildEffects(owner);
      if (mode.startsWith('SIG')) process.once(mode.split('-')[0], () => { ticksAtSignal = ticks; });
      if (mode === 'sleep-error') effects.sleep = () => { throw new Error('fixture sleep failure'); };
      return effects;
    },
    acquire: () => ({ ok: true }), heartbeat: () => {
      if (mode === 'heartbeat-error') throw new Error('fixture heartbeat failure');
      return mode !== 'lease-lost';
    },
    release: () => { released = true; },
  });
  process.exit(0);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
