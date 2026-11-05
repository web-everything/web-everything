/** Process state shared by one simulated world, never by worlds with independent clocks. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export function isolatedProcessEnv(root, ambient = process.env) {
  const env = {
    ...ambient,
    // vitest.setup.ts supplies a per-file root. Scenarios in that file advance independent clocks;
    // sharing its budget can leave the next scenario waiting on a window dated 11 minutes ahead.
    WE_GH_THROTTLE_LOCK_ROOT: join(root, 'gh-throttle'),
    WE_COORDINATION_ROOT: join(root, 'coordination'),
  };
  for (const key of ['WE_DISPATCH_ROUTING_SNAPSHOT', 'WE_GITHUB_APP_ID',
    'WE_GITHUB_APP_INSTALLATION_ID', 'WE_GITHUB_APP_PRIVATE_KEY_PATH', 'GITHUB_TOKEN']) delete env[key];
  return env;
}

/**
 * R553/R559: fixer admission refuses on a missing, stale or unreadable memory reading, and a CI runner has no macOS
 * memory-pressure level, so a world with no snapshot never dispatches a fixer. Seed the world's OWN coordination root
 * (never the host's) with a healthy, memory-only reading; cpu/swap stay unknown, so the dynamic fixer cap still cannot raise.
 */
export function seedHealthyHostSnapshot(coordinationRoot) {
  if (!coordinationRoot) throw Error('sim world has no coordination root to seed a host snapshot into');
  const dir = join(coordinationRoot, 'resource');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'snapshot.json'), `${JSON.stringify({
    schema: 'resource-snapshot/1', sampledAt: '2026-01-01T00:00:00.000Z', freshUntil: '2999-01-01T00:00:00.000Z', intervalMs: 10000,
    cpu: { idlePct: null, cores: null, loadAvg: [null, null, null] },
    memory: { pressureLevel: 1, freePct: null, metric: 'available', availableMb: 16384, floorMb: null, floorSource: null, swapUsedPct: null },
  })}\n`);
}

/** Generated App shim directories contain live state, not tools to copy into a fake world's PATH. */
export function toolPathDirs(pathEnv = process.env.PATH ?? '') {
  return pathEnv.split(delimiter).filter(Boolean)
    .filter(dir => !/(^|[/\\])github-app-token([/\\]|$)/.test(dir));
}
