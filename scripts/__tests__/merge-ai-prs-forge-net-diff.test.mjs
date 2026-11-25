// @vitest-environment node
import { it, expect, vi, afterEach } from 'vitest';
import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeDiffFingerprint } from '../lib/review-escalation.mjs';
import { synthesizeUnifiedDiff } from '../lib/drain-api-reads.mjs';
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
it.each(['ahead', 'diverged'])('an %s compare with no files holds and prevents delivery', status => world(async ({ pr, run }) => {
  ready(pr); pr.compare = compare({ status, files: [] });
  held(await run(false, options), 'net diff unverified (forge-compare-empty); ');
}, setup), 120_000);
it('clear-human cannot admit an unverified forge compare', () => world(async ({ pr, run }) => {
  ready(pr); pr.compare = { status: 500 };
  pr.comments[0].body += '\n<!-- cleared-human: chalbert -->';
  held(await run(false, options), 'net diff unverified (forge-api-http-500); ');
}, setup), 120_000);
it('a full 100-file compare page holds and prevents delivery even after clear-human', () => world(async ({ pr, run }) => {
  ready(pr);
  pr.compare = compare({ files: Array.from({ length: 100 }, (_, i) => file({ filename: `src/file-${i}.ts` })) });
  pr.comments[0].body += '\n<!-- cleared-human: chalbert -->';
  held(await run(false, options), 'net diff unverified (forge-compare-ceiling); ');
}, setup), 120_000);
it('a non-local test-tampering PR stays cleared at the current head and attempts delivery', () => world(async ({ pr, run }) => {
  ready(pr); pr.compare = compare({ files: [file({ filename: 'blocks/__tests__/x.test.ts', patch: '@@ -0,0 +1 @@\n+it.skip("works", () => {});' })] });
  pr.comments[0].body += '\n<!-- cleared-human: chalbert -->';
  const r = await run(false, options);
  expect(r.report.parked, r.stderr).toEqual([]);
  expect(r.calls.some(a => a.some(x => x?.includes('enqueuePullRequest')) || (a[0] === 'pr' && a[1] === 'merge'))).toBe(true);
  noRemoteGit(r.calls);
}, setup), 120_000);
it.each([
  { name: 'complete comments', sibling: true },
  { name: 'missing clone', sibling: false },
  { name: 'mismatched sibling origin', sibling: true, siblingOrigin: setup.localSlug },
  { name: 'mismatched comment count', sibling: true, commentsTotalCount: 2 },
])('an older non-local clearance needs a sibling clone and complete comments: $name', ({ sibling, siblingOrigin, commentsTotalCount }) => world(async ({ pr, run }) => {
  ready(pr);
  pr.compare = compare({ files: [file({ filename: 'blocks/__tests__/x.test.ts', patch: '@@ -0,0 +1 @@\n+it.skip("works", () => {});' })] });
  pr.gitDiffText = synthesizeUnifiedDiff(pr.compare.files);
  // A durable carry must cite the original human comment, as a real forge comment does.
  pr.comments[0].id = 'IC_clearance';
  pr.comments[0].body = `<!-- reviewed-sha: ${'c'.repeat(40)} -->\n<!-- cleared-human: chalbert -->\n<!-- reviewed-diff: ${normalizeDiffFingerprint(pr.gitDiffText)} -->`;
  pr.commentsTotalCount = commentsTotalCount;
  const r = await run(false, { ...options, env: { WE_ACCEPT_CARRY_FORWARD: 'on' } });
  const delivered = r.calls.some(a => a.some(x => x?.includes('enqueuePullRequest')) || (a[0] === 'pr' && a[1] === 'merge'));
  const usableClone = sibling && siblingOrigin === undefined;
  expect(delivered, r.stderr).toBe(usableClone && commentsTotalCount === undefined);
  if (usableClone && commentsTotalCount === undefined) {
    expect(r.report.parked, r.stderr).toEqual([]);
    expect(r.calls.some(a => a[0] === 'git' && a.includes('diff') && a.includes(pr.headRefOid))).toBe(true);
    const carryRecord = r.calls.findIndex(a => a[0] === 'pr' && a[1] === 'comment'
      && a.some(x => x?.includes('<!-- cleared-from: IC_clearance -->')));
    expect(carryRecord).toBeGreaterThanOrEqual(0);
    const countRead = r.calls.findIndex(a => a[0] === 'api' && a[1] === 'graphql'
      && a.some(x => x?.includes('comments{totalCount}')));
    expect(countRead).toBeGreaterThanOrEqual(0);
    expect(countRead).toBeLessThan(carryRecord);
    expect(r.calls[carryRecord].join('\n')).toContain(`<!-- reviewed-sha: ${pr.headRefOid} -->`);
    expect(carryRecord).toBeLessThan(r.calls.findIndex(a => a.some(x => x?.includes('enqueuePullRequest')) || (a[0] === 'pr' && a[1] === 'merge')));
  } else {
    expect(r.calls.some(a => a[0] === 'pr' && a[1] === 'comment'
      && a.some(x => x?.includes('<!-- cleared-from: IC_clearance -->')))).toBe(false);
    if (commentsTotalCount !== undefined) {
      // The live pre-write guard defers before the label gate when thread completeness is unknown.
      const reason = `human clearance carry (${'c'.repeat(9)}→${pr.headRefOid.slice(0, 9)}) not recorded: live re-read failed: complete comments read did not match a valid GraphQL totalCount — merge deferred this pass`;
      expect(r.report.skipped, r.stderr).toEqual(expect.arrayContaining([expect.objectContaining({ num: 42, reason })]));
      expect(r.report.parked, r.stderr).toEqual([]);
      expect(r.stderr).toContain(reason);
      expect(r.calls.filter(a => a.includes('--add-label') || a.includes('--remove-label'))).toEqual([]);
    } else {
      expect(r.calls.some(a => a.includes('--add-label') && a.some(x => x?.includes('review:held-mechanical')))).toBe(true);
    }
  }
}, { ...setup, siblingClone: sibling, siblingOrigin }), 120_000);
it('the CLI passes a non-main base through to the forge guard before any compare read', () => world(async ({ pr, run }) => {
  ready(pr); pr.baseRefName = 'release';
  // Match the repo default so classification reaches scoring; the forge reader only supports main.
  const r = await run(false, { ...options, defaultBranch: 'release' });
  held(r, 'net diff unverified (forge-stacked-base); ');
  expect(r.calls.some(a => a[0] === 'api' && a.some(x => x?.includes('/compare/')))).toBe(false);
}, setup), 120_000);
it.each([
  ['api-http-500', { status: 500 }], ['api-http-404', { status: 404 }],
  ['api-malformed', compare({ files: undefined })], ['compare-ceiling', compare({ files: Array.from({ length: 300 }, () => file()) })],
  ['patch-omitted', compare({ files: [file({ patch: undefined })] })],
  ['patch-truncated', compare({ files: [file({ additions: 2, changes: 2 })] })],
  ['path-unsupported', compare({ files: [file({ filename: 'a b/c.ts' })] })],
  ['patch-malformed', compare({ files: [file({ patch: '@@ nonsense\n+export const x = 1;' })] })],
  ['patch-malformed', compare({ files: [file({ patch: '+export const x = 1;' })] })],
  ['patch-malformed', compare({ files: [file({ patch: '@@ -0,0 +1,2 @@\n+export const x = 1;' })] })],
  ['compare-empty', compare({ status: 'identical' })], ['head-unbound', compare()],
])('every unknown holds: %s', (reason, doc) => world(async ({ pr, run }) => {
  ready(pr); pr.compare = doc;
  if (reason === 'head-unbound') pr.headRefOid = 'bad-head';
  held(await run(false, options), `net diff unverified (forge-${reason}); `);
}, setup), 120_000);
it('a stacked or unknown base is unscored with forge-stacked-base and never reads the compare', async () => {
  const { forgeNetDiffSignals, describeUnverifiedNetDiff } = await import('../lib/forge-net-diff.mjs');
  for (const baseRef of ['lane/other', null, '']) {
    const read = vi.fn();
    const s = forgeNetDiffSignals({ repo: 'o/r', headSha: 'a'.repeat(40), allowedRepos: ['o/r'], read, baseRef });
    expect(s.scored).toBe(false);
    expect(s.netDiffText).toMatchObject({ scored: false, reason: 'forge-stacked-base' });
    expect(read).not.toHaveBeenCalled();
    expect(describeUnverifiedNetDiff({ repo: 'o/r', headSha: 'a'.repeat(40), reason: s.netDiffText.reason, transient: s.netDiffText.transient }))
      .toBe('net diff unverified (forge-stacked-base); stacked PR: net diff is read once its base lands. Wake: after retargeting to main and verifying the compare is readable, run clear-human and restore ready-to-merge.');
  }
});
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
