/** PR #5809: one unretryable pin must not veto another pin's repair of a carried overlay. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { runSoak } from '../soak.mjs';

export default {
  id: 'overlay-pin-partial-retry',
  title: 'retry A after repair R while B stays pinned, allowing carried C to adopt instead of holding the clone',
  card: 'PR #5809',
  fixedBy: { sha: '5809-partial-pin-retry', where: 'lane/overlay-pin', paths: ['scripts/lib/daemon-rebuild/plan.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/lib/daemon-rebuild/plan.mjs'), 'utf8').includes('function* retryPinGroups()');
  },
  run({ log } = {}) {
    return runSoak({
      name: 'break:overlay-pin-partial-retry', rounds: 1, daemons: [], fleet: false,
      mainEvery: 0, scorecards: false, log,
      setup(w) {
        w.env.WE_DAEMON_CLONE_LOCK_ROOT = join(w.root, 'clone-lock');
        w.env.WE_DAEMON_OVERLAY_DIR = join(w.root, 'daemon-overlays');
        w.env.WE_DAEMON_REBUILD_SKIP_UNRELATED = '0';
        w.env.WE_DAEMON_OVERLAY_EDGE_RESOLVE = '0';
        w.env.WE_DAEMON_OVERLAY_STACK_MODE = 'tops';
      },
      async perRound(w, round, ctx, api) {
        const load = relative => import(pathToFileURL(join(w.simCloneRoot, relative)).href);
        const { rebuildClone, readRebuildState } = await load('scripts/lib/daemon-rebuild.mjs');
        const { addOverlay, readOverlays } = await load('scripts/lib/daemon-overlays.mjs');
        const git = args => execFileSync('git', args, { cwd: w.simCloneRoot, encoding: 'utf8', timeout: 20_000 }).trim();
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
        const base = api.moveMain(w, { 'shared.txt': 'base\n', 'blocked.txt': 'base\n', 'c.txt': 'base\n' }, 'soak: seed moving overlays');
        const a0 = branch('a', base, { 'a.txt': 'old-A\n' });
        const b0 = branch('b', base, { 'b.txt': 'B\n' });
        const c0 = branch('c', base, { 'c.txt': 'old-C\n' });
        for (const name of ['a', 'b', 'c']) register(name);
        const seeded = await rebuild();
        if (!seeded.adopted) throw new Error(`seed overlays not adopted: ${seeded.reason}`);
        const main = api.moveMain(w, { 'shared.txt': 'main\n', 'blocked.txt': 'main\n', 'c.txt': 'main-C\n' }, 'soak: main conflicts with moving tips');
        const a1 = branch('a', a0, { 'shared.txt': 'new-A\n', 'a.txt': 'new-A\n' });
        const b1 = branch('b', b0, { 'blocked.txt': 'new-B\n' });
        const c1 = branch('c', c0, { 'c.txt': 'main-C\n', 'a.txt': 'new-A\n', 'c-extra.txt': 'C\n' });
        const repair = branch('repair', main, { 'shared.txt': 'base\n', 'repair.txt': 'R\n' });
        register('repair');
        const result = await rebuild();
        api.say(`mixed-pin rebuild: adopted=${result.adopted}, reason=${result.reason}, smokes=${smokes}`);
        if (!result.adopted) api.violation('mixed-pin-hold', `${result.reason}: ${JSON.stringify(result.alerts)}`);
        const head = git(['rev-parse', 'HEAD']);
        for (const sha of [a1, b0, c1, repair]) {
          try { git(['merge-base', '--is-ancestor', sha, head]); }
          catch { api.violation('overlay-missing', `required head ${sha} absent from ${head}`); }
        }
        const pinned = readRebuildState(w.simCloneRoot, w.env).adopted?.applied?.find(row => row.ref === 'lane/b');
        if (pinned?.sha !== b0 || pinned?.pinnedFrom !== b1) api.violation('pin-lost', 'B must remain at its adopted head');
        if (smokes !== 2) api.violation('smoke-bypassed', `expected two smoked builds, got ${smokes}`);
        if (readOverlays(w.simCloneRoot, { env: w.env }).length !== 4) api.violation('registration-lost', 'all four overlays must stay registered');
      },
    });
  },
  judge(report) {
    return report.violations.map(row => `[${row.invariant}] ${row.detail}`);
  },
};
