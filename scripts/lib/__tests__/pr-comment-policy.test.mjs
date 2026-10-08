/**
 * @file scripts/lib/__tests__/pr-comment-policy.test.mjs
 * @description xadixye — daemons post a PR comment only when state changes or someone must act. Proves the
 *   setting (`prComments.mode`), the status-only note kinds, the repeat check, and the drain's no-action reasons.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_PR_COMMENT_MODE, loadPrCommentSettings, isStatusOnlyNote, repeatsLatestComment,
  isNoActionDrainReason, drainReasonCommentSuppressed,
} from '../pr-comment-policy.mjs';

const bot = (body) => ({ body, author: { login: 'web-everything' } });
const stranger = (body) => ({ body, author: { login: 'random-person' } });

function settingsFile(content) {
  const dir = mkdtempSync(join(tmpdir(), 'pr-comment-policy-'));
  const path = join(dir, 'pr-comments-settings.json');
  writeFileSync(path, content);
  return path;
}

describe('loadPrCommentSettings', () => {
  it('defaults to on-change-or-action', () => {
    expect(DEFAULT_PR_COMMENT_MODE).toBe('on-change-or-action');
    expect(loadPrCommentSettings({ path: '/nonexistent/x.json', env: {} }).mode).toBe('on-change-or-action');
  });
  it('reads prComments.mode from the settings file', () => {
    const path = settingsFile(JSON.stringify({ prComments: { mode: 'all' } }));
    expect(loadPrCommentSettings({ path, env: {} }).mode).toBe('all');
  });
  it('the env override wins over the file', () => {
    const path = settingsFile(JSON.stringify({ prComments: { mode: 'all' } }));
    expect(loadPrCommentSettings({ path, env: { WE_PR_COMMENTS_MODE: 'on-change-or-action' } }).mode).toBe('on-change-or-action');
  });
  it('a malformed file or an unknown mode falls back to the default', () => {
    expect(loadPrCommentSettings({ path: settingsFile('{not json'), env: {} }).mode).toBe('on-change-or-action');
    expect(loadPrCommentSettings({ path: settingsFile('{"prComments":{"mode":"loud"}}'), env: {} }).mode).toBe('on-change-or-action');
    expect(loadPrCommentSettings({ path: '/nonexistent/x.json', env: { WE_PR_COMMENTS_MODE: 'loud' } }).mode).toBe('on-change-or-action');
  });
  it('the checked-in settings file is the default mode', () => {
    expect(loadPrCommentSettings({ env: {} }).mode).toBe('on-change-or-action');
  });
});

describe('isStatusOnlyNote', () => {
  it('waiting/status notes need no one to act', () => {
    expect(isStatusOnlyNote({ kind: 'review-label-missing' })).toBe(true);
    expect(isStatusOnlyNote({ kind: 'stacked-awaiting-base' })).toBe(true);
  });
  it('escalations that need a person stay', () => {
    for (const kind of ['ci-heal-exhausted', 'awaiting-permission', 'round-cap-exhausted', 'ruling-dispute',
      'stacked-base-orphaned', 'something-new', undefined]) {
      expect(isStatusOnlyNote({ kind })).toBe(false);
    }
  });
});

describe('repeatsLatestComment', () => {
  const isNote = (b) => b.startsWith('🔔');
  it('true when the latest trusted comment of the same kind says the same thing (hidden markers ignored)', () => {
    const comments = [bot('🔔 x\n\nsame text\n\n<!-- key: a -->')];
    expect(repeatsLatestComment(comments, '🔔 x\n\nsame text\n\n<!-- key: b -->', isNote)).toBe(true);
  });
  it('false when the latest one differs, even if an older one matches', () => {
    const comments = [bot('🔔 x\n\nsame text'), bot('🔔 x\n\nnewer text')];
    expect(repeatsLatestComment(comments, '🔔 x\n\nsame text', isNote)).toBe(false);
  });
  it('ignores comments of other kinds and untrusted authors', () => {
    expect(repeatsLatestComment([bot('other\n\nsame text')], '🔔 x\n\nsame text', isNote)).toBe(false);
    expect(repeatsLatestComment([stranger('🔔 x\n\nsame text')], '🔔 x\n\nsame text', isNote)).toBe(false);
  });
  it('tolerates a missing or odd comment list', () => {
    expect(repeatsLatestComment(null, '🔔 x', isNote)).toBe(false);
    expect(repeatsLatestComment([null, 5, {}], '🔔 x', isNote)).toBe(false);
  });
});

describe('isNoActionDrainReason / drainReasonCommentSuppressed', () => {
  const noAction = [
    'not mergeable (mergeable=UNKNOWN)',
    'required check "test" is not green',
    'merge state BLOCKED (branch protection unsatisfied: required checks pending or red, or an uncleared review) — owned by the ci-heal / review daemons, nothing for the drain to rebase',
    'base is not main (lane/worker-contract-s1)',
    'held — a review hold (review:pending) stands, so the "ready-to-merge" go-ahead is withheld even though the required check is green (#2832). Specifically: blast-radius (a.mjs). Clear the review to release it.',
  ];
  const needsAction = [
    'CodeQL check failed (new code-scanning alerts in the changed code) — refusing to land; fix the alert and re-push (drainBlocksOnCodeQL)',
    'held — a review hold (review:human) stands, so the "ready-to-merge" go-ahead is withheld even though the required check is green (#2832). Clear the review to release it.',
    'held — a review hold (review:changes, review:pending) stands, so the go-ahead is withheld. Clear the review to release it.',
    'review:accepted is STALE — head advanced past the reviewed commit',
    'merge conflict with main',
    '',
  ];
  it('the waiting reasons are no-action', () => {
    for (const r of noAction) expect(isNoActionDrainReason(r), r).toBe(true);
  });
  it('failures, human holds and send-backs still need action', () => {
    for (const r of needsAction) expect(isNoActionDrainReason(r), r).toBe(false);
  });
  it('suppresses only skip/park kinds, only in on-change-or-action mode', () => {
    expect(drainReasonCommentSuppressed('skip', noAction[0], { mode: 'on-change-or-action' })).toBe(true);
    expect(drainReasonCommentSuppressed('park', noAction[4], { mode: 'on-change-or-action' })).toBe(true);
    expect(drainReasonCommentSuppressed('skip', noAction[0], { mode: 'all' })).toBe(false);
    expect(drainReasonCommentSuppressed('skip', needsAction[0], { mode: 'on-change-or-action' })).toBe(false);
    // merges, merge traces and review-coverage records always post
    for (const kind of ['land', 'merge-trace', 'review-coverage', 'stacked-base-close']) {
      expect(drainReasonCommentSuppressed(kind, noAction[0], { mode: 'on-change-or-action' })).toBe(false);
    }
  });
});
