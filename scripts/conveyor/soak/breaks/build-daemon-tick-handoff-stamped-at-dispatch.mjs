/**
 * @file breaks/build-daemon-tick-handoff-stamped-at-dispatch.mjs — item 78a (epic #4075). The build-dispatch
 * daemon plans ONCE per tick and then dispatches serially, handing each launch the already-computed tick through
 * `tick.json` so dispatch-lane need not re-plan (median 92 s each). dispatch-lane accepts that file only when its
 * `at` is under 5 minutes old — but `cliDispatch` stamped `at` with `new Date()` at WRITE time, i.e. when each
 * dispatch started, not when the plan was made. A third or later launch in a slow tick (the PR cites ~90 s per
 * launch, 486 s for two prepares) therefore wrote a "fresh" `at` on a plan that was many minutes old, and the
 * bound that is meant to force a re-plan never fired — the launch used admission and held decisions older than
 * the base code ever allowed.
 *
 * Fix (item 78a, review round 1): `runBuildDispatchTick` captures the plan time right after `planTick` and
 * threads it through `effects.dispatch({ tickAt })`; `cliDispatch` writes that as `at`, and hands off no tick at
 * all when it has none.
 *
 * SCENARIO: a LIVE tick on a controlled clock. The plan is made at T0; every dispatch burns 6 minutes. The REAL
 * `cliDispatch` runs with an injected `exec` that reads the `tick.json` it was handed. The envelope's `at` must
 * still be the plan time (T0), never a later one — and a launch started more than 5 minutes after the plan must
 * therefore be handed an envelope the reader will refuse.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cliDispatch, runBuildDispatchTick } from '../../../../skills-src/conveyor/build-dispatch-daemon.mjs';
import { BUILD_DISPATCH_POLICY } from '../../build-dispatch-policy.mjs';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const FIVE_MIN = 5 * 60_000;
const CANDIDATES = ['9101', '9102', '9103'];

export default {
  id: 'build-daemon-tick-handoff-stamped-at-dispatch',
  title: 'the build-dispatch daemon stamped its tick handoff with the dispatch time, so a plan older than 5 minutes still looked fresh to dispatch-lane',
  card: 'we:backlog/78a (epic #4075)',
  fixedBy: { sha: '923da6429', where: 'lane/item-78a', paths: ['skills-src/conveyor/build-dispatch-daemon.mjs'] },
  fixPresent(root) {
    const p = join(root, 'skills-src/conveyor/build-dispatch-daemon.mjs');
    return existsSync(p) && /\btickAt\b/.test(readFileSync(p, 'utf8'));
  },
  async run({ log } = {}) {
    let clock = T0;
    const envelopes = [];
    const spawnBuilds = CANDIDATES.map((num, i) => ({ num, lane: i + 1 }));
    const effects = {
      now: () => clock,
      planTick: () => ({
        decisions: {
          statusLine: 'soak',
          counts: { building: 0, buildingInFlight: 0 },
          spawnBuilds,
          admission: {
            queue: spawnBuilds.map((s) => ({ num: s.num, scope: [`we:soak/scratch-${s.num}.mjs`] })),
            cleared: spawnBuilds.map((s) => ({ num: s.num, ready: true })),
          },
        },
        nextState: {},
      }),
      fetchOpenPrs: () => [{ repo: 'plateau-app', prs: [] }],
      listClaims: () => [],
      releaseClaim: () => {},
      acquireClaim: () => ({ ok: true }),
      listRunStoreInFlight: () => [],
      killSwitch: () => ({ engaged: false }),
      dispatch: (c) => {
        const launchedAt = clock;
        const exec = (_cmd, argv) => {
          const tickFile = argv.find((a) => a.startsWith('--tickFile='))?.slice('--tickFile='.length);
          envelopes.push({ num: c.num, launchedAt, at: tickFile ? JSON.parse(readFileSync(tickFile, 'utf8')).at : null });
          return JSON.stringify({ dispatching: true });
        };
        const res = cliDispatch(c, { exec });
        clock += 6 * 60_000; // every launch is slow
        return { ...res, lane: 1 };
      },
    };
    const policy = { ...BUILD_DISPATCH_POLICY, maxConcurrentBuilds: CANDIDATES.length };
    await runBuildDispatchTick({ bookkeeping: {}, live: true, policy, effects });
    log?.(envelopes.map((e) => `#${e.num}: launched +${(e.launchedAt - T0) / 60_000}m, at=${e.at}`).join(' | '));
    const violations = [];
    for (const e of envelopes) {
      // No envelope at all is fine (the reader re-plans). A present one must carry the PLAN time.
      if (e.at !== null && Date.parse(e.at) !== T0) {
        violations.push({
          invariant: 'handoff-restamped',
          detail: `#${e.num} launched ${(e.launchedAt - T0) / 60_000} min after the plan but its tick.json says at=${e.at} (plan was ${new Date(T0).toISOString()}), so ${e.launchedAt - T0 >= FIVE_MIN ? 'the reader accepts a plan older than 5 min' : 'the stamp is the dispatch time'}`,
        });
      }
    }
    if (envelopes.length === 0) violations.push({ invariant: 'no-dispatch', detail: 'the scenario launched nothing' });
    return { violations };
  },
  judge(report) {
    return report.violations.map((v) => `[${v.invariant}] ${v.detail}`);
  },
};
