/** Persistent throttle for health-watch's FULL stale-state lane scan (not claim/liveness reads). */
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { platformPreference, resolveCascade } from './policy-cascade.mjs';
import { readDeclaredSettings } from './settings-files.mjs';

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
  if (fresh) return cache.lanes;
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
