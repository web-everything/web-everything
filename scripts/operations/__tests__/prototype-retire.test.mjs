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
import { planRetirements, declaresSupersedes, mergeRefBase, carriedBeyondMain } from '../prototype-retire.mjs';

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
  repository: { nameWithOwner: 'web-everything/web-everything' }, mergeCommit: { oid: mergeCommit } });
const plan = (r, rows, gh) => planRetirements({ rows, git: r.git, gh, repo: 'web-everything/web-everything' });

describe('declaresSupersedes / mergeRefBase', () => {
  it('matches only an explicit Supersedes line for the exact PR number', () => {
    expect(declaresSupersedes('Body\nSupersedes #6056 (close after this lands).', 6056)).toBe(true);
    expect(declaresSupersedes('- supersedes: #12, #6056', 6056)).toBe(true);
    expect(declaresSupersedes('Supersedes #60561', 6056)).toBe(false);
    expect(declaresSupersedes('no port of #6056 diff', 6056)).toBe(false);
    expect(declaresSupersedes('This is not superseding anything. See #6056', 6056)).toBe(false);
  });
  it('maps loader merge refs to their branch', () => {
    expect(mergeRefBase('lane/x-m12')).toBe('lane/x');
    expect(mergeRefBase('lane/x')).toBe(null);
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
