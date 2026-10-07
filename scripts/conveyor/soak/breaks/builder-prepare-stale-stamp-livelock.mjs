/**
 * @file breaks/builder-prepare-stale-stamp-livelock.mjs — builder-starved-2 (2026-10-07). From 16:59Z to 18:49Z
 * the build-dispatch daemon launched 0 prepares (1 build) in 38 ticks, with 280 needs-prepare cards and both
 * prepare slots free.
 *
 * Mechanism: the prepare-ahead window (4) held prepare-STALE cards (4648, 4647, 5189). Each still had a settled
 * run row from the earlier prepare that wrote its now-stale stamp. With no claim, the daemon read that stamp as
 * "prepared on main", marked the card finished and skipped it — every tick — while the card kept its window
 * slot. The tick core planned the re-prepare; the daemon dropped it. Nothing moved.
 *
 * Fix: a BARE spawn candidate (no claim, no hold, no guard) whose card carries a stamp is a re-prepare, not a
 * finished prepare (`runBuildDispatchTick`'s inspect loop).
 *
 * SCENARIO: the REAL `runBuildDispatchTick` (live) with stub effects: the tick core offers two prepare-stale
 * cards, each with an older settled `prepare-completed` row and a same-day stamp on main.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runBuildDispatchTick } from '../../../../skills-src/conveyor/build-dispatch-daemon.mjs';

export default {
  id: 'builder-prepare-stale-stamp-livelock',
  title: 'prepare-stale cards with an old settled run read as "prepared on main", so the builder re-prepared nothing for 2h',
  card: 'lane/builder-starved-2 (2026-10-07 builder starvation, second wave)',
  fixedBy: { sha: 'lane/builder-starved-2', where: 'lane/builder-starved-2', paths: ['skills-src/conveyor/build-dispatch-daemon.mjs'] },
  fixPresent(root) {
    const p = join(root, 'skills-src/conveyor/build-dispatch-daemon.mjs');
    return existsSync(p) && /builder-starved-2/.test(readFileSync(p, 'utf8'));
  },
  async run({ log } = {}) {
    const spawns = [{ num: '4648', lane: 12 }, { num: '4647', lane: 14 }];
    const dispatched = [];
    const claims = new Map();
    const effects = {
      dispatch: ({ num }) => { dispatched.push(num); return { dispatching: true }; },
      placePrepareHold: () => {}, releasePrepareHold: () => {},
      planTick: (bk) => ({ decisions: { spawnPrepareItems: spawns }, nextState: { tick: (bk.tick ?? 0) + 1, prepareGuards: [] } }),
      fetchOpenPrs: () => [], listClaims: () => [], listRunStoreInFlight: () => [],
      killSwitch: () => ({ engaged: false }),
      listPrepareInFlight: () => [],
      listPrepareClaims: () => [...claims.values()],
      acquirePrepareClaim: (o) => { claims.set(o.num, { meta: { num: o.num, claimedAt: new Date().toISOString() } }); return { ok: true }; },
      releasePrepareClaim: ({ num }) => { claims.delete(num); },
      listSettledPrepares: () => spawns.map((s) => ({ num: s.num, source: `run:${s.num}`, startedAt: '2026-10-07T08:00:00Z', outcome: 'prepare-completed' })),
      readPrepareStatus: () => ({ preparedDate: '2026-10-07', preparedAgainstSha: 'aaaa1111', pr: null }),
      readPreparedStamp: () => ({ preparedDate: '2026-10-07', preparedAgainstSha: 'aaaa1111' }),
    };
    const tick = await runBuildDispatchTick({ live: true, effects });
    const planned = tick.prepare.planned.map((p) => p.num);
    log?.(`planned=${planned.join(',')} dispatched=${dispatched.join(',')}`);
    const violations = [];
    if (planned.length === 0) violations.push({ invariant: 'stale-reprepare-dropped', detail: 'the tick core offered two prepare-stale cards and the daemon planned neither' });
    return { violations, planned };
  },
  judge(report) {
    return report.violations.map((v) => `[${v.invariant}] ${v.detail}`);
  },
};
