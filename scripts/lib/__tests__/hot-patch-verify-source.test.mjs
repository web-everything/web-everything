import { test, expect } from 'vitest';
import { readVerifyResult, verifyUrgentMarker } from '../hot-patch-verify-marker.mjs';
const sha = 'a'.repeat(40);
const run = (id, conclusion = 'success', extra = {}) => ({ id, name: 'test', head_sha: sha,
  app: { id: 15368, slug: 'github-actions' }, status: 'completed', conclusion, ...extra });
const read = runs => readVerifyResult({ sha, settings: { verifyRepo: 'owner/repo' },
  runGh: () => JSON.stringify(runs) });
for (const app of [{ id: 1, slug: 'github-actions' }, { id: 15368, slug: 'foreign' }, undefined]) {
  test(`producer identity refuses foreign or missing app ${JSON.stringify(app)}`, () => {
    expect(read([run(1, 'success', { app })])).toMatchObject({ ok: false, foreign: [expect.any(Object)] });
  });
}
for (const name of ['test ', 'Test']) test(`producer identity ignores name lookalike ${name}`, () => {
  expect(read([run(1, 'success', { name })]).ok).toBe(false);
});
for (const dates of [{}, { created_at: 'invalid' }, { created_at: '2026-01-01' }]) {
  test(`numeric run id wins independently of timestamps ${JSON.stringify(dates)}`, () => {
    expect(read([run('10', 'failure', { created_at: '2099-01-01' }), run(11, 'success', dates)]))
      .toMatchObject({ ok: true, result: 'green' });
    expect(read([run(9, 'success', dates), run('10', 'failure', dates)]))
      .toMatchObject({ ok: true, result: 'red' });
  });
}
for (const conclusion of ['failure', 'cancelled', 'timed_out', 'neutral']) test(`completed ${conclusion} is red`, () => {
  expect(read([run(1, conclusion)])).toMatchObject({ ok: true, result: 'red' });
});
for (const status of ['queued', 'in_progress']) test(`${status} is pending despite older green`, () => {
  expect(read([run(1), run(2, null, { status })])).toMatchObject({ ok: true, result: 'pending' });
});
for (const payload of ['{bad', 'null', '{}', '[]', '[{}]']) test(`unreadable/missing CI refuses ${payload}`, () => {
  expect(readVerifyResult({ sha, settings: { verifyRepo: 'owner/repo' }, runGh: () => payload }).ok).toBe(false);
});
test('API failure refuses', () => {
  expect(readVerifyResult({ sha, settings: { verifyRepo: 'owner/repo' }, runGh: () => { throw Error('offline'); } }).ok).toBe(false);
});
for (const invalid of ['abc', 'z'.repeat(40), undefined]) test(`invalid sha refuses ${invalid} before IO`, () => {
  expect(readVerifyResult({ sha: invalid, runGh: () => { throw Error('must not run'); } }).ok).toBe(false);
});
test('query pins repo and exact sha, pagination and bounded IO', () => {
  const result = readVerifyResult({ sha, root: process.cwd(), settings: { verifyRepo: 'owner/repo' }, runGh: (args, opts) => {
    expect(args).toEqual(['api', `repos/owner/repo/commits/${sha}/check-runs`, '--paginate', '--slurp', '--jq', '[.[].check_runs[]]']);
    expect(opts.timeout).toBeGreaterThan(0); expect(opts.maxBuffer).toBeGreaterThan(0);
    return JSON.stringify([run(1)]);
  } });
  expect(result.result).toBe('green');
});
test('urgent marker always refuses', () => {
  expect(verifyUrgentMarker(sha)).toEqual({ ok: false, reason: 'forge-signed marker not accepted yet' });
});
