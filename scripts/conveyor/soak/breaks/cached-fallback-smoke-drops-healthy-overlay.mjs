/** @file PR #5456: a historical fallback proof must not hide a newly broken dispatch harness. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { runSoak } from '../soak.mjs';

export default {
  id: 'cached-fallback-smoke-drops-healthy-overlay',
  title: 'a cached fallback must reproduce a shared dispatch harness failure before healthy overlays are blamed',
  card: 'PR #5456',
  fixedBy: {
    sha: '5456-fresh-recovery-smoke', where: 'lane/smoke-reuse',
    paths: ['scripts/lib/daemon-rebuild/smoke.mjs'],
  },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/lib/daemon-rebuild/smoke.mjs'), 'utf8').includes('const freshComparison = label != null');
  },
  run({ log } = {}) {
    return runSoak({
      name: 'break:cached-fallback-smoke-drops-healthy-overlay',
      rounds: 1, daemons: [], fleet: false, mainEvery: 0, scorecards: false, log,
      setup(w) {
        w.env.WE_DAEMON_CLONE_LOCK_ROOT = join(w.root, 'clone-lock');
        w.env.WE_DAEMON_OVERLAY_DIR = join(w.root, 'daemon-overlays');
        w.env.WE_DAEMON_REBUILD_SKIP_UNRELATED = '0';
        w.env.WE_REBUILD_SMOKE_REUSE_ENABLED = '1';
        w.env.WE_REBUILD_SMOKE_REUSE_HOURS = '12';
      },
      async perRound(w, round, ctx, api) {
        const load = relative => import(pathToFileURL(join(w.simCloneRoot, relative)).href);
        const { rebuildClone, readRebuildState } = await load('scripts/lib/daemon-rebuild.mjs');
        const { addOverlay, readOverlays } = await load('scripts/lib/daemon-overlays.mjs');
        const { runLiveSmoke, SMOKE_CHECKS } = await load('scripts/lib/daemon-live-smoke.mjs');
        const git = args => execFileSync('git', args, { cwd: w.simCloneRoot, encoding: 'utf8', timeout: 20_000, maxBuffer: 16 * 1024 * 1024 }).trim();
        const base = git(['rev-parse', 'HEAD']);
        const rebuild = runSmoke => rebuildClone({ root: w.simCloneRoot, env: w.env,
          runSmoke, prState: async () => null,
          dispatchSmoke: { settings: { dispatchSmoke: 'off' }, run: async () => ({ ok: true }), match: () => [] },
        });
        api.moveMain(w, { 'scripts/conveyor/soak/fixtures/cached-fallback-main.mjs': 'export const moved = true;\n' }, 'soak: cache plain-main smoke');
        const seeded = await rebuild(async () => ({ verdict: 'pass', smoke: {
          results: SMOKE_CHECKS.map(({ name }) => ({ name, ok: true })),
        } }));
        if (!seeded.adopted || !readRebuildState(w.simCloneRoot, w.env).smokePassed?.length) {
          throw new Error('scenario did not establish a passing fallback proof');
        }
        // Only the simulator clone is reset; the cached fallback differs from the running last-good.
        git(['reset', '--hard', base]);
        w.git.createBranch('we', 'lane/healthy-smoke-overlay', {
          files: { 'soak/healthy-overlay.txt': 'healthy\n' },
        });
        addOverlay(w.simCloneRoot, { ref: 'lane/healthy-smoke-overlay' }, { env: w.env });
        const checks = [];
        const result = await rebuild(async options => {
          const smoke = await runLiveSmoke({ ...options, shadow: () => null, admit: () => null,
            runChild: async (cmd, args, opts) => {
              if (opts.env.GH_CALLER === 'rebuild-smoke:dispatch-dry-run') return 'malformed JSON';
              if (args[1] === 'list') return '[]';
              if (args[1] === 'acquire') return JSON.stringify({ lane: 2 });
              return cmd === 'node' ? JSON.stringify({ ok: true }) : '';
            },
          });
          checks.push({ options, smoke });
          return { verdict: smoke.pass ? 'pass' : 'code', smoke };
        });
        api.say(`rebuild reason=${result.reason}; smoke calls=${checks.length}; overlays=${readOverlays(w.simCloneRoot, { env: w.env }).map(row => row.ref).join(',')}`);
        if (result.reason !== 'harness-broken-adopted-not-worse') api.violation('wrong-recovery', result.reason);
        if (!readOverlays(w.simCloneRoot, { env: w.env }).some(row => row.ref === 'lane/healthy-smoke-overlay')) {
          api.violation('healthy-overlay-dropped', 'historical proof masked a shared harness failure');
        }
        if (checks.length !== 3 || checks.some(({ options, smoke }) => options.reuseCode
          || !smoke.results.some(row => row.name === 'dispatch-dry-run' && !row.ok && row.detail.includes('unparsable output'))
          || smoke.results.some(row => SMOKE_CHECKS.find(check => check.name === row.name)?.kind === 'env' && !row.ok))) {
          api.violation('missing-fresh-comparison', 'A, plain main and last-good must all reproduce malformed dispatch output with env checks passing');
        }
      },
    });
  },
  judge(report) {
    return report.violations.map(row => `[${row.invariant}] ${row.detail}`);
  },
};
