#!/usr/bin/env node
/** CI healing has its own child: synchronous fix work can starve a timer in the daemon. */
import { spawn as nodeSpawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cascadePolicy } from '../lib/policy-cascade.mjs';
import { readSettings } from '../lib/settings-files.mjs';
import { ensureFreshGithubAppEnv, FLEET_APP_AUTH_OPTS, isGithubAppAuthGuardError } from '../lib/github-app-auth-env.mjs';
import { isPidAlive } from '../lib/dispatch-throttle.mjs';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { reserve, readLockEntry, releaseLockDirIf } from '../readiness/file-locks.mjs';

const SELF = fileURLToPath(import.meta.url);
const DEFAULT_SECONDS = 300;
const validInterval = value => Number.isInteger(value) && value >= 60 && value <= 1800;
const boundedInterval = value => validInterval(value) ? value : DEFAULT_SECONDS;

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

/** Shared by the child and the real daemon's inline fallback; busy cycles do no work. */
export async function withCiHealCycleLock(fn, { env = process.env, now = Date.now, lock = cycleLock({ env, now }) } = {}) {
  if (!lock.reserve().ok) return { skipped: 'busy' };
  try { return await fn(); } finally { lock.release(); }
}

/** One cross-process single-flight iteration. Any auth refresh failure stops dispatch. */
export async function runCiHealLoopIteration({
  tick = runCiHealTick, now = Date.now, env = process.env, lock = cycleLock({ env, now }),
  ensureAuth = () => ensureFreshGithubAppEnv(FLEET_APP_AUTH_OPTS), write = line => console.error(line),
} = {}) {
  return withCiHealCycleLock(async () => {
    await ensureAuth();
    const start = now();
    const result = await tick();
    write(`ci-heal-loop: completed in ${now() - start}ms`);
    return result;
  }, { lock });
}

export function spawnCiHealLoop({ env = process.env, spawnFn = nodeSpawn, parentPid = process.pid } = {}) {
  return spawnFn(process.execPath, [SELF, `--parent-pid=${parentPid}`], { stdio: 'inherit', env });
}

/** Injectable loop driver: one sleep after each iteration, no in-process daemon timer. */
export async function runCiHealLoop({
  parentPid, parentAlive = isPidAlive, resolveInterval = resolveCiHealInterval,
  iteration = runCiHealLoopIteration, sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms)),
  write = line => console.error(line),
} = {}) {
  for (;;) {
    if (Number.isInteger(parentPid) && parentPid > 0 && !parentAlive(parentPid)) return;
    const { seconds, source } = resolveInterval();
    write(`ci-heal-loop: ciHeal.intervalSec=${seconds} source=${source}`);
    try { await iteration({ write }); } catch (error) {
      if (isGithubAppAuthGuardError(error)) throw error;
      write(`ci-heal-loop: iteration failed: ${String(error?.message ?? error)}`);
    }
    await sleep(seconds * 1000);
  }
}

async function main(argv = process.argv.slice(2)) {
  const parentPid = Number((argv.find(arg => arg.startsWith('--parent-pid=')) ?? '').split('=')[1]);
  await runCiHealLoop({ parentPid });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`ci-heal-loop: fatal: ${String(error?.message ?? error)}`); process.exit(1); });
}
