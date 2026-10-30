/** PR #6085: Claude marks verify directly, bypassing the Codex fix-run CI wait. */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
export default {
  id: 'claude-fix-push-after-ci',
  title: 'Claude verify harness waits for previous-head CI before pushing',
  card: 'PR #6085 red-team send-back',
  fixedBy: { sha: 'HEAD', where: 'lane/ci-parallel-settings', paths: ['scripts/conveyor/await-verify-pass.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/conveyor/await-verify-pass.mjs'), 'utf8').includes('function previousCiPushGate(');
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const { runAwaitVerifyPass } = await import(pathToFileURL(join(sourceRoot, 'scripts/conveyor/await-verify-pass.mjs')).href);
    const now = Date.parse('2026-10-29T12:00:00Z');
    const sha = 'a'.repeat(40);
    let record = { v: 1, kind: 'fix', pr: 6085, repo: 'ci-wait-fixture/example', sha,
      sessionId: 'claude-fix', who: 'fix-6085', lane: '/lanes/lane-49', ref: 'lane/ci-parallel-settings',
      requestedAt: new Date(now).toISOString(), attempt: 1 };
    const violations = [];
    let pushes = 0;
    let complete = false;
    const io = {
      pushPolicy: () => ({ pushBeforeGate: true }),
      fixTimingPolicy: () => ({ pushAfterCi: true, pushAfterCiMaxMin: 2 }),
      readPreviousHead: () => 'b'.repeat(40),
      readPreviousChecks: () => [{ name: 'test', status: complete ? 'completed' : 'in_progress', conclusion: complete ? 'success' : null }],
      readPreviousRequired: () => ({ checks: ['test'] }),
      listRecords: () => record ? [{ key: 'claude-fix', record }] : [],
      writeRecord: next => { record = next; return { ok: true }; },
      clearRecord: () => { record = null; },
      laneState: () => ({ head: sha, dirty: false, treeHash: 'tree' }),
      readMarker: () => ({ sha, status: 'running', startedAt: new Date(now).toISOString(), treeHash: 'tree' }),
      listSessions: () => [{ sessionId: 'claude-fix', state: 'done' }],
      push: () => { pushes++; return { ok: true }; },
      resume: () => ({ resumed: true }),
    };
    for (const elapsed of [0, 30_000, 60_000]) {
      await runAwaitVerifyPass({ io, nowMs: now + elapsed });
      log?.(`Claude verify running, previous CI pending at ${elapsed}: pushes=${pushes}`);
      if (pushes) violations.push(`Claude pushed before previous CI finished at ${elapsed}`);
    }
    complete = true;
    await runAwaitVerifyPass({ io, nowMs: now + 90_000 });
    if (pushes !== 1) violations.push(`expected one push after previous CI completed, got ${pushes}`);
    return { violations };
  },
  judge: report => report.violations,
};
