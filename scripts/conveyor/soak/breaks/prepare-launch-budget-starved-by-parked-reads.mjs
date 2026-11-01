/** 2026-10-30 → 11-01: prepare launched 0 times; parked-card status reads spent the whole PR-listing budget. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
    const { resolvePreparePolicy } = await import(pathToFileURL(join(root, 'scripts/conveyor/prepare-policy-settings.mjs')).href);
    const violations = [];
    // PR #6148 send-back: the default reserve must not prevent two finished claims from settling.
    // Include bornAs aliases: each complete status read needs four searches, not just two.
    for (const prefetch of [false, true]) {
      const claims = ['8300', '8301'].map((num, i) => ({ meta: { num }, bornAs: `xlow00${i}` }));
      const blobs = claims.map(({ meta: { num }, bornAs }) => {
        const body = Buffer.from(`---\nbornAs: ${bornAs}\nstatus: open\n---\nfinished ${num}`);
        const sha = createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
        return { num, body, sha };
      });
      let calls = 0;
      const exec = (cmd, args, opts) => {
        if (cmd === 'git' && args[0] === 'fetch') return '';
        if (cmd === 'git' && args[0] === 'ls-tree') return blobs.map(b => `100644 blob ${b.sha}\tbacklog/${b.num}-card.md\n`).join('');
        if (cmd === 'git' && args[0] === 'cat-file') return Buffer.concat(String(opts.input).trim().split('\n').map(sha => {
          const b = blobs.find(b => b.sha === sha);
          return Buffer.concat([Buffer.from(`${sha} blob ${b.body.length}\n`), b.body, Buffer.from('\n')]);
        }));
        if (cmd === 'gh' && args[0] === 'pr') {
          calls++;
          const search = args[args.indexOf('--search') + 1];
          const claim = claims.find(c => search === `head:lane/${c.meta.num}`);
          return JSON.stringify(claim ? [{ number: Number(claim.meta.num), state: 'CLOSED',
            headRefName: `lane/${claim.meta.num}-prepare-x`, createdAt: '2026-11-01T00:00:00Z', isCrossRepository: false }] : []);
        }
        throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
      };
      const policy = resolvePreparePolicy({ env: { WE_PREPARE_MAX_PR_LISTING_CALLS_PER_TICK: '16' } });
      const r = createPrepareStatusReader({ maxPrListingCalls: policy.maxPrListingCallsPerTick,
        launchReserve: policy.launchPrListingReserve, exec, ...(prefetch ? { execAsync: async (...args) => exec(...args) } : {}) });
      const released = [];
      const tick = await runBuildDispatchTick({ live: true, effects: {
        planTick: () => ({ decisions: { itemPrepareSpawns: [] }, nextState: {} }),
        preparePolicy: () => policy,
        fetchOpenPrs: () => [], listClaims: () => [], listRunStoreInFlight: () => [], killSwitch: () => ({ engaged: false }),
        listPrepareClaims: () => claims, listPrepareInFlight: () => [],
        primePrepareStatus: () => r.prime(claims.map(c => ({ num: c.meta.num }))),
        readPrepareStatus: args => r.read(args), listPreparePrs: args => r.listPrs(args),
        releasePrepareClaim: ({ num }) => released.push(num), placePrepareHold: () => {},
        recordPrepareFailure: () => ({ cause: 'infra-transient', retry: true, held: false }),
      } });
      if (released.sort().join() !== '8300,8301' || tick.prepare.inFlight.length || calls !== 8) {
        violations.push(`small-budget settlement (prefetch=${prefetch}): released [${released}], busy [${tick.prepare.inFlight}], calls=${calls}, failures=${JSON.stringify(tick.prepare.failures)}`);
      }
    }
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
