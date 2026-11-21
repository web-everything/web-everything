/** Inactive CI-healing child driver; callers own launching it. */
import { execFileSync, spawn as nodeSpawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cascadePolicy } from '../lib/policy-cascade.mjs';
import { readSettings } from '../lib/settings-files.mjs';
import { ensureFreshGithubAppEnv, FLEET_APP_AUTH_OPTS, isGithubAppAuthGuardError } from '../lib/github-app-auth-env.mjs';
import { isPidAlive } from '../lib/dispatch-throttle.mjs';
import { acquireRead, releaseRead, defaultOwner, cloneLockDirs, HEARTBEAT_INTERVAL_MS } from '../lib/daemon-clone-lock.mjs';
import { cloneDispatchBlock } from '../lib/daemon-self-sync.mjs';
import { readEnumOverride } from '../lib/capacity-leaf.mjs';
import { readCloneIdentity } from '../lib/daemon-background-build.mjs';
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

/**
 * `ciHeal.loop` on|off with provenance. Layers, strongest first: operator override (the audited host store), env
 * WE_CI_HEAL_LOOP, the settings file, then the standard (off). An invalid env value or an unreadable override fails
 * closed to off at its own layer and never falls through to a stronger "on".
 */
export function resolveCiHealLoop({ env = process.env, settings = readSettings(), readOverride = key => readEnumOverride(key) } = {}) {
  const pick = value => (value === 'on' || value === 'off' ? value : undefined);
  let override;
  try { override = readOverride('ciHeal.loop'); } catch { override = { ok: false, reason: 'error' }; }
  if (override?.ok && pick(override.value)) return { enabled: override.value === 'on', source: 'override' };
  // Only a store that is simply absent or has no such key may defer to a lower layer; unreadable or invalid operator
  // evidence could be a lost "off", so it fails closed to off.
  if (!override || (override.ok === false && !['absent', 'not-set'].includes(override.reason)) || override.ok === true) {
    return { enabled: false, source: 'override-unreadable' };
  }
  if (env.WE_CI_HEAL_LOOP !== undefined) return { enabled: pick(env.WE_CI_HEAL_LOOP) === 'on', source: 'env' };
  const file = pick(settings?.ciHeal?.loop);
  return file ? { enabled: file === 'on', source: 'file' } : { enabled: false, source: 'standard' };
}
export const resolveCiHealLoopEnabled = options => resolveCiHealLoop(options).enabled;

/**
 * Re-reads `ciHeal.loop` every daemon tick and reconciles the child with it: on starts one if none runs, off stops it
 * gracefully, an unreadable store or a throwing resolver counts as off. Each change of value or source is logged once.
 */
export function createCiHealLoopController({ supervisor, resolve = resolveCiHealLoop, log = line => console.error(line) } = {}) {
  let last = null;
  return {
    tick() {
      let resolved;
      try { resolved = resolve(); } catch { resolved = { enabled: false, source: 'resolve-error' }; }
      const key = `${resolved.enabled}|${resolved.source}`;
      if (key !== last) { last = key; log(`ci-heal-loop: ciHeal.loop=${resolved.enabled ? 'on' : 'off'} source=${resolved.source}`); }
      if (resolved.enabled) { if (!supervisor.current()) supervisor.start(); } else if (supervisor.current()) supervisor.halt();
      return resolved;
    },
  };
}

/** The single spawn point: null (nothing spawned) unless `ciHeal.loop` is on. */
export function spawnCiHealLoop({ env = process.env, settings, readOverride, spawnFn = nodeSpawn, parentPid = process.pid, log = line => console.error(line) } = {}) {
  const resolved = resolveCiHealLoop({ env, ...(settings ? { settings } : {}), ...(readOverride ? { readOverride } : {}) });
  if (!resolved.enabled) return null;
  log(`ci-heal-loop: ciHeal.loop=on source=${resolved.source}`);
  return spawnFn(process.execPath, [fileURLToPath(import.meta.url), `--parent-pid=${parentPid}`], { stdio: ['ignore', 'inherit', 'inherit'], env });
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

export async function runCiHealTick({ tickOnce, refresh, log, planAuth = planClaudeAuthDispatchGate, daemon, supersedeWatch } = {}) {
  // Injecting fixTick bypasses the daemon's production gate, so own that check here.
  const authGate = await planAuth();
  if (authGate.paused) return { skipped: 'auth-paused' };
  const { runTickAllRepos, defaultTagDispatchStatus, withFixDispatchClaimRefresh } = daemon
    ?? await import('../../skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs');
  // Supersede holds must still land before any dispatch, so the child runs the real watch, never an empty stub.
  supersedeWatch ??= (await import('./supersede-watch.mjs')).runSupersedeWatch;
  const empty = async () => ({ dispatched: [], refusals: [], reconcileRefusalDetails: [], applied: [],
    dispatch: [], holds: [], rows: [], notes: [], comments: [], autoGrants: [], prsByNumber: new Map() });
  return withFixDispatchClaimRefresh({
    tickOnce: tickOnce ?? (() => runTickAllRepos({
      reuseReconcilePlan: true, tagDispatchStatus: defaultTagDispatchStatus, authGateOverride: () => authGate,
      fixTick: empty, hungCiTick: empty, mainRedRebaseTick: empty, missingRunTick: empty,
      promoteDraftTick: empty, rulingStandDownTick: empty, notesTick: empty, awaitVerifyTick: empty,
      stuckFixerTick: empty, supersedeTick: supersedeWatch, orphanGuardTick: null,
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
  root = cloneRoot(), locks = cloneLocks, bootHead, bootIdentity, readHead = cloneHead,
  dispatchBlock = () => cloneDispatchBlock({ root, env, knownIdentity: bootIdentity }),
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
      // The parent's own gates (quarantine, un-concluded re-clone) bind the child too: same checkout, same rule.
      const blocked = dispatchBlock();
      if (blocked) return { skipped: blocked };
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
  iteration = runCiHealLoopIteration, enabled = () => resolveCiHealLoopEnabled(), identityOf = readCloneIdentity, sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms)),
  root, readHead = cloneHead, write = line => console.error(line), ...iterationDeps
} = {}) {
  try { root ??= cloneRoot(); } catch { return { exit: 'head-unknown' }; }
  const bootHead = knownHead(readHead, root);
  if (!bootHead) return { exit: 'head-unknown' };
  let bootIdentity = null;
  try { bootIdentity = identityOf(root); } catch { /* unknown identity fails closed in cloneDispatchBlock */ }
  for (;;) {
    // The off-switch is the rollback: re-read it before every iteration and leave cleanly (exit 0, no restart).
    if (!enabled()) { write('ci-heal-loop: ciHeal.loop is off — exiting'); return { exit: 'disabled' }; }
    if (Number.isInteger(parentPid) && parentPid > 0 && !parentAlive(parentPid)) return { exit: 'parent-dead' };
    const head = knownHead(readHead, root);
    if (!head) return { exit: 'head-unknown' };
    if (head !== bootHead) return { exit: 'head-moved' };
    const { seconds, source } = resolveInterval();
    write(`ci-heal-loop: ciHeal.intervalSec=${seconds} source=${source}`);
    try {
      const result = await iteration({ ...iterationDeps, root, write, bootHead, bootIdentity, readHead });
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
