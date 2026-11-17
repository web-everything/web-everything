/** PR #6945: ownership must stay revoked across pending and overlapping cache writes. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

export default {
  id: 'host-handoff-cache-write-race',
  title: 'A failed or overlapping cache write cannot resurrect ownership after handoff',
  card: 'PR #6945 / x2fybk1',
  fixedBy: { sha: 'PR #6945 repair', where: 'lane/daemon-host-guard',
    paths: ['scripts/lib/daemon-host-guard.mjs'] },
  fixPresent(root) {
    // Independent behavioral check, including the actual on-disk cache fallback.
    const script = `import b from ${JSON.stringify(pathToFileURL(fileURLToPath(import.meta.url)).href)};
      const report = await b.run(); process.exitCode = b.judge(report).length ? 1 : 0;`;
    return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, SOAK_TREE_ROOT: root }, encoding: 'utf8', timeout: 10_000,
      maxBuffer: 1024 * 1024,
    }).status === 0;
  },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || fileURLToPath(new URL('../../../../', import.meta.url));
    const { resolveHostRole, readCacheFile, writeCacheFile, invalidateCacheFile, FRESH_READ_MS } =
      await import(pathToFileURL(join(root, 'scripts/lib/daemon-host-guard.mjs')).href);
    const dir = mkdtempSync(join(tmpdir(), 'host-handoff-soak-'));
    const path = join(dir, 'cache.json');
    const now = 1_800_000_000_000;
    const offline = () => ({ status: 'error' });
    const violations = [];
    try {
      for (const fails of [false, true]) {
        writeCacheFile({ host: 'a', owner: 'a', status: 'ok', readAt: now, writtenAt: now }, path);
        const writing = deferred();
        const started = deferred();
        const options = { thisHost: 'a', now, atStart: true, state: {},
          readCache: () => readCacheFile(path), invalidateCache: () => invalidateCacheFile(path) };
        const old = resolveHostRole({ ...options, readRemote: () => ({ status: 'ok', owner: 'a' }),
          writeCache: async (value) => { started.resolve(); await writing.promise; writeCacheFile(value, path); } });
        await started.promise;
        const handoff = resolveHostRole({ ...options, now: now + 1,
          readRemote: () => ({ status: 'ok', owner: 'b' }), writeCache: (value) => {
            if (fails) throw new Error('disk full');
            writeCacheFile(value, path);
          } });
        await Promise.resolve();
        await Promise.resolve();
        const during = await resolveHostRole({ ...options, now: now + 2, atStart: false, readRemote: offline });
        writing.resolve();
        await Promise.all([old, handoff]);
        const after = await resolveHostRole({ ...options, now: now + FRESH_READ_MS + 3,
          atStart: false, readRemote: offline });
        // A new guard must also stay closed when removal or replacement succeeded.
        const restarted = await resolveHostRole({ ...options, state: {}, now: now + FRESH_READ_MS + 3,
          atStart: false, readRemote: offline });
        for (const [phase, decision] of [['pending', during], ['offline', after], ['restart', restarted]]) {
          if (decision.role !== 'standby') violations.push(`${phase}: ownership resurrected (write fails=${fails})`);
        }
      }
      return { violations };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
  judge(report) { return report.violations; },
};
