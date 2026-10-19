/**
 * Card 5966: prepare #5399 was created over 24 hours ago but merged only 21 minutes
 * before duplicate #5438 launched. Scope moving after prepare must not bypass the
 * post-merge guard. Exercise the real live build-dispatch tick, not just the matcher.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const GUARD = 'scripts/conveyor/prepare-pr-match.mjs';

export default {
  id: 'merged-prepare-guard-measures-from-merge',
  title: 'An old-created, recently merged prepare permits a duplicate after scope moves',
  card: '5966 / PRs 5399, 5438',
  fixedBy: {
    sha: 'e3e18b0a2a0f928f6d8d17e33c276a9ced15e348',
    where: 'main',
    paths: [GUARD],
  },
  fixPresent(root) {
    return readFileSync(resolve(root, GUARD), 'utf8').includes('pr.mergedAt ?? pr.closedAt ?? pr.createdAt');
  },
  async run() {
    const { runBuildDispatchTick, createPrepareStatusReader } = await import(resolve(ROOT, 'skills-src/conveyor/build-dispatch-daemon.mjs'));
    const claimed = [], dispatched = [];
    let hideMergeDuringPlanning = false;
    let listingCalls = 0;
    const effects = {
      now: () => Date.parse('2026-10-16T20:53:36Z'),
      planTick: () => ({ decisions: {
        itemPrepareSpawns: [{ num: '5966' }],
        admission: { queue: [{ num: '5966' }], cleared: [], held: [{
          num: '5966', reason: 'prepare-stale',
          detail: 'scope changed since 2026-10-16T20:32:38Z',
        }] },
      }, nextState: {} }),
      fetchOpenPrs: () => [], listClaims: () => [], listRunStoreInFlight: () => [],
      listPrepareInFlight: () => [], listPrepareFailures: () => [], listPrepareReleases: () => [],
      killSwitch: () => ({ engaged: false }),
      readPreparedStamp: () => ({ preparedDate: '2026-10-16', preparedAgainstSha: 'a'.repeat(40) }),
      // A merge can become visible between planning and the final launch guard.
      listPreparePrs: () => hideMergeDuringPlanning && listingCalls++ === 0 ? [] : [{
        number: 5399, state: 'MERGED', headRefName: 'lane/5966-prepare-stand-down',
        title: 'WE #5966: prepare', isCrossRepository: false,
        createdAt: '2026-10-15T17:18:00Z', mergedAt: '2026-10-16T20:32:38Z',
      }],
      acquirePrepareClaim: ({ num }) => { claimed.push(num); return { ok: true }; },
      releasePrepareClaim: () => {}, placePrepareHold: () => {}, releasePrepareHold: () => {},
      dispatch: request => { dispatched.push(request); return { dispatching: true }; },
    };
    const planned = await runBuildDispatchTick({ live: true, effects });
    const planning = { claimed: [...claimed], dispatchCount: dispatched.length,
      launched: planned.prepare.launched, skipped: planned.prepare.skippedInPlanning,
      refusals: planned.nextBookkeeping.prepareRefusals };
    hideMergeDuringPlanning = true;
    const tick = await runBuildDispatchTick({ live: true, effects });
    // A large held backlog must not consume the reader's budget before the actual late-ordered pick.
    const rows = Array.from({ length: 60 }, (_, i) => ({ num: String(8000 + i), bornAs: `xabc${String(i).padStart(3, '0')}` }));
    const searches = [];
    // Both identities require branch and title searches. Give only the actual pick enough budget;
    // scanning held cards or repeating the planning queries at launch must still fail this probe.
    const reader = createPrepareStatusReader({ maxPrListingCalls: 4, exec: (cmd, args) => {
      if (cmd !== 'gh') throw new Error(`unexpected ${cmd} in listing-only probe`);
      searches.push(args[args.indexOf('--search') + 1]);
      return '[]';
    } });
    const volumeClaims = [], volumeDispatches = [];
    const volumeTick = await runBuildDispatchTick({ live: true, effects: { ...effects,
      planTick: () => ({ decisions: { itemPrepareSpawns: [rows.at(-1)],
        admission: { queue: rows, held: rows.map(row => ({ ...row, reason: 'needs-prepare' })) } }, nextState: {} }),
      listPreparePrs: args => reader.listPrs(args),
      acquirePrepareClaim: ({ num }) => { volumeClaims.push(num); return { ok: true }; },
      dispatch: request => { volumeDispatches.push(request); return { dispatching: true }; },
    } });
    return { planning, claimed, dispatchCount: dispatched.length, launched: tick.prepare.launched, refused: tick.prepare.refused,
      volume: { searches, claimed: volumeClaims, dispatchCount: volumeDispatches.length,
        launched: volumeTick.prepare.launched.map(row => row.num), refused: volumeTick.prepare.refused } };
  },
  judge(report) {
    const problems = [];
    const expectedSearches = ['head:lane/8059', 'head:lane/xabc059',
      'in:title "prepare" "8059"', 'in:title "prepare" "xabc059"'];
    if (report.volume.searches.join('\n') !== expectedSearches.join('\n') || report.volume.claimed.join() !== '8059'
      || report.volume.dispatchCount !== 1 || report.volume.launched.join() !== '8059' || report.volume.refused.length) {
      problems.push('held backlog exhausted the prepare listing budget before the actual pick');
    }
    if (report.planning.claimed.length || report.planning.dispatchCount || report.planning.launched.length) {
      problems.push('recently merged #5399 allowed a duplicate during planning');
    }
    if (!report.planning.skipped.some(row => row.num === '5966'
      && row.reason === 'skipped in planning: prepared 20 min ago (#5399)')) {
      problems.push('missing planning skip measured from #5399 merge time');
    }
    // The planning skip must not drop the build step's reconciliation signal the launch guard used to write.
    const planningNote = 'scope moved after prepare: scope changed since ';
    if (!report.planning.skipped.some(row => row.num === '5966' && row.note?.includes(planningNote))
      || !report.planning.refusals.some(row => row.num === '5966' && row.pr === 5399 && row.note?.includes(planningNote))) {
      problems.push('planning skip dropped the scope-moved note or its persisted refusal record');
    }
    if (report.claimed.length || report.dispatchCount || report.launched.length) {
      problems.push('recently merged #5399 allowed a duplicate prepare claim/launch (#5438 shape)');
    }
    const refusal = report.refused.find(row => row.num === '5966');
    if (refusal?.reason !== 'merged prepare PR #5399 (within 24h guard)') {
      problems.push('missing merged-prepare refusal for #5399');
    }
    if (!refusal?.note?.includes('scope moved after prepare: scope changed since ')) {
      problems.push('missing scope-moved reconciliation note');
    }
    return problems;
  },
};
