/** PR #5486: exercise the public body writer and settled-batch status/retirement path. */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPrepareBatch } from '../../../operations/prepare-batch.mjs';
import { realIo, openPrArgv, gateFailureDetail } from '../../../operations/probation-build-run.mjs';
import { createPrepareStatusReader, runBuildDispatchTick } from '../../../../skills-src/conveyor/build-dispatch-daemon.mjs';

export default {
  id: 'prepare-batch-publication-boundaries',
  title: 'Batch diagnostics are redacted and published batch PRs retain prepare identity',
  card: 'PR #5486',
  fixedBy: { sha: 'HEAD', where: 'lane/prepare-throughput', paths: [
    'scripts/operations/probation-build-run.mjs', 'scripts/operations/prepare-batch.mjs',
    'scripts/conveyor/prepare-pr-match.mjs', 'skills-src/conveyor/build-dispatch-daemon.mjs',
  ] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/conveyor/prepare-pr-match.mjs'), 'utf8').includes('batchMembers')
      && readFileSync(join(root, 'scripts/operations/probation-build-run.mjs'), 'utf8').includes('sanitizeForPublicComment(groupDropReasons')
      && readFileSync(join(root, 'skills-src/conveyor/build-dispatch-daemon.mjs'), 'utf8').includes('const awaitingStampedPr');
  },
  async run({ log } = {}) {
    const problems = [];
    const dir = mkdtempSync(join(tmpdir(), 'prepare-batch-publication-'));
    const previousCache = process.env.WE_PR_SNAPSHOT_DIR;
    process.env.WE_PR_SNAPSHOT_DIR = dir;
    try {
      // A failed worker's diagnostic traverses the coordinator and the real production body writer.
      const secrets = [`ghp_${'a'.repeat(36)}`, 'fixture-password-123', 'fixture-key-456'];
      let assembledRef, published;
      const io = {
        log: () => {}, findItem: num => ({ path: `backlog/${num}-card.md` }),
        retainPrepareCommit: () => {}, startPrepareAssembly: () => {},
        finishPrepareAssembly: (_dir, ref) => { assembledRef = ref; },
        cherryPickPrepare: () => ({ ok: true }), runGate: () => ({ pass: true }),
        writePrBody: realIo().writePrBody,
        openPr: args => { published = args; return { ok: true, pr: 99 }; },
      };
      const args = { num: '7201', groupMembers: ['7202'], session: 'publication-test',
        worker: { executor: 'codex', model: 'fixture', id: 'fixture' } };
      const result = await runPrepareBatch(args, io, { batchParallel: true, batchMaxParallel: 2 },
        async ({ num }) => num === '7201'
          ? { outcome: 'gate-red', detail: `worker failed: Authorization: Bearer ${secrets[0]}\npassword="${secrets[1]}"\r\n--api-key '${secrets[2]}'` }
          : { outcome: 'prepared-commit', num, lanePath: dir, sha: 'commit', baseSha: 'base' });
      const body = readFileSync(published.bodyFile, 'utf8');
      if (result.outcome !== 'opened-pr' || !body.includes('Not prepared: #7201')) problems.push('partial batch did not publish failure diagnostics');
      if (secrets.some(secret => body.includes(secret))) problems.push('public PR body contains failed worker credentials');
      const declineBody = readFileSync(realIo().writePrBody(dir, { ...args,
        declinedReason: `worker declined: password="${secrets[1]}"` }), 'utf8');
      if (declineBody.includes(secrets[1])) problems.push('public declined-worker body contains credentials');
      // This cut would retain only the token's tail if realIo shortened the output before redacting.
      const worker = await realIo().runWorker(['--eval',
        `process.stdout.write(${JSON.stringify(`${secrets[0]} ${'z'.repeat(3980)}`)}); process.exitCode = 1;`], dir);
      if (worker.ok || worker.out.includes('a'.repeat(20))) problems.push('worker output truncation retained an unrecognizable credential tail');
      const gateDetail = gateFailureDetail(`FAIL ${'z'.repeat(1484)} ${secrets[0]}`);
      if (gateDetail.includes('ghp_')) problems.push('gate diagnostic truncated a credential before redaction');
      const argv = openPrArgv(published);
      if (assembledRef !== 'lane/prepare-batch-7202-1' || !argv.includes(`--ref=${assembledRef}`)) problems.push('dropped lead left inconsistent batch branch identity');

      // Main has no stamps; each card in the shared PR does. Drive the actual reader and daemon settlement.
      const plain = Buffer.from('---\nstatus: open\n---\nNot prepared on main.\n');
      const sha = createHash('sha1').update(`blob ${plain.length}\0`).update(plain).digest('hex');
      const prepared = Buffer.from('---\nstatus: open\npreparedDate: 2026-10-17\n---\nPrepared in batch.\n');
      for (const ids of [['7201', '7202'], ['7202'], ['7201']]) {
        const originalIds = ['7201', '7202'];
        const dropped = originalIds.filter(num => !ids.includes(num));
        const pr = { number: ids.length + 90, state: 'OPEN', headRefName: `lane/prepare-batch-${ids[0]}-${ids.length}`,
          title: `prepare: ${ids.join(', ')}`, headRefOid: String(ids.length).repeat(40),
          createdAt: '2026-10-17T12:00:00Z', isCrossRepository: false };
        const reader = createPrepareStatusReader({ exec(cmd, callArgs) {
          if (cmd === 'git' && callArgs[0] === 'fetch') return '';
          if (cmd === 'git' && callArgs[0] === 'ls-tree') return originalIds.map(num => `100644 blob ${sha}\tbacklog/${num}-card.md\n`).join('');
          if (cmd === 'git' && callArgs[0] === 'cat-file') return Buffer.concat([Buffer.from(`${sha} blob ${plain.length}\n`), plain, Buffer.from('\n')]);
          if (cmd === 'gh' && callArgs[0] === 'pr') return JSON.stringify([pr]);
          if (cmd === 'gh' && callArgs[0] === 'api') return JSON.stringify({ content: prepared.toString('base64') });
          throw new Error(`unexpected fixture command ${cmd}`);
        } });
        for (const num of ids) if (reader.read({ num }).pr?.number !== pr.number) problems.push(`status reader missed batch member ${num}`);
        const failures = [], holds = [], released = [];
        const tick = await runBuildDispatchTick({ live: true, effects: {
          now: () => Date.parse('2026-10-17T13:00:00Z'),
          planTick: () => ({ decisions: { itemPrepareSpawns: [] }, nextState: {} }),
          fetchOpenPrs: () => [], listClaims: () => [], listRunStoreInFlight: () => [],
          killSwitch: () => ({ engaged: false }), listHolds: () => [],
          listPrepareClaims: () => originalIds.map((num, index) => ({ meta: { num,
            ...(index ? { groupLead: originalIds[0] } : {}), claimedAt: '2026-10-17T11:00:00Z' } })),
          listSettledPrepares: () => [{ num: originalIds[0], groupMembers: originalIds.slice(1),
            groupDropped: dropped, groupDropReasons: Object.fromEntries(dropped.map(num => [num, 'gate failed'])),
            outcome: 'opened-pr', pr: pr.number,
            startedAt: '2026-10-17T11:00:00Z', source: `run batch-${ids.length}` }],
          listPreparePrs: input => reader.listPrs(input), readPrepareStatus: input => reader.read(input),
          recordPrepareFailure: input => { failures.push(input); return { ...input, held: true }; },
          placePrepareHold: input => holds.push(input), releasePrepareClaim: input => released.push(input),
        } });
        if ([...failures, ...holds, ...tick.prepare.failures].some(row => ids.includes(row.num))) problems.push('successful batch recorded an unstamped failure or hold');
        if ([...released, ...tick.prepare.retired].some(row => ids.includes(row.num))) problems.push('successful open batch retired a prepare claim');
        if (dropped.some(num => !holds.some(row => row.num === num))) problems.push('failed card escaped its normal failure hold');
      }
      log?.(JSON.stringify(problems));
      return { problems };
    } finally {
      if (previousCache === undefined) delete process.env.WE_PR_SNAPSHOT_DIR;
      else process.env.WE_PR_SNAPSHOT_DIR = previousCache;
      rmSync(dir, { recursive: true, force: true });
    }
  },
  judge: report => report.problems,
};
