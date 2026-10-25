/** PR #5809: admission must use the same adopted head as the live overlay planner. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runSoak } from '../soak.mjs';

export default {
  id: 'overlay-admission-live-pin',
  title: 'a candidate compatible with established B is admitted while moving A stays pinned',
  card: 'PR #5809',
  fixedBy: { sha: '5809-admission-live-pin', where: 'lane/overlay-pin', paths: ['scripts/lib/daemon-rebuild/preview.mjs'] },
  fixPresent(root) {
    const source = readFileSync(join(root, 'scripts/lib/daemon-rebuild/preview.mjs'), 'utf8');
    return source.includes('headSha: head, mainRef:');
  },
  run({ log } = {}) {
    return runSoak({
      name: 'break:overlay-admission-live-pin', rounds: 1, daemons: [], fleet: false,
      mainEvery: 0, scorecards: false, log,
      setup(w) {
        w.env.WE_DAEMON_CLONE_LOCK_ROOT = join(w.root, 'clone-lock');
        w.env.WE_DAEMON_OVERLAY_DIR = join(w.root, 'daemon-overlays');
        w.env.WE_DAEMON_REBUILD_SKIP_UNRELATED = '0';
        w.env.WE_DAEMON_OVERLAY_EDGE_RESOLVE = '0';
        w.env.WE_DAEMON_OVERLAY_STACK_BASES = '{}';
      },
      async perRound(w, round, ctx, api) {
        const load = relative => import(pathToFileURL(join(w.simCloneRoot, relative)).href);
        const { rebuildClone, dryRunRebuild, readRebuildState } = await load('scripts/lib/daemon-rebuild.mjs');
        const { addOverlay, readOverlays } = await load('scripts/lib/daemon-overlays.mjs');
        const { guardedRegister } = await load('scripts/lib/daemon-load-overlay.mjs');
        const branch = (name, from, files) => w.git.createBranch('we', `lane/${name}`, { from, files });
        let smokes = 0;
        const rebuild = () => rebuildClone({
          root: w.simCloneRoot, env: w.env, prState: async () => 'OPEN',
          runSmoke: async () => {
            smokes++;
            return { verdict: 'pass', smoke: { results: [{ name: 'sim-smoke', ok: true }] } };
          },
        });
        const main = api.moveMain(w, { 'shared.txt': 'base\n' }, 'soak: seed admission conflict');
        const a0 = branch('a', main, { 'a.txt': 'A\n' });
        const b0 = branch('b', main, { 'shared.txt': 'B\n' });
        for (const ref of ['lane/a', 'lane/b']) addOverlay(w.simCloneRoot, { ref }, { env: w.env });
        const seeded = await rebuild();
        if (!seeded.adopted) throw new Error(`seed overlays not adopted: ${seeded.reason}`);
        const a1 = branch('a', a0, { 'shared.txt': 'A new\n' });
        const c0 = branch('c', main, { 'shared.txt': 'B\n', 'c.txt': 'C\n' });
        const live = await dryRunRebuild({
          root: w.simCloneRoot, env: w.env, prState: async () => 'OPEN', extraOverlays: [{ ref: 'lane/c' }],
        });
        if (!live.plan.ok || live.plan.establishedLost?.length
          || !live.plan.applied?.some(o => o.ref === 'lane/c')) {
          throw new Error('fixture must have a viable live plan for C');
        }
        const result = await guardedRegister({
          root: w.simCloneRoot, ref: 'lane/c', pr: null, env: w.env, gate: {},
          register: () => addOverlay(w.simCloneRoot, { ref: 'lane/c' }, { env: w.env }),
        });
        api.say(`live plan accepts C; guarded registration=${result.registered}, reason=${result.reason || 'clean'}`);
        if (!result.registered) {
          api.violation('compatible-overlay-refused', `C rejected against live pinned stack: ${result.reason}`);
          return;
        }
        const adopted = await rebuild();
        if (!adopted.adopted) api.violation('candidate-not-adopted', `C rebuild: ${adopted.reason}`);
        const applied = readRebuildState(w.simCloneRoot, w.env).adopted?.applied || [];
        for (const [ref, sha] of [['lane/a', a0], ['lane/b', b0], ['lane/c', c0]]) {
          if (!applied.some(o => o.ref === ref && o.sha === sha)) api.violation('overlay-missing', `${ref} missing adopted head`);
        }
        if (applied.find(o => o.ref === 'lane/a')?.pinnedFrom !== a1) api.violation('pin-lost', 'A must stay pinned');
        if (smokes !== 2) api.violation('smoke-bypassed', `expected two smokes, got ${smokes}`);
        if (readOverlays(w.simCloneRoot, { env: w.env }).length !== 3) api.violation('registration-lost', 'all overlays must remain registered');
      },
    });
  },
  judge(report) {
    return report.violations.map(row => `[${row.invariant}] ${row.detail}`);
  },
};
