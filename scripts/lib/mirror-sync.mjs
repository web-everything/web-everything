/** Fetch-only mirror refresh, with a shared cadence and exclusive lease. */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cascadePolicy } from './policy-cascade.mjs';
import { appendDaemonEvent } from './daemon-events.mjs';

const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const nonemptyPath = value => typeof value === 'string' && value.trim().length > 0
  && !/[\x00-\x1f\x7f]/.test(value);
const runGit = (args, { timeoutMs }) => spawnSync('git', args, {
  encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1024 * 1024, shell: false,
});

export function resolveMirrorSyncPolicy({ config = {}, env = process.env, platform, log } = {}) {
  return cascadePolicy('mirrorSync', config.mirrorSync, {
    standard: {
      intervalMs: 300_000, fetchTimeoutMs: 120_000,
      mirrorPath: join(homedir(), 'workspace', '.mirrors', 'web-everything.git'),
    },
    envValues: {
      intervalMs: env.WE_MIRROR_SYNC_INTERVAL_MS === undefined ? undefined : Number(env.WE_MIRROR_SYNC_INTERVAL_MS),
      fetchTimeoutMs: env.WE_MIRROR_SYNC_TIMEOUT_MS === undefined ? undefined : Number(env.WE_MIRROR_SYNC_TIMEOUT_MS),
      mirrorPath: env.WE_MIRROR_PATH,
    },
    valid: { intervalMs: positiveInteger, fetchTimeoutMs: positiveInteger, mirrorPath: nonemptyPath },
    platform, env, log,
  });
}

/** Git IO is exclusively run(args, { timeoutMs }); no shell or maintenance commands. */
export async function syncMirror({
  mirrorPath, stateDir, now = Date.now(), intervalMs = 300_000, fetchTimeoutMs = 120_000,
  // Both sequential Git calls may consume their full timeout before the lease is released.
  lockStale = 2 * fetchTimeoutMs + 60_000, run = runGit, exists = existsSync,
  log = console.error, emit = () => {},
} = {}) {
  let owned = false;
  let result;
  let temporary;
  const token = randomUUID();
  const lockPath = join(stateDir, 'mirror-sync.lock');
  const guardPath = `${lockPath}.guard`;
  const statePath = join(stateDir, 'mirror-sync.json');
  const finish = async (status, reason) => {
    result = { status };
    // Never log child output: authentication failures may contain credentials.
    if (reason) result.reason = reason;
    if (status.startsWith('skipped-')) await emit({ type: 'mirror-sync-skipped', reason });
    else if (status === 'failed') await emit({ type: 'mirror-sync-failed', reason });
    return result;
  };
  try {
    if (!nonemptyPath(mirrorPath) || !positiveInteger(intervalMs)
      || !positiveInteger(fetchTimeoutMs) || !positiveInteger(lockStale) || !Number.isFinite(now)) {
      return await finish('failed', 'invalid settings');
    }
    mkdirSync(stateDir, { recursive: true });
    // Every lease mutation uses this guard, which is never reclaimed by age. A crashed
    // guard owner therefore requires operator recovery rather than risking concurrent fetches.
    try { mkdirSync(guardPath); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      return await finish('locked', 'lease guard busy; if persistent, stop mirror sync before removing mirror-sync.lock.guard');
    }
    let contended = false;
    try {
      let previous;
      try { previous = statSync(lockPath); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (previous && now - previous.mtimeMs <= lockStale) {
        contended = true;
      } else {
        if (previous) unlinkSync(lockPath);
        writeFileSync(lockPath, token, { flag: 'wx', mode: 0o600 });
        owned = true;
        // Lease age uses the same injected clock as cadence, including hermetic callers.
        utimesSync(lockPath, now / 1000, now / 1000);
      }
    } finally { rmdirSync(guardPath); }
    if (contended) return await finish('locked');
    let lastSyncAt;
    try { lastSyncAt = JSON.parse(readFileSync(statePath, 'utf8')).lastSyncAt; }
    catch (error) {
      if (error.code && error.code !== 'ENOENT') throw error;
      // Torn JSON is not evidence of a completed fetch.
    }
    if (Number.isFinite(lastSyncAt) && lastSyncAt <= now && now - lastSyncAt < intervalMs) {
      return await finish('rate-limited');
    }
    if (!exists(mirrorPath)) return await finish('skipped-missing', 'missing');
    const args = [`--git-dir=${mirrorPath}`, '-c', 'gc.auto=0', '-c', 'maintenance.auto=false'];
    const bare = await run([...args, 'rev-parse', '--is-bare-repository'], { timeoutMs: fetchTimeoutMs });
    if (bare?.error || bare?.status !== 0 || String(bare.stdout).trim() !== 'true') {
      return await finish('skipped-invalid', 'invalid');
    }
    const fetched = await run([...args, 'fetch', '--prune', '--no-auto-gc'], { timeoutMs: fetchTimeoutMs });
    if (fetched?.error || fetched?.status !== 0) return await finish('failed', 'fetch failed; retry next tick');
    temporary = `${statePath}.${token}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ lastSyncAt: now })}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, statePath);
    temporary = undefined;
    return await finish('synced');
  } catch {
    return await finish('failed', 'mirror refresh unavailable; retry next tick');
  } finally {
    if (temporary) { try { unlinkSync(temporary); } catch { /* Preserve the original failure. */ } }
    if (owned) {
      let guarded = false;
      try {
        mkdirSync(guardPath);
        guarded = true;
        if (readFileSync(lockPath, 'utf8') === token) unlinkSync(lockPath);
      } catch { /* On contention, leave the lease for guarded reclamation next tick. */ }
      finally {
        if (guarded) { try { rmdirSync(guardPath); } catch { /* Operator recovery on persistent guard. */ } }
      }
    }
    log(`mirror-sync: ${result?.status || 'failed'}${result?.reason ? ` (${result.reason})` : ''}`);
  }
}

/** Skipped ticks do not even resolve settings or inspect injected dependencies. */
export async function mirrorSyncForTick({ dryRun, fixtureTick, now, config, env, deps = {} } = {}) {
  if (dryRun || fixtureTick) return null;
  const { value } = resolveMirrorSyncPolicy({ config, env, log: deps.log });
  return (deps.syncMirror ?? syncMirror)({
    ...value, now, stateDir: deps.stateDir,
    ...(deps.run ? { run: deps.run } : {}),
    ...(deps.exists ? { exists: deps.exists } : {}),
    ...(deps.log ? { log: deps.log } : {}),
    emit: deps.emit ?? (event => appendDaemonEvent({
      kind: event.type, daemon: 'health-watch', detail: { reason: event.reason },
    })),
  });
}
