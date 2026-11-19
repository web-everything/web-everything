/**
 * @file breaks/rebuild-spawner-reader-wait.mjs — live break (thin split of #6044). The detached rebuild job is spawned by
 * a daemon tick that holds a clone READ lock for the whole job, and the job then waited the full lock budget for
 * that very read lock (its own spawner) before it could take the WRITE lock — so no review-clone rebuild ever
 * finished without a hand reader pause. The fix lets the ready-only job exclude exactly its spawner
 * (`ignoreOwners` on `acquireWrite`), while any OTHER live reader must still be waited for.
 *
 * Scenario: a real process holds a READ lock (the spawner). (1) A job process asks for the WRITE lock excluding
 * that spawner: it must succeed promptly. (2) A second real process holds a READ lock (a foreign reader); a job
 * process excluding only the spawner must still be refused with `tick-in-progress` naming the foreign reader.
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSoak } from '../soak.mjs';

const HOLDER = fileURLToPath(new URL('./fixtures/hold-clone-lock.mjs', import.meta.url));
const JOB = fileURLToPath(new URL('./fixtures/take-clone-write-lock.mjs', import.meta.url));
const HOLD_MS = 20_000;

async function waitForReady(path, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => { setTimeout(r, 50); });
  }
  return false;
}

export default {
  id: 'rebuild-spawner-reader-wait',
  title: 'a rebuild job waited for its own spawner\'s read lock before taking the write lock (or stopped waiting for a foreign live reader)',
  card: 'we:PR #6044 (thin split)',
  fixedBy: {
    sha: 'rebuild-spawner-reader-thin',
    where: 'lane/rebuild-spawner-reader-thin',
    paths: ['scripts/lib/daemon-clone-lock.mjs', 'scripts/lib/daemon-rebuild/rebuild.mjs'],
  },
  fixPresent(root) {
    try {
      return /ignoreOwners/.test(readFileSync(join(root, 'scripts/lib/daemon-clone-lock.mjs'), 'utf8'));
    } catch {
      return false;
    }
  },
  async run({ log } = {}) {
    const holders = [];
    try {
      return await runSoak({
        name: 'break:rebuild-spawner-reader-wait',
        rounds: 1,
        daemons: [],
        mainEvery: 0,
        fleet: false,
        log,
        setup(w) {
          w.env.WE_DAEMON_CLONE_LOCK_ROOT = join(w.root, 'clone-lock');
          return {};
        },
        async perRound(w, round, ctx, api) {
          if (round !== 0) return;
          const lockModulePath = join(w.simCloneRoot, 'scripts/lib/daemon-clone-lock.mjs');
          if (!existsSync(lockModulePath)) throw new Error('rebuild-spawner-reader-wait: requires scripts/lib/daemon-clone-lock.mjs');
          const lockRoot = w.env.WE_DAEMON_CLONE_LOCK_ROOT;
          const hold = async (name) => {
            const marker = join(w.root, `${name}-ready`);
            const p = spawn(process.execPath, [HOLDER, 'read', lockModulePath, w.simCloneRoot, String(HOLD_MS), marker, lockRoot], { env: w.env, stdio: 'ignore' });
            holders.push(p);
            if (!await waitForReady(marker)) throw new Error(`rebuild-spawner-reader-wait: ${name} did not take its read lock`);
            return p;
          };
          const job = (waitMs, ignore) => {
            const res = spawnSync(process.execPath, [JOB, lockModulePath, w.simCloneRoot, String(waitMs), ignore, lockRoot], { env: w.env, encoding: 'utf8', timeout: 30_000 });
            try { return JSON.parse((res.stdout || '').trim().split('\n').pop()); } catch { return { ok: false, reason: `unparsable: ${(res.stderr || '').trim()}`, heldBy: null, ms: 0 }; }
          };

          const spawner = await hold('spawner');
          const spawnerOwner = `${hostname()}:${spawner.pid}`;
          api.say(`r00 spawner (pid ${spawner.pid}) holds a READ lock; the job excludes only it`);
          const own = job(3000, spawnerOwner);
          api.say(`r00 job vs own spawner reader: ${JSON.stringify(own)}`);
          if (!own.ok) api.violation('job-waited-for-own-spawner', `the job could not take the write lock past its own spawner's read lock: ${JSON.stringify(own)}`);

          const foreign = await hold('foreign');
          const foreignOwner = `${hostname()}:${foreign.pid}`;
          const blocked = job(1500, spawnerOwner);
          api.say(`r00 job vs foreign reader: ${JSON.stringify(blocked)}`);
          if (blocked.ok || blocked.heldBy !== foreignOwner) {
            api.violation('job-skipped-foreign-reader', `a foreign live reader (${foreignOwner}) must still be waited for: ${JSON.stringify(blocked)}`);
          }
        },
      });
    } finally {
      for (const p of holders) { try { p.kill('SIGKILL'); } catch { /* best-effort */ } }
    }
  },
  judge(report) {
    return report.violations
      .filter((v) => ['job-waited-for-own-spawner', 'job-skipped-foreign-reader', 'crash'].includes(v.invariant))
      .map((v) => `${v.daemon ?? '-'} tick ${v.tick ?? '-'}: [${v.invariant}] ${v.detail}`);
  },
};
