// Card xx0055i — automatic takeover at the fix round cap.
import { describe, it, expect, vi } from 'vitest';
import {
  resolveFixSettings, planTakeover, takeoverRung, takeoverMarkers, takeoverMarkerBody, takeoverVoidMarkerBody, withTakeover,
  FIX_SETTINGS_FILE,
} from '../fix-takeover.mjs';
import { planReconcile } from '../reconcile-core.mjs';
import { REARM_COMMENT_MARKER } from '../rearm-review.mjs';
import { briefWithRoundContext, fixerTableFor, dispatchFix } from '../reconcile-fix-dispatch.mjs';
import { readFileSync } from 'node:fs';

const BOT = { login: 'web-everything' };
const HEAD = 'a'.repeat(40);
const LADDER = {
  policy: { rungs: [
    { id: 'resend', at: 1, action: 'dispatch', taskType: null, provider: 'claude' },
    { id: 'stronger-model', at: 2, action: 'dispatch', taskType: 'ruling-escalation-stronger', provider: 'claude' },
    { id: 'cross-provider', at: 3, action: 'dispatch', taskType: 'ruling-escalation-cross-provider', provider: 'codex' },
    { id: 'human', at: 4, action: 'needs-you' },
  ] },
  routes: { resend: null, 'stronger-model': { provider: 'claude', model: 'opus', effort: 'high' }, 'cross-provider': undefined },
  available: (r) => r.action !== 'dispatch' || r.provider !== 'codex',
};
const marker = (head) => ({ author: BOT, createdAt: '2026-10-10T00:00:00Z', body: takeoverMarkerBody({ pr: 7, head, attempts: 5, cap: 5, rung: { id: 'stronger-model' } }) });

// A bounced PR that has spent 5 of 5 fix rounds (5 rearm markers), the shape #4708 was in.
const rearm = (i) => ({ author: BOT, createdAt: `2026-10-0${i}T00:00:00Z`, body: REARM_COMMENT_MARKER });
function cappedPr(extraComments = []) {
  return {
    number: 7, headRefName: 'lane/x-thing', headRefOid: HEAD, isDraft: false, createdAt: '2026-10-01T00:00:00Z',
    labels: [{ name: 'review:changes' }], statusCheckRollup: [], files: [{ path: 'src/a.mjs' }],
    comments: [{ author: BOT, createdAt: '2026-10-01T00:00:00Z', body: '🔁 review — changes requested\n\n### Findings\n\n**correctness/logic** (1)\n- `src/a.mjs:1` — bad' }, ...extraComments],
  };
}

describe('fix settings cascade (card xx0055i)', () => {
  it('built-in default is takeover + history on + one takeover per PR', () => {
    const s = resolveFixSettings({ env: {}, read: () => { throw new Error('no file'); } });
    expect(s).toMatchObject({ roundCapAction: 'takeover', roundHistory: 'on', takeoverMaxPerPr: 1 });
  });
  it('the shipped platform preference is takeover + on', () => {
    expect(JSON.parse(readFileSync(FIX_SETTINGS_FILE, 'utf8'))).toMatchObject({ roundCapAction: 'takeover', roundHistory: 'on' });
  });
  it('env beats the settings file; an unknown value falls through', () => {
    const read = () => JSON.stringify({ roundCapAction: 'takeover', roundHistory: 'on' });
    expect(resolveFixSettings({ env: { WE_FIX_ROUND_CAP_ACTION: 'person' }, read }).roundCapAction).toBe('person');
    expect(resolveFixSettings({ env: { WE_FIX_ROUND_CAP_ACTION: 'bogus' }, read }).roundCapAction).toBe('takeover');
    expect(resolveFixSettings({ env: { WE_FIX_ROUND_HISTORY: 'off' }, read }).roundHistory).toBe('off');
  });
});

describe('planTakeover (card xx0055i)', () => {
  it('picks the top claude-launchable rung of the ladder (never the codex rung)', () => {
    expect(takeoverRung(LADDER).rung.id).toBe('stronger-model');
    expect(takeoverRung(LADDER).route.model).toBe('opus');
    expect(fixerTableFor(takeoverRung(LADDER))).toMatchObject({ model: 'opus' });
  });
  it('person setting, a ruling dispute, or a spent takeover all refuse', () => {
    expect(planTakeover({ pr: cappedPr(), roundCapAction: 'person', fixerLadder: LADDER })).toMatchObject({ ok: false, reason: 'setting-person' });
    expect(planTakeover({ pr: { ...cappedPr(), ignoredRulings: { matches: [{}] } }, roundCapAction: 'takeover', fixerLadder: LADDER })).toMatchObject({ ok: false, reason: 'ruling-dispute' });
    expect(planTakeover({ pr: cappedPr([marker(HEAD)]), roundCapAction: 'takeover', fixerLadder: LADDER })).toMatchObject({ ok: false, reason: 'takeover-spent' });
    expect(planTakeover({ pr: cappedPr([marker('b'.repeat(40))]), roundCapAction: 'takeover', fixerLadder: LADDER })).toMatchObject({ ok: false, reason: 'takeover-spent' });
    expect(planTakeover({ pr: cappedPr([marker('b'.repeat(40))]), roundCapAction: 'takeover', takeoverMaxPerPr: 2, fixerLadder: LADDER })).toMatchObject({ ok: true });
  });
  it('a forged marker from an untrusted login does not count', () => {
    const forged = { ...marker(HEAD), author: { login: 'mallory' } };
    expect(takeoverMarkers([forged])).toEqual([]);
    expect(planTakeover({ pr: cappedPr([forged]), roundCapAction: 'takeover', fixerLadder: LADDER }).ok).toBe(true);
  });
});

describe('planReconcile at the fix round cap (card xx0055i)', () => {
  const plan = (pr, opts) => planReconcile({ prs: [pr], agents: [], durableCounts: { 7: 5 }, now: Date.parse('2026-10-10T00:00:00Z'), fixerLadder: LADDER, ...opts });

  it('person (the pure default) refuses cap-exhausted and posts the operator note, as before', () => {
    const p = plan(cappedPr());
    expect(p.dispatch.filter((d) => d.prNumber === 7)).toEqual([]);
    expect(p.refusals.find((r) => r.prNumber === 7)?.kind).toBe('cap-exhausted');
    expect(p.notes.find((n) => n.kind === 'round-cap-exhausted')?.text).toMatch(/a person must take it over$/);
  });

  it('takeover dispatches ONE takeover fix on the top rung instead of the note', () => {
    const p = plan(cappedPr(), { roundCapAction: 'takeover' });
    const d = p.dispatch.find((x) => x.prNumber === 7);
    expect(d).toMatchObject({ kind: 'fix', mode: 'takeover', takeover: { attempts: 5, cap: 5, rung: { id: 'stronger-model' } } });
    expect(p.notes.find((n) => n.kind === 'round-cap-exhausted')).toBeUndefined();
  });

  it('after the takeover ran (marker on the thread), the operator is asked, and the note says so', () => {
    const p = plan(cappedPr([marker(HEAD)]), { roundCapAction: 'takeover' });
    expect(p.dispatch.find((x) => x.prNumber === 7)).toBeUndefined();
    expect(p.refusals.find((r) => r.prNumber === 7)).toMatchObject({ kind: 'cap-exhausted', takeover: 'takeover-spent' });
    expect(p.notes.find((n) => n.kind === 'round-cap-exhausted')?.text).toMatch(/takeover already ran/);
  });
});

describe('takeover brief (card xx0055i)', () => {
  it('carries the takeover section, ALL rounds (including the current one), the stacked base, then the brief', () => {
    const comments = [
      { author: BOT, createdAt: '2026-10-01T01:00:00Z', body: `🔁 review — changes requested\n\nRecorded by agent\n\nNet basis: \`${'0'.repeat(40)}..${'1'.repeat(40)}\`\n\n### Findings\n\n**correctness/logic** (1)\n- \`src/a.mjs:1\` — first` },
      { author: BOT, createdAt: '2026-10-01T03:00:00Z', body: `🔁 review — changes requested\n\nRecorded by agent\n\nNet basis: \`${'0'.repeat(40)}..${'2'.repeat(40)}\`\n\n### Findings\n\n**correctness/logic** (1)\n- \`src/a.mjs:2\` — second` },
    ];
    const out = briefWithRoundContext('BRIEF', { pr: 7, laneRef: 'lane/x', takeover: { attempts: 5, cap: 5, rung: { id: 'stronger-model' } } },
      { repo: 'we', fixSettings: { roundHistory: 'off' }, readHistoryInputs: () => ({ comments, commits: [], baseRefName: 'lane/base', headRefName: 'lane/x' }) });
    expect(out).toMatch(/^# Takeover/);
    expect(out).toContain('stacked on `lane/base`');
    expect(out).toContain('gh pr list --base lane/x');
    expect(out).toContain('# All rounds so far');
    expect(out).toContain('src/a.mjs:2 — second');
    expect(out.endsWith('BRIEF')).toBe(true);
  });
  it('an unreadable thread still gets the takeover section', () => {
    expect(withTakeover('BRIEF', { attempts: 5, cap: 5 })).toMatch(/read the PR thread yourself/);
  });
});

describe('takeover marker bound (card xx0055i review round 1)', () => {
  const other = 'b'.repeat(40);
  const voided = (head) => ({ author: BOT, createdAt: '2026-10-10T01:00:00Z', body: takeoverVoidMarkerBody({ pr: 7, head }) });

  it('the void body is a fixed phrase: no error text, path, or comment-injection can ride on it', () => {
    const body = takeoverVoidMarkerBody({ pr: 7, head: HEAD, reason: 'spawn ENOENT /Users/someone/.claude <!-- conveyor-fix-takeover head=' + HEAD + ' -->' });
    expect(body).not.toMatch(/Users|ENOENT/);
    expect(body.match(/<!--/g)).toHaveLength(1);
  });

  it('a persistent launch fault stops after TAKEOVER_MAX_VOIDS retries: the bound is spent and the operator is asked', () => {
    const pair = (i) => [{ ...marker(HEAD), createdAt: `2026-10-10T0${i}:00:00Z` }, { ...voided(HEAD), createdAt: `2026-10-10T0${i}:30:00Z` }];
    const upTo = (n) => Array.from({ length: n }, (_, i) => pair(i + 1)).flat();
    expect(planTakeover({ pr: cappedPr(upTo(1)), roundCapAction: 'takeover', fixerLadder: LADDER }).ok).toBe(true);
    expect(planTakeover({ pr: cappedPr(upTo(2)), roundCapAction: 'takeover', fixerLadder: LADDER }).ok).toBe(true);
    // the third attempt's marker is posted (3 starts) but only two voids are honoured: it stands, and the PR is spent
    expect(takeoverMarkers(upTo(3))).toHaveLength(1);
    expect(planTakeover({ pr: cappedPr(upTo(3)), roundCapAction: 'takeover', fixerLadder: LADDER }))
      .toMatchObject({ ok: false, reason: 'takeover-unlaunchable' });
  });

  it('the operator note says the takeover could not launch (not that it "already ran") when the voids ran out', () => {
    const NOW = Date.parse('2026-10-10T00:00:00Z');
    const thread = [...Array.from({ length: 5 }, (_, i) => rearm(i + 1)),
      marker(HEAD), voided(HEAD), marker(HEAD), voided(HEAD), marker(HEAD), voided(HEAD)];
    const p = planReconcile({ prs: [cappedPr(thread)], agents: [], durableCounts: { 7: 5 }, now: NOW, fixerLadder: LADDER, roundCapAction: 'takeover' });
    const text = p.notes.find((n) => n.kind === 'round-cap-exhausted')?.text ?? '';
    expect(text).toMatch(/could not launch/);
    expect(text).not.toMatch(/already ran/);
  });

  it('refuses the same head while per-PR budget remains (the head guard, not the count, is what refuses)', () => {
    const r = planTakeover({ pr: cappedPr([marker(HEAD)]), roundCapAction: 'takeover', takeoverMaxPerPr: 2, fixerLadder: LADDER });
    expect(r).toMatchObject({ ok: false, reason: 'takeover-spent' });
    // and an abbreviated sha on the marker is the same head
    expect(planTakeover({ pr: cappedPr([marker(HEAD.slice(0, 9))]), roundCapAction: 'takeover', takeoverMaxPerPr: 2, fixerLadder: LADDER }).ok).toBe(false);
  });

  it('a void marker for the same head gives the takeover back; a void for another head, or from an untrusted login, does not', () => {
    expect(takeoverMarkers([marker(HEAD), voided(HEAD)])).toEqual([]);
    expect(planTakeover({ pr: cappedPr([marker(HEAD), voided(HEAD)]), roundCapAction: 'takeover', fixerLadder: LADDER }).ok).toBe(true);
    expect(takeoverMarkers([marker(HEAD), voided(other)])).toHaveLength(1);
    expect(takeoverMarkers([marker(HEAD), { ...voided(HEAD), author: { login: 'mallory' } }])).toHaveLength(1);
    // a void cancels ONE start: two starts and one void leave one
    expect(takeoverMarkers([marker(HEAD), marker(other), voided(HEAD)]).map((m) => m.head)).toEqual([other]);
    // a void on its own is not a start marker
    expect(takeoverMarkers([voided(HEAD)])).toEqual([]);
  });
});

describe('planReconcile takeover call sites and the post-takeover tick (card xx0055i review round 1)', () => {
  const NOW = Date.parse('2026-10-10T00:00:00Z');
  const plan = (pr, opts) => planReconcile({ prs: [pr], agents: [], durableCounts: {}, now: NOW, fixerLadder: LADDER, roundCapAction: 'takeover', requiredChecks: ['gate'], ...opts });
  const green = [{ name: 'gate', status: 'COMPLETED', conclusion: 'SUCCESS' }];
  const rearms = (n) => Array.from({ length: n }, (_, i) => rearm(i + 1));

  it('the takeover is reviewed: with the takeover marker, its own re-arm (cap+1) still owes a review, never cap-exhausted', () => {
    const pending = (comments) => ({ ...cappedPr(comments), labels: [{ name: 'review:pending' }], statusCheckRollup: green });
    const without = plan(pending(rearms(6)));
    expect(without.refusals.find((r) => r.prNumber === 7)).toMatchObject({ kind: 'cap-exhausted', capKind: 'review' });
    const withMarker = plan(pending([...rearms(6), marker(HEAD)]));
    expect(withMarker.dispatch.find((d) => d.prNumber === 7)).toMatchObject({ kind: 'review', attempts: 6, finalReview: true });
    expect(withMarker.refusals.find((r) => r.prNumber === 7)).toBeUndefined();
  });

  it('a voided takeover earns no extra review round', () => {
    const voidedMarker = { author: BOT, createdAt: '2026-10-10T01:00:00Z', body: takeoverVoidMarkerBody({ pr: 7, head: HEAD }) };
    const p = plan({ ...cappedPr([...rearms(6), marker(HEAD), voidedMarker]), labels: [{ name: 'review:pending' }], statusCheckRollup: green });
    expect(p.refusals.find((r) => r.prNumber === 7)).toMatchObject({ kind: 'cap-exhausted', capKind: 'review' });
  });

  it('after the takeover is reviewed and bounces again, the operator is asked (takeover-spent), not a second takeover', () => {
    const p = plan(cappedPr([...rearms(6), marker(HEAD)]));
    expect(p.dispatch.find((d) => d.prNumber === 7)).toBeUndefined();
    expect(p.refusals.find((r) => r.prNumber === 7)).toMatchObject({ kind: 'cap-exhausted', takeover: 'takeover-spent' });
  });

  it('plain bounce site: a takeover row', () => {
    expect(plan(cappedPr(rearms(5))).dispatch.find((d) => d.prNumber === 7)).toMatchObject({ kind: 'fix', mode: 'takeover' });
  });

  it('operator send-back site: never replaced by a takeover — the operator\'s must-fix body reaches a person', () => {
    const sendBack = { id: 'op-send-back', createdAt: '2026-10-09T00:00:00Z', author: { login: 'chalbert' },
      body: '🔁 review — changes requested\n\nRecorded by chalbert via claude-code-chat.\n\nMUST FIX: rename the export.' };
    const red = [{ name: 'gate', status: 'COMPLETED', conclusion: 'FAILURE' }];
    // five repair rounds BEFORE the operator's verdict, none after: the grant is 7 and the durable count is already 7.
    const p = plan({ ...cappedPr([...rearms(5), sendBack]), statusCheckRollup: red }, { durableCounts: { 7: 7 } });
    expect(p.dispatch.filter((d) => d.prNumber === 7 && d.mode === 'takeover')).toEqual([]);
    expect(p.notes.find((n) => n.kind === 'round-cap-exhausted')).toMatchObject({ capKind: 'fix', parkToHuman: true });
  });

  it('block-ruled-referral site: the takeover row carries the blocked referrals', () => {
    const referral = { key: 'k1', finding: { file: 'src/a.mjs', line: 1, summary: 'bad' }, ruling: 'block' };
    const p = plan({ ...cappedPr(rearms(5)), labels: [{ name: 'review:human' }], blockRuledReferrals: [referral] });
    expect(p.dispatch.find((d) => d.prNumber === 7)).toMatchObject({ kind: 'fix', mode: 'takeover', blockRuledReferrals: [referral] });
  });
});

describe('dispatchFix takeover ordering and failure (card xx0055i review round 1)', () => {
  const planned = {
    itemNum: null, pr: 4708, laneRef: 'lane/x', scope: ['we:x'], lane: 3, headRefOid: HEAD,
    mode: 'takeover', takeover: { attempts: 5, cap: 5, rung: { id: 'stronger-model' }, route: null },
  };
  function harness(over = {}) {
    const calls = [];
    const opts = {
      root: '/repo',
      readBrief: () => '{{PR_NUM}} {{ITEM_NUM}} {{LANE}} {{SESSION_SLUG}} {{SCOPE}} {{LANE_REF}}',
      readFixClaim: () => null, acquireClaim: () => ({ ok: true }), claimOwner: 'test-dispatcher',
      releaseClaim: vi.fn(() => { calls.push('release'); }),
      postNotice: vi.fn(), recordAdvisor: vi.fn(), // no real advisor-ledger row for PR 4708
      readHistoryInputs: () => null,
      fixSettings: { roundHistory: 'off' },
      postTakeover: vi.fn(() => { calls.push('marker'); }),
      postTakeoverVoidMark: vi.fn(() => { calls.push('void'); }),
      spawnAgent: vi.fn(() => { calls.push('spawn'); return ''; }),
      mintSessionId: () => 'sid-takeover',
      ...over,
    };
    return { calls, opts };
  }

  it('posts the takeover marker BEFORE the spawn, with the planned head and bound', () => {
    const { calls, opts } = harness();
    dispatchFix(planned, opts);
    expect(calls.indexOf('marker')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('marker')).toBeLessThan(calls.indexOf('spawn'));
    expect(opts.postTakeover).toHaveBeenCalledWith({ repo: 'we', pr: 4708, head: HEAD, takeover: planned.takeover });
    expect(opts.postTakeoverVoidMark).not.toHaveBeenCalled();
  });

  it('does not spawn when the takeover marker post fails: claim released, environment fault, nothing voided', () => {
    const { opts } = harness({ postTakeover: vi.fn(() => { throw Object.assign(new Error('gh down'), { status: 1, stderr: 'HTTP 502' }); }) });
    let err;
    try { dispatchFix(planned, opts); } catch (e) { err = e; }
    expect(opts.spawnAgent).not.toHaveBeenCalled();
    expect(opts.releaseClaim).toHaveBeenCalledTimes(1);
    expect(err.message).toMatch(/^dispatch-env-fault: takeover marker post failed for PR #4708/);
    expect(opts.postTakeoverVoidMark).not.toHaveBeenCalled(); // the marker never went up
  });

  it('voids the marker when the spawn fails AFTER it was posted, so the retry still owns the takeover', () => {
    const { calls, opts } = harness({ spawnAgent: vi.fn(() => { throw new Error('claude --bg failed'); }) });
    expect(() => dispatchFix(planned, opts)).toThrow('claude --bg failed');
    expect(calls).toEqual(['marker', 'release', 'void']);
    expect(opts.postTakeoverVoidMark).toHaveBeenCalledWith({ repo: 'we', pr: 4708, head: HEAD }); // no error text goes to the PR
  });

  it('a void that cannot be posted never masks the spawn failure', () => {
    const { opts } = harness({
      spawnAgent: vi.fn(() => { throw new Error('claude --bg failed'); }),
      postTakeoverVoidMark: vi.fn(() => { throw new Error('gh down'); }),
    });
    expect(() => dispatchFix(planned, opts)).toThrow('claude --bg failed');
  });

  it('an ordinary (non-takeover) fix posts no takeover marker and no void', () => {
    const { opts } = harness({ spawnAgent: vi.fn(() => { throw new Error('boom'); }) });
    expect(() => dispatchFix({ ...planned, mode: undefined, takeover: undefined }, opts)).toThrow('boom');
    expect(opts.postTakeover).not.toHaveBeenCalled();
    expect(opts.postTakeoverVoidMark).not.toHaveBeenCalled();
  });
});
