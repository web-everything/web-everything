import { describe, it, expect, vi } from 'vitest';
import {
  planHumanDeescalation, sweepHumanDeescalation, resolveDeescalateSettings, readDecisionCards, buildDeescalatedComment,
  readCommentsStrict, readNetDiffText, DEESCALATE_KINDS_STANDARD, DEESCALATED_MARKER_RE,
} from '../human-escalation-deescalate.mjs';
import {
  HUMAN_ESCALATION_KINDS as K, buildHumanEscalationMarker, buildHumanEscalationComment, readHumanEscalations, referralFailureKind,
} from '../../lib/human-escalation-marker.mjs';
import { buildRoundExtensionComment } from '../round-extension-mark.mjs';
import { buildOrphanGuardComment } from '../orphan-fix-round.mjs';
import { AUTOMATION_LOGINS } from '../../lib/marker-authorship.mjs';

// The automation login the test run resolves (the per-role App identity is pinned to none in tests).
const BOT = AUTOMATION_LOGINS.find(l => !l.endsWith('[bot]'));
const login = l => l.toLowerCase().replace(/\[bot\]$/, '');
const REPO = 'web-everything/web-everything';
const HEAD = 'a'.repeat(40);
const T0 = Date.parse('2026-10-21T18:38:25Z');
const at = ms => new Date(T0 + ms).toISOString();
const bot = (body, ms = 0, login = BOT) => ({ author: { login }, body, createdAt: at(ms) });
const operator = (body, ms = 0) => ({ author: { login: 'chalbert' }, body, createdAt: at(ms) });
const stranger = (body, ms = 0) => ({ author: { login: 'someone-else' }, body, createdAt: at(ms) });
const added = (actor = BOT, ms = 0, label = 'review:human') => ({ label, change: 'added', actor, actorType: actor === 'chalbert' ? 'User' : 'Bot', createdAt: at(ms) });
const settings = { enabled: true, kinds: [...DEESCALATE_KINDS_STANDARD], inferLegacy: true };
// A clean live-head referral state: the gate's reader shows a record for the live head and nothing held.
const cleanReferral = { pending: [], blocked: [], malformed: false, records: [{ head: HEAD }] };
const grant = ms => operator(buildRoundExtensionComment({ repo: REPO, pr: 5805, by: 2, actor: 'chalbert', channel: 'claude-code-chat', reason: 'two more rounds', at: at(ms) }), ms);
const pendingRecord = (ms = 20_000) => bot(buildHumanEscalationComment({ kind: K.REFERRAL_PENDING, head: HEAD }), ms);

const base = (over = {}) => ({
  pr: { number: 5805, headRefOid: HEAD, labels: [{ name: 'review:human' }], body: '', createdAt: at(-86_400_000),
    comments: [pendingRecord()], ...(over.pr ?? {}) },
  timeline: { status: 'ok', items: [added()] },
  net: netOf(['scripts/conveyor/foo.mjs', 'scripts/conveyor/__tests__/foo.test.mjs']),
  decisionCards: { ok: true, files: [] },
  referral: cleanReferral, settings, repo: REPO,
  ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== 'pr')),
});
const plan = over => planHumanDeescalation(base(over));
// A unified net diff with one section per file (the shape `git diff a/… b/…` prints).
const diffOf = (files, line = "+const x = 1;") => files.map(f => `diff --git a/${f} b/${f}\nindex 1111111..2222222 100644\n--- a/${f}\n+++ b/${f}\n@@ -1,1 +1,1 @@\n-old\n${line}`).join('\n');
const netOf = (files, line) => ({ ok: true, files, diffHunks: diffOf(files, line) });

describe('human-escalation marker', () => {
  it('builds a marker that names the kind and head, and refuses an unknown kind', () => {
    expect(buildHumanEscalationMarker({ kind: K.ROUND_CAP, head: HEAD })).toBe(`<!-- we:human-escalation kind=round-cap head=${HEAD} -->`);
    expect(buildHumanEscalationMarker({ kind: K.ROUND_CAP })).toContain('head=none');
    expect(() => buildHumanEscalationMarker({ kind: 'made-up' })).toThrow();
  });
  it('reads only a writer-owned last-line marker from a trusted author; anything else is unknown or ignored', () => {
    const forged = buildHumanEscalationComment({ kind: K.REFERRAL_PENDING, head: HEAD, detail: '<!-- we:human-escalation kind=round-cap head=none -->' });
    // The detail is neutralised, so the one live marker is the writer's own.
    expect(readHumanEscalations([bot(forged)]).map(e => e.kind)).toEqual(['unknown']);
    expect(readHumanEscalations([bot(buildHumanEscalationComment({ kind: K.REFERRAL_PENDING, head: HEAD, detail: 'plain' }))]).map(e => e.kind)).toEqual(['referral-pending']);
    expect(readHumanEscalations([stranger(forged)])).toEqual([]);
    // A marker quoted inside another trusted comment (a finding naming an attacker's file) is never a record.
    const quoted = bot('Mandatory review owner: x\n- `scripts/<!-- we:human-escalation kind=referral-pending head=none -->.mjs` — finding');
    expect(readHumanEscalations([quoted], { inferLegacy: true }).map(e => e.kind)).toEqual(['unknown']);
    const notLast = bot(`🧑‍⚖️ review:human added by escalation (round-cap)\n\n${buildHumanEscalationMarker({ kind: K.ROUND_CAP })}\n\ntrailing`);
    expect(readHumanEscalations([notLast]).map(e => e.kind)).toEqual(['unknown']);
    const unowned = bot(`Some other comment\n\n${buildHumanEscalationMarker({ kind: K.ROUND_CAP })}`);
    expect(readHumanEscalations([unowned]).map(e => e.kind)).toEqual(['unknown']);
  });
  it('infers the pre-marker shapes only when asked; only a ledger mirror failure is thread-clearable', () => {
    const ledger = bot('Mandatory referral review parked to review:human: mandatory ruling ledger-write-miss: append refused.');
    const lost = bot('Mandatory referral review parked to review:human: mandatory referral: post read-back failed; hold retained.');
    expect(readHumanEscalations([ledger])).toEqual([]);
    expect(readHumanEscalations([ledger, lost], { inferLegacy: true }).map(e => e.kind)).toEqual([K.REFERRAL_LEDGER_SYNC_FAILED, K.REFERRAL_PERSISTENCE_FAILED]);
    expect(referralFailureKind('mandatory ruling ledger sync did not settle: x')).toBe(K.REFERRAL_LEDGER_SYNC_FAILED);
    expect(referralFailureKind('mandatory referral record exceeds 60000 characters')).toBe(K.REFERRAL_PERSISTENCE_FAILED);
  });
  it('the orphan guard escalation comment records its kind; its other decisions do not', () => {
    const esc = buildOrphanGuardComment({ decision: 'escalate', reason: 'r', prNumber: 1, headSha: HEAD });
    expect(readHumanEscalations([bot(esc)]).map(e => e.kind)).toEqual([K.ORPHAN_FIX_EXHAUSTED]);
    expect(buildOrphanGuardComment({ decision: 'rearm', reason: 'r', prNumber: 1, headSha: HEAD })).not.toContain('we:human-escalation');
  });
});

describe('planHumanDeescalation', () => {
  const roundCap = (ms = 10_000) => bot(buildHumanEscalationComment({ kind: K.ROUND_CAP, head: HEAD }), ms);
  it('round-cap escalation + a later operator round grant → de-escalated', () => {
    expect(plan({ pr: { comments: [roundCap(), grant(3_600_000)] } })).toMatchObject({ action: 'deescalate', kinds: ['round-cap'], head: HEAD });
  });
  it('round-cap with no grant after it → kept; round-cap + grant but an unclean referral state → kept', () => {
    expect(plan({ pr: { comments: [grant(-3_600_000), roundCap()] } }).reason).toMatch(/no round grant/);
    const comments = [roundCap(), grant(3_600_000)];
    expect(plan({ pr: { comments }, referral: { ...cleanReferral, malformed: true, pending: ['malformed-referral-record'] } }).action).toBe('keep');
    expect(plan({ pr: { comments }, referral: { ...cleanReferral, pending: ['k'] } }).action).toBe('keep');
    expect(plan({ pr: { comments }, referral: null }).action).toBe('keep');
  });
  it('referral escalation, live head carries a fully ruled record → de-escalated; still pending → kept', () => {
    expect(plan().action).toBe('deescalate');
    expect(plan({ referral: { ...cleanReferral, pending: ['k'] } }).reason).toMatch(/still pending/);
  });
  it('a moved head with no referral record of its own → kept (old-head records prove nothing)', () => {
    expect(plan({ referral: { ...cleanReferral, records: [{ head: 'b'.repeat(40) }] } }).reason).toMatch(/no mandatory referral record on the live head/);
  });
  it('a persistence failure that may have lost the finding, and an overflow, never de-escalate', () => {
    for (const kind of [K.REFERRAL_PERSISTENCE_FAILED, K.REFERRAL_OVERFLOW]) {
      const c = bot(`Mandatory referral review parked to review:human: x.\n\n${buildHumanEscalationMarker({ kind, head: HEAD })}`, 10_000);
      expect(plan({ pr: { comments: [c] }, settings: { ...settings, kinds: [...settings.kinds, kind] } }).action, kind).toBe('keep');
    }
    const ledger = bot(`Mandatory referral review parked to review:human: mandatory ruling ledger-write-miss: append refused.\n\n${buildHumanEscalationMarker({ kind: K.REFERRAL_LEDGER_SYNC_FAILED, head: HEAD })}`, 10_000);
    expect(plan({ pr: { comments: [ledger] } }).action).toBe('deescalate');
  });
  it('legacy park comment by the labelling login right after the add explains it; a referral record never does', () => {
    const ledger = bot('Mandatory referral review parked to review:human: mandatory ruling ledger-write-miss: append refused.', 2_000);
    expect(plan({ pr: { comments: [ledger] } }).action).toBe('deescalate');
    expect(plan({ settings: { ...settings, inferLegacy: false }, pr: { comments: [ledger] } }).reason).toMatch(/no escalation record/);
    // Posted by another login than the one that labelled, or before the add: it does not explain the add.
    const other = AUTOMATION_LOGINS.find(l => login(l) !== login(BOT));
    if (other) expect(plan({ pr: { comments: [bot(ledger.body, 2_000, other)] } }).action).toBe('keep');
    expect(plan({ pr: { comments: [bot(ledger.body, -60_000)] } }).action).toBe('keep');
    // A settled referral record a minute before an unrelated add (an orphan park whose own record failed): kept.
    expect(plan({ pr: { comments: [bot('Mandatory review owner: d4c5 (correctness).', -60_000)] } }).reason).toMatch(/no escalation record/);
  });
  it('permission-change PR → kept', () => {
    for (const file of ['.github/workflows/ci.yml', '.claude/settings.json', 'scripts/bootstrap-session.mjs']) {
      expect(plan({ net: netOf(['scripts/conveyor/foo.mjs', file]) }).action, file).toBe('keep');
    }
    // Judged from the hunks: a sandbox grant written into an ordinary script.
    expect(plan({ net: netOf(['scripts/conveyor/new-worker.mjs'], "+const opts = { approval_policy: 'never' };") }).action).toBe('keep');
    expect(plan({ net: netOf(['scripts/conveyor/new-worker.mjs'], '+const opts = { retries: 2 };') }).action).toBe('deescalate');
  });
  it('a binary, mode-only or empty section (no text hunk) → kept', () => {
    const f = 'scripts/conveyor/foo.mjs';
    const binary = `diff --git a/${f} b/${f}\nindex 1111111..2222222 100644\nBinary files a/${f} and b/${f} differ`;
    expect(plan({ net: { ok: true, files: [f], diffHunks: binary } }).reason).toMatch(/no readable text hunk/);
    const mode = `diff --git a/${f} b/${f}\nold mode 100644\nnew mode 100755`;
    expect(plan({ net: { ok: true, files: [f], diffHunks: mode } }).action).toBe('keep');
  });
  it('net diff text unreadable, or a file with no diff section → kept', () => {
    expect(plan({ net: { ok: true, files: ['scripts/conveyor/foo.mjs'] } }).reason).toMatch(/net diff text unreadable/);
    expect(plan({ net: { ok: true, files: ['scripts/conveyor/foo.mjs', 'scripts/conveyor/bar.mjs'], diffHunks: diffOf(["scripts/conveyor/foo.mjs"]) } }).reason).toMatch(/hunks unavailable|no readable text hunk/);
  });
  it('a net diff (or a disclosed deviation) the shape rule sends to a human → kept', () => {
    const human = planHumanDeescalation({ ...base(), scoreFiles: () => ({ humanRequired: true, reasons: ['gate-self'] }) });
    expect(human.reason).toMatch(/requires a human \(gate-self\)/);
    expect(planHumanDeescalation({ ...base(), scoreFiles: () => ({}) }).action).toBe('keep');
    expect(planHumanDeescalation({ ...base(), scoreFiles: () => { throw new Error('x'); } }).action).toBe('keep');
    const deviation = vi.fn(() => ({ humanRequired: false }));
    planHumanDeescalation({ ...base({ pr: { body: 'Deviation: skipped the soak gate on purpose' } }), scoreFiles: deviation });
    expect(deviation.mock.calls[0][1]).toMatch(/skipped the soak gate/);
    expect(plan({ pr: { body: 'Deviation: skipped the soak gate on purpose' } }).action).toBe('keep');
    expect(plan({ pr: { body: null } }).reason).toMatch(/body unreadable/);
  });
  it('hand label → kept (operator login, or any non-automation account)', () => {
    expect(plan({ timeline: { status: 'ok', items: [added('chalbert')] } }).reason).toMatch(/hand or unproven/);
    expect(plan({ timeline: { status: 'ok', items: [added('someone-else')] } }).action).toBe('keep');
    expect(plan({ timeline: { status: 'ok', items: [added(), { ...added(), change: 'removed', createdAt: at(1000) }, added('chalbert', 2000)] } }).action).toBe('keep');
  });
  it('a non-clearable failure recorded by a no-op park (added=no) behind a cleared round-cap → kept', () => {
    const noop = bot(`Mandatory referral review parked to review:human: mandatory referral: comments unavailable; hold retained.\n\n${buildHumanEscalationMarker({ kind: K.REFERRAL_PERSISTENCE_FAILED, head: HEAD, added: false })}`, 600_000);
    const roundCap = bot(buildHumanEscalationComment({ kind: K.ROUND_CAP, head: HEAD }), 10_000);
    expect(plan({ pr: { comments: [roundCap, noop, grant(3_600_000)] } }).reason).toMatch(/referral-persistence-failed does not de-escalate/);
  });
  it('a cap reached while the referral hold stood (round-cap added=no) holds until a grant follows it', () => {
    const cap = bot(buildHumanEscalationComment({ kind: K.ROUND_CAP, head: HEAD, added: false }), 1_800_000);
    expect(plan({ pr: { comments: [pendingRecord(), cap] } }).reason).toMatch(/round-cap not cleared/);
    expect(plan({ pr: { comments: [pendingRecord(), cap, grant(3_600_000)] } }).action).toBe('deescalate');
  });
  it('a non-clearable record long BEFORE the add (a resumed card-extraction hold) still holds; a hand removal answers it', () => {
    const held = bot(`Card extraction held for a person: x. Nothing was extracted or dropped.\n\n${buildHumanEscalationMarker({ kind: K.CARD_EXTRACTION_HELD })}\n`, -600_000);
    expect(plan({ pr: { comments: [held, pendingRecord()] } }).reason).toMatch(/card-extraction-held does not de-escalate/);
    // The operator took the label off after that hold: it is answered; a later escalation stands on its own.
    const items = [added(BOT, -900_000), { ...added('chalbert', -300_000), change: 'removed' }, added()];
    expect(plan({ timeline: { status: 'ok', items }, pr: { comments: [held, pendingRecord()] } }).action).toBe('deescalate');
  });
  it('a review:human event with no readable actor → kept; only the operator\'s removal answers earlier causes', () => {
    const held = bot(`Card extraction held for a person: x.\n\n${buildHumanEscalationMarker({ kind: K.CARD_EXTRACTION_HELD })}\n`, -600_000);
    const nullActor = [added(BOT, -900_000), { ...added(BOT, -300_000), change: 'removed', actor: null }, added()];
    expect(plan({ timeline: { status: 'ok', items: nullActor }, pr: { comments: [held, pendingRecord()] } }).reason).toMatch(/no readable actor/);
    const other = [added(BOT, -900_000), { ...added('someone-else', -300_000), change: 'removed' }, added()];
    expect(plan({ timeline: { status: 'ok', items: other }, pr: { comments: [held, pendingRecord()] } }).action).toBe('keep');
    const app = [added(BOT, -900_000), { ...added('chalbert[bot]', -300_000), change: 'removed' }, added()];
    expect(plan({ timeline: { status: 'ok', items: app }, pr: { comments: [held, pendingRecord()] } }).action).toBe('keep');
  });
  it('an operator-named removal by a Bot actor never resets the window', () => {
    const held = bot(`Card extraction held for a person: x.\n\n${buildHumanEscalationMarker({ kind: K.CARD_EXTRACTION_HELD })}\n`, -600_000);
    const items = [added(BOT, -900_000), { ...added(BOT, -300_000), change: 'removed', actor: 'chalbert', actorType: 'Bot' }, added()];
    expect(plan({ timeline: { status: 'ok', items }, pr: { comments: [held, pendingRecord()] } }).action).toBe('keep');
  });
  it('an earlier unexplained add since the operator\'s last removal (a drain park, later removed by automation) → kept', () => {
    const items = [added(BOT, -900_000), { ...added(BOT, -600_000), change: 'removed' }, added()];
    expect(plan({ timeline: { status: 'ok', items } }).reason).toMatch(/earlier review:human add .* has no escalation record/);
    // Every add explained by its own record → fine.
    const first = bot(buildHumanEscalationComment({ kind: K.REFERRAL_PENDING, head: HEAD }), -899_000);
    expect(plan({ timeline: { status: 'ok', items }, pr: { comments: [first, pendingRecord()] } }).action).toBe('deescalate');
  });
  it('one record explains one add, inside its own lifecycle (never an earlier add it followed a removal of)', () => {
    const items = [added(BOT, -120_000), { ...added(BOT, -60_000), change: 'removed' }, added()];
    // The only record follows the LAST add; the first add (an unstamped hold) stays unexplained.
    expect(plan({ timeline: { status: 'ok', items }, pr: { comments: [pendingRecord(1_000)] } }).reason).toMatch(/earlier review:human add/);
  });
  it('a net file name outside the plain path alphabet (rename notation, quotes, spaces) → kept', () => {
    for (const odd of ['scripts/payload => innocuous.mjs', 'scripts/{a => b}.mjs', 'scripts/sp ace.mjs', 'scripts/"q".mjs']) {
      expect(plan({ net: netOf(['scripts/conveyor/foo.mjs', odd]) }).reason, odd).toMatch(/plain path alphabet/);
    }
  });
  it('an added=no record never explains an add, even of a clearable kind', () => {
    const noop = bot(`Mandatory referral review parked to review:human: mandatory ruling ledger-write-miss: x.\n\n${buildHumanEscalationMarker({ kind: K.REFERRAL_LEDGER_SYNC_FAILED, head: HEAD, added: false })}`, 20_000);
    expect(plan({ pr: { comments: [noop] } }).reason).toMatch(/no escalation record/);
  });
  it('a record from an earlier label lifecycle (before the last removal) never explains the current add', () => {
    const items = [added(BOT, -3_000), { ...added(BOT, -2_000), change: 'removed' }, added()];
    const old = bot(buildHumanEscalationComment({ kind: K.ROUND_CAP, head: HEAD }), -2_500);
    expect(plan({ timeline: { status: 'ok', items }, pr: { comments: [old, grant(3_600_000)] } }).reason).toMatch(/no escalation record/);
  });
  it('a hand add EVER on this PR → kept, even when an automation write restored it later (the label mirror)', () => {
    const items = [added('chalbert', -7_200_000), { ...added('chalbert', -3_600_000), change: 'removed' }, added()];
    expect(plan({ timeline: { status: 'ok', items } }).reason).toMatch(/hand-added by chalbert/);
  });
  it('an unreadable comment (body or author) anywhere in the thread → kept', () => {
    expect(plan({ pr: { comments: [pendingRecord(), { author: { login: BOT }, body: null, createdAt: at(30_000) }] } }).reason).toMatch(/unreadable/);
    const orphan = buildOrphanGuardComment({ decision: 'escalate', reason: 'r', prNumber: 5805, headSha: HEAD });
    expect(plan({ pr: { comments: [pendingRecord(), { author: null, body: orphan, createdAt: at(30_000) }] } }).reason).toMatch(/author\) is unreadable/);
  });
  it('the broad preset is judged on the hunks too; a bad surfaces setting → kept', () => {
    expect(plan({ surfaces: 'broad' }).action).toBe('deescalate');
    expect(plan({ surfaces: 'not-a-preset' }).reason).toMatch(/setting unreadable/);
  });
  it('decision card in the net diff → kept; unreadable card read → kept', () => {
    expect(plan({ decisionCards: { ok: true, files: ['backlog/x1-decide.md'] } }).reason).toMatch(/decision card/);
    expect(plan({ decisionCards: { ok: false, reason: 'card read failed' } }).action).toBe('keep');
  });
  it('unreadable or malformed inputs → kept', () => {
    expect(plan({ timeline: { status: 'unreadable', reason: 'truncated-timeline' } }).action).toBe('keep');
    expect(plan({ timeline: { status: 'ok', items: [added(), null] } }).action).toBe('keep');
    expect(plan({ timeline: { status: 'ok', items: [{ ...added(), createdAt: 'nope' }] } }).action).toBe('keep');
    expect(plan({ net: { ok: false, reason: 'fetch failed' } }).action).toBe('keep');
    expect(plan({ net: { ok: true, files: [] } }).action).toBe('keep');
    expect(plan({ referral: null }).action).toBe('keep');
    expect(plan({ referral: { pending: [], blocked: [] } }).action).toBe('keep');
    expect(plan({ pr: { comments: null } }).action).toBe('keep');
    expect(plan({ pr: { headRefOid: '' } }).action).toBe('keep');
    // A later escalation with no readable time cannot be placed: hold.
    expect(plan({ pr: { comments: [pendingRecord(), { ...pendingRecord(), createdAt: 'bad' }] } }).reason).toMatch(/no readable time/);
  });
  it('no recorded reason at the add (a rule-required or unstamped park) → kept, even if a later escalation is cleared', () => {
    expect(plan({ pr: { comments: [pendingRecord(3_600_000)] } }).reason).toMatch(/no escalation record/);
  });
  it('a kind outside the setting, or a non-clearable kind, since the add → kept', () => {
    const orphan = bot(buildOrphanGuardComment({ decision: 'escalate', reason: 'r', prNumber: 5805, headSha: HEAD }), 10_000);
    expect(plan({ pr: { comments: [pendingRecord(), orphan] } }).reason).toMatch(/does not de-escalate/);
    expect(plan({ settings: { ...settings, kinds: [K.ROUND_CAP] } }).reason).toMatch(/does not de-escalate/);
    expect(plan({ pr: { comments: [pendingRecord(), bot('🧑‍⚖️ review:human added by escalation\n\n<!-- we:human-escalation kind=future-kind head=none -->', 10_000)] } }).action).toBe('keep');
  });
  it('other holds → kept (accepted, mechanical, awaiting-advisory now or since, ruling-needed, red-team block, park marker, blocked referral, send-back)', () => {
    for (const label of ['review:accepted', 'review:held-mechanical', 'review:awaiting-advisory', 'advisory:ruling-needed', 'red-team:blocked']) {
      expect(plan({ pr: { labels: ['review:human', label] } }).reason, label).toMatch(/stands/);
    }
    // The drain parked for its own reason an hour later while the label stood: its awaiting-advisory add holds.
    expect(plan({ timeline: { status: 'ok', items: [added(), added(BOT, 3_600_000, 'review:awaiting-advisory'),
      { ...added(BOT, 3_700_000, 'review:awaiting-advisory'), change: 'removed' }] } }).reason).toMatch(/awaiting-advisory/);
    expect(plan({ pr: { comments: [pendingRecord(), bot(`<!-- human-surface-repark: ${HEAD} -->`, 5000)] } }).action).toBe('keep');
    expect(plan({ referral: { ...cleanReferral, blocked: ['k'] } }).action).toBe('keep');
  });
  it('an open operator send-back → kept', () => {
    const sendBack = operator('🔁 review — changes requested\n\nRecorded by chalbert via /review.\n\n1. fix the thing', 30_000);
    expect(planHumanDeescalation({ ...base({ pr: { comments: [pendingRecord(), sendBack] } }) }).action).toBe('keep');
  });
  it('disabled (kill switch) → kept', () => {
    expect(plan({ settings: { ...settings, enabled: false } }).reason).toMatch(/disabled/);
  });
});

describe('resolveDeescalateSettings', () => {
  const none = () => { throw new Error('absent'); };
  it('standard on, every clearable kind, legacy inference OFF (a pre-marker comment cannot prove its add)', () => {
    const s = resolveDeescalateSettings({ env: {}, readFile: none, platform: null, log: () => {} });
    expect(s).toMatchObject({ enabled: true, inferLegacy: false, kinds: [...DEESCALATE_KINDS_STANDARD] });
    expect(DEESCALATE_KINDS_STANDARD).not.toContain(K.REFERRAL_PERSISTENCE_FAILED);
    expect(s.sources.humanDeescalateEnabled).toBe('standard');
  });
  it('env kill switch wins and is sourced; an unclearable kind in a layer is refused', () => {
    const s = resolveDeescalateSettings({ env: { WE_REVIEW_HUMAN_DEESCALATE: 'off', WE_REVIEW_HUMAN_DEESCALATE_KINDS: 'orphan-fix-exhausted' }, readFile: none, platform: null, log: () => {} });
    expect(s.enabled).toBe(false);
    expect(s.sources.humanDeescalateEnabled).toBe('env');
    expect(s.kinds).toEqual([...DEESCALATE_KINDS_STANDARD]);
    const file = () => JSON.stringify({ humanDeescalateKinds: ['round-cap', 'referral-overflow'] });
    expect(resolveDeescalateSettings({ env: {}, readFile: file, platform: null, log: () => {} }).kinds).not.toContain('referral-overflow');
  });
});

describe('readDecisionCards', () => {
  const card = kind => `---\n${kind}\nstatus: open\n---\nbody`;
  it('names decision cards by parsed front matter (a YAML comment does not hide it); fails closed on any read problem', () => {
    const blobs = { 'backlog/d.md': card('kind: decision # operator ruling'), 'backlog/q.md': card("kind: 'decision'"), 'backlog/s.md': card('kind: story') };
    const git = vi.fn((dir, args) => blobs[args[1].split(':')[1]]);
    expect(readDecisionCards({ repo: REPO, head: HEAD, files: ['backlog/d.md', 'backlog/q.md', 'backlog/s.md', 'scripts/x.mjs'] }, { git, gitDirFor: () => '/r' }))
      .toEqual({ ok: true, files: ['backlog/d.md', 'backlog/q.md'] });
    expect(readDecisionCards({ repo: REPO, head: HEAD, files: ['backlog/d.md'] }, { git: () => { throw new Error('gone'); }, gitDirFor: () => '/r' }).ok).toBe(false);
    expect(readDecisionCards({ repo: REPO, head: HEAD, files: ['backlog/d.md'] }, { git, gitDirFor: () => null }).ok).toBe(false);
    expect(readDecisionCards({ repo: REPO, head: HEAD, files: ['backlog/b.md'] }, { git: () => '---\nkind: [unclosed\n---\n', gitDirFor: () => '/r' }).ok).toBe(false);
    expect(readDecisionCards({ repo: REPO, head: HEAD, files: ['backlog/n.md'] }, { git: () => 'no front matter', gitDirFor: () => '/r' }).ok).toBe(false);
    expect(readDecisionCards({ repo: REPO, head: HEAD, files: ['scripts/x.mjs'] }, { git, gitDirFor: () => null })).toEqual({ ok: true, files: [] });
  });
});

describe('sweepHumanDeescalation (apply)', () => {
  const io = (over = {}) => {
    const b = base();
    const state = { state: 'OPEN', headRefOid: HEAD, labels: [{ name: 'review:human' }], body: '', createdAt: b.pr.createdAt, comments: [] };
    // The fake applies label writes to the live state, the way GitHub does.
    const setLabels = vi.fn((repo, pr, { add, remove = [] }) => {
      state.labels = [...state.labels.filter(l => !remove.includes(l.name)), ...(add ? [{ name: add }] : [])];
    });
    const provider = { currentRepo: () => REPO, readPrState: vi.fn(() => structuredClone(state)), setLabels, postComment: vi.fn() };
    return { provider, opts: { repo: REPO, apply: true, settings, provider,
      listPrs: () => [{ number: 5805, labels: [{ name: 'review:human' }] }, { number: 9, labels: [{ name: 'review:pending' }] }],
      readComments: () => b.pr.comments, readTimeline: vi.fn(() => b.timeline), readCards: () => b.decisionCards,
      readNetFiles: vi.fn(() => ({ ok: true, files: b.net.files })), readDiff: vi.fn(() => ({ ok: true, text: b.net.diffHunks })),
      resolveSurfaces: () => 'narrow', readReferral: () => cleanReferral, log: vi.fn(), ...over } };
  };
  it('removes review:human, re-arms review:pending, records and logs it; the net read is not repeated for the same head', () => {
    const { provider, opts } = io();
    const rows = sweepHumanDeescalation(opts);
    expect(rows).toEqual([expect.objectContaining({ num: 5805, action: 'deescalated' })]);
    expect(provider.setLabels).toHaveBeenCalledWith(REPO, 5805, { add: 'review:pending', remove: ['review:human'] });
    expect(provider.postComment.mock.calls[0][2]).toMatch(DEESCALATED_MARKER_RE);
    expect(opts.log.mock.calls[0][0]).toMatch(/^review-human de-escalated \{"pr":5805,"head":"a{40}","reason":/);
    expect(opts.readTimeline).toHaveBeenCalledTimes(2);
    expect(opts.readNetFiles).toHaveBeenCalledTimes(1);
  });
  it('report mode writes nothing', () => {
    const { provider, opts } = io({ apply: false });
    expect(sweepHumanDeescalation(opts)[0].action).toBe('would-deescalate');
    expect(provider.setLabels).not.toHaveBeenCalled();
    expect(provider.postComment).not.toHaveBeenCalled();
  });
  it('a hand re-add between the first read and the write keeps the hold (the timeline is re-read)', () => {
    const { provider, opts } = io();
    opts.readTimeline.mockReturnValueOnce({ status: 'ok', items: [added()] })
      .mockReturnValueOnce({ status: 'ok', items: [added(), { ...added(), change: 'removed', createdAt: at(1000) }, added('chalbert', 2000)] });
    expect(sweepHumanDeescalation(opts)[0]).toMatchObject({ action: 'keep' });
    expect(provider.setLabels).not.toHaveBeenCalled();
  });
  it('a moved head between read and write keeps the hold', () => {
    const { provider, opts } = io();
    provider.readPrState.mockReturnValueOnce({ state: 'OPEN', headRefOid: HEAD, labels: [{ name: 'review:human' }], body: '', comments: [] })
      .mockReturnValueOnce({ state: 'OPEN', headRefOid: 'b'.repeat(40), labels: [{ name: 'review:human' }], body: '', comments: [] });
    expect(sweepHumanDeescalation(opts)[0]).toMatchObject({ action: 'keep' });
    expect(provider.setLabels).not.toHaveBeenCalled();
  });
  it('a push during the comment/timeline read (second state read) keeps the hold', () => {
    const { provider, opts } = io();
    const st = h => ({ state: 'OPEN', headRefOid: h, labels: [{ name: 'review:human' }], body: '', comments: [] });
    provider.readPrState.mockReturnValueOnce(st(HEAD)).mockReturnValueOnce(st(HEAD)).mockReturnValueOnce(st(HEAD)).mockReturnValueOnce(st('c'.repeat(40)));
    expect(sweepHumanDeescalation(opts)[0]).toMatchObject({ action: 'keep' });
    expect(provider.setLabels).not.toHaveBeenCalled();
  });
  it('a head that moved under the write gets review:human straight back', () => {
    const { provider, opts } = io();
    const st = (h, labels) => ({ state: 'OPEN', headRefOid: h, labels, body: '', comments: [] });
    for (let i = 0; i < 4; i++) provider.readPrState.mockReturnValueOnce(st(HEAD, [{ name: 'review:human' }]));
    provider.readPrState.mockReturnValueOnce(st('d'.repeat(40), [{ name: 'review:pending' }]));
    expect(sweepHumanDeescalation(opts)[0]).toMatchObject({ action: 'keep', reason: expect.stringMatching(/restored/) });
    expect(provider.setLabels.mock.calls.map(c => c[2])).toEqual([
      { add: 'review:pending', remove: ['review:human'] }, { add: 'review:human', remove: ['review:pending'] }]);
    expect(opts.log).not.toHaveBeenCalled();
  });
  it('a write that throws: the head is still re-read — moved → restored; unchanged and label gone → it landed', () => {
    const st = (h, labels) => ({ state: 'OPEN', headRefOid: h, labels, body: '', comments: [] });
    const moved = io();
    for (let i = 0; i < 4; i++) moved.provider.readPrState.mockReturnValueOnce(st(HEAD, [{ name: 'review:human' }]));
    moved.provider.readPrState.mockReturnValueOnce(st('e'.repeat(40), [{ name: 'review:pending' }]));
    moved.provider.setLabels.mockImplementationOnce(() => { throw new Error('timeout'); });
    expect(sweepHumanDeescalation(moved.opts)[0].reason).toMatch(/restored/);
    expect(moved.provider.setLabels.mock.calls[1][2]).toMatchObject({ add: 'review:human' });
    const unreadable = io();
    for (let i = 0; i < 4; i++) unreadable.provider.readPrState.mockReturnValueOnce(st(HEAD, [{ name: 'review:human' }]));
    unreadable.provider.readPrState.mockImplementationOnce(() => { throw new Error('gh down'); });
    unreadable.provider.setLabels.mockImplementationOnce(() => { throw new Error('timeout'); });
    expect(sweepHumanDeescalation(unreadable.opts)[0].reason).toMatch(/restored/);
    const failed = io();
    for (let i = 0; i < 5; i++) failed.provider.readPrState.mockReturnValueOnce(st(HEAD, [{ name: 'review:human' }]));
    failed.provider.setLabels.mockImplementationOnce(() => { throw new Error('422'); });
    expect(sweepHumanDeescalation(failed.opts)[0]).toMatchObject({ action: 'error', reason: expect.stringMatching(/label write failed/) });
  });
  it('a net diff read failure keeps the hold', () => {
    const { provider, opts } = io({ readDiff: () => ({ ok: false, reason: 'net diff failed' }) });
    expect(sweepHumanDeescalation(opts)[0].reason).toMatch(/net diff text unreadable/);
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
  it('keeps review:changes as the only review label instead of adding review:pending', () => {
    const { provider, opts } = io();
    provider.readPrState.mockReturnValue({ state: 'OPEN', headRefOid: HEAD, labels: [{ name: 'review:human' }, { name: 'review:changes' }], body: '', comments: [] });
    sweepHumanDeescalation(opts);
    expect(provider.setLabels).toHaveBeenCalledWith(REPO, 5805, { remove: ['review:human'] });
  });
});

describe('IO readers', () => {
  it('readCommentsStrict keeps a null body null (the planner then holds), never an empty string', () => {
    const exec = vi.fn(() => `${JSON.stringify({ body: 'x', createdAt: at(0), author: { login: BOT } })}\n${JSON.stringify({ body: null, createdAt: at(1), author: { login: BOT } })}\n`);
    const comments = readCommentsStrict(5805, { repo: REPO, exec });
    expect(comments[1].body).toBeNull();
    expect(exec.mock.calls[0][1]).toContain(`repos/${REPO}/issues/5805/comments`);
    expect(plan({ pr: { comments: [pendingRecord(), ...comments] } }).reason).toMatch(/is unreadable/);
  });
  it('readNetDiffText diffs the merge-base with origin/main against the head and fails closed', () => {
    const git = vi.fn((dir, args) => (args[0] === 'merge-base' ? `${'f'.repeat(40)}\n` : 'diff --git a/x b/x\n'));
    expect(readNetDiffText({ repo: REPO, head: HEAD }, { git, gitDirFor: () => '/r' })).toEqual({ ok: true, text: 'diff --git a/x b/x\n' });
    expect(git.mock.calls[1][1]).toEqual(expect.arrayContaining(['f'.repeat(40), HEAD, '--src-prefix=a/', '--dst-prefix=b/']));
    expect(readNetDiffText({ repo: REPO, head: HEAD }, { git: () => 'nope', gitDirFor: () => '/r' }).ok).toBe(false);
    expect(readNetDiffText({ repo: REPO, head: HEAD }, { git: () => { throw new Error('x'); }, gitDirFor: () => '/r' }).ok).toBe(false);
    expect(readNetDiffText({ repo: REPO, head: HEAD }, { git, gitDirFor: () => null }).ok).toBe(false);
  });
});

describe('buildDeescalatedComment', () => {
  it('carries a machine marker', () => {
    expect(buildDeescalatedComment({ pr: 1, head: HEAD, kinds: ['round-cap'], reason: 'r' })).toMatch(DEESCALATED_MARKER_RE);
  });
});
