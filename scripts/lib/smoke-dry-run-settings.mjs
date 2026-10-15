/** Dependency-light rebuild-smoke dry-run settings, shared by harnesses and candidate children. */
import { cascadePolicy } from './policy-cascade.mjs';
import { readDeclaredSettings } from './settings-files.mjs';

/** Smoke-only read bounds: standard → platform → declared tool settings → env. Never throws. */
export function resolveSmokeDryRun(env = process.env) {
  const standard = { prSample: 12, snapshotStaleOkMs: 900000, lanePoolListCache: true };
  try {
    let tool;
    try { tool = readDeclaredSettings().settings?.rebuildSmokeDryRun; } catch { /* use lower layers */ }
    const integer = value => /^\d+$/.test(String(value ?? '')) ? Number(value) : undefined;
    const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
    const cache = env?.WE_SMOKE_LANE_POOL_LIST_CACHE;
    const r = cascadePolicy('rebuildSmokeDryRun', tool, {
      env, standard,
      envValues: { prSample: integer(env?.WE_SMOKE_PR_SAMPLE), snapshotStaleOkMs: integer(env?.WE_SMOKE_SNAPSHOT_STALE_OK_MS),
        lanePoolListCache: cache === 'on' ? true : cache === 'off' ? false : undefined },
      valid: { prSample: nonnegative, snapshotStaleOkMs: nonnegative, lanePoolListCache: value => typeof value === 'boolean' },
    });
    return { ...r.value, sources: r.sources };
  } catch {
    return { ...standard, sources: { prSample: 'standard', snapshotStaleOkMs: 'standard', lanePoolListCache: 'standard' } };
  }
}
