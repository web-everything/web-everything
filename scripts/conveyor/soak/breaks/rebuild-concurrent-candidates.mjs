/**
 * @file breaks/rebuild-concurrent-candidates.mjs — review finding on PR #2731 (card 4218, epic #4075/#3383).
 * Once the rebuild's live smoke moved OFF the write lock (`rebuild-smoke-off-lock.mjs`), nothing stopped two
 * sibling daemons sharing ONE clone (the review daemon and the fix-dispatch daemon both call `rebuildClone` at
 * the top of every tick) from running phase 2 — build + smoke a candidate — at the SAME time. Both used one fixed
 * per-clone candidate path, so the second `materializeCandidate` force-removed the first one's worktree while its
 * smoke was still reading it, and the first one's teardown then removed the second one's. A smoke that loses its
 * tree mid-run fails as `'code'`, and a `'code'` verdict poisons the reject-cache for a perfectly good build.
 * The old single-lock design could not do this: its whole rebuild ran inside one write lock.
 *
 * Fix: phase 1 claims a single-flight build lease (`state.building`) under the write lock, so a second rebuild
 * that arrives while one is smoking returns `rebuild-in-progress` at once instead of building its own candidate;
 * each attempt's candidate path is also unique, and the lease is released (and any rejection recorded) under the
 * write lock again.
 *
 * Scenario: advance main, then start TWO real `rebuildClone` calls on the same clone, the second one while the
 * first one's (injected, multi-second) smoke is in flight. Each smoke drops a marker file into its own candidate
 * at start and checks, at the end, that the marker and the candidate's `.git` are both still there — if its tree
 * was ripped out or swapped under it, it reports a `'code'` failure, exactly what a real check would do. FIXED:
 * no smoke loses its tree, no rejection is recorded, and the clone adopts the new main. PRE-fix: the first smoke
 * sees its marker gone and a spurious rejection is recorded.
 */

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runSoak } from '../soak.mjs';
import { rebuildMechanismSource } from '../rebuild-mechanism-source.mjs';

const SMOKE_MS = 2_500;

export default {
  id: 'rebuild-concurrent-candidates',
  title: 'two sibling daemons rebuilding one clone at once deleted each other\'s candidate worktree mid-smoke, so a good build was rejected',
  card: 'we:backlog/4218 (epic #4075/#3383) — PR #2731 review finding',
  fixedBy: {
    sha: '4218-daemon-rebuild-offlock-smoke',
    where: 'lane/4218-daemon-rebuild-offlock-smoke',
    paths: ['scripts/lib/daemon-rebuild.mjs'],
  },
  fixPresent(root) {
    try {
      return /rebuild-in-progress/.test(rebuildMechanismSource(root));
    } catch {
      return false;
    }
  },
  async run({ log } = {}) {
    return runSoak({
      name: 'break:rebuild-concurrent-candidates',
      rounds: 1,
      daemons: [],
      mainEvery: 0,
      fleet: false,
      log,
      setup(w) {
        w.env.WE_DAEMON_CLONE_LOCK_ROOT = join(w.root, 'clone-lock');
        return {};
      },
      async perRound(w, round, ctx, api) {
        if (round !== 0) return;
        const rebuildModulePath = join(w.simCloneRoot, 'scripts/lib/daemon-rebuild.mjs');
        if (!existsSync(rebuildModulePath)) throw new Error('rebuild-concurrent-candidates: scripts/lib/daemon-rebuild.mjs not present on this tree');
        const { rebuildClone, readRebuildState } = await import(pathToFileURL(rebuildModulePath).href);

        api.moveMain(w, { 'soak/rebuild-concurrent-candidates.md': '# advance main\n' }, 'soak: advance main for rebuild-concurrent-candidates');

        const started = [];
        const makeSmoke = (who) => async ({ root }) => {
          const marker = join(root, `.soak-smoke-${who}`);
          writeFileSync(marker, who);
          started.push(who);
          await new Promise((r) => { setTimeout(r, SMOKE_MS); });
          const intact = existsSync(marker) && existsSync(join(root, '.git'));
          if (!intact) {
            return { verdict: 'code', attempts: 1, smoke: { results: [{ name: 'sim-smoke', ok: false, detail: `${who}: candidate tree vanished mid-smoke` }] } };
          }
          return { verdict: 'pass', attempts: 1, smoke: { results: [{ name: 'sim-smoke', ok: true, ms: SMOKE_MS }] } };
        };

        const a = rebuildClone({ root: w.simCloneRoot, env: w.env, runSmoke: makeSmoke('A'), prState: async () => null });
        const deadline = Date.now() + 10_000;
        while (!started.includes('A') && Date.now() < deadline) await new Promise((r) => { setTimeout(r, 20); });
        if (!started.includes('A')) throw new Error('rebuild-concurrent-candidates: first smoke never started');
        const b = rebuildClone({ root: w.simCloneRoot, env: w.env, runSmoke: makeSmoke('B'), prState: async () => null });

        const [ra, rb] = await Promise.all([a, b]);
        api.say(`r00 A: moved=${ra.moved} adopted=${ra.adopted} reason=${ra.reason ?? ''}`);
        api.say(`r00 B: moved=${rb.moved} adopted=${rb.adopted} reason=${rb.reason ?? ''}`);
        for (const [who, r] of [['A', ra], ['B', rb]]) {
          if (r.reason === 'smoke-rejected') {
            api.violation('candidate-clobbered', `${who}'s smoke lost its candidate tree mid-run and rejected a good build: ${JSON.stringify(r.alerts?.filter((x) => x.kind === 'smoke-rejected'))}`);
          }
        }
        const state = readRebuildState(w.simCloneRoot, w.env);
        if (state.rejected) api.violation('spurious-rejection', `a good build was recorded as rejected: ${JSON.stringify(state.rejected)}`);
        if (!ra.adopted && !rb.adopted) api.violation('rebuild-not-adopted', `neither concurrent rebuild adopted the new main: ${JSON.stringify({ a: ra.reason, b: rb.reason })}`);
      },
    });
  },
  judge(report) {
    return report.violations
      .filter((v) => ['candidate-clobbered', 'spurious-rejection', 'rebuild-not-adopted', 'crash'].includes(v.invariant))
      .map((v) => `${v.daemon ?? '-'} tick ${v.tick ?? '-'}: [${v.invariant}] ${v.detail}`);
  },
};
