#!/usr/bin/env node
/** Bounded shadow consumer. No GitHub, notification, worker or lane actuator imports. */
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readRebuildStateFile } from '../lib/daemon-last-good.mjs';
import { resolveManifestEntry } from '../../skills-src/conveyor/daemon-manifest.mjs';
import { runPassDaemonLoop, passDaemonLeaseKey, spawnPassOnce, realSleep } from '../../skills-src/conveyor/pass-daemon.mjs';
import { RUNNER_LOCK_ROOT, makeOwner, acquireRunnerLease, heartbeatRunnerLease, releaseRunnerLeaseIfOwned, runnerLeaseStatus } from '../../skills-src/conveyor/runner-lock.mjs';
import { decide, SHADOW_ACTUATORS } from './health-responder-core.mjs';
import { healthDir } from './health-watch-section.mjs';
import { responderDir, readWatchGeneration, readResponderConfig, readReceipts, rotateJournalIfNeeded, appendDecisions, writeLastTick, boundedText } from './health-responder-state.mjs';
export const TICK_CEILING_MS = 30_000;
export const CHILD_READ_CEILING_MS = 10_000;
/** External adapters are deliberately absent. Injection is for read-only facts and test tripwires only. */
export async function shadowTick({ stateRoot, env = process.env, now = Date.now(), clock = Date.now,
  readFacts = async () => ({}), actuators = SHADOW_ACTUATORS, leaseAlive = () => true,
  bootRevision = env.HEALTH_RESPONDER_BOOT_REVISION ?? 'unknown', bootInputs = env.HEALTH_RESPONDER_BOOT_INPUTS ?? null, leaseOwner = env.HEALTH_RESPONDER_LEASE_OWNER ?? 'pass-daemon',
  rotateBytes,
} = {}) {
  void actuators; // No dispatch path exists, even when supplied with live-capable test doubles.
  const start = clock(), dir = responderDir(stateRoot, env);
  const snapshot = readWatchGeneration(healthDir(stateRoot, env), { deadline: start + TICK_CEILING_MS, clock });
  const config = readResponderConfig(dir);
  rotateJournalIfNeeded(dir, { rotateBytes }); // Size never stops a tick: the journal rotates into a complete segment instead.
  const receipts = readReceipts(dir); // Corruption freezes the tick; stderr is the fallback if the log is unwritable.
  let facts = {}, timer;
  const abort = new AbortController();
  try {
    if (snapshot.watchGeneration.valid && config?.enabled === true && config.mode === 'shadow') {
      facts = await Promise.race([
        readFacts(snapshot.episodes.filter((e) => e.status === 'open'), { signal: abort.signal, timeoutMs: CHILD_READ_CEILING_MS }),
        new Promise((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(new Error('facts timeout')); }, CHILD_READ_CEILING_MS); }),
      ]);
    }
  } catch (e) { snapshot.watchGeneration = { valid: false, reason: `facts unavailable: ${e.message}` }; }
  finally { clearTimeout(timer); abort.abort(); }
  if (!leaseAlive() || clock() - start >= TICK_CEILING_MS)
    snapshot.watchGeneration = { valid: false, reason: 'lease lost or tick ceiling reached' };
  // Re-read the independent kill/config switch immediately before recording the proposal.
  const decisions = decide({ ...snapshot, subjectFacts: facts, actionReceipts: receipts,
    budgets: [], config: readResponderConfig(dir), now });
  const written = appendDecisions(dir, decisions, { rotateBytes });
  writeLastTick(dir, { completedAt: clock(), durationMs: clock() - start, bootRevision, leaseOwner,
    bootInputs, mode: 'shadow', effectiveSettings: readResponderConfig(dir), decisions: written.length, externalEffects: 0 });
  return written;
}
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const RESTART_FLOOR_MS = 300_000;
/** Bounded local read; never fetch, rebuild, edit configuration or run an action job. */
export function readBootInputs(root = ROOT, env = process.env) {
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8',
    timeout: CHILD_READ_CEILING_MS, maxBuffer: 4096, env: { ...env, GIT_OPTIONAL_LOCKS: '0' } }).trim();
  const adopted = readRebuildStateFile(root, env)?.adopted;
  return { revision, inputsKey: adopted?.inputsKey ?? revision,
    mainSha: adopted?.mainSha ?? null, applied: adopted?.applied ?? [], coverage: adopted ? 'rebuild-inputs' : 'checkout-head-only' };
}
export function shouldReload(boot, current, uptime, requested = false) {
  return uptime >= RESTART_FLOOR_MS && (requested || boot.inputsKey !== current.inputsKey);
}
/** Reuses pass-daemon cadence/spawn/lease primitives, excluding its auth refresh and clone-writing hooks. */
export async function runResponderDaemon({ root = ROOT, env = process.env, lockRoot = RUNNER_LOCK_ROOT,
  clock = Date.now, sleep = realSleep, readInputs = () => readBootInputs(root, env),
  runPass = spawnPassOnce, maxRuns = Infinity, log = console,
} = {}) {
  const entry = resolveManifestEntry('health-responder');
  const owner = makeOwner('health-responder'), key = passDaemonLeaseKey('health-responder');
  if (!acquireRunnerLease(lockRoot, owner, { key }).ok) return { stoppedReason: 'lease-held', runs: 0 };
  const bootAt = clock(); let alive = true, restart = false, timer;
  const shutdown = () => { alive = false; };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
  try {
    const boot = readInputs();
    timer = setInterval(() => { alive = heartbeatRunnerLease(lockRoot, owner, { key }) && alive; }, 10_000);
    timer.unref();
    return await runPassDaemonLoop({ intervalMs: entry.intervalMs, maxRuns, sleep,
      isAlive: () => alive && !restart,
      runPass: async () => {
        if (!alive || !heartbeatRunnerLease(lockRoot, owner, { key })) { alive = false; return { code: 0 }; }
        let requested = false;
        try { requested = Number(boundedText(join(responderDir(undefined, env), 'restart-request'), 256).trim()) > bootAt; }
        catch (e) { if (e.code !== 'ENOENT') log.error(`health-responder: unreadable restart request: ${e.message}`); }
        restart = shouldReload(boot, readInputs(), clock() - bootAt, requested);
        if (restart) return { code: 0 };
        return runPass(entry, { root, log, env: { ...env, HEALTH_RESPONDER_BOOT_REVISION: boot.revision,
          HEALTH_RESPONDER_BOOT_INPUTS: JSON.stringify(boot), HEALTH_RESPONDER_LEASE_OWNER: owner,
          HEALTH_RESPONDER_LOCK_ROOT: lockRoot } });
      }, onRunError: (e) => { log.error(`health-responder: tick held: ${e.message}`); },
    });
  } finally {
    clearInterval(timer); process.off('SIGTERM', shutdown); process.off('SIGINT', shutdown);
    releaseRunnerLeaseIfOwned(lockRoot, owner, { key });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--daemon')) {
    try { await runResponderDaemon(); } catch (e) { console.error(e.message); process.exitCode = 1; }
  } else {
    const timer = setTimeout(() => { console.error('health-responder: tick exceeded 30 seconds'); process.exit(1); }, TICK_CEILING_MS);
    try {
      const owner = process.env.HEALTH_RESPONDER_LEASE_OWNER;
      if (!owner) throw new Error('tick requires the resident singleton owner; use --daemon');
      const leaseAlive = () => {
        if (!owner) return false; // Direct ticks cannot compete with the resident singleton.
        const status = runnerLeaseStatus(process.env.HEALTH_RESPONDER_LOCK_ROOT ?? RUNNER_LOCK_ROOT,
          { key: passDaemonLeaseKey('health-responder') });
        return status.held && status.owner === owner;
      };
      console.log(JSON.stringify(await shadowTick({ leaseAlive })));
    } catch (error) { console.error(`health-responder: held: ${error.message}`); process.exitCode = 1; }
    finally { clearTimeout(timer); }
  }
}
