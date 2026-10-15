/**
 * @file breaks/prepare-ended-open-pr-slot-and-title-write.mjs — PR #5366 review round 7, two daemon defects:
 *
 * 1. An ended prepare attempt whose PR was still OPEN and unstamped was re-added to the prepare slots after
 *    retirement. Two such cards (cap two) blocked every item prepare until an operator closed or stamped the PRs.
 * 2. The status reader accepted a same-repo PR on ANY branch whose title was `WE #<num>: prepare …`, and the
 *    retirement pass let that PR drive stamp recovery (`stampPrepare`) and claim retirement for a tracked card.
 *
 * Fix: an ended attempt always frees its slot (its OPEN PR already refuses the re-launch), and the status reader
 * uses the write-grade `isLanePreparePrFor` (lane branch required); the title stays refusal grade only.
 * The scenario runs the REAL live dispatch tick and the REAL status reader with in-memory git/gh answers.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const DAEMON = 'skills-src/conveyor/build-dispatch-daemon.mjs';
const MATCH = 'scripts/conveyor/prepare-pr-match.mjs';

const deadRow = num => ({ num, row: { runId: `dead-${num}`, entry: { key: `dead-${num}`, live: false, expectedBy: '2020-01-01' } } });

export default {
  id: 'prepare-ended-open-pr-slot-and-title-write',
  title: 'Ended prepares with OPEN PRs pin prepare slots; a title-only PR drives stamp recovery',
  card: '347 / PR 5366',
  fixedBy: { sha: 'HEAD', where: 'lane/prepare-dup-guard', paths: [DAEMON, MATCH] },
  fixPresent(root) {
    const daemon = readFileSync(resolve(root, DAEMON), 'utf8');
    return daemon.includes('isLanePreparePrFor(p, { num, bornAs })')
      && !daemon.includes('if (awaitingPr && !status.preparedDate) prepareBusy.add(num);');
  },
  async run() {
    const { runBuildDispatchTick, createPrepareStatusReader } = await import(resolve(ROOT, DAEMON));
    const cache = mkdtempSync(resolve(tmpdir(), 'soak-prepare-ended-'));
    const previousCache = process.env.WE_PR_SNAPSHOT_DIR;
    const previousError = console.error;
    process.env.WE_PR_SNAPSHOT_DIR = cache;
    console.error = () => {};
    const problems = [];
    const base = () => ({
      fetchOpenPrs: () => [], listClaims: () => [], listRunStoreInFlight: () => [],
      killSwitch: () => ({ engaged: false }), listPrepareClaims: () => [],
      acquirePrepareClaim: () => ({ ok: true }), releasePrepareClaim: () => {},
      dispatch: () => ({ dispatching: true }), placePrepareHold: () => {},
    });
    try {
      // 1. Two ended attempts with OPEN unsectioned PRs (a retryable failure, so no hold) and a clean third card.
      {
        const effects = base();
        effects.listPrepareInFlight = () => ['5028', '5029'].map(deadRow);
        effects.planTick = () => ({ decisions: { itemPrepareSpawns: ['5028', '5029', '5030'].map(num => ({ num })) }, nextState: {} });
        effects.readPrepareStatus = ({ num }) => ({ preparedDate: null,
          pr: { number: Number(num), state: 'OPEN', preparedDate: null, hasSections: false } });
        effects.listPreparePrs = ({ num }) => num === '5030' ? []
          : [{ number: Number(num), state: 'OPEN', headRefName: `lane/${num}-prepare-x` }];
        effects.recordPrepareFailure = input => ({ ...input, cause: 'infra-transient', retry: true, held: false });
        const tick = await runBuildDispatchTick({ live: true, effects });
        if (!tick.prepare.launched.some(r => r.num === '5030')) {
          problems.push(`two ended OPEN-PR prepares kept the slots (inFlight=${tick.prepare.inFlight.join(',')}); the clean card did not launch`);
        }
      }
      // 2. A tracked card (dead worker) whose only PR is a non-lane branch titled `WE #5028: prepare`, with sections.
      for (const state of ['OPEN', 'CLOSED']) {
        const plain = Buffer.from('---\nstatus: open\n---\nunprepared on main\n');
        const sectioned = Buffer.from('---\nstatus: open\n---\n' + ['Design', 'MVP', 'Test plan', 'Proof plan']
          .map(h => `## ${h}\nCompleted substantive work.\n`).join('\n'));
        const sha = createHash('sha1').update(`blob ${plain.length}\0`).update(plain).digest('hex');
        const pr = { number: 91, state, headRefName: 'someone/manual', title: 'WE #5028: prepare — manual',
          headRefOid: '9'.repeat(40), createdAt: '2026-10-14T12:00:00Z', isCrossRepository: false };
        const reader = createPrepareStatusReader({ exec(cmd, args) {
          if (cmd === 'git' && args[0] === 'fetch') return '';
          if (cmd === 'git' && args[0] === 'ls-tree') return `100644 blob ${sha}\tbacklog/5028-card.md\n`;
          if (cmd === 'git' && args[0] === 'cat-file') return Buffer.concat([Buffer.from(`${sha} blob ${plain.length}\n`), plain, Buffer.from('\n')]);
          if (cmd === 'gh' && args[0] === 'pr') return JSON.stringify([pr]);
          if (cmd === 'gh' && args[0] === 'api') return JSON.stringify({ content: sectioned.toString('base64') });
          throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
        } });
        const effects = base();
        effects.listPrepareInFlight = () => [deadRow('5028')];
        effects.planTick = () => ({ decisions: { itemPrepareSpawns: [] }, nextState: {} });
        effects.listPreparePrs = args => reader.listPrs(args);
        effects.readPrepareStatus = args => reader.read(args);
        let stamps = 0;
        effects.stampPrepare = () => { stamps++; return { spawned: true }; };
        const tick = await runBuildDispatchTick({ live: true, effects });
        if (stamps) problems.push(`title-only non-lane ${state} PR drove stamp recovery`);
        if (tick.prepare.retired.some(r => r.why === 'prepare PR closed')) problems.push(`title-only non-lane ${state} PR retired the claim`);
        if (!reader.listPrs({ num: '5028' }).some(p => p.number === 91)) problems.push('title-only PR no longer refuses a launch');
      }
      return { problems };
    } finally {
      console.error = previousError;
      if (previousCache === undefined) delete process.env.WE_PR_SNAPSHOT_DIR;
      else process.env.WE_PR_SNAPSHOT_DIR = previousCache;
      rmSync(cache, { recursive: true, force: true });
    }
  },
  judge: report => report.problems,
};
