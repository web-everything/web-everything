/** @file accepted-conflict-rebase.test.mjs — admission, bounded proof and durable hand-back guarantees. */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AUTOMATION_LOGINS } from '../../lib/marker-authorship.mjs';
import { isAcceptedConflictRebase, planAcceptedConflictRebase, conflictRebaseReceipt,
  classifyRebaseTriviality, MAX_REBASE_DIFF_BYTES } from '../accepted-conflict-rebase.mjs';
import { proveRebaseTriviality } from '../rebase-triviality.mjs';
import { CONFLICT_FIX_COMMENT_MARKER } from '../conflict-fix-round-count.mjs';
import { buildConflictRearmComment } from '../rearm-review.mjs';
import { buildConflictFixMarkComment } from '../conflict-fix-mark.mjs';
import { decideSetLabel } from '../../review-set-label.mjs';
import { planFixesFromReconcile, withPlannedContext } from '../reconcile-fix-dispatch.mjs';

const head = 'a'.repeat(40), target = 'b'.repeat(40), earlier = 'c'.repeat(40);
const pr = (over = {}) => ({ number: 6911, state: 'OPEN', baseRefName: 'main', headRefOid: head,
  mergeStateStatus: 'DIRTY', labels: ['review:accepted'], comments: [], ...over });
const plan = (over = {}, opts = {}) => planAcceptedConflictRebase({ pr: pr(over), mainSha: target, cap: 3, ceiling: 9, ...opts });
const marker = (sha = target, actor = 'fixer') => ({ author: { login: AUTOMATION_LOGINS[0] },
  body: buildConflictFixMarkComment({ actor, baseRefName: 'main', baseSha: sha }) });
const patch = 'diff --git a/a.txt b/a.txt\nindex 111..222 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n before\n-old\n+new\n after\n';

describe('accepted conflict-rebase planner', () => {
  it.each(['review:accepted', 'ready-to-merge', 'status:ready-to-merge'])('admits %s with no CI requirement', label => {
    expect(plan({ labels: [{ name: label }] })).toMatchObject({ kind: 'fix', isConflict: true, mode: 'conflict-rebase', attempts: 0 });
  });
  it.each(['review:changes', 'review:human', 'review:pending', 'review:pending-with-bounce',
    'review:held-mechanical', 'status:held', 'held'])('refuses approval combined with %s', label => {
    expect(plan({ labels: ['review:accepted', label] })).toBeNull();
  });
  it.each([{ labels: null }, { labels: ['review:accepted', {}] }, { isDraft: true },
    { baseRefName: 'lane/base' }, { baseRefName: null }, { state: 'CLOSED' }, { mergeStateStatus: 'UNKNOWN' }])('refuses ineligible evidence %j', over => {
    expect(isAcceptedConflictRebase(pr(over))).toBe(false);
    expect(plan(over)).toBeNull();
  });
  it.each([{ headRefOid: null }, { comments: null }])('fails closed for incomplete evidence %j', over => {
    expect(plan(over)).toMatchObject({ kind: 'refuse', why: expect.stringContaining('refresh') });
  });
  it('admits mergeable CONFLICTING without DIRTY through the shared predicate', () => {
    expect(plan({ mergeable: 'CONFLICTING', mergeStateStatus: 'UNKNOWN' }).kind).toBe('fix');
  });
  it('fails closed for an unreadable target', () => expect(plan({}, { mainSha: null }).kind).toBe('refuse'));
  it('refuses live fixer claims and referral holds', () => {
    expect(plan({ fixClaim: { who: 'fixer' } }).kind).toBe('refuse');
    expect(plan({ referralHold: { why: 'ruling owed' } }).kind).toBe('refuse');
  });
  it.each([
    ['conflict-fix-mark', actor => buildConflictFixMarkComment({ actor, baseRefName: 'main', baseSha: target })],
    ['rearm-review', actor => buildConflictRearmComment({ actor, decision: { keepsHuman: false }, mainRef: 'main', mainSha: target })],
  ])('deduplicates %s receipts for a completed head after main advances and planner restarts', (_name, build) => {
    const first = plan();
    const comments = [{ author: { login: AUTOMATION_LOGINS[0] }, body: build(first.conflictRebase.receipt) }];
    expect(plan({ comments })).toMatchObject({ kind: 'refuse', why: expect.stringContaining('already completed for this head') });
    expect(plan({ comments, headRefOid: earlier }).kind).toBe('fix');
    expect(plan({ comments }, { mainSha: earlier }).kind).toBe('refuse');
    expect(plan({ comments: [{ ...comments[0], author: { login: 'untrusted' } }] }).kind).toBe('fix');
    expect(plan({ comments: [{ ...comments[0], body: build(first.conflictRebase.receipt + 'junk') }] }).kind).toBe('fix');
  });
  it('refuses both existing conflict budgets with an operator fallback', () => {
    for (const comments of [Array.from({ length: 3 }, () => marker()), Array.from({ length: 9 }, () => marker(earlier))]) {
      expect(plan({ comments })).toMatchObject({ kind: 'cap-exhausted', capKind: 'conflict-rebase', why: expect.stringContaining('person must take over') });
    }
  });
  it('carries mode and proof receipt through itemless planning into the fix mandate', () => {
    const entry = { ...plan(), prNumber: 6911, headRefName: 'topic', headRefOid: head, files: ['scripts/example.mjs'] };
    const { planned, refusals } = planFixesFromReconcile([entry], () => null, () => []);
    expect(refusals).toEqual([]);
    expect(planned[0]).toMatchObject({ mode: 'conflict-rebase', conflictRebase: { receipt: conflictRebaseReceipt(head, target) } });
    expect(withPlannedContext('brief', planned[0])).toContain('ACCEPTED-CONFLICT-REBASE MODE');
  });
});

describe('triviality and review hand-back', () => {
  it('preserves review only for identical per-file changes with relocated hunk lines and object IDs', () => {
    const after = patch.replace('111..222', '333..444').replace('@@ -1,3 +1,3 @@', '@@ -10,3 +20,3 @@ context');
    expect(classifyRebaseTriviality(patch, after)).toMatchObject({ trivial: true, handback: 'conflict-fix-mark' });
    const comment = buildConflictFixMarkComment({ actor: conflictRebaseReceipt(head, target), baseRefName: 'main', baseSha: target });
    expect(comment.startsWith(CONFLICT_FIX_COMMENT_MARKER)).toBe(true);
  });
  it.each([patch.replace('+new', '+semantic'), patch.replace('diff --git a/a.txt b/a.txt\n', 'diff --git a/a.txt b/a.txt\nold mode 100644\nnew mode 100755\n'), patch.replaceAll('a.txt', 'b.txt'), patch + patch])('requires re-review for changed file, content, mode or inventory', after => {
    expect(classifyRebaseTriviality(patch, after)).toMatchObject({ trivial: false, handback: 'rearm-review' });
  });
  it.each([null, '', 'unreadable', patch.slice(0, -5), patch.replace('-old\n', ''), 'diff --git a/a b/a\nBinary files a/a and b/a differ', patch + 'x'.repeat(MAX_REBASE_DIFF_BYTES)])('fails closed on incomplete, binary or oversized evidence', after => {
    expect(classifyRebaseTriviality(patch, after)).toMatchObject({ trivial: false, why: expect.stringContaining('independent review required') });
  });
  it.each([' before', ' after'])('requires review when identical replacement moves to different %s context', context => {
    expect(classifyRebaseTriviality(patch, patch.replace(context, context + ' elsewhere')))
      .toMatchObject({ trivial: false, handback: 'rearm-review' });
  });
  it('fails closed on context-free hunks even when their edit text matches', () => {
    const zeroContext = patch.replace('@@ -1,3 +1,3 @@', '@@ -2 +2 @@').replace(' before\n', '').replace(' after\n', '');
    expect(classifyRebaseTriviality(zeroContext, zeroContext).trivial).toBe(false);
  });
  it('fails closed on a context-only hunk with no edit evidence', () => {
    const contextOnly = patch.replace('@@ -1,3 +1,3 @@', '@@ -1,2 +1,2 @@').replace('-old\n+new\n', '');
    expect(classifyRebaseTriviality(contextOnly, contextOnly).trivial).toBe(false);
  });
  it('producer distinguishes identical replacements at different occurrences', () => {
    const cwd = mkdtempSync(join(process.env.TMPDIR, 'rebase-context-'));
    const git = (argv, input) => execFileSync('git', argv, { cwd, input, encoding: 'utf8', timeout: 10_000 });
    try {
      git(['init', '--bare', '--quiet']);
      const tree = text => {
        const blob = git(['hash-object', '-w', '--stdin'], text).trim();
        return git(['mktree'], `100644 blob ${blob}\tfile.txt\n`).trim();
      };
      const text = 'first\na\nb\nc\nold\nx\ny\nz\nbetween\na\nb\nc\nold\nx\ny\nz\nlast\n';
      const base = tree(text), before = tree(text.replace('old', 'new'));
      const after = tree(text.replace('old\nx\ny\nz\nlast', 'new\nx\ny\nz\nlast'));
      expect(proveRebaseTriviality([before, after, base, base], argv => argv[0] === 'merge-base' ? base : git(argv)))
        .toMatchObject({ trivial: false, handback: 'rearm-review' });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
  it('uses the existing rearm path to pending for changed accepted and ready-only PRs', () => {
    for (const [currentLabels, requireLive] of [[['review:accepted', 'ready-to-merge'], 'accepted'], [['status:ready-to-merge'], 'missing']]) {
      expect(decideSetLabel({ to: 'rearm', currentLabels, requireLive })).toMatchObject({ allowed: true, addLabel: 'review:pending' });
    }
  });
  it('CLI reads each pinned merge-base then contextual own patch', () => {
    const calls = [];
    const result = proveRebaseTriviality([head, earlier, target, target], argv => {
      calls.push(argv);
      return argv[0] === 'merge-base' ? target + '\n' : patch;
    });
    expect(result.trivial).toBe(true);
    expect(calls[0]).toEqual(['merge-base', head, target]);
    expect(calls[2]).toEqual(['merge-base', earlier, target]);
    expect(calls[1]).toContain('--unified=2147483647');
    expect(calls[1].slice(-3)).toEqual([target, head, '--']);
  });
  it('requires re-review for a changed gitlink alongside identical text under diff.ignoreSubmodules=all', () => {
    const cwd = mkdtempSync(join(process.env.TMPDIR, 'rebase-gitlink-'));
    const git = (argv, input) => execFileSync('git', argv, {
      cwd, input, encoding: 'utf8', timeout: 10_000, maxBuffer: MAX_REBASE_DIFF_BYTES,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    }).trimEnd();
    try {
      git(['init', '--bare', '--quiet']);
      git(['config', 'diff.ignoreSubmodules', 'all']);
      const blob = text => git(['hash-object', '-w', '--stdin'], text);
      // Trees exercise Git's actual diff producer without creating commits or updating any refs.
      const tree = (text, gitlink) => git(['mktree'],
        `100644 blob ${blob(text)}\tfile.txt\n160000 commit ${gitlink}\tdependency\n`);
      const base = tree('before\nold\nafter\n', head);
      const before = tree('before\nnew\nafter\n', head);
      const after = tree('before\nnew\nafter\n', earlier);
      const pins = [before, after, base, base];
      const read = argv => argv[0] === 'merge-base' ? base : git(argv) + '\n';
      // Prove the hostile configuration really hides the gitlink from the otherwise identical text diff.
      expect(proveRebaseTriviality(pins, argv => read(argv.filter(a => a !== '--ignore-submodules=none'))))
        .toMatchObject({ trivial: true, handback: 'conflict-fix-mark' });
      expect(proveRebaseTriviality(pins, read))
        .toMatchObject({ trivial: false, handback: 'rearm-review' });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
  it('requires rearm-review for an outside semantic change from a subdirectory under diff.relative=true', () => {
    const repo = mkdtempSync(join(process.env.TMPDIR, 'rebase-relative-'));
    const subdir = join(repo, 'inside');
    const git = (argv, input, cwd = repo) => execFileSync('git', argv, {
      cwd, input, encoding: 'utf8', timeout: 10_000, maxBuffer: MAX_REBASE_DIFF_BYTES,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    }).trimEnd();
    try {
      git(['init', '--quiet']);
      git(['config', 'diff.relative', 'true']);
      mkdirSync(subdir);
      const blob = text => git(['hash-object', '-w', '--stdin'], text);
      const tree = (inside, outside) => {
        const nested = git(['mktree'], `100644 blob ${blob(inside)}\tfile.txt\n`);
        return git(['mktree'], `040000 tree ${nested}\tinside\n100644 blob ${blob(outside)}\toutside.txt\n`);
      };
      const base = tree('before\nold\nafter\n', 'original\n');
      const before = tree('before\nnew\nafter\n', 'original\n');
      const after = tree('before\nnew\nafter\n', 'semantic change\n');
      const pins = [before, after, base, base];
      // Use real repository-wide tree diffs, with only merge-base resolution injected (no commits or refs).
      const read = argv => argv[0] === 'merge-base' ? base : git(argv, undefined, subdir) + '\n';
      expect(proveRebaseTriviality(pins, argv => read(argv.filter(a => a !== '--no-relative'))))
        .toMatchObject({ trivial: true, handback: 'conflict-fix-mark' });
      expect(proveRebaseTriviality(pins, read))
        .toMatchObject({ trivial: false, handback: 'rearm-review' });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
  it('CLI fails closed on Git errors, invalid merge bases and missing pins', () => {
    expect(proveRebaseTriviality([head, head, target, target], () => { throw new Error('failed'); }).trivial).toBe(false);
    expect(proveRebaseTriviality([head, head, target, target], () => 'unknown').trivial).toBe(false);
    expect(proveRebaseTriviality([head, head], () => { throw new Error('must not run'); }).trivial).toBe(false);
  });
});
