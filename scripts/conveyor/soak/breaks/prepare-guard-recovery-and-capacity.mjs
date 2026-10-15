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
    const daemon = readFileSync(resolve(root, DAEMON), 'utf8');
    return daemon.includes('const stampedOpenPr =') && daemon.includes('PREPARE_REFUSAL_HOLD_MS')
      && daemon.includes('refusePrepareLaunch(member') && daemon.includes('refusalProbes');
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
    // Round 5: the REAL tick-core offers at most two item prepares, so a stub offering three cannot show starvation.
    const { planTick } = await import(resolve(ROOT, 'scripts/conveyor/tick-core.mjs'));
    for (const kind of ['open PR', 'park']) {
      const effects = fixture();
      let nowMs = Date.parse('2026-10-15T12:00:00Z');
      effects.now = () => nowMs;
      const pending = ['5028', '5029', '5030'];
      effects.planTick = (bk, { config } = {}) => planTick({
        state: { queue: pending.map(num => ({ num })), lanes: [], prs: [] },
        plan: { launch: [], held: pending.map(num => ({ num, reason: 'needs-prepare' })) },
        freeLanes: [1, 2, 3, 4, 5, 6], bookkeeping: bk, config: { maxConcurrentLanes: 1_000_000, ...config },
      });
      if (kind === 'park') {
        effects.listPrepareFailures = () => ['5028', '5029'].map(num => ({ num, held: true,
          recordedAt: '2026-10-14', holdReason: 'needs-you: decide scope' }));
      } else {
        effects.listPreparePrs = ({ num }) => num === '5030' ? []
          : [{ number: Number(num), state: 'OPEN', headRefName: `lane/${num}d-prepare-x` }];
      }
      let bookkeeping = {};
      let cleanLaunched = false;
      for (let i = 0; i < 3; i++) {
        const tick = await runBuildDispatchTick({ live: true, effects, bookkeeping });
        cleanLaunched ||= tick.prepare.launched.some(r => r.num === '5030');
        bookkeeping = tick.nextBookkeeping;
        nowMs += 60_000;
      }
      if (!cleanLaunched) problems.push(`two persistently refused ${kind} cards starved the clean third under the real tick-core`);
    }
    // Operator send-back item 1: a group member with its own OPEN prepare PR was claimed under a clean lead.
    {
      const effects = fixture(['7201']);
      const nums = ['7201', '7202', '7203', '7204'];
      const rows = nums.map((num, i) => ({ num, kind: 'story', size: 1, parent: '7200', locus: 'we',
        scope: [`we:scripts/prepare/file${i}.mjs`] }));
      effects.planTick = () => ({ decisions: { spawnPrepareItems: [rows[0]], admission: { queue: rows, cleared: [],
        held: rows.map(r => ({ num: r.num, reason: 'needs-prepare' })) } }, nextState: {} });
      effects.loadGroupingCards = () => rows;
      effects.readPreparedStamp = () => ({ preparedDate: null });
      const claimed = [];
      effects.acquirePrepareClaim = ({ num }) => { claimed.push(num); return { ok: true }; };
      effects.listPreparePrs = ({ num }) => num === '7203'
        ? [{ number: 93, state: 'OPEN', headRefName: 'lane/7203d-prepare-x' }] : [];
      const tick = await runBuildDispatchTick({ live: true, effects });
      if (!tick.prepare.groups.some(g => g.members.includes('7203'))) problems.push('grouped member scenario did not form a group');
      if (claimed.includes('7203')) problems.push('group member with an OPEN prepare PR was claimed under a clean lead');
    }
    // Operator send-back item 2: an untracked card refused for its OPEN, sectioned, unstamped PR was never stamped.
    {
      const effects = fixture();
      effects.now = () => Date.parse('2026-10-15T12:00:00Z');
      effects.listPreparePrs = () => [{ number: 91, state: 'OPEN', headRefName: 'lane/5028d-prepare-x' }];
      effects.readPrepareStatus = () => ({ preparedDate: null, pr: { state: 'OPEN', number: 91, preparedDate: null, hasSections: true } });
      let stamps = 0;
      effects.stampPrepare = () => { stamps++; return { spawned: true }; };
      let bookkeeping = {};
      for (let i = 0; i < 2; i++) bookkeeping = (await runBuildDispatchTick({ live: true, effects, bookkeeping })).nextBookkeeping;
      if (stamps !== 1) problems.push(`untracked refused card with a sectioned unstamped OPEN PR stamped ${stamps}x (want 1)`);
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
