/**
 * @file breaks/infra-lock-waiter-busy-spins.mjs — red main @ 7974d7119 (CI run 43110368006, `test-shard (10)`).
 * `withInfraLock` (the sidecar store lock every infra-blocked record/retry mutation takes) waited for a held lock by
 * BUSY-SPINNING for 8 ms per round. On a loaded or small runner several concurrent waiters burn the very CPU the lock
 * holder needs, the holder is starved, the 5 s wait budget runs out and `requireLock` throws `could not acquire store
 * lock` — the multi-process mutual-exclusion test failed that way with 8 waiters.
 *
 * Scenario: a child process (a real waiter) calls the REAL `withInfraLock` against a store whose lock is held by
 * someone else for the whole wait (timeout 400 ms) and reports the CPU time it burned. With the fix the waiter sleeps
 * (`Atomics.wait`) and uses a few ms of CPU; before it, it spins at ~100% of a core for the whole wait.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LIB = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'infra-blocked.mjs');

export default {
  id: 'infra-lock-waiter-busy-spins',
  title: 'withInfraLock waiters busy-spun while waiting for a held lock, starving the holder on a loaded runner '
    + 'until the wait budget expired (red main @ 7974d7119)',
  card: 'main-fix-7974d7119',
  fixedBy: {
    sha: 'main-fix-7974d7119',
    where: 'lane/main-fix-7974d7119',
    paths: ['scripts/conveyor/infra-blocked.mjs'],
  },
  fixPresent(root) {
    const p = join(root, 'scripts/conveyor/infra-blocked.mjs');
    return existsSync(p) && /Atomics\.wait\(lockWaitCell/.test(readFileSync(p, 'utf8'));
  },
  async run({ log } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'soak-infra-lock-'));
    try {
      const store = join(dir, '.conveyor', 'store.json');
      mkdirSync(join(dir, '.conveyor'), { recursive: true });
      writeFileSync(`${store}.lock`, String(process.pid)); // a fresh lock another process holds for the whole wait
      const code = `import { withInfraLock } from ${JSON.stringify(pathToFileURL(LIB).href)};
        const c0 = process.cpuUsage(); const t0 = Date.now(); let threw = false;
        try { withInfraLock(${JSON.stringify(store)}, () => 1, { requireLock: true, timeoutMs: 400, staleMs: 60000 }); } catch { threw = true; }
        const u = process.cpuUsage(c0);
        console.log(JSON.stringify({ wallMs: Date.now() - t0, cpuMs: (u.user + u.system) / 1000, threw }));`;
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 60_000 });
      let out = null;
      try { out = JSON.parse(String(r.stdout || '').trim().split('\n').pop()); } catch { /* reported below */ }
      log?.(`waiter exit=${r.status} out=${JSON.stringify(out)}`);
      const violations = [];
      if (!out) violations.push({ invariant: 'waiter-reports', detail: `waiter printed no JSON (exit ${r.status}): ${String(r.stderr || '').slice(0, 300)}` });
      else if (out.cpuMs > out.wallMs * 0.1) violations.push({ invariant: 'waiter-sleeps', detail: `the waiter burned ${out.cpuMs.toFixed(0)} ms of CPU in a ${out.wallMs} ms wait — it busy-spins instead of sleeping` });
      return { violations };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  judge(report) {
    return report.violations.map((v) => `[${v.invariant}] ${v.detail}`);
  },
};
