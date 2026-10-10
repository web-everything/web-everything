// Card xx0055i — automatic takeover at the fix round cap.
import { describe, it, expect, vi } from 'vitest';
import {
  resolveFixSettings, planTakeover, takeoverRung, takeoverMarkers, takeoverMarkerBody, takeoverVoidMarkerBody, withTakeover,
  launchProvedNotStarted,
  FIX_SETTINGS_FILE,
} from '../fix-takeover.mjs';
import { planReconcile } from '../reconcile-core.mjs';
import { REARM_COMMENT_MARKER } from '../rearm-review.mjs';
import { briefWithRoundContext, fixerTableFor, dispatchFix } from '../reconcile-fix-dispatch.mjs';
import { readDeclaredSettings } from '../../lib/settings-files.mjs';
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
  it('the shipped platform preference is takeover + on, under the `fix` namespace', () => {
    expect(JSON.parse(readFileSync(FIX_SETTINGS_FILE, 'utf8'))).toMatchObject({ fix: { roundCapAction: 'takeover', roundHistory: 'on', takeoverMaxPerPr: 1 } });
  });
  it('the documented `fix.*` paths resolve through the merged settings loader (review round 3)', () => {
    const { settings, owners } = readDeclaredSettings({ legacyPath: null });
    for (const leaf of ['fix.roundCapAction', 'fix.roundHistory', 'fix.takeoverMaxPerPr']) expect(owners[leaf]).toBe('settings/fix.json');
    expect(settings.fix).toMatchObject({ roundCapAction: 'takeover', roundHistory: 'on', takeoverMaxPerPr: 1 });
    // no bare leaf leaks into the global namespace
    for (const leaf of ['roundCapAction', 'roundHistory', 'takeoverMaxPerPr']) expect(owners[leaf]).toBeUndefined();
  });
  it('the resolver reads the `fix` namespace of the file; a flat (un-namespaced) key is not a setting', () => {
    const nested = () => JSON.stringify({ fix: { roundCapAction: 'person', roundHistory: 'off', takeoverMaxPerPr: 3 } });
    expect(resolveFixSettings({ env: {}, read: nested })).toMatchObject({
      roundCapAction: 'person', roundHistory: 'off', takeoverMaxPerPr: 3,
      sources: { roundCapAction: 'settings', roundHistory: 'settings', takeoverMaxPerPr: 'settings' },
    });
    const flat = () => JSON.stringify({ roundCapAction: 'person', roundHistory: 'off', takeoverMaxPerPr: 3 });
    expect(resolveFixSettings({ env: {}, read: flat }).sources).toEqual({ roundCapAction: 'built-in', roundHistory: 'built-in', takeoverMaxPerPr: 'built-in' });
  });
  it('env beats the settings file; an unknown roundHistory falls through', () => {
    const read = () => JSON.stringify({ fix: { roundCapAction: 'takeover', roundHistory: 'on' } });
    expect(resolveFixSettings({ env: { WE_FIX_ROUND_CAP_ACTION: 'person' }, read }).roundCapAction).toBe('person');
    expect(resolveFixSettings({ env: { WE_FIX_ROUND_HISTORY: 'off' }, read }).roundHistory).toBe('off');
    expect(resolveFixSettings({ env: { WE_FIX_ROUND_HISTORY: 'bogus' }, read }).roundHistory).toBe('on');
  });
  it('an invalid roundCapAction fails closed to person (env or file), never the built-in takeover (self-review)', () => {
    const takeoverFile = () => JSON.stringify({ fix: { roundCapAction: 'takeover' } });
    for (const bad of ['bogus', 'persn', 'manual']) {
      expect(resolveFixSettings({ env: { WE_FIX_ROUND_CAP_ACTION: bad }, read: takeoverFile }))
        .toMatchObject({ roundCapAction: 'person', sources: { roundCapAction: 'env-invalid' } });
    }
    for (const bad of ['persn', '', ['person'], false, 1]) {
      expect(resolveFixSettings({ env: {}, read: () => JSON.stringify({ fix: { roundCapAction: bad } }) }))
        .toMatchObject({ roundCapAction: 'person', sources: { roundCapAction: 'settings-invalid' } });
    }
    // a valid value keeps working, case/space-insensitive; blank env and a null/absent key fall through
    expect(resolveFixSettings({ env: { WE_FIX_ROUND_CAP_ACTION: ' Takeover ' }, read: () => '{}' }).roundCapAction).toBe('takeover');
    expect(resolveFixSettings({ env: { WE_FIX_ROUND_CAP_ACTION: ' ' }, read: () => JSON.stringify({ fix: { roundCapAction: 'person' } }) }).roundCapAction).toBe('person');
    expect(resolveFixSettings({ env: {}, read: () => JSON.stringify({ fix: { roundCapAction: null } }) }).sources.roundCapAction).toBe('built-in');
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
  it('takeoverMaxPerPr <= 0 (or not a number) is `setting-disabled`, never `takeover-spent` (review round 3)', () => {
    for (const max of [0, -1, null, Number.NaN, 'x']) {
      expect(planTakeover({ pr: cappedPr(), roundCapAction: 'takeover', takeoverMaxPerPr: max, fixerLadder: LADDER }))
        .toMatchObject({ ok: false, reason: 'setting-disabled' });
    }
    // the setting is read through the env layer as 0 too
    expect(resolveFixSettings({ env: { WE_FIX_TAKEOVER_MAX_PER_PR: '0' }, read: () => '{}' }).takeoverMaxPerPr).toBe(0);
  });
  it('a present but invalid takeover limit fails closed to 0 (file or env), never the built-in 1 (self-review)', () => {
    for (const bad of [-1, 'off', 100, false, '1.5']) {
      const file = () => JSON.stringify({ fix: { takeoverMaxPerPr: bad } });
      expect(resolveFixSettings({ env: {}, read: file })).toMatchObject({ takeoverMaxPerPr: 0, sources: { takeoverMaxPerPr: 'settings-invalid' } });
      const ok = () => JSON.stringify({ fix: { takeoverMaxPerPr: 2 } });
      expect(resolveFixSettings({ env: { WE_FIX_TAKEOVER_MAX_PER_PR: String(bad) }, read: ok })).toMatchObject({ takeoverMaxPerPr: 0, sources: { takeoverMaxPerPr: 'env-invalid' } });
    }
    // types are checked, not stringified: an empty string, an array or 1.5 in the file is invalid, not absent or 3
    for (const bad of ['', [3], ['5'], 1.5, {}]) {
      expect(resolveFixSettings({ env: {}, read: () => JSON.stringify({ fix: { takeoverMaxPerPr: bad } }) }))
        .toMatchObject({ takeoverMaxPerPr: 0, sources: { takeoverMaxPerPr: 'settings-invalid' } });
    }
    expect(resolveFixSettings({ env: {}, read: () => JSON.stringify({ fix: { takeoverMaxPerPr: '2' } }) }).takeoverMaxPerPr).toBe(2);
    // absent / blank layers still fall through
    expect(resolveFixSettings({ env: { WE_FIX_TAKEOVER_MAX_PER_PR: '  ' }, read: () => JSON.stringify({ fix: { takeoverMaxPerPr: 2 } }) }).takeoverMaxPerPr).toBe(2);
    expect(resolveFixSettings({ env: {}, read: () => JSON.stringify({ fix: {} }) }).takeoverMaxPerPr).toBe(1);
    // and the resolved 0 reaches the planner as `setting-disabled`
    const s = resolveFixSettings({ env: { WE_FIX_TAKEOVER_MAX_PER_PR: 'off' }, read: () => '{}' });
    expect(planTakeover({ pr: cappedPr(), roundCapAction: 'takeover', takeoverMaxPerPr: s.takeoverMaxPerPr, fixerLadder: LADDER })).toMatchObject({ reason: 'setting-disabled' });
  });
  it('the operator note for a disabled takeover says it is turned off, not that it already ran', () => {
    const NOW = Date.parse('2026-10-10T00:00:00Z');
    const thread = Array.from({ length: 5 }, (_, i) => rearm(i + 1));
    const p = planReconcile({ prs: [cappedPr(thread)], agents: [], durableCounts: { 7: 5 }, now: NOW, fixerLadder: LADDER, roundCapAction: 'takeover', takeoverMaxPerPr: 0 });
    expect(p.dispatch.filter((d) => d.mode === 'takeover')).toEqual([]);
    const text = p.notes.find((n) => n.kind === 'round-cap-exhausted')?.text ?? '';
    expect(text).toMatch(/turned off/);
    expect(text).not.toMatch(/already ran/);
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
      .toMatchObject({ ok: false, reason: 'takeover-void-limit' });
  });

  it('a void cancels only a start that PRECEDES it: a later retry for the same head keeps its own marker', () => {
    const at = (c, t) => ({ ...c, createdAt: `2026-10-10T${t}:00Z` });
    // start(07) → void(08) → retry start(10): the void belongs to the 07 start; the 10:00 retry stands
    const thread = [at(marker(HEAD), '07:00'), at(voided(HEAD), '08:00'), at(marker(HEAD), '10:00')];
    expect(takeoverMarkers(thread).map((m) => m.at)).toEqual(['2026-10-10T10:00:00Z']);
    // a void with no earlier start cancels nothing (it must not eat a later start)
    expect(takeoverMarkers([at(voided(HEAD), '08:00'), at(marker(HEAD), '10:00')])).toHaveLength(1);
    // an `unknown`-head void likewise only reaches an earlier `unknown` start
    const unknownMarker = at({ ...marker(HEAD), body: takeoverMarkerBody({ pr: 7, head: null, attempts: 5, cap: 5 }) }, '10:00');
    const unknownVoid = at({ ...voided(HEAD), body: takeoverVoidMarkerBody({ pr: 7, head: null }) }, '08:00');
    expect(takeoverMarkers([unknownVoid, unknownMarker])).toHaveLength(1);
  });

  it('a trusted comment that merely QUOTES a marker is not one (the match is anchored at the start of the body)', () => {
    const quoted = { author: BOT, createdAt: '2026-10-10T00:00:00Z', body: `summary of the takeover:\n${takeoverMarkerBody({ pr: 7, head: HEAD, attempts: 5, cap: 5 })}` };
    const quotedVoid = { author: BOT, createdAt: '2026-10-10T00:00:00Z', body: `quoting: ${takeoverVoidMarkerBody({ pr: 7, head: HEAD })}` };
    expect(takeoverMarkers([quoted])).toEqual([]);
    expect(takeoverMarkers([marker(HEAD), quotedVoid])).toHaveLength(1);
  });

  it('launchProvedNotStarted: only a failure that cannot have started a session; a timeout or kill is indeterminate', () => {
    expect(launchProvedNotStarted(Object.assign(new Error('x'), { status: 1 }))).toBe(true);
    expect(launchProvedNotStarted(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(true);
    expect(launchProvedNotStarted(Object.assign(new Error('x'), { code: 'ETIMEDOUT', signal: 'SIGKILL', status: null }))).toBe(false);
    expect(launchProvedNotStarted(Object.assign(new Error('x'), { status: 1, signal: 'SIGKILL' }))).toBe(false);
    expect(launchProvedNotStarted(new Error('no exit information'))).toBe(false);
    expect(launchProvedNotStarted(null)).toBe(false);
  });

  it('the operator note names launch faults (not that it "already ran") when the voids ran out', () => {
    const NOW = Date.parse('2026-10-10T00:00:00Z');
    const thread = [...Array.from({ length: 5 }, (_, i) => rearm(i + 1)),
      marker(HEAD), voided(HEAD), marker(HEAD), voided(HEAD), marker(HEAD), voided(HEAD)];
    const p = planReconcile({ prs: [cappedPr(thread)], agents: [], durableCounts: { 7: 5 }, now: NOW, fixerLadder: LADDER, roundCapAction: 'takeover' });
    const text = p.notes.find((n) => n.kind === 'round-cap-exhausted')?.text ?? '';
    expect(text).toMatch(/launch faults/);
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

  describe('a takeover that started ABOVE the cap still owes its own final review (red-team round 2)', () => {
    const pending = (comments) => ({ ...cappedPr(comments), labels: [{ name: 'review:pending' }], statusCheckRollup: green });
    const markerAt = (attempts, head = HEAD) => ({ author: BOT, createdAt: '2026-10-10T00:00:00Z', body: takeoverMarkerBody({ pr: 7, head, attempts, cap: 5, rung: { id: 'stronger-model' } }) });
    const reviewRow = (p) => p.dispatch.find((d) => d.prNumber === 7);
    const refusal = (p) => p.refusals.find((r) => r.prNumber === 7);

    it('started at 6/5: its re-arm makes 7, and that is reviewed (allowance is relative to the launch count, not the cap)', () => {
      const p = plan(pending([...rearms(7), markerAt(6)]));
      expect(reviewRow(p)).toMatchObject({ kind: 'review', attempts: 7 });
      expect(refusal(p)).toBeUndefined();
    });

    it('started at 7/5 (counts can run further ahead than one): still exactly one round past its launch count', () => {
      const p = plan(pending([...rearms(8), markerAt(7)]));
      expect(reviewRow(p)).toMatchObject({ kind: 'review', attempts: 8 });
    });

    it('but only ONE round past the launch count: a further re-arm is refused', () => {
      const p = plan(pending([...rearms(8), markerAt(6)]));
      expect(refusal(p)).toMatchObject({ kind: 'cap-exhausted', capKind: 'review' });
    });

    it('a marker with no launch count (older shape) keeps the cap+1 allowance', () => {
      const legacy = { author: BOT, createdAt: '2026-10-10T00:00:00Z', body: takeoverMarkerBody({ pr: 7, head: HEAD, cap: 5, rung: { id: 'stronger-model' } }) };
      expect(reviewRow(plan(pending([...rearms(6), legacy])))).toMatchObject({ kind: 'review', attempts: 6 });
      expect(refusal(plan(pending([...rearms(7), legacy])))).toMatchObject({ kind: 'cap-exhausted', capKind: 'review' });
    });

    it('a voided takeover earns nothing even when its marker carried a high launch count', () => {
      const voidedMarker = { author: BOT, createdAt: '2026-10-10T01:00:00Z', body: takeoverVoidMarkerBody({ pr: 7, head: HEAD }) };
      const p = plan(pending([...rearms(7), markerAt(6), voidedMarker]));
      expect(refusal(p)).toMatchObject({ kind: 'cap-exhausted', capKind: 'review' });
    });

    it('a forged marker (untrusted login) claiming a huge launch count grants nothing', () => {
      const forged = { author: { login: 'stranger' }, createdAt: '2026-10-10T00:00:00Z', body: takeoverMarkerBody({ pr: 7, head: HEAD, attempts: 900, cap: 5, rung: {} }) };
      expect(refusal(plan(pending([...rearms(7), forged])))).toMatchObject({ kind: 'cap-exhausted', capKind: 'review' });
    });

    it('the launch count round-trips through the marker (and a garbage count is not read)', () => {
      expect(takeoverMarkers([markerAt(6)])).toMatchObject([{ head: HEAD, attempts: 6 }]);
      const garbage = { author: BOT, createdAt: '2026-10-10T00:00:00Z', body: `<!-- conveyor-fix-takeover head=${HEAD} attempts=-3 -->` };
      expect(takeoverMarkers([garbage])).toMatchObject([{ head: HEAD, attempts: null }]);
    });
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
    const { calls, opts } = harness({ spawnAgent: vi.fn(() => { throw Object.assign(new Error('claude --bg failed'), { status: 1 }); }) });
    expect(() => dispatchFix(planned, opts)).toThrow('claude --bg failed');
    expect(calls).toEqual(['marker', 'void', 'release']); // the void goes up BEFORE the claim is released
    expect(opts.postTakeoverVoidMark).toHaveBeenCalledWith({ repo: 'we', pr: 4708, head: HEAD }); // no error text goes to the PR
  });

  it('a launch TIMEOUT is indeterminate (the session may be live): the marker stands, no void, so no second takeover starts', () => {
    const timeout = Object.assign(new Error('spawnSync claude ETIMEDOUT'), { code: 'ETIMEDOUT', signal: 'SIGKILL', status: null });
    const { calls, opts } = harness({ spawnAgent: vi.fn(() => { throw timeout; }) });
    expect(() => dispatchFix(planned, opts)).toThrow('ETIMEDOUT');
    expect(calls).toEqual(['marker', 'release']);
    expect(opts.postTakeoverVoidMark).not.toHaveBeenCalled();
  });

  it('a failure BEFORE any launch call ran (no agent can exist) voids even without exit information', () => {
    const { calls, opts } = harness({ mintSessionId: () => { throw new Error('no session id'); } });
    expect(() => dispatchFix(planned, opts)).toThrow('no session id');
    expect(opts.spawnAgent).not.toHaveBeenCalled();
    expect(calls).toEqual(['marker', 'void', 'release']);
  });

  it('a void that cannot be posted never masks the spawn failure', () => {
    const { opts } = harness({
      spawnAgent: vi.fn(() => { throw Object.assign(new Error('claude --bg failed'), { status: 1 }); }),
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
