import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRequiredStatusChecks } from '../required-status-checks.mjs';
import { readReviewCiGate as readGate, readReviewHead, readReviewChecks, formatReviewCiSkip } from '../review-ci-gate-io.mjs';
const readReviewCiGate = o => readGate({ policy: { startAfter: 'ci-green' }, ...o });
const headSha = 'a'.repeat(40);
it.each(['fast-checks', 'push'])('uses required CI ownership under %s and reports policy on read failures', startAfter => {
  const policy = { startAfter, fastChecks: ['standards'] };
  const args = { repo: 'other/product', pr: 7, policy, readHead: () => headSha,
    readRequired: () => ({ source: 'live', checks: ['test'] }),
    readChecks: () => [{ name: 'standards', status: 'completed', conclusion: 'success' },
      { context: 'optional-status', state: 'failure' }] };
  expect(readGate(args)).toMatchObject({ allowed: true, startAfter });
  expect(readGate({ ...args, readRequired: () => { throw Error('protection unavailable'); } }))
    .toMatchObject({ allowed: true, startAfter, source: 'timing-policy' });
  expect(readGate({ ...args, readChecks: () => [...args.readChecks(), { name: 'test', status: 'completed', conclusion: 'failure' }] }))
    .toMatchObject({ allowed: false, reason: 'ci-red', startAfter });
  expect(readGate({ ...args, readHead: () => null })).toMatchObject({ allowed: false, startAfter });
  expect(readGate({ ...args, readChecks: () => { throw Error('offline'); } })).toMatchObject({ allowed: false, reason: 'unreadable-ci', startAfter });
  expect(readGate({ ...args, policy: { ...policy, startAfter: 'ci-green' }, readRequired: () => ({ source: 'fallback', checks: [] }) }))
    .toMatchObject({ allowed: false, reason: 'untrusted-required-set', startAfter: 'ci-green' });
});
function fixture(over = {}) {
  return { policy: { startAfter: 'ci-green' }, repo: 'other/product', pr: 3432, readHead: vi.fn(() => headSha),
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
  // A denial past TTL no longer replaces the seeded live entry with the declared set (#4708): stale-cache wins.
  ['Resource not accessible by integration (HTTP 403)', 60_000, true, 'stale-cache'],
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

describe('formatReviewCiSkip — the real error behind unreadable-ci is logged (plateau #202, 2026-10-04)', () => {
  const realError = "Command failed: gh pr view 202 --repo plateauapp/plateau-app --json headRefOid\nGraphQL: Could not resolve to a Repository with the name 'plateauapp/plateau-app'. (repository)\n";
  it('carries the underlying gh error on one line', () => {
    const io = fixture({ repo: 'plateauapp/plateau-app', pr: 202, readHead: () => { throw new Error(realError); } });
    const line = formatReviewCiSkip(readReviewCiGate(io));
    expect(line).toMatch(/^review-ci: unreadable-ci \(/);
    expect(line).toContain("Could not resolve to a Repository with the name 'plateauapp/plateau-app'");
    expect(line).not.toContain('\n');
  });
  it('scrubs token-shaped strings and bounds the length', () => {
    const line = formatReviewCiSkip({ reason: 'unreadable-ci', error: `boom ghs_${'A'.repeat(36)} Authorization: token abc123 ${'x'.repeat(900)}` });
    expect(line).not.toMatch(/ghs_A|abc123/);
    expect(line.length).toBeLessThan(340);
  });
  it('keeps the plain reason when there is no error', () => {
    expect(formatReviewCiSkip({ allowed: false, reason: 'required-checks-not-successful' })).toBe('review-ci: required-checks-not-successful');
    expect(formatReviewCiSkip(undefined)).toBe('review-ci: unreadable-ci');
  });
  it('names the failing required checks in the skip reason (#4290 was an unexplained "required-checks-not-successful")', () => {
    expect(formatReviewCiSkip({ allowed: false, reason: 'required-checks-not-successful',
      affected: [{ name: 'soak-replay-gate', reason: 'failure' }, { name: 'test', reason: 'pending' }] }))
      .toBe('review-ci: required-checks-not-successful: soak-replay-gate=failure, test=pending');
  });
});

it('fast-check dispatch reads all head checks without waiting for branch-protection discovery', () => {
  const readRequired = vi.fn(() => { throw Error('protection unavailable'); });
  const io = fixture({ policy: { startAfter: 'fast-checks', fastChecks: ['standards', 'test-shard (1)'] }, readRequired,
    readChecks: () => ['standards', 'test-shard (1)'].map(name => ({ name, head_sha: headSha, status: 'completed', conclusion: 'success' })) });
  expect(readGate(io)).toMatchObject({ allowed: true, headSha, source: 'timing-policy' });
  expect(readRequired).not.toHaveBeenCalled();
});

it('a repo without its own fast checks waits on its trusted required set', () => {
  const policy = { startAfter: 'fast-checks', fastChecks: { we: ['standards', 'test-shard (1)'] } };
  const green = name => ({ name, head_sha: headSha, status: 'completed', conclusion: 'success' });
  const io = fixture({ policy, repo: 'frontier-ui/frontierui', readRequired: vi.fn(() => ({ source: 'declared', checks: ['test'] })),
    readChecks: () => [green('test')] });
  expect(readGate(io)).toMatchObject({ allowed: true, headSha, source: 'declared' });
  expect(readGate({ ...io, readChecks: () => [{ ...green('test'), status: 'in_progress', conclusion: null }] }))
    .toMatchObject({ allowed: false, reason: 'required-checks-not-successful' });
  expect(readGate({ ...io, readRequired: () => ({ source: 'fallback', checks: ['test'] }) }))
    .toMatchObject({ allowed: false, reason: 'untrusted-required-set' });
  expect(readGate({ ...io, readRequired: () => { throw Error('offline'); } })).toMatchObject({ allowed: false, reason: 'unreadable-ci' });
  // WE keeps its fast checks and never waits on discovery.
  const we = fixture({ policy, repo: 'web-everything/web-everything', readRequired: vi.fn(),
    readChecks: () => ['standards', 'test-shard (1)'].map(green) });
  expect(readGate(we)).toMatchObject({ allowed: true, source: 'timing-policy' });
  expect(we.readRequired).not.toHaveBeenCalled();
});

it('publish-time gate reads the exact head marker only when enabled', () => {
  const readVerifyGreen = vi.fn(({ sha }) => sha === headSha);
  const args = { repo: 'other/product', pr: 7, readHead: () => headSha, readChecks: () => [],
    readRequired: () => ({ source: 'live', checks: ['test'] }), readVerifyGreen,
    policy: { startAfter: 'ci-green', startBeforeCi: true } };
  expect(readGate(args)).toMatchObject({ allowed: true, reason: 'verify-marker' });
  expect(readVerifyGreen).toHaveBeenCalledWith(expect.objectContaining({ sha: headSha }));
  expect(readGate({ ...args, readVerifyGreen: () => false }).allowed).toBe(false);
  expect(readGate({ ...args, readVerifyGreen: () => { throw Error('unreadable'); } }).allowed).toBe(false);
  readVerifyGreen.mockClear();
  expect(readGate({ ...args, policy: { startAfter: 'ci-green' } }).allowed).toBe(false);
  expect(readVerifyGreen).not.toHaveBeenCalled();
});
