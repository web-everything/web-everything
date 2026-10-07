/**
 * @file scripts/lib/__tests__/verdict-ledger.test.mjs
 * @description Unit tests for the #3007 PHASE-1 verdict ledger — the schema, the append-only fold, the
 *   ledger↔label checker core, and the two claims this slice makes that the card got wrong (the key is not
 *   the content digest; the writers are not single).
 *
 * NOTE ON LOCATION. #3007's `scope` names `we:scripts/__tests__/verdict-ledger.test.mjs`. The module lives at
 * `scripts/lib/verdict-ledger.mjs`, and every sibling library test in this repo sits in `scripts/lib/__tests__/`
 * (`review-escalation.test.mjs`, `jury-ledger.test.mjs`, …). The card's path is corrected rather than followed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  VERDICTS, VERDICT_VALUES, VERDICT_LEDGER_VERSION, VERDICT_LEDGER_KIND, ACTOR_PROVES,
  AGREEMENT, DISAGREE_DIRECTION,
  buildVerdictRecord, validateVerdictRecord, serializeVerdictRecord, parseVerdictLog,
  verdictClears, verdictLabel, verdictForLabelTarget, labelVerdictOf, foldVerdictLedger, ledgerCoversHead,
  compareLedgerToLabels, summarizeAgreement, summarizeShadowAgreement,
  NON_BEARING, verdictBears,
  appendVerdict, resolveLedgerStore, resolveLedgerStoreChoice, resetLedgerDowngradeWarning, DEFAULT_VERDICT_LEDGER_STORE, readVerdictLedger, foldRepo, verdictLedgerPath, verdictLedgerDir, defaultVerdictLedgerDir,
  listLedgerRepos,
  EVENT_TYPES, EVENT_TYPE_VALUES, LEDGER_EVENT_VERSION, eventBears,
  buildLedgerEvent, validateLedgerEvent, serializeLedgerEvent, parseLedgerEvents,
} from '../verdict-ledger.mjs';
import { createHash } from 'node:crypto';
import { REVIEW_LABELS, normalizeContributionFingerprint, decideReviewGate } from '../review-escalation.mjs';
import { REVIEW_LABEL_TARGETS } from '../../review-set-label.mjs';
import { lockDirFor, makeLockEntry } from '../../readiness/file-locks.mjs';
import { buildRows } from '../../review-ledger-check.mjs';
import { ROUND_VERDICTS, reviewRoundsFromVerdictLedger, owedFromLedgerVerdict } from '../../pr-status.mjs';

const REPO = 'web-everything/web-everything';
const AT = '2026-08-10T12:00:00.000Z';

/** #3329 — the BEARING subset, DERIVED from the module's own two exports rather than listed here. A local
 *  list would be a third copy of the enum and would drift the first time a seventh member lands. */
const BEARING_VERDICTS = VERDICT_VALUES.filter((v) => !NON_BEARING.includes(v));

/** A minimal valid record, with overrides. */
const rec = (over = {}) => buildVerdictRecord({
  repo: REPO, pr: 1, verdict: VERDICTS.ACCEPTED, at: AT, source: 'test', ...over,
});

const shadow = (over = {}) => rec({ verdict: VERDICTS.OBSERVED, mode: 'shadow', wouldClear: true, ...over });

describe('#3217 shadow records remain observations', () => {
  it('retains the shadow marker and prediction, deriving clears as false even if forged', () => {
    expect(validateVerdictRecord({ ...shadow(), clears: true }).record).toMatchObject({
      verdict: 'observed', clears: false, mode: 'shadow', wouldClear: true, applied: false, mutated: false,
    });
    expect(verdictClears(shadow().verdict)).toBe(false);
    expect(verdictBears(shadow().verdict)).toBe(false);
  });

  it.each([
    { verdict: VERDICTS.ACCEPTED }, { verdict: VERDICTS.CHANGES }, { mode: 'enforce' },
    { wouldClear: 'true' }, { applied: true }, { mutated: true }, { mode: undefined },
  ])('rejects an ambiguous or applied shadow row: %j', (over) => {
    expect(validateVerdictRecord({ ...shadow(), ...over }).valid).toBe(false);
  });

  it('refuses building a shadow clearance', () => {
    expect(() => shadow({ verdict: VERDICTS.ACCEPTED })).toThrow(/shadow predictions/);
  });

  it.each([VERDICTS.ACCEPTED, VERDICTS.CHANGES])('does not supersede a real %s or change its holds', (verdict) => {
    const real = rec({ verdict });
    const before = foldVerdictLedger([real]).get(1);
    const folded = foldVerdictLedger([real, shadow(), shadow({ wouldClear: false })]);
    expect(folded.get(1)).toMatchObject({ current: real, clears: before.clears, outstandingHolds: before.outstandingHolds });
    expect(compareLedgerToLabels({ pr: 1, labels: [verdictLabel(verdict)], folded: folded.get(1) }).status).toBe('agree');
    expect(reviewRoundsFromVerdictLedger(folded.get(1).history, 1)).toBe(1);
  });

  it('does not admit a shadow-only PR into live label drift comparisons', () => {
    expect(buildRows({ prs: [{ number: 1, labels: [] }], folded: foldVerdictLedger([shadow()]) })).toEqual([]);
  });
});

describe('#3217 shadow-vs-human agreement', () => {
  it.each([
    [true, VERDICTS.ACCEPTED, 'agree'], [true, VERDICTS.CHANGES, 'disagree'],
    [false, VERDICTS.ACCEPTED, 'disagree'], [false, VERDICTS.CHANGES, 'agree'],
  ])('compares wouldClear=%s against %s as %s', (wouldClear, verdict, status) => {
    const summary = summarizeShadowAgreement([
      shadow({ wouldClear }), rec({ verdict, declaredActor: 'nic' }),
    ], { humanActor: 'nic' });
    expect(summary.total).toBe(1);
    expect(summary[status]).toBe(1);
    expect(summary.rows[0]).toMatchObject({ repo: REPO, pr: 1, wouldClear, humanVerdict: verdict, status });
    expect(summary.unmatched).toEqual([]);
  });

  it('defaults only to the explicit human ceremony, not any agent acceptance', () => {
    const rows = [shadow(), rec({ declaredActor: 'agent' })];
    expect(summarizeShadowAgreement(rows)).toMatchObject({ total: 0, unmatched: [shadow()] });
    expect(summarizeShadowAgreement([...rows, rec({ verdict: VERDICTS.CLEAR_HUMAN })])).toMatchObject({ total: 1, agree: 1 });
  });

  it('joins by both repo and PR, never using a human verdict preceding the prediction', () => {
    const rows = [rec({ verdict: VERDICTS.CLEAR_HUMAN }), shadow(),
      rec({ pr: 2, verdict: VERDICTS.CLEAR_HUMAN }),
      rec({ repo: 'other/repo', verdict: VERDICTS.CLEAR_HUMAN })];
    expect(summarizeShadowAgreement(rows)).toMatchObject({ total: 0, unmatched: [shadow()] });
  });

  it('counts repeated predictions and human outcomes only once per matched pair', () => {
    const rows = [shadow({ wouldClear: false }), shadow(), rec({ verdict: VERDICTS.CLEAR_HUMAN }),
      rec({ verdict: VERDICTS.CLEAR_HUMAN }), shadow({ pr: 2 })];
    expect(summarizeShadowAgreement(rows)).toMatchObject({ total: 1, agree: 1, superseded: 1, unmatched: [shadow({ pr: 2 })] });
  });
});

describe('#3007 schema — versioned, closed, and total over the label targets', () => {
  it('stamps the version + kind on every record', () => {
    const r = rec();
    expect(r.v).toBe(VERDICT_LEDGER_VERSION);
    expect(r.kind).toBe(VERDICT_LEDGER_KIND);
    expect(VERDICT_LEDGER_VERSION).toBeGreaterThanOrEqual(1);
  });

  it('carries every field #3007 requires: PR, content key, verdict, reviewer identity, timestamp, reason', () => {
    const r = rec({ reason: 'reviewer accepted', headSha: 'A'.repeat(40), declaredActor: 'nic', session: 's-1' });
    expect(r.pr).toBe(1);
    expect(r.repo).toBe(REPO);
    expect(r.verdict).toBe(VERDICTS.ACCEPTED);
    expect(r.at).toBe(AT);
    expect(r.reason).toBe('reviewer accepted');
    expect(r.coverage).toEqual({ headSha: 'a'.repeat(40), reviewedDiff: null, reviewedContribution: null });
    expect(r.actor.declared).toBe('nic');
    expect(r.actor.session).toBe('s-1');
  });

  it('the verdict set covers every REVIEW_LABEL_TARGETS member the single home can write', () => {
    // A label target with no ledger verdict is a ledger that is silently narrower than the labels it replaces.
    // Taken through the ONE mapping both the writer and the reconciling sink use — a local table here would be
    // a third copy, and copies of this mapping are what made the reconciler unsound (PR #1149 review).
    for (const target of REVIEW_LABEL_TARGETS) {
      expect(VERDICT_VALUES, `no ledger verdict for --to=${target}`).toContain(verdictForLabelTarget(target));
    }
    // …and the two hold labels the DRAIN parks under are expressible too, which Phase 2 requires.
    expect(VERDICT_VALUES).toContain(VERDICTS.PENDING);
    expect(VERDICT_VALUES).toContain(VERDICTS.HUMAN);
  });

  it('verdictForLabelTarget is total over the targets, fails closed, and inverts verdictLabel', () => {
    expect(verdictForLabelTarget('accepted')).toBe(VERDICTS.ACCEPTED);
    expect(verdictForLabelTarget('changes')).toBe(VERDICTS.CHANGES);
    expect(verdictForLabelTarget('clear-human')).toBe(VERDICTS.CLEAR_HUMAN);
    // `rearm` swaps review:changes → review:pending: a HOLD awaiting review, not a verdict on the diff.
    expect(verdictForLabelTarget('rearm')).toBe(VERDICTS.PENDING);
    // #x5e2ldj — `restamp` re-witnesses an EXISTING acceptance at a head the drain's own rebase moved. It gets
    // its own verdict rather than reusing ACCEPTED, so a reader counting acceptances does not count a carried
    // marker as a review that happened.
    expect(verdictForLabelTarget('restamp')).toBe(VERDICTS.RESTAMPED);
    expect(verdictForLabelTarget('restamp')).not.toBe(VERDICTS.ACCEPTED);
    // FAIL CLOSED. The old private copy of this ternary defaulted an unrecognised target to a verdict, which
    // is how a `clear-human` clearance would have been recorded as a `changes` hold.
    for (const bad of ['', 'merge-it', 'ACCEPTED', null, undefined, 0]) {
      expect(verdictForLabelTarget(bad), `\`${String(bad)}\` must not map to a verdict`).toBeNull();
    }
    // Round-trip: the verdict a target implies mirrors to the label that target's swap actually applies.
    for (const target of REVIEW_LABEL_TARGETS) {
      expect(verdictLabel(verdictForLabelTarget(target))).toBe(
        target === 'clear-human' || target === 'restamp' ? REVIEW_LABELS.accepted
          : target === 'rearm' ? REVIEW_LABELS.pending : REVIEW_LABELS[target],
      );
    }
  });

  it('verdictLabel is total over the BEARING set and matches decideSetLabel\'s applied labels', () => {
    // #3329 narrowed this from VERDICT_VALUES to BEARING_VERDICTS, and the narrowing is the claim, not a
    // weakening: every verdict that bears on the merge still MUST mirror a label, and the one that does not
    // bear is asserted to have no label just below. Derived from the enum + NON_BEARING so a seventh member
    // lands on one side or the other rather than escaping both.
    expect(BEARING_VERDICTS).toEqual(VERDICT_VALUES.filter((v) => v !== VERDICTS.OBSERVED));
    for (const v of BEARING_VERDICTS) expect(verdictLabel(v), `no label for bearing verdict ${v}`).toBeTruthy();
    expect(verdictLabel(VERDICTS.ACCEPTED)).toBe(REVIEW_LABELS.accepted);
    // `clear-human` ADDS review:accepted (decideSetLabel), so it mirrors to the same label.
    expect(verdictLabel(VERDICTS.CLEAR_HUMAN)).toBe(REVIEW_LABELS.accepted);
    expect(verdictLabel(VERDICTS.CHANGES)).toBe(REVIEW_LABELS.changes);
    expect(verdictLabel(VERDICTS.HUMAN)).toBe(REVIEW_LABELS.human);
    expect(verdictLabel(VERDICTS.PENDING)).toBe(REVIEW_LABELS.pending);
    expect(verdictLabel('nonsense')).toBeNull();
  });

  it('only accepted / clear-human clear; an unknown verdict never clears (fail closed)', () => {
    expect(verdictClears(VERDICTS.ACCEPTED)).toBe(true);
    expect(verdictClears(VERDICTS.CLEAR_HUMAN)).toBe(true);
    expect(verdictClears(VERDICTS.CHANGES)).toBe(false);
    expect(verdictClears(VERDICTS.PENDING)).toBe(false);
    expect(verdictClears(VERDICTS.HUMAN)).toBe(false);
    expect(verdictClears('')).toBe(false);
    expect(verdictClears('accepted-ish')).toBe(false);
  });

  it('refuses a malformed record rather than writing a half-shaped row', () => {
    expect(() => rec({ repo: 'not-a-repo' })).toThrow(/owner\/name/);
    expect(() => rec({ pr: 0 })).toThrow(/positive integer/);
    expect(() => rec({ verdict: 'merged' })).toThrow(/unknown verdict/);
    expect(() => rec({ at: 'yesterday' })).toThrow(/ISO-8601/);
    expect(() => buildVerdictRecord({ repo: REPO, pr: 1, verdict: VERDICTS.CHANGES, at: AT })).toThrow(/`source`/);
  });

  it('a malformed content witness degrades to null instead of failing the row', () => {
    // Losing a witness costs a fail-closed coverage test later; losing the ROW costs the verdict itself.
    const r = rec({ headSha: 'zzz', reviewedDiff: 'nope', reviewedContribution: 'f'.repeat(63) });
    expect(r.coverage).toEqual({ headSha: null, reviewedDiff: null, reviewedContribution: null });
  });

  it('caps and single-lines free text so one record is one small append', () => {
    const r = rec({ reason: `${'x'.repeat(5000)}\nsecond line`, declaredActor: 'a\nb' });
    expect(r.reason.length).toBeLessThanOrEqual(500);
    expect(r.reason).not.toContain('\n');
    expect(r.actor.declared).toBe('a b');
    expect(JSON.stringify(r).length).toBeLessThan(4096);
  });
});

describe('#3007 identity — what the actor block can and cannot prove', () => {
  it('every row states its claim, and the claim is only `sanctioned-path`', () => {
    expect(rec().actor.proves).toBe(ACTOR_PROVES);
    expect(ACTOR_PROVES).toBe('sanctioned-path');
  });

  it('`proves` is derived on read, so a forged row cannot upgrade its own claim', () => {
    const forged = { ...rec(), actor: { ...rec().actor, proves: 'human-verified-by-webauthn' } };
    const { valid, record } = validateVerdictRecord(forged);
    expect(valid).toBe(true);
    expect(record.actor.proves).toBe(ACTOR_PROVES);
  });

  it('`clears` is derived on read too — a row cannot say "changes, but it clears"', () => {
    const forged = { ...rec({ verdict: VERDICTS.CHANGES }), clears: true };
    const { record } = validateVerdictRecord(forged);
    expect(record.verdict).toBe(VERDICTS.CHANGES);
    expect(record.clears).toBe(false);
  });

  it('records the machine-checked independence status verbatim, including the benign self-clear', () => {
    // A subagent inherits its parent session id, so `self-clear` on a clear-human row is the ORDINARY
    // operator workflow (#2844 exemption), not an alarm. The ledger records the status; it does not judge it.
    const r = rec({ verdict: VERDICTS.CLEAR_HUMAN, independence: 'self-clear' });
    expect(r.actor.independence).toBe('self-clear');
    expect(r.clears).toBe(true);
  });
});

describe('#3007 append-only — records are added, never edited, and latest wins', () => {
  it('a newer verdict supersedes an older one for the same PR, with both rows retained', () => {
    const folded = foldVerdictLedger([
      rec({ pr: 7, verdict: VERDICTS.PENDING, at: '2026-08-10T10:00:00.000Z' }),
      rec({ pr: 7, verdict: VERDICTS.ACCEPTED, at: '2026-08-10T11:00:00.000Z' }),
    ]).get(7);
    expect(folded.current.verdict).toBe(VERDICTS.ACCEPTED);
    expect(folded.clears).toBe(true);
    expect(folded.history).toHaveLength(2);
    expect(folded.history[0].verdict).toBe(VERDICTS.PENDING);
  });

  it('a hold is cleared by a LATER clearing record, never by removing the hold', () => {
    const stream = [
      rec({ pr: 9, verdict: VERDICTS.HUMAN, at: '2026-08-10T10:00:00.000Z' }),
      rec({ pr: 9, verdict: VERDICTS.CLEAR_HUMAN, at: '2026-08-10T11:00:00.000Z', declaredActor: 'nic' }),
    ];
    const folded = foldVerdictLedger(stream).get(9);
    expect(folded.clears).toBe(true);
    expect(folded.outstandingHolds).toEqual([]);
    // The hold row is STILL THERE — clearing is an addition, not a deletion.
    expect(folded.history.map((r) => r.verdict)).toEqual([VERDICTS.HUMAN, VERDICTS.CLEAR_HUMAN]);
  });

  it('a hold appended AFTER a clearance is outstanding again (the re-hold shape)', () => {
    const folded = foldVerdictLedger([
      rec({ pr: 9, verdict: VERDICTS.CLEAR_HUMAN, at: '2026-08-10T10:00:00.000Z' }),
      rec({ pr: 9, verdict: VERDICTS.HUMAN, at: '2026-08-10T11:00:00.000Z', reason: 'stale acceptance' }),
    ]).get(9);
    expect(folded.clears).toBe(false);
    expect(folded.outstandingHolds).toHaveLength(1);
    expect(folded.outstandingHolds[0].reason).toBe('stale acceptance');
  });

  it('folds many PRs independently and keeps append order per PR', () => {
    const folded = foldVerdictLedger([
      rec({ pr: 1, verdict: VERDICTS.CHANGES }),
      rec({ pr: 2, verdict: VERDICTS.ACCEPTED }),
      rec({ pr: 1, verdict: VERDICTS.ACCEPTED }),
    ]);
    expect(folded.get(1).current.verdict).toBe(VERDICTS.ACCEPTED);
    expect(folded.get(1).history).toHaveLength(2);
    expect(folded.get(2).history).toHaveLength(1);
  });

  it('an empty / garbage stream folds to an empty ledger rather than throwing', () => {
    expect(foldVerdictLedger([]).size).toBe(0);
    expect(foldVerdictLedger(null).size).toBe(0);
    expect(foldVerdictLedger([null, 42, {}]).size).toBe(0);
  });
});

describe('#3007 log parsing — tolerant, never throws', () => {
  it('skips blank, unparseable and schema-invalid lines and keeps the rest in order', () => {
    const good = serializeVerdictRecord(rec({ pr: 3 }));
    const good2 = serializeVerdictRecord(rec({ pr: 4, verdict: VERDICTS.CHANGES }));
    expect(good.ok).toBe(true);
    const text = [
      '',
      '   ',
      '{not json',
      JSON.stringify({ v: 1, kind: 'something.else', repo: REPO, pr: 5, verdict: 'accepted', at: AT }),
      JSON.stringify({ v: 1, kind: VERDICT_LEDGER_KIND, repo: REPO, pr: 6, verdict: 'bogus', at: AT }),
      good.line,
      good2.line,
    ].join('\n');
    const parsed = parseVerdictLog(text);
    expect(parsed.map((r) => r.pr)).toEqual([3, 4]);
  });

  it('serialize refuses an invalid record and reports why (nothing is written)', () => {
    const bad = serializeVerdictRecord({ v: 1, kind: VERDICT_LEDGER_KIND, repo: 'x', pr: -1, verdict: 'nope', at: 'no' });
    expect(bad.ok).toBe(false);
    expect(bad.line).toBeNull();
    expect(bad.errors.join(' ')).toMatch(/repo/);
    expect(bad.errors.join(' ')).toMatch(/pr/);
  });

  it('round-trips a record through serialize → parse unchanged', () => {
    const r = rec({ pr: 11, headSha: 'b'.repeat(40), reviewedDiff: 'c'.repeat(64), findingCount: 3 });
    const [back] = parseVerdictLog(serializeVerdictRecord(r).line);
    expect(back).toEqual(r);
  });
});

describe('#3007 THE KEY — a rebase that breaks the fingerprint must NOT break the record', () => {
  // The card asked for records "keyed by PR + the diff content-hash the verdict covered". #3046 and #3052
  // proved that digest DIVERGED on a byte-identical contribution; #3054 has since repaired it, and the key is
  // STILL `repo` + `pr` + append order — see the first test for the reason that outlived the repair.

  it('#3046 is FIXED — that same base move no longer diverges the digest, and the key still is not it', () => {
    // One contribution, two bases: `main` grew a DIFFERENT number of lines above each of the two hunks
    // (a non-uniform base move). Every `+`/`-` line, hunk length and section heading is identical.
    const diffAt = (startA, startB) => [
      'diff --git a/src/thing.mjs b/src/thing.mjs',
      'index 1111111..2222222 100644',
      '--- a/src/thing.mjs',
      '+++ b/src/thing.mjs',
      `@@ -${startA},6 +${startA},7 @@ export function alpha() {`,
      '   one();',
      '   two();',
      '   three();',
      '+  guard();',
      '   four();',
      '   five();',
      `@@ -${startB},6 +${startB},7 @@ export function beta() {`,
      '   six();',
      '   seven();',
      '   eight();',
      '+  guard();',
      '   nine();',
      '   ten();',
      '',
    ].join('\n');
    // accept-time: hunks at 100 and 200 (gap 100). post-rebase: main grew 15 lines above the first hunk and 4
    // above the second → 115 and 219 (gap 104). Same contribution, different digest.
    const before = normalizeContributionFingerprint(diffAt(100, 200));
    const after = normalizeContributionFingerprint(diffAt(115, 219));
    expect(before).toBeTruthy();
    expect(after).toBeTruthy();
    // #3054 (via #3046/#3052) dropped both base-derived position signals, so this now HOLDS. The key decision
    // below is unchanged by that, and this test is kept rather than deleted to say why: the digest is a
    // COVERAGE witness, not an identity. It is still not usable as a lookup key, for a reason the repair did
    // not remove and deliberately widened — two DIFFERENT contributions collide whenever one is a relocation of
    // the other (#3021, open, pinned in `we:scripts/lib/__tests__/review-escalation.test.mjs`). A key that two
    // different verdicts can share is worse than one that a rebase breaks.
    expect(after).toBe(before);
  });

  it('the ledger record for that PR is still found after the digest diverges', () => {
    // THE WHOLE POINT. A record keyed on the digest would be unreachable after the rebase above. Keyed on
    // repo + pr + append order, the clearance is still the live verdict, and the stale witness is visible as
    // data rather than as a lost row.
    const cleared = rec({ pr: 1106, verdict: VERDICTS.CLEAR_HUMAN, reviewedContribution: 'a'.repeat(64) });
    const folded = foldVerdictLedger([cleared]).get(1106);
    expect(folded.current.verdict).toBe(VERDICTS.CLEAR_HUMAN);
    expect(folded.clears).toBe(true);
    expect(folded.current.coverage.reviewedContribution).toBe('a'.repeat(64));
  });

  it('ledgerCoversHead delegates to acceptanceCoversHead — one staleness rule, not a second one', () => {
    const r = rec({ pr: 5, headSha: 'a'.repeat(40), reviewedContribution: 'c'.repeat(64) });
    // Same head → covered.
    expect(ledgerCoversHead({ record: r, headSha: 'a'.repeat(40) }).covers).toBe(true);
    // Head moved, contribution witness matches → covered by the #x9xqexm escape, inherited not re-derived.
    expect(ledgerCoversHead({
      record: r, headSha: 'b'.repeat(40), headContribution: 'c'.repeat(64),
    }).covers).toBe(true);
    // Head moved, witnesses differ → stale, exactly as the shared gate says.
    const stale = ledgerCoversHead({ record: r, headSha: 'b'.repeat(40), headContribution: 'd'.repeat(64) });
    expect(stale.covers).toBe(false);
    expect(stale.reason).toMatch(/head advanced/);
    // No record → nothing to contradict, fails OPEN like the shared gate on a missing marker.
    expect(ledgerCoversHead({ record: null, headSha: 'b'.repeat(40) }).covers).toBe(true);
  });
});

describe('#3007 PHASE-1 CHECKER — ledger vs label', () => {
  const folded = (verdict, over = {}) => foldVerdictLedger([rec({ pr: 1, verdict, ...over })]).get(1);
  const L = (...names) => names.map((name) => ({ name }));

  it('labelVerdictOf uses decideReviewGate precedence: accepted → changes → human → pending', () => {
    expect(labelVerdictOf(L(REVIEW_LABELS.accepted, REVIEW_LABELS.human))).toBe(VERDICTS.ACCEPTED);
    expect(labelVerdictOf(L(REVIEW_LABELS.changes, REVIEW_LABELS.human))).toBe(VERDICTS.CHANGES);
    expect(labelVerdictOf(L(REVIEW_LABELS.human, REVIEW_LABELS.pending))).toBe(VERDICTS.HUMAN);
    expect(labelVerdictOf(L(REVIEW_LABELS.pending))).toBe(VERDICTS.PENDING);
    expect(labelVerdictOf(L('size/S'))).toBeNull();
    expect(labelVerdictOf([])).toBeNull();
  });

  it('agrees when the two sides match', () => {
    const row = compareLedgerToLabels({ pr: 1, labels: L(REVIEW_LABELS.accepted), folded: folded(VERDICTS.ACCEPTED) });
    expect(row.status).toBe(AGREEMENT.AGREE);
    expect(row.direction).toBeNull();
  });

  it('agrees when a clear-human row faces the review:accepted label it applies', () => {
    const row = compareLedgerToLabels({
      pr: 1, labels: L(REVIEW_LABELS.accepted), folded: folded(VERDICTS.CLEAR_HUMAN),
    });
    expect(row.status).toBe(AGREEMENT.AGREE);
  });

  it('flags the DANGEROUS direction: the ledger holds while the label clears', () => {
    const row = compareLedgerToLabels({ pr: 1, labels: L(REVIEW_LABELS.accepted), folded: folded(VERDICTS.HUMAN) });
    expect(row.status).toBe(AGREEMENT.DISAGREE);
    expect(row.direction).toBe(DISAGREE_DIRECTION.LEDGER_HOLDS_LABEL_CLEARS);
    expect(row.ledgerClears).toBe(false);
    expect(row.labelClears).toBe(true);
  });

  it('flags the safe direction separately: the ledger clears while the label holds', () => {
    const row = compareLedgerToLabels({ pr: 1, labels: L(REVIEW_LABELS.human), folded: folded(VERDICTS.CLEAR_HUMAN) });
    expect(row.status).toBe(AGREEMENT.DISAGREE);
    expect(row.direction).toBe(DISAGREE_DIRECTION.LEDGER_CLEARS_LABEL_HOLDS);
  });

  it('flags a same-side divergence (both hold, different labels) without calling it dangerous', () => {
    const row = compareLedgerToLabels({ pr: 1, labels: L(REVIEW_LABELS.pending), folded: folded(VERDICTS.CHANGES) });
    expect(row.status).toBe(AGREEMENT.DISAGREE);
    expect(row.direction).toBe(DISAGREE_DIRECTION.SAME_SIDE);
  });

  it('reports an unledgered label separately from a disagreement', () => {
    const row = compareLedgerToLabels({ pr: 1, labels: L(REVIEW_LABELS.pending), folded: null });
    expect(row.status).toBe(AGREEMENT.UNLEDGERED);
    expect(row.detail).toMatch(/park path/);
  });

  it('reports an orphan ledger row with no label at all', () => {
    const row = compareLedgerToLabels({ pr: 1, labels: L('size/M'), folded: folded(VERDICTS.ACCEPTED) });
    expect(row.status).toBe(AGREEMENT.UNLABELED);
  });

  it('a PR with neither a row nor a label is agreement, not a finding', () => {
    const row = compareLedgerToLabels({ pr: 1, labels: [], folded: null });
    expect(row.status).toBe(AGREEMENT.AGREE);
  });

  it('summarizes into the Phase-2 decision, counting the two hazards apart', () => {
    const rows = [
      compareLedgerToLabels({ pr: 1, labels: L(REVIEW_LABELS.accepted), folded: folded(VERDICTS.ACCEPTED) }),
      compareLedgerToLabels({ pr: 2, labels: L(REVIEW_LABELS.accepted), folded: folded(VERDICTS.HUMAN) }),
      compareLedgerToLabels({ pr: 3, labels: L(REVIEW_LABELS.pending), folded: null }),
    ];
    const s = summarizeAgreement(rows);
    expect(s.total).toBe(3);
    expect(s.counts).toEqual({ agree: 1, disagree: 1, unledgered: 1, unlabeled: 0 });
    expect(s.dangerous.map((r) => r.pr)).toEqual([2]);
    expect(s.owedBeforePhase2).toBe(1);
    expect(s.phase2Safe).toBe(false);
  });

  it('phase2Safe is true only with zero disagreements AND zero unledgered labels', () => {
    const clean = summarizeAgreement([
      compareLedgerToLabels({ pr: 1, labels: L(REVIEW_LABELS.accepted), folded: folded(VERDICTS.ACCEPTED) }),
    ]);
    expect(clean.phase2Safe).toBe(true);
    const owed = summarizeAgreement([compareLedgerToLabels({ pr: 1, labels: L(REVIEW_LABELS.human), folded: null })]);
    expect(owed.phase2Safe).toBe(false);
    expect(owed.counts.disagree).toBe(0);
  });
});

describe('#3007 IO — the machine-global home, the locked append, the tolerant read', () => {
  let dir;
  const prevDir = process.env.WE_VERDICT_LEDGER_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'we-verdict-ledger-'));
    process.env.WE_VERDICT_LEDGER_DIR = dir;
  });
  afterEach(() => {
    if (prevDir === undefined) delete process.env.WE_VERDICT_LEDGER_DIR;
    else process.env.WE_VERDICT_LEDGER_DIR = prevDir;
    rmSync(dir, { recursive: true, force: true });
    rmSync(`${dir}-locks`, { recursive: true, force: true });
  });

  it('anchors the ledger to HOME, not to the checkout — a per-clone ledger cannot be a merge authority', () => {
    // A lane clone, the primary and the drain's own dedicated clone must all read ONE file, so the home is
    // HOME-anchored exactly like `DRAIN_LOCK_ROOT`. Asserted on the pure resolver: `verdictLedgerDir()` is
    // deliberately redirected under vitest so no test can write to the operator's real ledger.
    expect(defaultVerdictLedgerDir('/Users/someone')).toBe(join('/Users/someone', '.claude', 'verdict-ledger'));
    expect(defaultVerdictLedgerDir('/Users/someone').startsWith(process.cwd())).toBe(false);
  });

  it('never resolves to the real home under a test run, even with no explicit redirect', () => {
    delete process.env.WE_VERDICT_LEDGER_DIR;
    const underTest = verdictLedgerDir();
    process.env.WE_VERDICT_LEDGER_DIR = dir;
    expect(process.env.VITEST).toBeTruthy();
    expect(underTest).not.toBe(defaultVerdictLedgerDir());
    expect(underTest).toBe(join(tmpdir(), 'we-verdict-ledger-vitest'));
  });

  it('one file per repo, named reversibly', () => {
    expect(verdictLedgerPath(REPO)).toBe(join(dir, 'web-everything-web-everything.jsonl'));
  });

  it('appends, reads back, and folds', () => {
    expect(appendVerdict(rec({ pr: 20, verdict: VERDICTS.PENDING })).ok).toBe(true);
    expect(appendVerdict(rec({ pr: 20, verdict: VERDICTS.ACCEPTED })).ok).toBe(true);
    expect(appendVerdict(rec({ pr: 21, verdict: VERDICTS.CHANGES })).ok).toBe(true);
    expect(readVerdictLedger(REPO)).toHaveLength(3);
    const folded = foldRepo(REPO);
    expect(folded.get(20).current.verdict).toBe(VERDICTS.ACCEPTED);
    expect(folded.get(20).history).toHaveLength(2);
    expect(folded.get(21).clears).toBe(false);
    expect(listLedgerRepos()).toEqual(['web-everything-web-everything']);
  });

  it('reads persisted shadow/human evidence through the offline agreement CLI', () => {
    expect(appendVerdict(shadow()).ok).toBe(true);
    expect(appendVerdict(rec({ verdict: VERDICTS.CHANGES, declaredActor: 'nic' })).ok).toBe(true);
    expect(readVerdictLedger(REPO)[0]).toMatchObject({ mode: 'shadow', wouldClear: true, clears: false });
    const out = execFileSync(process.execPath, ['scripts/lib/verdict-ledger.mjs', 'shadow-agreement',
      `--repo=${REPO}`, '--human-actor=nic', '--json'], { encoding: 'utf8', env: process.env });
    expect(JSON.parse(out)).toMatchObject({ total: 1, agree: 0, disagree: 1, unmatched: [] });
  });

  it('each append is exactly one newline-terminated line (so one write is one record)', () => {
    appendVerdict(rec({ pr: 30 }));
    appendVerdict(rec({ pr: 31 }));
    const text = readFileSync(verdictLedgerPath(REPO), 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(text.trim().split('\n')).toHaveLength(2);
    for (const line of text.trim().split('\n')) expect(() => JSON.parse(line)).not.toThrow();
  });

  it('takes the writer lock — the card\'s "the drain lease guarantees a single writer" does not hold here', () => {
    // Every writer reaches the ledger through review-set-label.mjs, whose callers (the /review ceremony, the
    // #3035 operation, the console, the conveyor rearm) hold NO drain lease. So the append locks for itself.
    const r = appendVerdict(rec({ pr: 40 }));
    expect(r.ok).toBe(true);
    expect(r.locked).toBe(true);
    expect(r.record.unlocked).toBeUndefined();
  });

  it('a lock it cannot take costs the ROW A FLAG, never the record', () => {
    // Simulate a live holder by planting the lock dir the primitive uses, then confirm the verdict survives.
    const lockRoot = `${dir}-locks`;
    const held = lockDirFor(lockRoot, '<verdict-ledger:append>');
    mkdirSync(held, { recursive: true });
    writeFileSync(join(held, 'lock.json'), `${JSON.stringify(
      makeLockEntry('someone-else', '<verdict-ledger:append>', new Date().toISOString(), 999999), null, 2,
    )}\n`, 'utf8');

    const r = appendVerdict(rec({ pr: 41, verdict: VERDICTS.CHANGES }));
    expect(r.ok).toBe(true);
    expect(r.locked).toBe(false);
    // The record landed AND says the weaker case applied, rather than being silently dropped.
    expect(readVerdictLedger(REPO).map((x) => x.pr)).toContain(41);
    expect(readVerdictLedger(REPO).find((x) => x.pr === 41).unlocked).toBe(true);
  });

  it('refuses an invalid record and writes nothing', () => {
    const bad = appendVerdict({ v: 1, kind: VERDICT_LEDGER_KIND, repo: REPO, pr: 1, verdict: 'nope', at: AT });
    expect(bad.ok).toBe(false);
    expect(bad.errors.length).toBeGreaterThan(0);
    expect(readVerdictLedger(REPO)).toEqual([]);
  });

  it('a missing ledger reads as empty rather than throwing', () => {
    expect(readVerdictLedger('someone/else')).toEqual([]);
    expect(foldRepo('someone/else').size).toBe(0);
  });

  it('#3329 — an observed row round-trips through the real append/read/fold path', () => {
    expect(appendVerdict(rec({ pr: 60, verdict: VERDICTS.ACCEPTED })).ok).toBe(true);
    expect(appendVerdict(rec({ pr: 60, verdict: VERDICTS.OBSERVED, reason: 'advisory look' })).ok).toBe(true);
    expect(readVerdictLedger(REPO)).toHaveLength(2);
    const folded = foldRepo(REPO).get(60);
    expect(folded.history.map((r) => r.verdict)).toEqual([VERDICTS.ACCEPTED, VERDICTS.OBSERVED]);
    expect(folded.current.verdict).toBe(VERDICTS.ACCEPTED);
    expect(folded.clears).toBe(true);
    expect(folded.outstandingHolds).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// #3329 — THE NON-BEARING `observed` VERDICT.
//
// The happy path (the enum validates, the label is null) is the easy half and would ship the bug on its own.
// The half that matters is the ENFORCEMENT: `observed` must not satisfy anything `accepted` satisfies, and it
// must not create a hold either. Every question this repo asks of the verdict ledger is enumerated below and
// answered for `observed` — including the ones asked from OUTSIDE this module, which is where a "soft accept"
// would actually do its damage.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A label array in the `{name}` shape `hasReviewLabel` reads. */
const LBL = (...names) => names.map((name) => ({ name }));

describe('#3329 `observed` — the vocabulary', () => {
  it('buildVerdictRecord accepts it and stamps clears:false', () => {
    const r = rec({ pr: 3329, verdict: VERDICTS.OBSERVED, reason: 'advisory look, nothing actionable' });
    expect(r.verdict).toBe('observed');
    expect(r.clears).toBe(false);
    expect(VERDICT_VALUES).toContain(VERDICTS.OBSERVED);
    // A review that ran and found nothing still says so: zero findings is a number, not an absence.
    expect(rec({ verdict: VERDICTS.OBSERVED, findingCount: 0 }).findingCount).toBe(0);
  });

  it('is NON-BEARING, and bearingness fails closed the opposite way to clearing', () => {
    expect(verdictBears(VERDICTS.OBSERVED)).toBe(false);
    expect(NON_BEARING).toEqual([VERDICTS.OBSERVED]);
    for (const v of BEARING_VERDICTS) expect(verdictBears(v), `${v} must bear`).toBe(true);
    // The export is a genuinely immutable list, not a frozen Set an importer could still `.add()` to — which
    // would be a public handle for making a CLEARING verdict non-bearing.
    expect(Object.isFrozen(NON_BEARING)).toBe(true);
    expect(() => { NON_BEARING.push(VERDICTS.ACCEPTED); }).toThrow();
    expect(verdictBears(VERDICTS.ACCEPTED)).toBe(true);
    // Only an ENROLLED member is non-bearing. An unknown word BEARS (→ a hold, since it does not clear), which
    // is the safe direction: a typo'd verdict must not vanish from the disposition.
    expect(verdictBears('observd')).toBe(true);
    expect(verdictClears('observd')).toBe(false);
  });

  it('does not clear, by any spelling', () => {
    expect(verdictClears(VERDICTS.OBSERVED)).toBe(false);
    expect(verdictClears('observed')).toBe(false);
  });

  it('mirrors NO label — explicitly, not by falling through the default', () => {
    expect(verdictLabel(VERDICTS.OBSERVED)).toBeNull();
    // …and no review label projects BACK to it either, so the label side cannot manufacture one.
    for (const label of Object.values(REVIEW_LABELS)) {
      expect(labelVerdictOf(LBL(label)), `${label} must not project to observed`).not.toBe(VERDICTS.OBSERVED);
    }
  });

  it('has no label-swap target — an invented `--to=observed` fails closed to null', () => {
    // The single home derives a row's verdict from `--to` through THIS function, and the reconciling sink
    // (`we:scripts/operations/review-pr-io.mjs`) refuses a null verdict rather than guessing — so there is no
    // path by which a label swap writes an `observed` row. The producer (#3330) writes it directly.
    expect(verdictForLabelTarget('observed')).toBeNull();
    expect(REVIEW_LABEL_TARGETS).not.toContain('observed');
  });
});

describe('#3329 `observed` — the fold, which is where non-bearing is ENFORCED', () => {
  it('THE REGRESSION THAT MATTERS: [accepted, observed] stays cleared with no phantom hold', () => {
    // Marking `observed` merely non-CLEARING would have shipped this bug. The fold assigns clears for EVERY
    // row, last-wins, then calls every non-clearing row after the last clear an outstanding hold — so an
    // advisory note appended after an acceptance would have re-held a cleared PR.
    const folded = foldVerdictLedger([
      rec({ pr: 100, verdict: VERDICTS.ACCEPTED, at: '2026-08-26T10:00:00.000Z' }),
      rec({ pr: 100, verdict: VERDICTS.OBSERVED, at: '2026-08-26T11:00:00.000Z', reason: 'advisory look' }),
    ]).get(100);
    expect(folded.clears).toBe(true);
    expect(folded.outstandingHolds).toEqual([]);
    expect(folded.current.verdict).toBe(VERDICTS.ACCEPTED);
    // It IS recorded — it is simply invisible to the disposition. That is the whole shape of the item.
    expect(folded.history.map((r) => r.verdict)).toEqual([VERDICTS.ACCEPTED, VERDICTS.OBSERVED]);
  });

  it('never becomes `current`, however many of them are appended', () => {
    const folded = foldVerdictLedger([
      rec({ pr: 101, verdict: VERDICTS.ACCEPTED, at: '2026-08-26T10:00:00.000Z' }),
      rec({ pr: 101, verdict: VERDICTS.OBSERVED, at: '2026-08-26T11:00:00.000Z' }),
      rec({ pr: 101, verdict: VERDICTS.OBSERVED, at: '2026-08-26T12:00:00.000Z' }),
    ]).get(101);
    expect(folded.current.verdict).toBe(VERDICTS.ACCEPTED);
    expect(folded.clears).toBe(true);
    expect(folded.history).toHaveLength(3);
  });

  it('does not ANSWER a standing hold either — a hold is only ever ended by a clearing row', () => {
    const folded = foldVerdictLedger([
      rec({ pr: 102, verdict: VERDICTS.CHANGES, at: '2026-08-26T10:00:00.000Z', reason: 'fix the guard' }),
      rec({ pr: 102, verdict: VERDICTS.OBSERVED, at: '2026-08-26T11:00:00.000Z' }),
    ]).get(102);
    expect(folded.clears).toBe(false);
    expect(folded.current.verdict).toBe(VERDICTS.CHANGES);
    // Exactly ONE outstanding hold: the `changes`. The observed row is neither a second hold nor an answer.
    expect(folded.outstandingHolds.map((r) => r.verdict)).toEqual([VERDICTS.CHANGES]);
  });

  it('a PR with ONLY observed rows has no live verdict and does not clear', () => {
    const folded = foldVerdictLedger([
      rec({ pr: 103, verdict: VERDICTS.OBSERVED, at: '2026-08-26T10:00:00.000Z', reason: 'reviewed, nothing actionable' }),
    ]).get(103);
    expect(folded.current).toBeNull();
    expect(folded.clears).toBe(false);
    expect(folded.outstandingHolds).toEqual([]);
    // The review IS on the record — this is the situation the item exists for: a review ran and, before this,
    // the ledger held no evidence it had happened at all.
    expect(folded.history).toHaveLength(1);
    expect(folded.history[0].reason).toBe('reviewed, nothing actionable');
  });

  it('an observed-only PR is not made mergeable by the Phase-2 coverage affordance', () => {
    // `ledgerCoversHead({record: null})` answers `covers: true`, and that is safe: coverage is the SECOND
    // question, asked of a verdict that already clears. The folded `clears` is what gates, and it says no.
    const folded = foldVerdictLedger([rec({ pr: 104, verdict: VERDICTS.OBSERVED })]).get(104);
    expect(ledgerCoversHead({ record: folded.current, headSha: 'a'.repeat(40) }).covers).toBe(true);
    expect(folded.clears).toBe(false);
  });
});

describe('#3329 `observed` satisfies NOTHING that `accepted` satisfies', () => {
  // Each row is one live question meaning "has this been reviewed / may this land?". `accepted` answers yes;
  // `observed` must answer no to every one of them. Written as a table so a NEW gate added later is a one-line
  // addition here rather than a question nobody re-asked.
  const asked = [
    ['verdictClears', (v) => verdictClears(v)],
    ['fold → clears', (v) => foldVerdictLedger([rec({ pr: 200, verdict: v })]).get(200).clears],
    ['fold → current is a verdict', (v) => foldVerdictLedger([rec({ pr: 201, verdict: v })]).get(201).current != null],
    ['verdictLabel (mirrors any label)', (v) => verdictLabel(v) != null],
    ['verdictLabel === review:accepted', (v) => verdictLabel(v) === REVIEW_LABELS.accepted],
    ['pr-status ROUND_VERDICTS (counts as a review round)', (v) => ROUND_VERDICTS.includes(v)],
    ['pr-status owedFromLedgerVerdict === none (nothing owed)', (v) => owedFromLedgerVerdict(v) === 'none'],
  ];

  for (const [name, ask] of asked) {
    it(`${name}: accepted → yes, observed → no`, () => {
      expect(ask(VERDICTS.ACCEPTED), `accepted must satisfy: ${name}`).toBe(true);
      expect(ask(VERDICTS.OBSERVED), `observed must NOT satisfy: ${name}`).toBe(false);
    });
  }

  it('the drain\'s real merge gate is label-driven, and observed writes no label to drive it', () => {
    // `decideReviewGate` (`we:scripts/lib/review-escalation.mjs`) is what actually decides whether the drain
    // lands a PR today, and it reads ONLY labels. An `observed` row mirrors no label, so the gate cannot see
    // it however many rows exist — the PR parks exactly as it would with an empty ledger.
    // xvzc4v4: a matching accepted/head SHA — the SHA-coverage gate is a separate concern from this test.
    expect(decideReviewGate({ escalate: true, labels: LBL(REVIEW_LABELS.accepted), acceptedSha: 'abc1234', headSha: 'abc1234' }).action).toBe('merge');
    expect(decideReviewGate({ escalate: true, labels: [] }).action).toBe('park');
    expect(verdictLabel(VERDICTS.OBSERVED)).toBeNull();
  });

  it('does not inflate the review-round count either consumer reports', () => {
    // pr-status counts one qualifying ROW as one round. An advisory look is a review that happened, but it is
    // not a round of the fix loop, and counting it would put a round on the board against a cap.
    const records = [
      rec({ pr: 300, verdict: VERDICTS.CHANGES }),
      rec({ pr: 300, verdict: VERDICTS.OBSERVED }),
      rec({ pr: 300, verdict: VERDICTS.OBSERVED }),
    ];
    expect(reviewRoundsFromVerdictLedger(records, 300)).toBe(1);
    // …and the review-pr operation's own round count (`priorRoundsFor`) reads `outstandingHolds`, which holds
    // exactly the one `changes` row.
    expect(foldVerdictLedger(records).get(300).outstandingHolds).toHaveLength(1);
  });
});

describe('#3329 `observed` and the Phase-1 drift checker', () => {
  it('is never reported as a disagreement or as an orphan row', () => {
    const folded = foldVerdictLedger([
      rec({ pr: 400, verdict: VERDICTS.ACCEPTED }),
      rec({ pr: 400, verdict: VERDICTS.OBSERVED }),
    ]);
    const row = compareLedgerToLabels({ pr: 400, labels: LBL(REVIEW_LABELS.accepted), folded: folded.get(400) });
    expect(row.status).toBe(AGREEMENT.AGREE);
    expect(row.ledgerVerdict).toBe(VERDICTS.ACCEPTED);
    expect(summarizeAgreement([row]).counts.disagree).toBe(0);
  });

  it('an observed-only PR with NO label is kept out of the comparison set entirely', () => {
    // Admitting it would add a row whose ledger side is empty and whose label side is empty — scored `agree`,
    // inflating the total with a PR that was never a comparison and diluting the ratio Phase 2 is decided on.
    const folded = foldVerdictLedger([rec({ pr: 401, verdict: VERDICTS.OBSERVED })]);
    expect(folded.has(401)).toBe(true);
    expect(buildRows({ prs: [{ number: 401, labels: [] }], folded })).toEqual([]);
    // The control: the same PR with a BEARING row IS admitted, so the filter narrows on bearingness and not on
    // something incidental.
    const bearing = foldVerdictLedger([rec({ pr: 401, verdict: VERDICTS.CHANGES })]);
    expect(buildRows({ prs: [{ number: 401, labels: [] }], folded: bearing })).toHaveLength(1);
  });

  it('an observed row does not excuse a label that has no verdict behind it', () => {
    // The label side is still unbacked, and `unledgered` is a Phase-2 precondition count. An advisory look
    // must not quietly discharge it.
    const folded = foldVerdictLedger([rec({ pr: 402, verdict: VERDICTS.OBSERVED })]);
    const rows = buildRows({ prs: [{ number: 402, labels: LBL(REVIEW_LABELS.pending) }], folded });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe(AGREEMENT.UNLEDGERED);
    expect(summarizeAgreement(rows).owedBeforePhase2).toBe(1);
    expect(summarizeAgreement(rows).phase2Safe).toBe(false);
  });
});

describe('#3329 a MALFORMED observed row is caught by the ledger check', () => {
  const wellFormed = () => JSON.parse(JSON.stringify(rec({ pr: 500, verdict: VERDICTS.OBSERVED })));

  it('the well-formed row validates, so the negatives below are about the defect and not the shape', () => {
    const { valid, errors } = validateVerdictRecord(wellFormed());
    expect(valid).toBe(true);
    expect(errors).toEqual([]);
  });

  it.each([
    ['bad kind', (r) => { r.kind = 'we.something-else'; }, /kind/],
    ['bad repo', (r) => { r.repo = 'not-a-repo'; }, /repo/],
    ['bad pr', (r) => { r.pr = 0; }, /pr/],
    ['bad timestamp', (r) => { r.at = 'yesterday'; }, /at/],
    ['near-miss verdict', (r) => { r.verdict = 'observe'; }, /verdict/],
    ['missing version', (r) => { delete r.v; }, /v/],
  ])('rejects an observed row with a %s', (_name, mangle, pattern) => {
    const raw = wellFormed();
    mangle(raw);
    const { valid, errors } = validateVerdictRecord(raw);
    expect(valid).toBe(false);
    expect(errors.join(' ')).toMatch(pattern);
    // …nothing is serialized for it, and a file containing it folds to nothing for that PR.
    expect(serializeVerdictRecord(raw).ok).toBe(false);
    expect(parseVerdictLog(JSON.stringify(raw))).toEqual([]);
  });

  it('a FORGED observed row claiming clears:true is neutralized on read AND on write', () => {
    // This is the one malformation that would matter: a hand-edited or forged row asserting that an advisory
    // look cleared the merge. `clears` is DERIVED, never trusted from the line, in both directions.
    const forged = { ...wellFormed(), clears: true };
    expect(validateVerdictRecord(forged).record.clears).toBe(false);
    expect(JSON.parse(serializeVerdictRecord(forged).line).clears).toBe(false);
    expect(parseVerdictLog(JSON.stringify(forged))[0].clears).toBe(false);
    // And the fold ignores the claim whatever the line says, because bearingness is read off the VERDICT.
    expect(foldVerdictLedger(parseVerdictLog(JSON.stringify(forged))).get(500).clears).toBe(false);
  });

  it('a malformed observed row never takes a valid neighbour down with it', () => {
    const text = [
      JSON.stringify(rec({ pr: 501, verdict: VERDICTS.ACCEPTED })),
      JSON.stringify({ ...wellFormed(), pr: 501, verdict: 'observe' }),
      JSON.stringify(rec({ pr: 501, verdict: VERDICTS.OBSERVED })),
    ].join('\n');
    const parsed = parseVerdictLog(text);
    expect(parsed.map((r) => r.verdict)).toEqual([VERDICTS.ACCEPTED, VERDICTS.OBSERVED]);
    expect(foldVerdictLedger(parsed).get(501).clears).toBe(true);
  });
});

describe('plan slice B: v2 event types round-trip, and the v1 fold is byte-identical', () => {
  const SHA = 'b'.repeat(40);
  const base = { repo: REPO, pr: 7, at: AT, source: 'test', writer: 'h:1:w', declaredActor: 'op', session: 's1', channel: 'c' };
  const payloads = {
    referral: { headSha: SHA, findingKeys: ['f1', 'f2'] },
    ruling: { findingKey: 'f1', ruling: 'block' },
    'review-run': { headSha: SHA, phase: 'completed', posted: false },
    hold: { reasonCode: 'load-flake', holdSource: 'drain' },
    release: { reasonCode: 'load-flake', holdSource: 'drain' },
    approval: { approval: 'judge', delegation: { by: 'op', scope: 'pr:7', expires: '2026-12-01T00:00:00.000Z' } },
    'send-back': { cause: 'block-ruling' },
    author: { author: 'agent-1' },
    'label-input': { label: 'review:human', sender: 'op', change: 'added' },
  };

  it('covers every non-verdict type in the closed set', () => {
    expect(Object.keys(payloads).sort()).toEqual(EVENT_TYPE_VALUES.filter((t) => t !== 'verdict').sort());
    expect(LEDGER_EVENT_VERSION).toBe(2);
  });

  it.each(Object.keys(payloads))('round-trips a %s event through serialize and parse', (type) => {
    const ev = buildLedgerEvent({ ...base, type, ...payloads[type] });
    expect(ev).toMatchObject({ v: 2, type, repo: REPO, pr: 7 });
    expect(ev).not.toHaveProperty('clears');
    const { ok, line } = serializeLedgerEvent(ev);
    expect(ok).toBe(true);
    expect(parseLedgerEvents(`${line}\n`)).toEqual([ev]);
    expect(serializeLedgerEvent(parseLedgerEvents(line)[0]).line).toBe(line);
  });

  it('defaults optional payload fields so they round-trip', () => {
    expect(buildLedgerEvent({ ...base, type: 'review-run', headSha: SHA, phase: 'started' }).posted).toBeNull();
    expect(buildLedgerEvent({ ...base, type: 'approval', approval: 'clear-human' }).delegation).toBeNull();
  });

  it.each([
    ['unknown type', { type: 'nope' }],
    ['verdict via the event builder', { type: 'verdict' }],
    ['bad ruling value', { type: 'ruling', findingKey: 'f', ruling: 'maybe' }],
    ['empty finding keys', { type: 'referral', headSha: SHA, findingKeys: [] }],
    ['bad head sha', { type: 'review-run', headSha: 'zz', phase: 'started' }],
    ['bad delegation', { type: 'approval', approval: 'judge', delegation: { by: 'x' } }],
    ['bad label change', { type: 'label-input', label: 'l', sender: 's', change: 'moved' }],
  ])('refuses %s', (_n, over) => {
    expect(() => buildLedgerEvent({ ...base, ...over })).toThrow(TypeError);
  });

  it('never throws on a bad raw line, and skips it', () => {
    expect(validateLedgerEvent(null).valid).toBe(false);
    expect(validateLedgerEvent({ v: 2, kind: VERDICT_LEDGER_KIND, type: 'ruling' }).valid).toBe(false);
    expect(parseLedgerEvents('not json\n{"type":"ruling"}\n\n')).toEqual([]);
  });

  it('reads a v1 row as type verdict without changing the row', () => {
    const v1 = rec();
    const [ev] = parseLedgerEvents(JSON.stringify(v1));
    expect(ev).toEqual({ type: 'verdict', ...v1 });
    expect(serializeLedgerEvent(v1).line).toBe(serializeVerdictRecord(v1).line);
    expect(validateVerdictRecord({ ...v1, type: 'verdict' }).valid).toBe(true);
  });

  it('bears: verdicts, referrals, rulings, holds, releases, approvals, send-backs; not review-run, author, label-input', () => {
    const bearing = EVENT_TYPE_VALUES.filter((t) => eventBears(t));
    expect(bearing).toEqual(['verdict', 'referral', 'ruling', 'hold', 'release', 'approval', 'send-back']);
    expect(EVENT_TYPES.REVIEW_RUN).toBe('review-run');
  });

  describe('the v1 readers never see a v2 event', () => {
    const D = 'a'.repeat(64);
    const mk = (pr, verdict, n, o = {}) => buildVerdictRecord({
      repo: 'o/r', pr, verdict, at: `2026-08-10T12:00:0${n}.000Z`, source: 't', writer: 'h:1:w', reason: 'r',
      headSha: SHA, reviewedDiff: D, declaredActor: 'x', session: 's', channel: 'c', ...o,
    });
    const v1 = [mk(1, 'pending', 1), mk(1, 'accepted', 2), mk(1, 'observed', 3, { mode: 'shadow', wouldClear: true }),
      mk(2, 'changes', 4, { findingCount: 2 }), mk(2, 'human', 5), mk(2, 'clear-human', 6), mk(3, 'observed', 7),
      mk(3, 'restamped', 8)];
    const v1Text = v1.map((r) => serializeVerdictRecord(r).line).join('\n');
    // Captured from the fold BEFORE the v2 types existed (main 803e314e2).
    const GOLDEN_SHA256 = '2841dea2f03f42e30baeccae09cfd9f83728446203f313dd71fa8d68fb46475a';
    const foldHash = (text) => createHash('sha256')
      .update(JSON.stringify([...foldVerdictLedger(parseVerdictLog(text)).values()])).digest('hex');

    it('v1 fold output matches the golden captured before v2', () => {
      expect(foldHash(v1Text)).toBe(GOLDEN_SHA256);
    });

    it('interleaving every v2 type leaves the v1 fold byte-identical', () => {
      const v2Lines = Object.keys(payloads)
        .map((type) => serializeLedgerEvent(buildLedgerEvent({ ...base, pr: 1, type, ...payloads[type] })).line);
      const mixed = [...v2Lines, ...v1Text.split('\n').flatMap((l, i) => [l, v2Lines[i % v2Lines.length]])].join('\n');
      expect(foldHash(mixed)).toBe(GOLDEN_SHA256);
      expect(parseVerdictLog(mixed)).toEqual(parseVerdictLog(v1Text));
      expect(parseLedgerEvents(mixed).filter((e) => e.type === 'verdict')).toHaveLength(v1.length);
    });
  });
});

describe('#3255 C2 dual-write: appendVerdict behind verdictLedger.store', () => {
  let dir;
  const prevDir = process.env.WE_VERDICT_LEDGER_DIR;
  const mk = (verdict, pr = 11) => buildVerdictRecord({
    repo: 'web-everything/web-everything', pr, verdict, at: '2026-10-07T12:00:00.000Z', source: 'test',
  });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'we-verdict-ledger-c2-'));
    process.env.WE_VERDICT_LEDGER_DIR = dir;
  });
  afterEach(() => {
    if (prevDir === undefined) delete process.env.WE_VERDICT_LEDGER_DIR;
    else process.env.WE_VERDICT_LEDGER_DIR = prevDir;
    rmSync(dir, { recursive: true, force: true });
    rmSync(`${dir}-locks`, { recursive: true, force: true });
  });
  const seam = () => {
    const calls = [];
    return { calls, gitAppend: (a) => { calls.push(a); return { status: 'appended' }; }, warn: () => {} };
  };

  it('store=dual finds the row in BOTH stores', () => {
    const s = seam();
    const r = appendVerdict(mk('accepted'), { store: 'dual', board: '/board', ...s });
    expect(r.ok).toBe(true);
    expect(readVerdictLedger('web-everything/web-everything')).toHaveLength(1);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]).toMatchObject({ board: '/board', repo: 'web-everything/web-everything' });
    expect(s.calls[0].records[0].verdict).toBe('accepted');
  });

  it('store=home leaves git untouched', () => {
    const s = seam();
    const r = appendVerdict(mk('accepted'), { store: 'home', board: '/board', ...s });
    expect(r.ok).toBe(true);
    expect(s.calls).toHaveLength(0);
    expect(readVerdictLedger('web-everything/web-everything')).toHaveLength(1);
  });

  it('default store is dual outside tests, home under a test run; both branches asserted explicitly', () => {
    expect(resolveLedgerStore('git', {})).toBe('git');
    // Outside a test run (an injected env bag with no under-test flag) the default — and any unrecognised value — is dual.
    expect(resolveLedgerStore(undefined, {})).toBe('dual');
    expect(resolveLedgerStore('nonsense', {})).toBe('dual');
    expect(resolveLedgerStore(undefined, { WE_VERDICT_LEDGER_STORE: 'bogus' })).toBe('dual');
    expect(resolveLedgerStore(undefined, { WE_VERDICT_LEDGER_STORE: ' HOME ' })).toBe('home');
    // Under a test run (either runner flag) an unconfigured store is home, but a named store is honoured.
    expect(resolveLedgerStore(undefined, { VITEST: 'true' })).toBe('home');
    expect(resolveLedgerStore('nonsense', { WE_UNDER_TEST: '1' })).toBe('home');
    expect(resolveLedgerStore('dual', { VITEST: 'true' })).toBe('dual');
    expect(DEFAULT_VERDICT_LEDGER_STORE).toBe('dual');
  });

  it('store=git writes git only', () => {
    const s = seam();
    const r = appendVerdict(mk('accepted'), { store: 'git', board: '/board', ...s });
    expect(r.ok).toBe(true);
    expect(s.calls).toHaveLength(1);
    expect(readVerdictLedger('web-everything/web-everything')).toHaveLength(0);
  });

  it('F4: a CLEARING row that misses git does not clear, is loud, and is not dropped', () => {
    const warns = [];
    const r = appendVerdict(mk('accepted'), {
      store: 'dual', board: '/board', gitAppend: () => { throw new Error('push exhausted'); }, warn: (m) => warns.push(m),
    });
    expect(r.ok).toBe(false);
    expect(r.ledgerWriteMiss).toBe(true);
    expect(r.errors.join()).toMatch(/ledger-write-miss: push exhausted/);
    expect(warns.join()).toMatch(/GIT WRITE MISS/);
    expect(readVerdictLedger('web-everything/web-everything')).toHaveLength(1);
  });

  it('F4: a HOLDING row that misses git still holds (ok) but flags ledgerWriteMiss', () => {
    const warns = [];
    const r = appendVerdict(mk('human'), {
      store: 'dual', board: '/board', gitAppend: () => { throw new Error('unreachable'); }, warn: (m) => warns.push(m),
    });
    expect(r.ok).toBe(true);
    expect(r.ledgerWriteMiss).toBe(true);
    expect(warns).toHaveLength(1);
  });

  it('a missing board is a loud miss, not a silent skip; store=git spills the row to home', () => {
    const warns = [];
    const r = appendVerdict(mk('human'), { store: 'git', warn: (m) => warns.push(m) });
    expect(r.ledgerWriteMiss).toBe(true);
    expect(warns.join()).toMatch(/no git board/);
    expect(readVerdictLedger('web-everything/web-everything')).toHaveLength(1);
  });

  it('an invalid record is refused and written nowhere', () => {
    const s = seam();
    const r = appendVerdict({ nope: true }, { store: 'dual', board: '/board', ...s });
    expect(r.ok).toBe(false);
    expect(s.calls).toHaveLength(0);
  });
});

describe('#3255 C2 review fix: the production default path, home-fails-too spill, store=git visibility', () => {
  let dir;
  const FLAGS = ['VITEST', 'WE_UNDER_TEST', 'WE_VERDICT_LEDGER_STORE', 'WE_VERDICT_LEDGER_BOARD'];
  const saved = {};
  const REPO = 'web-everything/web-everything';
  const mk = (verdict, pr = 21) => buildVerdictRecord({ repo: REPO, pr, verdict, at: '2026-10-07T12:00:00.000Z', source: 'test' });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'we-verdict-ledger-c2fix-'));
    for (const k of [...FLAGS, 'WE_VERDICT_LEDGER_DIR']) saved[k] = process.env[k];
    process.env.WE_VERDICT_LEDGER_DIR = dir;
  });
  afterEach(() => {
    for (const k of [...FLAGS, 'WE_VERDICT_LEDGER_DIR']) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    rmSync(dir, { recursive: true, force: true });
    rmSync(`${dir}-locks`, { recursive: true, force: true });
  });
  /** Run `fn` as production would see it: the under-test shims and every ledger env knob unset. */
  const asProduction = (fn) => {
    for (const k of FLAGS) delete process.env[k];
    return fn();
  };

  it('production default (no opts, no board env, test flags off): a clearing verdict is still ok:true and writes home, with no git attempt and no miss', () => {
    const r = asProduction(() => appendVerdict(mk('accepted'), { warn: () => {} }));
    expect(r.ok).toBe(true);
    expect(r.ledgerWriteMiss).toBeUndefined();
    expect(r.store).toBe('home');
    expect(readVerdictLedger(REPO)).toHaveLength(1);
  });

  it('production default with a board configured: dual-writes both stores', () => {
    const calls = [];
    const r = asProduction(() => appendVerdict(mk('accepted'), {
      board: '/board', gitAppend: (a) => { calls.push(a); return { status: 'appended' }; }, warn: () => {},
    }));
    expect(r.ok).toBe(true);
    expect(r.store).toBe('dual');
    expect(calls).toHaveLength(1);
    expect(readVerdictLedger(REPO)).toHaveLength(1);
  });

  it('production default with the board in env: dual-writes both stores', () => {
    const calls = [];
    const r = asProduction(() => {
      process.env.WE_VERDICT_LEDGER_BOARD = '/env-board';
      return appendVerdict(mk('accepted'), { gitAppend: (a) => { calls.push(a); return { status: 'appended' }; }, warn: () => {} });
    });
    expect(r.ok).toBe(true);
    expect(calls[0].board).toBe('/env-board');
  });

  it('an EXPLICIT dual/git store with no board stays a loud miss (only the unconfigured default falls back to home)', () => {
    const warns = [];
    const r = asProduction(() => appendVerdict(mk('accepted'), { store: 'dual', warn: (m) => warns.push(m) }));
    expect(r.ok).toBe(false);
    expect(r.ledgerWriteMiss).toBe(true);
    expect(warns.join()).toMatch(/no git board/);
    const viaEnv = asProduction(() => {
      process.env.WE_VERDICT_LEDGER_STORE = 'dual';
      return appendVerdict(mk('accepted', 22), { warn: () => {} });
    });
    expect(viaEnv.ok).toBe(false);
  });

  it('store=git where git misses AND the home spill fails: ok:false, and the home failure reason is kept (clearing and holding)', () => {
    // Point the home ledger at a path under a regular file so every home write throws ENOTDIR.
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'x');
    process.env.WE_VERDICT_LEDGER_DIR = join(blocker, 'ledger');
    for (const verdict of ['accepted', 'human']) {
      const warns = [];
      const r = appendVerdict(mk(verdict), {
        store: 'git', board: '/board', gitAppend: () => { throw new Error('push exhausted'); }, warn: (m) => warns.push(m),
      });
      expect(r.ok, verdict).toBe(false);
      expect(r.errors.join('; '), verdict).toMatch(/ENOTDIR|not a directory|home/i);
      expect(r.errors.length, verdict).toBeGreaterThan(0);
      expect(warns.join(), verdict).toMatch(/GIT WRITE MISS/);
    }
  });

  it('store=git where git misses and home fails by an invalid-for-home reason keeps every error (home errors first, then the miss)', () => {
    const r = appendVerdict(mk('accepted'), {
      store: 'git', board: '/board', gitAppend: () => { throw new Error('push exhausted'); }, warn: () => {},
      homeAppend: () => ({ ok: false, path: null, record: null, locked: false, errors: ['home boom'] }),
    });
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual(['home boom', 'ledger-write-miss: push exhausted']);
    const hold = appendVerdict(mk('human'), {
      store: 'git', board: '/board', gitAppend: () => { throw new Error('push exhausted'); }, warn: () => {},
      homeAppend: () => ({ ok: false, path: null, record: null, locked: false, errors: ['home boom'] }),
    });
    expect(hold.ok).toBe(false);
    expect(hold.errors).toEqual(['home boom']);
  });

  it('store=git success is announced loudly: readers still read home, so a git-only row is invisible to the fold', () => {
    const warns = [];
    const r = appendVerdict(mk('human'), {
      store: 'git', board: '/board', gitAppend: () => ({ status: 'appended' }), warn: (m) => warns.push(m),
    });
    expect(r.ok).toBe(true);
    expect(warns.join()).toMatch(/store=git/);
    expect(warns.join()).toMatch(/readers still read home/);
    // The documented consequence the warning names: the fold does not see the git-only hold.
    expect(foldRepo(REPO).get(21)).toBeUndefined();
  });
  it('a THROWING home write in dual/home mode is an ok:false result with its reason, never an escape (and the reason is one capped line)', () => {
    const boom = () => { throw new Error('disk full\nsecond line'.padEnd(2000, 'x')); };
    for (const store of ['home', 'dual']) {
      const r = appendVerdict(mk('accepted'), { store, board: '/board', homeAppend: boom, gitAppend: () => ({ status: 'appended' }), warn: () => {} });
      expect(r.ok, store).toBe(false);
      expect(r.errors, store).toHaveLength(1);
      expect(r.errors[0], store).toMatch(/^home ledger write failed: disk full/);
      expect(r.errors[0].length, store).toBeLessThan(400);
      expect(r.errors[0], store).not.toMatch(/second line/);
    }
  });

  it('the unconfigured-default downgrade to home is announced once per process; a named store never triggers it', () => {
    resetLedgerDowngradeWarning();
    const warns = [];
    asProduction(() => {
      appendVerdict(mk('accepted', 31), { warn: (m) => warns.push(m) });
      appendVerdict(mk('accepted', 32), { warn: (m) => warns.push(m) });
    });
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/running as `home`/);
    resetLedgerDowngradeWarning();
    const named = [];
    asProduction(() => appendVerdict(mk('accepted', 33), { store: 'home', warn: (m) => named.push(m) }));
    expect(named).toHaveLength(0);
  });

  it('ruling (PR 4311): a real production process, NO opts at all and no ledger env, clears with ok:true on home', () => {
    // A child process, so nothing of the test runner leaks in: no VITEST, no WE_UNDER_TEST, no store or board knob.
    const env = { ...process.env, WE_VERDICT_LEDGER_DIR: dir };
    for (const k of FLAGS) delete env[k];
    // Repo-root cwd, like the shadow-agreement CLI test above (import.meta.url is not a file: URL under this runner).
    const src = `const m = await import('./scripts/lib/verdict-ledger.mjs');
      const r = m.appendVerdict(m.buildVerdictRecord({ repo: ${JSON.stringify(REPO)}, pr: 41, verdict: 'accepted', at: '2026-10-07T12:00:00.000Z', source: 'test' }));
      process.stdout.write(JSON.stringify({ ok: r.ok, store: r.store, miss: r.ledgerWriteMiss ?? null, errors: r.errors }));`;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', src], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(JSON.parse(out)).toEqual({ ok: true, store: 'home', miss: null, errors: [] });
    expect(readVerdictLedger(REPO)).toHaveLength(1);
  });

  it('a BLANK board (empty or whitespace-only, env or opts) is no board: the production default clears on home and never calls the transport', () => {
    for (const [i, place] of [['env', '   '], ['env', ''], ['env', '\t\n'], ['opts', '  '], ['opts', '']].entries()) {
      const calls = [];
      const r = asProduction(() => {
        const o = { gitAppend: (a) => { calls.push(a); throw new Error(`git spawned with cwd ${JSON.stringify(a.board)}`); }, warn: () => {} };
        if (place[0] === 'env') process.env.WE_VERDICT_LEDGER_BOARD = place[1]; else o.board = place[1];
        return appendVerdict(mk('accepted', 50 + i), o);
      });
      const label = `${place[0]}=${JSON.stringify(place[1])}`;
      expect(r.ok, label).toBe(true);
      expect(r.store, label).toBe('home');
      expect(r.ledgerWriteMiss, label).toBeUndefined();
      expect(calls, label).toHaveLength(0);
    }
  });

  it('a board padded with whitespace is trimmed before it reaches the transport', () => {
    const calls = [];
    const r = asProduction(() => {
      process.env.WE_VERDICT_LEDGER_BOARD = '  /env-board \n';
      return appendVerdict(mk('accepted'), { gitAppend: (a) => { calls.push(a); return { status: 'appended' }; }, warn: () => {} });
    });
    expect(r.ok).toBe(true);
    expect(r.store).toBe('dual');
    expect(calls[0].board).toBe('/env-board');
  });

  it('resolveLedgerStoreChoice derives store and named-ness together', () => {
    expect(resolveLedgerStoreChoice(undefined, {})).toEqual({ store: 'dual', named: false });
    expect(resolveLedgerStoreChoice('bogus', { WE_VERDICT_LEDGER_STORE: 'git' })).toEqual({ store: 'dual', named: false });
    expect(resolveLedgerStoreChoice(undefined, { WE_VERDICT_LEDGER_STORE: ' Git ' })).toEqual({ store: 'git', named: true });
    expect(resolveLedgerStoreChoice(undefined, { VITEST: '1' })).toEqual({ store: 'home', named: false });
  });

});
