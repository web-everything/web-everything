/** PR #6084: settlement and the following tick must agree on the identity allowed to roll back. */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { runSoak } from '../soak.mjs';

export default {
  id: 'quick-soak-recovery-replacement-head',
  title: 'Quick-soak recovery preserves a replacement HEAD and the original marker or quarantine',
  card: 'PR #6084',
  fixedBy: { sha: '1195bffdd76d6eaec2774687ad82062e08617db2', where: 'lane/daemon-rebuild-quick-mode', paths: [
    'scripts/lib/daemon-rebuild/prepare.mjs', 'scripts/lib/daemon-rebuild/quick-soak-job.mjs',
  ] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/lib/daemon-rebuild/prepare.mjs'), 'utf8')
      .includes('if (!assertMarkerIdentity(readRebuildState(root, stEnv), { token: quarantine.token, sha: quarantine.failedHead,');
  },
  run({ log } = {}) {
    return runSoak({
      name: 'break:quick-soak-recovery-replacement-head', rounds: 1, daemons: [], fleet: false,
      mainEvery: 0, scorecards: false, log,
      setup(w) {
        w.env.WE_DAEMON_STATE_DIR = join(w.root, 'quick-state');
        w.env.WE_DAEMON_JOBS_ROOT = join(w.root, 'quick-jobs');
        w.env.WE_DAEMON_OVERLAY_DIR = join(w.root, 'quick-overlays');
        w.env.WE_DAEMON_CLONE_LOCK_ROOT = join(w.root, 'quick-locks');
        w.env.WE_DAEMON_AUTO_REBASE = '0';
      },
      async perRound(w, _round, _ctx, api) {
        const root = w.simCloneRoot;
        const load = file => import(pathToFileURL(join(root, file)).href);
        const { writeRebuildState, readRebuildState } = await load('scripts/lib/daemon-rebuild/state.mjs');
        const { settleQuickSoak } = await load('scripts/lib/daemon-rebuild/quick-soak-job.mjs');
        const { prepareRebuild } = await load('scripts/lib/daemon-rebuild/prepare.mjs');
        const { withWriteLock } = await load('scripts/lib/daemon-clone-lock.mjs');
        const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 20_000,
          maxBuffer: 1024 * 1024 }).trim();
        const prevHead = git(['rev-parse', 'HEAD']);
        const failed = api.moveMain(w, { 'quick-recovery.txt': 'failed adoption\n' }, 'soak: quick adoption');
        git(['fetch', '--quiet', 'origin', 'main']);
        const replacement = api.moveMain(w, { 'quick-recovery.txt': 'operator replacement\n' }, 'soak: replacement');
        git(['fetch', '--quiet', 'origin', 'main']);
        git(['reset', '--hard', replacement]);
        const marker = { quick: true, sha: failed, head: failed, prevHead, token: 'soak-replacement',
          soakAttempts: 3, lastGood: { head: prevHead } };
        const run = (args, opts) => spawnSync('git', args, { encoding: 'utf8', maxBuffer: 1024 * 1024, ...opts });
        for (const phase of ['unverified', 'quarantine']) {
          writeRebuildState(root, phase === 'unverified'
            ? { unverified: marker, adopted: { head: failed, unverified: true } }
            : { quarantine: { token: marker.token, failedHead: failed, prevHead, reason: 'quick-soak-rollback-failed' },
              adopted: marker.lastGood }, w.env);
          const expected = readRebuildState(root, w.env);
          const messages = [];
          const log = { error: message => messages.push(message) };
          const locked = await withWriteLock(root, async () => {
            if (phase === 'unverified') {
              settleQuickSoak({ root, env: w.env, marker, outcome: 'failed', log });
              if (!isDeepStrictEqual(readRebuildState(root, w.env), expected)) {
                api.violation('settlement-state-changed', 'stale settlement must preserve the original marker');
              }
              if (git(['rev-parse', 'HEAD']) !== replacement) api.violation('settlement-reset', 'settlement displaced replacement');
            }
            return prepareRebuild({ root, env: w.env, run, stateOpts: {}, now: Date.now, log });
          }, { lockRoot: w.env.WE_DAEMON_CLONE_LOCK_ROOT });
          if (!locked.ok) throw new Error('could not acquire recovery write lock');
          const result = locked.value;
          if (git(['rev-parse', 'HEAD']) !== replacement) api.violation('recovery-reset', `${phase}: next tick displaced replacement`);
          if (!isDeepStrictEqual(readRebuildState(root, w.env), expected)) {
            api.violation('recovery-state-changed', `${phase}: identity mismatch must preserve all clone state`);
          }
          const reason = phase === 'unverified' ? 'rebuild-in-progress' : 'quarantined';
          if (result.result?.reason !== reason || !messages.some(message => message.includes('marker-identity-mismatch'))) {
            api.violation('recovery-not-deferred', `${phase}: mismatch must be logged and deferred`);
          }
          api.say(`quick recovery (${phase}): ${result.result?.reason}, replacement preserved=${git(['rev-parse', 'HEAD']) === replacement}`);
        }
      },
    });
  },
  judge(report) { return report.violations.map(row => `[${row.invariant}] ${row.detail}`); },
};
