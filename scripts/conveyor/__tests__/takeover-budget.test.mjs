// Takeover budget — fix.takeoverBudget takeovers per PR, a further one only when the previous one reduced the open
// findings; gate holds never trigger one. Live: #4708 needed a second, operator-approved takeover by hand.
import { describe, it, expect } from 'vitest';
import {
  resolveTakeoverBudget, takeoverEpisodes, takeoverProgress, planTakeover, gateHoldReason, findingWeight,
  notConvergingText, renderPreviousTakeover, OPERATOR_TAKEOVER_PREFIX, TAKEOVER_BUDGET_STANDARD_DEFAULT, isPausedReview,
} from '../takeover-budget.mjs';
import { takeoverMarkerBody, takeoverVoidMarkerBody, withTakeover } from '../fix-takeover.mjs';
import { takeoverReviewGrant } from '../takeover-review.mjs';
import { planReconcile } from '../reconcile-core.mjs';
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
    const repo = () => ({ takeoverBudget: 1 });
    expect(resolveTakeoverBudget({ env: {}, readPlatform: platform, readRepo: none })).toEqual({ value: 3, source: 'platform' });
    expect(resolveTakeoverBudget({ env: {}, readPlatform: platform, readRepo: repo })).toEqual({ value: 1, source: 'repo' });
    expect(resolveTakeoverBudget({ env: { WE_FIX_TAKEOVER_BUDGET: '0' }, readPlatform: platform, readRepo: repo })).toEqual({ value: 0, source: 'env' });
  });
  it('junk skips the layer; the legacy takeoverMaxPerPr name is read when the new one is absent', () => {
    expect(resolveTakeoverBudget({ env: { WE_FIX_TAKEOVER_BUDGET: 'lots' }, readPlatform: none, readRepo: () => ({ takeoverBudget: -1 }) })).toEqual({ value: 2, source: 'standard' });
    expect(resolveTakeoverBudget({ env: {}, readPlatform: none, readRepo: () => ({ takeoverMaxPerPr: 1 }) })).toEqual({ value: 1, source: 'repo' });
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

describe('gateHoldReason', () => {
  it('names the hold, or null for a PR its gate does not hold', () => {
    expect(gateHoldReason(pr(R5, []))).toBeNull();
    expect(gateHoldReason(pr(R5, [], { statusCheckRollup: [{ name: 'test', conclusion: 'FAILURE' }, { name: 'merge-gate', conclusion: 'FAILURE' }] }))).toBeNull();
    expect(gateHoldReason(pr(R5, [], { statusCheckRollup: [{ name: 'review-gate', conclusion: 'FAILURE' }] }))).toBe('review-gate-hold');
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
    expect(planTakeover({ pr: pr(T2, ruled), roundCapAction: 'takeover', takeoverBudget: 2, fixerLadder: LADDER }))
      .toMatchObject({ ok: false, reason: 'takeover-awaiting-review' });
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
  });

  it('after that review returns changes → the operator, with what is still open', () => {
    const judged = [...thread, paused(T2, 11), policyRuling(T2, 12), review(T2, 13, FOUR.slice(1))];
    expect(takeoverReviewGrant({ pr: pr(T2, judged), takeoverReviewAttempts: 1 }).ok).toBe(false);
    const p = plan(pr(T2, judged), { durableCounts: { 7: 6 } });
    expect(p.dispatch.find((x) => x.prNumber === 7)).toBeUndefined();
    expect(p.refusals.find((r) => r.prNumber === 7)).toMatchObject({ kind: 'cap-exhausted', takeover: 'takeover-budget-spent' });
    const note = p.notes.find((n) => n.kind === 'round-cap-exhausted');
    expect(note.text).toMatch(/takeover budget is spent: 2 of 2/);
    expect(note.text).toMatch(/takeover not converging/);
    expect(note.text).toMatch(/still has 4 open finding\(s\)/); // the block-ruled referral + 3 review findings
    expect(note.text).toContain('src/c.mjs:3');
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
