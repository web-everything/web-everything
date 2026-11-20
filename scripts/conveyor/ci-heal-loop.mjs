/** Inactive CI-healing child driver; callers own launching it. */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cascadePolicy } from '../lib/policy-cascade.mjs';
import { readSettings } from '../lib/settings-files.mjs';
import { ensureFreshGithubAppEnv, FLEET_APP_AUTH_OPTS, isGithubAppAuthGuardError } from '../lib/github-app-auth-env.mjs';
import { isPidAlive } from '../lib/dispatch-throttle.mjs';
import { acquireRead, releaseRead, defaultOwner, cloneLockDirs, HEARTBEAT_INTERVAL_MS } from '../lib/daemon-clone-lock.mjs';
import { planClaudeAuthDispatchGate } from './claude-auth-health.mjs';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { reserve, readLockEntry, releaseLockDirIf, heartbeat } from '../readiness/file-locks.mjs';

const DEFAULT_SECONDS = 300;
const validInterval = value => Number.isInteger(value) && value >= 60 && value <= 1800;
const boundedInterval = value => validInterval(value) ? value : DEFAULT_SECONDS;
const gitRev = (cwd, ref) => execFileSync('git', ['rev-parse', ref], {
  cwd, encoding: 'utf8', timeout: 5000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const cloneRoot = () => gitRev(dirname(fileURLToPath(import.meta.url)), '--show-toplevel');
const cloneHead = root => gitRev(root, 'HEAD');
let cycleBusy = false;
const cloneLocks = {
  acquireRead, releaseRead,
  heartbeatRead: (root, { owner }) => heartbeat(cloneLockDirs(root).readersRoot, owner, owner, new Date().toISOString(), process.pid),
};
function knownHead(readHead, root) {
  try {
    const head = readHead(root);
    return typeof head === 'string' && head.trim() ? head.trim() : null;
  } catch { return null; }
}

/** Invalid explicit overrides select the standard bound, never an arbitrary lower-layer value. */
export function resolveCiHealInterval({ env = process.env, settings = readSettings() } = {}) {
  const tool = settings?.ciHeal?.intervalSec;
  const rawEnv = env.WE_CI_HEAL_INTERVAL_SEC;
  const envValue = rawEnv === undefined ? undefined
    : boundedInterval(typeof rawEnv === 'string' && /^\d+$/.test(rawEnv) ? Number(rawEnv) : NaN);
  const resolved = cascadePolicy('ciHeal', tool === undefined ? undefined : { intervalSec: boundedInterval(tool) }, {
    standard: { intervalSec: DEFAULT_SECONDS }, envValues: { intervalSec: envValue }, valid: validInterval, env,
  });
  return { seconds: resolved.value.intervalSec, source: resolved.sources.intervalSec };
}

function cycleLock({ env = process.env, pid = process.pid, now = Date.now } = {}) {
  const root = join(resolveCoordinationRoot({ env }), 'ci-heal-cycle-lock');
  const resource = 'ci-heal-cycle', owner = `${hostname()}:${pid}`;
  return {
    reserve: () => {
      mkdirSync(root, { recursive: true });
      const nowMs = now();
      return reserve(root, resource, owner, nowMs, new Date(nowMs).toISOString(), pid,
        entry => Number.isInteger(entry?.pid) ? (isPidAlive(entry.pid) ? 'alive' : 'dead') : 'unknown', 20);
    },
    release: () => {
      const mine = readLockEntry(root, resource);
      if (mine?.owner === owner) releaseLockDirIf(root, resource, mine);
    },
    heartbeat: () => heartbeat(root, resource, owner, new Date(now()).toISOString(), pid),
  };
}

export async function runCiHealTick({ tickOnce, refresh, log, planAuth = planClaudeAuthDispatchGate, daemon } = {}) {
  // Injecting fixTick bypasses the daemon's production gate, so own that check here.
  const authGate = await planAuth();
  if (authGate.paused) return { skipped: 'auth-paused' };
  const { runTickAllRepos, defaultTagDispatchStatus, withFixDispatchClaimRefresh } = daemon
    ?? await import('../../skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs');
  const empty = async () => ({ dispatched: [], refusals: [], reconcileRefusalDetails: [], applied: [],
    dispatch: [], holds: [], rows: [], notes: [], comments: [], autoGrants: [], prsByNumber: new Map() });
  return withFixDispatchClaimRefresh({
    tickOnce: tickOnce ?? (() => runTickAllRepos({
      reuseReconcilePlan: true, tagDispatchStatus: defaultTagDispatchStatus, authGateOverride: () => authGate,
      fixTick: empty, hungCiTick: empty, mainRedRebaseTick: empty, missingRunTick: empty,
      promoteDraftTick: empty, rulingStandDownTick: empty, notesTick: empty, awaitVerifyTick: empty,
      stuckFixerTick: empty, supersedeTick: empty, orphanGuardTick: null,
    })),
  }, { refresh, log }).tickOnce();
}

/** Busy cycles never acquire a clone read slot owned by an already-running cycle. */
export async function withCiHealCycleLock(fn, { env = process.env, now = Date.now, lock = cycleLock({ env, now }) } = {}) {
  if (cycleBusy) return { skipped: 'busy' };
  cycleBusy = true;
  let acquired = false;
  try {
    acquired = lock.reserve().ok;
    if (!acquired) return { skipped: 'busy' };
    return await fn();
  } finally {
    try { if (acquired) lock.release(); } finally { cycleBusy = false; }
  }
}

export async function runCiHealLoopIteration({
  tick = runCiHealTick, now = Date.now, env = process.env, lock = cycleLock({ env, now }),
  root = cloneRoot(), locks = cloneLocks, bootHead, readHead = cloneHead,
  interval = setInterval, clearInterval: clearTimer = clearInterval,
  ensureAuth = () => ensureFreshGithubAppEnv(FLEET_APP_AUTH_OPTS), write = line => console.error(line),
} = {}) {
  return withCiHealCycleLock(async () => {
    const owner = defaultOwner(process.pid);
    if (locks.acquireRead(root, { owner })?.ok !== true) return { skipped: 'read-locked' };
    let timer;
    try {
      timer = interval(() => {
        try { lock.heartbeat(); } catch { /* best-effort lease refresh */ }
        try { locks.heartbeatRead(root, { owner }); } catch { /* refresh independently */ }
      }, HEARTBEAT_INTERVAL_MS);
      timer.unref();
      if (bootHead !== undefined) {
        const head = knownHead(readHead, root);
        if (!head) return { exit: 'head-unknown' };
        if (head !== bootHead) return { exit: 'head-moved' };
      }
      await ensureAuth();
      const start = now();
      const result = await tick();
      write(`ci-heal-loop: refusals=${result?.refusals?.length ?? 0} errors=${result?.errors?.length ?? 0} authPaused=${result?.authPaused ?? false}`);
      write(`ci-heal-loop: completed in ${now() - start}ms`);
      return result;
    } finally {
      try { if (timer) clearTimer(timer); } finally { locks.releaseRead(root, { owner }); }
    }
  }, { lock });
}

/** Pin the clone at boot; unknown or changed HEAD forbids every subsequent tick. */
export async function runCiHealLoop({
  parentPid, parentAlive = isPidAlive, resolveInterval = resolveCiHealInterval, once = false,
  iteration = runCiHealLoopIteration, sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms)),
  root, readHead = cloneHead, write = line => console.error(line), ...iterationDeps
} = {}) {
  try { root ??= cloneRoot(); } catch { return { exit: 'head-unknown' }; }
  const bootHead = knownHead(readHead, root);
  if (!bootHead) return { exit: 'head-unknown' };
  for (;;) {
    if (Number.isInteger(parentPid) && parentPid > 0 && !parentAlive(parentPid)) return { exit: 'parent-dead' };
    const head = knownHead(readHead, root);
    if (!head) return { exit: 'head-unknown' };
    if (head !== bootHead) return { exit: 'head-moved' };
    const { seconds, source } = resolveInterval();
    write(`ci-heal-loop: ciHeal.intervalSec=${seconds} source=${source}`);
    try {
      const result = await iteration({ ...iterationDeps, root, write, bootHead, readHead });
      if (result?.exit === 'head-moved' || result?.exit === 'head-unknown') return result;
    } catch (error) {
      if (isGithubAppAuthGuardError(error)) throw error;
      write(`ci-heal-loop: iteration failed: ${String(error?.message ?? error)}`);
      if (once) return { exit: 'error' };
    }
    if (once) return;
    await sleep(seconds * 1000);
  }
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const parentFlag = argv.find(arg => arg === '--parent-pid' || arg.startsWith('--parent-pid='));
  const rawPid = parentFlag?.slice('--parent-pid='.length);
  const parentPid = rawPid === undefined ? undefined : Number(rawPid);
  if (parentFlag !== undefined && (!/^\d+$/.test(rawPid) || !Number.isSafeInteger(parentPid) || parentPid <= 0)) {
    throw new Error('--parent-pid must be a positive integer');
  }
  const result = await runCiHealLoop({ ...deps, parentPid, once: argv.includes('--once') });
  if (result?.exit === 'error') process.exitCode = 1;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`ci-heal-loop: fatal: ${String(error?.message ?? error)}`); process.exit(1); });
}
