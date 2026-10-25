/** PR #5937: containment must not move a clean base behind its conflicting top. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { runSoak } from '../soak.mjs';

export default {
  id: 'pinned-stack-clean-base-order',
  title: 'a clean pinned base enables its pinned top after main reverts their newer merge base',
  card: 'PR #5937 / x1b8hlo',
  fixedBy: { sha: '5937-conflict-only-deferral', where: 'lane/rebuild-contained-base-after-top', paths: ['scripts/lib/daemon-rebuild/plan.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/lib/daemon-rebuild/plan.mjs'), 'utf8').includes('const deferredContainers = new Map();');
  },
  run({ log } = {}) {
    return runSoak({
      name: 'break:pinned-stack-clean-base-order', rounds: 1, daemons: [], fleet: false,
      mainEvery: 0, scorecards: false, log,
      setup(w) {
        w.env.WE_DAEMON_CLONE_LOCK_ROOT = join(w.root, 'clone-lock');
        w.env.WE_DAEMON_OVERLAY_DIR = join(w.root, 'daemon-overlays');
        w.env.WE_DAEMON_REBUILD_SKIP_UNRELATED = '0';
        w.env.WE_DAEMON_OVERLAY_EDGE_RESOLVE = '0';
        w.env.WE_DAEMON_OVERLAY_STACK_MODE = 'tops';
        w.env.WE_DAEMON_AUTO_REBASE = '0';
      },
      async perRound(w, round, ctx, api) {
        const load = relative => import(pathToFileURL(join(w.simCloneRoot, relative)).href);
        const { rebuildClone } = await load('scripts/lib/daemon-rebuild.mjs');
        const { addOverlay, readOverlays } = await load('scripts/lib/daemon-overlays.mjs');
        const git = (cwd, args) => execFileSync('git', [
          '-c', 'user.name=Soak', '-c', 'user.email=soak@example.com', ...args,
        ], { cwd, encoding: 'utf8', timeout: 20_000, maxBuffer: 16 * 1024 * 1024 }).trim();
        const branch = (name, from, files) => w.git.createBranch('we', `lane/${name}`, { from, files });
        let smokes = 0;
        const rebuild = () => rebuildClone({
          root: w.simCloneRoot, env: w.env, prState: async () => 'OPEN',
          runSmoke: async () => {
            smokes++;
            return { verdict: 'pass', smoke: { results: [{ name: 'sim-smoke', ok: true }] } };
          },
        });
        const a = api.moveMain(w, { 'f.txt': '0\n', 'g.txt': '0\n' }, 'soak: A');
        const b = branch('base', a, { 'f.txt': '1\n' });
        addOverlay(w.simCloneRoot, { ref: 'lane/base', pinned: true }, { env: w.env });
        const seeded = await rebuild();
        if (!seeded.adopted) throw new Error(`base not adopted: ${seeded.reason}`);
        const p = api.moveMain(w, { 'f.txt': '2\n' }, 'soak: P');
        api.moveMain(w, { 'f.txt': '0\n' }, 'soak: M reverts P');
        // T has the exact tree of the conflict resolution and both B and P as parents.
        const source = branch('top-tree', b, { 'g.txt': '1\n' });
        const origin = w.repos.we.originPath;
        const tree = git(origin, ['rev-parse', `${source}^{tree}`]);
        const t = git(origin, ['commit-tree', tree, '-p', b, '-p', p, '-m', 'soak: T resolves B+P']);
        git(origin, ['update-ref', 'refs/heads/lane/top', t]);
        addOverlay(w.simCloneRoot, { ref: 'lane/top', pinned: true }, { env: w.env });
        const result = await rebuild();
        api.say(`clean pinned stack: adopted=${result.adopted}, reason=${result.reason}, smokes=${smokes}`);
        if (!result.adopted) api.violation('clean-stack-refused', `${result.reason}: ${JSON.stringify(result.alerts)}`);
        const head = git(w.simCloneRoot, ['rev-parse', 'HEAD']);
        for (const sha of [b, t]) {
          try { git(w.simCloneRoot, ['merge-base', '--is-ancestor', sha, head]); }
          catch { api.violation('overlay-missing', `required head ${sha} absent`); }
        }
        for (const file of ['f.txt', 'g.txt']) {
          if (git(w.simCloneRoot, ['show', `HEAD:${file}`]) !== '1') api.violation('content-missing', file);
        }
        if (smokes !== 2) api.violation('smoke-bypassed', `expected two smoked builds, got ${smokes}`);
        const registered = readOverlays(w.simCloneRoot, { env: w.env });
        if (registered.length !== 2 || registered.some(o => o.pinned !== true)) {
          api.violation('registration-lost', 'both explicit pins must stay registered');
        }
      },
    });
  },
  judge(report) {
    return report.violations.map(row => `[${row.invariant}] ${row.detail}`);
  },
};
