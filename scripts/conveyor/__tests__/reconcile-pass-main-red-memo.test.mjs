import * as nodeTest from 'node:test';
import assert from 'node:assert/strict';
import * as pass from '../reconcile-pass.mjs';

const { test, beforeEach } = process.env.VITEST ? await import('vitest') : nodeTest;
beforeEach(() => pass.resetMainRedMemo());

function fixture() {
  const calls = { ahead: 0, green: 0, signature: 0, runs: 0, latest: 0, job: 0 };
  const pr = { number: 1, headRefOid: 'head', statusCheckRollup: [{ name: 'test',
    status: 'COMPLETED', conclusion: 'FAILURE', completedAt: '2026-10-01T00:00:00Z',
    detailsUrl: 'https://github.com/memo/repo/actions/runs/1/job/2' }] };
  let runs = [{ headSha: 'main', status: 'queued', createdAt: '2026-10-02T00:00:00Z' }];
  const options = { repo: 'memo/repo', requiredChecks: ['test'],
    readMainRuns: () => { calls.runs++; return runs; },
    readMainLatestCheckRuns: () => { calls.latest++; return [{ name: 'test',
      status: 'completed', conclusion: 'success', head_sha: 'green' }]; },
    readAheadBy: () => { calls.ahead++; return 3; },
    readMainGreenFixFacts: () => { calls.green++; return { prContainsMainGreenSha: true, mergeBaseCheckRuns: null }; },
    readMainFixedSignatureFacts: () => { calls.signature++; return { signatures: [] }; },
    readJobAttempt: () => { calls.job++; return 1; }, readBudget: () => null };
  return { calls, pr, options, tick: () => pass.enrichPrsWithMainRedFacts([pr], options),
    setRuns: value => { runs = value; } };
}

test('a newly queued main SHA misses ahead and signature memo despite an older completed run', () => {
  const f = fixture(); f.tick();
  f.setRuns([{ headSha: 'old', status: 'completed', conclusion: 'success', createdAt: '2026-09-01' },
    { headSha: 'new', status: 'queued', createdAt: '2026-10-03' }]);
  f.tick();
  assert.equal(f.calls.ahead, 2); assert.equal(f.calls.signature, 2);
});

test('a rerun with a new job, run id, or completedAt misses signature memo', () => {
  const f = fixture(); f.tick();
  const check = f.pr.statusCheckRollup[0];
  check.detailsUrl = check.detailsUrl.replace('/job/2', '/job/3'); f.tick();
  check.detailsUrl = check.detailsUrl.replace('/runs/1', '/runs/4'); f.tick();
  check.completedAt = '2026-10-01T01:00:00Z'; f.tick();
  assert.equal(f.calls.signature, 4);
});

test('in-progress or unfinished merge-base check rows are never stored', () => {
  for (const row of [{ status: 'in_progress', conclusion: 'success' }, { status: 'queued', conclusion: null }]) {
    pass.resetMainRedMemo();
    const f = fixture();
    f.options.readMainGreenFixFacts = () => { f.calls.green++; return {
      prContainsMainGreenSha: false, mergeBaseCheckRuns: [row] }; };
    f.tick(); f.tick(); assert.equal(f.calls.green, 2);
  }
});

test('failed ahead, all-null green-fix, and null signature reads are retried', () => {
  const f = fixture();
  f.options.readAheadBy = () => { f.calls.ahead++; return null; };
  f.options.readMainGreenFixFacts = () => { f.calls.green++; return {
    prContainsMainGreenSha: null, mergeBaseCheckRuns: null, mergeBaseRunConclusion: null }; };
  f.tick(); f.tick(); assert.equal(f.calls.ahead, 2); assert.equal(f.calls.green, 2);
  f.options.readAheadBy = () => 3;
  f.options.readMainFixedSignatureFacts = () => { f.calls.signature++; return null; };
  f.tick(); f.tick(); assert.equal(f.calls.signature, 2);
});

test('same inputs reuse all three successful reads with injected readers', () => {
  const f = fixture(); const first = f.tick(); assert.deepEqual(f.tick(), first);
  assert.deepEqual(f.calls, { ahead: 1, green: 1, signature: 1, runs: 2, latest: 2, job: 0 });
});

test('missing main SHA never memoizes ahead or signature; non-finite ahead is retried', () => {
  const f = fixture(); f.setRuns([]); f.tick(); f.tick();
  assert.equal(f.calls.ahead, 2); assert.equal(f.calls.signature, 2);
  f.setRuns([{ headSha: 'main' }]);
  f.options.readAheadBy = () => { f.calls.ahead++; return Infinity; };
  f.tick(); f.tick(); assert.equal(f.calls.ahead, 4);
});

test('repo, head, green SHA and check name isolate memo entries', () => {
  const f = fixture(); f.tick();
  f.options.repo = 'memo/other'; f.tick();
  f.pr.headRefOid = 'other-head'; f.tick();
  f.options.readMainLatestCheckRuns = () => [{ name: 'test', conclusion: 'success', head_sha: 'green2' }]; f.tick();
  f.options.requiredChecks = ['smoke']; f.pr.statusCheckRollup[0].name = 'smoke';
  f.options.readMainLatestCheckRuns = () => [{ name: 'smoke', conclusion: 'success', head_sha: 'green2' }]; f.tick();
  assert.equal(f.calls.ahead, 3); assert.equal(f.calls.green, 5); assert.equal(f.calls.signature, 2);
});

test('each memo evicts its oldest entry after 500; reset clears all entries', () => {
  const f = fixture();
  const check = f.pr.statusCheckRollup[0]; const url = check.detailsUrl;
  for (let i = 0; i <= 500; i++) {
    f.pr.headRefOid = `head-${i}`; check.detailsUrl = url.replace('/job/2', `/job/${i + 10}`); f.tick();
  }
  f.pr.headRefOid = 'head-1'; check.detailsUrl = url.replace('/job/2', '/job/11'); f.tick();
  assert.equal(f.calls.ahead, 501); assert.equal(f.calls.green, 501); assert.equal(f.calls.signature, 501);
  f.pr.headRefOid = 'head-0'; check.detailsUrl = url.replace('/job/2', '/job/10'); f.tick();
  assert.equal(f.calls.ahead, 502); assert.equal(f.calls.green, 502); assert.equal(f.calls.signature, 502);
  pass.resetMainRedMemo(); f.tick();
  assert.equal(f.calls.ahead, 503); assert.equal(f.calls.green, 503); assert.equal(f.calls.signature, 503);
});

test('completed merge-base rows can be stored; job attempts remain live', () => {
  const f = fixture();
  f.setRuns([{ headSha: 'main', status: 'completed', conclusion: 'success', updatedAt: '2026-10-03' }]);
  f.options.readMainGreenFixFacts = () => { f.calls.green++; return {
    prContainsMainGreenSha: true, mergeBaseCheckRuns: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] }; };
  f.tick(); f.tick(); assert.equal(f.calls.green, 1); assert.equal(f.calls.job, 2);
});

test('soak scenario observes one call per slow reader across two ticks', async () => {
  const { default: b } = await import('../soak/breaks/review-speed-main-red-reads-not-memoized.mjs');
  assert.deepEqual(b.judge(await b.run()), []);
});
