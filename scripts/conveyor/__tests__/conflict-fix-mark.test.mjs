/**
 * @file scripts/conveyor/__tests__/conflict-fix-mark.test.mjs
 * @description Pins the PURE STACKED-BASE conflict-fix comment builder (#3383). Unlike
 *   `we:scripts/conveyor/conflict-fix-round-count.mjs`'s own test coverage (exercised via
 *   `reconcile-core.test.mjs`), this file pins `buildConflictFixMarkComment` directly: it reuses
 *   `CONFLICT_FIX_COMMENT_MARKER` from that module UNCHANGED (single-sourced, never a fourth marker) so a
 *   stacked-base round and an ordinary main-base conflict-fix round bind on the exact same durable
 *   `CONFLICT_FIX_ROUND_CAP` floor, and states plainly that it touches no `review:*` label.
 */
import { spawnSync } from 'node:child_process';
import { planAcceptedConflictRebase, MAX_REBASE_DIFF_BYTES } from '../accepted-conflict-rebase.mjs';
import { describe, it, expect, vi } from 'vitest';
import { countConflictFixComments, CONFLICT_FIX_COMMENT_MARKER as ROUND_COUNT_MARKER } from '../conflict-fix-round-count.mjs';
import { buildConflictFixMarkComment, runConflictFixMark, CONFLICT_FIX_COMMENT_MARKER } from '../conflict-fix-mark.mjs';

describe('conflict-fix-mark.mjs#CONFLICT_FIX_COMMENT_MARKER — single-sourced, never a fourth marker (#3383)', () => {
  it('is the IDENTICAL marker conflict-fix-round-count.mjs exports — never redeclared', () => {
    expect(CONFLICT_FIX_COMMENT_MARKER).toBe(ROUND_COUNT_MARKER);
  });
});

describe('buildConflictFixMarkComment — the durable STACKED-BASE conflict-fix comment (#3383)', () => {
  it('leads with the SAME marker the ordinary conflict-fix round posts, so both count against one cap', () => {
    const body = buildConflictFixMarkComment({ baseRefName: 'lane/3681-ratify-daemon-lifecycle' });
    expect(body.split('\n')[0]).toBe(CONFLICT_FIX_COMMENT_MARKER);
    // Round-trips through the SAME counter the ordinary conflict-fix round is counted with. #3383 — that
    // counter now also requires a trusted author.
    expect(countConflictFixComments([{ body, author: { login: 'web-everything' } }])).toBe(1);
  });

  it('names the base it resolved against', () => {
    const body = buildConflictFixMarkComment({ baseRefName: 'lane/3681-ratify-daemon-lifecycle' });
    expect(body).toContain('lane/3681-ratify-daemon-lifecycle');
  });

  it('falls back to generic wording when no baseRefName is given', () => {
    const body = buildConflictFixMarkComment({});
    expect(body).toContain('its own base branch');
  });

  it('states plainly that NO review label was touched — there was nothing to re-arm', () => {
    const body = buildConflictFixMarkComment({ baseRefName: 'lane/x' });
    expect(body).toContain('review:accepted');
    expect(body).toContain('review:changes');
    expect(body.toLowerCase()).toContain('did not touch');
  });

  it('a human quoting the marker mid-body never inflates the count (leading-line narrowing, shared with the round-count reader)', () => {
    const quoted = `> ${CONFLICT_FIX_COMMENT_MARKER}\na human quoting it in a reply`;
    expect(countConflictFixComments([{ body: quoted }])).toBe(0);
  });
});


describe('conflict-rebase keep-review hand-back enforcement', () => {
  const oldHead = 'a'.repeat(40), newHead = 'b'.repeat(40), oldBase = 'c'.repeat(40), newBase = 'd'.repeat(40);
  const patch = 'diff --git a/a b/a\nindex 111..222 100644\n--- a/a\n+++ b/a\n@@ -1,3 +1,3 @@\n before\n-old\n+new\n after\n';
  const args = ['6911', '--repo=web-everything/web-everything', '--mode=conflict-rebase',
    `--old-head=${oldHead}`, `--old-base=${oldBase}`];
  const fixture = (after = patch) => {
    const pushed = { headRefOid: newHead, baseRefOid: newBase, baseRefName: 'main' };
    const gh = vi.fn(argv => argv[1] === 'view' ? JSON.stringify(pushed) : '');
    const git = vi.fn(argv => argv[0] === 'merge-base' ? oldBase : argv.at(-2) === oldHead ? patch : after);
    return { pushed, gh, git };
  };
  it.each([
    ['semantic change', patch.replace('+new', '+changed')],
    ['unreadable patch', ''],
    ['oversized patch', patch + 'x'.repeat(MAX_REBASE_DIFF_BYTES)],
  ])('refuses %s without posting a keep-review marker and names the review fallback', (_name, after) => {
    const io = fixture(after);
    expect(() => runConflictFixMark(args, io)).toThrow('rearm-review.mjs --round=conflict');
    expect(io.gh.mock.calls.some(([argv]) => argv[1] === 'comment')).toBe(false);
  });
  it('refuses missing original pins and unreadable pushed-head evidence without posting', () => {
    for (const bad of [args.filter(a => !a.startsWith('--old-base=')), args]) {
      const io = fixture();
      if (bad === args) io.gh.mockImplementation(() => { throw new Error('unreadable'); });
      expect(() => runConflictFixMark(bad, io)).toThrow('rearm-review.mjs --round=conflict');
      expect(io.gh.mock.calls.some(([argv]) => argv[1] === 'comment')).toBe(false);
    }
  });
  it('exits non-zero with no evidence and directs the operator to rearm review', () => {
    const result = spawnSync(process.execPath, ['scripts/conveyor/conflict-fix-mark.mjs',
      '6911', '--mode=conflict-rebase'], { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('rearm-review.mjs --round=conflict');
    expect(result.stdout).not.toContain('"commented":true');
  });
  it('refuses legacy actor receipts that bypass the enforced conflict-rebase mode', () => {
    const io = fixture();
    expect(() => runConflictFixMark(['6911', `--actor=accepted-conflict-rebase:${oldHead}@${newBase}`], io))
      .toThrow('--mode=conflict-rebase');
    expect(io.gh).not.toHaveBeenCalled();
  });
  it('proves the live pushed head, posts its receipt, and deduplicates only that head', () => {
    const io = fixture(patch.replace('111..222', '333..444'));
    expect(runConflictFixMark(args, io)).toMatchObject({ ok: true, head: newHead });
    expect(io.git).toHaveBeenCalledWith(['merge-base', newHead, newBase]);
    const posts = io.gh.mock.calls.filter(([argv]) => argv[1] === 'comment');
    expect(posts).toHaveLength(1);
    const body = posts[0][0][posts[0][0].indexOf('--body') + 1];
    expect(body).toContain(`accepted-conflict-rebase:${newHead}@${newBase}`);
    expect(body).not.toContain(`accepted-conflict-rebase:${oldHead}@`);
    const plan = headRefOid => planAcceptedConflictRebase({ pr: {
      headRefOid, baseRefName: 'main', mergeable: 'CONFLICTING', labels: ['review:accepted'],
      comments: [{ body, author: { login: 'web-everything' } }],
    }, mainSha: newBase, cap: 3, ceiling: 9 });
    expect(plan(newHead)).toMatchObject({ kind: 'refuse', why: expect.stringContaining('already completed for this head') });
    expect(plan(oldHead).kind).toBe('fix');
  });
  it('refuses a head changed during proof without posting', () => {
    const io = fixture();
    io.gh.mockReturnValueOnce(JSON.stringify(io.pushed))
      .mockReturnValueOnce(JSON.stringify({ ...io.pushed, headRefOid: oldHead }));
    expect(() => runConflictFixMark(args, io)).toThrow('rearm-review.mjs --round=conflict');
    expect(io.gh).toHaveBeenCalledTimes(2);
  });
});
