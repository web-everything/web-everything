/** Checklist 1, 3, 6, 7: workflow/run identity and fail-closed CI evidence. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hotPatchCiVerdict } from '../hot-patch-ci.mjs';
const sha = 'a'.repeat(40), repo = 'web-everything/web-everything';
// Fixtures ported from hot-patch-verify-source.test.mjs on origin/lane/hot-patch-s2.
const run = (id, conclusion = 'success', extra = {}) => ({ id, name: 'test', head_sha: sha,
  app: { id: 15368, slug: 'github-actions' }, status: 'completed', conclusion, ...extra });
const job = (name, conclusion = 'success', extra = {}) => ({ name, status: 'completed', conclusion, ...extra });
const workflow = '.github/workflows/ci.yml';
async function verdict({ runs = [run(1)], jobs = { 1: [job('test')] }, required = ['test'],
  repository = repo, fetchJson } = {}) {
  const paths = [];
  const result = await hotPatchCiVerdict({ repo: repository, sha, required,
    fetchJson: fetchJson ?? (async path => {
      paths.push(path);
      if (path === `/repos/${repo}/actions/workflows/${workflow}/runs?head_sha=${sha}`) return { workflow_runs: runs };
      const match = path.match(/^\/repos\/web-everything\/web-everything\/actions\/runs\/(\d+)\/jobs$/);
      assert(match, `unexpected API path: ${path}`);
      assert(Object.hasOwn(jobs, match[1]), `jobs requested for ignored run ${match[1]}`);
      return { jobs: jobs[match[1]] };
    }) });
  assert.equal(typeof result.reason, 'string'); assert(result.reason.length > 0);
  return { ...result, paths };
}
test('mapped workflow and exact sha produce green from the selected run jobs', async () => {
  const result = await verdict(); assert.equal(result.state, 'green');
  assert.deepEqual(result.paths, [`/repos/${repo}/actions/workflows/${workflow}/runs?head_sha=${sha}`,
    `/repos/${repo}/actions/runs/1/jobs`]);
});
for (const app of [{ id: 1, slug: 'github-actions' }, { id: 15368, slug: 'foreign' }, undefined]) {
  test(`another app newer success ignored: ${JSON.stringify(app)}`, async () => {
    assert.equal((await verdict({ runs: [run(1, 'failure'), run(999, 'success', { app })],
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
    if (path === `/repos/${repo}/actions/workflows/.github/workflows/soak-replay-gate.yml/runs?head_sha=${sha}`)
      return { workflow_runs: [run(8)] };
    assert.equal(path, `/repos/${repo}/actions/runs/8/jobs`);
    return { jobs: [job('soak-replay-gate')] };
  } });
  assert.equal(result.state, 'green'); assert.equal(paths.length, 2);
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
