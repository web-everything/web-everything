// @vitest-environment node
import { it, expect, vi } from 'vitest';
import { defaultResolvedSideBranchIo, enrichResolvedSideBranches, resolveResolvedSideBranchSetting } from '../resolved-side-branch-io.mjs';
import { planReconcile } from '../reconcile-core.mjs';

const H = '1'.repeat(40), B = '2'.repeat(40), S = '3'.repeat(40);
const repo = 'web-everything/web-everything';
const pr = { number: 7329, state: 'OPEN', isCrossRepository: false, headRefName: 'lane/topic',
  headRefOid: H, baseRefName: 'main', baseRefOid: B, comments: [] };

it('bounded rotation distinguishes unscanned PRs from unreadable evidence and never grants a write', () => {
  const prs = Array.from({ length: 9 }, (_, i) => ({ ...pr, number: i + 1 }));
  const io = { readPr: vi.fn((_repo, n) => prs[n - 1]), readBranches: vi.fn(() => []) };
  const cursors = new Map();
  const first = enrichResolvedSideBranches(prs, { repo, io, cursors });
  expect(io.readPr).toHaveBeenCalledTimes(8);
  expect(first[7].resolvedSideBranches).toEqual([]);
  expect(first[8]).not.toHaveProperty('resolvedSideBranches');
  const next = enrichResolvedSideBranches(prs, { repo, io, cursors });
  expect(next[8].resolvedSideBranches).toEqual([]);
});

it.each([
  ['read failure', () => { throw Error('unreadable'); }],
  ['oversized refs', () => Array.from({ length: 17 }, () => ({ name: 'unknown' }))],
])('%s becomes an operator-visible refusal, never full resolution', (_name, readBranches) => {
  const rows = enrichResolvedSideBranches([pr], { repo, io: { readPr: () => pr, readBranches } });
  expect(rows[0].resolvedSideBranches).toBeNull();
  const result = planReconcile({ prs: rows });
  expect(result.dispatch).toEqual([]);
  expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'resolved-side-branch-unreadable', why: expect.stringContaining('operator inspection') }));
});

it('moved PR read refuses before reading saved branches', () => {
  const readBranches = vi.fn();
  const rows = enrichResolvedSideBranches([pr], { repo, io: { readPr: () => ({ ...pr, headRefOid: S }), readBranches } });
  expect(rows[0].resolvedSideBranches).toBeNull();
  expect(readBranches).not.toHaveBeenCalled();
});

it('discovery uses only bounded reads and a disposable bare repository, never a push or hook override', () => {
  const calls = [];
  const exec = (bin, args, opts) => {
    calls.push({ bin, args, opts });
    if (args.includes('ls-remote')) return `${S}\trefs/heads/lane/topic-fix-7329-saved\n`;
    if (args.includes('rev-parse')) return args.at(-1).match(/[a-f0-9]{40}/)[0];
    if (args.includes('rev-list')) return [S, H, B].join('\n');
    return '';
  };
  const io = defaultResolvedSideBranchIo({ exec, tokenForRepo: () => 'ghs_fixture', ghBin: '/fixture/gh' });
  expect(Object.keys(io).sort()).toEqual(['readBranches', 'readPr']);
  expect(io.readBranches(pr, repo)).toEqual([{ name: 'lane/topic-fix-7329-saved', sha: S, ancestors: [S, H, B] }]);
  expect(calls.every(c => c.opts.maxBuffer === 2 * 1024 * 1024 && c.opts.timeout === 30000)).toBe(true);
  expect(calls.every(c => c.bin === '/usr/bin/git')).toBe(true);
  expect(calls.some(c => c.args.includes('--bare'))).toBe(true);
  expect(calls.some(c => c.args.includes('push'))).toBe(false);
  expect(calls.some(c => c.args.some(a => /--no-verify|core.hooksPath/.test(a)))).toBe(false);
});

it('shared API-call bound fails closed with operator fallback, including comment reads', () => {
  const exec = vi.fn(() => JSON.stringify({ number: pr.number, state: 'open', head: { ref: pr.headRefName, sha: H }, base: { ref: 'main', sha: B } }));
  const io = defaultResolvedSideBranchIo({ exec, tokenForRepo: () => 'ghs_fixture', ghBin: '/fixture/gh', maxCalls: 1 });
  expect(() => io.readPr(repo, pr.number)).toThrow(/API budget exhausted.*operator inspection/);
  expect(exec).toHaveBeenCalledOnce();
});

it('setting retains cascade, invalid-policy refusal and provenance for the push-only launch', () => {
  const setting = options => resolveResolvedSideBranchSetting({ env: {}, platform: {}, tool: {}, ...options });
  expect(setting()).toEqual({ value: true, source: 'standard' });
  expect(setting({ platform: { pushResolvedSideBranch: false } })).toEqual({ value: false, source: 'platform' });
  expect(setting({ platform: { pushResolvedSideBranch: true }, tool: { pushResolvedSideBranch: false } })).toEqual({ value: false, source: 'tool' });
  expect(setting({ env: { WE_FIX_PUSH_RESOLVED_SIDE_BRANCH: 'on' }, tool: { pushResolvedSideBranch: false } })).toEqual({ value: true, source: 'env' });
  expect(setting({ env: { WE_FIX_PUSH_RESOLVED_SIDE_BRANCH: 'unknown' } })).toMatchObject({ value: false, source: expect.stringContaining('operator inspection') });
});
