// Card xx0055i — automatic takeover at the fix round cap.
import { describe, it, expect } from 'vitest';
import {
  resolveFixSettings, planTakeover, takeoverRung, takeoverMarkers, takeoverMarkerBody, withTakeover, FIX_SETTINGS_FILE,
} from '../fix-takeover.mjs';
import { planReconcile } from '../reconcile-core.mjs';
import { briefWithRoundContext, fixerTableFor } from '../reconcile-fix-dispatch.mjs';
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
const rearm = (i) => ({ author: BOT, createdAt: `2026-10-0${i}T00:00:00Z`, body: '<!-- conveyor-rearm-review -->\n🔁 conveyor re-armed review' });
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
