/** PR #5366 review: duplicate guards must preserve stamp recovery, capacity and complete discovery. */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const DAEMON = 'skills-src/conveyor/build-dispatch-daemon.mjs';

export default {
  id: 'prepare-guard-recovery-and-capacity',
  title: 'Prepare duplicate guards strand recovery, consume slots and miss alternate PR identities',
  card: '347 / PR 5366',
  fixedBy: { sha: 'HEAD', where: 'lane/prepare-dup-guard', paths: [DAEMON] },
  fixPresent(root) {
    return readFileSync(resolve(root, DAEMON), 'utf8').includes('const stampedOpenPr =');
  },
  async run() {
    const { runBuildDispatchTick, createPrepareStatusReader } = await import(resolve(ROOT, DAEMON));
    const cache = mkdtempSync(resolve(tmpdir(), 'soak-prepare-guard-'));
    const previousCache = process.env.WE_PR_SNAPSHOT_DIR;
    process.env.WE_PR_SNAPSHOT_DIR = cache;
    try {
    const problems = [];
    function fixture(nums = ['5028']) {
      return {
        planTick: () => ({ decisions: { itemPrepareSpawns: nums.map(num => ({ num })) }, nextState: {} }),
        fetchOpenPrs: () => [], listClaims: () => [], listRunStoreInFlight: () => [],
        killSwitch: () => ({ engaged: false }), listPreparePrs: () => [],
        acquirePrepareClaim: () => ({ ok: true }), releasePrepareClaim: () => {},
        dispatch: () => ({ dispatching: true }), placePrepareHold: () => {},
      };
    }
    for (const hasSections of [false, true]) {
      const effects = fixture();
      const holds = [], stamps = [];
      effects.listPrepareInFlight = () => [{ num: '5028', row: { runId: 'dead', entry: {
        key: 'dead', live: false, expectedBy: '2020-01-01',
      } } }];
      effects.readPrepareStatus = () => ({ preparedDate: null, pr: { state: 'OPEN', preparedDate: null, hasSections } });
      effects.placePrepareHold = hold => holds.push(hold.reason);
      effects.stampPrepare = ({ num }) => { stamps.push(num); return { spawned: true }; };
      const tick = await runBuildDispatchTick({ live: true, effects });
      if (!holds.includes(hasSections ? 'prepare-stamp-pending' : 'prepare-unstamped')
        || stamps.length !== Number(hasSections) || tick.prepare.inFlight.includes('5028')) {
        problems.push(`dead OPEN unstamped PR stranded (sections=${hasSections})`);
      }
    }
    const parked = fixture(['5028', '5029', '5030']);
    parked.listPrepareFailures = () => ['5028', '5029'].map(num => ({ num, held: true,
      recordedAt: '2026-10-14', holdReason: 'needs-you: decide scope' }));
    for (let i = 0; i < 2; i++) {
      const tick = await runBuildDispatchTick({ live: true, effects: parked });
      if (!tick.prepare.launched.some(r => r.num === '5030')) problems.push('two persistent refusals starved the clean successor');
    }
    const missing = fixture();
    delete missing.listPreparePrs;
    const closed = await runBuildDispatchTick({ live: true, effects: missing });
    if (closed.prepare.launched.length || !closed.prepare.refused.some(r => r.reason === 'prepare PR listing unavailable')) {
      problems.push('missing PR listing effect allowed dispatch');
    }
    const card = Buffer.from('---\nstatus: open\nbornAs: abc.12\n---\nquery-aware prepare guard');
    const sectioned = Buffer.from('---\nstatus: open\n---\n' + ['Design', 'MVP', 'Test plan', 'Proof plan']
      .map(heading => `## ${heading}\nCompleted substantive work.\n`).join('\n'));
    const sha = createHash('sha1').update(`blob ${card.length}\0`).update(card).digest('hex');
    for (const fallback of [false, true]) for (const [headRefName, title, bornAs] of [
      ['custom-prepare-x', 'WE #5028: prepare — scope', undefined],
      ['lane/1234d-prepare-x', 'ordinary', '1234'],
      ['lane/abc.12d-prepare-x', 'ordinary', undefined], // real settlement callers pass only num
    ]) {
      const pr = { number: 95028, state: 'OPEN', headRefName, title, createdAt: '2026-10-10', headRefOid: '9'.repeat(40) };
      const reader = createPrepareStatusReader({ exec(cmd, args) {
        if (cmd === 'git' && args[0] === 'fetch') return '';
        if (cmd === 'git' && args[0] === 'ls-tree') return `100644 blob ${sha}\tbacklog/5028-card.md\n`;
        if (cmd === 'git' && args[0] === 'cat-file') return Buffer.concat([Buffer.from(`${sha} blob ${card.length}\n`), card, Buffer.from('\n')]);
        if (cmd === 'gh' && args[0] === 'api') return JSON.stringify({ content: sectioned.toString('base64') });
        if (cmd === 'gh' && args[0] === 'pr') {
          const search = args[args.indexOf('--search') + 1] ?? '';
          const head = /head:([^ ]+)/.exec(search)?.[1];
          const phrase = /"([^"]+)"/.exec(search)?.[1];
          const floor = /created:>=(\S+)/.exec(search)?.[1];
          return JSON.stringify((!head || headRefName.startsWith(head)) && (!phrase || title.includes(phrase))
            && (!floor || pr.createdAt >= floor) ? [pr] : []);
        }
        throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
      } });
      if (fallback) reader.prime([{ num: '5028', bornAs, claimedAt: '2026-10-14' }]);
      const effects = fixture();
      effects.planTick = () => ({ decisions: { itemPrepareSpawns: [{ num: '5028', bornAs }] }, nextState: {} });
      effects.listPreparePrs = args => reader.listPrs(args);
      effects.readPreparedStamp = args => reader.stamp(args);
      const tick = await runBuildDispatchTick({ live: true, effects });
      if (tick.prepare.launched.length || !tick.prepare.refused.some(r => r.reason.includes('open prepare PR'))) {
        problems.push(`missed ${title.startsWith('WE #') ? 'title-only' : 'bornAs'} PR (fallback=${fallback})`);
      }
      if (headRefName === 'lane/abc.12d-prepare-x') {
        const recovery = fixture([]);
        let stamps = 0;
        recovery.listPrepareInFlight = () => [{ num: '5028', row: { runId: 'alias', entry: {
          key: 'alias', live: false, expectedBy: '2020-01-01',
        } } }];
        recovery.readPrepareStatus = args => reader.read(args);
        recovery.stampPrepare = () => { stamps++; return { spawned: true }; };
        const recovered = await runBuildDispatchTick({ live: true, effects: recovery });
        if (stamps !== 1 || recovered.prepare.inFlight.includes('5028')) problems.push(`alias-only PR stamp recovery failed (fallback=${fallback})`);
      }
    }
    return { problems };
    } finally {
      if (previousCache === undefined) delete process.env.WE_PR_SNAPSHOT_DIR;
      else process.env.WE_PR_SNAPSHOT_DIR = previousCache;
      rmSync(cache, { recursive: true, force: true });
    }
  },
  judge: report => report.problems,
};
