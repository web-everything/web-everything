import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { findImplicitShortLaneTtls, findUnsafeLaneLeaseTakes } from '../check-standards-rules.mjs';

const scan = content => findImplicitShortLaneTtls([{ file: 'scripts/caller.mjs', content }]);
it.each(["'--ttl-minutes=10'", "'--ttl-minutes', '30'", "'--ttl-minutes', 30", '`--ttl-minutes=1`', "'--ttl-minutes=0.5'"])(
  'flags a literal short TTL %s on an acquire argv', ttl => {
    expect(scan(`run('node', ['scripts/lane-pool.mjs', 'acquire', ${ttl}]);`)).toHaveLength(1);
  });
it('exact-ttl must belong to the same invocation', () => {
  expect(scan("run(['scripts/lane-pool.mjs', 'acquire', '--ttl-minutes=10']); run(['--exact-ttl']);")).toHaveLength(1);
});
it.each(["join(root, 'scripts/lane-pool.mjs')", "path.resolve(root, 'scripts/lane-pool.mjs')", '`\u0024{root}/scripts/lane-pool.mjs`'])(
  'recognizes a caller with a constructed script path %s', script => {
    expect(scan(`run([${script}, 'acquire', '--ttl-minutes=180']);`)).toHaveLength(1);
  });
it.each([
  "run(['scripts/lane-pool.mjs', 'acquire', '--ttl-minutes=10', '--exact-ttl']);",
  "run(['scripts/lane-pool.mjs', 'acquire', '--ttl-minutes=240']);",
  "run(['scripts/lane-pool.mjs', 'release', '--ttl-minutes=10']);",
  "run(['other.mjs', 'acquire', '--ttl-minutes=10']);",
  'run(["scripts/lane-pool.mjs", "acquire", `--ttl-minutes=${ttl}`]);',
])('accepts explicit opt-in, defaults, other commands and dynamic TTLs: %s', content => expect(scan(content)).toEqual([]));
it('an unparseable caller is an error', () => expect(scan('run([')).toHaveLength(1));
it('the real daemon smoke explicitly opts into ten minutes', () => {
  expect(scan(readFileSync('scripts/lib/daemon-live-smoke.mjs', 'utf8'))).toEqual([]);
});
it('the card batch caller explicitly opts into its historical three-hour TTL', () => {
  const content = readFileSync('scripts/operations/card-batch-seal-io.mjs', 'utf8');
  expect(scan(content)).toEqual([]);
  expect(content).toContain("'--ttl-minutes=180', '--exact-ttl'");
});

const takes = content => findUnsafeLaneLeaseTakes([{ file: 'scripts/lane-pool.mjs', content }]);
it('every identity-only marker take needs an owner-operation annotation', () => {
  expect(takes('if (takeMarkerIf(dir, moved => sameLease(moved, lease), n)) act();')).toHaveLength(1);
  expect(takes('takeMarkerIf(dir, moved => sameStaleLease(moved, lease, ttlMs), n);')).toEqual([]);
  expect(takes('takeMarkerIf(\n dir, moved => sameStaleLease(moved, lease, ttlMs),\n n);')).toEqual([]);
  expect(takes('// owner-operation: release own claim\ntakeMarkerIf(dir, moved => sameLease(moved, claim), n);')).toEqual([]);
  expect(takes('// owner-operation:\ntakeMarkerIf(dir, moved => sameLease(moved, claim), n);')).toHaveLength(1);
});
it('every real marker take has a stale guard or explains the owner operation', () => {
  expect(takes(readFileSync('scripts/lane-pool.mjs', 'utf8'))).toEqual([]);
});
