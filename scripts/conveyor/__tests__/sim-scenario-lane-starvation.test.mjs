/**
 * @file sim-scenario-lane-starvation.test.mjs — epic #3383, scenario I-09 (report "First three scenarios" row
 * C). Fix under test: commit `1723ea4d3`, the review daemon capping dispatch by acquirable lanes
 * (`skills-src/conveyor/review-daemon.mjs#runReviewTick`'s `acquirableLanes` option, wired to the real
 * `defaultAcquirableLaneCount` only by `buildCliDaemonEffects` — the pure function's own default stays
 * unbounded `() => Infinity`, unaffected).
 *
 * SETUP: 4 lanes (two per review round, so 2 rounds fit), 5 `review:pending` PRs — more owed than the pool can
 * serve at once.
 *
 * The scripted review sessions do what the REAL review-agent-brief's own step 1 does first: acquire a lane —
 * `node scripts/lane-pool.mjs acquire --purpose=review-loop --session=<name> --json` (this scenario's own
 * `acquireLane()` agent action, added to `sim/agent-actions.mjs` for this build — see that file's own
 * docblock). A session that cannot get one fails exactly like a real dispatch that loses the acquire race
 * would — `acquireLane`'s own failure branch mirrors {@link ../sim/agent-actions.mjs#failNoLane} byte for
 * byte. The whole point of the fix under test is that THIS should never actually happen: the daemon's own
 * dispatch cap is supposed to never fire more sessions than lanes exist to serve them.
 *
 * `LANE_POOL_ACQUIRE_GROWTH_MAX_NEW=0` (#3383, `scripts/lane-pool.mjs`'s own `acquire` auto-pick growth,
 * `1723ea4d3`'s OTHER half) is pinned in this scenario's own env: `acquire`'s auto-pick path growing the pool
 * past a genuinely starved reading would let a session succeed anyway, masking whether the review daemon's
 * OWN dispatch cap is what is actually bounding concurrency here — pinning growth to zero makes the 4-lane
 * pool a hard ceiling, so if the daemon ever over-dispatches, the excess session's `acquireLane()` genuinely
 * fails instead of quietly growing its way past the defect.
 *
 * PLAY: `tick review` dispatches at most 2 (never all 5); the scenario then runs each dispatched pair fully
 * to completion (acquire → verdict → release → exit) before ticking again for the next batch, exactly the
 * "deferred reviews stay owed and simply reappear next tick" behaviour `runReviewTick`'s own docblock
 * describes. Three ticks cover all five PRs (2 + 2 + 1).
 */

import { describe, expect, it } from 'vitest';
import { scenario, runScenario } from './sim/scenario.mjs';
import { FALLBACK_REQUIRED_STATUS_CHECKS } from '../../lib/required-status-checks.mjs';

const PR_COUNT = 5;
// The daemon now budgets roughly two lanes per review round (a round needs a companion lane), so 4 lanes
// still admit exactly 2 rounds per tick — the same 2 + 2 + 1 shape this scenario was written around.
const LANE_COUNT = 4;

function reviewSessionNames(w) {
  return w.claude.sessions().filter((s) => /^review-\d+$/.test(s.name)).map((s) => s.name);
}

function def() {
  const prNumbers = [];
  return scenario('lane-starvation-review-dispatch-cap', {
    repos: ['we'],
    daemons: ['review'],
    lanes: LANE_COUNT,
    setup(w) {
      // #3383 — pin the pool's own growth off, so the 4-lane pool is a HARD ceiling for this scenario (see
      // file header for why: otherwise a real over-dispatch defect could be masked by `acquire` silently
      // growing the pool past it, rather than the excess session's `acquireLane()` genuinely failing).
      w.env.LANE_POOL_ACQUIRE_GROWTH_MAX_NEW = '0';

      for (let i = 0; i < PR_COUNT; i += 1) {
        const branch = `lane/lane-starvation-${i}`;
        w.git.createBranch('we', branch, { from: 'main', files: { [`starvation-${i}.txt`]: `pr ${i}\n` } });
        const pr = w.gh.openPr({
          repo: 'we', head: branch, base: 'main', title: `lane starvation fixture ${i}`, labels: ['review:pending'],
        });
        // A PR owes a review only once every required check succeeded on its head (review CI gate).
        w.gh.setRequiredChecks('we', FALLBACK_REQUIRED_STATUS_CHECKS);
        w.gh.setChecks('we', pr, FALLBACK_REQUIRED_STATUS_CHECKS.map((name) => ({ name, conclusion: 'SUCCESS' })));
        prNumbers.push(pr);
      }

      // ONE script queue PER PR, not a single shared `'review-*'` queue: `createFakeClaude#script`'s queue is
      // per REGISTERED PATTERN, and `stepSessions` pops from whichever registered entry a session's name first
      // matches — a single wildcard registration shared by all 5 review sessions would round-robin ONE shared
      // 4-action queue across all of them (session A's step popping the action session B was about to run),
      // never each session completing its own full acquire→verdict→release→exit sequence independently. Every
      // PR number is already known here (`w.gh.openPr` returned it above), so each gets its own exact-name
      // script instead.
      for (const pr of prNumbers) {
        w.agents.script(`review-${pr}`, [
          w.act.acquireLane({ purpose: 'review-loop' }),
          w.act.postVerdict({ verdict: 'accepted' }),
          w.act.releaseLane(),
          w.act.exit({ state: 'done' }),
        ]);
      }
      return { prNumbers };
    },
    play: [
      'tick review',
      (w) => {
        // Capped by acquirable lanes (4 lanes = 2 rounds), never by reviews owed (5) — the decisive assertion for #3383.
        expect(reviewSessionNames(w)).toHaveLength(2);
      },
      'agents', 'agents', 'agents', 'agents',
      'tick review',
      (w) => {
        expect(reviewSessionNames(w)).toHaveLength(4); // 2 more dispatched, now that the first pair released
      },
      'agents', 'agents', 'agents', 'agents',
      'tick review',
      (w) => {
        expect(reviewSessionNames(w)).toHaveLength(5); // the last one
      },
      'agents', 'agents', 'agents', 'agents',
      'tick review', // nothing left to dispatch or defer
    ],
    expect(s, { prNumbers }) {
      expect(s.sessions('review-*')).toHaveLength(PR_COUNT);
      // No session ever failed for lack of a lane — the whole point of the cap under test.
      for (const sess of s.sessions('review-*')) {
        expect(sess.state).not.toBe('failed');
      }
      for (const pr of prNumbers) {
        const row = s.pr(pr, 'we');
        expect(row).toBeTruthy();
        expect(row.labels).toContain('review:accepted');
        expect(row.labels).not.toContain('review:pending');
      }
      // No lane left leased at the end — every acquire was matched by a release.
      for (const lane of s.leases) {
        expect(lane.lease).toBeNull();
      }
    },
  });
}

describe('#3383 daemon scenario simulator — lane starvation caps review dispatch (I-09)', () => {
  it('dispatches at most as many reviews as lanes are acquirable, never fails no-lane, and clears the backlog', async () => {
    await runScenario(def(), { timeoutMs: 180_000 });
  }, 180_000);
});
