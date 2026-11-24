/** Card 408 / PR 7336: a merge-gate red held only by red-main-freeze must not count as a previous-CI failure. */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
export default {
  id: 'ci-freeze-hold-gate',
  title: 'push-after-CI gate does not treat a red-main-freeze merge-gate hold as a CI failure',
  card: 'cards-to-file 408 (PR 7336)',
  fixedBy: { sha: 'HEAD', where: 'lane/ci-freeze-hold-gate', paths: ['scripts/conveyor/await-verify-pass.mjs'] },
  // Presence is decided by the behaviour `run` replays below (the break is expected green on a tree that carries it).
  fixPresent() { return true; },
  async run({ sourceRoot = ROOT, log } = {}) {
    const { runAwaitVerifyPass, excusePreviousCiChecks } = await import(pathToFileURL(join(sourceRoot, 'scripts/conveyor/await-verify-pass.mjs')).href);
    const now = Date.parse('2026-11-23T12:00:00Z');
    const sha = 'a'.repeat(40);
    const prev = 'b'.repeat(40);
    let record = { v: 1, kind: 'fix', pr: 7336, repo: 'freeze-fixture/example', sha, sessionId: 'fix-7336', who: 'fix-7336',
      lane: '/lanes/lane-1', ref: 'lane/freeze-fixture', requestedAt: new Date(now).toISOString(), attempt: 1 };
    const violations = [];
    let pushes = 0, resumes = 0;
    const gate = { name: 'merge-gate', status: 'completed', conclusion: 'failure', details_url: 'https://github.com/o/r/actions/runs/1/job/42' };
    const io = {
      pushPolicy: () => ({ pushBeforeGate: true }),
      fixTimingPolicy: () => ({ pushAfterCi: true, pushAfterCiMaxMin: 2 }),
      readPreviousHead: () => prev,
      readPreviousChecks: () => [{ name: 'test', status: 'completed', conclusion: 'success' }, { ...gate }],
      readPreviousRequired: () => ({ checks: ['test', 'merge-gate'] }),
      excusePreviousChecks: ({ checks, headSha }) => excusePreviousCiChecks({ checks, prNumber: 7336, headSha, labels: [], setting: 'on',
        readVerdict: () => ({ num: 7336, head_sha: headSha, ok: false, results: [{ id: 'red-main-freeze', status: 'hold', reason: 'main is RED' }] }),
        freeze: () => ({ frozen: true }) }),
      listRecords: () => record ? [{ key: 'fix-7336', record }] : [],
      writeRecord: next => { record = next; return { ok: true }; },
      clearRecord: () => { record = null; },
      laneState: () => ({ head: sha, dirty: false, treeHash: 'tree' }),
      readMarker: () => ({ sha, status: 'running', startedAt: new Date(now).toISOString(), treeHash: 'tree' }),
      listSessions: () => [{ sessionId: 'fix-7336', state: 'done' }],
      push: () => { pushes++; return { ok: true }; },
      resume: () => { resumes++; return { resumed: true }; },
    };
    await runAwaitVerifyPass({ io, nowMs: now });
    log?.(`freeze-only merge-gate hold: pushes=${pushes} resumes=${resumes}`);
    if (pushes !== 1) violations.push(`expected the push to proceed past a freeze-only hold, got ${pushes} pushes`);
    if (resumes) violations.push('a freeze-only merge-gate hold was handed to the fixer as a CI failure');
    return { violations };
  },
  judge: report => report.violations,
};
