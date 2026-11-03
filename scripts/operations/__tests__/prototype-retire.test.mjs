/**
 * @file Real-git proof for prototype registration retirement (R310, incident 2026-11-01).
 * Two daemons froze for hours on a superseded registration (#6056's `-m` ref, replaced by merged #6132) and
 * old tops. Every case builds real commits; only GitHub answers are stubbed.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { planRetirements, planFetchFailed, declaresSupersedes, mergeRefBase, carriedBeyondMain } from '../prototype-retire.mjs';

const dirs = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'we-proto-retire-'));
  dirs.push(dir);
  const raw = (args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
    { cwd: dir, encoding: 'utf8' });
  const ok = (...args) => { const r = raw(args); if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
  ok('init', '-q', '-b', 'main');
  const commit = (file, content, msg = `edit ${file}`) => { writeFileSync(join(dir, file), content); ok('add', '-A'); ok('commit', '-q', '-m', msg); return ok('rev-parse', 'HEAD'); };
  commit('README.md', 'init\n');
  const setRemote = (name, sha) => ok('update-ref', `refs/remotes/origin/${name}`, sha);
  // Same shape as prototype-load's `-m<N>` ref: commit-tree of the clean merge-tree, parents main + branch.
  const mergeRef = (a, b) => ok('commit-tree', ok('merge-tree', '--write-tree', a, b).split('\n')[0], '-p', a, '-p', b, '-m', 'merge');
  return { dir, ok, commit, setRemote, mergeRef, git: (args) => { const r = raw(args); return { code: r.status, stdout: r.stdout }; } };
}

/** gh stub: `prs` keyed by head ref, `views` keyed by number, `xrefs` keyed by number. Unknown calls fail. */
function ghStub({ heads = {}, views = {}, xrefs = {}, fail = false } = {}) {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (fail) return { code: 1, stdout: '' };
    if (args[0] === 'pr' && args[1] === 'list') {
      const head = args[args.indexOf('--head') + 1];
      return { code: 0, stdout: JSON.stringify(heads[head] ? [{ headRefName: head, ...heads[head] }] : []) };
    }
    if (args[0] === 'pr' && args[args.indexOf('--repo') + 1] !== 'web-everything/web-everything') return { code: 1, stdout: '' };
    if (args[0] === 'pr' && args[1] === 'view' && views[args[2]]) return { code: 0, stdout: JSON.stringify(views[args[2]]) };
    if (args[0] === 'api' && args[1] === 'graphql') {
      const n = Number(args.find((a) => a.startsWith('n=')).slice(2));
      return { code: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { timelineItems: { nodes: (xrefs[n] || []).map((source) => ({ source })) } } } } }) };
    }
    return { code: 1, stdout: '' };
  };
  return { gh, calls };
}

/** A merged cross-referencing PR of this repo, merged into main at `mergeCommit`. */
const src = (number, body, mergeCommit) => ({ number, merged: true, body, baseRefName: 'main',
  author: { login: 'web-everything' }, mergedAt: '2026-11-01T01:00:00Z', lastEditedAt: null, editor: null,
  repository: { nameWithOwner: 'web-everything/web-everything' }, mergeCommit: { oid: mergeCommit } });
const plan = (r, rows, gh) => planRetirements({ rows, git: r.git, gh, repo: 'web-everything/web-everything' });

describe('declaresSupersedes / mergeRefBase', () => {
  it('matches only an explicit Supersedes line for the exact PR number', () => {
    expect(declaresSupersedes('Body\nSupersedes #6056 (close after this lands).', 6056)).toBe(true);
    expect(declaresSupersedes('**Supersedes:** #12, #6056', 6056)).toBe(true);
    // Share the conveyor's explicit, case-sensitive declaration grammar.
    expect(declaresSupersedes('- supersedes: #12, #6056', 6056)).toBe(false);
    expect(declaresSupersedes('Supersedes #60561', 6056)).toBe(false);
    expect(declaresSupersedes('no port of #6056 diff', 6056)).toBe(false);
    expect(declaresSupersedes('This is not superseding anything. See #6056', 6056)).toBe(false);
  });
  it('maps loader merge refs to their branch', () => {
    expect(mergeRefBase('lane/x-m12')).toBe('lane/x');
    expect(mergeRefBase('lane/x')).toBe(null);
  });
  it.each([
    'Supersedes #10 (does not supersede #9)',
    'Supersedes #10, #11 and #12; excludes #9',
    '```md\nSupersedes #9\n```',
    '~~~\nSupersedes #9\n~~~',
    '    Supersedes #9',
    '`example\nSupersedes #9\n`',
    '<!--\nSupersedes #9\n-->',
    '<pre>\nSupersedes #9\n</pre>',
    '~~Supersedes #9~~',
    '> Supersedes #9',
    'Supersedes #90',
    'Supersedes #9x',
    'Supersedes #10\u2028Supersedes #9',
    'Supersedes #10\u200b #9',
    'Ｓupersedes #9',
    'Supersedes -- #9',
    'Supersedes "#9"',
    'Supersedes ../#9',
  ])('ignores a target outside an actual visible declaration: %s', (body) => {
    expect(declaresSupersedes(body, 9)).toBe(false);
  });
});

describe('planRetirements', () => {
  it('retires a loader merge ref whose branch is already merged into main (in-main)', () => {
    const r = repo();
    const base = r.ok('rev-parse', 'HEAD');
    r.ok('checkout', '-q', '-b', 'feature');
    const feature = r.commit('a.txt', 'a\n');
    r.ok('checkout', '-q', 'main');
    const mergedTip = r.mergeRef(base, feature);
    r.ok('checkout', '-q', '--detach', base);
    const mainNext = r.commit('b.txt', 'b\n');
    const main = r.mergeRef(mainNext, feature); // the branch landed on main
    const top = r.mergeRef(mergedTip, mainNext); // registration: an older merge of main + branch
    r.setRemote('main', main);
    r.setRemote('lane/feature-m2', top);
    const { gh } = ghStub();
    const [d] = plan(r, [{ ref: 'lane/feature-m2', pr: null }], gh);
    expect(d).toMatchObject({ ref: 'lane/feature-m2', action: 'retire', reason: 'in-main', tip: top, pr: null });
  });

  it('retires a registration whose merged PR was squash-merged onto main (pr-merged)', () => {
    const r = repo();
    const base = r.ok('rev-parse', 'HEAD');
    r.ok('checkout', '-q', '-b', 'feature');
    r.commit('a.txt', 'a1\n');
    const tip = r.commit('a.txt', 'a2\n');
    r.ok('checkout', '-q', '--detach', base);
    const main = r.commit('a.txt', 'a2\n', 'squash');
    r.setRemote('main', main);
    r.setRemote('lane/feature', tip);
    const { gh } = ghStub({ heads: { 'lane/feature': { number: 7, state: 'MERGED' } } });
    const [d] = plan(r, [{ ref: 'lane/feature', pr: null }], gh);
    expect(d).toMatchObject({ action: 'retire', reason: 'pr-merged', pr: 7, evidence: { contentInMain: true } });
  });

  it('retires a superseded registration: closed PR, merged PR declares Supersedes, nothing else carried', () => {
    const r = repo();
    const base = r.ok('rev-parse', 'HEAD');
    r.ok('checkout', '-q', '-b', 'old');
    const c1 = r.commit('x.txt', 'old approach\n');
    const c2 = r.commit('y.txt', 'old more\n');
    r.ok('checkout', '-q', '--detach', base);
    const main = r.commit('x.txt', 'new approach\n', 'superseder #6132');
    const top = r.mergeRef(base, c2);
    r.setRemote('main', main);
    r.setRemote('lane/old-m1', top);
    const { gh } = ghStub({
      heads: { 'lane/old': { number: 6056, state: 'CLOSED' } },
      views: { 6056: { commits: [{ oid: c1 }, { oid: c2 }] } },
      xrefs: { 6056: [src(6117, 'mentions #6056 only', main), src(6132, 'Supersedes #6056 (close after this lands).', main)] },
    });
    const [d] = plan(r, [{ ref: 'lane/old-m1', pr: null }], gh);
    expect(d).toMatchObject({ action: 'retire', reason: 'superseded', pr: 6056, tip: top, evidence: { supersededBy: 6132, prVia: 'merge-ref-base', supersederCommit: main } });
  });

  it('never retires a flag-pinned or edge-approved registration as superseded', () => {
    const r = repo();
    const base = r.ok('rev-parse', 'HEAD');
    r.ok('checkout', '-q', '-b', 'old');
    const c1 = r.commit('x.txt', 'old\n');
    r.ok('checkout', '-q', '--detach', base);
    const main = r.commit('x.txt', 'new\n');
    r.setRemote('main', main);
    r.setRemote('lane/old', c1);
    const { gh } = ghStub({
      heads: { 'lane/old': { number: 9, state: 'CLOSED' } },
      views: { 9: { commits: [{ oid: c1 }] } },
      xrefs: { 9: [src(12, 'Supersedes #9', main)] },
    });
    expect(plan(r, [{ ref: 'lane/old', pr: null, pinned: true }], gh)[0]).toMatchObject({ action: 'keep', reason: 'pinned-closed-pr' });
    expect(plan(r, [{ ref: 'lane/old', pr: null, edgeResolution: { sha: 'e'.repeat(40), by: 'x' } }], gh)[0]).toMatchObject({ action: 'keep', reason: 'edge-resolution-recorded' });
    expect(plan(r, [{ ref: 'lane/old', pr: null }], gh)[0]).toMatchObject({ action: 'retire', reason: 'superseded' });
  });

  it('keeps a flag-pinned closed-PR registration even when its content is on main, like the rebuild', () => {
    const r = repo();
    const base = r.ok('rev-parse', 'HEAD');
    r.ok('checkout', '-q', '-b', 'f');
    const tip = r.commit('a.txt', 'a\n');
    r.setRemote('main', tip);
    r.setRemote('lane/f', tip);
    void base;
    const { gh } = ghStub({ heads: { 'lane/f': { number: 4, state: 'CLOSED' } } });
    expect(plan(r, [{ ref: 'lane/f', pr: null, pinned: true }], gh)[0]).toMatchObject({ action: 'keep', reason: 'pinned-closed-pr' });
    expect(plan(r, [{ ref: 'lane/f', pr: null }], gh)[0]).toMatchObject({ action: 'retire', reason: 'in-main' });
  });

  it.each([
    ['another repository', { repository: { nameWithOwner: 'someone/fork' } }],
    ['a non-main base', { baseRefName: 'lane/x' }],
    ['a merge commit not on main', { mergeCommit: { oid: 'e'.repeat(40) } }],
    ['an explicitly excluded target', { body: 'Supersedes #10 (does not supersede #9)' }],
    ['a fenced example', { body: '```md\nSupersedes #9\n```' }],
    ['an outside contributor', { author: { login: 'outside-contributor' } }],
    ['a missing author', { author: undefined }],
    ['a deleted author', { author: null }],
    ['a malformed author', { author: { login: 7 } }],
    ['a forged app operator', { author: { login: 'app/chalbert', is_bot: true } }],
    ['an outside post-merge editor', { lastEditedAt: '2026-11-01T02:00:00Z', editor: { login: 'outside-contributor' } }],
    ['an unknown post-merge editor', { lastEditedAt: '2026-11-01T02:00:00Z', editor: null }],
    ['an unreadable edit timestamp', { lastEditedAt: 'unknown' }],
  ])('never retires on a Supersedes line from %s', (_label, override) => {
    const r = repo();
    const base = r.ok('rev-parse', 'HEAD');
    r.ok('checkout', '-q', '-b', 'old');
    const c1 = r.commit('x.txt', 'old\n');
    r.ok('checkout', '-q', '--detach', base);
    const main = r.commit('x.txt', 'new\n');
    r.setRemote('main', main);
    r.setRemote('lane/old', c1);
    const { gh } = ghStub({
      heads: { 'lane/old': { number: 9, state: 'CLOSED' } },
      views: { 9: { commits: [{ oid: c1 }] } },
      xrefs: { 9: [{ ...src(12, 'Supersedes #9', main), ...override }] },
    });
    expect(plan(r, [{ ref: 'lane/old', pr: null }], gh)[0]).toMatchObject({ action: 'keep', reason: 'unique-commits-not-on-main' });
  });

  it.each([
    [{ login: 'web-everything' }, null, null],
    [{ login: 'chalbert' }, '2026-11-01T02:00:00Z', { login: 'chalbert' }],
    [{ login: 'web-everything[bot]' }, '2026-11-01T00:00:00Z', { login: 'outside-contributor' }],
  ])('accepts trusted superseders and reads GitHub authorship and edit evidence (%j)', (author, lastEditedAt, editor) => {
    const r = repo();
    const base = r.ok('rev-parse', 'HEAD');
    const tip = r.commit('x.txt', 'unmerged work\n');
    r.setRemote('main', base);
    r.setRemote('lane/old', tip);
    const { gh, calls } = ghStub({
      heads: { 'lane/old': { number: 9, state: 'CLOSED' } },
      views: { 9: { commits: [{ oid: tip }] } },
      xrefs: { 9: [{ ...src(12, '### **Supersedes:** #10, #9 and #11 (replacement)', base), author, lastEditedAt, editor }] },
    });
    expect(plan(r, [{ ref: 'lane/old', pr: null }], gh)[0]).toMatchObject({ action: 'retire', reason: 'superseded' });
    const query = calls.find((args) => args[0] === 'api').find((arg) => arg.startsWith('query='));
    expect(query).toMatch(/author\s*\{\s*login\s*\}/);
    expect(query).toMatch(/editor\s*\{\s*login\s*\}/);
    expect(query).toContain('mergedAt');
    expect(query).toContain('lastEditedAt');
  });

  it('never retires a commit that only looks patch-equivalent to main', () => {
    const r = repo();
    const base = r.ok('rev-parse', 'HEAD');
    r.ok('checkout', '-q', '-b', 'side');
    const tip = r.commit('s.js', 'const s = "ab";\n');
    r.ok('checkout', '-q', '--detach', base);
    const main = r.commit('s.js', 'const s = "a b";\n');
    r.setRemote('main', main);
    r.setRemote('lane/side', tip);
    const [d] = plan(r, [{ ref: 'lane/side', pr: null }], ghStub().gh);
    expect(d).toMatchObject({ action: 'keep', reason: 'unique-commits-not-on-main', evidence: { unique: 1, contentInMain: false } });
  });

  it('never drops a closed registration whose unique commits are not on main and nothing supersedes it', () => {
    const r = repo();
    const base = r.ok('rev-parse', 'HEAD');
    r.ok('checkout', '-q', '-b', 'old');
    const c1 = r.commit('x.txt', 'unique work\n');
    r.setRemote('main', base);
    r.setRemote('lane/old', c1);
    const { gh } = ghStub({
      heads: { 'lane/old': { number: 9, state: 'CLOSED' } },
      views: { 9: { commits: [{ oid: c1 }] } },
      xrefs: { 9: [src(10, 'Related to #9', base), { ...src(11, 'Supersedes #9', base), merged: false }] },
    });
    expect(plan(r, [{ ref: 'lane/old', pr: null }], gh)[0]).toMatchObject({ action: 'keep', reason: 'unique-commits-not-on-main' });
  });

  it('never drops a superseded registration that carries a commit outside the closed PR', () => {
    const r = repo();
    const base = r.ok('rev-parse', 'HEAD');
    r.ok('checkout', '-q', '-b', 'old');
    const c1 = r.commit('x.txt', 'old\n');
    const extra = r.commit('z.txt', 'someone else\'s live fix\n');
    r.setRemote('main', base);
    r.setRemote('lane/old', extra);
    const { gh } = ghStub({
      heads: { 'lane/old': { number: 9, state: 'CLOSED' } },
      views: { 9: { commits: [{ oid: c1 }] } },
      xrefs: { 9: [src(12, 'Supersedes #9', base)] },
    });
    const [d] = plan(r, [{ ref: 'lane/old', pr: null }], gh);
    expect(d).toMatchObject({ action: 'keep', reason: 'carries-more-than-superseded-pr' });
    expect(d.evidence.foreign).toEqual([extra]);
  });

  it('never drops a merged PR registration whose unique commits are not on main', () => {
    const r = repo();
    const base = r.ok('rev-parse', 'HEAD');
    r.ok('checkout', '-q', '-b', 'top');
    const tip = r.commit('w.txt', 'combined top work not on main\n');
    r.setRemote('main', base);
    r.setRemote('lane/top', tip);
    const { gh } = ghStub({ views: { 5: { number: 5, state: 'MERGED', headRefName: 'lane/top' } } });
    expect(plan(r, [{ ref: 'lane/top', pr: 5 }], gh)[0]).toMatchObject({ action: 'keep', reason: 'unique-commits-not-on-main', pr: 5 });
  });

  it('keeps open PRs, unreadable GitHub answers and unresolved tips', () => {
    const r = repo();
    const base = r.ok('rev-parse', 'HEAD');
    r.setRemote('main', base);
    r.setRemote('lane/open', base);
    expect(plan(r, [{ ref: 'lane/open', pr: null }], ghStub({ heads: { 'lane/open': { number: 3, state: 'OPEN' } } }).gh)[0])
      .toMatchObject({ action: 'keep', reason: 'pr-open' });
    expect(plan(r, [{ ref: 'lane/open', pr: null }], ghStub({ fail: true }).gh)[0]).toMatchObject({ action: 'keep', reason: 'pr-state-unknown' });
    expect(plan(r, [{ ref: 'lane/missing', pr: null }], ghStub().gh)[0]).toMatchObject({ action: 'keep', reason: 'tip-unresolved' });
    expect(planRetirements({ rows: [{ ref: 'lane/open', pr: null }], git: r.git, gh: ghStub().gh, repo: '' })[0]).toMatchObject({ action: 'keep', reason: 'repo-unknown' });
  });

  it('does not count a merge with hidden edits as clean', () => {
    const r = repo();
    const base = r.ok('rev-parse', 'HEAD');
    r.ok('checkout', '-q', '-b', 'side');
    const side = r.commit('a.txt', 'a\n');
    r.ok('checkout', '-q', '--detach', base);
    const mainNext = r.commit('b.txt', 'b\n');
    const main = r.mergeRef(mainNext, side);
    // An "evil" merge: parents main + side, but its tree carries an extra file.
    r.ok('checkout', '-q', '--detach', main);
    writeFileSync(join(r.dir, 'hidden.txt'), 'hidden\n');
    r.ok('add', '-A');
    const evil = r.ok('commit-tree', r.ok('write-tree'), '-p', mainNext, '-p', side, '-m', 'merge');
    r.setRemote('main', main);
    r.setRemote('lane/evil', evil);
    const carried = carriedBeyondMain({ git: r.git, ref: 'lane/evil' });
    expect(carried).toMatchObject({ ok: true, unique: [], cleanMerges: false, contentInMain: false });
    expect(plan(r, [{ ref: 'lane/evil', pr: null }], ghStub().gh)[0]).toMatchObject({ action: 'keep', reason: 'unique-commits-not-on-main' });
  });
});

describe('planFetchFailed (registration whose branch could not be fetched)', () => {
  const REPO = 'web-everything/web-everything';
  const OFF = 'f'.repeat(40);
  const ZERO = '0'.repeat(40);
  const T = (n) => `2026-11-02T10:0${n}:00Z`;
  const event = (activity_type, before, after, n) => ({ activity_type, before, after, timestamp: T(n) });
  const merged = (head, extra = {}) => ({ number: 7, state: 'MERGED', headRefName: 'lane/gone', headRefOid: head,
    headRepository: { nameWithOwner: REPO }, isCrossRepository: false, mergeCommit: { oid: head }, ...extra });
  /** gh stub: `prs` answers `pr list`, `activity` answers the ref activity log (newest first, as GitHub returns it). */
  const stub = (prs, activity, { failList = false, failActivity = false, raw } = {}) => {
    const calls = [];
    const gh = (args) => {
      calls.push(args);
      if (args[0] === 'pr' && args[1] === 'list') return failList ? { code: 1, stdout: '' } : { code: 0, stdout: raw ?? JSON.stringify(prs) };
      if (args[0] === 'api') return failActivity ? { code: 1, stdout: '' } : { code: 0, stdout: JSON.stringify(activity) };
      return { code: 1, stdout: '' };
    };
    return { gh, calls };
  };
  const deletedAt = (tip) => [event('branch_deletion', tip, ZERO, 5), event('push', OFF, tip, 3), event('branch_creation', ZERO, OFF, 1)];
  const run = (r, s, row = { ref: 'lane/gone' }) => planFetchFailed({ row, git: r.git, gh: s.gh, repo: REPO });
  const withMain = () => { const r = repo(); r.setRemote('main', r.ok('rev-parse', 'HEAD')); return r; };
  const KEEP = { action: 'keep', reason: 'fetch-failed' };

  it('retires a MERGED origin PR whose head is the branch tip at its newest deletion and whose merge commit is on origin/main', () => {
    const r = withMain();
    const sha = r.ok('rev-parse', 'HEAD');
    const s = stub([merged(sha)], deletedAt(sha));
    expect(run(r, s)).toEqual({ ref: 'lane/gone', action: 'retire', reason: 'pr-squash-merged', tip: sha, pr: 7,
      evidence: { refGone: true, prState: 'MERGED', mergeCommit: sha, prVia: 'head-ref', deletedTip: sha } });
    // the activity read names the exact ref and the PR read covers every state
    const api = s.calls.find((c) => c[0] === 'api');
    expect(api[1]).toBe(`repos/${REPO}/activity?ref=refs%2Fheads%2Flane%2Fgone&per_page=10`);
    expect(s.calls.find((c) => c[0] === 'pr')[s.calls.find((c) => c[0] === 'pr').indexOf('--state') + 1]).toBe('all');
  });
  it('retires when the recorded PR number matches', () => {
    const r = withMain();
    const sha = r.ok('rev-parse', 'HEAD');
    expect(run(r, stub([merged(sha)], deletedAt(sha)), { ref: 'lane/gone', pr: 7 })).toMatchObject({ action: 'retire', pr: 7 });
  });
  it('keeps a reused name deleted at a different tip (unmerged work after the merged PR)', () => {
    const r = withMain();
    const sha = r.ok('rev-parse', 'HEAD');
    const reused = [event('branch_deletion', OFF, ZERO, 9), event('push', sha, OFF, 8), event('branch_creation', ZERO, sha, 7), event('branch_deletion', sha, ZERO, 5)];
    expect(run(r, stub([merged(sha)], reused))).toEqual({ ref: 'lane/gone', ...KEEP });
  });
  it('keeps when the newest ref event is not a deletion (the branch exists or was recreated)', () => {
    const r = withMain();
    const sha = r.ok('rev-parse', 'HEAD');
    expect(run(r, stub([merged(sha)], [event('branch_creation', ZERO, sha, 9), ...deletedAt(sha)]))).toMatchObject(KEEP);
    expect(run(r, stub([merged(sha)], [event('push', OFF, sha, 9), ...deletedAt(sha)]))).toMatchObject(KEEP);
  });
  it('keeps when the activity log is unreadable, empty, malformed or ties for newest', () => {
    const r = withMain();
    const sha = r.ok('rev-parse', 'HEAD');
    expect(run(r, stub([merged(sha)], [], { failActivity: true }))).toMatchObject(KEEP);
    expect(run(r, stub([merged(sha)], []))).toMatchObject(KEEP);
    expect(run(r, stub([merged(sha)], { not: 'a list' }))).toMatchObject(KEEP);
    expect(run(r, stub([merged(sha)], [{ ...event('branch_deletion', sha, ZERO, 5), timestamp: 'never' }]))).toMatchObject(KEEP);
    expect(run(r, stub([merged(sha)], [event('branch_deletion', sha, ZERO, 5), event('push', OFF, sha, 5)]))).toMatchObject(KEEP);
    expect(run(r, stub([merged(sha)], [event('branch_deletion', 'short', ZERO, 5)]))).toMatchObject(KEEP);
  });
  it('keeps when the deleted tip is not the merged PR head', () => {
    const r = withMain();
    const sha = r.ok('rev-parse', 'HEAD');
    expect(run(r, stub([merged(sha)], deletedAt(OFF)))).toMatchObject(KEEP);
  });
  it('keeps when the PR is not MERGED', () => {
    const r = withMain();
    const sha = r.ok('rev-parse', 'HEAD');
    for (const state of ['OPEN', 'CLOSED']) expect(run(r, stub([merged(sha, { state })], deletedAt(sha)))).toMatchObject(KEEP);
  });
  it('keeps when the PR lookup fails or is unparseable', () => {
    const r = withMain();
    const sha = r.ok('rev-parse', 'HEAD');
    expect(run(r, stub([], deletedAt(sha), { failList: true }))).toMatchObject(KEEP);
    expect(run(r, stub([], deletedAt(sha), { raw: 'not json' }))).toMatchObject(KEEP);
  });
  it('keeps when the merge commit is not an ancestor of origin/main', () => {
    const r = withMain();
    r.ok('checkout', '-q', '-b', 'side');
    const off = r.commit('side.txt', 'x\n');
    expect(run(r, stub([merged(off)], deletedAt(off)))).toMatchObject(KEEP);
    expect(run(r, stub([merged(OFF)], deletedAt(OFF)))).toMatchObject(KEEP);
  });
  it('keeps when several PRs, a different recorded PR number, a full result page or an edge resolution is present', () => {
    const r = withMain();
    const sha = r.ok('rev-parse', 'HEAD');
    const events = deletedAt(sha);
    expect(run(r, stub([merged(sha), merged(sha, { number: 8, state: 'CLOSED', mergeCommit: null })], events))).toMatchObject(KEEP);
    expect(run(r, stub([merged(sha)], events), { ref: 'lane/gone', pr: 99 })).toMatchObject(KEEP);
    expect(run(r, stub([merged(sha)], events), { ref: 'lane/gone', edgeResolution: { x: 1 } })).toMatchObject(KEEP);
    const full = [merged(sha), ...Array.from({ length: 9 }, (_, i) => merged(sha, { number: 20 + i, state: 'CLOSED', mergeCommit: null, headRefName: 'other' }))];
    expect(run(r, stub(full, events))).toMatchObject(KEEP);
  });
  it('keeps a PR from a fork or whose head repository cannot be classified', () => {
    const r = withMain();
    const sha = r.ok('rev-parse', 'HEAD');
    const events = deletedAt(sha);
    expect(run(r, stub([merged(sha, { isCrossRepository: true, headRepository: { nameWithOwner: 'contributor/web-everything' } })], events))).toMatchObject(KEEP);
    for (const extra of [{ isCrossRepository: undefined }, { isCrossRepository: 'false' }, { headRepository: null }, { headRepository: { nameWithOwner: `${REPO}\n` } },
      { headRepository: { nameWithOwner: 'contributor/web-everything' } }]) {
      expect(run(r, stub([merged(sha, extra)], events))).toMatchObject(KEEP);
    }
    // a fork's same-named PR beside the single origin PR does not block it, an unclassifiable one does
    const fork = merged(sha, { number: 9, state: 'OPEN', isCrossRepository: true, headRepository: { nameWithOwner: 'contributor/web-everything' } });
    expect(run(r, stub([merged(sha), fork], events))).toMatchObject({ action: 'retire' });
    expect(run(r, stub([merged(sha), { ...fork, headRepository: null }], events))).toMatchObject(KEEP);
  });
  it('keeps for an unknown repository or missing IO', () => {
    const r = withMain();
    const sha = r.ok('rev-parse', 'HEAD');
    const s = stub([merged(sha)], deletedAt(sha));
    expect(planFetchFailed({ row: { ref: 'lane/gone' }, git: r.git, gh: s.gh, repo: '' })).toMatchObject(KEEP);
    expect(planFetchFailed({ row: { ref: 'lane/gone' } })).toMatchObject(KEEP);
  });
});
