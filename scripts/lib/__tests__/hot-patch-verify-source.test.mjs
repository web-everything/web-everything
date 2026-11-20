import { test, expect } from 'vitest';
import { ciVerdict, verifyUrgentMarker } from '../hot-patch-verify-marker.mjs';
const sha = 'a'.repeat(40);
const run = (id, conclusion = 'success', extra = {}) => ({ id, name: 'test', head_sha: sha,
  app: { id: 15368, slug: 'github-actions' }, status: 'completed', conclusion, ...extra });
const read = runs => ciVerdict({ sha, settings: { verifyRepo: 'owner/repo' },
  runGh: () => JSON.stringify(runs) });
for (const app of [{ id: 1, slug: 'github-actions' }, { id: 15368, slug: 'foreign' }, undefined]) {
  test(`producer identity refuses foreign or missing app ${JSON.stringify(app)}`, () => {
    expect(read([run(1, 'success', { app })])).toMatchObject({ state: 'unknown', reason: expect.any(String), runId: null });
  });
}
for (const name of ['test ', 'Test']) test(`producer identity ignores name lookalike ${name}`, () => {
  expect(read([run(1, 'success', { name })]).state).toBe('unknown');
});
for (const dates of [{}, { created_at: 'invalid' }, { created_at: '2026-01-01' }]) {
  test(`numeric run id wins independently of timestamps ${JSON.stringify(dates)}`, () => {
    expect(read([run('10', 'failure', { created_at: '2099-01-01' }), run(11, 'success', dates)]))
      .toMatchObject({ state: 'green', reason: expect.any(String), runId: 11 });
    expect(read([run(9, 'success', dates), run('10', 'failure', dates)]))
      .toMatchObject({ state: 'red' });
  });
}
for (const conclusion of ['failure', 'cancelled', 'timed_out', 'neutral']) test(`completed ${conclusion} is red`, () => {
  expect(read([run(1, conclusion)])).toMatchObject({ state: 'red' });
});
for (const status of ['queued', 'in_progress']) test(`${status} is pending despite older green`, () => {
  expect(read([run(1), run(2, null, { status })])).toMatchObject({ state: 'pending', runId: 2 });
});
for (const payload of ['{bad', 'null', '{}', '[]', '[{}]']) test(`unreadable/missing CI refuses ${payload}`, () => {
  expect(ciVerdict({ sha, settings: { verifyRepo: 'owner/repo' }, runGh: () => payload }).state).toBe('unknown');
});
test('API failure refuses', () => {
  expect(ciVerdict({ sha, settings: { verifyRepo: 'owner/repo' }, runGh: () => { throw Error('offline'); } }).state).toBe('unknown');
});
for (const invalid of ['abc', 'z'.repeat(40), undefined]) test(`invalid sha refuses ${invalid} before IO`, () => {
  expect(ciVerdict({ sha: invalid, runGh: () => { throw Error('must not run'); } }).state).toBe('unknown');
});
test('query pins repo and exact sha, pagination and bounded IO', () => {
  const result = ciVerdict({ sha, root: process.cwd(), settings: { verifyRepo: 'owner/repo' }, runGh: (args, opts) => {
    expect(args).toEqual(['api', `repos/owner/repo/commits/${sha}/check-runs`, '--paginate', '--slurp', '--jq', '[.[].check_runs[]]']);
    expect(opts.timeout).toBeGreaterThan(0); expect(opts.maxBuffer).toBeGreaterThan(0);
    return JSON.stringify([run(1)]);
  } });
  expect(result).toEqual({ state: 'green', reason: expect.any(String), runId: 1 });
});
test('urgent marker always refuses', () => {
  expect(verifyUrgentMarker(sha)).toEqual({ ok: false, reason: 'forge-signed marker not accepted yet' });
});

test('newer failing run by id after an older success is red', () => {
  expect(read([run(9), run(10, 'failure')])).toEqual({
    state: 'red', reason: expect.any(String), runId: 10,
  });
});
test('no run yields an explicit unknown verdict with operator fallback', () => {
  expect(read([])).toEqual({ state: 'unknown', reason: expect.stringContaining('retry verify-result'), runId: null });
});
test('oversized response fails closed', () => {
  expect(ciVerdict({ sha, settings: { verifyRepo: 'owner/repo', maxOutputBytes: 2 },
    runGh: () => JSON.stringify([run(1)]) }).state).toBe('unknown');
});
