// Takeover budget — fix.takeoverBudget takeovers per PR, a further one only when the previous one reduced the open
// findings; gate holds never trigger one. Live: #4708 needed a second, operator-approved takeover by hand.
import { describe, it, expect } from 'vitest';
import {
  resolveTakeoverBudget, takeoverEpisodes, takeoverProgress, planTakeover, gateHoldReason, findingWeight, openDefects, reviewRounds,
  notConvergingText, renderPreviousTakeover, OPERATOR_TAKEOVER_PREFIX, TAKEOVER_BUDGET_STANDARD_DEFAULT, isPausedReview,
} from '../takeover-budget.mjs';
import { takeoverMarkerBody, takeoverVoidMarkerBody, withTakeover } from '../fix-takeover.mjs';
import { takeoverReviewGrant } from '../takeover-review.mjs';
import { planReconcile as planReconcileWithTiming, ADVISORY_FIX_ROUND_CAP } from '../reconcile-core.mjs';
// This historical fixture exercises the serial policy; new defaults have their own timing suite.
const planReconcile = options => planReconcileWithTiming({ reviewTiming: { startAfter: 'ci-green' }, fixTiming: { joinCiAndReview: false }, ...options });
import { buildAdvisoryFixComment } from '../advisory-fix-mark.mjs';
import { REARM_COMMENT_MARKER } from '../rearm-review.mjs';
import { ADVISORY_NOTE_MARKER } from '../advisory-round-count.mjs';
import { briefWithRoundContext } from '../reconcile-fix-dispatch.mjs';

const BOT = { login: 'web-everything' };
const H = (c) => c.repeat(40);
const R5 = H('5'); // the head round 5 reviewed (before takeover 1)
const T1 = H('6'); // the head takeover 1 pushed
const T2 = H('8'); // the head takeover 2 pushed
const at = (h, m = 0) => `2026-10-10T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;
const LADDER = {
  policy: { rungs: [
    { id: 'resend', at: 1, action: 'dispatch', taskType: null },
    { id: 'stronger-model', at: 2, action: 'dispatch', taskType: 'ruling-escalation-stronger' },
  ] },
  routes: { resend: { provider: 'claude', model: 'sonnet' }, 'stronger-model': { provider: 'claude', model: 'opus' } },
  available: () => true,
};

/** An advisory `changes` verdict on `head` with findings `[file, line, impact]`. */
const review = (head, h, findings) => ({ author: BOT, createdAt: at(h),
  body: `${ADVISORY_NOTE_MARKER} Changes: ${findings.length} finding(s)\n\n**Advisory outcome:** \`changes\`\n\nNet basis: \`${H('0')}..${head}\`\n\n### Findings\n\n`
    + `**correctness/logic** (${findings.length})\n`
    + findings.map(([file, line, impact, claim]) => `- \`${file}:${line}\` — ${claim ?? `defect at ${line}`} — _[CONFIRMED]_ impact if unfixed: ${impact}`).join('\n') });
const marker = (head, h, n = null, budget = null) => ({ author: BOT, createdAt: at(h),
  body: takeoverMarkerBody({ pr: 7, head, attempts: 5, cap: 5, rung: { id: 'stronger-model' }, n, budget }) });
const operatorTakeover = (h) => ({ author: { login: 'chalbert' }, createdAt: at(h), body: `${OPERATOR_TAKEOVER_PREFIX} — all open findings fixed**` });
const rearm = (h) => ({ author: BOT, createdAt: at(h), body: REARM_COMMENT_MARKER });

const FIVE = [['src/a.mjs', 1, 'broken'], ['src/a.mjs', 40, 'broken'], ['src/b.mjs', 9, 'degraded'], ['src/c.mjs', 3, 'degraded'], ['src/d.mjs', 7, 'cosmetic']];
const FOUR = FIVE.slice(1); // takeover fixed one broken finding
const SIX = [...FIVE, ['src/e.mjs', 2, 'broken']]; // takeover made it worse
const rounds5 = [rearm(1), rearm(2), rearm(3), rearm(4), rearm(5), review(R5, 6, FIVE)];

function pr(head, comments, over = {}) {
  return {
    number: 7, headRefName: 'lane/x-thing', headRefOid: head, baseRefName: 'main', isDraft: false, createdAt: at(0),
    labels: [{ name: 'review:changes' }], files: [{ path: 'src/a.mjs' }],
    statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', headSha: head }],
    comments, ...over,
  };
}
const plan = (p, opts = {}) => planReconcile({
  prs: [p], agents: [], durableCounts: { 7: 6 }, now: Date.parse(at(23)), fixerLadder: LADDER, requiredChecks: ['test'],
  roundCapAction: 'takeover', takeoverBudget: 2, takeoverReviewAttempts: 1, ...opts,
});

describe('fix.takeoverBudget cascade', () => {
  const none = () => null;
  it('standard default is 2', () => {
    expect(TAKEOVER_BUDGET_STANDARD_DEFAULT).toBe(2);
    expect(resolveTakeoverBudget({ env: {}, readPlatform: none, readRepo: none })).toEqual({ value: 2, source: 'standard' });
  });
  it('platform preference → repo → env, each layer overriding the one before; the source is named', () => {
    const platform = () => ({ fix: { takeoverBudget: 3 } });
    const repo = () => ({ fix: { takeoverBudget: 1 } });
    expect(resolveTakeoverBudget({ env: {}, readPlatform: platform, readRepo: none })).toEqual({ value: 3, source: 'platform' });
    expect(resolveTakeoverBudget({ env: {}, readPlatform: platform, readRepo: repo })).toEqual({ value: 1, source: 'repo' });
    expect(resolveTakeoverBudget({ env: { WE_FIX_TAKEOVER_BUDGET: '0' }, readPlatform: platform, readRepo: repo })).toEqual({ value: 0, source: 'env' });
  });
  it('junk fails closed to 0 (not the standard); the legacy takeoverMaxPerPr name is read when the new one is absent', () => {
    expect(resolveTakeoverBudget({ env: { WE_FIX_TAKEOVER_BUDGET: 'lots' }, readPlatform: none, readRepo: () => ({ fix: { takeoverBudget: 1 } }) })).toEqual({ value: 0, source: 'env-invalid' });
    expect(resolveTakeoverBudget({ env: {}, readPlatform: none, readRepo: () => ({ fix: { takeoverBudget: -1 } }) })).toEqual({ value: 0, source: 'repo-invalid' });
    expect(resolveTakeoverBudget({ env: {}, readPlatform: none, readRepo: () => ({ fix: { takeoverMaxPerPr: 1 } }) })).toEqual({ value: 1, source: 'repo' });
    // a flat (un-namespaced) key in the repo file is not a setting
    expect(resolveTakeoverBudget({ env: {}, readPlatform: none, readRepo: () => ({ takeoverBudget: 1 }) })).toEqual({ value: 2, source: 'standard' });
  });
  it('the shipped repo setting is the standard budget', () => {
    expect(resolveTakeoverBudget({ env: {}, readPlatform: none }).value).toBe(2);
  });
});

describe('takeover episodes', () => {
  it('an operator takeover comment and the marker for the same takeover (no verdict between) are ONE takeover', () => {
    const eps = takeoverEpisodes([...rounds5, operatorTakeover(7), marker(T1, 8)]);
    expect(eps).toHaveLength(1);
    expect(eps[0].kinds).toEqual(['operator', 'marker']);
  });
  it('a verdict between two takeover signals makes them two takeovers; a voided marker is none', () => {
    expect(takeoverEpisodes([...rounds5, marker(R5, 7), review(T1, 9, FOUR), marker(T1, 10)])).toHaveLength(2);
    const voided = { author: BOT, createdAt: at(7, 30), body: takeoverVoidMarkerBody({ pr: 7, head: R5 }) };
    expect(takeoverEpisodes([...rounds5, marker(R5, 7), voided])).toEqual([]);
  });
});

describe('progress guard', () => {
  it('fewer findings with no heavier total is progress; a heavier total or more findings is not', () => {
    const ep = (comments) => takeoverEpisodes(comments).at(-1);
    const better = [...rounds5, marker(R5, 7), review(T1, 9, FOUR)];
    expect(takeoverProgress(better, ep(better))).toMatchObject({ judged: true, progress: true, before: { count: 5 }, after: { count: 4 } });
    const worse = [...rounds5, marker(R5, 7), review(T1, 9, SIX)];
    expect(takeoverProgress(worse, ep(worse))).toMatchObject({ judged: true, progress: false });
    const same = [...rounds5, marker(R5, 7), review(T1, 9, FIVE)];
    expect(takeoverProgress(same, ep(same)).progress).toBe(false);
    // same count, lighter: a broken finding downgraded to cosmetic
    const lighter = [...rounds5, marker(R5, 7), review(T1, 9, [['src/a.mjs', 1, 'cosmetic'], ...FIVE.slice(1)])];
    expect(takeoverProgress(lighter, ep(lighter)).progress).toBe(true);
    // fewer, but heavier: not progress
    const swap = [...rounds5, marker(R5, 7), review(T1, 9, [['src/a.mjs', 1, 'broken'], ['src/a.mjs', 40, 'broken'], ['src/b.mjs', 9, 'broken'], ['src/z.mjs', 9, 'broken']])];
    expect(takeoverProgress(swap, ep(swap)).progress).toBe(false);
  });
  it('a block ruling outweighs any impact', () => {
    expect(findingWeight({ ruling: 'block', impact: 'cosmetic' })).toBe(4);
    expect(findingWeight({ impact: 'broken' })).toBeGreaterThan(findingWeight({ impact: 'degraded' }));
  });
});

describe('planReconcile with a takeover budget (the four required cases)', () => {
  it('second takeover dispatched when takeover 1 made progress (4 open < 5), on the top rung, with the previous takeover', () => {
    const p = plan(pr(T1, [...rounds5, marker(R5, 7), rearm(8), review(T1, 9, FOUR)]));
    const d = p.dispatch.find((x) => x.prNumber === 7);
    expect(d).toMatchObject({ kind: 'fix', mode: 'takeover', takeover: { n: 2, budget: 2, rung: { id: 'stronger-model' }, previous: { n: 1, before: { count: 5 }, after: { count: 4 } } } });
    expect(d.takeover.previous.startHead).toBe(R5.slice(0, 9));
    expect(d.takeover.previous.reviewedHead).toBe(T1.slice(0, 9));
    expect(p.notes.find((n) => n.kind === 'round-cap-exhausted')).toBeUndefined();
  });

  it('no progress → escalate: no takeover, a "takeover not converging" note that lists the remaining findings', () => {
    const p = plan(pr(T1, [...rounds5, marker(R5, 7), rearm(8), review(T1, 9, SIX)]));
    expect(p.dispatch.find((x) => x.prNumber === 7)).toBeUndefined();
    expect(p.refusals.find((r) => r.prNumber === 7)).toMatchObject({ kind: 'cap-exhausted', takeover: 'takeover-not-converging' });
    const note = p.notes.find((n) => n.kind === 'round-cap-exhausted');
    expect(note).toMatchObject({ takeoverNotConverging: true, parkToHuman: true });
    expect(note.text).toMatch(/takeover not converging/);
    expect(note.text).toMatch(/6 open finding\(s\).*against 5/);
    expect(note.text).toContain('src/e.mjs:2');
  });

  it('budget exhausted → operator, even when the last takeover made progress', () => {
    const thread = [...rounds5, marker(R5, 7), rearm(8), review(T1, 9, FOUR), marker(T1, 10, 2, 2), rearm(11), review(T2, 12, FOUR.slice(1))];
    const p = plan(pr(T2, thread), { durableCounts: { 7: 7 } });
    expect(p.dispatch.find((x) => x.prNumber === 7)).toBeUndefined();
    expect(p.refusals.find((r) => r.prNumber === 7)).toMatchObject({ kind: 'cap-exhausted', takeover: 'takeover-budget-spent' });
    expect(p.notes.find((n) => n.kind === 'round-cap-exhausted')?.text).toMatch(/takeover budget is spent: 2 of 2/);
    // a larger budget would have allowed takeover 3
    expect(plan(pr(T2, thread), { durableCounts: { 7: 7 }, takeoverBudget: 3 }).dispatch.find((x) => x.prNumber === 7)).toMatchObject({ mode: 'takeover', takeover: { n: 3 } });
  });

  it('a gate that holds the PR itself (no open defect) never triggers a takeover, and asks nobody to take it over', () => {
    const R7 = H('7');
    const clean = [...rounds5, rearm(7), review(R7, 8, [])]; // the latest review round has no open finding
    for (const over of [
      { baseRefName: 'lane/dependency' }, // stacked: the dependency PR is not merged yet
      { labels: [{ name: 'review:changes' }, { name: 'review-status:awaiting-base' }] },
      { labels: [{ name: 'review:changes' }, { name: 'review:human' }] },
      { statusCheckRollup: [{ name: 'merge-gate', status: 'COMPLETED', conclusion: 'FAILURE', headSha: R5 }] },
    ]) {
      const p = plan(pr(R7, clean, over), { durableCounts: { 7: 6 } });
      expect(p.dispatch.filter((x) => x.prNumber === 7 && x.mode === 'takeover')).toEqual([]);
      expect(p.refusals.find((r) => r.prNumber === 7)).toMatchObject({ kind: 'gate-hold', takeover: 'gate-hold' });
      expect(p.notes.find((n) => n.kind === 'round-cap-exhausted')).toBeUndefined();
    }
  });

  it('a finding that only names a gate hold is not a defect', () => {
    const holdOnly = [...rounds5, rearm(7), review(H('7'), 8, [['.github/workflows/merge-gate.yml', 1, 'degraded', 'merge-gate red because dependency PR #4700 is not merged']])];
    expect(planTakeover({ pr: pr(H('7'), holdOnly, { baseRefName: 'lane/dep' }), roundCapAction: 'takeover', takeoverBudget: 2, fixerLadder: LADDER }))
      .toMatchObject({ ok: false, reason: 'gate-hold', hold: 'stacked-base-unmerged' });
  });

  it('a defect is a defect whatever the labels: open findings + review:human still get a takeover', () => {
    const p = plan(pr(R5, rounds5, { labels: [{ name: 'review:changes' }, { name: 'review:human' }] }));
    expect(p.dispatch.find((x) => x.prNumber === 7)).toMatchObject({ mode: 'takeover', takeover: { n: 1 } });
  });

  it('a ruling dispute goes to the operator at once, budget or not', () => {
    const r = planTakeover({ pr: { ...pr(T1, [...rounds5, marker(R5, 7), review(T1, 9, FOUR)]), ignoredRulings: { matches: [{}] } }, roundCapAction: 'takeover', takeoverBudget: 2, fixerLadder: LADDER });
    expect(r).toMatchObject({ ok: false, reason: 'ruling-dispute' });
  });

  it('a takeover that pushed but is not judged yet waits for its review (no note, no second takeover)', () => {
    const p = plan(pr(T1, [...rounds5, marker(R5, 7), rearm(8)], { statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', headSha: T1 }] }));
    expect(p.dispatch.find((x) => x.prNumber === 7 && x.mode === 'takeover')).toBeUndefined();
    expect(p.notes.find((n) => n.kind === 'round-cap-exhausted')).toBeUndefined();
  });
});

describe('each takeover head earns one review past the cap', () => {
  it('takeover 2 head gets its own review after takeover 1 already used its one', () => {
    const thread = [...rounds5, marker(R5, 7), rearm(8), review(T1, 9, FOUR), marker(T1, 10, 2, 2), rearm(11)];
    expect(takeoverReviewGrant({ pr: pr(T2, thread), takeoverReviewAttempts: 1 })).toMatchObject({ ok: true, used: 0, takeover: 2 });
    const p = plan(pr(T2, thread, { labels: [{ name: 'review:pending' }] }), { durableCounts: { 7: 7 } });
    expect(p.dispatch.find((x) => x.prNumber === 7)).toMatchObject({ kind: 'review' });
  });
});

describe('any escalation dispatch past the cap earns one review for the head it pushes (#4689)', () => {
  const notice = (h) => ({ author: BOT, createdAt: at(h), body: '⛔ conveyor — ruling not addressed\n\n**Escalation rung 2 (stronger-model):** x' });
  // #4689: the ladder notice goes up, the OLD head is still bounced after it, then the rung-2 fixer pushes T1.
  const thread = [...rounds5, notice(7), review(R5, 8, FIVE), rearm(9)];
  it('the rung-2 head is granted its review; a verdict on the old head between dispatch and push spends nothing', () => {
    expect(takeoverReviewGrant({ pr: pr(T1, thread), takeoverReviewAttempts: 1 })).toMatchObject({ ok: true, used: 0, via: 'escalation-rung' });
    const p = plan(pr(T1, thread, { labels: [{ name: 'review:pending' }] }));
    expect(p.dispatch.find((x) => x.prNumber === 7)).toMatchObject({ kind: 'review' });
  });
  it('once that head is reviewed, the next push is capped again (until the next escalation dispatch)', () => {
    const judged = [...thread, review(T1, 10, FOUR)];
    expect(takeoverReviewGrant({ pr: pr(T2, [...judged, rearm(11)]), takeoverReviewAttempts: 1 })).toMatchObject({ ok: false, reason: 'takeover-review-spent' });
    expect(takeoverReviewGrant({ pr: pr(T2, [...judged, notice(11), rearm(12)]), takeoverReviewAttempts: 1 })).toMatchObject({ ok: true });
  });
  it('an untrusted notice grants nothing', () => {
    expect(takeoverReviewGrant({ pr: pr(T1, [...rounds5, { ...notice(7), author: { login: 'mallory' } }, rearm(9)]), takeoverReviewAttempts: 1 }))
      .toMatchObject({ ok: false, reason: 'no-takeover' });
  });
});

describe('one rule for every round cap', () => {
  it('the review cap leads to a takeover once the head is judged with open defects; an unjudged head does not', () => {
    const judged = [...rounds5, rearm(7), review(T1, 8, FOUR)];
    expect(planTakeover({ pr: pr(T1, judged), roundCapAction: 'takeover', takeoverBudget: 2, fixerLadder: LADDER, capKind: 'review' }))
      .toMatchObject({ ok: true, n: 1 });
    const unjudged = [...rounds5, rearm(7)];
    expect(planTakeover({ pr: pr(T1, unjudged), roundCapAction: 'takeover', takeoverBudget: 2, fixerLadder: LADDER, capKind: 'review' }))
      .toMatchObject({ ok: false, reason: 'review-cap-unjudged' });
  });
});

describe('takeover 2+ brief', () => {
  it('carries the previous takeover diff and the review that rejected it', () => {
    const p = plan(pr(T1, [...rounds5, marker(R5, 7), rearm(8), review(T1, 9, FOUR)]));
    const takeover = p.dispatch.find((x) => x.prNumber === 7).takeover;
    const calls = [];
    const out = briefWithRoundContext('BRIEF', { pr: 7, laneRef: 'lane/x', takeover }, {
      repo: 'we', fixSettings: { roundHistory: 'on' }, readHistoryInputs: () => null,
      readTakeoverDiff: (a) => { calls.push(a); return 'diff --git a/src/a.mjs b/src/a.mjs\n-bad\n+good\n'; },
    });
    expect(calls).toEqual([{ repo: 'we', pr: 7, from: R5.slice(0, 9), to: T1.slice(0, 9) }]);
    expect(out).toMatch(/You are takeover 2 of 2/);
    expect(out).toContain('# Previous takeover (1)');
    expect(out).toContain('src/a.mjs:40');
    expect(out).toContain('+good');
    expect(out.endsWith('BRIEF')).toBe(true);
  });
  it('the diff is bounded and a fence inside it cannot close the block', () => {
    const s = renderPreviousTakeover({ previous: { n: 1, startHead: R5, reviewedHead: T1, remaining: [] }, diffText: `${'x'.repeat(50)}\n\`\`\`\n${'y\n'.repeat(100)}`, maxChars: 80 });
    expect(s).toMatch(/diff cut at 80 chars/);
    expect(s).toMatch(/^````diff$/m); // the fence outruns the ``` inside the diff
    expect(s.match(/^````$/gm)).toHaveLength(1);
  });
  it('takeover 1 keeps the plain section', () => {
    expect(withTakeover('BRIEF', { attempts: 5, cap: 5, n: 1, budget: 2 })).toMatch(/You are the takeover session for this head/);
  });
  it('the marker names the takeover count', () => {
    expect(takeoverMarkerBody({ pr: 7, head: T1, attempts: 6, cap: 5, rung: { id: 'stronger-model' }, n: 2, budget: 2 })).toMatch(/Takeover 2 of 2 was dispatched/);
  });
  it('the not-converging note is bounded', () => {
    const remaining = Array.from({ length: 10 }, (_, i) => ({ file: `f${i}.mjs`, line: i, claim: 'x' }));
    const text = notConvergingText(7, { n: 1, budget: 2, progress: { before: { count: 5, weight: 10 }, after: { count: 10, weight: 20 }, remaining } });
    expect(text).toMatch(/… and 4 more/);
  });
});

describe('only a verdict on the takeover\'s own head judges it (PR #4779 review round 5)', () => {
  const ep = (comments) => takeoverEpisodes(comments).at(-1);
  const plain = (head, comments) => planTakeover({ pr: pr(head, comments), roundCapAction: 'takeover', takeoverBudget: 2, fixerLadder: LADDER });
  it('a delayed old-head verdict cannot authorize another takeover', () => {
    // The review of R5 (the head the takeover started from) lands after the marker, with fewer findings.
    const late = [...rounds5, marker(R5, 7), review(R5, 8, FOUR)];
    expect(takeoverProgress(late, ep(late))).toMatchObject({ judged: false });
    // Still on the start head: the takeover never pushed — the one-per-head bound holds.
    expect(plain(R5, late)).toMatchObject({ ok: false, reason: 'takeover-spent' });
    // It pushed T1: its own review is still owed — no second takeover on an old-head verdict.
    expect(plain(T1, [...late, rearm(9)])).toMatchObject({ ok: false, reason: 'takeover-awaiting-review' });
    expect(plan(pr(T1, [...late, rearm(9)])).dispatch.filter((x) => x.prNumber === 7 && x.mode === 'takeover')).toEqual([]);
    // The old-head review landing AFTER the takeover's push still judges nothing: it names the head reviewed before.
    expect(plain(T1, [...rounds5, marker(R5, 7), rearm(8), review(R5, 9, FOUR)])).toMatchObject({ ok: false, reason: 'takeover-awaiting-review' });
    // The takeover head's own verdict then judges it as usual.
    expect(plain(T1, [...late, rearm(9), review(T1, 10, FOUR.slice(1))])).toMatchObject({ ok: true, n: 2 });
  });
  it('the review grant and the progress guard agree: a delayed old-head review after the push spends no grant (no stall)', () => {
    const thread = [...rounds5, marker(R5, 7), rearm(8), review(R5, 9, FOUR)];
    expect(takeoverReviewGrant({ pr: pr(T1, thread), takeoverReviewAttempts: 1 })).toMatchObject({ ok: true, used: 0 });
    // The takeover head T1 is owed its review, dispatched now — not a silent `takeover-awaiting-review` forever.
    expect(plan(pr(T1, thread, { labels: [{ name: 'review:changes' }] })).dispatch.find((x) => x.prNumber === 7)).toMatchObject({ kind: 'review' });
  });
  it('a manual takeover whose marker names the head it pushed (#4708) still earns a second takeover once judged', () => {
    const thread = [...rounds5, operatorTakeover(7), marker(T1, 8), review(T1, 9, FOUR)];
    expect(plain(T1, thread)).toMatchObject({ ok: true, n: 2 });
  });
  it('no parseable head before the takeover: the automatic marker\'s start head still marks a delayed review as old', () => {
    const headless = [rearm(1), rearm(2), rearm(3), rearm(4), rearm(5), { ...review(R5, 6, FIVE), body: review(R5, 6, FIVE).body.replace(/Net basis:[^\n]*/, '') }];
    // After the push, a delayed review of R5 judges nothing.
    expect(plain(T1, [...headless, marker(R5, 7), rearm(8), review(R5, 9, FOUR)])).toMatchObject({ ok: false, reason: 'takeover-awaiting-review' });
    // No push yet and the PR still on R5: the one-per-head bound holds even though a verdict landed.
    expect(plain(R5, [...headless, marker(R5, 7), review(R5, 8, FOUR)])).toMatchObject({ ok: false, reason: 'takeover-spent' });
  });
  it('a late old-head review after the takeover\'s own review neither hides it (no stall) nor merges into it', () => {
    // P1: the takeover head T1 is reviewed, then a late review of R5 lands — T1's round still judges the takeover.
    const p1 = [...rounds5, marker(R5, 7), rearm(8), review(T1, 9, FOUR), review(R5, 10, FIVE)];
    expect(plain(T1, p1)).toMatchObject({ ok: true, n: 2, previous: { after: { count: 4 } } });
    // P2: the late R5 review lands first; its findings do not merge into T1's round.
    const p2 = [...rounds5, marker(R5, 7), rearm(8), review(R5, 9, FIVE), review(T1, 10, FOUR)];
    expect(plain(T1, p2)).toMatchObject({ ok: true, n: 2, previous: { after: { count: 4 } } });
  });
  it('the open defects are the current head\'s round, never a late old-head round after it', () => {
    const clean = [...rounds5, marker(R5, 7), rearm(8), review(T1, 9, [])];
    const late = [...clean, review(R5, 10, FIVE)];
    expect(openDefects(late, T1)).toMatchObject({ count: 0 });
    // A late old-head review changes nothing: the plan matches the thread without it.
    const strip = (r) => JSON.parse(JSON.stringify(r));
    expect(strip(plain(T1, late))).toEqual(strip(plain(T1, clean)));
    expect(planTakeover({ pr: pr(T1, late), roundCapAction: 'takeover', takeoverBudget: 2, fixerLadder: LADDER, capKind: 'review' }))
      .toMatchObject({ ok: false, reason: 'review-cap-unjudged' });
  });
  it('an old-head review in the middle of the current head\'s round never splits it: each head keeps one round', () => {
    const interleaved = [rearm(1), review(R5, 2, FIVE), rearm(7), review(T1, 8, FOUR), { ...review(R5, 8, [['src/z.mjs', 1, 'cosmetic']]), createdAt: at(8, 20) },
      { ...review(T1, 8, [['src/d.mjs', 7, 'cosmetic']]), createdAt: at(8, 40) }];
    expect(openDefects(interleaved, T1)).toMatchObject({ count: 4 });
    const rounds = reviewRounds(interleaved);
    expect(rounds.map((r) => [r.head, r.findings.length, r.stale])).toEqual([[R5.slice(0, 9), 5, false], [T1.slice(0, 9), 4, false], [R5.slice(0, 9), 1, true]]);
    // In a takeover thread the takeover's round is judged whole (4 open, not the last fragment's 1).
    const thread = [...rounds5, marker(R5, 7), rearm(8), review(T1, 9, FOUR), { ...review(R5, 9, FIVE), createdAt: at(9, 20) },
      { ...review(T1, 9, [['src/d.mjs', 7, 'cosmetic']]), createdAt: at(9, 40) }];
    expect(plain(T1, thread)).toMatchObject({ ok: true, previous: { after: { count: 4 } } });
  });
  it('a late re-review of older post-takeover code never outranks the fresh round that judges the takeover', () => {
    const T3 = H('9');
    const TWO = FOUR.slice(2);
    const thread = [...rounds5, marker(R5, 7), rearm(8), review(T1, 9, FOUR), rearm(10), review(T3, 11, TWO), { ...review(T1, 11, SIX), createdAt: at(11, 30) }];
    expect(plain(T3, thread)).toMatchObject({ ok: true, n: 2, previous: { reviewedHead: T3.slice(0, 9), after: { count: 2 } } });
  });
  it('a headless review never counts as the first review a manual takeover\'s push check compares against', () => {
    const R6 = H('7');
    const headless = { author: BOT, createdAt: at(6, 40), body: '🔁 review — changes requested\n\nRecorded by auto-policy\n\n### Findings\n\n**correctness/logic** (1)\n- `src/q.mjs:1` — bad' };
    const thread = [...rounds5, { ...rearm(6), createdAt: at(6, 30) }, headless, { ...review(R5, 6, FIVE), createdAt: at(6, 45) },
      operatorTakeover(7), marker(R6, 8), review(R6, 9, FOUR)];
    expect(plain(R6, thread)).toMatchObject({ ok: false, reason: 'takeover-spent' });
  });
  it('out-of-order reviews and a reset to an older head never wedge the current head\'s round', () => {
    const R6 = H('7');
    // R6 reviewed, then R5's first-ever review lands late; a rearm; R6 re-reviewed with one finding.
    const late = [rearm(1), review(R6, 2, FOUR), review(R5, 3, FIVE), rearm(4), review(R6, 5, [['src/d.mjs', 7, 'cosmetic']])];
    expect(openDefects(late, R6)).toMatchObject({ count: 1 });
    expect(planTakeover({ pr: pr(R6, late), roundCapAction: 'takeover', takeoverBudget: 2, fixerLadder: LADDER, capKind: 'review' })).toMatchObject({ ok: true });
    // R5, then R6, then the head reset back to R5 and re-reviewed: R5's latest round is current.
    const reset = [rearm(1), review(R5, 2, FIVE), rearm(3), review(R6, 4, FOUR), rearm(5), review(R5, 6, [['src/d.mjs', 7, 'cosmetic']])];
    expect(openDefects(reset, R5)).toMatchObject({ count: 1 });
    expect(planTakeover({ pr: pr(R5, reset), roundCapAction: 'takeover', takeoverBudget: 2, fixerLadder: LADDER, capKind: 'review' })).toMatchObject({ ok: true });
  });
  it('a late old-head review before a manual takeover does not hide the push that made its start head unreviewed', () => {
    const R6 = H('7');
    const thread = [...rounds5, { ...rearm(6), createdAt: at(6, 30) }, { ...review(R5, 6, FIVE), createdAt: at(6, 45) },
      operatorTakeover(7), marker(R6, 8), review(R6, 9, FOUR)];
    expect(plain(R6, thread)).toMatchObject({ ok: false, reason: 'takeover-spent' });
  });
  it('the review cap: a PR head no round names was never reviewed, whatever older round came last', () => {
    const R6 = H('7');
    const thread = [...rounds5, { ...rearm(6), createdAt: at(6, 30) }, review(R5, 7, FOUR)];
    expect(planTakeover({ pr: pr(R6, thread), roundCapAction: 'takeover', takeoverBudget: 2, fixerLadder: LADDER, capKind: 'review' }))
      .toMatchObject({ ok: false, reason: 'review-cap-unjudged' });
    // A head moved with no fixer-turn comment (a rebase) and no review of it: unjudged too.
    expect(planTakeover({ pr: pr(R6, [...rounds5, review(R5, 7, FOUR)]), roundCapAction: 'takeover', takeoverBudget: 2, fixerLadder: LADDER, capKind: 'review' }))
      .toMatchObject({ ok: false, reason: 'review-cap-unjudged' });
  });
  it('a manual takeover started on an unreviewed pushed head and never pushed is spent, judged or not', () => {
    const R6 = H('7');
    // A fixer pushed R6 at 06:30, after round 5's review of R5; the operator then took over on R6.
    const thread = [...rounds5, { ...rearm(6), createdAt: at(6, 30) }, operatorTakeover(7), marker(R6, 8), review(R6, 9, FOUR)];
    expect(plain(R6, thread)).toMatchObject({ ok: false, reason: 'takeover-spent' });
  });
  it('a delayed review of an even older head (reviewed before the takeover) judges nothing either', () => {
    const R4 = H('4');
    const thread = [rearm(1), rearm(2), rearm(3), review(R4, 4, SIX), rearm(5), review(R5, 6, FIVE), marker(R5, 7), rearm(8), review(R4, 9, FOUR)];
    expect(plain(T1, thread)).toMatchObject({ ok: false, reason: 'takeover-awaiting-review' });
  });
  it('a judged takeover whose PR head is still the start head reads as never pushed', () => {
    // A verdict naming another head, but the PR never moved off the head the takeover started from.
    expect(plain(R5, [...rounds5, marker(R5, 7), review(T1, 9, FOUR)])).toMatchObject({ ok: false, reason: 'takeover-spent' });
  });
  it('an operator-only takeover that pushed and is unjudged awaits its review (not "spent")', () => {
    const op = [...rounds5, operatorTakeover(7)];
    expect(plain(T1, [...op, rearm(8)])).toMatchObject({ ok: false, reason: 'takeover-awaiting-review' });
    // Never pushed: still on the reviewed head before it.
    expect(plain(R5, op)).toMatchObject({ ok: false, reason: 'takeover-spent' });
  });
  it('A3: a judged takeover with no measurable before-round is never progress', () => {
    const noBefore = [rearm(1), marker(R5, 7), review(T1, 9, [])];
    expect(takeoverProgress(noBefore, ep(noBefore))).toMatchObject({ judged: true, progress: false, before: { count: 0 } });
    // An unreadable thread (no parseable review round at all) judges nothing.
    const unreadable = [rearm(1), marker(R5, 7), { author: BOT, createdAt: at(9), body: 'not a review' }];
    expect(takeoverProgress(unreadable, ep(unreadable))).toMatchObject({ judged: false });
  });
  it('untrusted takeover signals and verdicts count for nothing', () => {
    const forgedMarker = { ...marker(R5, 7), author: { login: 'mallory' } };
    expect(takeoverEpisodes([...rounds5, forgedMarker, { ...operatorTakeover(8), author: { login: 'mallory' } }])).toEqual([]);
    const forgedVerdict = { ...review(T1, 9, []), author: { login: 'mallory' } };
    const thread = [...rounds5, marker(R5, 7), rearm(8), forgedVerdict];
    expect(takeoverProgress(thread, ep(thread))).toMatchObject({ judged: false });
  });
});

// The LAST takeover's head always earns its one review before the PR goes to the operator (live #4708: takeover 2
// pushed 483aab1e2 with the budget spent; its review PAUSED on two mandatory referrals, the planner read that pause
// as a verdict, told the operator "a person must take it over" and refused the woken re-review as cap-exhausted 6/5).
describe('the last takeover head earns its review even when the budget is spent', () => {
  /** The paused advisory: the review stopped on mandatory referrals awaiting a ruling (no outcome line). */
  const paused = (head, h) => ({ author: BOT, createdAt: at(h),
    body: `${ADVISORY_NOTE_MARKER} Pending: 2 mandatory referral(s) await a ruling\n\n### Awaiting a ruling\n\n1. \`src/a.mjs:40\` (judgeSecurity) — still bad\n\n`
      + `**Verdict:** 🚦 human review required\n\n**Advisory outcome:** \`pending-referral\` — mandatory referrals still need a ruling\n\nNet basis: \`${H('0')}..${head}\`` });
  /** The policy's block ruling on the paused review's referrals (no verdict by itself). */
  const policyRuling = (head, h) => ({ author: BOT, createdAt: at(h),
    body: `## Automatic policy ruling on mandatory referrals\n\nRecorded by policy, for head \`${head}\`.\n\n1. **block** — still bad (run \`review-pr-x\`)` });
  // #4708's shape: takeover 1 (marker) judged with progress, then takeover 2 is an OPERATOR takeover (no marker,
  // so its episode names no head) that pushed T2. Budget 2 is spent.
  const thread = [...rounds5, marker(R5, 7), rearm(8), review(T1, 9, FOUR), operatorTakeover(10)];

  it('budget spent + last takeover head unreviewed → its review is dispatched (no needs-you note)', () => {
    const p = plan(pr(T2, thread, { labels: [{ name: 'review:changes' }, { name: 'review:human' }] }), { durableCounts: { 7: 6 } });
    expect(p.dispatch.find((x) => x.prNumber === 7)).toMatchObject({ kind: 'review', takeoverReview: { ok: true } });
    expect(p.notes.find((n) => n.kind === 'round-cap-exhausted')).toBeUndefined();
    // and the takeover planner itself says the head is awaiting its review, not that the budget is spent
    expect(planTakeover({ pr: pr(T2, thread), roundCapAction: 'takeover', takeoverBudget: 2, fixerLadder: LADDER }))
      .toMatchObject({ ok: false, reason: 'takeover-awaiting-review' });
  });

  it('a review that only PAUSED on referrals is not that head\'s review: once ruled, the woken review is dispatched', () => {
    const ruled = [...thread, paused(T2, 11), policyRuling(T2, 12)];
    expect(takeoverReviewGrant({ pr: pr(T2, ruled), takeoverReviewAttempts: 1 })).toMatchObject({ ok: true, used: 0 });
    const p = plan(pr(T2, ruled, { labels: [{ name: 'review:changes' }, { name: 'review:human' }] }), { durableCounts: { 7: 6 } });
    expect(p.dispatch.find((x) => x.prNumber === 7)).toMatchObject({ kind: 'review' });
    expect(p.notes.find((n) => n.kind === 'round-cap-exhausted')).toBeUndefined();
    // the block rulings already judge the head for the takeover planner, but the grant runs first: the woken review goes
    expect(planTakeover({ pr: pr(T2, ruled), roundCapAction: 'takeover', takeoverBudget: 2, fixerLadder: LADDER }))
      .toMatchObject({ ok: false, reason: 'takeover-budget-spent' });
  });

  it('a paused note is recognised by its outcome line, or by its Pending lead when it has none; a forged one is not', () => {
    expect(isPausedReview(paused(T2, 11))).toBe(true);
    expect(isPausedReview({ ...paused(T2, 11), body: paused(T2, 11).body.replace(/\*\*Advisory outcome:\*\*[^\n]*\n/, '') })).toBe(true);
    expect(isPausedReview({ ...paused(T2, 11), body: `${paused(T2, 11).body}\n**Advisory outcome:** \`changes\`` })).toBe(false);
    expect(isPausedReview({ ...paused(T2, 11), author: { login: 'mallory' } })).toBe(false);
    expect(isPausedReview(review(T2, 11, FOUR))).toBe(false);
  });

  it('bounded: a head whose review paused twice has spent its grant', () => {
    const twice = [...thread, paused(T2, 11), policyRuling(T2, 12), paused(T2, 13)];
    expect(takeoverReviewGrant({ pr: pr(T2, twice), takeoverReviewAttempts: 1 })).toMatchObject({ ok: false, reason: 'takeover-review-spent' });
    // …and the PR then reaches the operator (the block rulings judged the head), never hangs at the round limit
    const p = plan(pr(T2, twice), { durableCounts: { 7: 7 } });
    expect(p.dispatch.find((x) => x.prNumber === 7)).toBeUndefined();
    expect(p.refusals.find((r) => r.prNumber === 7)).toMatchObject({ kind: 'cap-exhausted', takeover: 'takeover-budget-spent' });
    expect(p.notes.find((n) => n.kind === 'round-cap-exhausted')).toMatchObject({ parkToHuman: true });
  });

  it('after that review returns changes → the operator (needs-you)', () => {
    const judged = [...thread, paused(T2, 11), policyRuling(T2, 12), review(T2, 13, FOUR.slice(1))];
    expect(takeoverReviewGrant({ pr: pr(T2, judged), takeoverReviewAttempts: 1 }).ok).toBe(false);
    const p = plan(pr(T2, judged), { durableCounts: { 7: 6 } });
    expect(p.dispatch.find((x) => x.prNumber === 7)).toBeUndefined();
    expect(p.refusals.find((r) => r.prNumber === 7)).toMatchObject({ kind: 'cap-exhausted', takeover: 'takeover-budget-spent' });
    const note = p.notes.find((n) => n.kind === 'round-cap-exhausted');
    expect(note.text).toMatch(/takeover budget is spent: 2 of 2/);
    expect(note.parkToHuman).toBe(true);
  });

  it('after that review accepts → the normal human ceremony: no takeover, no extra review, no needs-you note', () => {
    const accept = { author: BOT, createdAt: at(11), body: `${ADVISORY_NOTE_MARKER} Accept: no blocking findings on this head\n\n**Advisory outcome:** \`accept\`\n\nNet basis: \`${H('0')}..${T2}\`` };
    const accepted = [...thread, accept];
    const p = plan(pr(T2, accepted, { labels: [{ name: 'review:human' }, { name: 'advisory:accepted' }] }), { durableCounts: { 7: 6 } });
    // nothing escalates: no takeover and no takeover-review grant (the parked-PR review path is the ordinary one)
    expect(p.dispatch.filter((x) => x.prNumber === 7 && (x.mode === 'takeover' || x.takeoverReview))).toEqual([]);
    expect(p.refusals.filter((r) => r.prNumber === 7 && r.kind === 'cap-exhausted')).toEqual([]);
    expect(p.notes.find((n) => n.kind === 'round-cap-exhausted')).toBeUndefined();
    expect(takeoverReviewGrant({ pr: pr(T2, accepted), takeoverReviewAttempts: 1 })).toMatchObject({ ok: false, reason: 'head-already-reviewed' });
  });
});

describe('every round cap kind leads to a takeover (A5)', () => {
  it.each(['fix', 'review', 'advisory-fix'])('planTakeover owes a takeover at the %s cap with open defects', (capKind) => {
    const judged = [...rounds5, rearm(7), review(T1, 8, FOUR)];
    expect(planTakeover({ pr: pr(T1, judged), roundCapAction: 'takeover', takeoverBudget: 2, fixerLadder: LADDER, capKind }))
      .toMatchObject({ ok: true, n: 1 });
  });
  it('a review:human PR at the advisory-fix cap with open defects gets a takeover dispatch, not "a person must take it over"', () => {
    const comments = [];
    for (let i = 0; i < ADVISORY_FIX_ROUND_CAP; i += 1) {
      comments.push(review(R5, 2 * i + 1, FIVE));
      comments.push({ author: BOT, createdAt: at(2 * i + 2), body: buildAdvisoryFixComment({}) });
    }
    comments.push(review(R5, 9, FOUR)); // the note the last advisory fix did not clear, on the current head
    const p = pr(R5, comments, { labels: [{ name: 'review:human' }, { name: 'advisory:changes' }] });
    expect(plan(p).dispatch.find((x) => x.prNumber === 7)).toMatchObject({ kind: 'fix', mode: 'takeover', capKind: 'advisory-fix', takeover: { n: 1 } });
    // With the person setting, the same PR is a plain advisory-fix cap refusal.
    expect(plan(p, { roundCapAction: 'person' }).refusals.find((r) => r.prNumber === 7)).toMatchObject({ kind: 'cap-exhausted', capKind: 'advisory-fix' });
  });
});

describe('gateHoldReason', () => {
  it('names the hold, or null for a PR its gate does not hold', () => {
    expect(gateHoldReason(pr(R5, []))).toBeNull();
    expect(gateHoldReason(pr(R5, [], { statusCheckRollup: [{ name: 'test', conclusion: 'FAILURE' }, { name: 'merge-gate', conclusion: 'FAILURE' }] }))).toBeNull();
    expect(gateHoldReason(pr(R5, [], { statusCheckRollup: [{ name: 'review-gate', conclusion: 'FAILURE' }] }))).toBe('review-gate-hold');
  });
});

// PR #4797 review round 5 (security/fail-closed): `gh pr list --json comments` stops at GH_LIST_COMMENT_CAP, so on a
// long thread the takeover markers, voids and verdicts past comment 100 are invisible. The reconcile pass re-reads
// such a thread in full (`pr-comments-complete.mjs`), but any other path (a `--prs-file` snapshot, another planner
// caller) could hand the planner the cut list — and then a spent takeover reads as unspent, so one is re-dispatched
// every tick. A thread of exactly the cap may be cut: every past-cap grant refuses it; a complete re-read is trusted.
describe('a thread cut at the list cap grants no takeover and no takeover review', async () => {
  const { GH_LIST_COMMENT_CAP } = await import('../review-referral-hold.mjs');
  const filler = (n) => Array.from({ length: n }, (_, i) => ({ author: { login: 'someone' }, createdAt: at(0), body: `chatter ${i}` }));
  const cut = (full) => full.slice(0, GH_LIST_COMMENT_CAP);

  it('planTakeover: the cut list hides takeover 1 and its non-converging review, so it would re-run takeover 1', () => {
    const full = [...filler(GH_LIST_COMMENT_CAP - rounds5.length), ...rounds5, marker(R5, 7), rearm(8), review(T1, 9, SIX)];
    const args = { roundCapAction: 'takeover', takeoverBudget: 2, fixerLadder: LADDER };
    expect(planTakeover({ pr: pr(T1, full), ...args })).toMatchObject({ ok: false, reason: 'takeover-not-converging' });
    expect(planTakeover({ pr: pr(T1, cut(full)), ...args })).toMatchObject({ ok: false, reason: 'thread-truncated' });
    // control: a complete thread longer than the cap gets the normal decision (takeover 1 is owed)
    const long = [...filler(GH_LIST_COMMENT_CAP - rounds5.length + 1), ...rounds5];
    expect(planTakeover({ pr: pr(R5, long), ...args })).toMatchObject({ ok: true, n: 1 });
  });

  it('takeoverReviewGrant: the cut list hides the verdict that already judged the takeover head', () => {
    const lead = [...rounds5, marker(R5, 7), rearm(8)];
    const full = [...filler(GH_LIST_COMMENT_CAP - lead.length), ...lead, review(T1, 9, FOUR)];
    expect(takeoverReviewGrant({ pr: pr(T1, full), takeoverReviewAttempts: 1 })).toMatchObject({ ok: false, reason: 'head-already-reviewed' });
    expect(takeoverReviewGrant({ pr: pr(T1, cut(full)), takeoverReviewAttempts: 1 })).toMatchObject({ ok: false, reason: 'thread-truncated' });
    // control: the complete, longer thread with the takeover head not yet judged still earns its one review
    expect(takeoverReviewGrant({ pr: pr(T1, [...filler(GH_LIST_COMMENT_CAP), ...lead]), takeoverReviewAttempts: 1 })).toMatchObject({ ok: true, used: 0 });
  });

  it('planReconcile: a possibly-cut thread decides nothing for the PR (one refusal, no note)', () => {
    const p = plan(pr(R5, [...filler(GH_LIST_COMMENT_CAP - rounds5.length), ...rounds5]));
    expect(p.dispatch.filter((x) => x.prNumber === 7)).toEqual([]);
    expect(p.refusals.filter((r) => r.prNumber === 7).map((r) => r.kind)).toEqual(['thread-truncated']);
    expect(p.notes.filter((n) => n.prNumber === 7 && n.kind === 'round-cap-exhausted')).toEqual([]);
  });

  // Self-review on ae21303e0: every other counter the planner reads off the thread fails OPEN on a cut list — the
  // rearm count reads low (an ordinary fixer is dispatched past the cap), a stand-down past comment 100 is not seen
  // (work is dispatched at a PR a fixer deliberately stood down). One per-PR check covers them all.
  it('planReconcile: a cut list that hides the rearm comments does not read the round cap as unspent', () => {
    const full = [...filler(GH_LIST_COMMENT_CAP), ...rounds5];
    expect(plan(pr(R5, cut(full)), { durableCounts: {} }).dispatch.filter((x) => x.prNumber === 7)).toEqual([]);
    expect(plan(pr(R5, cut(full)), { durableCounts: {} }).refusals.find((r) => r.prNumber === 7)).toMatchObject({ kind: 'thread-truncated' });
  });

  it('planReconcile: a cut list that hides a stand-down dispatches nothing at the stood-down PR', async () => {
    const { buildStandDownComment } = await import('../stand-down.mjs');
    const standDown = { author: BOT, createdAt: at(2), body: buildStandDownComment({ reason: 'needs-judgment' }) };
    const full = [...filler(GH_LIST_COMMENT_CAP), rearm(1), standDown];
    const complete = plan(pr(R5, full, { commentsComplete: true }), { durableCounts: {} });
    expect(complete.dispatch.filter((x) => x.prNumber === 7)).toEqual([]); // control: seen in full, it is terminal
    const p = plan(pr(R5, cut(full)), { durableCounts: {} });
    expect(p.dispatch.filter((x) => x.prNumber === 7)).toEqual([]);
    expect(p.refusals.find((r) => r.prNumber === 7)).toMatchObject({ kind: 'thread-truncated' });
  });

  // The completeness fact comes from the reader that fetched the list, not from its length: a complete re-read of
  // exactly 100 comments is marked and decided normally (no false "possibly cut" refusal or note).
  it('a complete thread of exactly the cap, re-read in full, gets the normal decision', async () => {
    const { enrichPrsWithCompleteComments } = await import('../pr-comments-complete.mjs');
    const thread = [...filler(GH_LIST_COMMENT_CAP - rounds5.length), ...rounds5];
    const [read] = enrichPrsWithCompleteComments([pr(R5, thread)], { readComments: () => thread });
    expect(read.commentsComplete).toBe(true);
    expect(planTakeover({ pr: read, roundCapAction: 'takeover', takeoverBudget: 2, fixerLadder: LADDER })).toMatchObject({ ok: true, n: 1 });
    expect(plan(read).dispatch.find((x) => x.prNumber === 7)).toMatchObject({ kind: 'fix', mode: 'takeover', takeover: { n: 1 } });
  });
});

describe('the same gap raised by two seats counts once', () => {
  const claim = 'Retry budget resets before pending requests finish during background refresh';
  const finding = (line, impact = 'broken', text = claim, file = 'src/j.mjs') => [file, line, impact, text];
  const thread = (findings) => [review(T1, 9, findings)];
  const tally = (findings) => openDefects(thread(findings), T1);

  it('counts the live after-takeover duplicate once and allows the next takeover', () => {
    const before = [finding(20), finding(60, 'broken', 'Worker exits before queued jobs complete')];
    const comments = [...rounds5.slice(0, -1), review(R5, 6, before), marker(R5, 7), rearm(8),
      review(T1, 9, [finding(20), finding(24, 'broken', `${claim} silently`)])];
    expect(openDefects(comments, T1)).toMatchObject({ count: 1, weight: findingWeight({ impact: 'broken' }) });
    const decision = planTakeover({ pr: pr(T1, comments), roundCapAction: 'takeover', takeoverBudget: 2, fixerLadder: LADDER });
    expect(decision.reason).not.toBe('takeover-not-converging');
    expect(decision).toMatchObject({ ok: true, n: 2 });
    expect(plan(pr(T1, comments)).dispatch.find((d) => d.prNumber === 7)).toMatchObject({ mode: 'takeover' });
  });

  it('gives equal count and weight for opposite arrival orders at 20, 22, 30', () => {
    const forward = tally([20, 22, 30].map((line) => finding(line)));
    const reverse = tally([30, 22, 20].map((line) => finding(line)));
    expect({ count: forward.count, weight: forward.weight }).toEqual({ count: reverse.count, weight: reverse.weight });
    expect(forward).toMatchObject({ count: 2, weight: 6 });
  });

  it('compares only kept findings: a bridge at 28 cannot join the gaps at 20 and 36', () => {
    expect(tally([20, 36].map((line) => finding(line)))).toMatchObject({ count: 2, weight: 6 });
    for (const lines of [[20, 28, 36], [36, 28, 20], [20, 36, 28], [28, 20, 36], [28, 36, 20], [36, 20, 28]]) {
      const result = tally(lines.map((line) => finding(line)));
      expect(result).toMatchObject({ count: 2, weight: 6 });
      expect(result.count).toBeGreaterThanOrEqual(2);
    }
  });

  it('keeps the closed Read versus Write authorization path separate', async () => {
    const { sameGapSameHead } = await import('../../lib/jury-core.mjs');
    const read = 'Read handler skips authorization when cached credentials expire';
    const write = read.replace('Read', 'Write');
    expect(sameGapSameHead({ file: 'src/j.mjs', line: 20, summary: read, impactIfUnfixed: 'broken' },
      { file: 'src/j.mjs', line: 24, summary: write, impactIfUnfixed: 'broken' })).toBe(false);
    expect(tally([finding(20, 'broken', read), finding(24, 'broken', write)])).toMatchObject({ count: 2, weight: 6 });
  });

  it('keeps a gate hold separate from the nearby real defect and counts the defect', () => {
    const hold = 'review-gate red because required dependency change is not merged';
    const defect = 'review-gate red because required configuration change is not applied';
    const comments = thread([finding(20, 'broken', hold), finding(24, 'broken', defect)]);
    expect(reviewRounds(comments).at(-1).findings).toHaveLength(2);
    expect(openDefects(comments, T1)).toMatchObject({ count: 1, weight: 3, findings: [{ claim: defect }] });
  });

  it('protects a high-overlap gate hold in both arrival orders', () => {
    const hold = 'review-gate dependency failure leaves background refresh requests pending while retry budget resets before queued workers finish';
    const defect = hold.replace('dependency', 'configuration');
    for (const pair of [[finding(20, 'broken', hold), finding(24, 'broken', defect)], [finding(24, 'broken', defect), finding(20, 'broken', hold)]]) {
      expect(reviewRounds(thread(pair)).at(-1).findings).toHaveLength(2);
      expect(tally(pair)).toMatchObject({ count: 1, weight: 3, findings: [{ claim: defect }] });
    }
  });
  it.each(['Security/logic', 'correctness/Security'])('protects parser lens/category %s in either kept position', (heading) => {
    for (const line of [20, 24]) {
      const comments = [review(T1, 9, [finding(line)]), { ...review(T1, 10, [finding(44 - line)]),
        body: review(T1, 10, [finding(44 - line)]).body.replace('correctness/logic', heading) }];
      expect(openDefects(comments, T1)).toMatchObject({ count: 2, weight: 6 });
      expect(reviewRounds(comments).at(-1).findings).toContainEqual(expect.objectContaining({ lens: heading.split('/')[0], category: heading.split('/')[1] }));
    }
  });

  it.each([
    ['different severity', finding(24, 'degraded'), 5],
    ['different files', finding(24, 'broken', claim, 'src/k.mjs'), 6],
    ['30 lines apart', finding(50), 6],
    ['different negation tokens', finding(24, 'broken', `${claim} without`), 6],
  ])('keeps %s separate', (_name, other, weight) => {
    expect(tally([finding(20), other])).toMatchObject({ count: 2, weight });
  });

  it('folds an ordinary finding and its policy block ruling into one block-weight finding', async () => {
    const { buildOperatorRulingComment } = await import('../../lib/jury-core.mjs');
    const ruling = (line = 20, text = claim, h = 10) => ({ author: BOT, createdAt: at(h), body: buildOperatorRulingComment({
      version: 1, repo: 'test/repo', pr: 7, head: T1, actor: 'auto-policy', channel: 'test',
      reason: 'Required referral is blocked', at: at(10), clearerId: 'policy',
      rulings: [{ runId: 'review-pr-x', key: JSON.stringify(['judgeSecurity', 'src/j.mjs', line, text]), result: 'block' }],
    }) });
    const comments = [...thread([finding(20)]), ruling()];
    expect(reviewRounds(comments).at(-1).findings).toHaveLength(1);
    expect(openDefects(comments, T1)).toMatchObject({ count: 1, weight: findingWeight({ ruling: 'block' }) });
    expect(findingWeight({ ruling: 'block' })).toBe(4);
    for (const h of [8, 10]) expect(reviewRounds([...thread([finding(20)]), ruling(21, 'Unrelated block ruling', h)]).at(-1).findings).toHaveLength(2);
  });

  it('retains MAX_MERGE_FINDINGS + 5 distinct-file findings raw', async () => {
    const { MAX_MERGE_FINDINGS } = await import('../takeover-budget.mjs');
    expect(MAX_MERGE_FINDINGS).toBe(200);
    const findings = Array.from({ length: MAX_MERGE_FINDINGS + 5 }, (_, i) => finding(20, 'broken', claim, `src/gap-${i}.mjs`));
    expect(tally(findings)).toMatchObject({ count: MAX_MERGE_FINDINGS + 5, weight: 3 * (MAX_MERGE_FINDINGS + 5) });
    expect(reviewRounds(thread(findings)).at(-1).overBound).toBe(true);
  });

  it('folds exact duplicates at the bound but fails closed on oversized near-duplicates before or after', async () => {
    const { MAX_MERGE_FINDINGS } = await import('../takeover-budget.mjs');
    expect(MAX_MERGE_FINDINGS).toBe(200);
    const full = Array.from({ length: MAX_MERGE_FINDINGS }, (_, i) => finding(20, 'broken', claim, `src/gap-${i}.mjs`));
    expect(tally([...full, full[0], full[0], full[0]])).toMatchObject({ count: 200, weight: 600 });
    const oversized = [...full, ...full.slice(0, 3).map(([file]) => finding(24, 'broken', claim, file))];
    for (const [before, after] of [[oversized, full], [full, oversized]]) {
      const comments = [review(R5, 6, before), marker(R5, 7), rearm(8), review(T1, 9, after)];
      expect(reviewRounds(comments).find((r) => r.overBound)?.findings).toHaveLength(203);
      expect(takeoverProgress(comments, takeoverEpisodes(comments)[0])).toMatchObject({ judged: true, progress: false, reason: 'merge-bound' });
      const decision = planTakeover({ pr: pr(T1, comments), roundCapAction: 'takeover', takeoverBudget: 2 });
      expect(decision).toMatchObject({ ok: false, reason: 'takeover-not-converging', progress: { reason: 'merge-bound' } });
      expect(notConvergingText(7, decision)).toContain('merge-bound');
    }
  });
});
