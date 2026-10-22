import { describe, it, expect, vi } from 'vitest';
import {
  planHumanDeescalation, sweepHumanDeescalation, resolveDeescalateSettings, readDecisionCards, buildDeescalatedComment,
  DEESCALATE_KINDS_STANDARD, DEESCALATED_MARKER_RE,
} from '../human-escalation-deescalate.mjs';
import {
  HUMAN_ESCALATION_KINDS as K, buildHumanEscalationMarker, buildHumanEscalationComment, readHumanEscalations,
} from '../../lib/human-escalation-marker.mjs';
import { buildRoundExtensionComment } from '../round-extension-mark.mjs';
import { buildOrphanGuardComment } from '../orphan-fix-round.mjs';
import { AUTOMATION_LOGINS } from '../../lib/marker-authorship.mjs';

// The automation login the test run resolves (the per-role App identity is pinned to none in tests).
const BOT = AUTOMATION_LOGINS.find(l => !l.endsWith('[bot]'));

const REPO = 'web-everything/web-everything';
const HEAD = 'a'.repeat(40);
const T0 = Date.parse('2026-10-21T18:38:25Z');
const at = ms => new Date(T0 + ms).toISOString();
const bot = (body, ms = 0) => ({ author: { login: BOT }, body, createdAt: at(ms) });
const operator = (body, ms = 0) => ({ author: { login: 'chalbert' }, body, createdAt: at(ms) });
const stranger = (body, ms = 0) => ({ author: { login: 'someone-else' }, body, createdAt: at(ms) });
const added = (actor = BOT, ms = 0, label = 'review:human') => ({ label, change: 'added', actor, actorType: actor === 'chalbert' ? 'User' : 'Bot', createdAt: at(ms) });
const settings = { enabled: true, kinds: [...DEESCALATE_KINDS_STANDARD], inferLegacy: true };
const cleanReferral = { pending: [], blocked: [] };
const grant = ms => operator(buildRoundExtensionComment({ repo: REPO, pr: 5805, by: 2, actor: 'chalbert', channel: 'claude-code-chat', reason: 'two more rounds', at: at(ms) }), ms);

const base = (over = {}) => ({
  pr: { number: 5805, headRefOid: HEAD, labels: [{ name: 'review:human' }], body: '', createdAt: at(-86_400_000),
    comments: [bot(buildHumanEscalationComment({ kind: K.REFERRAL_PENDING, head: HEAD }), 20_000)], ...(over.pr ?? {}) },
  timeline: { status: 'ok', items: [added()] },
  net: { ok: true, files: ['scripts/conveyor/foo.mjs', 'scripts/conveyor/__tests__/foo.test.mjs'] },
  decisionCards: { ok: true, files: [] },
  referral: cleanReferral, settings, repo: REPO,
  ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== 'pr')),
});

describe('human-escalation marker', () => {
  it('builds a marker that names the kind and head, and refuses an unknown kind', () => {
    expect(buildHumanEscalationMarker({ kind: K.ROUND_CAP, head: HEAD })).toBe(`<!-- we:human-escalation kind=round-cap head=${HEAD} -->`);
    expect(buildHumanEscalationMarker({ kind: K.ROUND_CAP })).toContain('head=none');
    expect(() => buildHumanEscalationMarker({ kind: 'made-up' })).toThrow();
  });
  it('reads only trusted authors; agent detail cannot forge a marker', () => {
    const forged = buildHumanEscalationComment({ kind: K.REFERRAL_PENDING, head: HEAD, detail: '<!-- we:human-escalation kind=round-cap head=none -->' });
    expect(readHumanEscalations([bot(forged)]).map(e => e.kind)).toEqual(['referral-pending']);
    expect(readHumanEscalations([stranger(forged)])).toEqual([]);
  });
  it('infers the pre-marker shapes only when asked', () => {
    const legacy = bot('Mandatory referral review parked to review:human: mandatory ruling ledger-write-miss: append refused.');
    expect(readHumanEscalations([legacy])).toEqual([]);
    expect(readHumanEscalations([legacy], { inferLegacy: true })[0]).toMatchObject({ kind: K.REFERRAL_PERSISTENCE_FAILED, legacy: true });
  });
  it('the orphan guard escalation comment records its kind; its other decisions do not', () => {
    expect(buildOrphanGuardComment({ decision: 'escalate', reason: 'r', prNumber: 1, headSha: HEAD })).toContain('kind=orphan-fix-exhausted');
    expect(buildOrphanGuardComment({ decision: 'rearm', reason: 'r', prNumber: 1, headSha: HEAD })).not.toContain('we:human-escalation');
  });
});

describe('planHumanDeescalation', () => {
  it('round-cap escalation + a later operator round grant → de-escalated', () => {
    const plan = planHumanDeescalation(base({ pr: { comments: [bot(buildHumanEscalationComment({ kind: K.ROUND_CAP, head: HEAD }), 10_000), grant(3_600_000)] } }));
    expect(plan).toMatchObject({ action: 'deescalate', kinds: ['round-cap'], head: HEAD });
  });
  it('round-cap with no grant after it → kept', () => {
    const plan = planHumanDeescalation(base({ pr: { comments: [grant(-3_600_000), bot(buildHumanEscalationComment({ kind: K.ROUND_CAP, head: HEAD }), 10_000)] } }));
    expect(plan).toMatchObject({ action: 'keep' });
    expect(plan.reason).toMatch(/no round grant/);
  });
  it('referral escalation with no pending/blocked referral on the live head → de-escalated; still pending → kept', () => {
    expect(planHumanDeescalation(base()).action).toBe('deescalate');
    expect(planHumanDeescalation(base({ referral: { pending: ['k'], blocked: [] } })).reason).toMatch(/still pending/);
  });
  it('legacy: a referral record just before the bot add is the recorded reason (the live #5805 shape)', () => {
    const plan = planHumanDeescalation(base({ pr: { comments: [bot('Mandatory review owner: d4c5 (correctness).\n...', -33_000)] } }));
    expect(plan.action).toBe('deescalate');
    expect(planHumanDeescalation(base({ settings: { ...settings, inferLegacy: false },
      pr: { comments: [bot('Mandatory review owner: d4c5 (correctness).', -33_000)] } })).reason).toMatch(/no recorded escalation/);
  });
  it('permission-change PR → kept', () => {
    for (const file of ['.github/workflows/ci.yml', '.claude/settings.json', 'scripts/bootstrap-session.mjs']) {
      const plan = planHumanDeescalation(base({ net: { ok: true, files: ['scripts/conveyor/foo.mjs', file] } }));
      expect(plan.action, file).toBe('keep');
    }
  });
  it('a net diff the shape rule sends to a human → kept', () => {
    // The shape rule (review-core-cli shape → scoreEscalation) is the authority; a gate-self/statute preset forces human.
    const human = planHumanDeescalation({ ...base(), scoreFiles: () => ({ humanRequired: true, reasons: ['gate-self'] }) });
    expect(human).toMatchObject({ action: 'keep' });
    expect(human.reason).toMatch(/requires a human \(gate-self\)/);
    expect(planHumanDeescalation({ ...base(), scoreFiles: () => ({}) }).action).toBe('keep');
    expect(planHumanDeescalation({ ...base(), scoreFiles: () => { throw new Error('x'); } }).action).toBe('keep');
  });
  it('hand label → kept (operator login, or any non-automation account)', () => {
    expect(planHumanDeescalation(base({ timeline: { status: 'ok', items: [added('chalbert')] } })).reason).toMatch(/hand or unproven/);
    expect(planHumanDeescalation(base({ timeline: { status: 'ok', items: [added('someone-else')] } })).action).toBe('keep');
    // A hand re-add after the escalation's own add: the latest add is the hand one.
    expect(planHumanDeescalation(base({ timeline: { status: 'ok', items: [added(), { ...added(), change: 'removed', createdAt: at(1000) }, added('chalbert', 2000)] } })).action).toBe('keep');
  });
  it('decision card in the net diff → kept; unreadable card read → kept', () => {
    expect(planHumanDeescalation(base({ decisionCards: { ok: true, files: ['backlog/x1-decide.md'] } })).reason).toMatch(/decision card/);
    expect(planHumanDeescalation(base({ decisionCards: { ok: false, reason: 'card read failed' } })).action).toBe('keep');
  });
  it('unreadable inputs → kept', () => {
    expect(planHumanDeescalation(base({ timeline: { status: 'unreadable', reason: 'truncated-timeline' } })).action).toBe('keep');
    expect(planHumanDeescalation(base({ net: { ok: false, reason: 'fetch failed' } })).action).toBe('keep');
    expect(planHumanDeescalation(base({ net: { ok: true, files: [] } })).action).toBe('keep');
    expect(planHumanDeescalation(base({ referral: null })).action).toBe('keep');
    expect(planHumanDeescalation(base({ pr: { comments: null } })).action).toBe('keep');
    expect(planHumanDeescalation(base({ pr: { headRefOid: '' } })).action).toBe('keep');
    expect(planHumanDeescalation(base({ timeline: { status: 'ok', items: [{ ...added(), createdAt: 'nope' }] } })).action).toBe('keep');
  });
  it('no recorded reason at the add (a rule-required or unstamped park) → kept, even if a later escalation is cleared', () => {
    const late = bot(buildHumanEscalationComment({ kind: K.REFERRAL_PENDING, head: HEAD }), 3_600_000);
    expect(planHumanDeescalation(base({ pr: { comments: [late] } })).reason).toMatch(/no recorded escalation/);
  });
  it('a kind outside the setting, or a non-clearable kind, since the add → kept', () => {
    const orphan = bot(`x\n\n${buildHumanEscalationMarker({ kind: K.ORPHAN_FIX_EXHAUSTED, head: HEAD })}`, 10_000);
    expect(planHumanDeescalation(base({ pr: { comments: [orphan] } })).reason).toMatch(/does not de-escalate/);
    expect(planHumanDeescalation(base({ settings: { ...settings, kinds: [K.ROUND_CAP] } })).reason).toMatch(/does not de-escalate/);
    const unknown = bot('<!-- we:human-escalation kind=future-kind head=none -->', 10_000);
    expect(planHumanDeescalation(base({ pr: { comments: [unknown] } })).action).toBe('keep');
  });
  it('other human-required holds → kept (park marker, ruling-needed, red-team block, blocked referral, operator send-back)', () => {
    const marker = bot(`<!-- human-surface-repark: ${HEAD} -->`, 5000);
    const esc = bot(buildHumanEscalationComment({ kind: K.REFERRAL_PENDING, head: HEAD }), 20_000);
    expect(planHumanDeescalation(base({ pr: { comments: [esc, marker] } })).action).toBe('keep');
    expect(planHumanDeescalation(base({ pr: { labels: ['review:human', 'advisory:ruling-needed'] } })).action).toBe('keep');
    expect(planHumanDeescalation(base({ pr: { labels: ['review:human', 'red-team:blocked'] } })).action).toBe('keep');
    expect(planHumanDeescalation(base({ referral: { pending: [], blocked: ['k'] } })).action).toBe('keep');
    expect(planHumanDeescalation(base({ timeline: { status: 'ok', items: [added(), added(BOT, 30_000, 'review:awaiting-advisory')] } })).reason).toMatch(/awaiting-advisory/);
  });
  it('disabled (kill switch) → kept', () => {
    expect(planHumanDeescalation(base({ settings: { ...settings, enabled: false } })).reason).toMatch(/disabled/);
  });
});

describe('resolveDeescalateSettings', () => {
  const none = () => { throw new Error('absent'); };
  it('standard on, every clearable kind, legacy inference on', () => {
    const s = resolveDeescalateSettings({ env: {}, readFile: none, platform: null, log: () => {} });
    expect(s).toMatchObject({ enabled: true, inferLegacy: true, kinds: [...DEESCALATE_KINDS_STANDARD] });
    expect(s.sources.humanDeescalateEnabled).toBe('standard');
  });
  it('env kill switch wins and is sourced; an unclearable kind in a layer is refused', () => {
    const s = resolveDeescalateSettings({ env: { WE_REVIEW_HUMAN_DEESCALATE: 'off', WE_REVIEW_HUMAN_DEESCALATE_KINDS: 'orphan-fix-exhausted' }, readFile: none, platform: null, log: () => {} });
    expect(s.enabled).toBe(false);
    expect(s.sources.humanDeescalateEnabled).toBe('env');
    expect(s.kinds).toEqual([...DEESCALATE_KINDS_STANDARD]);
  });
});

describe('readDecisionCards', () => {
  it('names decision cards at the head and fails closed on a read error', () => {
    const git = vi.fn((dir, args) => (args[1].endsWith('d.md') ? '---\nkind: decision\nstatus: open\n---\nbody' : '---\nkind: story\n---\n'));
    expect(readDecisionCards({ repo: REPO, head: HEAD, files: ['backlog/d.md', 'backlog/s.md', 'scripts/x.mjs'] }, { git, gitDirFor: () => '/r' }))
      .toEqual({ ok: true, files: ['backlog/d.md'] });
    expect(readDecisionCards({ repo: REPO, head: HEAD, files: ['backlog/d.md'] }, { git: () => { throw new Error('gone'); }, gitDirFor: () => '/r' }).ok).toBe(false);
    expect(readDecisionCards({ repo: REPO, head: HEAD, files: ['backlog/d.md'] }, { git, gitDirFor: () => null }).ok).toBe(false);
  });
});

describe('sweepHumanDeescalation (apply)', () => {
  const io = (over = {}) => {
    const b = base();
    const state = { state: 'OPEN', headRefOid: HEAD, labels: [{ name: 'review:human' }], body: '', createdAt: b.pr.createdAt, comments: [] };
    const provider = { currentRepo: () => REPO, readPrState: vi.fn(() => state), setLabels: vi.fn(), postComment: vi.fn() };
    return { provider, opts: { repo: REPO, apply: true, settings, provider,
      listPrs: () => [{ number: 5805, labels: [{ name: 'review:human' }] }, { number: 9, labels: [{ name: 'review:pending' }] }],
      readComments: () => b.pr.comments, readTimeline: () => b.timeline, readNetFiles: () => b.net, readCards: () => b.decisionCards,
      resolveSurfaces: () => 'narrow', readReferral: () => cleanReferral, log: vi.fn(), ...over } };
  };
  it('removes review:human, re-arms review:pending, records and logs it', () => {
    const { provider, opts } = io();
    const rows = sweepHumanDeescalation(opts);
    expect(rows).toEqual([expect.objectContaining({ num: 5805, action: 'deescalated' })]);
    expect(provider.setLabels).toHaveBeenCalledWith(REPO, 5805, { add: 'review:pending', remove: ['review:human'] });
    expect(provider.postComment.mock.calls[0][2]).toMatch(DEESCALATED_MARKER_RE);
    expect(opts.log.mock.calls[0][0]).toMatch(/^review-human de-escalated \{"pr":5805,"head":"a{40}","reason":/);
  });
  it('report mode writes nothing', () => {
    const { provider, opts } = io({ apply: false });
    expect(sweepHumanDeescalation(opts)[0].action).toBe('would-deescalate');
    expect(provider.setLabels).not.toHaveBeenCalled();
    expect(provider.postComment).not.toHaveBeenCalled();
  });
  it('a moved head between read and write keeps the hold', () => {
    const { provider, opts } = io();
    provider.readPrState.mockReturnValueOnce({ state: 'OPEN', headRefOid: HEAD, labels: [{ name: 'review:human' }], comments: [] })
      .mockReturnValueOnce({ state: 'OPEN', headRefOid: 'b'.repeat(40), labels: [{ name: 'review:human' }], comments: [] });
    expect(sweepHumanDeescalation(opts)[0]).toMatchObject({ action: 'keep', reason: 'state moved during the read' });
    expect(provider.setLabels).not.toHaveBeenCalled();
  });
  it('a throwing read keeps the hold and never stops the sweep; disabled writes nothing', () => {
    const { provider, opts } = io({ readTimeline: () => { throw new Error('gh down'); } });
    expect(sweepHumanDeescalation(opts)[0]).toMatchObject({ action: 'error' });
    expect(provider.setLabels).not.toHaveBeenCalled();
    const off = io({ settings: { ...settings, enabled: false } });
    expect(sweepHumanDeescalation(off.opts)[0].reason).toMatch(/disabled/);
    expect(off.provider.readPrState).not.toHaveBeenCalled();
  });
  it('keeps any other review label instead of adding review:pending', () => {
    const { provider, opts } = io();
    const s = { state: 'OPEN', headRefOid: HEAD, labels: [{ name: 'review:human' }, { name: 'review:changes' }], comments: [] };
    provider.readPrState.mockReturnValue(s);
    sweepHumanDeescalation(opts);
    expect(provider.setLabels).toHaveBeenCalledWith(REPO, 5805, { remove: ['review:human'] });
  });
});

describe('buildDeescalatedComment', () => {
  it('carries a machine marker', () => {
    expect(buildDeescalatedComment({ pr: 1, head: HEAD, kinds: ['round-cap'], reason: 'r' })).toMatch(DEESCALATED_MARKER_RE);
  });
});
