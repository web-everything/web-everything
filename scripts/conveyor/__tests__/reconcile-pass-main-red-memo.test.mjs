import * as nodeTest from 'node:test';
import assert from 'node:assert/strict';
import * as pass from '../reconcile-pass.mjs';

const { test, beforeEach } = process.env.VITEST ? await import('vitest') : nodeTest;
beforeEach(() => pass.resetMainRedMemo());

function fixture() {
  const calls = { ahead: 0, green: 0, signature: 0, runs: 0, latest: 0, job: 0, tip: 0 };
  const pr = { number: 1, headRefOid: 'head', statusCheckRollup: [{ name: 'test',
    status: 'COMPLETED', conclusion: 'FAILURE', completedAt: '2026-10-01T00:00:00Z',
    detailsUrl: 'https://github.com/memo/repo/actions/runs/1/job/2' }] };
  let runs = [{ headSha: 'main', status: 'queued', createdAt: '2026-10-02T00:00:00Z' }];
  let tip = 'a'.repeat(40);
  const options = { repo: 'memo/repo', requiredChecks: ['test'],
    readMainTip: () => { calls.tip++; return tip; },
    readMainRuns: () => { calls.runs++; return runs; },
    readMainLatestCheckRuns: () => { calls.latest++; return [{ name: 'test',
      status: 'completed', conclusion: 'success', head_sha: 'green' }]; },
    readAheadBy: () => { calls.ahead++; return 3; },
    readMainGreenFixFacts: () => { calls.green++; return { prContainsMainGreenSha: true, mergeBaseCheckRuns: null }; },
    readMainFixedSignatureFacts: () => { calls.signature++; return { signatures: [] }; },
    readJobAttempt: () => { calls.job++; return 1; }, readBudget: () => null };
  return { calls, pr, options, tick: () => pass.enrichPrsWithMainRedFacts([pr], options),
    setTip: value => { tip = value; }, setRuns: value => { runs = value; } };
}

test('a live tip change misses ahead memo even when CI runs do not change', () => {
  const f = fixture(); f.tick();
  f.setTip('b'.repeat(40)); f.tick();
  assert.equal(f.calls.ahead, 2);
});

test('unchanged tip reuses ahead and stable ancestry; signatures are read every time', () => {
  const f = fixture(); const first = f.tick(); assert.deepEqual(f.tick(), first);
  assert.deepEqual(f.calls, { ahead: 1, green: 1, signature: 2, runs: 2, latest: 2, job: 0, tip: 2 });
});

test('CI run changes do not invalidate ahead memo for an unchanged tip', () => {
  const f = fixture(); f.tick();
  f.setRuns([{ headSha: 'new-run', status: 'queued', createdAt: '2026-10-03' }]); f.tick();
  assert.equal(f.calls.ahead, 1);
});

test('branch changes miss both memos and reach the tip reader', () => {
  const f = fixture(); const branches = [];
  f.options.readMainTip = ({ repo, branch }) => { branches.push([repo, branch]); return 'a'.repeat(40); };
  f.tick(); f.options.defaultBranch = 'release'; f.tick();
  assert.equal(f.calls.ahead, 2); assert.equal(f.calls.green, 2);
  assert.deepEqual(branches, [['memo/repo', 'main'], ['memo/repo', 'release']]);
});

test('tip is read once for multiple failing PRs and never when none fail', () => {
  const f = fixture();
  pass.enrichPrsWithMainRedFacts([], f.options);
  assert.equal(f.calls.tip, 0);
  pass.enrichPrsWithMainRedFacts([f.pr, { ...f.pr, number: 2, headRefOid: 'other' }], f.options);
  assert.equal(f.calls.tip, 1);
});

test('unknown tip never memoizes ahead', () => {
  const f = fixture(); f.setTip(null); f.tick(); f.tick();
  assert.equal(f.calls.ahead, 2);
});

test('injected ahead reader without tip reader remains uncached', () => {
  const f = fixture();
  delete f.options.readMainTip;
  const bases = [];
  f.options.readAheadBy = (_head, { base }) => { f.calls.ahead++; bases.push(base); return 3; };
  f.tick(); f.tick();
  assert.equal(f.calls.ahead, 2);
  assert.deepEqual(bases, ['main', 'main']);
  assert.equal(f.calls.tip, 0);
});

test('ahead comparison uses the resolved tip even when branch replication lags', () => {
  const f = fixture();
  const bases = [];
  f.options.readAheadBy = (head, { repo, base }) => pass.defaultReadAheadBy(head, {
    repo, base, exec: (_file, args) => {
      bases.push(args[3]);
      return args[3].endsWith('...main') ? '3' : '0';
    },
  });
  assert.equal(f.tick().prs[0].aheadByOnMain, 0);
  assert.equal(f.tick().prs[0].aheadByOnMain, 0);
  assert.deepEqual(bases, [`repos/memo/repo/compare/head...${'a'.repeat(40)}`]);
});

for (const field of ['detailsUrl', 'completedAt']) {
  test(`PR rerun changes ${field} but reuses immutable ahead and ancestry facts`, () => {
    const f = fixture(); f.tick();
    f.pr.statusCheckRollup[0][field] = field === 'detailsUrl'
      ? 'https://github.com/memo/repo/actions/runs/3/job/4' : '2026-10-04T00:00:00Z';
    f.tick();
    assert.equal(f.calls.ahead, 1); assert.equal(f.calls.green, 1);
    assert.equal(f.calls.signature, 2);
  });
}

for (const value of [null, Infinity, NaN]) {
  test(`unknown or non-finite ahead (${value}) is retried`, () => {
    const f = fixture();
    f.options.readAheadBy = () => { f.calls.ahead++; return value; };
    f.tick(); f.tick(); assert.equal(f.calls.ahead, 2);
  });
}

const success = { status: 'COMPLETED', conclusion: 'SUCCESS' };
for (const [name, facts] of [
  ['null facts', null],
  ['false ancestry with unread checks', { prContainsMainGreenSha: false, mergeBaseCheckRuns: null }],
  ['null ancestry with unread checks', { prContainsMainGreenSha: null, mergeBaseCheckRuns: null }],
  ['empty checks', { mergeBaseCheckRuns: [], mergeBaseRunConclusion: 'success' }],
  ['in-progress checks', { mergeBaseCheckRuns: [{ ...success, status: 'in_progress' }], mergeBaseRunConclusion: 'success' }],
  ['queued checks', { mergeBaseCheckRuns: [{ ...success, status: 'queued' }], mergeBaseRunConclusion: 'success' }],
  ['unread status', { mergeBaseCheckRuns: [{ conclusion: 'success' }], mergeBaseRunConclusion: 'success' }],
  ['failure conclusion', { mergeBaseCheckRuns: [success, { ...success, conclusion: 'failure' }], mergeBaseRunConclusion: 'failure' }],
  ['unread check conclusion', { mergeBaseCheckRuns: [{ status: 'completed', conclusion: null }], mergeBaseRunConclusion: 'success' }],
  ['null run conclusion', { mergeBaseCheckRuns: [success], mergeBaseRunConclusion: null }],
  ['missing run conclusion', { mergeBaseCheckRuns: [success] }],
]) {
  test(`green-fix never caches ${name}`, () => {
    const f = fixture();
    f.options.readMainGreenFixFacts = () => { f.calls.green++; return facts; };
    f.tick(); f.tick(); assert.equal(f.calls.green, 2);
  });
}

test('completed successful merge-base checks remain live; job attempts stay live', () => {
  const f = fixture();
  f.setRuns([{ headSha: 'main', status: 'completed', conclusion: 'success', updatedAt: '2026-10-03' }]);
  f.options.readMainGreenFixFacts = () => { f.calls.green++; return {
    prContainsMainGreenSha: false, mergeBaseCheckRuns: [success], mergeBaseRunConclusion: 'success' }; };
  f.tick(); f.tick(); assert.equal(f.calls.green, 2); assert.equal(f.calls.job, 2);
});

for (const conclusion of ['failure', 'cancelled', 'timed_out', 'neutral', 'skipped', 'success', null]) {
  test(`run conclusion ${conclusion} with successful check rows is retried`, () => {
    const f = fixture();
    f.options.readMainGreenFixFacts = () => { f.calls.green++; return {
      prContainsMainGreenSha: false, mergeBaseCheckRuns: [success], mergeBaseRunConclusion: conclusion,
    }; };
    f.tick(); f.tick(); assert.equal(f.calls.green, 2);
  });
}

for (const change of ['new run ID', 'changed completedAt', 'in-progress rerun', 'failed read']) {
  test(`${change} refreshes merge-base evidence with unchanged PR, head and main`, () => {
    const f = fixture();
    let facts = { prContainsMainGreenSha: false, mergeBaseCheckRuns: [
      { ...success, name: 'test', id: 1, completed_at: '2026-10-01T00:00:00Z' },
    ], mergeBaseRunConclusion: 'success' };
    f.options.readMainGreenFixFacts = () => { f.calls.green++; return facts; };
    assert.equal(f.tick().prs[0].mergeBaseCheckRuns[0].conclusion, 'SUCCESS');
    const row = { ...facts.mergeBaseCheckRuns[0], conclusion: 'failure' };
    if (change === 'new run ID') row.id = 2;
    if (change === 'changed completedAt') row.completed_at = '2026-10-04T00:00:00Z';
    if (change === 'in-progress rerun') { row.status = 'in_progress'; row.conclusion = null; }
    facts = { prContainsMainGreenSha: false,
      mergeBaseCheckRuns: change === 'failed read' ? null : [row], mergeBaseRunConclusion: null };
    const actual = f.tick().prs[0];
    assert.equal(f.calls.green, 2);
    assert.deepEqual(actual.mergeBaseCheckRuns, facts.mergeBaseCheckRuns);
    assert.equal(actual.mergeBaseRunConclusion, null);
    assert.equal(f.calls.ahead, 1);
  });
}

test('repo, head, green SHA and check name isolate memo entries', () => {
  const f = fixture(); f.tick();
  f.options.repo = 'memo/other'; f.tick();
  f.pr.headRefOid = 'other-head'; f.tick();
  f.options.readMainLatestCheckRuns = () => [{ name: 'test', conclusion: 'success', head_sha: 'green2' }]; f.tick();
  f.options.requiredChecks = ['smoke']; f.pr.statusCheckRollup[0].name = 'smoke';
  f.options.readMainLatestCheckRuns = () => [{ name: 'smoke', conclusion: 'success', head_sha: 'green2' }]; f.tick();
  assert.equal(f.calls.ahead, 3); assert.equal(f.calls.green, 5);
});

test('each memo evicts its oldest entry after 500; reset clears both', () => {
  const f = fixture();
  for (let i = 0; i <= 500; i++) { f.pr.headRefOid = `head-${i}`; f.tick(); }
  f.pr.headRefOid = 'head-1'; f.tick();
  assert.equal(f.calls.ahead, 501); assert.equal(f.calls.green, 501);
  f.pr.headRefOid = 'head-0'; f.tick();
  assert.equal(f.calls.ahead, 502); assert.equal(f.calls.green, 502);
  pass.resetMainRedMemo(); f.tick();
  assert.equal(f.calls.ahead, 503); assert.equal(f.calls.green, 503);
});

test('defaultReadAheadBy rejects empty or blank responses and preserves zero', () => {
  for (const out of ['', '  \n', null, undefined]) {
    assert.equal(pass.defaultReadAheadBy('head', { exec: () => out }), null);
  }
  assert.equal(pass.defaultReadAheadBy('head', { exec: () => '0\n' }), 0);
});

test('defaultReadMainTip reads the branch commit SHA with bounded execution', () => {
  for (const repo of ['memo/repo', null]) {
    const sha = 'a'.repeat(40);
    const actual = pass.defaultReadMainTip({ repo, branch: 'release', exec: (file, args, options) => {
      assert.equal(file, 'gh');
      assert.deepEqual(args, ['api', '--method', 'GET',
        `repos/${repo || '{owner}/{repo}'}/commits/release`, '--jq', '.sha']);
      assert.equal(options.killSignal, 'SIGKILL'); assert.ok(options.timeout > 0);
      assert.equal(options.encoding, 'utf8'); assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
      return `${sha}\n`;
    } });
    assert.equal(actual, sha);
  }
});

test('defaultReadMainTip rejects missing, malformed or failed reads', () => {
  for (const out of ['', ' ', null, 'a'.repeat(39), 'g'.repeat(40), 'a'.repeat(41)]) {
    assert.equal(pass.defaultReadMainTip({ exec: () => out }), null);
  }
  assert.equal(pass.defaultReadMainTip({ exec: () => { throw new Error('unreadable'); } }), null);
});

test('soak scenario reuses graph facts and refreshes independent merge-base reruns', async () => {
  const { default: b } = await import('../soak/breaks/review-speed-main-red-reads-not-memoized.mjs');
  assert.deepEqual(b.judge(await b.run()), []);
});

test('unchanged-main second tick completes under 15 seconds under controlled reader load', async () => {
  const { loadedMemoBenchmark } = await import('../soak/breaks/review-speed-main-red-reads-not-memoized.mjs');
  const result = await loadedMemoBenchmark();
  console.info(`enrich-main-red offline loaded benchmark: cold=${result.coldMs.toFixed(1)}ms warm=${result.warmMs.toFixed(1)}ms PRs=${result.prCount}`);
  assert.ok(result.warmMs < 15_000, JSON.stringify(result));
  assert.equal(result.signatureReads, result.prCount * 2);
});
