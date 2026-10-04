import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRequiredStatusChecks } from '../required-status-checks.mjs';
import { readReviewCiGate, readReviewHead, readReviewChecks } from '../review-ci-gate-io.mjs';
const headSha = 'a'.repeat(40);
function fixture(over = {}) {
  return { repo: 'other/product', pr: 3432, readHead: vi.fn(() => headSha),
    readRequired: vi.fn(() => ({ source: 'live', checks: ['custom'] })),
    readChecks: vi.fn(() => [{ name: 'custom', status: 'completed', conclusion: 'success' }]), ...over };
}
describe('fresh review CI IO', () => {
  it('reads repo, fresh required set and exact SHA, then verifies the head again', () => {
    const io = fixture();
    expect(readReviewCiGate(io).allowed).toBe(true);
    expect(io.readHead.mock.calls).toEqual([[{ repo: io.repo, pr: 3432 }], [{ repo: io.repo, pr: 3432 }]]);
    expect(io.readChecks).toHaveBeenCalledWith({ repo: io.repo, headSha });
    expect(io.readRequired).toHaveBeenCalledWith({ repo: io.repo, ttlMs: 0 });
  });
  it.each(['live', 'cache', 'declared'])('allows trusted source %s with green required checks', source => {
    expect(readReviewCiGate(fixture({ readRequired: () => ({ source, checks: ['custom'] }) })))
      .toMatchObject({ allowed: true, source });
  });
  it.each(['fallback', 'unavailable', undefined])('refuses untrusted source %s', source => {
    expect(readReviewCiGate(fixture({ readRequired: () => ({ source, checks: ['custom'] }) }))).toMatchObject({ allowed: false, reason: 'untrusted-required-set' });
  });
  it.each([0, 60_000, 24 * 60 * 60_000])('allows stale cache aged %s ms and reports its age', cacheAgeMs => {
    const result = readReviewCiGate(fixture({ readRequired: () => ({ source: 'stale-cache', checks: ['custom'], cacheAgeMs }) }));
    expect(result).toMatchObject({ allowed: true, source: 'stale-cache', cacheAgeMs });
    expect(result.reason).toContain(`cache-age-ms=${cacheAgeMs}`);
  });
  it.each([undefined, NaN, Infinity, -1, '1000', 24 * 60 * 60_000 + 1, 2 * 24 * 60 * 60_000])('refuses stale cache with invalid or expired age %s', cacheAgeMs => {
    const io = fixture({ readRequired: () => ({ source: 'stale-cache', checks: ['custom'], cacheAgeMs }) });
    const result = readReviewCiGate(io);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('untrusted-required-set');
    expect(io.readChecks).not.toHaveBeenCalled();
  });
  it.each(['readHead', 'readRequired', 'readChecks'])('fails closed on %s errors', key => {
    expect(readReviewCiGate(fixture({ [key]: () => { throw new Error('offline'); } }))).toMatchObject({ allowed: false, reason: 'unreadable-ci' });
  });
  it('refuses a head move during the read', () => {
    expect(readReviewCiGate(fixture({ readHead: vi.fn().mockReturnValueOnce(headSha).mockReturnValueOnce('b'.repeat(40)) }))).toMatchObject({ allowed: false, reason: 'head-changed', headSha });
  });
  it.each([[], [{ name: 'custom', status: 'in_progress' }], [{ name: 'custom', status: 'completed', conclusion: 'failure' }]])('refuses fresh missing/pending/red despite an earlier green plan', checks => {
    expect(readReviewCiGate(fixture({ readChecks: () => checks })).allowed).toBe(false);
  });
});

it.each([198, 199])('replays Plateau PR #%s with protection unavailable and test/e2e green', pr => {
  const dir = mkdtempSync(join(tmpdir(), 'we-review-ci-declared-'));
  try {
    const readRequired = args => getRequiredStatusChecks({ ...args, cachePath: join(dir, 'cache.json'),
      readChecks: () => { throw new Error('Resource not accessible by integration (HTTP 403)'); } });
    const checks = ['test', 'e2e'].map(name => ({ name, status: 'completed', conclusion: 'success' }));
    const io = fixture({ repo: 'plateauapp/plateau-app', pr, readRequired, readChecks: () => checks });
    expect(readReviewCiGate(io)).toMatchObject({ allowed: true, source: 'declared', headSha });
    expect(readReviewCiGate({ ...io, readChecks: () => checks.slice(0, 1) })).toMatchObject({ allowed: false, source: 'declared' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('production read argv is repo/SHA-explicit and fetches every page and rerun', () => {
  const runHead = vi.fn(() => JSON.stringify({ headRefOid: headSha }));
  expect(readReviewHead({ repo: 'other/product', pr: 3432, run: runHead })).toBe(headSha);
  expect(runHead).toHaveBeenCalledWith(['pr', 'view', '3432', '--repo', 'other/product', '--json', 'headRefOid']);
  const runChecks = vi.fn(argv => JSON.stringify(argv[3].includes('/status?')
    ? [{ statuses: [{ context: 'legacy', state: 'success', id: 9 }] }, { statuses: [] }]
    : [{ check_runs: [{ id: 2 }] }, { check_runs: [{ id: 1 }] }]));
  expect(readReviewChecks({ repo: 'other/product', headSha, run: runChecks })).toEqual([{ id: 2 }, { id: 1 }, { context: 'legacy', state: 'success' }]);
  expect(runChecks).toHaveBeenCalledWith(['api', '--paginate', '--slurp', `repos/other/product/commits/${headSha}/check-runs?per_page=100&filter=all`]);
  expect(runChecks).toHaveBeenCalledWith(['api', '--paginate', '--slurp', `repos/other/product/commits/${headSha}/status?per_page=100`]);
  expect(() => readReviewChecks({ repo: 'other/product', headSha, run: () => '[{}]' })).toThrow('unreadable check runs');
  expect(() => readReviewChecks({ repo: 'other/product', headSha, run: argv => JSON.stringify(argv[3].includes('/status?') ? [{}] : []) })).toThrow('unreadable commit statuses');
});

it('admits successful required commit statuses', () => {
  const run = argv => JSON.stringify(argv[3].includes('/status?')
    ? [{ statuses: [{ context: 'legacy', state: 'success' }] }] : [{ check_runs: [{ name: 'custom', status: 'completed', conclusion: 'success' }] }]);
  expect(readReviewCiGate(fixture({ readRequired: () => ({ source: 'live', checks: ['custom', 'legacy'] }),
    readChecks: ({ repo, headSha }) => readReviewChecks({ repo, headSha, run }) }))).toMatchObject({ allowed: true });
});

// Recovered read-only from GitHub on 2026-10-02. Times are UTC. We reconstruct
// eligibility at the accept comment; neither dispatch-start time nor the old required-set configuration is archived here.
it.each([
  ['2498e55c6b57f30b629e1477e55366138ef724d6', '2026-10-02T01:42:07Z', '2026-10-02T01:44:24Z', '2026-10-02T01:42:58Z', '2026-10-02T01:43:01Z'],
  ['62f132b42c56d00231f38a71b8376b670f73417a', '2026-10-02T02:05:53Z', '2026-10-02T02:08:54Z', '2026-10-02T02:07:00Z', '2026-10-02T02:07:03Z'],
])('historical #3432 accepted head %s was ineligible at acceptance and after soak failure', (sha, acceptedAt, testDone, soakStarted, soakDone) => {
  for (const at of [acceptedAt, soakDone, testDone]) {
    const checks = [{ name: 'smoke', status: 'completed', conclusion: 'success' },
      { name: 'test', status: at < testDone ? 'in_progress' : 'completed', conclusion: at < testDone ? null : 'success' },
      ...(at < soakStarted ? [] : [{ name: 'daemon-soak', status: 'completed', conclusion: 'failure' }])];
    const out = readReviewCiGate({ repo: 'web-everything/web-everything', pr: 3432, readHead: () => sha,
      readRequired: () => ({ source: 'live', checks: ['test', 'smoke', 'daemon-soak'] }), readChecks: () => checks });
    expect(out.allowed).toBe(false);
    expect(out.affected).toContainEqual({ name: 'daemon-soak', reason: at < soakStarted ? 'missing' : 'failure' });
  }
});

it.each([
  ['Resource not accessible by integration (HTTP 403)', 60_000, true, 'declared'],
  ['offline', 60_000, true, 'stale-cache'],
  ['offline', 24 * 60 * 60_000, true, 'stale-cache'],
  ['offline', 2 * 24 * 60 * 60_000, false, 'stale-cache'],
])('replays WE protection failure %s with cache age %s', (message, age, allowed, source) => {
  const dir = mkdtempSync(join(tmpdir(), 'we-review-ci-cache-'));
  try {
    const cachePath = join(dir, 'cache.json');
    const repo = 'web-everything/web-everything';
    const names = ['test', 'smoke', 'daemon-soak'];
    getRequiredStatusChecks({ repo, cachePath, now: 1000, readChecks: () => names });
    const io = fixture({ repo,
      readRequired: args => getRequiredStatusChecks({ ...args, cachePath, now: 1000 + age,
        readChecks: () => { throw new Error(message); } }),
      readChecks: () => names.map(name => ({ name, status: 'completed', conclusion: 'success' })),
    });
    expect(readReviewCiGate(io)).toMatchObject({ allowed, source });
    if (allowed) {
      expect(readReviewCiGate({ ...io, readChecks: () => [] }).allowed).toBe(false);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
