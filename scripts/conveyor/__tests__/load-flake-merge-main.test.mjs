import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLoadFlakeRedispatchComment, buildLoadFlakeRedispatchResolvedComment } from '../stand-down.mjs';
import { runLoadFlakeReverify, reverifyConfig } from '../load-flake-reverify.mjs';
import {
  resolveMergeMainBeforeRetry, logMergeMainSource, describeMergeMain, defaultMergeMain,
  MERGE_MAIN_ENV, PLATFORM_PREFERENCES_ENV, TOOL_SETTINGS_PATH,
} from '../load-flake-merge-main.mjs';

const HEAD = '4687407aa2e4a95188ee4e5f72f936971101b619';
const MAIN = '0be65caf34925bce962197399643296cdb148e1b';
const MERGED = 'm3r6ed0000000000000000000000000000000000';
const comment = (body, createdAt) => ({ body, createdAt, author: { login: 'web-everything' } });

/** The plateau #220 hold as posted at 12:33:48Z: a re-dispatch hold on the old head. */
function fixture({ mergeMain } = {}) {
  const pr = { number: 220, state: 'OPEN', headRefName: 'lane/request-build-now', headRefOid: HEAD, baseRefName: 'main',
    labels: [{ name: 'review:changes' }], comments: [comment(buildLoadFlakeRedispatchComment({ head: HEAD }), '2026-10-10T12:33:48Z')] };
  const order = [];
  const io = { now: () => Date.parse('2026-10-10T12:37:50Z'), loadavg: () => [1, 2], cpuCount: () => 12,
    listPrs: vi.fn(async () => [structuredClone(pr)]), readPr: vi.fn(async () => pr), pushRefusal: vi.fn(() => null),
    acquire: vi.fn(), verify: vi.fn(), push: vi.fn(), prepare: vi.fn(),
    comment: vi.fn((_slug, _n, body) => { order.push(['comment', body]); }),
    mergeMain: mergeMain === null ? undefined : vi.fn((args) => { order.push(['mergeMain', args]); return mergeMain ?? { result: 'merged', base: 'main', headSha: HEAD, mainSha: MAIN, sha: MERGED }; }) };
  return { pr, io, order };
}
const sweep = (io, env = {}) => runLoadFlakeReverify({ repo: 'plateau-app', config: reverifyConfig(env) }, io);

describe('load-flake retry merges main first (#xg0rkxn, live plateau #220)', () => {
  it('merges main into the old head BEFORE posting the re-dispatch, and says so on the PR', async () => {
    const { io, order } = fixture();
    const out = await sweep(io);
    expect(out.redispatched).toEqual([{ pr: 220, result: 'redispatched' }]);
    expect(order.map(([k]) => k)).toEqual(['mergeMain', 'comment']);
    expect(order[0][1]).toEqual({ slug: 'plateauapp/plateau-app', branch: 'lane/request-build-now', headSha: HEAD, base: 'main' });
    expect(order[1][1]).toContain('result=redispatched');
    expect(order[1][1]).toContain(`Merged current \`main\` (${MAIN.slice(0, 9)}) into the head first`);
  });
  it('a conflict is not resolved here: the retry goes ahead and the PR names the conflict-fix path', async () => {
    const { io, order } = fixture({ mergeMain: { result: 'conflict', base: 'main', headSha: HEAD, mainSha: MAIN, files: ['src/a.ts'] } });
    await sweep(io);
    expect(order.map(([k]) => k)).toEqual(['mergeMain', 'comment']);
    expect(order[1][1]).toContain('conflicts with the head (src/a.ts); not merged here, left to the conflict-fix path');
  });
  it('up to date: no merge note', async () => {
    const { io, order } = fixture({ mergeMain: { result: 'up-to-date', base: 'main', headSha: HEAD, mainSha: MAIN } });
    await sweep(io);
    expect(order[1][1]).not.toContain('Merged current');
  });
  it('the setting off skips the merge; a failed merge leaves the hold for the next sweep', async () => {
    const off = fixture();
    await sweep(off.io, { [MERGE_MAIN_ENV]: 'false' });
    expect(off.io.mergeMain).not.toHaveBeenCalled();
    expect(off.io.comment).toHaveBeenCalledTimes(1);
    const failing = fixture();
    failing.io.mergeMain = vi.fn(() => { throw new Error('push rejected'); });
    const out = await sweep(failing.io);
    expect(out.redispatched).toEqual([{ pr: 220, error: 'push rejected' }]);
    expect(failing.io.comment).not.toHaveBeenCalled();
  });
  it('an exhausted hold is not merged (a human is next)', async () => {
    const { io, pr } = fixture();
    pr.comments.unshift(comment(buildLoadFlakeRedispatchResolvedComment({ result: 'redispatched' }), '2026-10-10T04:07:01Z'));
    io.listPrs = vi.fn(async () => [structuredClone(pr)]);
    await sweep(io, { WE_LOAD_FLAKE_REVERIFY_MAX_ATTEMPTS: '1' });
    expect(io.mergeMain).not.toHaveBeenCalled();
    expect(io.comment.mock.calls[0][2]).toContain('result=exhausted');
  });
});

describe('loadFlake.mergeMainBeforeRetry resolves in the policy-cascade shape', () => {
  const files = (map) => (path) => { if (path in map) return map[path]; throw Object.assign(new Error('nope'), { code: 'ENOENT' }); };
  it('standard default true; platform, tool, env each override the layer below; invalid never overrides', () => {
    expect(resolveMergeMainBeforeRetry({ env: {}, readFile: files({}) })).toMatchObject({ value: true, source: 'standard' });
    const platform = { '/p.json': JSON.stringify({ loadFlake: { mergeMainBeforeRetry: false } }) };
    expect(resolveMergeMainBeforeRetry({ env: { [PLATFORM_PREFERENCES_ENV]: '/p.json' }, readFile: files(platform) })).toMatchObject({ value: false, source: 'platform' });
    const tool = { ...platform, [TOOL_SETTINGS_PATH]: JSON.stringify({ mergeMainBeforeRetry: true }) };
    expect(resolveMergeMainBeforeRetry({ env: { [PLATFORM_PREFERENCES_ENV]: '/p.json' }, readFile: files(tool) })).toMatchObject({ value: true, source: 'tool' });
    expect(resolveMergeMainBeforeRetry({ env: { [PLATFORM_PREFERENCES_ENV]: '/p.json', [MERGE_MAIN_ENV]: '0' }, readFile: files(tool) })).toMatchObject({ value: false, source: 'env' });
    const bad = resolveMergeMainBeforeRetry({ env: { [MERGE_MAIN_ENV]: 'maybe' }, readFile: files({}) });
    expect(bad).toMatchObject({ value: true, source: 'standard', invalid: ['env="maybe"'] });
  });
  it('logs the source once per distinct value', () => {
    const lines = [];
    const r = resolveMergeMainBeforeRetry({ env: {}, readFile: files({}) });
    expect(logMergeMainSource(r, (l) => lines.push(l))).toBe(true);
    expect(logMergeMainSource(r, (l) => lines.push(l))).toBe(false);
    expect(lines).toEqual(['policy-cascade · loadFlake: mergeMainBeforeRetry=true (standard)\n']);
  });
});

describe('defaultMergeMain against real git (plumbing merge, fast-forward push, no force)', () => {
  const dirs = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
  function repos({ conflict = false } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'lf-merge-main-')); dirs.push(root);
    const remote = join(root, 'remote.git'); const work = join(root, 'work'); const daemon = join(root, 'daemon');
    git(root, 'init', '--bare', '-q', '-b', 'main', remote);
    git(root, 'clone', '-q', remote, work);
    writeFileSync(join(work, 'a.txt'), 'base\n'); git(work, 'add', 'a.txt'); git(work, 'commit', '-qm', 'base'); git(work, 'push', '-q', remote, 'HEAD:refs/heads/main');
    git(work, 'checkout', '-qb', 'lane/fix'); writeFileSync(join(work, conflict ? 'a.txt' : 'b.txt'), 'pr\n'); git(work, 'add', '-A'); git(work, 'commit', '-qm', 'pr'); git(work, 'push', '-q', remote, 'HEAD:refs/heads/lane/fix');
    const head = git(work, 'rev-parse', 'HEAD');
    git(work, 'checkout', '-q', 'main'); writeFileSync(join(work, 'a.txt'), 'main fix\n'); git(work, 'commit', '-qam', 'timing fix'); git(work, 'push', '-q', remote, 'HEAD:refs/heads/main');
    const main = git(work, 'rev-parse', 'HEAD');
    git(root, 'init', '-q', daemon);
    return { remote, daemon, head, main };
  }
  const run = (bin, args, opts) => execFileSync(bin, args, { ...opts, env: { ...process.env, GIT_AUTHOR_NAME: 'd', GIT_AUTHOR_EMAIL: 'd@d', GIT_COMMITTER_NAME: 'd', GIT_COMMITTER_EMAIL: 'd@d' } });
  it('merges main into the head and pushes the merge commit as a fast-forward', () => {
    const { remote, daemon, head, main } = repos();
    const out = defaultMergeMain({ slug: 'x/y', branch: 'lane/fix', headSha: head, base: 'main' }, { run, cwd: daemon, url: remote });
    expect(out).toMatchObject({ result: 'merged', headSha: head, mainSha: main });
    expect(git(remote, 'rev-parse', 'refs/heads/lane/fix')).toBe(out.sha);
    expect(git(remote, 'rev-parse', `${out.sha}^1`, `${out.sha}^2`).split('\n')).toEqual([head, main]);
    expect(defaultMergeMain({ slug: 'x/y', branch: 'lane/fix', headSha: out.sha }, { run, cwd: daemon, url: remote })).toMatchObject({ result: 'up-to-date' });
  });
  it('a conflict pushes nothing and names the file', () => {
    const { remote, daemon, head } = repos({ conflict: true });
    expect(defaultMergeMain({ slug: 'x/y', branch: 'lane/fix', headSha: head }, { run, cwd: daemon, url: remote })).toMatchObject({ result: 'conflict', files: ['a.txt'] });
    expect(git(remote, 'rev-parse', 'refs/heads/lane/fix')).toBe(head);
  });
  it('describes each outcome for the PR comment', () => {
    expect(describeMergeMain(null)).toBe('');
    expect(describeMergeMain({ result: 'up-to-date' })).toBe('');
  });
});
