/**
 * @file breaks/large-reap-backlog-starves-dispatch.mjs — LIVE INCIDENT, 2026-09-26 18:02 ET (epic #3383). The
 * review daemon (`we:skills-src/conveyor/review-daemon.mjs`) restarted onto the code that wires
 * `we:scripts/conveyor/session-reaper.mjs#runSessionReaperPass` into its own tick. Since nothing had ever
 * reaped before that, its FIRST tick found ~1,500 old finished sessions and worked through them one `claude
 * stop` at a time (~95/min, a real measured rate) — 15+ minutes with NOTHING else in this single-threaded
 * daemon able to run: no review dispatched, no `review-status:*` tag refreshed, the whole time. Discovered a
 * SECOND, sharper way to hit the same wall the same night: the reap was moved to run BEFORE discovery so a PR
 * freed by reaping its own stale blocker could be picked up the SAME tick — which means an unbounded backlog
 * now blocks discovery+dispatch EVERY tick, not just the first.
 *
 * `runSessionReaperPass` had no notion of "enough for this tick" at all — it kept `claude stop`-ing every
 * reap candidate the listing produced, however many, before ever returning control to its caller.
 *
 * FIX (this same PR, epic #3383): `runSessionReaperPass` now takes a per-tick BUDGET —
 * `maxStops`/`maxDurationMs` ({@link ../../session-reaper.mjs#DEFAULT_REAP_MAX_STOPS_PER_PASS}/
 * {@link ../../session-reaper.mjs#DEFAULT_REAP_MAX_DURATION_MS}, both env-overridable via
 * `WE_SESSION_REAP_MAX_STOPS`/`WE_SESSION_REAP_MAX_DURATION_MS`) — whichever bound is hit first ends that
 * pass's reaping; every candidate the budget didn't reach is simply left for the next tick's fresh listing
 * (never lost, never double-reaped once actually stopped). `we:skills-src/conveyor/review-daemon.mjs`'s own
 * `defaultReapSessions` forwards this straight through, so the real daemon is bounded with no extra wiring.
 *
 * SCENARIO. The plain soak world's default fleet already seeds the trigger population: PR `pending` (always
 * PR #1, `we:scripts/conveyor/soak/fleet.mjs`) owes a review. Before the review daemon's very first tick,
 * this scenario seeds `BACKLOG_SIZE` already-`done` sessions directly into the fake `claude` store — the
 * exact shape a long-neglected reaper backlog has: `kind:'background'`, `state:'done'`, `cwd` = the daemon's
 * OWN clone (so `allowedCwd` accepts them as real candidates), no live pid. `WE_SESSION_REAP_MAX_STOPS` is
 * pinned to a small test value (never this scenario's job to also pin the PRODUCTION-sized default — that is
 * `we:scripts/conveyor/__tests__/session-reaper.test.mjs`'s own job) so the scenario proves the CAP EXISTS
 * AND IS HONORED, at a backlog size and tick bound that stay fast to run either way.
 *
 * RED (pre-fix) = the daemon's first tick tries to `claude stop` all `BACKLOG_SIZE` sessions before ever
 * calling discovery — measured (see this file's own calibration) at ~58ms per fake-CLI `stop` spawn, so a
 * backlog many times smaller than the real 1,500 still comfortably blows `TICK_BOUND_MS`; the harness's own
 * per-tick IPC timeout (`we:scripts/conveyor/__tests__/sim/scenario.mjs`'s `tickDaemon`) fires from the
 * PARENT process (never blocked by the child's synchronous reap loop) and the tick is recorded 'bounded'.
 * GREEN (post-fix) = the SAME backlog reaps only `WE_SESSION_REAP_MAX_STOPS` sessions this tick, finishes
 * comfortably inside `TICK_BOUND_MS`, and discovery+dispatch runs right after in the same tick — PR #1 is
 * dispatched a review within the grace window.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runSoak } from '../soak.mjs';
import { withStoreLock } from '../../../operations/__tests__/helpers/fake-claude-shim.mjs';

/** Empirically measured (see this file's own header): ~58ms per fake-CLI `claude stop` spawn, and a bare
 *  review-daemon tick (real reconcile/dispatch/self-sync overhead, ZERO junk backlog) already costs ~4.7s in
 *  this harness — so `TICK_BOUND_MS` below must clear THAT floor too, not just the reap cost. 300 sessions is
 *  ~17s of unbounded reap on top of that floor — comfortably over the bound with margin, while staying well
 *  under this tier's own multi-minute norm (this file's own header: "Minutes, not seconds"). The REAL incident
 *  was ~1,500; this scenario does not need that scale to prove the cap fires — see `we:scripts/conveyor/soak/
 *  breaks/session-junk-in-daemon-clone.mjs` for the same "small enough to run fast, large enough to reproduce"
 *  calibration convention. */
const BACKLOG_SIZE = 300;
/** A tiny override so the FIXED path's budgeted reap (a handful of stops, ~0.7s) adds only a small margin on
 *  top of the ~4.7s bare-tick floor, while the unbounded pre-fix path (BACKLOG_SIZE stops, ~17s) blows well
 *  past `TICK_BOUND_MS` below. Never the production-sized default — that value is pinned by
 *  session-reaper.test.mjs's own unit tests. */
const MAX_STOPS_OVERRIDE = '5';
/** Comfortably above the bare-tick floor + a budgeted reap's own real cost, comfortably below BACKLOG_SIZE
 *  stops' unbounded real cost on top of that same floor — see calibration above. The LOCAL floor is ~5.5s, but
 *  the CI runner's first review tick is much slower: main CI measured 10.1s green (run 41004478390) and 12.04s
 *  against a 12s bound (run 41006327928, first red commit f16501bd7 — no code on the reap/tick path changed),
 *  so 12s left ~2s of runner-variance margin and flaked. 18s keeps the same separation from the unbounded path
 *  (>= ~4.7s + ~17s ≈ 22s locally, and the stop spawns only get slower on a CI runner). */
const TICK_BOUND_MS = 18_000;

export default {
  id: 'large-reap-backlog-starves-dispatch',
  title: 'an unbounded session-reap sweep runs every tick with no per-tick budget; a large backlog of already-finished sessions blocks the review daemon\'s own discovery+dispatch, starving a PR that is owed a review',
  card: 'epic #3383 — session-reap per-tick budget (review-daemon restart 2026-09-26 18:02 ET)',
  fixedBy: {
    sha: 'this same PR', where: 'this same PR (epic #3383)',
    paths: ['scripts/conveyor/session-reaper.mjs', 'skills-src/conveyor/review-daemon.mjs'],
  },
  fixPresent(root) {
    try {
      return /DEFAULT_REAP_MAX_STOPS_PER_PASS/.test(readFileSync(join(root, 'scripts/conveyor/session-reaper.mjs'), 'utf8'));
    } catch { return false; }
  },
  run({ log } = {}) {
    return runSoak({
      name: 'break:large-reap-backlog-starves-dispatch',
      rounds: 2,
      daemons: ['review'],
      mainEvery: 0,
      scorecards: false,
      env: { WE_SESSION_REAP_MAX_STOPS: MAX_STOPS_OVERRIDE },
      bounds: { tickBoundMs: TICK_BOUND_MS, owedGraceTicks: 0 },
      log,
      setup(w) {
        // Seeded BEFORE the review daemon's very first tick — the live incident's own shape: the whole
        // backlog is already there the moment the daemon (re)starts, not accumulated gradually across ticks.
        withStoreLock(w.claude.env.FAKE_CLAUDE_STORE, (store) => {
          for (let i = 0; i < BACKLOG_SIZE; i += 1) {
            store.sessions.push({
              id: `oldsess${i}`, sessionId: `oldsess${i}-0000-0000-0000-000000000000`,
              name: `review-old-${i}`, kind: 'background', state: 'done', cwd: w.simCloneRoot,
              startedAt: new Date(Date.now() - 86_400_000).toISOString(),
            });
          }
        });
      },
    });
  },
  judge(report) {
    // 'bounded' is the direct proof: an unbounded reap blows the per-tick bound (pre-fix) vs a budgeted one
    // comfortably finishing (post-fix). 'owed' is the FUNCTIONAL consequence when a tick isn't outright
    // aborted by the harness's own IPC timeout — either signal alone means the break reproduced.
    return report.violations
      .filter((v) => ['bounded', 'owed'].includes(v.invariant))
      .map((v) => `${v.daemon ?? '-'} tick ${v.tick ?? '-'}: [${v.invariant}] ${v.detail}`);
  },
};
