// @vitest-environment node
import { it, expect, vi, afterEach } from 'vitest';
import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { prestagePorts } from './fixtures/merge-ai-prs-fake-ports.mjs';
import { runInProcess, childProcessMock } from './fixtures/merge-ai-prs-cli-harness.mjs';
import { createPrestageWorld } from './fixtures/merge-ai-prs-prestage-world.mjs';

const MB = 'b'.repeat(40);
const file = (extra = {}) => ({ filename: 'src/x.ts', status: 'added', additions: 1, deletions: 0, changes: 1, patch: '@@ -0,0 +1 @@\n+export const x = 1;', ...extra });
const compare = (extra = {}) => ({ status: 'ahead', merge_base_commit: { sha: MB }, base_commit: { sha: MB }, files: [file(), file({ filename: 'blocks/__tests__/new.test.ts', patch: '@@ -0,0 +1 @@\n+it("works", () => {});' })], ...extra });
const options = { thisRepo: false, args: ['--repos=frontier-ui/frontierui'] };
const setup = { slug: 'frontier-ui/frontierui', localSlug: 'web-everything/web-everything' };
const world = createPrestageWorld((argv, options) => runInProcess(argv, { ...options, ports: prestagePorts }));
afterEach(() => { vi.doUnmock('node:child_process'); vi.resetModules(); });
function ready(pr) {
  vi.doMock('node:child_process', () => childProcessMock);
  pr.mergeStateStatus = 'CLEAN';
  pr.compare = compare();
  pr.statusCheckRollup[0] = { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', head_sha: pr.headRefOid };
}
function noRemoteGit(calls) {
  expect(calls.filter(a => a[0] === 'git' && (a.includes('clone') || (a.some(x => ['fetch', 'diff', 'merge-base'].includes(x)) && a.some(x => /frontierui|lane\/readme/.test(x)))))).toEqual([]);
}
function held(r, reason) {
  expect(r.report.parked, r.stderr).toEqual(expect.arrayContaining([expect.objectContaining({ num: 42, humanRequired: true, reasons: expect.arrayContaining([expect.stringContaining(reason)]) })]));
  expect(r.calls.filter(a => (a[0] === 'pr' && a[1] === 'merge') || a.some(x => x?.includes('enqueuePullRequest')))).toEqual([]);
  expect(r.calls.some(a => a.includes('--add-label') && a.some(x => x?.includes('review:human')))).toBe(true);
  noRemoteGit(r.calls);
}
it("a non-local repo's clean forge compare scores the net diff and does not park", () => world(async ({ pr, run }) => {
  ready(pr);
  const r = await run(false, options);
  expect(r.stderr).toContain(`net-diff #42: base=${MB} head=${pr.headRefOid} (forge)`);
  expect(JSON.stringify(r.report)).not.toContain('net diff unverified');
  expect(r.calls.some(a => a.some(x => x?.includes('enqueuePullRequest')) || (a[0] === 'pr' && a[1] === 'merge'))).toBe(true);
  noRemoteGit(r.calls);
}, setup), 120_000);
it.each([
  ['api-http-500', { status: 500 }], ['api-http-404', { status: 404 }],
  ['api-malformed', compare({ files: undefined })], ['compare-ceiling', compare({ files: Array.from({ length: 300 }, () => file()) })],
  ['patch-omitted', compare({ files: [file({ patch: undefined })] })],
  ['patch-truncated', compare({ files: [file({ additions: 2, changes: 2 })] })],
  ['path-unsupported', compare({ files: [file({ filename: 'a b/c.ts' })] })],
  ['compare-empty', compare({ status: 'identical' })], ['head-unbound', compare()],
])('every unknown holds: %s', (reason, doc) => world(async ({ pr, run }) => {
  ready(pr); pr.compare = doc;
  if (reason === 'head-unbound') pr.headRefOid = 'bad-head';
  held(await run(false, options), `net diff unverified (forge-${reason}); `);
}, setup), 120_000);
it.each([
  ['test-file-removed', file({ filename: 'blocks/__tests__/x.test.ts', status: 'removed', additions: 0, deletions: 1, patch: '@@ -1 +0,0 @@\n-it("works", () => {});' })],
  ['test-skipped', file({ filename: 'blocks/__tests__/x.test.ts', patch: '@@ -0,0 +1 @@\n+it.skip("works", () => {});' })],
])('forge tampering still parks: %s', (reason, f) => world(async ({ pr, run }) => {
  ready(pr); pr.compare = compare({ files: [f] });
  held(await run(false, options), reason);
}, setup), 120_000);
it('two passes read fresh compares, pin the host, and never write an ETag cache', () => world(async ({ pr, run, dir }) => {
  ready(pr);
  const cache = join(dir, 'etag'); mkdirSync(cache);
  for (let pass = 0; pass < 3; pass++) {
    if (pass === 2) pr.compare = { status: 500 };
    const r = await run(false, { ...options, env: { WE_GH_ETAG_DIR: cache, GH_HOST: 'evil.example', GH_ENTERPRISE_TOKEN: 'x', WE_GH_THROTTLE_RETRY_MAX_ATTEMPTS: '1' } });
    expect(r.calls.filter(a => a[0] === 'api' && a.some(x => x?.includes('/compare/')))).toHaveLength(1);
    expect(r.calls).toContainEqual(['compare-env', 'github.com', null]);
    expect(JSON.stringify(r.calls)).not.toContain('If-None-Match');
    expect(readdirSync(cache)).toEqual([]);
    if (pass === 2) held(r, 'net diff unverified (forge-api-http-500); ');
    else expect(r.stderr).toContain('(forge)');
  }
}, setup), 120_000);
