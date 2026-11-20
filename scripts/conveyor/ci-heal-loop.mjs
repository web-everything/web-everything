/** Inactive CI-healing child driver; callers own launching it. */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cascadePolicy } from '../lib/policy-cascade.mjs';
import { readSettings } from '../lib/settings-files.mjs';
import { ensureFreshGithubAppEnv, FLEET_APP_AUTH_OPTS, isGithubAppAuthGuardError } from '../lib/github-app-auth-env.mjs';
import { isPidAlive } from '../lib/dispatch-throttle.mjs';
import { acquireRead, releaseRead, defaultOwner } from '../lib/daemon-clone-lock.mjs';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { reserve, readLockEntry, releaseLockDirIf } from '../readiness/file-locks.mjs';

const DEFAULT_SECONDS = 300;
const validInterval = value => Number.isInteger(value) && value >= 60 && value <= 1800;
const boundedInterval = value => validInterval(value) ? value : DEFAULT_SECONDS;
const gitRev = (cwd, ref) => execFileSync('git', ['rev-parse', ref], {
  cwd, encoding: 'utf8', timeout: 5000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const cloneRoot = () => gitRev(process.cwd(), '--show-toplevel');
const cloneHead = root => gitRev(root, 'HEAD');
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
  };
}

export async function runCiHealTick({ tickOnce, refresh, log } = {}) {
  const { runTickAllRepos, defaultTagDispatchStatus, withFixDispatchClaimRefresh } = await import('../../skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs');
  return withFixDispatchClaimRefresh({
    tickOnce: tickOnce ?? (() => runTickAllRepos({ ciHealOnly: true, reuseReconcilePlan: true, tagDispatchStatus: defaultTagDispatchStatus })),
  }, { refresh, log }).tickOnce();
}

/** Busy cycles never acquire a clone read slot owned by an already-running cycle. */
export async function withCiHealCycleLock(fn, { env = process.env, now = Date.now, lock = cycleLock({ env, now }) } = {}) {
  if (!lock.reserve().ok) return { skipped: 'busy' };
  try { return await fn(); } finally { lock.release(); }
}

export async function runCiHealLoopIteration({
  tick = runCiHealTick, now = Date.now, env = process.env, lock = cycleLock({ env, now }),
  root = cloneRoot(), locks = { acquireRead, releaseRead }, bootHead, readHead = cloneHead,
  ensureAuth = () => ensureFreshGithubAppEnv(FLEET_APP_AUTH_OPTS), write = line => console.error(line),
} = {}) {
  return withCiHealCycleLock(async () => {
    const owner = defaultOwner(process.pid);
    if (locks.acquireRead(root, { owner })?.ok !== true) return { skipped: 'read-locked' };
    try {
      if (bootHead !== undefined) {
        const head = knownHead(readHead, root);
        if (!head) return { exit: 'head-unknown' };
        if (head !== bootHead) return { exit: 'head-moved' };
      }
      await ensureAuth();
      const start = now();
      const result = await tick();
      write(`ci-heal-loop: completed in ${now() - start}ms`);
      return result;
    } finally { locks.releaseRead(root, { owner }); }
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
    }
    if (once) return;
    await sleep(seconds * 1000);
  }
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const parentPid = Number((argv.find(arg => arg.startsWith('--parent-pid=')) ?? '').split('=')[1]);
  return runCiHealLoop({ ...deps, parentPid, once: argv.includes('--once') });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`ci-heal-loop: fatal: ${String(error?.message ?? error)}`); process.exit(1); });
}
