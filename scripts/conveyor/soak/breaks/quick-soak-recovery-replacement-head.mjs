/** PR #6084: settlement and the following tick must agree on the identity allowed to roll back. */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runSoak } from '../soak.mjs';

export default {
  id: 'quick-soak-recovery-replacement-head',
  title: 'Quick-soak recovery preserves a clean replacement HEAD and its quarantine',
  card: 'PR #6084',
  fixedBy: { sha: '6084-quick-recovery-identity', where: 'lane/daemon-rebuild-quick-mode', paths: [
    'scripts/lib/daemon-rebuild/prepare.mjs', 'scripts/lib/daemon-rebuild/quick-soak-job.mjs',
  ] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/lib/daemon-rebuild/prepare.mjs'), 'utf8')
      .includes('rollbackQuick(state.quarantine.prevHead, state.quarantine.failedHead)');
  },
  run({ log } = {}) {
    return runSoak({
      name: 'break:quick-soak-recovery-replacement-head', rounds: 1, daemons: [], fleet: false,
      mainEvery: 0, scorecards: false, log,
      setup(w) {
        w.env.WE_DAEMON_STATE_DIR = join(w.root, 'quick-state');
        w.env.WE_DAEMON_JOBS_ROOT = join(w.root, 'quick-jobs');
        w.env.WE_DAEMON_OVERLAY_DIR = join(w.root, 'quick-overlays');
        w.env.WE_DAEMON_AUTO_REBASE = '0';
      },
      async perRound(w, _round, _ctx, api) {
        const root = w.simCloneRoot;
        const load = file => import(pathToFileURL(join(root, file)).href);
        const { writeRebuildState, readRebuildState } = await load('scripts/lib/daemon-rebuild/state.mjs');
        const { settleQuickSoak } = await load('scripts/lib/daemon-rebuild/quick-soak-job.mjs');
        const { prepareRebuild } = await load('scripts/lib/daemon-rebuild/prepare.mjs');
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
        writeRebuildState(root, { unverified: marker, adopted: { head: failed, unverified: true } }, w.env);
        const silentLog = { error() {} };
        settleQuickSoak({ root, env: w.env, marker, outcome: 'failed', log: silentLog });
        if (git(['rev-parse', 'HEAD']) !== replacement) api.violation('settlement-reset', 'settlement displaced replacement');
        const run = (args, opts) => spawnSync('git', args, { encoding: 'utf8', ...opts, maxBuffer: 1024 * 1024 });
        const result = await prepareRebuild({ root, env: w.env, run, stateOpts: {}, now: Date.now, log: silentLog });
        const state = readRebuildState(root, w.env);
        if (git(['rev-parse', 'HEAD']) !== replacement) api.violation('recovery-reset', 'next tick displaced replacement');
        if (result.result?.reason !== 'quarantined' || !state.quarantine) {
          api.violation('quarantine-lost', 'replacement must remain quarantined for operator recovery');
        }
        api.say(`quick recovery: ${result.result?.reason}, replacement preserved=${git(['rev-parse', 'HEAD']) === replacement}`);
      },
    });
  },
  judge(report) { return report.violations.map(row => `[${row.invariant}] ${row.detail}`); },
};
