/** PR #5809: a temporary pin must not bypass retries when explicit P refuses the partial stack. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { runSoak } from '../soak.mjs';

export default {
  id: 'overlay-pin-refusal-retry',
  title: 'A,P,R retries a temporary pin-induced refusal while retaining explicit P',
  card: 'PR #5809',
  fixedBy: { sha: '5809-pin-refusal-retry', where: 'lane/overlay-pin', paths: ['scripts/lib/daemon-rebuild/plan.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/lib/daemon-rebuild/plan.mjs'), 'utf8')
      .includes('if (refused) return retryPins(refused);');
  },
  run({ log } = {}) {
    return runSoak({
      name: 'break:overlay-pin-refusal-retry', rounds: 1, daemons: [], fleet: false,
      mainEvery: 0, scorecards: false, log,
      setup(w) {
        w.env.WE_DAEMON_CLONE_LOCK_ROOT = join(w.root, 'clone-lock');
        w.env.WE_DAEMON_OVERLAY_DIR = join(w.root, 'daemon-overlays');
        w.env.WE_DAEMON_REBUILD_SKIP_UNRELATED = '0';
        w.env.WE_DAEMON_OVERLAY_EDGE_RESOLVE = '0';
        w.env.WE_DAEMON_OVERLAY_STACK_MODE = 'independent';
      },
      async perRound(w, round, ctx, api) {
        const load = relative => import(pathToFileURL(join(w.simCloneRoot, relative)).href);
        const { rebuildClone } = await load('scripts/lib/daemon-rebuild.mjs');
        const { addOverlay, readOverlays } = await load('scripts/lib/daemon-overlays.mjs');
        const git = args => execFileSync('git', args, {
          cwd: w.simCloneRoot, encoding: 'utf8', timeout: 20_000,
        }).trim();
        const branch = (name, from, files) => w.git.createBranch('we', `lane/${name}`, { from, files });
        const register = (name, pinned = false) => addOverlay(w.simCloneRoot, { ref: `lane/${name}`, pinned }, { env: w.env });
        let smokes = 0;
        const rebuild = () => rebuildClone({
          root: w.simCloneRoot, env: w.env, prState: async () => 'OPEN',
          runSmoke: async () => {
            smokes++;
            return { verdict: 'pass', smoke: { results: [{ name: 'sim-smoke', ok: true }] } };
          },
        });
        const base = api.moveMain(w, { 'a.txt': 'BASE\n', 'p.txt': 'BASE\n', 'shared.txt': 'BASE\n' }, 'soak: seed A,P');
        const a0 = branch('a', base, { 'a.txt': 'OLD-A\n' });
        const p0 = branch('p', base, { 'p.txt': 'OLD-P\n' });
        register('a');
        register('p', true);
        const seeded = await rebuild();
        if (!seeded.adopted) throw new Error(`seed overlays not adopted: ${seeded.reason}`);
        const main = api.moveMain(w, { 'p.txt': 'MAIN\n', 'shared.txt': 'MAIN\n' }, 'soak: main moves');
        const a1 = branch('a', a0, { 'a.txt': 'NEW-A\n', 'shared.txt': 'NEW-A\n' });
        const p1 = branch('p', p0, { 'p.txt': 'MAIN\n', 'a.txt': 'NEW-A\n' });
        const repair = branch('repair', main, { 'shared.txt': 'BASE\n' });
        register('repair');

        const result = await rebuild();
        api.say(`pin-refusal retry: adopted=${result.adopted}, reason=${result.reason}, smokes=${smokes}`);
        if (!result.adopted) api.violation('pin-refusal-hold', `${result.reason}: ${JSON.stringify(result.alerts)}`);
        const head = git(['rev-parse', 'HEAD']);
        for (const sha of [a0, p0, a1, p1, repair]) {
          try { git(['merge-base', '--is-ancestor', sha, head]); }
          catch { api.violation('overlay-missing', `required head ${sha} absent from ${head}`); }
        }
        if (smokes !== 2) api.violation('smoke-bypassed', `expected two smoked builds, got ${smokes}`);
        const registered = readOverlays(w.simCloneRoot, { env: w.env });
        if (registered.length !== 3 || !registered.some(o => o.ref === 'lane/p' && o.pinned === true)) {
          api.violation('explicit-pin-lost', 'all overlays and the explicit P flag must stay registered');
        }
      },
    });
  },
  judge(report) {
    return report.violations.map(row => `[${row.invariant}] ${row.detail}`);
  },
};
