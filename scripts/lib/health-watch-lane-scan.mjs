/**
 * Persistent throttle for health-watch's FULL stale-state lane scan (not claim/liveness reads).
 *
 * THE CACHE IS FOR REPORTING ONLY (operator ruling 2026-10-20). A row served from the cache carries `cachedAt`; the
 * stale-state reader never reports a cached row as safe (`hasUnsafeWork:false`): cached unsafe stays unsafe, cached
 * safe/unknown becomes unknown (null). Before ANY destructive action on a lane (reclaim, reset, reuse,
 * release-on-behalf) the actor must call {@link guardLaneAction}, which runs {@link freshLaneSafety} on that one lane
 * now and permits the action only on a fresh, positively-safe result; any error is unsafe.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { platformPreference, resolveCascade } from './policy-cascade.mjs';
import { readDeclaredSettings } from './settings-files.mjs';
import { DIRTY_PROBE_ARGS, hasHiddenIndexFlags, laneGitEnv } from './git-transport-branch.mjs';

export function resolveLaneScanPolicy({ env = process.env,
  platform = platformPreference('healthWatch', { env }), tool = readDeclaredSettings().settings?.healthWatch,
} = {}) {
  const raw = env.WE_HEALTH_WATCH_LANE_SCAN_INTERVAL_SEC;
  const pick = block => {
    const value = block?.laneScanIntervalSec;
    // Validate the setting as a leaf even when a malformed object was supplied.
    return value === undefined ? {} : { laneScanIntervalSec: typeof value === 'object' ? JSON.stringify(value) : value };
  };
  const result = resolveCascade({ standard: { laneScanIntervalSec: 300 }, platform: pick(platform), tool: pick(tool),
    envValues: { laneScanIntervalSec: raw === undefined ? undefined : /^\d+$/.test(raw) ? Number(raw) : raw },
    valid: { laneScanIntervalSec: v => Number.isSafeInteger(v) && v > 0 },
  });
  // This throttle deliberately falls back to the standard on invalid configuration.
  return { interval: result.invalid.length ? 300 : result.value.laneScanIntervalSec,
    source: result.invalid.length ? 'standard' : result.sources.laneScanIntervalSec, invalid: result.invalid };
}

export function cachedLaneScan(scan, { dir, root, now = Date.now(), write = true,
  policy = resolveLaneScanPolicy(), log = line => console.error(line),
} = {}) {
  const path = dir ? join(dir, 'lane-scan.json') : null;
  let cache;
  try { cache = JSON.parse(readFileSync(path, 'utf8')); } catch { /* missing/corrupt is due */ }
  const valid = cache?.version === 1 && cache.root === root && Number.isFinite(cache.at)
    && Array.isArray(cache.lanes) && cache.lanes.every(row => row?.lane && typeof row.lane === 'object' && typeof row.lane.path === 'string'
      && (row.ahead === null || Number.isSafeInteger(row.ahead) && row.ahead >= 0));
  const age = valid ? now - cache.at : NaN;
  const fresh = age >= 0 && age < policy.interval * 1000;
  const invalid = policy.invalid.length ? `, invalid setting (${policy.invalid.join('; ')}); falling back to default 300s` : '';
  log(`health-watch: lane scan ${fresh ? `skipped (age ${Math.floor(age / 1000)}s < ${policy.interval}s` : `running (due, interval=${policy.interval}s`}, source=${policy.source}${invalid})`);
  // Served rows are marked with the scan time so no reader can mistake them for a fresh safety read.
  if (fresh) return cache.lanes.map(row => ({ ...row, cachedAt: cache.at }));
  const lanes = scan();
  if (path && write) {
    const tmp = `${path}.tmp-${process.pid}`;
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(tmp, JSON.stringify({ version: 1, root, at: now, lanes }), { mode: 0o600 });
      renameSync(tmp, path);
    } catch (error) { log(`health-watch: lane scan cache write failed: ${error.code || 'unknown'}`); }
    finally { try { rmSync(tmp, { force: true }); } catch { /* best-effort temp cleanup */ } }
  }
  return lanes;
}

/**
 * FRESH safety read of ONE lane, right now (never the cache). Unsafe when the worktree has any change (tracked or
 * untracked or ignored), index flags that may hide edits, any stash, or any commit absent from local origin refs. Any git error,
 * timeout or unparseable output is UNSAFE: this answers "may I destroy this lane's state?", so not knowing is no.
 * @returns {{hasUnsafeWork:boolean, fresh:true, observedAt:string, reason:string, error?:string}}
 */
export function freshLaneSafety({ path, exec = execFileSync, now = Date.now } = {}) {
  const observedAt = new Date(now()).toISOString();
  const unsafe = (reason, error) => ({ hasUnsafeWork: true, fresh: true, observedAt, reason, ...(error ? { error } : {}) });
  if (typeof path !== 'string' || !path) return unsafe('no lane path');
  const git = argv => String(exec('git', argv, { cwd: path, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
    env: { ...laneGitEnv(path), GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] }));
  try {
    // Share destructive cleanup's probe: ignored files and submodule work must remain visible.
    const status = git([...DIRTY_PROBE_ARGS]);
    if (typeof status !== 'string') return unsafe('status unreadable');
    if (status.trim()) return unsafe('worktree has changes');
    if (hasHiddenIndexFlags(git)) return unsafe('index flags may hide worktree changes');
    const stash = git(['stash', 'list']);
    if (stash.trim()) return unsafe('stash entries present');
    const ahead = git(['rev-list', '--count', 'HEAD', '--not', '--remotes=origin']).trim();
    if (!/^\d+$/.test(ahead)) return unsafe('ahead count unreadable');
    if (Number(ahead) > 0) return unsafe(`${ahead} unpushed commit(s)`);
    return { hasUnsafeWork: false, fresh: true, observedAt, reason: 'clean, no stash, nothing unpushed' };
  } catch (error) {
    return unsafe('fresh safety check failed', String(error?.message ?? error).split('\n')[0]);
  }
}

/**
 * THE gate every destructive lane action goes through. Ignores whatever safety a record (cached or not) claims, runs
 * a fresh check of that one lane, and permits `action` only when the fresh result is positively safe. Logged either
 * way. Never throws (a throwing checker is a refusal).
 * @returns {{act:boolean, action:string, path:string, fresh:object, reason:string}}
 */
export function guardLaneAction({ path, action, check = freshLaneSafety, exec, log = line => console.error(line) } = {}) {
  let fresh;
  try { fresh = check({ path, ...(exec ? { exec } : {}) }); }
  catch (error) { fresh = { hasUnsafeWork: true, fresh: true, reason: 'fresh safety check threw', error: String(error?.message ?? error) }; }
  const act = fresh?.fresh === true && fresh.hasUnsafeWork === false;
  const reason = act ? `fresh check safe (${fresh.reason})` : `refused: fresh check ${fresh?.hasUnsafeWork === false ? 'not fresh' : 'unsafe'} (${fresh?.reason ?? 'no result'}${fresh?.error ? `: ${fresh.error}` : ''})`;
  try { log(`health-watch: lane ${action} ${path}: ${reason}`); } catch { /* logging never decides */ }
  return { act, action, path, fresh, reason };
}
