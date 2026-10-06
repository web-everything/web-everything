/**
 * @file breaks/sticky-smoke-rejection.mjs — live break 7, 2026-09-25 08:14 ET (#4075, card 4169). Both `gh`
 * smoke checks (`gh api --method GET repos/...`, `gh pr list --limit 1 ...` — `daemon-live-smoke.mjs#SMOKE_CHECKS`)
 * failed together with Go-style network errors (`gh` is a Go binary: "error connecting to api.github.com",
 * "dial tcp ...: i/o timeout"), not matched by the OLD `TRANSIENT_FAILURE_PATTERNS`, so
 * `classifySmokeFailure` read the whole smoke as `'code'` — a genuine-looking regression, not env noise.
 * `daemon-rebuild.mjs#doRebuild` recorded `state.rejected = {inputsKey, reason, at}` (no `retryAt`, since that
 * field didn't exist yet) and every later tick short-circuited at Step 4's `still-rejected` check FOREVER —
 * `state.rejected.inputsKey` only changes when `origin/main` (or the overlay list) moves, so the clone stayed
 * behind even long after the network itself recovered.
 *
 * Fix (lane/4044, eb7c540ea): Go-style patterns joined `TRANSIENT_FAILURE_PATTERNS`
 * (`error connecting to api\.github\.com` / `dial tcp` / `i\/o timeout`, among others), so THIS exact failure now
 * classifies `'transient'` — `runLiveSmokeWithRetry` retries the whole smoke (backoff, capped attempts) and, per
 * the file's own Module D rule, a `'transient'` verdict NEVER writes `state.rejected` at all (`doRebuild`'s
 * `'transient'` branch just rolls back) — so the very next tick tries a completely fresh smoke instead of being
 * stuck on a cached verdict. `doRebuild` ALSO gained `isExternalOnlyFailure()` + `rejectRetryDelayMs()` (5m base,
 * doubling, 1h cap) as defense-in-depth for a residual `'code'` verdict whose failures are still all
 * `mayBeTransient` rows (an external error the pattern list doesn't yet name) — that path records `retryAt` and
 * re-smokes once due, rather than sticking until main moves; plus a `clone-held-stale` alert either way.
 *
 * Scenario: main moves ONCE, then stays still for many rounds (only a retry — never another main move — can
 * ever adopt it). While the rebuild's live smoke would run, the fake `gh`'s `api` and `pr list` verbs are armed
 * (`fake-gh-shim.mjs`'s new `kind:'network'` fault — #4075 soak harness gap, no existing kind could produce
 * Go's net/http stderr text) to fail with the exact Go-style error for a LIMITED number of calls, then the
 * "network" recovers on its own — nothing else in the scenario changes. RED = the clone never adopts the move
 * again after that (`lag`/`stale` pile up for the rest of the soak, well past the network's own recovery).
 * GREEN = the very next fresh smoke attempt (this tick's own retry, or the next daemon tick) succeeds once the
 * fault is spent, and the clone catches back up within a few ticks.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runSoak } from '../soak.mjs';
import { rebuildMechanismSource } from '../rebuild-mechanism-source.mjs';

export default {
  id: 'sticky-smoke-rejection',
  title: 'both gh smoke checks fail with Go-style network errors the old transient patterns miss; the rebuild misreads it as a code regression and stays rejected forever, even after the network recovers',
  card: 'we:backlog/4044 via PR #2625 (epic #4075)',
  fixedBy: {
    sha: 'eb7c540ea',
    where: 'lane/4044-daemon-rebuild-and-clone-lock',
    paths: ['scripts/lib/daemon-live-smoke.mjs', 'scripts/lib/daemon-rebuild.mjs'],
  },
  // fixPresent probe (per the brief): `rejectRetryDelayMs` in daemon-rebuild.mjs — absent on main (that whole
  // module doesn't exist there) and on lane/4044 before eb7c540ea.
  fixPresent(root) {
    try {
      return /export function rejectRetryDelayMs/.test(rebuildMechanismSource(root));
    } catch { return false; }
  },
  run({ log } = {}) {
    return runSoak({
      name: 'break:sticky-smoke-rejection',
      // One main move (round 15) with plenty of idle rounds on both sides: rounds 0-14 let the clone settle onto
      // a rebuild-state file (see world.mjs's own `WE_DAEMON_STATE_DIR` isolation) before anything interesting
      // happens; rounds 16-21 (12 more daemon ticks) are enough to blow `maxLagTicks`(6)/`staleStreakMax`(3) on
      // RED while giving GREEN room to show a clean recovery well before the same bound.
      rounds: 22,
      mainEvery: 15,
      scorecards: false,
      setup(w) {
        // The sticky rejection lives in `daemon-rebuild.mjs#doRebuild`'s reject record — a module main does not have
        // (main's older `withSelfSync` merge-in-place + gate path did NOT reproduce this scenario: measured
        // 2026-09-25, every invariant held there). So on a tree without the rebuild this scenario is not
        // applicable yet: throw a clear error — counted as the expected failure — rather than read as a pass.
        if (!existsSync(join(w.simCloneRoot, 'scripts/lib/daemon-rebuild.mjs'))) {
          throw new Error('sticky-smoke-rejection: requires scripts/lib/daemon-rebuild.mjs (lands with #2625 / #4044) — not present on this tree');
        }
        // Never the real `~/.claude/daemon-self-sync-state` — world.mjs now scopes `WE_DAEMON_STATE_DIR` itself
        // (#4075 soak harness gap fixed alongside this break), so nothing extra is needed here; kept as an
        // explicit belt-and-suspenders pin in case that world-level default is ever missing.
        w.env.WE_DAEMON_STATE_DIR = w.env.WE_DAEMON_STATE_DIR || join(w.root, 'daemon-self-sync-state');
        return {};
      },
      // #4075 soak harness gap: `gh pr list ...` is ALSO exactly what the review daemon's own normal per-tick
      // dispatch scan calls (`pr list --repo ... --json ...`, looking for review:pending work) — `fault()`
      // matches on verb alone, not the full argv, so arming the fault in `setup` (before round 0) gets it
      // entirely CONSUMED by 14+ rounds of ordinary dispatch scanning before the round-15 main move ever runs
      // the live smoke at all, and the "break" silently never reproduces. Arming it here, in `perRound` at the
      // exact round main moves, means the smoke's own two calls (inside `rebuild()`, which `withSelfSync` always
      // runs BEFORE that tick's own dispatch work — `daemon-self-sync.mjs#withSelfSync`'s `tickOnce`, Gate 1)
      // are the FIRST calls to consume it.
      perRound(w, round) {
        if (round !== 15) return;
        // `times` covers up to 2 full internal retry cycles of `runLiveSmokeWithRetry` (each up to 3 attempts ×
        // 1 `api` + 1 `pr list` call) plus headroom for BOTH daemons independently attempting the rebuild on the
        // SAME clone the round main moves — comfortably more calls than one real 08:14 ET-style network blip
        // would need to clear on its own, and still a bounded, LIMITED number (never "forever" — that is exactly
        // the behaviour under test).
        w.gh.fault({ verb: 'api', kind: 'network', times: 12 });
        w.gh.fault({ verb: 'pr list', kind: 'network', times: 12 });
      },
      log,
    });
  },
  judge(report) {
    return report.violations
      .filter((v) => ['lag', 'behind', 'stale', 'crash'].includes(v.invariant))
      .map((v) => `${v.daemon ?? '-'} tick ${v.tick ?? '-'}: [${v.invariant}] ${v.detail}`);
  },
};
