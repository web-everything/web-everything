/**
 * @file scripts/conveyor/__tests__/reconcile-note-comment.test.mjs
 * @description #4191 (epic #4075/#3383) — proof of the durable, deduped, author-checked PR-comment helper for a
 *   reconcile note episode: stable episode keys, an unforgeable marker, and the ONE IO shell that actually posts.
 */
import { describe, it, expect } from 'vitest';
import {
  NOTE_COMMENT_MARKER, noteEpisodeKey, noteHeadline, buildNoteComment, hasPostedNoteComment, planNoteComment,
  postNoteComment,
} from '../reconcile-note-comment.mjs';

describe('noteEpisodeKey', () => {
  it('ci-heal-exhausted: keyed on the attempt/cap pair', () => {
    expect(noteEpisodeKey({ kind: 'ci-heal-exhausted', prNumber: 2636, attempts: 2, cap: 3 })).toBe('ci-heal-exhausted:2636:2/3');
  });
  it('a later, genuinely new exhaustion (cap burned again) gets a DIFFERENT key', () => {
    const first = noteEpisodeKey({ kind: 'ci-heal-exhausted', prNumber: 2636, attempts: 3, cap: 3 });
    const second = noteEpisodeKey({ kind: 'ci-heal-exhausted', prNumber: 2636, attempts: 6, cap: 3 });
    expect(first).not.toBe(second);
  });
  it('awaiting-permission: keyed on the stuck session', () => {
    expect(noteEpisodeKey({ kind: 'awaiting-permission', prNumber: 10, sessionId: 'sess-abc' })).toBe('awaiting-permission:10:sess-abc');
  });
  it('awaiting-permission falls back to pid when sessionId is absent', () => {
    expect(noteEpisodeKey({ kind: 'awaiting-permission', prNumber: 10, pid: 555 })).toBe('awaiting-permission:10:555');
  });
  it('an unrecognised kind keys on its own text — never silently dropped', () => {
    expect(noteEpisodeKey({ kind: 'something-new', prNumber: 5, text: 'a fresh escalation' }))
      .toBe('something-new:5:a fresh escalation');
  });

  // #xu38vlf (epic #4075/#3383) — round-cap-exhausted (a NEW population, unowned-mechanical-rebase) and
  // liveness-wait-exhausted (a brand-new note kind) both reuse this shared episode-key machinery.
  it('round-cap-exhausted: keyed on the population (capKind) AND the attempt/cap pair', () => {
    expect(noteEpisodeKey({
      kind: 'round-cap-exhausted', prNumber: 1854, attempts: 3, cap: 3, capKind: 'unowned-mechanical-rebase',
    })).toBe('round-cap-exhausted:1854:unowned-mechanical-rebase:3/3');
  });

  it('round-cap-exhausted: a DIFFERENT population (capKind) at the SAME attempt/cap pair gets a DIFFERENT key', () => {
    const a = noteEpisodeKey({ kind: 'round-cap-exhausted', prNumber: 1, attempts: 3, cap: 3, capKind: 'unowned-mechanical-rebase' });
    const b = noteEpisodeKey({ kind: 'round-cap-exhausted', prNumber: 1, attempts: 3, cap: 3, capKind: 'conflict-fix' });
    expect(a).not.toBe(b);
  });

  it('liveness-wait-exhausted: keyed on the PR and the wait\'s own first-observed timestamp (since)', () => {
    expect(noteEpisodeKey({ kind: 'liveness-wait-exhausted', prNumber: 1920, since: '2026-09-26T10:00:00.000Z' }))
      .toBe('liveness-wait-exhausted:1920:2026-09-26T10:00:00.000Z');
  });

  it('liveness-wait-exhausted: a FRESH wait (a new since) is a genuinely new episode', () => {
    const first = noteEpisodeKey({ kind: 'liveness-wait-exhausted', prNumber: 1920, since: '2026-09-26T10:00:00.000Z' });
    const second = noteEpisodeKey({ kind: 'liveness-wait-exhausted', prNumber: 1920, since: '2026-09-27T10:00:00.000Z' });
    expect(first).not.toBe(second);
  });
});

describe('noteHeadline — the operator\'s own rule', () => {
  it('ci-heal-exhausted reads "needs your decision: fix attempts exhausted"', () => {
    expect(noteHeadline({ kind: 'ci-heal-exhausted' })).toBe('needs your decision: fix attempts exhausted');
  });
  it('awaiting-permission reads its own headline', () => {
    expect(noteHeadline({ kind: 'awaiting-permission' })).toMatch(/blocked on a permission prompt/);
  });
  it('an unknown kind still gets a needs-your-decision headline, never blank', () => {
    expect(noteHeadline({ kind: 'mystery' })).toContain('needs your decision');
  });

  it('round-cap-exhausted reads "needs your decision: auto-repair rounds exhausted"', () => {
    expect(noteHeadline({ kind: 'round-cap-exhausted' })).toBe('needs your decision: auto-repair rounds exhausted');
  });

  it('liveness-wait-exhausted reads its own headline', () => {
    expect(noteHeadline({ kind: 'liveness-wait-exhausted' })).toBe('needs your decision: a liveness wait ran past its bound');
  });
});

describe('buildNoteComment', () => {
  it('first line is the stable marker; carries the headline, the note text, and the episode key', () => {
    const note = { kind: 'ci-heal-exhausted', prNumber: 2636, attempts: 3, cap: 3, text: 'auto-heal exhausted' };
    const body = buildNoteComment(note);
    expect(body.startsWith(NOTE_COMMENT_MARKER)).toBe(true);
    expect(body).toContain('needs your decision: fix attempts exhausted');
    expect(body).toContain('auto-heal exhausted');
    expect(body).toContain(`<!-- conveyor-note-key: ${noteEpisodeKey(note)} -->`);
  });

  it('includes the last failure reason for ci-heal-exhausted when present', () => {
    const body = buildNoteComment({
      kind: 'ci-heal-exhausted', prNumber: 1, attempts: 3, cap: 3, text: 'exhausted', lastFailureReason: 'test suite',
    });
    expect(body).toContain('Last failure: test suite');
  });
});

describe('hasPostedNoteComment — trusted-author dedup', () => {
  const note = { kind: 'ci-heal-exhausted', prNumber: 2636, attempts: 3, cap: 3 };
  const key = noteEpisodeKey(note);

  it('true when a trusted (automation) author already posted this exact episode', () => {
    const comments = [{ body: `${NOTE_COMMENT_MARKER}\n\n<!-- conveyor-note-key: ${key} -->`, author: { login: 'web-everything' } }];
    expect(hasPostedNoteComment(comments, note)).toBe(true);
  });

  it('false for a DIFFERENT episode (a different attempt/cap pair) — never a stale match', () => {
    const otherKey = noteEpisodeKey({ ...note, attempts: 2 });
    const comments = [{ body: `${NOTE_COMMENT_MARKER}\n\n<!-- conveyor-note-key: ${otherKey} -->`, author: { login: 'web-everything' } }];
    expect(hasPostedNoteComment(comments, note)).toBe(false);
  });

  it('false when an UNTRUSTED login posts the identical marker+key — must never suppress a real escalation', () => {
    const comments = [{ body: `${NOTE_COMMENT_MARKER}\n\n<!-- conveyor-note-key: ${key} -->`, author: { login: 'some-rando' } }];
    expect(hasPostedNoteComment(comments, note)).toBe(false);
  });

  it('false for a bare-string comment (no author at all) — fail closed', () => {
    expect(hasPostedNoteComment([`${NOTE_COMMENT_MARKER}\n\n<!-- conveyor-note-key: ${key} -->`], note)).toBe(false);
  });

  it('false with no comments / non-array input', () => {
    expect(hasPostedNoteComment(undefined, note)).toBe(false);
    expect(hasPostedNoteComment([], note)).toBe(false);
  });

  it('true when the operator (a trusted human login) posted it by hand', () => {
    const comments = [{ body: `${NOTE_COMMENT_MARKER}\n\n<!-- conveyor-note-key: ${key} -->`, author: { login: 'chalbert' } }];
    expect(hasPostedNoteComment(comments, note)).toBe(true);
  });
});

describe('planNoteComment — the whole pure decision, no network', () => {
  it('alreadyPosted:false, with a body, for a fresh episode', () => {
    const note = { kind: 'awaiting-permission', prNumber: 5, sessionId: 's1', text: 'blocked' };
    const plan = planNoteComment(note, []);
    expect(plan.alreadyPosted).toBe(false);
    expect(plan.body).toContain(NOTE_COMMENT_MARKER);
    expect(plan.key).toBe(noteEpisodeKey(note));
  });

  it('alreadyPosted:true for an episode a trusted author already commented', () => {
    const note = { kind: 'awaiting-permission', prNumber: 5, sessionId: 's1', text: 'blocked' };
    const key = noteEpisodeKey(note);
    const comments = [{ body: `${NOTE_COMMENT_MARKER}\n<!-- conveyor-note-key: ${key} -->`, author: { login: 'web-everything' } }];
    expect(planNoteComment(note, comments).alreadyPosted).toBe(true);
  });

  // xadixye — comment only when state changes or someone must act (`prComments.mode`).
  it('a status-only note (nobody needs to act) is suppressed: treated as already handled, never posted', () => {
    for (const note of [
      { kind: 'review-label-missing', prNumber: 4381, text: 'open agent PR has no review:* label' },
      { kind: 'stacked-awaiting-base', prNumber: 4462, text: 'PR #4462: stacked on lane/x (PR #4439)' },
    ]) {
      const plan = planNoteComment(note, [], { mode: 'on-change-or-action' });
      expect(plan.alreadyPosted).toBe(true);
      expect(plan.suppressed).toBe('status-only');
    }
  });

  it('mode=all restores the old behaviour for status-only notes', () => {
    const plan = planNoteComment({ kind: 'review-label-missing', prNumber: 4381, text: 'x' }, [], { mode: 'all' });
    expect(plan.alreadyPosted).toBe(false);
    expect(plan.suppressed).toBe(null);
  });

  // PR #4494 review: repeat suppression silenced a recurring escalation (same words, new episode). A note that
  // asks a person to act must post again for every new episode, whatever its visible text.
  it('a recurring escalation (new episode, identical visible text) still posts — never repeat-suppressed', () => {
    const escalations = [
      { kind: 'permission-blocked', prNumber: 7, since: '2026-10-08T01:00:00Z', text: 'fixer denied `rm`' },
      { kind: 'infra-retry-exhausted', prNumber: 7, since: '2026-10-08T01:00:00Z', text: 'infra retry streak capped' },
      { kind: 'liveness-wait-exhausted', prNumber: 7, since: '2026-10-08T01:00:00Z', text: 'liveness wait ran long' },
    ];
    for (const first of escalations) {
      const second = { ...first, since: '2026-10-08T05:00:00Z' };
      const comments = [{ body: buildNoteComment(first), author: { login: 'web-everything' } }];
      expect(noteEpisodeKey(first), first.kind).not.toBe(noteEpisodeKey(second));
      expect(planNoteComment(second, comments, { mode: 'on-change-or-action' }), first.kind)
        .toMatchObject({ alreadyPosted: false, suppressed: null });
    }
  });

  it('every kind whose headline says "needs your decision" is never repeat-suppressed', () => {
    const kinds = ['ci-heal-exhausted', 'awaiting-permission', 'round-cap-exhausted', 'permission-blocked',
      'infra-retry-exhausted', 'session-overrun', 'liveness-wait-exhausted', 'ruling-dispute', 'brand-new-kind'];
    for (const kind of kinds) {
      // An unknown kind is keyed on its own text (same words = same episode, the existing dedup), so its second
      // episode must carry different words; every known kind differs by its key fields alone.
      const first = { kind, prNumber: 3, sessionId: 'a', since: '1', head: 'h1', attempts: 1, cap: 3, text: 'same words' };
      const second = { ...first, sessionId: 'b', since: '2', head: 'h2', attempts: 2, ...(kind === 'brand-new-kind' ? { text: 'same words ' } : {}) };
      expect(noteEpisodeKey(first), kind).not.toBe(noteEpisodeKey(second));
      const comments = [{ body: buildNoteComment(first), author: { login: 'web-everything' } }];
      expect(noteHeadline(first), kind).toMatch(/^needs your decision/);
      expect(planNoteComment(second, comments, { mode: 'on-change-or-action' }).alreadyPosted, kind).toBe(false);
    }
  });

  it('an escalation that needs a person still posts', () => {
    const note = { kind: 'ci-heal-exhausted', prNumber: 9, attempts: 3, cap: 3, text: 'exhausted' };
    expect(planNoteComment(note, [], { mode: 'on-change-or-action' })).toMatchObject({ alreadyPosted: false, suppressed: null });
  });
});

describe('postNoteComment — the IO shell', () => {
  it('shells `gh pr comment <pr> --body <body> --repo <repo>` and reports ok', () => {
    const exec = (file, args) => {
      expect(file).toBe('gh');
      expect(args).toEqual(['pr', 'comment', '10', '--body', 'hello', '--repo', 'web-everything/web-everything']);
      return '';
    };
    expect(postNoteComment({ repo: 'web-everything/web-everything', pr: 10, body: 'hello', exec })).toEqual({ ok: true });
  });

  it('omits --repo when none is given', () => {
    const exec = (file, args) => { expect(args).toEqual(['pr', 'comment', '10', '--body', 'hello']); return ''; };
    expect(postNoteComment({ pr: 10, body: 'hello', exec })).toEqual({ ok: true });
  });

  it('reports ok:false with the error, never throws', () => {
    const exec = () => { throw new Error('gh: rate limited'); };
    expect(postNoteComment({ pr: 10, body: 'hello', exec })).toEqual({ ok: false, error: 'gh: rate limited' });
  });
});
