/** PR #6882: a successful boot rollback must retire the failed process before its first tick. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withSelfSync } from '../../../lib/daemon-self-sync.mjs';

export default {
  id: 'probation-boot-rollback-restart',
  title: 'boot rollback restarts before failed in-memory code can tick, without restart spacing',
  card: 'x1b8hlo / PR #6882 send-back item 1',
  fixedBy: { sha: 'HEAD', where: 'lane/blue-green-s2-probation-r928',
    paths: ['scripts/lib/daemon-self-sync.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/lib/daemon-self-sync.mjs'), 'utf8')
      .includes('if (rollback?.ok === true)');
  },
  async run({ log } = {}) {
    const base = mkdtempSync(join(tmpdir(), 'soak-boot-rollback-'));
    const violations = [];
    try {
      for (const mode of ['default', 'background', 'poc', 'versioned', 'already-restored']) {
        const clone = join(base, mode);
        const root = mode === 'versioned' ? join(clone, 'versions', 'failed') : clone;
        const restored = 'a'.repeat(40);
        let head = mode === 'already-restored' ? restored : 'b'.repeat(40);
        let rollbacks = 0, restarts = 0, ticks = 0, reads = 0, rebuilds = 0;
        const messages = [];
        let finishRollback;
        const pending = new Promise(resolve => { finishRollback = resolve; });
        const wrapped = withSelfSync({ tickOnce() {
          ticks++;
          // Count entry without hanging the harness: the production failed tick may never return.
          return 'failed-build-ticked';
        } }, {
          root, env: { WE_DAEMON_STATE_DIR: join(base, 'state'), WE_DAEMON_CLONE_LOCK_ROOT: join(base, 'locks') },
          now: () => 1000, readHead: () => head, log: { error: message => messages.push(message) },
          background: mode === 'background' ? { enabled: true, swapMinIntervalMs: 600_000 } : false,
          versions: mode === 'versioned' ? { clone, dir: clone, home: base, settings: {} } : null,
          pocBranch: mode === 'poc' ? 'poc/recovery' : undefined,
          versionApi: {
            currentVersion: () => ({ id: 'restored', dir: join(clone, 'versions', 'restored'), sha: head }),
            pin: async () => ({ status: 'pinned' }), unpin() {},
          },
          readReady: () => null, readState: () => ({ adopted: null }),
          importClosure: () => ({ complete: true, files: new Set(['scripts/worker.mjs']), bareDeps: false, jsonNames: new Set() }),
          diffFiles: () => ['scripts/worker.mjs'],
          rebuild: async () => { rebuilds++; return { moved: false, reason: 'still-rejected' }; },
          syncPoc: async () => { rebuilds++; return { merged: false, reason: 'up-to-date' }; },
          acquireRead: () => { reads++; return { ok: true }; }, releaseRead() {},
          applyPendingRollback: async () => {
            rollbacks++;
            await pending;
            head = restored;
            return { ok: true, head };
          },
          onRestart: info => {
            restarts++;
            if (info.head !== restored) violations.push(`${mode}: restart lost the rollback target`);
            return 'restarted';
          },
        });
        // Both entries must wait for the same boot hook; neither may reach failed code afterwards.
        const first = wrapped.tickOnce(), second = wrapped.tickOnce();
        if (ticks || restarts || reads || rebuilds) violations.push(`${mode}: work ran before rollback completed`);
        finishRollback();
        const results = await Promise.all([first, second]);
        if (results.some(result => result !== 'restarted') || rollbacks !== 1 || restarts !== 2
          || ticks || reads || rebuilds) {
          violations.push(`${mode}: rollbacks=${rollbacks}, restarts=${restarts}, ticks=${ticks}, reads=${reads}, rebuilds=${rebuilds}`);
        }
        log?.(`${mode}: rollback=${rollbacks}, restarts=${restarts}, failed ticks=${ticks}`);
        if (ticks) for (const message of messages.filter(message => message.includes('restart deferred'))) log?.(message);
      }
    } catch (error) { violations.push(error.message); }
    finally { rmSync(base, { recursive: true, force: true }); }
    return { violations };
  },
  judge: report => report.violations,
};
