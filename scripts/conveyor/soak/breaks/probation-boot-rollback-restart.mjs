/** PR #6882: a successful boot rollback must retire the failed process before its first tick. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withSelfSync } from '../../../lib/daemon-self-sync.mjs';
import { applyPendingRollback } from '../../../lib/daemon-rebuild/probation.mjs';
import { cloneKeyOf } from '../../../lib/daemon-last-good.mjs';
import { readRebuildState, writeRebuildState } from '../../../lib/daemon-rebuild/state.mjs';

export default {
  id: 'probation-boot-rollback-restart',
  title: 'boot rollback restarts before failed in-memory code can tick, without restart spacing',
  card: 'x1b8hlo / PR #6882 send-back item 1',
  fixedBy: { sha: 'HEAD', where: 'lane/blue-green-s2-probation-r928',
    paths: ['scripts/lib/daemon-self-sync.mjs', 'scripts/lib/daemon-rebuild/probation.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/lib/daemon-self-sync.mjs'), 'utf8')
      .includes('rollback?.restartRequired === true')
      && readFileSync(join(root, 'scripts/lib/daemon-rebuild/probation.mjs'), 'utf8').includes('rollback-request-changed');
  },
  async run({ log, phases = ['before-hook', 'under-lock', 'replacement-under-lock', 'superseded-under-lock'] } = {}) {
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
      // Exercise the production boot hook and clone lock, with only Git IO
      // injected. A sibling completes between the loaded-head snapshot and the
      // hook, or between its marker snapshot and its locked re-read.
      for (const phase of phases) {
        const root = join(base, phase);
        const env = { WE_DAEMON_STATE_DIR: join(root, 'state'), WE_DAEMON_CLONE_LOCK_ROOT: join(root, 'locks') };
        mkdirSync(env.WE_DAEMON_STATE_DIR, { recursive: true });
        const marker = join(env.WE_DAEMON_STATE_DIR, `${cloneKeyOf(root)}.rollback-requested.json`);
        const failed = 'b'.repeat(40), restored = 'a'.repeat(40), newer = 'c'.repeat(40);
        const record = { from: failed, to: restored, inputsKey: 'good', mainSha: restored, applied: [],
          rejectInputsKey: 'failed', reason: 'no-tick-progress', at: new Date(1000).toISOString() };
        writeFileSync(marker, JSON.stringify(record));
        writeRebuildState(root, { adopted: { head: failed }, rejected: null }, env);
        let head = failed, completed = false, ticks = 0, restarts = 0, reads = 0, rebuilds = 0;
        const siblingCompletes = () => {
          if (completed) return;
          completed = true;
          head = phase === 'superseded-under-lock' ? newer : restored;
          writeRebuildState(root, { adopted: { head }, rejected: { inputsKey: 'sibling-rejection' } }, env);
          if (phase === 'replacement-under-lock') writeFileSync(marker, JSON.stringify({ ...record, from: restored, to: newer }));
          else if (phase !== 'superseded-under-lock') unlinkSync(marker);
        };
        const wrapped = withSelfSync({ tickOnce() { ticks++; return 'failed-build-ticked'; } }, {
          root, env, now: () => 1000, readHead: () => head, log: { error() {} }, versions: null,
          background: phase === 'superseded-under-lock' ? { enabled: true, swapMinIntervalMs: 600_000 } : false,
          readState: () => ({ adopted: null }),
          importClosure: () => ({ complete: true, files: new Set(['scripts/worker.mjs']), bareDeps: false, jsonNames: new Set() }),
          diffFiles: () => ['scripts/worker.mjs'],
          rebuild: async () => { rebuilds++; return { moved: false, reason: 'still-rejected' }; },
          acquireRead: () => { reads++; return { ok: true }; }, releaseRead() {},
          applyPendingRollback: opts => applyPendingRollback({ ...opts, emit() {}, run: args => {
            if (args[0] !== 'rev-parse' || args.at(-1) !== 'HEAD') throw new Error(`Unexpected Git: ${args[0]}`);
            siblingCompletes();
            return { status: 0, stdout: head };
          } }),
          onRestart() { restarts++; return 'restarted'; },
        });
        if (phase === 'before-hook') siblingCompletes();
        const result = await wrapped.tickOnce();
        if (result !== 'restarted' || restarts !== 1 || ticks || reads || rebuilds) {
          violations.push(`${phase}: result=${result}, restarts=${restarts}, ticks=${ticks}, reads=${reads}, rebuilds=${rebuilds}`);
        }
        if (readRebuildState(root, env).rejected?.inputsKey !== 'sibling-rejection') violations.push(`${phase}: stale caller overwrote recovery state`);
        if (phase === 'replacement-under-lock' && (!existsSync(marker) || JSON.parse(readFileSync(marker)).to !== newer)) {
          violations.push(`${phase}: stale caller removed the replacement marker`);
        }
        if (phase === 'superseded-under-lock') {
          if (head !== newer || readRebuildState(root, env).adopted?.head !== newer) violations.push(`${phase}: newer adoption was overwritten`);
          if (existsSync(marker)) violations.push(`${phase}: superseded marker was not removed`);
        }
        log?.(`${phase}: restarts=${restarts}, failed ticks=${ticks}`);
      }
    } catch (error) { violations.push(error.message); }
    finally { rmSync(base, { recursive: true, force: true }); }
    return { violations };
  },
  judge: report => report.violations,
};
