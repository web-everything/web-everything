/** PR #5809: a repair overlay unlocks a moving tip; prototype-named pins notify only once. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runSoak } from '../soak.mjs';

export default {
  id: 'overlay-admission-repair-pin',
  title: 'repair admission retries the full stack and __proto__ pin notices deduplicate',
  card: 'PR #5809',
  fixedBy: {
    sha: '5809-admission-repair-pin', where: 'lane/overlay-pin',
    paths: ['scripts/lib/daemon-rebuild/preview.mjs', 'scripts/lib/daemon-rebuild/prepare.mjs'],
  },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/lib/daemon-rebuild/preview.mjs'), 'utf8').includes('const planCandidate =')
      && readFileSync(join(root, 'scripts/lib/daemon-rebuild/prepare.mjs'), 'utf8').includes('const pinnedNow = Object.create(null)');
  },
  run({ log } = {}) {
    return runSoak({
      name: 'break:overlay-admission-repair-pin', rounds: 1, daemons: [], fleet: false,
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
        const { addOverlay } = await load('scripts/lib/daemon-overlays.mjs');
        const { guardedRegister } = await load('scripts/lib/daemon-load-overlay.mjs');
        const branch = (ref, from, files) => w.git.createBranch('we', ref, { from, files });
        const logs = [];
        const rebuild = () => rebuildClone({
          root: w.simCloneRoot, env: w.env, prState: async () => 'OPEN',
          log: { error: message => logs.push(message) },
          runSmoke: async () => ({ verdict: 'pass', smoke: { results: [{ name: 'sim-smoke', ok: true }] } }),
        });
        const m0 = api.moveMain(w, { 'shared.txt': 'base\n', 'a.txt': 'base\n' }, 'soak: M0');
        const a0 = branch('__proto__', m0, { 'a.txt': 'old-A\n' });
        addOverlay(w.simCloneRoot, { ref: '__proto__' }, { env: w.env });
        if (!(await rebuild()).adopted) throw new Error('A0 must be adopted');
        const m1 = api.moveMain(w, { 'shared.txt': 'main\n' }, 'soak: M1');
        const a1 = branch('__proto__', a0, { 'shared.txt': 'new-A\n', 'a.txt': 'new-A\n' });
        for (let i = 0; i < 3; i++) await rebuild();
        const notices = logs.filter(message => message.startsWith('daemon-rebuild: overlay-pinned '));
        if (notices.length !== 1) api.violation('pin-notice-repeated', `three ticks produced ${notices.length} notices`);
        const ref = 'lane/repair';
        const repair = branch(ref, m1, { 'shared.txt': 'base\n', 'a.txt': 'new-A\n', 'repair.txt': 'R\n' });
        const live = await dryRunRebuild({
          root: w.simCloneRoot, env: w.env, prState: async () => 'OPEN', extraOverlays: [{ ref }],
        });
        if (!live.plan.ok || live.plan.establishedLost.length
          || !live.plan.applied.some(o => o.ref === ref)) throw new Error('full plan must accept repair');
        const result = await guardedRegister({
          root: w.simCloneRoot, ref, pr: null, env: w.env, gate: {},
          register: () => addOverlay(w.simCloneRoot, { ref }, { env: w.env }),
        });
        api.say(`repair registered=${result.registered}; pin notices=${notices.length}`);
        if (!result.registered) {
          api.violation('repair-refused', result.reason);
          return;
        }
        if (!(await rebuild()).adopted) api.violation('repair-not-adopted', 'repair rebuild did not adopt');
        const state = readRebuildState(w.simCloneRoot, w.env);
        for (const [expectedRef, sha] of [['__proto__', a1], [ref, repair]]) {
          if (!state.adopted?.applied.some(o => o.ref === expectedRef && o.sha === sha)) {
            api.violation('overlay-missing', `${expectedRef} did not advance`);
          }
        }
        if (state.pinnedNotified != null) api.violation('pin-not-cleared', 'repair must clear the pin notice');
      },
    });
  },
  judge(report) {
    return report.violations.map(row => `[${row.invariant}] ${row.detail}`);
  },
};
