/**
 * @file sim-scenario-self-sync-sibling.test.mjs — epic #3383, scenarios I-15/I-18 (report "First three
 * scenarios" row A). Fix under test: commit `ee1bbd861`, `scripts/lib/daemon-self-sync.mjs#withSelfSync` — see
 * that file's own header for bug 1 (mid-tick stale-main re-sync) and bug 2 (boot-HEAD-drift restart).
 *
 * Both cases share ONE fact the harness already gives for free: `review` and `fix-dispatch` both boot their
 * daemon host with `cwd: w.simCloneRoot` (`scenario.mjs#bootHost`), i.e. they run from the SAME shared clone —
 * exactly the topology bug 2's own docblock names ("the review-daemon and reconcile-fix-dispatch-daemon run
 * from ONE shared dedicated clone").
 *
 * A1 (I-15) — a sibling daemon self-syncs first; the OTHER daemon (already booted, on the OLD bootSha) never
 * reloads unless it independently notices HEAD moved out from under it. Proves the boot-HEAD-drift restart.
 *
 * A2 (I-18) — origin/main moves AFTER a tick's own tick-start self-sync but BEFORE the tick finishes, tripping
 * `assertMainNotStale`'s refusal partway through a multi-repo tick. Proves the immediate re-sync-and-restart
 * (never waiting out the rest of `intervalMs` to lose the same race again).
 *
 * A2's mid-tick advance is fired from INSIDE the tick itself — a scenario play-array step only ever runs
 * BETWEEN ticks, so the only way to land a change at the exact moment the design report's own incident needed
 * (between the tick-start sync and the tick's internal dispatch) is a hook the `gh` call ITSELF trips. The fake
 * GitHub's `fault({kind:'push-to-main-diverge'})` (added here, see `fake-gh.mjs#pushCommitToRef` and
 * `fake-gh-shim.mjs`'s own dispatch) is exactly that hook — a HARNESS GAP this scenario's own build closed: a
 * bare forward push alone is not enough, because `assertMainNotStale`'s `cleanOnly` staleness check silently
 * self-heals a plain BEHIND (not diverged) checkout via `git merge --ff-only` (see `main-staleness.mjs`) — which
 * is the whole POINT of that mode, and means a plain push never reproduces a genuine refusal here. Only a
 * DIVERGED tree (ahead AND behind at once) refuses to fast-forward and throws — which is also the REAL shape
 * `daemon-self-sync.mjs`'s own file header names as the live condition ("the clone is usually also AHEAD —
 * unmerged fixes merged in to run ahead of main"). `push-to-main-diverge` reproduces both halves at once: a
 * real push to the bare origin, AND a real local `--allow-empty` commit directly in the dispatching daemon's
 * own clone (its cwd, inherited by every `gh` child it spawns) — so the checkout is genuinely ahead-and-behind,
 * not merely stale.
 *
 * #4044 UPDATE: the default self-sync path now REBUILDS a managed clone instead of merging on top of it, and a
 * managed clone's `assertMainNotStale` refuses a plain behind-only checkout rather than fast-forwarding it. So A2 now
 * arms the plain `push-to-main` fault: behind-only is enough to refuse, and a local-only ahead commit (what
 * `-diverge` adds) is refused by the rebuild as local work, never merged. The paragraph above is the pre-#4044 story.
 *
 * LIVE SMOKE GATE (`scripts/lib/daemon-live-smoke.mjs`, landed separately as `2a53302d8`, already on `main`
 * ahead of this build): every successful tick-start self-sync merge now runs a real smoke (lane-pool
 * list/acquire/release, two `gh` reads, a `reconcile-pass.mjs --json` dry run per constellation repo) before
 * adopting it. It runs FOR REAL here — hermetically: the lane-pool checks hit the REAL (sim) pool this world
 * already provisions, and every `gh` call resolves to the fake `gh` this world puts on `PATH` first, which
 * already carries all three constellation repos (see `world.mjs`'s own "every constellation repo... gets a
 * bare origin" note) — so nothing about the gate needs `WE_DAEMON_SMOKE_DISABLE`.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scenario, runScenario } from './sim/scenario.mjs';

function headOfClone(cloneRoot) {
  return execFileSync('git', ['-C', cloneRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

// #4044 restart gate: a daemon restarts only when a file it IMPORTS changed, and not before it has run
// WE_DAEMON_RESTART_MIN_INTERVAL_MS (default 10m). A restart-proving scenario therefore lands a real (harmless,
// appended-comment) change to a module both daemons import, and advances the sim clock past the window.
const IMPORTED = 'scripts/lib/daemon-self-sync.mjs';
function touchedImported(w, tag) {
  return { [IMPORTED]: `${readFileSync(join(w.simCloneRoot, IMPORTED), 'utf8')}\n// sim: ${tag}\n` };
}

function a1Def() {
  return scenario('self-sync-sibling-a1-boot-drift-restart', {
    repos: ['we'],
    daemons: ['review', 'fix-dispatch'],
    lanes: 2,
    setup(w) {
      return { w };
    },
    play: [
      // Boot BOTH daemon hosts on the SAME original main sha — each records its own `bootSha` at this moment.
      'tick fix-dispatch',
      'tick review',
      // A human (or another lane) pushes a harmless commit straight to origin/main.
      (w) => { w.git.commitToMain('we', touchedImported(w, 'a1'), 'sim: a1 main commit touching daemon code'); },
      'advance 11m',
      // review's OWN tick-start self-sync finds it, merges (real git, in the shared clone), passes the live
      // smoke gate, and restarts — all within this ONE tick call.
      'tick review',
      // fix-dispatch's OWN tick-start self-sync finds NOTHING to merge (review already brought the shared
      // clone current) — but its bootSha no longer matches the clone's on-disk HEAD, so it restarts too,
      // within this SAME tick call, never ticking on stale in-memory code first.
      'tick fix-dispatch',
      // Reboot both, lazily, onto the new code — proving they come back up clean rather than restart-looping.
      'tick fix-dispatch',
      'tick review',
    ],
    expect(s, { w }) {
      // fix-dispatch: boot #1 (baseline) -> tick #2 hits the boot-HEAD-drift restart -> boot #2 (rebooted).
      const fixTicks = s.trace.filter((t) => t.daemon === 'fix-dispatch');
      expect(fixTicks).toHaveLength(3);
      expect(fixTicks[0].restart).toBeFalsy();
      expect(fixTicks[1].restart).toBe(true); // the boot-HEAD-drift restart (#3383 bug 2)
      expect(fixTicks[2].restart).toBeFalsy();

      // review: boot #1 -> tick #2 merges the harmless commit + restarts -> boot #2 (rebooted).
      const reviewTicks = s.trace.filter((t) => t.daemon === 'review');
      expect(reviewTicks).toHaveLength(3);
      expect(reviewTicks[0].restart).toBeFalsy();
      expect(reviewTicks[1].restart).toBe(true);
      expect(reviewTicks[2].restart).toBeFalsy();

      expect(s.hosts.review).toEqual({ boots: 2, restarts: 1 });
      expect(s.hosts['fix-dispatch']).toEqual({ boots: 2, restarts: 1 });

      // Both hosts share ONE clone by construction — the meaningful proof is that the CLONE itself actually
      // converged to the new origin/main tip (self-sync did not leave it stale or mid-merge).
      const originMainSha = w.git.headOf('we', 'main');
      expect(headOfClone(w.simCloneRoot)).toBe(originMainSha);
    },
  });
}

function a2Def() {
  return scenario('self-sync-sibling-a2-mid-tick-stale-refusal', {
    repos: ['we'],
    daemons: ['fix-dispatch'],
    lanes: 2,
    setup(w) {
      return { w };
    },
    play: [
      // Boot fix-dispatch on a clean baseline tick — nothing owed, nothing to merge.
      'tick fix-dispatch',
      // Arm the mid-tick advance: fires on the FIRST `pr list` call this NEXT tick makes (repo 'we', first in
      // `FIX_DISPATCH_DAEMON_REPOS` iteration order) — see this file's own header for why `-diverge`, not a
      // bare push, is what is needed to make `assertMainNotStale` actually refuse rather than silently heal.
      (w) => {
        // #4044: a plain push, not `-diverge`. The clone is now MANAGED (rebuilt fresh from origin/main + its
        // overlay list; `withSelfSync` sets WE_DAEMON_MANAGED_CLONE=1), so `assertMainNotStale` REFUSES a
        // behind-only clone instead of fast-forwarding it past the smoke gate. A local-only ahead commit is no
        // longer how a daemon clone runs ahead (overlays are); the rebuild refuses such a commit as local work.
        w.gh.raw.fault({
          verb: 'pr list', kind: 'push-to-main', times: 1, repo: 'web-everything/web-everything',
          files: touchedImported(w, 'a2'), message: 'sim: a2 mid-tick origin advance (daemon code)',
        });
      },
      'advance 11m',
      // This tick: repo 'we' ticks clean (tick-start self-sync already up to date), its own `reconcile()` calls
      // `gh pr list` — the fault fires, diverging the shared clone. repo 'frontierui' and 'plateau-app' then
      // each independently call `assertMainNotStale` at the top of their OWN `runReconcileFixDispatch` and
      // THROW (diverged) — recorded as `tick-failed` refusals. `hasStaleMainRefusal` sees them and
      // `withSelfSync` re-syncs IMMEDIATELY: the shared clone is genuinely ahead+behind, so `selfSyncCheckout`
      // performs a real 3-way merge (no conflict — disjoint files) and restarts, all within THIS tick.
      'tick fix-dispatch',
      // Reboot onto the new (now up-to-date) code — must converge, not stay stuck refusing.
      'tick fix-dispatch',
    ],
    expect(s, { w }) {
      const ticks = s.trace.filter((t) => t.daemon === 'fix-dispatch');
      expect(ticks).toHaveLength(3);
      expect(ticks[0].restart).toBeFalsy();
      expect(ticks[0].result?.refusals ?? []).toEqual([]);
      // THE decisive assertion (#3383 bug 1): the restart happens on the SAME tick that hit the mid-tick
      // refusal — never absorbed as an ordinary failed tick that waits out the rest of `intervalMs`.
      expect(ticks[1].restart).toBe(true);
      // Converged: the next (rebooted) tick sees a clean, up-to-date checkout with nothing left to refuse.
      expect(ticks[2].restart).toBeFalsy();
      expect(ticks[2].error).toBeNull();
      expect(ticks[2].result?.refusals ?? []).toEqual([]);

      // Converged: the rebuild moved the clone to EXACTLY origin's new tip (no overlays registered, no merge on
      // top) — the same exact match A1 asserts.
      const originMainSha = w.git.headOf('we', 'main');
      expect(headOfClone(w.simCloneRoot)).toBe(originMainSha);
    },
  });
}

// #4044 LIVE BUG 2 (restart churn): a main move touching nothing the daemons import (the common drain case — a
// backlog card) must still bring the shared clone current, but restart NEITHER daemon; both keep ticking.
function a3Def() {
  return scenario('self-sync-sibling-a3-no-restart-on-unimported-move', {
    repos: ['we'],
    daemons: ['review', 'fix-dispatch'],
    lanes: 2,
    setup(w) {
      return { w };
    },
    play: [
      'tick fix-dispatch',
      'tick review',
      (w) => { w.git.commitToMain('we', { 'backlog/9999-sim-a3.md': '---\ntitle: sim a3\n---\nbody\n' }, 'sim: a3 backlog-only main commit'); },
      'advance 11m', // past the window, so only the imported-file rule can be what holds the restart back
      'tick review',
      'tick fix-dispatch',
    ],
    expect(s, { w }) {
      for (const d of ['review', 'fix-dispatch']) {
        const ticks = s.trace.filter((t) => t.daemon === d);
        expect(ticks).toHaveLength(2);
        expect(ticks.every((t) => !t.restart)).toBe(true);
        expect(s.hosts[d]).toEqual({ boots: 1, restarts: 0 });
      }
      expect(headOfClone(w.simCloneRoot)).toBe(w.git.headOf('we', 'main'));
    },
  });
}

describe('#3383 daemon scenario simulator — self-sync sibling scenarios (I-15/I-18)', () => {
  it('A1: fix-dispatch restarts within one tick on boot-HEAD drift from a sibling daemon self-syncing first (I-15)', async () => {
    await runScenario(a1Def(), { timeoutMs: 180_000 });
  }, 180_000);

  it('A2: a mid-tick stale-main refusal re-syncs and restarts within the SAME tick (I-18)', async () => {
    await runScenario(a2Def(), { timeoutMs: 180_000 });
  }, 180_000);

  it('A3: a main move touching no daemon import rebuilds the clone but restarts neither daemon (#4044)', async () => {
    await runScenario(a3Def(), { timeoutMs: 180_000 });
  }, 180_000);
});
