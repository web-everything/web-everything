import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { proveMixedMechanicalChain } from '../carry-chain.mjs';
import { MAX_NUMBERING_COMMITS, planNumberingRestamp, restampAfterNumbering, _resetNumberingRestampMemo } from '../numbering-carry.mjs';

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); _resetNumberingRestampMemo(); });
function repo(submodule = null) {
  const cwd = mkdtempSync(join(tmpdir(), 'carry-chain-')); dirs.push(cwd);
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const put = (path, text) => { mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), text); };
  const commit = subject => { git('add', '-A'); git('commit', '--allow-empty', '-qm', subject); return git('rev-parse', 'HEAD'); };
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test');
  put('base.txt', 'base\n'); commit('base');
  if (submodule) {
    git('-c', 'protocol.file.allow=always', 'submodule', 'add', submodule.cwd, 'dependency');
    if (submodule.ignore) git('config', '-f', '.gitmodules', 'submodule.dependency.ignore', 'all');
    commit('base submodule');
  }
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('checkout', '-qb', 'feature');
  put('feature.txt', 'approved\n'); put('backlog/xabc123-card.md', '---\ntitle: Card\n---\nCard\n');
  const from = commit('approved');
  const number = () => { git('mv', 'backlog/xabc123-card.md', 'backlog/7474-card.md');
    put('backlog/7474-card.md', '---\nbornAs: xabc123\ntitle: Card\n---\nCard\n');
    return commit('drain: JIT-number xabc123→#7474 at land (#2288)'); };
  const merge = (extra = false) => {
    git('checkout', 'main'); put('upstream.txt', 'upstream\n'); commit('upstream');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD'); git('checkout', 'feature');
    git('merge', '--no-ff', '--no-commit', 'main');
    if (extra) put('extra.txt', 'hidden merge change\n');
    return commit('merge main');
  };
  const proof = toSha => proveMixedMechanicalChain({ exec: execFileSync, cwd, fromSha: from, toSha });
  return { cwd, git, put, commit, from, number, merge, proof };
}
const rearm = {
  author: { login: 'web-everything[bot]' },
  body: '🔧 conveyor fix — re-armed for re-review\n\nThe previously accepted PR was re-pushed and its acceptance is being re-armed for review by conveyor fix agent; the PR is re-armed `review:pending` (an independent re-review is owed).\n\nThe fix agent did NOT clear the review — a human `/review` (or the drain AI-review convergence pass) re-verdicts.',
};
function stateFor(r, to) {
  return { headRefOid: to, labels: ['review:pending'], comments: [
    { id: 'accept', author: { login: 'chalbert' }, body: `✅ review — accepted\n<!-- reviewed-sha: ${r.from} -->` }, rearm,
  ] };
}
it('proves numbering then clean merge with ordered, SHA-bound hops', () => {
  const r = repo(), numbered = r.number(), to = r.merge();
  expect(r.proof(to)).toMatchObject({ ok: true, kind: 'chain', hops: [
    { kind: 'numbering', from: r.from, to: numbered }, { kind: 'merge', from: numbered, to },
  ] });
});
it('caps every delegated Git read at 5 seconds and 8 MiB', () => {
  const r = repo(); r.number(); const to = r.merge(), calls = [];
  const exec = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return execFileSync(cmd, args, opts);
  };
  expect(proveMixedMechanicalChain({ exec, cwd: r.cwd, fromSha: r.from, toSha: to })).toMatchObject({ ok: true });
  // Exercise both numbering and merge delegates, including net-patch's larger requested bounds.
  expect(calls.some(({ args }) => args[0] === 'diff-tree')).toBe(true);
  expect(calls.find(({ args }) => args[0] === 'patch-id')?.opts).toMatchObject({
    timeout: 5000, maxBuffer: 8 * 1024 * 1024,
  });
  for (const { args } of calls.filter(({ args }) => ['diff', 'diff-tree'].includes(args[0])))
    expect(args[1]).toBe('--ignore-submodules=none');
  for (const { cmd, opts } of calls) {
    expect(cmd).toBe('git');
    expect(opts.env).toMatchObject({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'diff.ignoreSubmodules', GIT_CONFIG_VALUE_0: 'none' });
    expect(opts.cwd).toBe(r.cwd);
    expect(opts.timeout).toBeGreaterThan(0);
    expect(opts.timeout).toBeLessThanOrEqual(5000);
    expect(opts.maxBuffer).toBeGreaterThan(0);
    expect(opts.maxBuffer).toBeLessThanOrEqual(8 * 1024 * 1024);
  }
});
it.each(['string', 'buffer'])('refuses returned Git evidence over 8 MiB with an operator fallback (%s)', format => {
  const r = repo(), to = r.number(), calls = [];
  // Valid SHA plus trailing whitespace would pass endpoint parsing without the byte bound.
  // Multibyte whitespace also distinguishes the byte bound from a character-count bound.
  const oversized = r.from + '\u2003'.repeat(Math.ceil(8 * 1024 * 1024 / 3));
  const exec = (cmd, args, opts) => {
    calls.push(args);
    return format === 'buffer' ? Buffer.from(oversized) : oversized;
  };
  expect(proveMixedMechanicalChain({ exec, cwd: r.cwd, fromSha: r.from, toSha: to })).toMatchObject({
    ok: false, reason: expect.stringMatching(/evidence unreadable.*retain pending.*fresh re-review/),
  });
  expect(calls).toEqual([['rev-parse', '--verify', `${r.from}^{commit}`]]);
});
it.each(['merge', 'merge-numbering'])('proves %s', order => {
  const r = repo(); let to = r.merge(); if (order === 'merge-numbering') to = r.number();
  expect(r.proof(to)).toMatchObject({ ok: true, kind: 'chain', hops: order === 'merge' ? [{ kind: 'merge' }] : [{ kind: 'merge' }, { kind: 'numbering' }] });
});
it('refuses extra changes hidden in a merge commit', () => {
  const r = repo(); r.number(); expect(r.proof(r.merge(true)).ok).toBe(false);
});
it.each(['config', 'gitmodules'])('refuses a merge-owned submodule pointer change hidden by %s ignore', ignore => {
  const sub = repo(), r = repo({ cwd: sub.cwd, ignore: ignore === 'gitmodules' });
  const from = r.from;
  const next = sub.commit('new submodule revision');
  const clean = r.merge();
  expect(proveMixedMechanicalChain({ exec: execFileSync, cwd: r.cwd, fromSha: from, toSha: clean }).ok).toBe(true);
  r.git('update-index', '--cacheinfo', `160000,${next},dependency`);
  r.git('commit', '--amend', '--no-edit', '-q');
  const to = r.git('rev-parse', 'HEAD');
  if (ignore === 'config') r.git('config', 'diff.ignoreSubmodules', 'all');
  expect(r.git('diff', '--name-only', clean, to)).toBe('');
  expect(proveMixedMechanicalChain({ exec: execFileSync, cwd: r.cwd, fromSha: from, toSha: to }))
    .toMatchObject({ ok: false, reason: expect.stringContaining('fresh re-review') });
});
it('refuses a merge resolving a conflict', () => {
  const r = repo(); r.put('base.txt', 'feature\n'); const from = r.commit('approved conflict');
  r.git('checkout', 'main'); r.put('base.txt', 'main\n'); r.commit('upstream conflict');
  r.git('update-ref', 'refs/remotes/origin/main', 'HEAD'); r.git('checkout', 'feature');
  expect(() => r.git('merge', '--no-ff', '--no-commit', 'main')).toThrow();
  r.put('base.txt', 'resolution\n'); const to = r.commit('resolve conflict');
  expect(proveMixedMechanicalChain({ exec: execFileSync, cwd: r.cwd, fromSha: from, toSha: to }).ok).toBe(false);
});
it.each(['before', 'after', 'reverted'])('refuses non-numbering edits %s the merge even if reverted', where => {
  const r = repo(); r.number();
  if (where === 'before') { r.put('bad.txt', 'bad'); r.commit('unreviewed'); }
  let to = r.merge();
  if (where !== 'before') { r.put('feature.txt', 'unreviewed\n'); to = r.commit('unreviewed'); }
  if (where === 'reverted') { r.put('feature.txt', 'approved\n'); to = r.commit('revert'); }
  expect(r.proof(to).ok).toBe(false);
});
it('refuses unreadable commits without fetching', () => {
  const r = repo(), calls = [];
  const exec = (cmd, args, opts) => { calls.push(args); return execFileSync(cmd, args, opts); };
  expect(proveMixedMechanicalChain({ exec, cwd: r.cwd, fromSha: r.from, toSha: 'f'.repeat(40) }).ok).toBe(false);
  expect(calls.some(args => args[0] === 'fetch')).toBe(false);
});
it('refuses oversized chains with an operator fallback', () => {
  const r = repo(); let to;
  for (let i = 0; i <= MAX_NUMBERING_COMMITS; i++) to = r.commit('empty');
  expect(r.proof(to)).toMatchObject({ ok: false, reason: expect.stringMatching(/limit.*re-review/) });
});
it('refuses when the approved head is not on the first-parent path', () => {
  const r = repo(); r.git('checkout', 'main'); r.put('other.txt', 'other'); r.commit('other');
  r.git('merge', '--no-ff', '-m', 'merge feature', 'feature');
  expect(r.proof(r.git('rev-parse', 'HEAD')).ok).toBe(false);
});
it('allows only the complete trusted mechanical re-arm while preserving human and formal holds', () => {
  const r = repo(), to = r.number(), state = stateFor(r, to);
  const plan = comments => planNumberingRestamp({ ...state, headSha: to, comments, reviews: [] });
  expect(plan(state.comments).candidate).toBe(true);
  for (const c of [{ ...rearm, author: { login: 'reviewer' } }, { ...rearm, author: { login: 'chalbert' }, viewerDidAuthor: true },
    { ...rearm, author: undefined }, { ...rearm, body: rearm.body + '\nChanges requested.' },
    { author: { login: 'reviewer' }, body: 'Please fix this.' }]) {
    expect(plan([state.comments[0], c]).candidate).toBe(false);
  }
  expect(planNumberingRestamp({ ...state, headSha: to, labels: ['review:pending', 'review:changes'], reviews: [] }).candidate).toBe(false);
  expect(planNumberingRestamp({ ...state, headSha: to, reviews: [{ state: 'CHANGES_REQUESTED', submittedAt: '2026-11-10T00:00:00Z' }] }).candidate).toBe(false);
});
it('refuses merge-owned changes even on the normally transient root manifest', () => {
  const r = repo(); r.number(); r.merge();
  r.put('.lane-manifest.json', '{"unreviewed":true}');
  r.git('add', '-A'); r.git('commit', '--amend', '--no-edit', '-q');
  expect(r.proof(r.git('rev-parse', 'HEAD')).ok).toBe(false);
});

it('refuses unreadable numbering-hop blobs without fetching or posting', () => {
  const r = repo(); r.number(); const to = r.merge(), calls = [];
  const exec = (cmd, args, opts) => {
    calls.push(args);
    if (args[0] === 'cat-file' && args[1] === 'blob') throw Error('blob unavailable');
    return execFileSync(cmd, args, opts);
  };
  expect(proveMixedMechanicalChain({ exec, cwd: r.cwd, fromSha: r.from, toSha: to })).toMatchObject({ ok: false });
  expect(calls.some(args => args[0] === 'fetch')).toBe(false);
});
it('refuses an extra-parent merge hop', () => {
  const r = repo(); r.number(); const merge = r.merge();
  const extra = r.git('rev-parse', 'main^');
  const to = r.git('commit-tree', `${merge}^{tree}`, '-p', r.git('rev-parse', `${merge}^1`), '-p', r.git('rev-parse', 'main'), '-p', extra, '-m', 'octopus');
  expect(r.proof(to)).toMatchObject({ ok: false });
});
it('refuses retryably when mainRef moves while the pinned chain delegates prove', () => {
  const r = repo(); r.number(); const to = r.merge(), calls = [];
  const exec = (cmd, args, opts) => {
    calls.push(args);
    const output = execFileSync(cmd, args, opts);
    if (args[0] === 'rev-parse' && args[2] === 'origin/main^{commit}')
      r.git('update-ref', 'refs/remotes/origin/main', r.from);
    return output;
  };
  expect(proveMixedMechanicalChain({ exec, cwd: r.cwd, fromSha: r.from, toSha: to })).toMatchObject({
    ok: false, retryable: true, reason: expect.stringContaining('main moved'),
  });
  expect(calls.filter(args => args.some(arg => arg.includes('origin/main')))).toHaveLength(2);
});

function restamp(r, { clean = true, human = false, setting } = {}) {
  const numbered = r.number(), to = r.merge(!clean), state = stateFor(r, to), writes = [];
  if (human) state.comments[0].body += '\n<!-- cleared-human: chalbert -->';
  const result = restampAfterNumbering({ repo: 'owner/repo', pr: 7474, state, reviews: [], exec: execFileSync, cwd: r.cwd,
    enabled: setting !== 'enabled', acceptCarry: setting === 'accept' ? 'off' : 'on',
    numberingSetting: { value: setting !== 'numbering', source: 'test' },
    netPatchSetting: { value: setting !== 'net-patch', source: 'test' },
    guardReferrals: () => {}, readLiveState: () => ({ state, reviews: [] }),
    provider: {
      postComment: (_repo, _pr, body) => { writes.push(body); state.comments.push({ id: 'restamp', author: rearm.author, body }); },
      setLabels: (_repo, _pr, spec) => writes.push(spec),
    } });
  return { result, writes, state, numbered, to };
}
it('restamps plain acceptance over a mixed chain with both endpoints and the ordered hop list', () => {
  const r = repo(), { result, writes, numbered, to } = restamp(r);
  expect(result).toMatchObject({ action: 'restamped', human: false });
  expect(writes).toHaveLength(2);
  expect(writes[0]).toContain(`mechanical chain: numbering ${r.from} -> ${numbered}`);
  expect(writes[0]).toContain(`; merge ${numbered} -> ${to}`);
  expect(writes[0]).toContain(`<!-- reviewed-sha: ${to} -->`);
  expect(writes[0]).not.toContain('cleared-human');
  expect(writes[0]).not.toContain('human-clearance-carried');
  expect(writes[0]).not.toContain("only by the drain's own card-numbering");
  expect(writes[1]).toEqual({ add: 'review:accepted', remove: ['review:pending'] });
});
it('refuses an unclean acceptance chain without writes', () => {
  const { result, writes } = restamp(repo(), { clean: false });
  expect(result.action).toBe('refused');
  expect(writes).toEqual([]);
});
it('refuses human clearance on a mixed chain without writes', () => {
  const { result, writes } = restamp(repo(), { human: true });
  expect(result).toMatchObject({ action: 'refused', reason: expect.stringContaining('human clearance cannot be carried across a mechanical chain') });
  expect(writes).toEqual([]);
});
it.each(['numbering', 'net-patch', 'enabled', 'accept'])('refuses acceptance chain restamping when %s carry is off', setting => {
  const { result, writes } = restamp(repo(), { setting });
  if (['numbering', 'net-patch'].includes(setting)) expect(result.action).toBe('refused');
  else expect(result).toBeNull();
  expect(writes).toEqual([]);
});
it.each(['config', 'gitmodules'])('refuses the net-patch fallback restamp over a merge-owned submodule pointer change hidden by %s ignore', ignore => {
  const sub = repo(), r = repo({ cwd: sub.cwd, ignore: ignore === 'gitmodules' });
  // No numbering commit: only the net-patch fallback could accept this merge-only head move.
  const next = sub.commit('new submodule revision');
  r.merge();
  r.git('update-index', '--cacheinfo', `160000,${next},dependency`);
  r.git('commit', '--amend', '--no-edit', '-q');
  const to = r.git('rev-parse', 'HEAD');
  if (ignore === 'config') r.git('config', 'diff.ignoreSubmodules', 'all');
  const state = stateFor(r, to), writes = [], calls = [];
  const exec = (cmd, args, opts) => { calls.push(args); return execFileSync(cmd, args, opts); };
  const result = restampAfterNumbering({ repo: 'owner/repo', pr: 7474, state, reviews: [], exec, cwd: r.cwd,
    enabled: true, acceptCarry: 'on', numberingSetting: { value: true, source: 'test' }, netPatchSetting: { value: true, source: 'test' },
    guardReferrals: () => {}, readLiveState: () => ({ state, reviews: [] }),
    provider: { postComment: (_repo, _pr, body) => writes.push(body), setLabels: (_repo, _pr, spec) => writes.push(spec) } });
  expect(result).toMatchObject({ action: 'refused' });
  expect(writes).toEqual([]);
  // Every diff the fallback reads is forced to show submodule pointer changes.
  const diffs = calls.filter(args => ['diff', 'diff-tree'].includes(args[0]));
  expect(diffs.length).toBeGreaterThan(0);
  for (const args of diffs) expect(args).toContain('--ignore-submodules=none');
});
