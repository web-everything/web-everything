/**
 * The orphaned-fix-round guard. Live 2026-10-10, PR #4715: a fix round addressed the findings but was killed before
 * re-arming, the next round was a restack that by design never touched labels, and the PR then sat `review:changes`
 * with no owner. These fixtures are that thread's real comment shapes.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  planOrphanFixRound, runOrphanFixRoundPass, formatOrphanFixRoundLines, buildOrphanGuardComment, verdictReviewedHead,
  ORPHAN_GUARD_MARKER, CHANGES_VERDICT_PREFIX, DEFAULT_ORPHAN_GRACE_MS,
} from '../orphan-fix-round.mjs';
import { FIX_BEGIN_MARKER, FIX_END_MARKER } from '../fix-procedure.mjs';
import { REARM_COMMENT_MARKER } from '../rearm-review.mjs';
import { runFixerStuckReclaimPass, formatFixerStuckReclaimLines } from '../fixer-stuck-reclaim.mjs';

const BOT = { login: 'web-everything' };
const c = (createdAt, body, author = BOT) => ({ createdAt, body, author });
const NOW = Date.parse('2026-10-10T15:48:00Z');
const HEAD = '124e242dac0adc572aaa013a35ff007b8e6f859a';
const VERDICT = c('2026-10-09T22:42:48Z', `${CHANGES_VERDICT_PREFIX}\n\nRecorded by agent.\n\nNet basis: \`0c6c1fb5caf43602aeff444ed5731b4c39e1c1ec..d9829f557f3f264ac885722cb9afef18bd91ca7f\` (rev at review time)`);
const EVIDENCE = c('2026-10-10T11:21:37Z', '## 🔧 conveyor fix — evidence for the `review:changes` round on this PR\n\nFix commit: …');
const BEGIN = c('2026-10-10T15:03:55Z', `${FIX_BEGIN_MARKER}\n\n**Who:** \`fix-4715\``);
const RESTACK = c('2026-10-10T15:21:28Z', '🔁 restack — merged `origin/lane/gh-merge-queue-gate` into this branch.');
const END = c('2026-10-10T15:21:33Z', `${FIX_END_MARKER}\n\n\`fix-4715\` released the fix claim at \`124e242da\`.`);
const pr4715 = (comments, extra = {}) => ({ number: 4715, labels: [{ name: 'review:changes' }, { name: 'review-round:1' }], headRefOid: HEAD, isDraft: false, comments, ...extra });

describe('planOrphanFixRound — the #4715 shapes', () => {
  it('re-arms the live #4715 thread: findings addressed (evidence, head moved), round ended, never re-armed', () => {
    const p = planOrphanFixRound({ pr: pr4715([VERDICT, EVIDENCE, BEGIN, RESTACK, END]), nowMs: NOW });
    expect(p.decision).toBe('rearm');
    expect(p.roundAt).toBe('2026-10-10T15:21:33.000Z');
  });

  it('re-dispatches a restack-only round that never addressed the review', () => {
    const p = planOrphanFixRound({ pr: pr4715([VERDICT, BEGIN, RESTACK, END]), nowMs: NOW });
    expect(p.decision).toBe('redispatch');
    expect(p.reason).toMatch(/no fix evidence/);
  });

  it('a killed round (fix-begin, no fix-end, claim gone) is also an ended round', () => {
    expect(planOrphanFixRound({ pr: pr4715([VERDICT, BEGIN]), nowMs: NOW }).decision).toBe('redispatch');
  });

  it('re-dispatches when evidence exists but the head never moved past the reviewed head', () => {
    const p = planOrphanFixRound({ pr: pr4715([VERDICT, EVIDENCE, END], { headRefOid: 'd9829f557f3f264ac885722cb9afef18bd91ca7f' }), nowMs: NOW });
    expect(p.decision).toBe('redispatch');
  });

  it('escalates after the guard already re-dispatched twice since the verdict', () => {
    const mark = (t) => c(t, `${ORPHAN_GUARD_MARKER} — re-dispatched a fixer\n\n…`);
    const p = planOrphanFixRound({ pr: pr4715([VERDICT, mark('2026-10-10T12:00:00Z'), mark('2026-10-10T14:00:00Z'), BEGIN, END]), nowMs: NOW });
    expect(p.decision).toBe('escalate');
  });

  it.each([
    ['a live claim owns it', { owned: true }, [VERDICT, BEGIN, END], {}],
    ['already re-armed after the verdict', {}, [VERDICT, BEGIN, END, c('2026-10-10T15:22:00Z', `${REARM_COMMENT_MARKER}\n\n…`)], {}],
    ['no fix round since the verdict (the ordinary dispatcher owns it)', {}, [EVIDENCE, VERDICT], {}],
    ['still inside the grace after fix-end', { nowMs: Date.parse(END.createdAt) + DEFAULT_ORPHAN_GRACE_MS - 1 }, [VERDICT, BEGIN, END], {}],
    ['not bounced', {}, [VERDICT, BEGIN, END], { labels: [{ name: 'review:pending' }] }],
    ['draft', {}, [VERDICT, BEGIN, END], { isDraft: true }],
    ['a person owns it (review:human)', {}, [VERDICT, BEGIN, END], { labels: ['review:changes', 'review:human'] }],
  ])('does nothing when %s', (_name, opts, comments, extra) => {
    expect(planOrphanFixRound({ pr: pr4715(comments, extra), nowMs: NOW, ...opts }).decision).toBe('none');
  });

  it('an untrusted author cannot forge the verdict, the evidence or the fix-end', () => {
    const anon = { login: 'drive-by' };
    expect(planOrphanFixRound({ pr: pr4715([c(VERDICT.createdAt, VERDICT.body, anon), BEGIN, END]), nowMs: NOW }).decision).toBe('none');
    expect(planOrphanFixRound({ pr: pr4715([VERDICT, c(EVIDENCE.createdAt, EVIDENCE.body, anon), BEGIN, END]), nowMs: NOW }).decision).toBe('redispatch');
  });

  it('reads the reviewed head off the verdict', () => {
    expect(verdictReviewedHead(VERDICT.body)).toBe('d9829f557f3f264ac885722cb9afef18bd91ca7f');
    expect(verdictReviewedHead('no basis')).toBeNull();
  });
});

describe('runOrphanFixRoundPass — IO shell', () => {
  const repos = [{ key: 'we', slug: 'web-everything/web-everything' }];
  const seams = (comments, over = {}) => ({
    repos, nowMs: NOW, env: {},
    listBounced: () => [{ number: 4715, labels: [{ name: 'review:changes' }], headRefOid: HEAD, isDraft: false }],
    readComments: async () => comments,
    isOwned: async () => false,
    rearm: vi.fn(async () => ({ ok: true })),
    redispatch: vi.fn(async () => ({ ok: true })),
    escalate: vi.fn(async () => ({ ok: true })),
    postComment: vi.fn(),
    ...over,
  });

  it('re-arms #4715 through rearm-review at the observed head and leaves one marker comment', async () => {
    const s = seams([VERDICT, EVIDENCE, BEGIN, RESTACK, END]);
    const r = await runOrphanFixRoundPass(s);
    expect(s.rearm).toHaveBeenCalledWith({ slug: 'web-everything/web-everything', pr: 4715, head: HEAD });
    expect(s.redispatch).not.toHaveBeenCalled();
    expect(r.rows).toEqual([expect.objectContaining({ pr: 4715, decision: 'rearm', result: 're-armed' })]);
    expect(s.postComment.mock.calls[0][0].body.startsWith(`${ORPHAN_GUARD_MARKER} — re-armed for review`)).toBe(true);
    expect(formatOrphanFixRoundLines(r)[0]).toMatch(/^orphan-fix-round: web-everything\/web-everything PR #4715 — rearm → re-armed/);
  });

  it('re-dispatches the restack-only orphan; a refused dispatch posts no marker and is retried next tick', async () => {
    const ok = seams([VERDICT, BEGIN, RESTACK, END]);
    await runOrphanFixRoundPass(ok);
    expect(ok.redispatch).toHaveBeenCalledWith({ slug: 'web-everything/web-everything', pr: 4715 });
    expect(ok.postComment.mock.calls[0][0].body).toMatch(/re-dispatched a fixer/);
    const refused = seams([VERDICT, BEGIN, RESTACK, END], { redispatch: vi.fn(async () => ({ ok: false, why: 'fix-cap: full' })) });
    const r = await runOrphanFixRoundPass(refused);
    expect(r.rows[0].result).toBe('not-done: fix-cap: full');
    expect(refused.postComment).not.toHaveBeenCalled();
  });

  it('WE_ORPHAN_FIX_GUARD=0 reports without acting; an owned PR is never even read', async () => {
    const off = seams([VERDICT, EVIDENCE, BEGIN, END], { env: { WE_ORPHAN_FIX_GUARD: '0' } });
    const r = await runOrphanFixRoundPass(off);
    expect(r.rows[0].result).toMatch(/report-only/);
    expect(off.rearm).not.toHaveBeenCalled();
    const readComments = vi.fn(async () => []);
    const owned = await runOrphanFixRoundPass(seams([], { isOwned: async () => true, readComments }));
    expect(owned.rows).toEqual([]);
    expect(readComments).not.toHaveBeenCalled();
  });

  it('one PR failing never stops the next', async () => {
    const s = seams([VERDICT, EVIDENCE, BEGIN, END], {
      listBounced: () => [{ number: 1, labels: ['review:changes'] }, { number: 4715, labels: ['review:changes'], headRefOid: HEAD }],
      readComments: async (n) => { if (n === 1) throw new Error('gh down'); return [VERDICT, EVIDENCE, BEGIN, END]; },
    });
    const r = await runOrphanFixRoundPass(s);
    expect(r.rows.map((x) => [x.pr, x.result])).toEqual([[1, 'error: gh down'], [4715, 're-armed']]);
  });

  it('the marker comment names what happened and that it is the same round', () => {
    const body = buildOrphanGuardComment({ decision: 'escalate', reason: 'cap reached', prNumber: 4715 });
    expect(body.split('\n')[0]).toBe(`${ORPHAN_GUARD_MARKER} — escalated to a person`);
    expect(body).toMatch(/same review round/);
  });
});

describe('wiring — the fix daemon runs the guard inside its stuck-fixer reclaim step', () => {
  it('appends the guard rows after the reclaim rows and logs them on their own prefix', async () => {
    const orphanPass = vi.fn(async () => ({ enabled: true, rows: [{ repo: 'web-everything/web-everything', pr: 4715, decision: 'rearm', result: 're-armed', reason: 'r' }] }));
    const r = await runFixerStuckReclaimPass({
      env: {}, nowMs: NOW, readEvents: () => [], readAcked: () => new Set(), listClaims: () => [], prHeadFor: () => null,
      stopSession: () => ({}), orphanPass,
    });
    expect(orphanPass).toHaveBeenCalledWith({ env: {}, nowMs: NOW });
    expect(formatFixerStuckReclaimLines(r)).toEqual(['orphan-fix-round: web-everything/web-everything PR #4715 — rearm → re-armed (r)']);
  });

  it('a throwing guard never breaks the reclaim result', async () => {
    const r = await runFixerStuckReclaimPass({
      env: {}, nowMs: NOW, readEvents: () => [], readAcked: () => new Set(), listClaims: () => [], prHeadFor: () => null,
      stopSession: () => ({}), orphanPass: async () => { throw new Error('boom'); },
    });
    expect(r.rows).toEqual([{ kind: 'orphan-fix-round', decision: 'error', reason: 'boom' }]);
  });
});
