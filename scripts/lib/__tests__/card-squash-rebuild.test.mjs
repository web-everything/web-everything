import { squashPatchHash } from '../card-squash-marker.mjs';
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { rebaseDropManifest } from '../rebase-drop-manifest.mjs';
import { cardTreeOnly, loadCardRebaseSettings, patchWithoutPositions } from '../card-squash-rebuild.mjs';
import { isAiGeneratedPr, isDrainBookkeepingCommit } from '../ai-pr-authorship.mjs';
const base = 'b'.repeat(40), head = 'a'.repeat(40), tree = 'c'.repeat(40), next = 'd'.repeat(40);
const card = 'backlog/123-card.md';
const patch = `diff --git a/${card} b/${card}\nindex 123..456 100644\n--- a/${card}\n+++ b/${card}\n@@ -1 +1 @@\n-old\n+new\n`;
const settings = enabled => ({ value: { squashToSingleCommit: enabled }, sources: { squashToSingleCommit: 'env' } });
function setup({ files = card, mismatch = false, pathMismatch = false, count = 2, merges = 0, current = false, resultMode = '100644', baseMode = '100644', treeFailure = false } = {}) {
  const run = vi.fn((_cmd, args) => {
    let stdout = '';
    if (args[0] === 'merge-tree' || args[0] === 'write-tree') stdout = tree;
    if (args[0] === 'rev-parse') stdout = args.at(-1).endsWith('^{tree}') ? (current ? tree : 'e'.repeat(40))
      : (args.at(-1).startsWith('origin/main') || args.at(-1).startsWith(base)) ? base : head;
    if (args[0] === 'rev-list') stdout = String(args.includes('--merges') ? merges : count);
    if (args[0] === 'ls-tree' && args.includes('-r')) {
      if (treeFailure) return { status: 1, stdout: '' };
      const mode = args[3] === tree ? resultMode : baseMode;
      stdout = mode ? `${mode} ${mode === '160000' ? 'commit' : 'blob'} ${head}\t${card}\0` : '';
    }
    if (args[0] === 'commit-tree') stdout = next;
    if (args[0] === 'log') stdout = 'Co-Authored-By: Claude <claude@anthropic.com>\n\nCo-Authored-By: Claude <claude@anthropic.com>\nCo-Authored-By: Codex <codex@openai.com>\n';
    if (args[0] === 'diff') stdout = args.includes('--name-only') ? (pathMismatch && args.at(-1) === next ? 'backlog/456-other.md' : files)
      : (mismatch && args.at(-1) === next ? patch.replace('+new', '+changed') : patch);
    return { status: args[0] === 'merge-base' && !current ? 1 : 0, stdout, stderr: '' };
  });
  const invoke = extra => rebaseDropManifest({ laneRef: 'lane/cards', run, fetch: false, cardRebaseSettings: settings(true), ...extra });
  return { run, invoke };
}
describe('card squash rebuild', () => {
  it('pins inputs, creates one parent, preserves distinct authors and pushes with exact expect-head lease', () => {
    const { run, invoke } = setup(); const r = invoke();
    expect(r).toMatchObject({ action: 'rebased', base, newCommit: next, proof: { oldHead: head, newHead: next, patchHash: squashPatchHash(patch), oldFiles: [card], newFiles: [card], patchEqual: true }, cardRebaseSetting: { value: true, source: 'env' } });
    const ct = run.mock.calls.find(([, a]) => a[0] === 'commit-tree')[1];
    expect(ct.slice(0, 4)).toEqual(['commit-tree', tree, '-p', base]);
    expect(ct.filter(a => a === '-p')).toHaveLength(1);
    expect(ct[5]).toBe('drain: rebase lane/cards onto origin/main, drop transient .lane-manifest.json, squash to one commit');
    expect(ct.at(-1).match(/Co-Authored-By: Claude/g)).toHaveLength(1);
    expect(ct.at(-1)).toContain('Co-Authored-By: Codex');
    expect(run.mock.calls.find(([, a]) => a[0] === 'push')[1]).toEqual(['push', `--force-with-lease=refs/heads/lane/cards:${head}`, 'origin', `${next}:refs/heads/lane/cards`]);
  });
  it.each([{ mismatch: true }, { pathMismatch: true }])('a failed net proof refuses without pushing: %j', options => {
    const { run, invoke } = setup(options); expect(invoke()).toMatchObject({ action: 'error', guard: 'squash-net-diff-mismatch' });
    expect(run.mock.calls.some(([, a]) => a[0] === 'push')).toBe(false);
  });
  it('dry-run proves the patch but never pushes', () => {
    const { run, invoke } = setup();
    expect(invoke({ dryRun: true })).toMatchObject({ action: 'dry-run', newCommit: next, oldHead: head, base, laneRef: 'lane/cards', proof: { oldHead: head, newHead: next, patchHash: squashPatchHash(patch), patchEqual: true }, wouldPush: 'lease' });
    expect(run.mock.calls.some(([, a]) => a[0] === 'push')).toBe(false);
  });
  it.each([{ files: 'src/code.js' }, { disabled: true }])('non-card/setting off keeps two parents and ff push: %j', options => {
    const { run, invoke } = setup(options); expect(invoke(options.disabled ? { cardRebaseSettings: settings(false) } : {} ).action).toBe('rebased');
    const ct = run.mock.calls.find(([, a]) => a[0] === 'commit-tree')[1]; expect(ct.filter(a => a === '-p')).toHaveLength(2);
    expect(run.mock.calls.find(([, a]) => a[0] === 'push')[1]).toEqual(['push', 'origin', `${next}:refs/heads/lane/cards`]);
  });
  it.each([{ count: 2 }, { count: 1, merges: 1 }])('dirty stack cannot short-circuit current: %j', options => {
    expect(setup({ ...options, current: true }).invoke({ dryRun: true }).action).toBe('dry-run');
  });
  it('a single card commit already on base remains current', () => {
    const { run, invoke } = setup({ current: true, count: 1 });
    expect(invoke()).toMatchObject({ action: 'current', newCommit: head, cardRebaseSetting: { value: true, source: 'env' } });
    expect(run.mock.calls.some(([, a]) => ['push', 'commit-tree'].includes(a[0]))).toBe(false);
  });
  it('ignores only index and hunk-position headers', () => {
    expect(patchWithoutPositions(patch)).toBe(patchWithoutPositions(patch.replace('123..456', '789..abc').replace('@@ -1 +1 @@', '@@ -3 +3 @@')));
    expect(patchWithoutPositions(patch)).not.toBe(patchWithoutPositions(patch.replace('+new', '+changed')));
  });
  it('a squash commit is never bookkeeping: authorship rests on the preserved Co-Authored-By trailers', () => {
    const messageHeadline = 'drain: rebase lane/cards onto origin/main, drop transient .lane-manifest.json, squash to one commit';
    expect(isDrainBookkeepingCommit({ messageHeadline })).toBe(false);
    expect(isDrainBookkeepingCommit({ messageHeadline: `${messageHeadline}, extra` })).toBe(false);
    expect(isAiGeneratedPr({ commits: [{ messageHeadline, messageBody: 'Preserved net patch.\n\nCo-Authored-By: Claude <claude@anthropic.com>' }] })).toBe(true);
    expect(isAiGeneratedPr({ commits: [{ messageHeadline, messageBody: 'Preserved net patch.' }] })).toBe(false);
  });
});
describe('card rebase settings', () => {
  it('defaults true with standard source when no overrides exist', () => {
    expect(loadCardRebaseSettings({ env: {}, platform: {}, repo: {} })).toMatchObject({ value: { squashToSingleCommit: true }, sources: { squashToSingleCommit: 'standard' } });
  });
  it.each([['false', false], ['0', false], ['true', true], ['1', true]])('env %s wins with source', (raw, value) => {
    expect(loadCardRebaseSettings({ env: { WE_CARD_REBASE_SQUASH_TO_SINGLE_COMMIT: raw }, platform: {}, repo: {} })).toMatchObject({ value: { squashToSingleCommit: value }, sources: { squashToSingleCommit: 'env' } });
  });
  it('invalid env preserves the valid tool layer', () => {
    expect(loadCardRebaseSettings({ env: { WE_CARD_REBASE_SQUASH_TO_SINGLE_COMMIT: 'wat' }, platform: { squashToSingleCommit: true }, repo: { squashToSingleCommit: false } })).toMatchObject({ value: { squashToSingleCommit: false }, sources: { squashToSingleCommit: 'tool' } });
  });
});

import { gitRun } from '../git-run.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
it('real object-only git dry-run preserves a card patch across concurrent main changes and leaves one commit', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'card-squash-objects-'));
  const identity = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
  const run = (cmd, args, opts = {}) => {
    if (args[0] === 'push' || args[0] === 'fetch') throw new Error('object-only test forbids remote writes');
    return gitRun(cmd, args, { ...opts, env: { ...identity, ...opts.env } });
  };
  const g = (args, input) => {
    const r = run('git', args, { input }); expect(r.status, r.stderr).toBe(0); return String(r.stdout).trim();
  };
  const makeTree = text => {
    const blob = g(['hash-object', '-w', '--stdin'], text);
    const backlog = g(['mktree'], `100644 blob ${blob}\t123-card.md\n`);
    return g(['mktree'], `040000 tree ${backlog}\tbacklog\n`);
  };
  try {
    const rootTree = makeTree('one\ntwo\nthree\nfour\nfive\n');
    const root = g(['commit-tree', rootTree, '-m', 'base']);
    const laneTree = makeTree('one\ntwo\nthree\nfour\nPR change\n');
    const first = g(['commit-tree', laneTree, '-p', root, '-m', 'card', '-m', 'Co-Authored-By: Claude <claude@anthropic.com>']);
    const stack = g(['commit-tree', laneTree, '-p', root, '-p', first, '-m', 'drain rebase']);
    const concurrent = g(['commit-tree', makeTree('main intro\none\ntwo\nthree\nfour\nfive\n'), '-p', root, '-m', 'main moves']);
    const r = rebaseDropManifest({ laneRef: 'lane/cards', base: concurrent, readRef: stack, fetch: false,
      run, tmpIndex: join(scratch, 'index'), dryRun: true, cardRebaseSettings: settings(true) });
    expect(r).toMatchObject({ action: 'dry-run', proof: { oldFiles: [card], newFiles: [card], patchEqual: true }, wouldPush: 'lease' });
    expect(g(['rev-list', '--count', `${concurrent}..${r.newCommit}`])).toBe('1');
    expect(g(['rev-list', '--parents', '-n', '1', r.newCommit])).toBe(`${r.newCommit} ${concurrent}`);
    expect(g(['log', '-1', '--format=%B', r.newCommit])).toContain('Co-Authored-By: Claude <claude@anthropic.com>');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}, 30_000);

import { cardRebaseProbe } from '../../operations/card-rebase-probe.mjs';
it('probe prints resolved evidence and a dry-run while its runner never sees a push', () => {
  const { run: plumbing } = setup();
  const calls = [];
  const run = (cmd, args, opts) => {
    calls.push([cmd, args]);
    if (cmd === 'gh') return { status: 0, stdout: JSON.stringify({ headRefName: 'lane/cards', headRefOid: head, baseRefName: 'main', files: [{ path: 'scripts/stale.mjs' }] }) };
    if (args[0] === 'remote') return { status: 0, stdout: 'https://github.com/web-everything/web-everything.git' };
    return plumbing(cmd, args, opts);
  };
  const print = vi.fn();
  expect(cardRebaseProbe({ pr: 123, repo: 'web-everything/web-everything', run, print }).action).toBe('dry-run');
  expect(JSON.parse(print.mock.calls[0][0])).toMatchObject({ source: 'git', files: [card], disagreed: true });
  expect(JSON.parse(print.mock.calls[1][0])).toMatchObject({ newCommit: next, patchEqual: true });
  expect(calls.some(([, args]) => args.includes('push'))).toBe(false);
});

it.each([
  ...['120000', '160000', '100755'].flatMap(mode => [{ resultMode: mode }, { baseMode: mode }]),
  { resultMode: '' }, { treeFailure: true },
])('unsafe card tree keeps the legacy two-parent rebuild: %j', options => {
  const { run, invoke } = setup(options);
  expect(invoke()).toMatchObject({ action: 'rebased' });
  const ct = run.mock.calls.find(([, args]) => args[0] === 'commit-tree')[1];
  expect(ct.filter(arg => arg === '-p')).toHaveLength(2);
  expect(run.mock.calls.find(([, args]) => args[0] === 'push')[1]).toEqual(['push', 'origin', `${next}:refs/heads/lane/cards`]);
});
it('a new regular card needs no base entry', () => {
  const { run } = setup({ baseMode: '' });
  expect(cardTreeOnly({ run, base, tree })).toBe(true);
});
it('a throwing tree read fails closed', () => {
  expect(cardTreeOnly({ run: () => { throw new Error('unreadable'); }, base, tree })).toBe(false);
});
it('real Git trees reject card-shaped links and gitlinks on either side', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'card-tree-modes-'));
  const run = (cmd, args, opts = {}) => gitRun(cmd, args, { ...opts, cwd: scratch,
    env: { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' } });
  const g = (args, input) => {
    const result = run('git', args, { input });
    expect(result.status, result.stderr).toBe(0);
    return String(result.stdout).trim();
  };
  try {
    g(['init', '--quiet']);
    const empty = g(['mktree'], '');
    const commit = g(['commit-tree', empty, '-m', 'gitlink target']);
    const makeTree = (mode, content) => {
      const oid = mode === '160000' ? commit : g(['hash-object', '-w', '--stdin'], content);
      const subtree = g(['mktree'], `${mode} ${mode === '160000' ? 'commit' : 'blob'} ${oid}\t123-card.md\n`);
      return g(['mktree'], `040000 tree ${subtree}\tbacklog\n`);
    };
    const regular = makeTree('100644', 'old');
    expect(cardTreeOnly({ run, base: regular, tree: makeTree('100644', 'new') })).toBe(true);
    expect(cardTreeOnly({ run, base: empty, tree: regular })).toBe(true);
    expect(cardTreeOnly({ run, base: regular, tree: empty })).toBe(false);
    for (const mode of ['120000', '160000', '100755']) {
      const unsafe = makeTree(mode, 'target');
      expect(cardTreeOnly({ run, base: regular, tree: unsafe }), mode).toBe(false);
      expect(cardTreeOnly({ run, base: unsafe, tree: regular }), mode).toBe(false);
    }
    expect(cardTreeOnly({ run, base: regular, tree: '0'.repeat(40) })).toBe(false);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
