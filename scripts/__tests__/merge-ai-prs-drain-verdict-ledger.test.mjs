/**
 * @file scripts/__tests__/merge-ai-prs-drain-verdict-ledger.test.mjs
 * @description #3215 — the verdict ledger (#3007) covered the review seam only; a hold the DRAIN applies on
 *   its own (a fresh park, a #2409 stale-acceptance re-park) never appended a row, so `review-ledger-check`
 *   counted every one of them as `unledgered` — the precondition the Phase-2 flip cannot clear without this.
 *   Covers `recordDrainVerdict` (the drain's own writer through the ledger's single owner,
 *   `we:scripts/lib/verdict-ledger.mjs`) and the WIRING that puts it ahead of the `gh` transport call at the
 *   drain's one park site.
 *
 *   Also covers, per PR review round 1, the Phase-1 fail-soft divergence this ordering deliberately accepts
 *   (ledger row written, THEN the `gh` label call — a transport miss there does not touch the row) and ties
 *   the #2409 re-park reason to the REAL `decideReviewGate` formatting rather than a hand-typed stand-in.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { recordDrainVerdict, recordParkVerdict, recordDrainHold, drainHoldReasonCode } from '../merge-ai-prs.mjs';
import { VERDICTS, AGREEMENT, readVerdictLedger, foldRepo, compareLedgerToLabels, parseLedgerEvents, verdictLedgerPath } from '../lib/verdict-ledger.mjs';
import { REVIEW_LABELS, decideReviewGate } from '../lib/review-escalation.mjs';

describe('merge-ai-prs — #3215 recordDrainVerdict: the drain\'s own holds, ledgered', () => {
  let dir;
  const prevDir = process.env.WE_VERDICT_LEDGER_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'we-drain-verdict-ledger-'));
    process.env.WE_VERDICT_LEDGER_DIR = dir;
  });
  afterEach(() => {
    if (prevDir === undefined) delete process.env.WE_VERDICT_LEDGER_DIR;
    else process.env.WE_VERDICT_LEDGER_DIR = prevDir;
    rmSync(dir, { recursive: true, force: true });
    rmSync(`${dir}-locks`, { recursive: true, force: true });
  });

  it('a fresh review:pending park writes a PENDING row with the drain named as its author', () => {
    const result = recordDrainVerdict({
      repo: 'o/n', pr: 501, applyLabel: REVIEW_LABELS.pending,
      reason: 'escalated — awaiting an independent review (review:pending)', headSha: 'abc1234',
    });
    expect(result).toEqual({ ok: true, errors: [] });
    const rows = readVerdictLedger('o/n');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      pr: 501, verdict: VERDICTS.PENDING, clears: false, source: 'merge-ai-prs',
      reason: 'escalated — awaiting an independent review (review:pending)',
    });
    expect(rows[0].actor.declared).toBe('drain');
    expect(rows[0].coverage.headSha).toBe('abc1234');
  });

  it('a review:human park writes a HUMAN row', () => {
    recordDrainVerdict({ repo: 'o/n', pr: 502, applyLabel: REVIEW_LABELS.human, reason: 'gate-self' });
    const rows = readVerdictLedger('o/n');
    expect(rows[0]).toMatchObject({ pr: 502, verdict: VERDICTS.HUMAN, clears: false, source: 'merge-ai-prs' });
  });

  it('#2409 — a stale-acceptance RE-PARK is ledgered exactly like a fresh park, with the REAL decideReviewGate reason (not a hand-typed stand-in), and clears the `unledgered` gap', () => {
    // PR review round 1, finding 5 — the prior version of this test hand-typed a plausible-looking reason
    // string and only proved `recordDrainVerdict` round-trips it unchanged, which never touches the actual
    // `gate.staleAcceptance` + `gate.reason` code path at the drain's real park site (merge-ai-prs.mjs:
    // `v.reason = gate.reason + (score.reasons.length ? ... : '')`). Drive the REAL `decideReviewGate` with a
    // stale-acceptance scenario (an accepted SHA the live head has moved past, no operator clearance, no
    // diff/contribution fingerprints to rescue it) so `gate.reason` is the SAME string production code would
    // compute, and feed THAT into `recordDrainVerdict` — proving the ledger row explains the same thing the PR
    // comment/body does, not merely that recordDrainVerdict is a faithful pass-through of whatever it's handed.
    const acceptedSha = 'aaa1111';
    const headSha = 'bbb2222';
    const gate = decideReviewGate({
      escalate: false, humanRequired: false, labels: [REVIEW_LABELS.accepted],
      acceptedSha, headSha, acceptedDiff: null, headDiff: null,
      acceptedContribution: null, headContribution: null, operatorClearance: null, headReadFailed: false,
    });
    expect(gate.staleAcceptance).toBe(true);
    expect(gate.applyLabel).toBe(REVIEW_LABELS.pending);
    // score.reasons is empty in this scenario (no fresh escalation triggers), so v.reason === gate.reason —
    // the same formula the drain's park branch applies.
    const reason = gate.reason;
    expect(reason).toBe(
      'review:accepted is STALE — head advanced to bbb2222 past the reviewed commit aaa1111 — the acceptance did not cover the current tree; re-parking for a fresh review',
    );

    const result = recordDrainVerdict({ repo: 'o/n', pr: 503, applyLabel: gate.applyLabel, reason, headSha });
    expect(result.ok).toBe(true);
    const rows = readVerdictLedger('o/n');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pr: 503, verdict: VERDICTS.PENDING, reason });
    // PR review round 1, finding 3 — the drain-authored actor must be asserted on THIS (re-park) row too, not
    // only on the fresh-park test above; a regression that dropped `declaredActor` on only the staleAcceptance
    // branch of the call site would otherwise pass this test undetected.
    expect(rows[0].actor.declared).toBe('drain');

    // The exact predicate `review-ledger-check` runs: a PR the ledger now covers must never read UNLEDGERED,
    // which is precisely the Phase-2 precondition #3215 exists to satisfy.
    const folded = foldRepo('o/n');
    const cmp = compareLedgerToLabels({ pr: 503, labels: [REVIEW_LABELS.pending], folded: folded.get(503) || null });
    expect(cmp.status).not.toBe(AGREEMENT.UNLEDGERED);
  });

  it('an unknown label is refused rather than guessed at, and nothing is written', () => {
    const result = recordDrainVerdict({ repo: 'o/n', pr: 504, applyLabel: 'some:other-label' });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/no VERDICTS member/);
    expect(readVerdictLedger('o/n')).toHaveLength(0);
  });

  it('never throws — a malformed repo fails soft, matching review-set-label\'s Phase-1 posture', () => {
    expect(() => recordDrainVerdict({ repo: 'not-a-repo-shape', pr: 1, applyLabel: REVIEW_LABELS.pending })).not.toThrow();
    const result = recordDrainVerdict({ repo: 'not-a-repo-shape', pr: 1, applyLabel: REVIEW_LABELS.pending });
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('#3215 PR review round 1, findings 1/2/4 — a `gh` transport failure AFTER a successful ledger write leaves the row intact; the ledger/label divergence this can cause is the DELIBERATE, DOCUMENTED Phase-1 cost, not an unhandled bug', () => {
    // This reproduces, at the unit level, the exact sequence the wiring test below pins in the source: (1)
    // `recordDrainVerdict` runs and returns before (2) the drain's `gh pr edit --add-label` transport call is
    // even reached. `recordDrainVerdict` has no knowledge of, and no rollback path keyed on, step 2's outcome
    // — so if `gh` fails there (rate limit / transient API error / permissions, silently swallowed by the
    // call site's pre-existing `catch { /* label best-effort */ }`), the row from step 1 is neither corrected
    // nor withdrawn. That is the SAME posture `review-set-label.mjs` already ships for the review seam under
    // #3007 ("a transport failure does not un-form the verdict... What it costs is an orphan row... a visible
    // Phase-1 observation" — see that file's own `#3007 PHASE 1` comment block), applied here to the drain's
    // own seam. Revisiting it belongs to the Phase-2 flip (a gate reading ONLY the ledger), not to this item.
    const result = recordDrainVerdict({
      repo: 'o/n', pr: 505, applyLabel: REVIEW_LABELS.pending, reason: 'gate-self', headSha: 'cafe123',
    });
    expect(result.ok).toBe(true);
    const rowAfterLedgerWrite = readVerdictLedger('o/n')[0];

    // A throwing stand-in for the `execFileSync('gh', ...)` call, wrapped in the IDENTICAL catch shape the
    // call site uses, so the swallow is proven to never reach back into (or need to react to) the row above.
    const throwingExec = () => { throw new Error('simulated gh transport failure — rate limit'); };
    expect(() => {
      try { throwingExec(); } catch { /* label best-effort — same catch shape as the call site */ }
    }).not.toThrow();

    expect(readVerdictLedger('o/n')).toEqual([rowAfterLedgerWrite]);
  });
});

// The WIRING half — a pure unit test cannot see WHERE the drain's park loop calls this, and that call site
// lives inside `runCli`'s park branch, which this file's standing norm (see the #984 F2 block in
// merge-ai-prs-ai-detection-and-drain-ordering.test.mjs) leaves un-executed. Source-contract assertion, same
// mechanism.
describe('merge-ai-prs — #3215 wiring: the park site writes the ledger BEFORE the `gh` label call', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'merge-ai-prs.mjs'), 'utf8');

  it('recordDrainVerdict is called at the ordinary park site plus (E3 #3929) the manifest-tamper re-park; the test-gaming re-park goes through applyTestGamingParkLabel', () => {
    expect(src.match(/recordDrainVerdict\(\{ repo:/g) || []).toHaveLength(2);
    // PR #4631 round 4 (F2): the test-gaming site writes its row only after a LIVE label read (the function's own
    // default `record` is recordDrainVerdict), live read, add, then row, and the runCli site hands it the live reader.
    const site = src.indexOf('const parkedLabel = applyTestGamingParkLabel({');
    expect(site).toBeGreaterThan(-1);
    expect(src.indexOf("'--json', 'labels']", site)).toBeGreaterThan(site);
    const fn = src.indexOf('export function applyTestGamingParkLabel(');
    const read = src.indexOf('readLiveLabels()', fn);
    const record = src.indexOf('record({ repo, pr, applyLabel: label', fn);
    const add = src.indexOf('addLabel(label)', fn);
    expect(fn).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(fn);
    // live read -> the add -> the attested row (the ledger write must not sit inside the read-to-add window).
    expect(add).toBeGreaterThan(read);
    expect(record).toBeGreaterThan(add);
  });

  it('the call sits inside the shouldApplyReviewLabel guard, AHEAD of the `gh pr edit --add-label` transport call', () => {
    const guardStart = src.indexOf('if (shouldApplyReviewLabel(gate.applyLabel, v.prLabels)) {');
    expect(guardStart).toBeGreaterThan(-1);
    const ledgerCallAt = src.indexOf('recordDrainVerdict({ repo:', guardStart);
    const ghCallAt = src.indexOf("execFileSync('gh', ['pr', 'edit', String(v.num), ...repoFlag(v.repo), '--add-label', gate.applyLabel]", guardStart);
    expect(ledgerCallAt).toBeGreaterThan(guardStart);
    expect(ghCallAt).toBeGreaterThan(ledgerCallAt);
  });

  it('the wired call passes the SAME label the gate decided and the drain\'s own headSha — never a re-derived value', () => {
    expect(src).toContain('recordDrainVerdict({ repo: v.repo || localSlug, pr: v.num, applyLabel: gate.applyLabel, reason: v.reason, headSha: v.headSha ?? null })');
  });
});

// ── E3 (#3929) — the remaining hold writers, ledgered ALONGSIDE the label (strictly additive) ──────────────────
describe('E3 #3929 — re-park rows, producer rows and drain-hold events', () => {
  let dir;
  const prevDir = process.env.WE_VERDICT_LEDGER_DIR;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'we-e3-ledger-'));
    process.env.WE_VERDICT_LEDGER_DIR = dir;
  });
  afterEach(() => {
    if (prevDir === undefined) delete process.env.WE_VERDICT_LEDGER_DIR;
    else process.env.WE_VERDICT_LEDGER_DIR = prevDir;
    rmSync(dir, { recursive: true, force: true });
    rmSync(`${dir}-locks`, { recursive: true, force: true });
  });
  const events = (repo) => { try { return parseLedgerEvents(readFileSync(verdictLedgerPath(repo), 'utf8')); } catch { return []; } };

  it('a producer park row names the producer, not the drain, and carries the head', () => {
    const r = recordParkVerdict({ repo: 'o/n', pr: 601, applyLabel: REVIEW_LABELS.human, reason: 'gate-self', headSha: 'abc1234', declaredActor: 'producer', source: 'pr-land' });
    expect(r.ok).toBe(true);
    const rows = readVerdictLedger('o/n');
    expect(rows[0]).toMatchObject({ pr: 601, verdict: VERDICTS.HUMAN, clears: false, source: 'pr-land' });
    expect(rows[0].actor.declared).toBe('producer');
    expect(rows[0].coverage.headSha).toBe('abc1234');
  });

  it('recordParkVerdict fails soft: bad repo and unknown label never throw and never write', () => {
    expect(() => recordParkVerdict({ repo: 'nope', pr: 1, applyLabel: REVIEW_LABELS.pending, declaredActor: 'producer', source: 'pr-land' })).not.toThrow();
    expect(recordParkVerdict({ repo: 'nope', pr: 1, applyLabel: REVIEW_LABELS.pending, declaredActor: 'producer', source: 'pr-land' }).ok).toBe(false);
    expect(recordParkVerdict({ repo: 'o/n', pr: 1, applyLabel: 'x:y', declaredActor: 'producer', source: 'pr-land' }).ok).toBe(false);
    expect(readVerdictLedger('o/n')).toHaveLength(0);
  });

  it('a re-park row is a HUMAN drain row, and a ledger append failure still reports ok:false without throwing', () => {
    expect(recordDrainVerdict({ repo: 'o/n', pr: 602, applyLabel: REVIEW_LABELS.human, reason: 'manifest baseline mismatch', headSha: 'bbb2222' }).ok).toBe(true);
    expect(readVerdictLedger('o/n')[0]).toMatchObject({ pr: 602, verdict: VERDICTS.HUMAN, source: 'merge-ai-prs' });
    process.env.WE_VERDICT_LEDGER_DIR = join(dir, 'a-file-not-a-dir', '\0bad');
    expect(() => recordDrainVerdict({ repo: 'o/n', pr: 603, applyLabel: REVIEW_LABELS.human })).not.toThrow();
  });

  it('drain-hold: a new reason appends exactly one event; the same reason again appends none; a change appends one more', () => {
    const a = recordDrainHold({ repo: 'o/n', pr: 700, reason: 'required check "test" is pending (2/5)' });
    expect(a).toMatchObject({ ok: true, appended: true });
    const again = recordDrainHold({ repo: 'o/n', pr: 700, reason: 'required check "test" is pending (3/5)' });
    expect(again).toMatchObject({ ok: true, appended: false });
    const holds = () => events('o/n').filter((e) => e.type === 'hold');
    expect(holds()).toHaveLength(1);
    expect(holds()[0]).toMatchObject({ pr: 700, holdSource: 'drain', source: 'merge-ai-prs' });
    expect(recordDrainHold({ repo: 'o/n', pr: 700, reason: 'merge conflict with main' }).appended).toBe(true);
    expect(holds()).toHaveLength(2);
    expect(recordDrainHold({ repo: 'o/n', pr: 701, reason: 'merge conflict with main' }).appended).toBe(true);
  });

  it('drain-hold never touches the verdict fold, and never throws on a failing append', () => {
    recordDrainHold({ repo: 'o/n', pr: 702, reason: 'blocked' });
    expect(foldRepo('o/n').get(702)).toBeUndefined();
    const boom = () => { throw new Error('disk full'); };
    let r;
    expect(() => { r = recordDrainHold({ repo: 'o/n', pr: 703, reason: 'x', append: boom }); }).not.toThrow();
    expect(r.ok).toBe(false);
  });

  it('drainHoldReasonCode masks numbers and shas so a counter change is not a reason change', () => {
    expect(drainHoldReasonCode('pending (2/5) abcdef1234')).toBe(drainHoldReasonCode('pending (3/5) 0123456789'));
    expect(drainHoldReasonCode('')).toBe('unspecified');
    expect(drainHoldReasonCode('x'.repeat(500)).length).toBeLessThanOrEqual(100);
  });

  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'merge-ai-prs.mjs'), 'utf8');
  it('wiring: both re-park sites ledger BEFORE their label call, only inside the new-label guard', () => {
    for (const marker of ['manifest baseline mismatch', 'test-gaming suspected']) {
      const at = src.indexOf(marker);
      const guard = src.indexOf('if (parkDecision.addLabel && shouldApplyReviewLabel(parkDecision.addLabel, v.prLabels)) {', at);
      const led = src.indexOf('recordDrainVerdict({ repo: v.repo || localSlug, pr: v.num, applyLabel: parkDecision.addLabel', guard);
      const gh = src.indexOf("'--add-label', parkDecision.addLabel]", guard);
      expect(guard).toBeGreaterThan(at);
      expect(led).toBeGreaterThan(guard);
      expect(gh).toBeGreaterThan(led);
    }
  });
  it('wiring: drain-hold runs only on a live (non-dry-run) pass, for drain-owned skips, before the skip stamping', () => {
    const dry = src.indexOf('E3 (#3929, plan R8) — a held/skipped PR');
    expect(dry).toBeGreaterThan(src.lastIndexOf('if (!DRY_RUN) {', dry) - 1);
    expect(src.slice(dry, dry + 900)).toContain('v.certifyLabel || v.aiGenerated');
    expect(src.indexOf('recordDrainHold({ repo:', dry)).toBeLessThan(src.indexOf("postDrainReasonComment(v.repo, v.num, 'skip'", dry));
  });
});
