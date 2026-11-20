/** Added seats must overlap the loop, and evidence must stay bound to the reviewed head. */
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ghRepoSlug } from '../../../lib/constellation-repos.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');

export function exercise(runReviewJob) {
  const violations = [];
  for (const moved of [false, true]) {
    const calls = [];
    const head = 'a'.repeat(40);
    const io = {
      root: '.', now: () => 1000, newActorId: () => 'test', readPrevCompletion: () => null,
      report: () => {}, claim: () => ({ ok: true }), updateRecord: () => {}, unclaim: () => {},
      acquireLane: () => ({ lanePath: '.' }), prepareLane: () => ({ head }), releaseLane: () => {}, log: () => {},
      liveHead: () => moved ? 'b'.repeat(40) : head,
      finalHeadSeatsSetting: () => ({ mode: 'off' }),
      concurrentSeatsSetting: () => ({ enabled: true, value: true, source: 'standard' }),
      startSpeculativeSeats: () => { calls.push('start'); return { readSink: 'sink', startedAt: Date.now() }; },
      runLoop: o => {
        calls.push('loop');
        if (o.readSink !== 'sink') violations.push('loop did not receive seats read sink');
        return { status: 0, stdout: JSON.stringify({ runId: 'test', stopped: 'complete', verdict: { verdict: 'accept', loop: { outcome: 'converged' } },
          findings: { read: { diffText: '+change', netBasis: { rev: head } } } }) };
      },
      awaitSpeculativeSeats: () => ({ spec: { status: 'speculated', rev: head } }),
      finishSpeculativeSeats: () => { calls.push('finish'); return { status: 'ran', seats: [] }; },
      cancelSpeculativeSeats: () => { calls.push('cancel'); return { reserved: { reservations: [{ callId: 'one' }] } }; },
      recordDiscardedSeats: () => { calls.push('spend'); return { status: 'recorded' }; }, cleanupSpeculativeSeats: () => calls.push('cleanup'),
      runExtraSeats: () => { calls.push('sequential'); return { status: 'ran', seats: [] }; },
    };
    const result = runReviewJob({ pr: 7, repo: ghRepoSlug('we'), pid: 1 }, io);
    const expected = moved ? ['start', 'loop', 'cancel', 'spend', 'cleanup'] : ['start', 'loop', 'finish', 'cleanup'];
    if (JSON.stringify(calls) !== JSON.stringify(expected)) violations.push(`moved=${moved}: wrong concurrent order ${calls.join(',')}`);
    if (result.extraSeats?.status !== (moved ? 'discarded' : 'ran')) violations.push(`moved=${moved}: incorrect evidence status`);
  }
  return { violations };
}

export default {
  id: 'added-seats-concurrent-head-binding',
  title: 'added seats overlap the review loop and discard evidence on a moved head',
  card: 'xbizuci added seats concurrency',
  fixedBy: { sha: 'HEAD', where: 'working tree', paths: ['scripts/operations/review-job.mjs', 'scripts/operations/review-extra-seats.mjs'] },
  fixPresent(root) {
    const probe = `import { exercise } from ${JSON.stringify(import.meta.url)};
      import { runReviewJob } from ${JSON.stringify(pathToFileURL(join(root, 'scripts/operations/review-job.mjs')).href)};
      process.stdout.write(JSON.stringify(exercise(runReviewJob)));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { cwd: root, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
    try { return r.status === 0 && JSON.parse(r.stdout).violations.length === 0; } catch { return false; }
  },
  async run({ sourceRoot = ROOT } = {}) {
    const { runReviewJob } = await import(pathToFileURL(join(sourceRoot, 'scripts/operations/review-job.mjs')).href);
    return exercise(runReviewJob);
  },
  judge: report => report.violations,
};
