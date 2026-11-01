/** 2026-10-30 → 11-01: prepare launched 0 times; parked-card status reads spent the whole PR-listing budget. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DAEMON = 'skills-src/conveyor/build-dispatch-daemon.mjs';

export default {
  id: 'prepare-launch-budget-starved-by-parked-reads',
  title: 'Prepare launch guard refused every pick with "prepare PR listing unavailable": ~41 parked cards re-listed each tick and exhausted the 128-call budget',
  card: 'prepare-budget (build-dispatch-daemon log, 107 refusals 2026-10-31)',
  fixedBy: { sha: 'HEAD', where: 'lane/prepare-budget', paths: [DAEMON] },
  fixPresent(root) {
    const daemon = readFileSync(join(root, DAEMON), 'utf8');
    return daemon.includes('launchReserve = 0') && daemon.includes('parkedListings = parkedPrepareListings');
  },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const { runBuildDispatchTick, createPrepareStatusReader } = await import(pathToFileURL(join(root, DAEMON)).href);
    const violations = [];
    const searches = [];
    const parkedListings = new Map();
    let clock = Date.parse('2026-11-01T04:00:00Z');
    const reader = () => createPrepareStatusReader({ maxPrListingCalls: 16, launchReserve: 8, parkedCacheMs: 15 * 60_000,
      now: () => clock, parkedListings, exec: (cmd, args) => {
        if (cmd === 'git') return ''; // fetch + an empty backlog tree: every read below names its bornAs
        searches.push(args[args.indexOf('--search') + 1]);
        return '[]';
      } });
    const parked = Array.from({ length: 10 }, (_, i) => ({ num: String(8200 + i), bornAs: `xpk${String(i).padStart(4, '0')}` }));
    const picks = [{ num: '4501', bornAs: 'xpick01' }, { num: '4502', bornAs: 'xpick02' }];
    for (const label of ['cold', 'warm']) {
      const r = reader();
      const before = searches.length;
      const tick = await runBuildDispatchTick({ live: true, effects: {
        planTick: () => ({ decisions: { itemPrepareSpawns: picks }, nextState: {} }),
        fetchOpenPrs: () => [], listClaims: () => [], listRunStoreInFlight: () => [], killSwitch: () => ({ engaged: false }),
        listPrepareClaims: () => [], listPrepareInFlight: () => [],
        primePrepareStatus: async () => {
          await r.prime(parked.map(p => ({ ...p, parked: true })));
          for (const p of parked) try { r.listPrs(p); } catch { /* the pre-launch share is spent */ }
        },
        listPreparePrs: args => r.listPrs(args),
        acquirePrepareClaim: () => ({ ok: true }), releasePrepareClaim: () => {},
        dispatch: () => ({ dispatching: true }), placePrepareHold: () => {},
      } });
      const launched = tick.prepare.launched.map(x => x.num);
      if (launched.join() !== '4501,4502') {
        violations.push(`${label} tick launched [${launched}] — refused: ${JSON.stringify(tick.prepare.refused.map(x => x.reason))}`);
      }
      // The two parked cards the cold tick listed in full are served from the cache on the warm tick.
      if (label === 'warm' && searches.slice(before).some(s => s.includes('8200') || s.includes('8201'))) {
        violations.push('warm tick re-listed a parked card cached 5 minutes earlier');
      }
      clock += 5 * 60_000;
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};
