// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  isDraftOwedPromotion, isPromotionCandidate, promotionStepDue, resolveDraftPromotionSettings,
  DRAFT_PROMOTION_ENV, WITHDRAWN_LABEL,
} from '../draft-promotion-rule.mjs';
import { runDraftPromotionStep, runDraftPromotionIfDue, formatDraftPromotionLines, defaultReadPrView, DRAFT_LIST_FIELDS, PR_VIEW_FIELDS } from '../draft-promotion-loop.mjs';
import { planReconcile } from '../reconcile-core.mjs';
import { enrichPrsWithFixClaims } from '../reconcile-pass.mjs';
import { buildStandDownComment, buildConcurrentAuthorPauseComment, buildLoadFlakeHoldComment } from '../stand-down.mjs';
import { buildOperatorAnswer } from '../stand-down-answer-core.mjs';
import { CONFLICT_LABEL } from '../conflict-label.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/draft-promotion/pr4567-2026-10-09.json', import.meta.url), 'utf8'));
const SHA = 'a'.repeat(40);
const draft = (over = {}) => ({ number: 1, state: 'OPEN', isDraft: true, headRefName: 'lane/x', headRefOid: SHA, labels: [], ...over });
const green = { state: 'green', sha: SHA };
const NOW = Date.parse('2026-10-09T08:00:00Z');
/** What the fresh `gh pr view` returns for a list row `d`: the fields the tick decides on, green on `test`. */
const viewOf = (d, over = {}) => ({
  number: d.number, state: 'OPEN', isDraft: true, headRefName: d.headRefName, headRefOid: d.headRefOid, baseRefName: 'main',
  labels: d.labels ?? [], comments: [], isCrossRepository: false, mergeStateStatus: 'CLEAN', body: '',
  statusCheckRollup: [{ name: 'test', status: 'completed', conclusion: 'success' }], ...over,
});

describe('isDraftOwedPromotion', () => {
  it('owes a green open lane draft', () => {
    expect(isDraftOwedPromotion({ pr: draft(), checks: green }).owed).toBe(true);
  });
  it.each([
    ['not a draft', draft({ isDraft: false }), green],
    ['closed', draft({ state: 'CLOSED' }), green],
    ['a human branch', draft({ headRefName: 'feature/x' }), green],
    ['a fork branch that merely starts with lane/', draft({ isCrossRepository: true }), green],
    ['withdrawn', draft({ labels: [{ name: WITHDRAWN_LABEL }] }), green],
    ['pending checks', draft(), { state: 'pending', sha: SHA }],
    ['red checks', draft(), { state: 'red', sha: SHA }],
    ['checks for another head', draft(), { state: 'green', sha: 'b'.repeat(40) }],
    ['checks not read', draft(), null],
  ])('does not owe it when %s', (_, pr, checks) => {
    expect(isDraftOwedPromotion({ pr, checks }).owed).toBe(false);
  });
  it('candidate pre-filter needs no check read', () => {
    expect(isPromotionCandidate(draft())).toBe(true);
    expect(isPromotionCandidate(draft({ isDraft: false }))).toBe(false);
  });
});

describe('resolveDraftPromotionSettings', () => {
  const read = (obj) => () => JSON.stringify(obj);
  it('missing file → off (before this change)', () => {
    expect(resolveDraftPromotionSettings({}, { read: () => { throw new Error('ENOENT'); } })).toEqual({ loop: false, intervalSeconds: 60 });
  });
  it('the shipped file turns the loop on at 60s', () => {
    expect(resolveDraftPromotionSettings({})).toEqual({ loop: true, intervalSeconds: 60 });
  });
  it('env beats the file; a garbled switch fails off; a too-short interval is ignored', () => {
    const file = read({ draftPromotion: { loop: 'on', intervalSeconds: 90 } });
    expect(resolveDraftPromotionSettings({ [DRAFT_PROMOTION_ENV.loop]: 'off' }, { read: file }).loop).toBe(false);
    expect(resolveDraftPromotionSettings({ [DRAFT_PROMOTION_ENV.loop]: 'maybe' }, { read: file }).loop).toBe(false);
    expect(resolveDraftPromotionSettings({ [DRAFT_PROMOTION_ENV.intervalSeconds]: '3' }, { read: file }).intervalSeconds).toBe(90);
  });
  it('promotionStepDue respects the switch and the interval', () => {
    const settings = { loop: true, intervalSeconds: 60 };
    expect(promotionStepDue({ settings: { ...settings, loop: false }, nowMs: 0 })).toBe(false);
    expect(promotionStepDue({ settings, lastRunAtMs: null, nowMs: 0 })).toBe(true);
    expect(promotionStepDue({ settings, lastRunAtMs: 0, nowMs: 59_999 })).toBe(false);
    expect(promotionStepDue({ settings, lastRunAtMs: 0, nowMs: 60_000 })).toBe(true);
  });
});

describe('replay: #4567/#4563/#4535 green drafts left unpromoted (2026-10-09)', () => {
  const run = (over = {}) => {
    const readied = [];
    const result = runDraftPromotionStep({
      repos: [fixture.repo],
      listDrafts: () => fixture.drafts,
      readHeadCheckState: ({ sha }) => fixture.checksBySha[sha],
      readPrView: ({ prNumber }) => viewOf(fixture.drafts.find((d) => d.number === prNumber)),
      readAgents: () => [],
      readClaim: () => null,
      readRequiredChecks: () => ({ checks: ['test'] }),
      ready: (_repo, pr) => { readied.push(pr); },
      clearAwaiting: () => {},
      now: () => NOW,
      ...over,
    });
    return { result, readied };
  };
  it('promotes every green lane draft in the live snapshot', () => {
    const { readied, result } = run();
    expect(readied.sort()).toEqual([...fixture.expectPromoted].sort());
    expect(result.rows.every((r) => r.action === 'promoted')).toBe(true);
  });
  it('a fresh red read on the head refuses the write (#2811 stale-green)', () => {
    const { readied } = run({ readHeadCheckState: () => ({ state: 'red' }) });
    expect(readied).toEqual([]);
  });
  it('a withdrawal that lands after the list read refuses the write', () => {
    const { readied } = run({ readPrView: ({ prNumber }) => viewOf(fixture.drafts.find((d) => d.number === prNumber), { labels: [{ name: WITHDRAWN_LABEL }] }) });
    expect(readied).toEqual([]);
  });
  it('a failed read or write is a row, never a throw', () => {
    const { result } = run({ ready: () => { throw new Error('boom'); } });
    expect(result.rows.every((r) => r.action === 'error')).toBe(true);
    expect(run({ listDrafts: () => { throw new Error('rate limit'); } }).result.rows[0].action).toBe('error');
  });

  // Review finding (codex-correctness): each read failure must be ONE error row and must not stop the next candidate.
  it.each([
    ['check read', { readHeadCheckState: ({ sha }) => { if (sha === fixture.drafts[0].headRefOid) throw new Error('503'); return fixture.checksBySha[sha]; } }, /check read/],
    ['pr view read', { readPrView: ({ prNumber }) => { if (prNumber === fixture.drafts[0].number) throw new Error('503'); return viewOf(fixture.drafts.find((d) => d.number === prNumber)); } }, /pr view/],
    ['claim read', { readClaim: ({ pr }) => { if (pr === fixture.drafts[0].number) throw new Error('EIO'); return null; } }, /claim/],
  ])('a %s failure on the first candidate is an error row and the later candidates are still promoted', (_, over, why) => {
    const { result, readied } = run(over);
    const first = result.rows.find((r) => r.pr === fixture.drafts[0].number);
    expect(first.action).toBe('error');
    expect(first.why).toMatch(why);
    expect(readied.sort()).toEqual(fixture.expectPromoted.filter((n) => n !== fixture.drafts[0].number).sort());
  });
  it('an unreadable agent listing fails closed for every candidate (a live session may own any of them)', () => {
    const { result, readied } = run({ readAgents: () => { throw new Error('claude agents failed'); } });
    expect(readied).toEqual([]);
    expect(result.rows.every((r) => r.action === 'error' && /agents/.test(r.why))).toBe(true);
  });
  it('the head moving between the list/check read and the fresh view refuses the write', () => {
    const moved = 'c'.repeat(40);
    const { readied, result } = run({ readPrView: ({ prNumber }) => viewOf(fixture.drafts.find((d) => d.number === prNumber), { headRefOid: moved }) });
    expect(readied).toEqual([]);
    expect(result.rows.every((r) => r.action === 'skip' && /head moved/.test(r.why))).toBe(true);
  });
  it('the fresh view asks for the fields the tick decides on, and the list asks for the fork flag', () => {
    for (const f of ['headRefOid', 'comments', 'labels', 'statusCheckRollup', 'isCrossRepository', 'mergeStateStatus', 'baseRefName']) expect(PR_VIEW_FIELDS.split(',')).toContain(f);
    expect(DRAFT_LIST_FIELDS.split(',')).toContain('isCrossRepository');
  });
  it('a rollup at the gh cap of 100 contexts is left to the tick, with a reason that says so', () => {
    const big = Array.from({ length: 100 }, (_, i) => ({ name: `c${i}`, status: 'completed', conclusion: 'success' }));
    const { readied, result } = run({ readPrView: ({ prNumber }) => viewOf(fixture.drafts.find((d) => d.number === prNumber), { statusCheckRollup: big }) });
    expect(readied).toEqual([]);
    expect(result.rows.every((r) => r.action === 'skip' && /truncated/.test(r.why))).toBe(true);
  });
  it('an unknown repo is an error row, never classified under another repo key', () => {
    const { readied, result } = run({ repos: ['someone/else'], listDrafts: () => fixture.drafts });
    expect(readied).toEqual([]);
    expect(result.rows.every((r) => r.action === 'error' && /not a constellation repo/.test(r.why))).toBe(true);
  });
  it('log lines are one bounded line even when the reason carries comment-derived newlines', () => {
    const lines = formatDraftPromotionLines({ rows: [{ repo: 'r', pr: 1, action: 'skip', why: `a\nforged: promoted r PR #9${'x'.repeat(500)}` }] });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/\n/);
    expect(lines[0].length).toBeLessThan(400);
  });
  it('a stalled claim read after a slow agent listing still counts: the claim is read after the agents', () => {
    const order = [];
    run({ readAgents: () => { order.push('agents'); return []; }, readClaim: () => { order.push('claim'); return null; } });
    expect(order.slice(0, 2)).toEqual(['agents', 'claim']);
  });
  it('a fork draft whose branch merely starts with lane/ is never promoted', () => {
    const forkList = fixture.drafts.map((d) => ({ ...d, isCrossRepository: true }));
    const { readied } = run({ listDrafts: () => forkList });
    expect(readied).toEqual([]);
  });
  it('the live fix claim on #4535 (the "fixing" draft) refuses it while the other two are still promoted', () => {
    const { readied } = run({ readClaim: ({ pr }) => (pr === 4535 ? { meta: { who: 'fix-4535', why: 'address review' } } : null) });
    expect(readied.sort()).toEqual([4563, 4567]);
  });
});

// ── PARITY with the tick (review finding on PR #4575) ───────────────────────────────────────────────────────────
// The fast step must never un-draft something `planReconcile` would NOT turn into a `promote-draft`. Every refusal
// that the tick runs BEFORE its `promote-draft` branch is in this matrix; each case first proves the TICK refuses it
// (so a matrix row that stopped reproducing the refusal reddens here), then proves the fast step refuses it too.
describe('parity: the fast step refuses everything the tick refuses before promote-draft', () => {
  const TRUSTED = { login: 'web-everything' };
  const standDown = { id: 'IC_abc', body: buildStandDownComment({ reason: 'needs-judgment', detail: 'a question' }), author: TRUSTED, createdAt: '2026-10-09T05:00:00Z' };
  const closeSuperseded = {
    body: buildOperatorAnswer({ standDownId: 'IC_abc', reason: 'close as superseded', actor: 'chalbert', channel: 'test', disposition: 'close-superseded' }),
    author: { login: 'chalbert' },
  };
  const pause = { body: buildConcurrentAuthorPauseComment({ head: SHA, alt: 'lane/x-alt', altSha: 'd'.repeat(40), detail: 'someone else pushed' }), author: TRUSTED, createdAt: '2026-10-09T07:50:00Z' };
  const liveAgent = { sessionId: 's', cwd: '/lanes/lane-1', pid: 4242, pidAlive: true, state: 'working', laneHeadOid: SHA };
  const base = draft({ number: 7 });

  const MATRIX = [
    ['fix-claimed', { claim: { meta: { who: 'fix-7', why: 'w' } } }, 'refusal'],
    ['stood-down', { comments: [standDown] }, 'refusal'],
    ['concurrent-author-paused', { comments: [pause] }, 'refusal'],
    ['live-process', { agents: [liveAgent] }, 'refusal'],
    ['close-superseded', { comments: [standDown, closeSuperseded] }, 'dispatch'],
  ];

  const tick = ({ comments = [], claim = null, agents = [], labels = [] }) => {
    const view = viewOf(base, { comments, labels: [...base.labels, ...labels.map((name) => ({ name }))] });
    const [pr] = enrichPrsWithFixClaims([view], { repo: 'we', readClaim: () => claim });
    return planReconcile({ repo: 'we', prs: [pr], agents, requiredChecks: ['test'], now: NOW });
  };
  const fast = ({ comments = [], claim = null, agents = [], labels = [] }) => {
    const readied = [];
    const { rows } = runDraftPromotionStep({
      repos: ['web-everything/web-everything'],
      listDrafts: () => [base],
      readHeadCheckState: () => ({ state: 'green' }),
      readPrView: () => viewOf(base, { comments, labels: [...base.labels, ...labels.map((name) => ({ name }))] }),
      readAgents: () => agents,
      readClaim: () => claim,
      readRequiredChecks: () => ({ checks: ['test'] }),
      ready: (_r, n) => readied.push(n),
      clearAwaiting: () => {},
      now: () => NOW,
    });
    return { readied, rows };
  };

  it('control: with none of them present the tick plans promote-draft and the fast step promotes', () => {
    expect(tick({}).dispatch).toEqual([expect.objectContaining({ prNumber: 7, kind: 'promote-draft' })]);
    expect(fast({}).readied).toEqual([7]);
  });
  it.each(MATRIX)('%s: refused by the tick, therefore refused by the fast step', (kind, ctx, where) => {
    const plan = tick(ctx);
    expect(plan.dispatch.some((d) => d.kind === 'promote-draft')).toBe(false);
    if (where === 'refusal') expect(plan.refusals.map((r) => r.kind)).toContain(kind);
    else expect(plan.dispatch.map((d) => d.kind)).toContain(kind);
    const out = fast(ctx);
    expect(out.readied).toEqual([]);
    expect(out.rows).toEqual([expect.objectContaining({ pr: 7, action: 'skip' })]);
  });
  it('already-landed: a merge-conflicting draft is deferred to the tick (the landed check needs git reads, not a fast step)', () => {
    const out = fast({ labels: [CONFLICT_LABEL] });
    expect(out.readied).toEqual([]);
    expect(out.rows[0].why).toMatch(/conflict/);
  });
  it('the matrix covers every refusal/disposition kind the tick runs before promote-draft', () => {
    // Kept in step with reconcile-core.mjs: REFUSAL 1 stood-down, load-flake, REFUSAL 1b fix-claimed, close-superseded,
    // REFUSAL 1c concurrent-author, REFUSAL 4 liveness, already-landed. load-flake is exercised below.
    expect(MATRIX.map(([k]) => k).sort()).toEqual(['close-superseded', 'concurrent-author-paused', 'fix-claimed', 'live-process', 'stood-down']);
  });
  it('a load-flake hold on the draft is refused by the tick and by the fast step', () => {
    const hold = { body: buildLoadFlakeHoldComment({ head: SHA, alt: 'lane/x-alt', altSha: 'd'.repeat(40), detail: 'timeouts under load' }), author: TRUSTED, createdAt: '2026-10-09T07:50:00Z' };
    const plan = tick({ comments: [hold] });
    expect(plan.dispatch.some((d) => d.kind === 'promote-draft')).toBe(false);
    expect(fast({ comments: [hold] }).readied).toEqual([]);
  });
});

describe('defaultReadPrView', () => {
  const base = { number: 1, labels: [], comments: [], isCrossRepository: false };
  const gh = (obj) => () => JSON.stringify(obj);
  it('returns a short thread as read', () => {
    expect(defaultReadPrView({ repoSlug: 'r', prNumber: 1, runGh: gh(base) }).comments).toEqual([]);
  });
  it('re-reads a thread at the list page size complete, and a failed complete read refuses the candidate', () => {
    const page = Array.from({ length: 100 }, (_, i) => ({ body: `c${i}` }));
    const full = [...page, { body: 'the marker on comment 101' }];
    expect(defaultReadPrView({ repoSlug: 'r', prNumber: 1, runGh: gh({ ...base, comments: page }), readComments: () => full }).comments).toHaveLength(101);
    expect(() => defaultReadPrView({ repoSlug: 'r', prNumber: 1, runGh: gh({ ...base, comments: page }), readComments: () => { throw new Error('page 2 failed'); } })).toThrow(/page 2/);
  });
  it.each([
    ['no label list', { ...base, labels: undefined }],
    ['no comment list', { ...base, comments: undefined }],
    ['no fork flag', { ...base, isCrossRepository: undefined }],
  ])('a view with %s is refused rather than read as "nothing there"', (_, obj) => {
    expect(() => defaultReadPrView({ repoSlug: 'r', prNumber: 1, runGh: gh(obj) })).toThrow();
  });
});

describe('runDraftPromotionIfDue (the await-verify child hook)', () => {
  const settings = () => ({ loop: true, intervalSeconds: 60 });
  it('runs when due, then waits out the interval, and dedups repeated skip lines', () => {
    const lines = [];
    const step = () => ({ rows: [{ repo: 'r', pr: 1, action: 'skip', why: 'required checks read pending, not green' }] });
    let s = runDraftPromotionIfDue({ write: (l) => lines.push(l), now: () => 0, resolveSettings: settings, step });
    expect(s.ran).toBe(true);
    s = runDraftPromotionIfDue({ ...s, write: (l) => lines.push(l), now: () => 30_000, resolveSettings: settings, step });
    expect(s.ran).toBe(false);
    s = runDraftPromotionIfDue({ ...s, write: (l) => lines.push(l), now: () => 61_000, resolveSettings: settings, step });
    expect(s.ran).toBe(true);
    expect(lines).toHaveLength(1);
  });
  it('setting off never runs the step; a throwing step never escapes', () => {
    const off = runDraftPromotionIfDue({ write: () => {}, now: () => 0, resolveSettings: () => ({ loop: false, intervalSeconds: 60 }), step: () => { throw new Error('x'); } });
    expect(off.ran).toBe(false);
    const lines = [];
    const on = runDraftPromotionIfDue({ write: (l) => lines.push(l), now: () => 0, resolveSettings: settings, step: () => { throw new Error('x'); } });
    expect(on.ran).toBe(true);
    expect(lines[0]).toMatch(/draft-promotion: error/);
  });
});
