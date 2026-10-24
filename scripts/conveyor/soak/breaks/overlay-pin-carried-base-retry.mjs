/** PR #5809: a retried top carries its base by ancestry, so a later repair must unlock adoption. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { runSoak } from '../soak.mjs';

export default {
  id: 'overlay-pin-carried-base-retry',
  title: 'B,A,C,R adopts the repair when the retried A tip carries B without an applied row',
  card: 'PR #5809',
  fixedBy: { sha: '5809-carried-base-retry', where: 'lane/overlay-pin', paths: ['scripts/lib/daemon-rebuild/plan.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/lib/daemon-rebuild/plan.mjs'), 'utf8')
      .includes("git(['merge-base', '--is-ancestor', a.sha, alt.finalSha]).status === 0");
  },
  run({ log } = {}) {
    return runSoak({
      name: 'break:overlay-pin-carried-base-retry', rounds: 1, daemons: [], fleet: false,
      mainEvery: 0, scorecards: false, log,
      setup(w) {
        w.env.WE_DAEMON_CLONE_LOCK_ROOT = join(w.root, 'clone-lock');
        w.env.WE_DAEMON_OVERLAY_DIR = join(w.root, 'daemon-overlays');
        w.env.WE_DAEMON_REBUILD_SKIP_UNRELATED = '0';
        w.env.WE_DAEMON_OVERLAY_EDGE_RESOLVE = '0';
        w.env.WE_DAEMON_OVERLAY_STACK_MODE = 'tops';
        w.env.WE_DAEMON_OVERLAY_STACK_BASES = '{}';
      },
      async perRound(w, round, ctx, api) {
        const load = relative => import(pathToFileURL(join(w.simCloneRoot, relative)).href);
        const { rebuildClone, readRebuildState } = await load('scripts/lib/daemon-rebuild.mjs');
        const { addOverlay, readOverlays } = await load('scripts/lib/daemon-overlays.mjs');
        const git = (cwd, args) => execFileSync('git', [
          '-c', 'user.name=Soak', '-c', 'user.email=soak@example.com', ...args,
        ], { cwd, encoding: 'utf8', timeout: 20_000, maxBuffer: 16 * 1024 * 1024 }).trim();
        const branch = (name, from, files) => w.git.createBranch('we', `lane/${name}`, { from, files });
        const register = name => addOverlay(w.simCloneRoot, { ref: `lane/${name}` }, { env: w.env });
        let smokes = 0;
        const rebuild = () => rebuildClone({
          root: w.simCloneRoot, env: w.env, prState: async () => 'OPEN',
          runSmoke: async () => {
            smokes++;
            return { verdict: 'pass', smoke: { results: [{ name: 'sim-smoke', ok: true }] } };
          },
        });
        const base = api.moveMain(w, { 'shared.txt': 'base\n', 'c.txt': 'base\n' }, 'soak: seed B,A,C');
        const b0 = branch('b', base, { 'b.txt': 'B\n' });
        const a0 = branch('a', base, { 'a.txt': 'old-A\n' });
        const c0 = branch('c', base, { 'c.txt': 'old-C\n' });
        for (const name of ['b', 'a', 'c']) register(name);
        const seeded = await rebuild();
        if (!seeded.adopted) throw new Error(`seed overlays not adopted: ${seeded.reason}`);
        const main = api.moveMain(w, { 'shared.txt': 'main\n', 'c.txt': 'main-C\n' }, 'soak: main moves');
        const origin = w.repos.we.originPath;
        // Seed the merge's exact tree, then give A1 both A0 and B0 as parents.
        const treeSource = branch('a-tree', a0, { 'b.txt': 'B\n', 'a.txt': 'new-A\n', 'shared.txt': 'new-A\n' });
        const tree = git(origin, ['rev-parse', `${treeSource}^{tree}`]);
        const a1 = git(origin, ['commit-tree', tree, '-p', a0, '-p', b0, '-m', 'soak: A1 merges A0+B0']);
        git(origin, ['update-ref', 'refs/heads/lane/a', a1, a0]);
        const c1 = branch('c', c0, { 'c.txt': 'main-C\n', 'a.txt': 'new-A\n' });
        const repair = branch('repair', main, { 'shared.txt': 'base\n', 'repair.txt': 'R\n' });
        register('repair');

        const result = await rebuild();
        api.say(`carried-base retry: adopted=${result.adopted}, reason=${result.reason}, smokes=${smokes}`);
        if (!result.adopted) api.violation('carried-base-hold', `${result.reason}: ${JSON.stringify(result.alerts)}`);
        const head = git(w.simCloneRoot, ['rev-parse', 'HEAD']);
        for (const sha of [b0, a1, c1, repair]) {
          try { git(w.simCloneRoot, ['merge-base', '--is-ancestor', sha, head]); }
          catch { api.violation('overlay-missing', `required head ${sha} absent from ${head}`); }
        }
        const adopted = readRebuildState(w.simCloneRoot, w.env).adopted;
        if (!adopted?.applied?.some(a => a.ref === 'lane/repair' && a.sha === repair)) {
          api.violation('repair-missing', 'R must be applied');
        }
        if (adopted?.applied?.some(a => a.ref === 'lane/b')) api.violation('fixture-not-stacked', 'B must be carried by A');
        if (result.alerts?.some(a => a.kind === 'established-overlay-hold')) api.violation('held', 'the repair must clear the hold');
        if (smokes !== 2) api.violation('smoke-bypassed', `expected two smoked builds, got ${smokes}`);
        if (readOverlays(w.simCloneRoot, { env: w.env }).length !== 4) api.violation('registration-lost', 'all four overlays must stay registered');
      },
    });
  },
  judge(report) {
    return report.violations.map(row => `[${row.invariant}] ${row.detail}`);
  },
};
