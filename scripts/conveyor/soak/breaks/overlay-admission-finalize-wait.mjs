/** #5938 / PR #5381: a late explicit load must not discard a passed smoke while readers drain. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

export default {
  id: 'overlay-admission-finalize-wait',
  title: 'an explicit overlay load preserves the finalize wait after its admission budget shrinks',
  card: 'we:backlog/5938 / PR #5381',
  fixedBy: { sha: 'PR #5381 repair', where: 'lane/5938', paths: ['scripts/lib/daemon-load-overlay.mjs', 'scripts/lib/daemon-rebuild/rebuild.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/lib/daemon-load-overlay.mjs'), 'utf8').includes('admissionWaitMs: remainingMs');
  },
  async run() {
    const tree = process.env.SOAK_TREE_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
    const load = (file) => import(pathToFileURL(join(tree, 'scripts/lib', file)).href);
    // These modules share cycles through self-sync and overlays. Let the loader's graph finish
    // evaluating before importing its dependencies separately: concurrent roots can deadlock Vitest
    // on a cold soak worker (the unit suite has already imported the loader before running this).
    const { runDaemonLoadOverlay } = await load('daemon-load-overlay.mjs');
    const { rebuildClone } = await load('daemon-rebuild.mjs');
    const lock = await load('daemon-clone-lock.mjs');
    const { writeRebuildStarvation } = await load('daemon-rebuild/lease.mjs');
    const violations = [];
    for (const variant of [
      { name: 'first attempt', busy: 0, finalize: 180_000 },
      { name: 'late retry', busy: 2, finalize: 180_000 },
      { name: 'configured finalize', busy: 2, finalize: 1_000, configured: true },
      { name: 'starved finalize', busy: 2, finalize: 300_000, starved: true },
    ]) {
      const dir = mkdtempSync(join(tmpdir(), 'overlay-finalize-'));
      const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], {
        cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
      });
      try {
        git(dir, 'init', '-q', '-b', 'main', 'origin');
        const origin = join(dir, 'origin');
        writeFileSync(join(origin, 'main.txt'), 'main\n');
        git(origin, 'add', '.');
        git(origin, 'commit', '-qm', 'main');
        git(origin, 'checkout', '-qb', 'lane/overlay');
        writeFileSync(join(origin, 'overlay.txt'), 'overlay\n');
        git(origin, 'add', '.');
        git(origin, 'commit', '-qm', 'overlay');
        git(origin, 'checkout', '-q', 'main');
        git(dir, 'clone', '-q', 'origin', 'daemon');
        const root = join(dir, 'daemon');
        const env = {
          ...process.env, WE_DAEMON_STATE_DIR: join(dir, 'state'), WE_DAEMON_OVERLAY_DIR: join(dir, 'overlays'),
          WE_DAEMON_CLONE_LOCK_ROOT: join(dir, 'locks'), WE_DAEMON_REBUILD_LOCK_WAIT_MS: '600',
          WE_DAEMON_FINALIZE_LOCK_WAIT_MS: String(variant.configured ? variant.finalize : 180_000),
          WE_DAEMON_REBUILD_STARVED_WAIT_MS: '300000', WE_DAEMON_REBUILD_STARVE_ESCALATE_AFTER: '2',
        };
        if (variant.starved) writeRebuildStarvation(root, 2, env);
        let time = Date.now();
        let releaseAt = time + 50;
        const reader = { owner: 'sibling-tick', lockRoot: env.WE_DAEMON_CLONE_LOCK_ROOT };
        const startReader = () => {
          if (!lock.acquireRead(root, { ...reader, nowMs: time }).ok) throw new Error('reader fixture refused');
        };
        const waits = [];
        let attempts = 0;
        let smokes = 0;
        startReader();
        const result = await runDaemonLoadOverlay({
          clone: root, ref: 'lane/overlay', pr: 1, versions: null, env, log: { error() {} }, clock: () => time,
          settings: { noPr: 'allow', dispatchSmoke: 'off' },
          // This break exercises the rebuild finalize wait, not admission: register without add's conflict guard
          // (that guard is covered by daemon-load-overlay-guard.test.mjs and would make live gh reads here).
          admit: async ({ register }) => { register(null); return { registered: true }; },
          sleep: async (ms) => { time += ms; },
          rebuild: async (options) => {
            if (attempts++ < variant.busy) return { adopted: false, reason: 'rebuild-in-progress' };
            // Still have a live reader at prepare, even after busy retries.
            releaseAt = time + 50;
            return rebuildClone({
              ...options, versions: null, asJob: false, skipCheck: null, prState: async () => null,
              now: () => time,
              run: (args, opts) => {
                try { return { status: 0, stdout: git(opts.cwd, ...args) }; }
                catch (e) { return { status: e.status ?? 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') }; }
              },
              lockOpts: { ...options.lockOpts, pollMs: 50, onBlocked: ({ waitMs }) => waits.push(waitMs) },
              sleep: async (ms) => { time += ms; if (time >= releaseAt) lock.releaseRead(root, reader); },
              runSmoke: async () => {
                smokes++;
                startReader();
                releaseAt = time + 700; // outlast even the first attempt's 600ms admission budget
                return options.runSmoke({ root, env });
              },
            });
          },
          // Skip the smoke memoization write so the next lock is specifically finalize, not cache bookkeeping.
          baseSmoke: async () => ({ verdict: 'pass', cached: true, attempts: 1, smoke: { results: [] } }),
        });
        const expected = [600 - variant.busy * 250, variant.finalize];
        if (!result.adopted || smokes !== 1 || JSON.stringify(waits) !== JSON.stringify(expected)) {
          violations.push(`${variant.name}: adopted=${result.adopted}, smokes=${smokes}, waits=${JSON.stringify(waits)}, expected=${JSON.stringify(expected)}, reason=${result.reason}`);
        }
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};
