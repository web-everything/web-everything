import { squashPatchHash, parseCardSquashMarkers, postCardSquashMarker } from '../card-squash-marker.mjs';
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { rebaseDropManifest } from '../rebase-drop-manifest.mjs';
import { cardSquashRebuild, cardTreeOnly, loadCardRebaseSettings, patchWithoutPositions } from '../card-squash-rebuild.mjs';
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
  it.each(['', 'not-an-oid', `${base}\n${head}`])('fallback refuses an invalid merge base: %j', stdout => {
    const { run: plumbing } = setup({ mismatch: true });
    const run = (cmd, args, opts) => args[0] === 'merge-base' ? { status: 0, stdout } : plumbing(cmd, args, opts);
    expect(cardSquashRebuild({ run, base, mergeRef: head, tree, message: 'test' }))
      .toMatchObject({ action: 'error', guard: 'squash-net-diff-mismatch' });
  });
  it('fallback refuses a tree entry with an empty oid even with a valid merge base', () => {
    const { run: plumbing } = setup({ mismatch: true });
    const run = (cmd, args, opts) => args[0] === 'merge-base' ? { status: 0, stdout: base }
      : args[0] === 'ls-tree' ? { status: 0, stdout: `100644 blob \t${card}\0` } : plumbing(cmd, args, opts);
    expect(cardSquashRebuild({ run, base, mergeRef: head, tree, message: 'test' }))
      .toMatchObject({ action: 'error', guard: 'squash-net-diff-mismatch' });
  });
  it.each([{ mismatch: true }, { pathMismatch: true }])('fallback refuses all-absent entries for a mismatching candidate: %j', options => {
    const { run: plumbing } = setup(options);
    const run = vi.fn((cmd, args, opts) => args[0] === 'merge-base' ? { status: 0, stdout: base }
      : args[0] === 'rev-parse' && args.at(-1).includes(':') ? { status: 1, stdout: '', stderr: '' }
      : args[0] === 'ls-tree' ? { status: 0, stdout: '' } : plumbing(cmd, args, opts));
    expect(cardSquashRebuild({ run, base, mergeRef: head, tree, message: 'test' }))
      .toMatchObject({ action: 'error', guard: 'squash-net-diff-mismatch' });
    expect(run.mock.calls.filter(([, args]) => args[0] === 'ls-tree')).toHaveLength(4);
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
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
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

// Real Git object graphs exercise exclusion pathspecs and the blob proof independently of the runner stub.
describe('resolver-proven squash blobs', () => {
  function unionFixture(check, { subdir = false } = {}) {
    const top = mkdtempSync(join(tmpdir(), 'card-squash-union-'));
    const cwd = subdir ? join(top, 'elsewhere') : top;
    if (subdir) mkdirSync(cwd);
    const run = (cmd, args, opts = {}) => gitRun(cmd, args, { ...opts, cwd,
      env: { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' } });
    const g = (args, input) => {
      const r = run('git', args, { input }); expect(r.status, r.stderr).toBe(0); return String(r.stdout).trim();
    };
    try {
      g(subdir ? ['init', '--quiet', top] : ['init', '--bare', '--quiet']);
      const resolvedPath = 'backlog/123-[card].md';
      const other = 'backlog/456-other.md';
      const blob = text => g(['hash-object', '-w', '--stdin'], text);
      const makeTree = (text, otherText, code = false) => {
        const backlog = g(['mktree'], `100644 blob ${blob(text)}\t123-[card].md\n100644 blob ${blob(otherText)}\t456-other.md\n`);
        return g(['mktree'], `040000 tree ${backlog}\tbacklog\n${code ? `100644 blob ${blob('extra')}\tcode.js\n` : ''}`);
      };
      const cardText = entries => `# Card\n\n## Also raised by\n\n${entries.map(n => `- Also raised by o/r#${n} (backlog/xabc123-child.md)`).join('\n')}\n`;
      const commit = (tree, parent) => g(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'fixture']);
      const root = commit(makeTree(cardText([0]), 'old\n'));
      const base = commit(makeTree(cardText([0, 1]), 'old\n'), root);
      const mergeRef = commit(makeTree(cardText([0, 2]), 'PR change\n'), root);
      const text = cardText([0, 1, 2]).replaceAll('xabc123', '6000');
      const resolved = [{ path: resolvedPath, oid: blob(text) }];
      const tree = makeTree(text, 'PR change\n');
      const invoke = extra => cardSquashRebuild({ run, cwd, base, mergeRef, tree, message: 'union', resolved, ...extra });
      check({ invoke, g, base, resolved, tree, makeTree, text, other });
    } finally { rmSync(top, { recursive: true, force: true }); }
  }
  it('accepts the exact union blob and hashes the full new patch', () => unionFixture(({ invoke, g, base, resolved }) => {
    const result = invoke();
    expect(result).toMatchObject({ newCommit: expect.any(String), proof: { patchEqual: true, resolvedPaths: [resolved[0].path] } });
    const fullPatch = g(['diff', '--binary', '--no-renames', '-U0', base, result.newCommit]) + '\n';
    expect(result.proof.patchHash).toBe(squashPatchHash(fullPatch));
  }));
  it.each([{ resolved: undefined }, { resolved: [] }])('still refuses the union without resolver evidence: %j', ({ resolved }) => unionFixture(({ invoke }) => {
    expect(invoke({ resolved })).toMatchObject({ action: 'error', guard: 'squash-net-diff-mismatch' });
  }));
  it('refuses a resolved blob that differs from the verified oid', () => unionFixture(({ invoke, makeTree, text }) => {
    expect(invoke({ tree: makeTree(text + 'tampered\n', 'PR change\n') })).toMatchObject({ action: 'error', guard: 'squash-net-diff-mismatch' });
  }));
  it('refuses an extra change on an unresolved path within the same path set', () => unionFixture(({ invoke, makeTree, text }) => {
    expect(invoke({ tree: makeTree(text, 'tampered\n') })).toMatchObject({ action: 'error', guard: 'squash-net-diff-mismatch' });
  }));
  it('proves unresolved paths repo-wide even when run from a subdirectory', () => unionFixture(({ invoke, makeTree, text }) => {
    expect(invoke({ tree: makeTree(text, 'tampered\n') })).toMatchObject({ action: 'error', guard: 'squash-net-diff-mismatch' });
  }, { subdir: true }));
  it('still accepts the exact union blob from a subdirectory', () => unionFixture(({ invoke }) => {
    expect(invoke()).toMatchObject({ proof: { patchEqual: true } });
  }, { subdir: true }));
  it('refuses a non-card path-set addition even with a verified union blob', () => unionFixture(({ invoke, makeTree, text }) => {
    expect(invoke({ tree: makeTree(text, 'PR change\n', true) })).toMatchObject({ action: 'error', guard: 'squash-net-diff-mismatch' });
  }));
});

// Diverging real Git histories prove absorbed hunks without trusting the proposed tree.
describe('per-path squash merge proof', () => {
  const original = 'first\none\ntwo\nthree\nfour\nfive\nsix\nlast\n';
  const first = original.replace('first', 'PR first');
  const both = first.replace('last', 'PR last');
  function absorbedFixture(check, { main = first, pr = both, result = both, extra = false, headExtra = false, headMode = '100644', baseMode = '100644', treeMode = '100644', ancestorMode = '100644', resolved = false, ancestor = original, companion = false, fault } = {}) {
    const cwd = mkdtempSync(join(tmpdir(), 'card-squash-absorbed-'));
    const run = vi.fn((cmd, args, opts = {}) => {
      if (['push', 'fetch'].includes(args[0])) throw new Error('fixture forbids remote writes');
      return gitRun(cmd, args, { ...opts, cwd,
        env: { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' } });
    });
    const g = (args, input) => {
      const r = run('git', args, { input }); expect(r.status, r.stderr).toBe(0); return String(r.stdout).trim();
    };
    try {
      g(['init', '--bare', '--quiet']);
      const makeTree = (text, extra = false, mode = '100644') => {
        if (text === null) return g(['mktree'], '');
        const blob = g(['hash-object', '-w', '--stdin'], text);
        const backlog = g(['mktree'], `${mode} blob ${blob}\t123-card.md\n${extra ? `100644 blob ${blob}\t456-extra.md\n` : ''}${companion ? `100644 blob ${blob}\t789-other.md\n` : ''}`);
        return g(['mktree'], `040000 tree ${backlog}\tbacklog\n`);
      };
      const commit = (tree, parent) => g(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'fixture']);
      const root = commit(makeTree(ancestor, false, ancestorMode));
      const base = commit(makeTree(main, false, baseMode), root);
      const mergeRef = commit(makeTree(pr, headExtra, headMode), root);
      const tree = makeTree(result, extra, treeMode);
      const proofRun = fault ? (cmd, args, opts) => {
        const result = run(cmd, args, opts);
        return fault(args, result) ?? result;
      } : run;
      const outcome = cardSquashRebuild({ run: proofRun, cwd, base, mergeRef, tree, message: 'absorbed',
        resolved: resolved ? [{ path: card, oid: g(['rev-parse', `${tree}:${card}`]) }] : [] });
      check({ outcome, run, g, base, mergeRef });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  }

  it('accepts a genuine addition using unmodified real Git absence probes', () => absorbedFixture(({ outcome, run }) => {
    expect(outcome).toMatchObject({ proof: { proofKind: 'per-path-merge', patchEqual: false } });
    const probes = run.mock.calls.flatMap(([, args], index) => args[0] === 'rev-parse'
      && args.at(-1).endsWith(':backlog/456-extra.md') ? [run.mock.results[index].value] : []);
    expect(probes).toHaveLength(2);
    for (const probe of probes) expect(probe).toMatchObject({ status: 1, stdout: '', stderr: '' });
  }, { extra: true, headExtra: true }));
  it.each([
    { status: 128 },
    { status: 0, stdout: head + '\n' },
    { status: 0, stdout: 'invalid oid' },
    { status: 1, stdout: 'unexpected output' },
    { status: 1, stderr: 'unreadable' },
    { status: null },
    { status: 1, error: new Error('unreadable') },
    { status: 1, signal: 'SIGTERM' },
  ])('refuses an unproven rev-parse absence: %j', absence => {
    let absenceChecks = 0;
    absorbedFixture(({ outcome }) => {
      expect(absenceChecks).toBeGreaterThan(0);
      expect(outcome).toMatchObject({ action: 'error', guard: 'squash-net-diff-mismatch' });
    }, { extra: true, headExtra: true, fault: (args, result) => {
      if (args[0] !== 'rev-parse' || !args.at(-1).includes(':')) return;
      // The added companion path is genuinely absent in the ancestor/base trees.
      expect(args.at(-1)).toMatch(/:backlog\/456-extra\.md$/);
      expect(result).toMatchObject({ status: 1, stdout: '', stderr: '' });
      absenceChecks++;
      return { ...result, ...absence };
    } });
  });
  it('refuses non-octal ls-tree mode 100888 even when base, head and result entries match', () => absorbedFixture(({ outcome }) => {
    expect(outcome).toMatchObject({ action: 'error', guard: 'squash-net-diff-mismatch' });
  }, { pr: first, result: first, headExtra: true, extra: true, fault: (args, result) => args[0] === 'ls-tree'
    ? { ...result, stdout: String(result.stdout).replace(/^100644/, '100888') } : undefined }));
  it('refuses empty ls-tree output when rev-parse confirms the path exists', () => absorbedFixture(({ outcome, run }) => {
    expect(outcome).toMatchObject({ action: 'error', guard: 'squash-net-diff-mismatch' });
    const call = run.mock.calls.findIndex(([, args]) => args[0] === 'rev-parse' && args.at(-1).includes(':'));
    expect(call).toBeGreaterThanOrEqual(0);
    expect(run.mock.results[call].value.status).toBe(0);
    expect(run.mock.results[call].value.stdout.trim()).toMatch(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
  }, { fault: (args, result) => args[0] === 'ls-tree' ? { ...result, stdout: '' } : undefined }));
  it.each([
    ['unparseable', () => 'garbled\0'],
    ['wrong path', output => String(output).replace(card, 'backlog/wrong.md')],
    ['extra entry', output => String(output) + String(output)],
    ['trailing newline', output => String(output) + '\n'],
    ['missing stdout', () => undefined],
  ])('refuses ls-tree output with %s', (_name, falsify) => absorbedFixture(({ outcome }) => {
    expect(outcome).toMatchObject({ action: 'error', guard: 'squash-net-diff-mismatch' });
  }, { fault: (args, result) => args[0] === 'ls-tree' ? { ...result, stdout: falsify(result.stdout) } : undefined }));
  it('refuses non-zero ls-tree despite a valid entry', () => absorbedFixture(({ outcome }) => {
    expect(outcome).toMatchObject({ action: 'error', guard: 'squash-net-diff-mismatch' });
  }, { fault: (args, result) => args[0] === 'ls-tree' ? { ...result, status: 1 } : undefined }));
  it.each([1, 128, 129])('refuses merge-file status %s despite clean output', status => absorbedFixture(({ outcome }) => {
    expect(outcome).toMatchObject({ action: 'error', guard: 'squash-net-diff-mismatch' });
  }, { fault: (args, result) => args[0] === 'merge-file' ? { ...result, status } : undefined }));
  it('refuses empty merge output from three non-empty inputs even for an empty candidate', () => absorbedFixture(({ outcome }) => {
    expect(outcome).toMatchObject({ action: 'error', guard: 'squash-net-diff-mismatch' });
  }, { result: '', fault: (args, result) => args[0] === 'merge-file' ? { ...result, stdout: Buffer.alloc(0) } : undefined }));
  it('refuses merge-file output that is not a Buffer', () => absorbedFixture(({ outcome }) => {
    expect(outcome).toMatchObject({ action: 'error', guard: 'squash-net-diff-mismatch' });
  }, { fault: (args, result) => args[0] === 'merge-file' ? { ...result, stdout: String(result.stdout) } : undefined }));
  it('refuses different bytes on the second merge-file run with identical inputs', () => {
    let calls = 0;
    const inputs = [];
    absorbedFixture(({ outcome }) => {
      expect(outcome).toMatchObject({ action: 'error', guard: 'squash-net-diff-mismatch' });
      expect(calls).toBe(2);
      expect(inputs[1]).toEqual(inputs[0]);
    }, { fault: (args, result) => {
      if (args[0] !== 'merge-file') return;
      inputs.push(args);
      if (++calls === 2) return { ...result, stdout: Buffer.from('different\n') };
    } });
  });

  it('refuses the head blob when it drops the base middle edit', () => absorbedFixture(({ outcome, run }) => {
    expect(outcome).toMatchObject({ action: 'error', guard: 'squash-net-diff-mismatch' });
    expect(run.mock.calls.some(([, args]) => args[0] === 'merge-file')).toBe(true);
  }, { ancestor: 'first\nmiddle\nlast\n', main: 'first\nbase middle\nlast\n',
    pr: 'PR first\nmiddle\nlast\n', result: 'PR first\nmiddle\nlast\n' }));
  it('refuses PR deletion against a base modification', () => absorbedFixture(({ outcome }) => {
    expect(outcome).toMatchObject({ action: 'error', guard: 'squash-net-diff-mismatch' });
  }, { main: original.replace('three', 'main middle'), pr: null, result: null }));
  it('accepts regular resolved paths in both diffs with an independently proven companion', () => absorbedFixture(({ outcome }) => {
    expect(outcome.proof).toMatchObject({ proofKind: 'per-path-merge', resolvedPaths: [card] });
  }, { resolved: true, companion: true }));
  it.each(['100755', '120000'])('refuses resolved result mode %s in both diffs', treeMode => absorbedFixture(({ outcome }) => {
    expect(outcome).toMatchObject({ action: 'error', guard: 'squash-net-diff-mismatch' });
  }, { resolved: true, companion: true, treeMode }));
  it.each(['100755', '120000'])('refuses resolved base mode %s in both diffs', baseMode => absorbedFixture(({ outcome }) => {
    expect(outcome).toMatchObject({ action: 'error', guard: 'squash-net-diff-mismatch' });
  }, { resolved: true, companion: true, baseMode }));
  it.each(['100755', '120000'])('refuses resolved head mode %s with a regular result and fallback companion', headMode => absorbedFixture(({ outcome }) => {
    expect(outcome).toMatchObject({ action: 'error', guard: 'squash-net-diff-mismatch' });
  }, { resolved: true, companion: true, headMode }));
  it.each(['100755', '120000'])('refuses resolved merge-base mode %s with a fallback companion', ancestorMode => absorbedFixture(({ outcome }) => {
    expect(outcome).toMatchObject({ action: 'error', guard: 'squash-net-diff-mismatch' });
  }, { resolved: true, companion: true, ancestorMode }));
  it.each(['', 'garbled\n'])('refuses corrupted cat-file bytes even when they match the candidate: %j', bytes => absorbedFixture(({ outcome, run }) => {
    expect(outcome).toMatchObject({ action: 'error', guard: 'squash-net-diff-mismatch' });
    expect(run.mock.calls.some(([, args]) => args[0] === 'cat-file')).toBe(true);
    expect(run.mock.calls.some(([, args]) => args[0] === 'merge-file')).toBe(false);
  }, { result: bytes, fault: (args, result) => args[0] === 'cat-file'
    ? { ...result, stdout: Buffer.from(bytes) } : undefined }));
  it.each(['merge-base', 'rev-parse', 'ls-tree', 'cat-file', 'merge-file', 'hash-object'].flatMap(command =>
    ['status', 'error', 'signal'].map(failure => ({ command, failure }))))('refuses $command with $failure despite usable output', ({ command, failure }) => absorbedFixture(({ outcome }) => {
    expect(outcome).toMatchObject({ action: 'error', guard: 'squash-net-diff-mismatch' });
  }, { fault: (args, result) => args[0] === command && (command !== 'rev-parse' || args.at(-1).endsWith('^{tree}'))
    ? { ...result, [failure]: failure === 'status' ? 1 : failure === 'signal' ? 'SIGTERM' : new Error('unreadable') } : undefined }));
  it('refuses an unreadable ref even when ls-tree would report absence', () => absorbedFixture(({ outcome, run }) => {
    expect(outcome).toMatchObject({ action: 'error', guard: 'squash-net-diff-mismatch' });
    expect(run.mock.calls.some(([, args]) => args[0] === 'ls-tree')).toBe(false);
  }, { fault: (args, result) => args[0] === 'rev-parse' && args.at(-1).endsWith('^{tree}')
    ? { ...result, stdout: '' } : args[0] === 'ls-tree' ? { status: 0, stdout: '' } : undefined }));
  it('accepts a wholly absorbed card change by reproducing the base blob', () => {
    const main = first.replace('last', 'main last');
    absorbedFixture(({ outcome, run, g, base }) => {
      expect(outcome).toMatchObject({ proof: { proofKind: 'per-path-merge', absorbedPaths: [card], oldFiles: [card], newFiles: [], patchEqual: false } });
      expect(g(['rev-parse', `${outcome.newCommit}:${card}`])).toBe(g(['rev-parse', `${base}:${card}`]));
      expect(run.mock.calls.some(([, args]) => args[0] === 'merge-file')).toBe(true);
      expect(outcome.proof.patchHash).toBe(squashPatchHash(''));
      expect(outcome.proof).not.toHaveProperty('proofMode');
      const postComment = vi.fn();
      expect(postCardSquashMarker({ result: { ...outcome, action: 'rebased' }, comments: [], postComment })).toBe(true);
      expect(parseCardSquashMarkers([{ body: postComment.mock.calls[0][0], author: { login: 'chalbert' } }]))
        .toEqual([{ oldHead: outcome.proof.oldHead, newHead: outcome.newCommit, patchHash: outcome.proof.patchHash }]);
    }, { main, pr: first, result: main });
  });
  it('accepts one absorbed hunk and one remaining PR hunk in the same head blob', () => absorbedFixture(({ outcome, run }) => {
    expect(outcome).toMatchObject({ proof: { proofKind: 'per-path-merge', absorbedPaths: [], oldFiles: [card], newFiles: [card], patchEqual: false } });
    expect(run.mock.calls.some(([, args]) => args[0] === 'merge-file')).toBe(true);
  }));
  it('accepts partially absorbed changes with independent main content through a clean merge', () => {
    const main = first.replace('three', 'main middle');
    absorbedFixture(({ outcome, run }) => {
      expect(outcome).toMatchObject({ proof: { proofKind: 'per-path-merge', absorbedPaths: [card], patchEqual: false } });
      expect(run.mock.calls.some(([, args]) => args[0] === 'merge-file')).toBe(true);
    }, { main, result: both.replace('three', 'main middle') });
  });
  it.each(['100755', '120000'])('refuses head mode %s lost from an otherwise identical result', headMode => absorbedFixture(({ outcome }) => {
    expect(outcome).toMatchObject({ action: 'error', guard: 'squash-net-diff-mismatch' });
  }, { headMode }));
  it.each(['100755', '120000'])('refuses non-regular mode %s in the merge-file branch', baseMode => absorbedFixture(({ outcome, run }) => {
    expect(outcome).toMatchObject({ action: 'error', guard: 'squash-net-diff-mismatch' });
    expect(run.mock.calls.some(([, args]) => args[0] === 'merge-file')).toBe(false);
  }, { baseMode, main: first.replace('three', 'main middle'), result: both.replace('three', 'main middle') }));
  it('refuses a resolved path vanishing from the new diff without matching merge evidence', () => absorbedFixture(({ outcome, run }) => {
    expect(outcome).toMatchObject({ action: 'error', guard: 'squash-net-diff-mismatch' });
    expect(run.mock.calls.some(([, args]) => args[0] === 'merge-file')).toBe(true);
  }, { resolved: true, main: original.replace('three', 'main middle'), result: original.replace('three', 'main middle') }));
  it('accepts a resolved path vanishing from the new diff when it equals the exact merge', () => {
    const main = first.replace('last', 'main last');
    absorbedFixture(({ outcome, run }) => {
      expect(outcome).toMatchObject({ proof: { proofKind: 'per-path-merge', patchEqual: false,
        absorbedPaths: [card], resolvedPaths: [card], oldFiles: [card], newFiles: [] } });
      expect(outcome.proof).not.toHaveProperty('proofMode');
      expect(run.mock.calls.some(([, args]) => args[0] === 'merge-file')).toBe(true);
    }, { resolved: true, main, pr: first, result: main });
  });
  it('refuses an extra unresolved change that matches neither head nor clean merge', () => absorbedFixture(({ outcome, run }) => {
    expect(outcome).toMatchObject({ action: 'error', guard: 'squash-net-diff-mismatch' });
    expect(run.mock.calls.some(([, args]) => args[0] === 'hash-object' && !args.includes('-w'))).toBe(true);
  }, { result: both + 'tampered\n' }));
  it('refuses a path only in newFiles whose blob differs from the absent head blob', () => absorbedFixture(({ outcome }) => {
    expect(outcome).toMatchObject({ action: 'error', guard: 'squash-net-diff-mismatch' });
  }, { extra: true }));
  it('refuses a conflicting independent file merge', () => absorbedFixture(({ outcome, run }) => {
    expect(outcome).toMatchObject({ action: 'error', guard: 'squash-net-diff-mismatch' });
    const call = run.mock.calls.findIndex(([, args]) => args[0] === 'merge-file');
    expect(call).toBeGreaterThanOrEqual(0);
    expect(run.mock.results[call].value.status).toBe(1);
  }, { main: original.replace('first', 'main first'), pr: both, result: both + 'tampered\n' }));
});
