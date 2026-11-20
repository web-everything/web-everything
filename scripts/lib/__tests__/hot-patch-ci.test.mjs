/** Checklist 1, 3, 6, 7: workflow/run identity and fail-closed CI evidence. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hotPatchCiVerdict, requiredChecksForMain } from '../hot-patch-ci.mjs';
import { decideHotPatch } from '../hot-patch.mjs';
const sha = 'a'.repeat(40), repo = 'web-everything/web-everything';
// Fixtures ported from hot-patch-verify-source.test.mjs on origin/lane/hot-patch-s2.
const run = (id, conclusion = 'success', extra = {}) => ({ id, name: 'test', head_sha: sha,
  check_suite_id: id, status: 'completed', conclusion, ...extra });
const suite = id => ({ id, head_sha: sha, app: { id: 15368, slug: 'github-actions' } });
test('workflow-run response without app authenticates through its linked check suite', async () => {
  const response = run(30433642, 'success', { workflow_id: 159038, check_suite_id: 42,
    path: '.github/workflows/ci.yml', run_attempt: 1 });
  assert.equal(Object.hasOwn(response, 'app'), false);
  assert.equal((await verdict({ runs: [response], jobs: { 30433642: [job('test')] } })).state, 'green');
});
for (const evidence of [null, {}, { ...suite(2) }, { ...suite(1), head_sha: 'b'.repeat(40) }]) {
  test(`unreadable or mismatched linked check suite fails closed: ${JSON.stringify(evidence)}`, async () => {
    assert.equal((await verdict({ suites: { 1: evidence } })).state, 'unknown');
  });
}
test('linked check suite read failure is unknown', async () => {
  assert.equal((await verdict({ fetchJson: async path => {
    if (path.includes('/workflows/')) return { workflow_runs: [run(1)] };
    assert.equal(path, `/repos/${repo}/check-suites/1`);
    throw Error('offline');
  } })).state, 'unknown');
});
const job = (name, conclusion = 'success', extra = {}) => ({ name, status: 'completed', conclusion, ...extra });
const workflow = 'ci.yml';
async function verdict({ runs = [run(1)], jobs = { 1: [job('test')] }, required = ['test'],
  repository = repo, fetchJson, suites = {} } = {}) {
  const paths = [];
  const result = await hotPatchCiVerdict({ repo: repository, sha, required,
    fetchJson: fetchJson ?? (async path => {
      paths.push(path);
      if (path === `/repos/${repo}/actions/workflows/${workflow}/runs?head_sha=${sha}&per_page=100&page=1`) return { workflow_runs: runs };
      const suiteMatch = path.match(/\/check-suites\/(\d+)$/);
      if (suiteMatch) return Object.hasOwn(suites, suiteMatch[1]) ? suites[suiteMatch[1]] : suite(suiteMatch[1]);
      const match = path.match(/^\/repos\/web-everything\/web-everything\/actions\/runs\/(\d+)\/jobs\?per_page=100&page=1$/);
      assert(match, `unexpected API path: ${path}`);
      assert(Object.hasOwn(jobs, match[1]), `jobs requested for ignored run ${match[1]}`);
      return { jobs: jobs[match[1]] };
    }) });
  assert.equal(typeof result.reason, 'string'); assert(result.reason.length > 0);
  return { ...result, paths };
}
test('endpoint construction uses the workflow filename as the REST identifier', async () => {
  const result = await verdict(); assert.equal(result.state, 'green');
  assert.deepEqual(result.paths, [`/repos/${repo}/actions/workflows/${workflow}/runs?head_sha=${sha}&per_page=100&page=1`,
    `/repos/${repo}/check-suites/1`, `/repos/${repo}/actions/runs/1/jobs?per_page=100&page=1`]);
});
for (const app of [{ id: 1, slug: 'github-actions' }, { id: 15368, slug: 'foreign' }, undefined]) {
  test(`another app newer success ignored: ${JSON.stringify(app)}`, async () => {
    assert.equal((await verdict({ runs: [run(1, 'failure'), run(999)], suites: { 999: { ...suite(999), app } },
      jobs: { 1: [job('test', 'failure')] } })).state, 'red');
  });
}
test('equal numeric run ids fail closed as unknown', async () => {
  assert.equal((await verdict({ runs: [run(10), run('10')], jobs: {} })).state, 'unknown');
});
test('head_sha mismatch is ignored even on a newer successful Actions run', async () => {
  assert.equal((await verdict({ runs: [run(1), run(999, 'success', { head_sha: 'b'.repeat(40) })],
    jobs: { 1: [job('test', 'failure')] } })).state, 'red');
});
test('BigInt ordering above 2^53 chooses newer failure despite misleading dates', async () => {
  assert.equal((await verdict({ runs: [run('9007199254740993', 'failure', { created_at: 'invalid' }),
    run('9007199254740992', 'success', { created_at: '2099-01-01' })],
    jobs: { '9007199254740993': [job('test', 'failure')] } })).state, 'red');
});
test('numeric id ordering wins over lexical ordering and timestamps', async () => {
  assert.equal((await verdict({ runs: [run('9', 'success', { created_at: '2099-01-01' }), run('10', 'failure')],
    jobs: { 10: [job('test', 'failure')] } })).state, 'red');
});
test('missing required job is pending', async () => {
  assert.equal((await verdict({ required: ['test', 'smoke'] })).state, 'pending');
});
test('in-progress required job is pending despite a success conclusion', async () => {
  assert.equal((await verdict({ jobs: { 1: [job('test', 'success', { status: 'in_progress' })] } })).state, 'pending');
});
test('green workflow summary with daemon-soak failed is red', async () => {
  assert.equal((await verdict({ required: ['test', 'smoke', 'daemon-soak'],
    jobs: { 1: [job('test'), job('smoke'), job('daemon-soak', 'failure')] } })).state, 'red');
});
for (const conclusion of ['failure', 'cancelled', 'skipped', 'neutral', 'timed_out']) {
  test(`completed required job ${conclusion} is red`, async () => {
    assert.equal((await verdict({ jobs: { 1: [job('test', conclusion)] } })).state, 'red');
  });
}
test('soak-replay-gate uses its own frozen workflow mapping', async () => {
  const paths = [];
  const result = await verdict({ required: ['soak-replay-gate'], fetchJson: async path => {
    paths.push(path);
    if (path === `/repos/${repo}/actions/workflows/soak-replay-gate.yml/runs?head_sha=${sha}&per_page=100&page=1`)
      return { workflow_runs: [run(8)] };
    if (path === `/repos/${repo}/check-suites/8`) return suite(8);
    assert.equal(path, `/repos/${repo}/actions/runs/8/jobs?per_page=100&page=1`);
    return { jobs: [job('soak-replay-gate')] };
  } });
  assert.equal(result.state, 'green'); assert.equal(paths.length, 3);
});
test('unmapped required name is unknown before IO', async () => {
  let calls = 0;
  assert.equal((await verdict({ required: ['unmapped'], fetchJson: async () => { calls++; return {}; } })).state, 'unknown');
  assert.equal(calls, 0);
});
test('wrong repo is unknown before IO', async () => {
  let calls = 0;
  assert.equal((await verdict({ repository: 'another/repo', fetchJson: async () => { calls++; return {}; } })).state, 'unknown');
  assert.equal(calls, 0);
});
for (const phase of ['runs', 'jobs']) test(`fetch throws reading ${phase}: unknown`, async () => {
  assert.equal((await verdict({ fetchJson: async path => {
    if (phase === 'jobs' && path.includes('/workflows/')) return { workflow_runs: [run(1)] };
    throw Error('offline');
  } })).state, 'unknown');
});
for (const payload of [null, {}, { workflow_runs: [] }, { workflow_runs: [{}] }]) {
  test(`unreadable or absent run evidence is unknown: ${JSON.stringify(payload)}`, async () => {
    assert.equal((await verdict({ fetchJson: async () => payload })).state, 'unknown');
  });
}

test('R3.5 unreadable or partial required policy stays unknown despite all four jobs succeeding', async () => {
  for (const read of [() => { throw Error('offline'); },
    () => { throw Object.assign(Error('partial'), { partialChecks: ['test'] }); },
    () => ({ checks: ['test'], partialChecks: ['smoke'] })]) {
    const required = requiredChecksForMain(read);
    const result = await verdict({ required, fetchJson: async path => {
      if (path.includes('/workflows/')) return { workflow_runs: [run(1)] };
      if (path.includes('/check-suites/')) return suite(1);
      return { jobs: ['test', 'smoke', 'daemon-soak', 'soak-replay-gate'].map(name => job(name)) };
    } });
    assert.equal(result.state, 'unknown');
    assert.equal(result.reason, 'Required-check policy unreadable');
    assert.equal(required, null);
  }
  assert.deepEqual(requiredChecksForMain(() => ({ checks: ['test'] })), ['test']);
});
test('R3.6 daemon-soak red survives later soak-replay-gate fetch failure', async () => {
  const result = await verdict({ required: ['daemon-soak', 'soak-replay-gate'], fetchJson: async path => {
    if (path.includes('soak-replay-gate.yml')) throw Error('offline');
    if (path.includes('/workflows/')) return { workflow_runs: [run(1)] };
    if (path.includes('/check-suites/')) return suite(1);
    return { jobs: [job('daemon-soak', 'failure')] };
  } });
  assert.equal(result.state, 'red');
});
test('R3.7 bogus job status is unknown and expires to ci-unknown after 31 minutes', async () => {
  const ci = await verdict({ jobs: { 1: [job('test', null, { status: 'bogus' })] } });
  assert.equal(ci.state, 'unknown');
  const loaded = 1700000000000;
  assert.equal(decideHotPatch({ record: { sha, loadedAt: new Date(loaded).toISOString() }, ci,
    pr: { state: 'OPEN', headRefOid: sha }, now: loaded + 31 * 60000 }), 'ci-unknown');
});
for (const phase of ['runs', 'jobs']) {
  test(`${phase} pagination discovers a later failure instead of accepting first-page success`, async () => {
    const paths = [];
    const result = await verdict({ fetchJson: async path => {
      paths.push(path);
      const page = Number(new URL(path, 'https://example.test').searchParams.get('page'));
      if (path.includes('/workflows/')) return phase === 'runs'
        ? { total_count: 101, workflow_runs: page === 1 ? Array.from({ length: 100 }, (_, i) => run(i + 1)) : [run(101)] }
        : { total_count: 1, workflow_runs: [run(1)] };
      if (path.includes('/check-suites/')) return suite(path.split('/').at(-1));
      if (phase === 'runs') { assert(path.includes('/runs/101/jobs?')); return { jobs: [job('test', 'failure')] }; }
      return { total_count: 101, jobs: page === 1 ? Array.from({ length: 100 }, () => job('test')) : [job('test', 'failure')] };
    } });
    assert.equal(result.state, 'red');
    assert(paths.some(path => path.endsWith('per_page=100&page=2')));
  });
  for (const capped of [false, true]) test(`${phase} incomplete ${capped ? 'ten-page cap' : 'short page'} is unknown`, async () => {
    let pages = 0;
    const result = await verdict({ fetchJson: async path => {
      if (path.includes('/check-suites/')) return suite(1);
      if (phase === 'jobs' && path.includes('/workflows/')) return { workflow_runs: [run(1)] };
      pages++;
      return { total_count: 1001, [phase === 'runs' ? 'workflow_runs' : 'jobs']:
        Array.from({ length: capped ? 100 : 1 }, () => phase === 'runs' ? run(1) : job('test')) };
    } });
    assert.equal(result.state, 'unknown');
    assert.equal(pages, capped ? 10 : 1);
    assert.match(result.reason, /inspect workflows manually/);
  });
}
for (const [conclusion, status, expected] of [['success', 'completed', 'green'], ['failure', 'completed', 'red'],
  ['success', 'in_progress', 'pending'], [null, 'completed', 'unknown']]) {
  test(`duplicate required names require all successes: ${expected}`, async () => {
    assert.equal((await verdict({ jobs: { 1: [job('test'), job('test', conclusion, { status })] } })).state, expected);
  });
}
