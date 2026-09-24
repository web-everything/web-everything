/**
 * @file scripts/conveyor/__tests__/conflict-fix-mark.test.mjs
 * @description Pins the PURE STACKED-BASE conflict-fix comment builder (#3383). Unlike
 *   `we:scripts/conveyor/conflict-fix-round-count.mjs`'s own test coverage (exercised via
 *   `reconcile-core.test.mjs`), this file pins `buildConflictFixMarkComment` directly: it reuses
 *   `CONFLICT_FIX_COMMENT_MARKER` from that module UNCHANGED (single-sourced, never a fourth marker) so a
 *   stacked-base round and an ordinary main-base conflict-fix round bind on the exact same durable
 *   `CONFLICT_FIX_ROUND_CAP` floor, and states plainly that it touches no `review:*` label.
 */
import { describe, it, expect } from 'vitest';
import { countConflictFixComments, CONFLICT_FIX_COMMENT_MARKER as ROUND_COUNT_MARKER } from '../conflict-fix-round-count.mjs';
import { buildConflictFixMarkComment, CONFLICT_FIX_COMMENT_MARKER } from '../conflict-fix-mark.mjs';

describe('conflict-fix-mark.mjs#CONFLICT_FIX_COMMENT_MARKER — single-sourced, never a fourth marker (#3383)', () => {
  it('is the IDENTICAL marker conflict-fix-round-count.mjs exports — never redeclared', () => {
    expect(CONFLICT_FIX_COMMENT_MARKER).toBe(ROUND_COUNT_MARKER);
  });
});

describe('buildConflictFixMarkComment — the durable STACKED-BASE conflict-fix comment (#3383)', () => {
  it('leads with the SAME marker the ordinary conflict-fix round posts, so both count against one cap', () => {
    const body = buildConflictFixMarkComment({ baseRefName: 'lane/3681-ratify-daemon-lifecycle' });
    expect(body.split('\n')[0]).toBe(CONFLICT_FIX_COMMENT_MARKER);
    // Round-trips through the SAME counter the ordinary conflict-fix round is counted with.
    expect(countConflictFixComments([{ body }])).toBe(1);
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
