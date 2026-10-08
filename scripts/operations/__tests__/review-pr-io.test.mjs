import { buildOperatorRulingComment, referralFindingKey, mandatoryReferralReviewer, normalizeFinding, renderReferralRecord,
  readReferralRecords, validateReferralRecord, mandatoryReferralState, activeReferrals, REFERRAL_CARRY_REASON } from '../../lib/jury-core.mjs';
import { assertMandatoryReferralsCleared } from '../../review-set-label.mjs';
/**
 * @file review-pr-io.test.mjs — the `review-pr` io shell (#3035): the four sinks, with no `gh` and no network.
 *
 * WHAT IS WORTH PINNING HERE is not that a file gets written — it is the THREE-STATE mapping the executor
 * depends on. A sink that guesses "nothing landed" on an unrecognised failure double-posts a durable comment;
 * a sink that guesses "something landed" on a plain typo wedges the run. So:
 *
 *   - a refusal the single home emits BEFORE any write → `notApplied` → the entry is `failed` and retried;
 *   - ANY other failure → a plain throw → the entry stays `pending` → the executor refuses to replay it.
 *
 * The label sink's subprocess is injected, so the argv it would hand `we:scripts/review-set-label.mjs` is
 * assertable without running it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readLatestFixRange,
  PR_VIEW_FIELDS, createReviewPrReader, createReviewPrSinks, filePrView, ghPrView, isPreWriteRefusal, priorRoundsFor,
  prViewFileName, readPr, resolveViewReader, revParseCommit, reviewBodyPath, reviewSidecarDir,
  resolveSubjectCheckout, COMPARE_FILE_CAP, changedLinesFromCompare, changesTouchCitedLines, createChangedLinesReader,
} from '../review-pr-io.mjs';
import { REVIEW_EFFECTS, REVIEW_PR_CHANNEL, REVIEW_PR_OP, reviewPrOperation } from '../review-pr.mjs';
import { createRegistry } from '../registry.mjs';
import { applyPendingEffects } from '../effect-executor.mjs';
import { createMemoryRunStore } from '../run-store.mjs';
import { classifyReviewLoopOutcome } from '../review-job.mjs';
import { VERDICTS, appendVerdict, buildVerdictRecord, readVerdictLedger, parseLedgerEvents, verdictLedgerPath } from '../../lib/verdict-ledger.mjs';
// #xu2pp2m — the `--cwd`-reaches-the-reader wiring, asserted through the REAL operation table rather than a
// re-created copy of it (the same reason `createCliJudgeFactory` is exported and driven directly, #3151).
import { cwdFlagValue } from '../cli-adapter.mjs';
import { resolveOperation } from '../run.mjs';
import { advanceWhileRunning, startRun } from '../engine.mjs';

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'review-pr-io-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const CTX = { key: 'run-1#4#0', runId: 'run-1', type: 'x', stepIndex: 4, step: 'record', index: 0 };

describe('the write-up sink', () => {
  it('writes the comment body to the operation sidecar, deterministically', async () => {
    const sinks = createReviewPrSinks({ root });
    const result = await sinks[REVIEW_EFFECTS.WRITE_UP]({ bodyFile: 'o-n-7-verdict.md', body: '# hello' }, CTX);
    expect(readFileSync(result.path, 'utf8')).toBe('# hello');
    expect(result.path).toBe(join(reviewSidecarDir(root), 'run-1', 'o-n-7-verdict.md'));
    // Re-applying writes the SAME bytes to the SAME path — which is why it is declared idempotent. A REPLAY
    // is the same run resuming, so it arrives with the same `ctx.runId` and the run-scoping is invisible to it.
    const again = await sinks[REVIEW_EFFECTS.WRITE_UP]({ bodyFile: 'o-n-7-verdict.md', body: '# hello' }, CTX);
    expect(again.path).toBe(result.path);
    expect(readFileSync(result.path, 'utf8')).toBe('# hello');
  });

  it('SCOPES the staged write-up by run — two runs on the same PR do not cross-stage', async () => {
    // The payload name is keyed by PR only, so before this the second run's bytes replaced the first's and
    // the label sink shelled the single home with `--body-file=` pointing at the wrong verdict.
    const sinks = createReviewPrSinks({ root });
    const payload = (body) => ({ bodyFile: 'o-n-7-verdict.md', body });
    const a = await sinks[REVIEW_EFFECTS.WRITE_UP](payload('# run A'), { ...CTX, runId: 'run-a' });
    const b = await sinks[REVIEW_EFFECTS.WRITE_UP](payload('# run B'), { ...CTX, runId: 'run-b' });
    expect(a.path).not.toBe(b.path);
    expect(readFileSync(a.path, 'utf8')).toBe('# run A');
    expect(readFileSync(b.path, 'utf8')).toBe('# run B');
  });

  it('REFUSES a missing or unsafe run id rather than falling back to the shared path', async () => {
    const sinks = createReviewPrSinks({ root });
    for (const runId of [undefined, '', '..', '../../etc', 'a/b']) {
      await expect(sinks[REVIEW_EFFECTS.WRITE_UP]({ bodyFile: 'o-n-7-verdict.md', body: 'x' }, { ...CTX, runId }))
        .rejects.toThrow(/valid run id/);
    }
    // …and the file name stays a bare name, so the payload cannot escape the run's directory either.
    expect(() => reviewBodyPath({ root, runId: 'run-1', bodyFile: '../x.md' })).toThrow(/bare file name/);
  });
});

describe('the label sink', () => {
  const payload = {
    pr: 7, repo: 'o/n', to: 'accepted', actor: 'operator', bodyFile: 'o-n-7-verdict.md',
    addLabel: 'review:accepted', removeLabels: ['review:pending'],
  };

  it('shells the SINGLE HOME with the target, the actor and the staged body file', async () => {
    const seen = [];
    const sinks = createReviewPrSinks({ root, runNode: (argv) => { seen.push(argv); return '{"ok":true,"pr":7,"to":"accepted"}'; } });
    const result = await sinks[REVIEW_EFFECTS.LABEL](payload, CTX);
    expect(result).toEqual({ ok: true, pr: 7, to: 'accepted' });
    const argv = seen[0];
    expect(argv[0]).toBe(join(root, 'scripts', 'review-set-label.mjs'));
    expect(argv).toContain('--repo=o/n');
    expect(argv).toContain('--to=accepted');
    expect(argv).toContain('--actor=operator');
    // The SAME run-scoped path effect 0 staged — derived from `ctx.runId`, not re-derived from the payload.
    expect(argv).toContain(`--body-file=${join(reviewSidecarDir(root), 'run-1', 'o-n-7-verdict.md')}`);
    // It never builds a `gh` call of its own — the single home owns the write arc, the markers and the ordering.
    expect(argv.join(' ')).not.toContain('gh ');
  });

  // #2898 — the single home renders the attribution it is GIVEN. Before this the CLI hardcoded "via the
  // Plateau Loop review console" for every caller, so the live run on PR #1146 posted a comment claiming a
  // surface it never touched, three lines above its own footer naming this operation.
  it('passes the CHANNEL through, so the durable comment names the surface it came through', async () => {
    const seen = [];
    const sinks = createReviewPrSinks({ root, runNode: (argv) => { seen.push(argv); return '{"ok":true}'; } });
    await sinks[REVIEW_EFFECTS.LABEL]({ ...payload, channel: REVIEW_PR_CHANNEL }, CTX);
    expect(seen[0]).toContain(`--channel=${REVIEW_PR_CHANNEL}`);
  });

  it('omits --channel entirely for a payload written before the field existed', async () => {
    const seen = [];
    const sinks = createReviewPrSinks({ root, runNode: (argv) => { seen.push(argv); return '{"ok":true}'; } });
    await sinks[REVIEW_EFFECTS.LABEL](payload, CTX);
    // The single home's own default for an absent channel is the NEUTRAL sentence, never a wrong one — so a
    // `--resume` across the upgrade degrades to "no surface stated", not to another caller's identity.
    expect(seen[0].some((a) => a.startsWith('--channel='))).toBe(false);
  });

  it('maps a PROVEN pre-write refusal to `notApplied`, so it is retried rather than refused', async () => {
    const sinks = createReviewPrSinks({
      root,
      runNode: () => { throw Object.assign(new Error('exit 1'), { stdout: '{"error":"gate-self: review:human is human-ceremony-only — clear via /review in a session"}' }); },
    });
    await expect(sinks[REVIEW_EFFECTS.LABEL](payload, CTX)).rejects.toMatchObject({ notApplied: true });
  });

  it('maps an UNRECOGNISED failure to INDETERMINATE — the comment may already be posted', async () => {
    const sinks = createReviewPrSinks({
      root,
      runNode: () => { throw Object.assign(new Error('exit 1'), { stdout: '{"error":"could not resolve host: api.github.com"}' }); },
    });
    const err = await sinks[REVIEW_EFFECTS.LABEL](payload, CTX).catch((e) => e);
    expect(err.notApplied).toBeUndefined();
    expect(String(err.message)).toMatch(/outcome is UNKNOWN/);
  });

  it('treats a zero-exit `{"error":…}` the same way — refusal vs unknown, never "it worked"', async () => {
    const refuse = createReviewPrSinks({ root, runNode: () => '{"error":"invalid --repo — expected <owner/name>"}' });
    await expect(refuse[REVIEW_EFFECTS.LABEL](payload, CTX)).rejects.toMatchObject({ notApplied: true });
    const unknown = createReviewPrSinks({ root, runNode: () => '{"error":"something nobody has seen"}' });
    await expect(unknown[REVIEW_EFFECTS.LABEL](payload, CTX)).rejects.toThrow(/outcome is UNKNOWN/);
  });

  it('recognises the pre-write refusals the single home actually emits, and nothing else', () => {
    for (const text of [
      'gate-self: review:human is human-ceremony-only — clear via /review in a session',
      'no review:human label — nothing to clear (use --to=accepted for an ordinary parked PR)',
      'invalid --to — expected \'accepted\' or \'changes\'',
      'PR 7 is MERGED, not OPEN — a review verdict here would be inert',
      'the rendered comment is 70000 chars, over GitHub\'s 65536 limit',
    ]) expect(isPreWriteRefusal(text)).toBe(true);
    for (const text of ['fatal: unable to access', 'HTTP 502', 'connection reset by peer']) {
      expect(isPreWriteRefusal(text)).toBe(false);
    }
  });
});

// The recorded basis used to name `origin/<branch>` — a ref that moves. The `reviewed-sha` marker covers the
// merge gate; it does not make the "Net basis" line reproducible, which is what this pins.
describe('the rev is pinned to a commit', () => {
  const SHA = 'd7ad4774849fe32af2a317510a43b7ca1375e6b3';

  it('resolves the candidate ref to its full commit SHA, guarding a dash-leading refname', () => {
    const calls = [];
    const exec = (cmd, args) => { calls.push([cmd, ...args]); return `${SHA}\n`; };
    expect(revParseCommit(exec, 'origin/lane/3058-seed-encoding')).toBe(SHA);
    expect(calls[0]).toEqual(['git', 'rev-parse', '--verify', '--end-of-options', 'origin/lane/3058-seed-encoding^{commit}']);
  });

  it('returns null — never a half-pin — when the rev will not resolve, and never throws', () => {
    expect(revParseCommit(() => { throw new Error('fatal: Needed a single revision'); }, 'origin/gone')).toBe(null);
    expect(revParseCommit(() => 'd7ad477\n', 'origin/x')).toBe(null); // an abbreviation is not a pin
    expect(revParseCommit(() => '', 'origin/x')).toBe(null);
    expect(revParseCommit(null, 'origin/x')).toBe(null);
    expect(revParseCommit(() => SHA, '')).toBe(null);
  });
});

describe('the ledger and notice sinks', () => {
  // #3007 — the sink now reaches the REAL verdict ledger, so every test here redirects its home. Without
  // this, running the suite would append to the operator's live ledger, which is a merge authority in
  // waiting. The redirect is set/torn down per test alongside the temp root.
  let ledgerDir;
  const prevLedgerDir = process.env.WE_VERDICT_LEDGER_DIR;
  beforeEach(() => {
    ledgerDir = mkdtempSync(join(tmpdir(), 'review-pr-io-ledger-'));
    process.env.WE_VERDICT_LEDGER_DIR = ledgerDir;
  });
  afterEach(() => {
    if (prevLedgerDir === undefined) delete process.env.WE_VERDICT_LEDGER_DIR;
    else process.env.WE_VERDICT_LEDGER_DIR = prevLedgerDir;
    rmSync(ledgerDir, { recursive: true, force: true });
    rmSync(`${ledgerDir}-locks`, { recursive: true, force: true });
  });

  describe('ledger events (plan slice E2)', () => {
    const readEvents = () => parseLedgerEvents(readFileSync(verdictLedgerPath('o/n'), 'utf8'));
    const HEAD = 'a'.repeat(40);
    let prevStore;
    beforeEach(() => { prevStore = process.env.WE_VERDICT_LEDGER_STORE; process.env.WE_VERDICT_LEDGER_STORE = 'home'; });
    afterEach(() => {
      if (prevStore === undefined) delete process.env.WE_VERDICT_LEDGER_STORE; else process.env.WE_VERDICT_LEDGER_STORE = prevStore;
    });

    it('a #3988 replay: 3 runs on one head yield 3 review-run rows with posted:false', async () => {
      const sinks = createReviewPrSinks({ root });
      for (let i = 0; i < 3; i += 1) {
        await sinks[REVIEW_EFFECTS.LEDGER_EVENTS]({ pr: 7, repo: 'o/n', headSha: HEAD, posted: false, referralKeys: [] }, CTX);
      }
      const rows = readEvents().filter((r) => r.type === 'review-run');
      expect(rows).toHaveLength(3);
      for (const r of rows) expect(r).toMatchObject({ pr: 7, headSha: HEAD, phase: 'completed', posted: false, source: 'review-pr' });
    });

    it('appends a referral row with hashed finding keys when the run opened findings, plus the review-run row', async () => {
      const sinks = createReviewPrSinks({ root });
      const result = await sinks[REVIEW_EFFECTS.LEDGER_EVENTS]({ pr: 7, repo: 'o/n', headSha: HEAD, posted: true, referralKeys: ['["correctness","a.js",1,"bug"]'] }, CTX);
      expect(result.written).toEqual(['referral', 'review-run']);
      const rows = readEvents();
      const referral = rows.find((r) => r.type === 'referral');
      expect(referral.findingKeys).toHaveLength(1);
      expect(referral.findingKeys[0]).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(rows.find((r) => r.type === 'review-run').posted).toBe(true);
    });

    it('writes nothing without a pinned head', async () => {
      const sinks = createReviewPrSinks({ root });
      const result = await sinks[REVIEW_EFFECTS.LEDGER_EVENTS]({ pr: 7, repo: 'o/n', headSha: null, posted: false, referralKeys: [] }, CTX);
      expect(result).toEqual({ written: [], missed: [] });
    });

    it('a ledger write miss never throws: it prints a loud ledger-write-miss line and returns', async () => {
      const lines = [];
      process.env.WE_VERDICT_LEDGER_DIR = join(ledgerDir, 'does', 'not', 'exist', '\0bad');
      const sinks = createReviewPrSinks({ root, out: (l) => lines.push(l) });
      const result = await sinks[REVIEW_EFFECTS.LEDGER_EVENTS]({ pr: 7, repo: 'o/n', headSha: HEAD, posted: false, referralKeys: [] }, CTX);
      expect(result.written).toEqual([]);
      expect(result.missed).toHaveLength(1);
      expect(lines.join('\n')).toContain('ledger-write-miss');
    });
  });

  it('RECONCILES against the row the single home already wrote — it does not append a second one', async () => {
    // Effect 1 shells `we:scripts/review-set-label.mjs`, which is the single home of BOTH the label swap and
    // the ledger row. By the time this sink runs the row exists, and appending again would put two rows in an
    // append-only merge authority for one verdict.
    appendVerdict(buildVerdictRecord({
      repo: 'o/n', pr: 7, verdict: VERDICTS.ACCEPTED, at: '2026-08-10T12:00:00.000Z', source: 'review-set-label',
    }));
    const sinks = createReviewPrSinks({ root });
    const result = await sinks[REVIEW_EFFECTS.LEDGER]({ pr: 7, repo: 'o/n', to: 'accepted' }, CTX);
    expect(result).toMatchObject({ reconciled: true, verdict: 'accepted', source: 'review-set-label' });
    expect(readVerdictLedger('o/n')).toHaveLength(1);
    // The gitignored session-local sidecar the seam used before a writer existed is GONE, not migrated.
    expect(existsSync(join(reviewSidecarDir(root), 'verdicts.pending.jsonl'))).toBe(false);
  });

  it('is a no-op on replay — a second apply finds the same row and still writes nothing new', async () => {
    const sinks = createReviewPrSinks({ root });
    await sinks[REVIEW_EFFECTS.LEDGER]({ pr: 8, repo: 'o/n', to: 'changes', actor: 'a', lens: 'correctness' }, CTX);
    const again = await sinks[REVIEW_EFFECTS.LEDGER]({ pr: 8, repo: 'o/n', to: 'changes', actor: 'a', lens: 'correctness' }, CTX);
    expect(again.reconciled).toBe(true);
    expect(readVerdictLedger('o/n')).toHaveLength(1);
  });

  it('writes a recovery row when the single home\'s fail-soft append missed, and says which path made it', async () => {
    const sinks = createReviewPrSinks({ root });
    const result = await sinks[REVIEW_EFFECTS.LEDGER]({
      pr: 9, repo: 'o/n', to: 'accepted', actor: 'operator', lens: 'correctness', findings: [],
    }, CTX);
    expect(result).toMatchObject({ reconciled: false, source: 'operation-reconcile' });
    const rows = readVerdictLedger('o/n');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pr: 9, verdict: 'accepted', source: 'operation-reconcile', clears: true });
  });

  it('F4: a CLEARING verdict whose git write missed is NOT applied and leaves no home row, so the next run retries instead of reconciling', async () => {
    const prevStore = process.env.WE_VERDICT_LEDGER_STORE;
    const prevBoard = process.env.WE_VERDICT_LEDGER_BOARD;
    process.env.WE_VERDICT_LEDGER_STORE = 'dual'; // operator-named dual + no board = a git write miss, with no git spawned
    delete process.env.WE_VERDICT_LEDGER_BOARD;
    try {
      const sinks = createReviewPrSinks({ root });
      const payload = { pr: 12, repo: 'o/n', to: 'accepted', actor: 'operator', lens: 'correctness', findings: [] };
      await expect(sinks[REVIEW_EFFECTS.LEDGER](payload, CTX)).rejects.toThrow(/verdict-ledger append refused/);
      expect(readVerdictLedger('o/n')).toHaveLength(0);
      // Transport back (store no longer named): the retry is a real append, not "already reconciled".
      if (prevStore === undefined) delete process.env.WE_VERDICT_LEDGER_STORE; else process.env.WE_VERDICT_LEDGER_STORE = prevStore;
      const retry = await sinks[REVIEW_EFFECTS.LEDGER](payload, CTX);
      expect(retry).toMatchObject({ reconciled: false, source: 'operation-reconcile' });
      expect(readVerdictLedger('o/n')).toHaveLength(1);
    } finally {
      if (prevStore === undefined) delete process.env.WE_VERDICT_LEDGER_STORE; else process.env.WE_VERDICT_LEDGER_STORE = prevStore;
      if (prevBoard === undefined) delete process.env.WE_VERDICT_LEDGER_BOARD; else process.env.WE_VERDICT_LEDGER_BOARD = prevBoard;
    }
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────────────────
  // THE MULTI-ROUND CASE (PR #1149 review). "Already reconciled" is about THIS ROUND'S VERDICT, never about
  // the PR having any row at all. A PR that got `changes` and later `accepted` is the ordinary shape of a
  // review, so the first cut's `if (folded && folded.current)` mis-fired on most PRs: it found round 1's
  // `changes` row, called itself reconciled, and dropped the acceptance on the floor while the label said
  // accepted. Both directions are pinned — the miss must be recovered, and the hit must NOT double-write.
  // ───────────────────────────────────────────────────────────────────────────────────────────────────────

  it('round 2 accepted after a round-1 `changes` row WRITES the fresh verdict — a stale row is not reconciliation', async () => {
    // Round 1: the reviewer bounced it, and the single home recorded that.
    appendVerdict(buildVerdictRecord({
      repo: 'o/n', pr: 42, verdict: VERDICTS.CHANGES, at: '2026-08-01T10:00:00.000Z', source: 'review-set-label',
    }));
    // Round 2: the reviewer accepts, the label swaps, and the single home's fail-soft append misses.
    const sinks = createReviewPrSinks({ root });
    const result = await sinks[REVIEW_EFFECTS.LEDGER]({
      pr: 42, repo: 'o/n', to: 'accepted', actor: 'operator', lens: 'correctness', findings: [],
    }, CTX);
    expect(result).toMatchObject({ reconciled: false, verdict: 'accepted', source: 'operation-reconcile' });
    const rows = readVerdictLedger('o/n');
    expect(rows.map((r) => r.verdict)).toEqual(['changes', 'accepted']);
    // The FOLD is what a Phase-2 gate would read, and it now holds the verdict the label mirrors.
    expect(rows[rows.length - 1].clears).toBe(true);
  });

  it('round 2 accepted whose single-home row DID land reconciles — the multi-round case never double-writes', async () => {
    appendVerdict(buildVerdictRecord({
      repo: 'o/n', pr: 43, verdict: VERDICTS.CHANGES, at: '2026-08-01T10:00:00.000Z', source: 'review-set-label',
    }));
    appendVerdict(buildVerdictRecord({
      repo: 'o/n', pr: 43, verdict: VERDICTS.ACCEPTED, at: '2026-08-02T10:00:00.000Z', source: 'review-set-label',
    }));
    const sinks = createReviewPrSinks({ root });
    const result = await sinks[REVIEW_EFFECTS.LEDGER]({ pr: 43, repo: 'o/n', to: 'accepted' }, CTX);
    expect(result).toMatchObject({ reconciled: true, verdict: 'accepted', source: 'review-set-label' });
    expect(readVerdictLedger('o/n')).toHaveLength(2);
  });

  it('a RECOVERY row is written once and only once — the replay after it finds its own row and stops', async () => {
    // The dangerous replay: the recovery path appended, then the effect is applied again. If the comparison
    // looked at anything but the LIVE verdict this would put two `accepted` rows in an append-only authority.
    appendVerdict(buildVerdictRecord({
      repo: 'o/n', pr: 44, verdict: VERDICTS.CHANGES, at: '2026-08-01T10:00:00.000Z', source: 'review-set-label',
    }));
    const sinks = createReviewPrSinks({ root });
    const first = await sinks[REVIEW_EFFECTS.LEDGER]({ pr: 44, repo: 'o/n', to: 'accepted' }, CTX);
    const replay = await sinks[REVIEW_EFFECTS.LEDGER]({ pr: 44, repo: 'o/n', to: 'accepted' }, CTX);
    expect(first.reconciled).toBe(false);
    expect(replay).toMatchObject({ reconciled: true, verdict: 'accepted', source: 'operation-reconcile' });
    expect(readVerdictLedger('o/n').map((r) => r.verdict)).toEqual(['changes', 'accepted']);
  });

  it('another PR\'s rows are not this PR\'s reconciliation', async () => {
    appendVerdict(buildVerdictRecord({
      repo: 'o/n', pr: 45, verdict: VERDICTS.ACCEPTED, at: '2026-08-01T10:00:00.000Z', source: 'review-set-label',
    }));
    const sinks = createReviewPrSinks({ root });
    const result = await sinks[REVIEW_EFFECTS.LEDGER]({ pr: 46, repo: 'o/n', to: 'accepted' }, CTX);
    expect(result.reconciled).toBe(false);
    expect(readVerdictLedger('o/n').map((r) => r.pr)).toEqual([45, 46]);
  });

  it('a recovery row records the verdict the target actually implies — `clear-human` is not `changes`', async () => {
    // The first cut's `payload.to === 'accepted' ? ACCEPTED : CHANGES` recorded a `clear-human` clearance as a
    // HOLD. Both sides now derive through the writer's own `verdictForLabelTarget`, so they cannot diverge.
    const sinks = createReviewPrSinks({ root });
    await sinks[REVIEW_EFFECTS.LEDGER]({ pr: 47, repo: 'o/n', to: 'clear-human' }, CTX);
    await sinks[REVIEW_EFFECTS.LEDGER]({ pr: 48, repo: 'o/n', to: 'rearm' }, CTX);
    const rows = readVerdictLedger('o/n');
    expect(rows.map((r) => [r.pr, r.verdict, r.clears])).toEqual([[47, 'clear-human', true], [48, 'pending', false]]);
  });

  it('refuses through `notApplied` on a label target it does not know — a guessed disposition is worse than none', async () => {
    const sinks = createReviewPrSinks({ root });
    await expect(sinks[REVIEW_EFFECTS.LEDGER]({ pr: 49, repo: 'o/n', to: 'merge-it' }, CTX))
      .rejects.toThrow(/unknown label target/);
    expect(readVerdictLedger('o/n')).toEqual([]);
  });

  it('refuses through `notApplied` when the record is unbuildable — nothing landed, so it is retriable', async () => {
    const sinks = createReviewPrSinks({ root });
    await expect(sinks[REVIEW_EFFECTS.LEDGER]({ pr: 'not-a-pr', repo: 'o/n', to: 'accepted' }, CTX))
      .rejects.toThrow(/positive integer/);
    expect(readVerdictLedger('o/n')).toEqual([]);
  });

  it('emits the notice through the injected channel and writes nothing', async () => {
    const lines = [];
    const sinks = createReviewPrSinks({ root, out: (l) => lines.push(l) });
    await sinks[REVIEW_EFFECTS.NOTICE]({ notice: 'PR o/n#7 — human review accepted by operator.' }, CTX);
    expect(lines).toEqual(['PR o/n#7 — human review accepted by operator.']);
    expect(existsSync(join(reviewSidecarDir(root), 'verdicts.pending.jsonl'))).toBe(false);
    expect(readVerdictLedger('o/n')).toEqual([]);
  });
});

/**
 * #xlw02hw — the `advise` step's sink. UNLIKE the label sink, it goes nowhere near
 * `we:scripts/review-set-label.mjs`: it posts a bare comment through the SAME `postComment` primitive that
 * single home itself calls, injected here exactly as `runNode` is injected above, so this is testable with no
 * `gh` on PATH and asserts the argv it would build without running it.
 */
describe('the advisory-note sink', () => {
  it('posts the body through the injected `postComment`, touching no label and no ledger', async () => {
    const calls = [];
    const sinks = createReviewPrSinks({ root, postComment: (repo, pr, body) => { calls.push({ repo, pr, body }); } });
    const result = await sinks[REVIEW_EFFECTS.ADVISORY_NOTE](
      { pr: 9, repo: 'o/n', body: '⚠️ advisory only' },
      { ...CTX, type: REVIEW_EFFECTS.ADVISORY_NOTE, step: 'advise' },
    );
    expect(calls).toEqual([{ repo: 'o/n', pr: 9, body: '⚠️ advisory only' }]);
    expect(result).toEqual({ posted: true });
    // No label swap and no local sidecar write — this sink's only side effect is the one `postComment` call
    // asserted above. (Not asserting the ledger here: unlike the block above, this describe does not redirect
    // `WE_VERDICT_LEDGER_DIR`, and this sink never touches the ledger at all, so there is nothing to check.)
    expect(existsSync(reviewSidecarDir(root))).toBe(false);
  });

  it('defaults to the real `gh`-backed provider when no `postComment` is injected', () => {
    // Just proves the default is wired, not a live `gh` call: `createReviewPrSinks({ root })` must not throw
    // while BUILDING the sink map (the provider is constructed eagerly as the default parameter value).
    const sinks = createReviewPrSinks({ root });
    expect(typeof sinks[REVIEW_EFFECTS.ADVISORY_NOTE]).toBe('function');
  });
});

/**
 * `advise`'s second effect — the `advisory:accepted` / `advisory:changes` label. The forge port is injected exactly
 * as `postComment` is above, so every case runs with no `gh` and asserts the label writes it WOULD make.
 */
describe('the advisory-label sink', () => {
  const HEAD = 'fd37ce270'.padEnd(40, 'a');
  const CTX_LABEL = { ...CTX, type: REVIEW_EFFECTS.ADVISORY_LABEL, step: 'advise', index: 1 };

  /** A recording provider: `state` is what the live PR looks like; every write is captured. */
  function provider(state) {
    const calls = { ensure: [], set: [] };
    return {
      calls,
      readPrState: () => state,
      ensureLabel: (repo, name, meta) => { calls.ensure.push({ repo, name, meta }); },
      setLabels: (repo, pr, spec) => { calls.set.push({ repo, pr, spec }); },
    };
  }
  const apply = (labelProvider, payload) => createReviewPrSinks({ root, labelProvider })[REVIEW_EFFECTS.ADVISORY_LABEL](
    { pr: 9, repo: 'o/n', outcome: 'accept', reviewedHead: HEAD, ...payload }, CTX_LABEL,
  );

  it('accept: adds advisory:accepted (creating it first) and drops review:pending, touching nothing else', async () => {
    const p = provider({ headRefOid: HEAD, labels: [{ name: 'review:human' }, { name: 'review:pending' }] });
    expect(await apply(p, {})).toEqual({ applied: true, added: 'advisory:accepted', removed: ['review:pending'] });
    expect(p.calls.ensure).toEqual([{ repo: 'o/n', name: 'advisory:accepted', meta: expect.objectContaining({ color: '0e8a16' }) }]);
    expect(p.calls.set).toEqual([{ repo: 'o/n', pr: 9, spec: { add: 'advisory:accepted', remove: ['review:pending'] } }]);
  });

  it('changes: adds advisory:changes and removes the opposite label', async () => {
    const p = provider({ headRefOid: HEAD, labels: [{ name: 'review:human' }, { name: 'review:pending' }, { name: 'advisory:accepted' }] });
    expect(await apply(p, { outcome: 'changes' })).toEqual({
      applied: true, added: 'advisory:changes', removed: ['advisory:accepted', 'review:pending'],
    });
    expect(p.calls.ensure[0].name).toBe('advisory:changes');
  });

  it('never removes review:human and never adds review:accepted, whatever the outcome', async () => {
    for (const outcome of ['accept', 'changes']) {
      const p = provider({ headRefOid: HEAD, labels: [{ name: 'review:human' }, { name: 'review:pending' }] });
      await apply(p, { outcome });
      const written = JSON.stringify([...p.calls.ensure, ...p.calls.set]);
      expect(written).not.toContain('review:accepted');
      expect(p.calls.set[0].spec.remove).not.toContain('review:human');
    }
  });

  it('refuses quietly when the head has MOVED since the panel judged it — the label would describe a dead head', async () => {
    const p = provider({ headRefOid: 'b'.repeat(40), labels: [{ name: 'review:human' }] });
    expect(await apply(p, {})).toEqual({ applied: false, reason: 'head-moved' });
    expect(p.calls.set).toEqual([]);
    expect(p.calls.ensure).toEqual([]);
  });

  it('refuses when the PR is no longer human-gated, or the basis is unpinned', async () => {
    expect(await apply(provider({ headRefOid: HEAD, labels: [{ name: 'review:pending' }] }), {}))
      .toEqual({ applied: false, reason: 'not-human-gated' });
    expect(await apply(provider({ headRefOid: HEAD, labels: [{ name: 'review:human' }] }), { reviewedHead: null }))
      .toEqual({ applied: false, reason: 'unpinned-basis' });
  });

  it('is a no-op when the PR already shows exactly the desired state', async () => {
    const p = provider({ headRefOid: HEAD, labels: [{ name: 'review:human' }, { name: 'advisory:accepted' }] });
    expect(await apply(p, {})).toEqual({ applied: false, reason: 'already-current' });
    expect(p.calls.set).toEqual([]);
  });

  it('defaults to the real provider when none is injected (building the sink map must not throw)', () => {
    expect(typeof createReviewPrSinks({ root })[REVIEW_EFFECTS.ADVISORY_LABEL]).toBe('function');
  });
});

/**
 * mechanical-dispatcher lane — the `advise` step's OTHER sink: the mechanical flip of `review:awaiting-advisory`.
 * Both `readLabels`/`setLabels` are injected exactly as `postComment` is above, so this is testable with no `gh`
 * on PATH. The one behaviour worth pinning: this sink RE-READS the PR's LIVE labels before writing, and treats
 * the label already being absent as the desired end state rather than a failure — never `we:scripts/
 * review-set-label.mjs`'s single home, which always couples a comment with a full verdict swap (#2644).
 */
describe('the awaiting-advisory-clear sink', () => {
  it('removes review:awaiting-advisory when the PR still carries it', async () => {
    const setCalls = [];
    const sinks = createReviewPrSinks({
      root,
      readLabels: () => [{ name: 'review:human' }, { name: 'review:awaiting-advisory' }],
      setLabels: (repo, pr, spec) => { setCalls.push({ repo, pr, spec }); },
    });
    const result = await sinks[REVIEW_EFFECTS.AWAITING_ADVISORY_CLEAR](
      { pr: 9, repo: 'o/n' },
      { ...CTX, type: REVIEW_EFFECTS.AWAITING_ADVISORY_CLEAR, step: 'advise' },
    );
    expect(setCalls).toEqual([{ repo: 'o/n', pr: 9, spec: { remove: ['review:awaiting-advisory'] } }]);
    expect(result).toEqual({ cleared: true });
  });

  it('no-ops (never calls `setLabels`) when the live PR no longer carries the label', async () => {
    // `gh pr edit --remove-label` ERRORS on an absent label — a naive replay could crash on exactly the state
    // this sink is supposed to treat as already-done (idempotent: true relies on this).
    const setCalls = [];
    const sinks = createReviewPrSinks({
      root,
      readLabels: () => [{ name: 'review:human' }],
      setLabels: (repo, pr, spec) => { setCalls.push({ repo, pr, spec }); },
    });
    const result = await sinks[REVIEW_EFFECTS.AWAITING_ADVISORY_CLEAR](
      { pr: 9, repo: 'o/n' },
      { ...CTX, type: REVIEW_EFFECTS.AWAITING_ADVISORY_CLEAR, step: 'advise' },
    );
    expect(setCalls).toEqual([]);
    expect(result).toEqual({ cleared: false, alreadyAbsent: true });
  });

  it('defaults to the real `gh`-backed provider when no `readLabels`/`setLabels` are injected', () => {
    const sinks = createReviewPrSinks({ root });
    expect(typeof sinks[REVIEW_EFFECTS.AWAITING_ADVISORY_CLEAR]).toBe('function');
  });
});

/**
 * THE ROUND NUMBER IS ROUNDS SINCE THE LAST CLEAR, not rows ever written (#3072; PR #1178 review, finding 3).
 *
 * `history` holds every verdict a PR has ever carried, including rows from an already-CONVERGED loop, so
 * counting its length made a brand-new review of a previously-accepted PR report itself as round N of a cap of
 * 5. Measured on real repo data before the fix: PRs 1162 and 1164 each ran three `changes` rounds then an
 * `accepted` that cleared them, and the old expression reported `exhausted` on the FIRST round of the next
 * loop. #1164's four-round run is why the cap is 5, so the miscount strangled the exact case the cap allows.
 */
describe('priorRounds counts the CURRENT loop', () => {
  let ledgerDir;
  const prevLedgerDir = process.env.WE_VERDICT_LEDGER_DIR;
  beforeEach(() => {
    ledgerDir = mkdtempSync(join(tmpdir(), 'review-pr-io-rounds-'));
    process.env.WE_VERDICT_LEDGER_DIR = ledgerDir;
  });
  afterEach(() => {
    if (prevLedgerDir === undefined) delete process.env.WE_VERDICT_LEDGER_DIR;
    else process.env.WE_VERDICT_LEDGER_DIR = prevLedgerDir;
    rmSync(ledgerDir, { recursive: true, force: true });
    rmSync(`${ledgerDir}-locks`, { recursive: true, force: true });
  });

  const row = (verdict, at) => appendVerdict(buildVerdictRecord({
    repo: 'o/n', pr: 7, verdict, at, source: 'review-set-label',
  }));
  /** The REAL helper the reader calls, over the ledger as it now stands. */
  const priorRounds = () => priorRoundsFor('o/n', 7);

  it('is 0 on a PR with no history at all', () => {
    expect(priorRounds()).toBe(0);
  });

  it('counts the bounces of an open loop', () => {
    row(VERDICTS.CHANGES, '2026-08-10T12:00:00.000Z');
    row(VERDICTS.CHANGES, '2026-08-10T13:00:00.000Z');
    expect(priorRounds()).toBe(2);
  });

  // THE ONE THAT WAS WRONG. Three bounces then an accept is a CONVERGED loop; the next review starts over.
  it('RESETS after a clearing verdict — a converged loop does not count against the next one', () => {
    row(VERDICTS.CHANGES, '2026-08-10T12:00:00.000Z');
    row(VERDICTS.CHANGES, '2026-08-10T13:00:00.000Z');
    row(VERDICTS.CHANGES, '2026-08-10T14:00:00.000Z');
    row(VERDICTS.ACCEPTED, '2026-08-10T15:00:00.000Z');
    expect(priorRounds()).toBe(0); // history.length would be 4 — round 5 of 5, i.e. `exhausted` on a fresh loop
  });

  it('counts only the bounces since that clear', () => {
    row(VERDICTS.CHANGES, '2026-08-10T12:00:00.000Z');
    row(VERDICTS.ACCEPTED, '2026-08-10T13:00:00.000Z');
    row(VERDICTS.CHANGES, '2026-08-10T14:00:00.000Z');
    expect(priorRounds()).toBe(1);
  });
});

/**
 * The PR-view transport (the ONE network reach, made swappable).
 *
 * What is worth pinning is not that a file can be read — it is that the swap cannot widen what the review
 * trusts. `gh` stays the default when nothing is staged; a staged view supplies the SAME field set; and a
 * missing or corrupt file FAILS rather than degrading to an empty view, which would silently review a PR as
 * if it had no body, no labels and no comments.
 */
describe('the PR-view transport', () => {
  it('defaults to gh when no view directory is staged', () => {
    expect(resolveViewReader({})).toBe(ghPrView);
  });

  it('swaps to the on-disk reader when WE_PR_VIEW_DIR is set', () => {
    expect(resolveViewReader({ WE_PR_VIEW_DIR: root })).not.toBe(ghPrView);
  });

  it('names a staged view by encoded slug and number', () => {
    expect(prViewFileName('web-everything/web-everything', 1465)).toBe('web-everything%2Fweb-everything-1465.json');
  });

  // The `-` flattening was NOT injective: a repo name may contain `-`, so two different repos landed on one
  // file and the second staged view silently answered for the first — wrong labels/body, right diff.
  it('never collides two different repos onto one file', () => {
    expect(prViewFileName('foo-bar/baz', 5)).not.toBe(prViewFileName('foo/bar-baz', 5));
  });

  it('reads a staged view the resolver points at', () => {
    const view = { number: 7, title: 'x', body: 'b', labels: [], comments: [], files: [], headRefName: 'lane/x' };
    writeFileSync(join(root, prViewFileName('o/r', 7)), JSON.stringify(view));
    expect(resolveViewReader({ WE_PR_VIEW_DIR: root })({ pr: 7, repo: 'o/r' })).toEqual(view);
  });

  it('THROWS on a missing staged view, naming the path and the way back to gh', () => {
    expect(() => filePrView({ pr: 9, repo: 'o/r', dir: root }))
      .toThrow(/no pre-fetched view at .*o%2Fr-9\.json[\s\S]*WE_PR_VIEW_DIR/);
  });

  it('THROWS on a corrupt staged view rather than yielding an empty one', () => {
    writeFileSync(join(root, prViewFileName('o/r', 9)), '{not json');
    expect(() => filePrView({ pr: 9, repo: 'o/r', dir: root })).toThrow(/is not valid JSON/);
  });

  it('asks both transports for the same field set', () => {
    expect(PR_VIEW_FIELDS).toContain('headRefName');
    expect(PR_VIEW_FIELDS).toContain('body');
    expect(PR_VIEW_FIELDS).toContain('labels');
    expect(PR_VIEW_FIELDS).toContain('comments');
    expect(PR_VIEW_FIELDS).toContain('files');
  });

  it('#3322 — asks for `createdAt`, so the stamp-regime comparison rides the same one `gh pr view`', () => {
    // #3067 tells a STRIPPED author stamp from one that never existed by comparing the PR's open date against
    // the regime start. Without the field on this list the read side would answer `unknown-author` for every
    // unstamped PR while `we:scripts/review-set-label.mjs` — which reads it on its own call — answered
    // `stamp-lost`: two answers to one question about one PR, which is the drift #2644 forbids.
    expect(PR_VIEW_FIELDS).toContain('createdAt');
    // And it is ONE call, not a second hop: the whole set still goes to a single `gh pr view --json`.
    expect(new Set(PR_VIEW_FIELDS).size).toBe(PR_VIEW_FIELDS.length);
  });
});

/**
 * The `readView` WIRING inside `readPr` — the integration point, not just the transports.
 *
 * The transports each had unit tests, but nothing called the real `readPr` with an injected `readView`, so a
 * dropped or misnamed argument at the one call site would have surfaced only against a live `gh` or a staged
 * file (review-pr correctness juror on #1466). `exec` is injected too, so this stays io-free: no `gh`, no
 * `git`, no network — the property the file header claims.
 */
/**
 * #3137 — THE CROSS-REPO REFUSAL. `readPr`'s net-diff git calls are rooted at `cwd`, so a `--repo=` target
 * that is not this checkout's own origin cannot be resolved locally. Before this fix that fell through to
 * `shapeReadFinding`'s `ref-unresolved` degrade path — an EMPTY diff, `degraded: true`, and no hard error
 * anywhere in the run (reproduced live against plateau-app#139). This is the false-pass hazard itself: a
 * judge handed nothing to find fault with reads as a clean, if slightly degraded, accept.
 */
describe('readPr refuses a cross-repo target rather than degrading to an empty diff (#3137)', () => {
  const VIEW = {
    number: 7, title: 'a title', url: 'https://example.invalid/7', body: 'a body',
    labels: [], comments: [], files: [{ path: 'a.mjs', additions: 1, deletions: 0 }], headRefName: 'lane/x',
  };

  it('throws when `repo` does not match this checkout\'s origin', () => {
    let gitCalls = 0;
    const countingExec = () => { gitCalls += 1; return ''; };
    expect(() => readPr({
      pr: 139, repo: 'plateauapp/plateau-app', exec: countingExec, cwd: '/somewhere',
      originRepo: () => 'org/web-everything', readView: () => ({ ...VIEW, number: 139 }),
    })).toThrow(/refusing to review plateauapp\/plateau-app#139.*origin is org\/web-everything/s);
    // Refuses BEFORE any net-diff git call — the mismatch never reaches `git`, exactly like the
    // wrong-PR-number refusal a few lines up.
    expect(gitCalls).toBe(0);
  });

  it('refuses BEFORE the `gh`/view transport is even called — no wasted round trip on a target it cannot use', () => {
    let called = 0;
    const readView = () => { called += 1; return VIEW; };
    expect(() => readPr({
      pr: 139, repo: 'plateauapp/plateau-app', exec: () => '', originRepo: () => 'org/web-everything', readView,
    })).toThrow();
    expect(called).toBe(0);
  });

  it('treats an unresolvable origin (empty string) as a mismatch too, never as a silent pass', () => {
    expect(() => readPr({
      pr: 7, repo: 'o/n', exec: () => '', originRepo: () => '', readView: () => VIEW,
    })).toThrow(/origin is \(unknown\)/);
  });

  it('proceeds normally when `repo` matches this checkout\'s origin', () => {
    expect(() => readPr({
      pr: 7, repo: 'o/n', exec: () => '', originRepo: () => 'o/n', readView: () => VIEW,
    })).not.toThrow();
  });

  it('defaults `originRepo` to the real git-backed resolver, so production callers get the check for free', () => {
    // No `originRepo` injected — this exercises the real `defaultOriginRepo` against a `cwd` that is not a
    // git checkout at all, which resolves to '' and therefore never matches a real `repo`.
    expect(() => readPr({
      pr: 7, repo: 'o/n', exec: () => '', cwd: '/definitely-not-a-git-checkout-3137', readView: () => VIEW,
    })).toThrow(/review-pr-io: refusing to review/);
  });
});

/**
 * #3137 — `createReviewPrReader` is the closure production wiring actually calls (`run.mjs`); it must thread
 * the new `originRepo` override through to `readPr` rather than silently dropping it, which a mere line-count
 * check on the pass-through cannot catch.
 */
describe('createReviewPrReader threads `originRepo` through to `readPr` (#3137)', () => {
  const VIEW = {
    number: 7, title: 't', url: 'https://example.invalid/7', body: '',
    labels: [], comments: [], files: [], headRefName: 'lane/x',
  };

  it('refuses a cross-repo target using the injected `originRepo`, not just the default', () => {
    const reader = createReviewPrReader({
      exec: () => '', cwd: '/somewhere', originRepo: () => 'org/other-repo',
    });
    expect(() => reader({ pr: 7, repo: 'org/web-everything' })).toThrow(/refusing to review org\/web-everything#7/);
  });

  it('reads normally when the injected `originRepo` matches — proceeds past the refusal to the view transport', () => {
    // Stage a view via WE_PR_VIEW_DIR (`readPr`'s default `readView` resolves `process.env` per call) so this
    // stays io-free rather than reaching real `gh`. `createReviewPrReader` takes no `readView` of its own, so
    // this is the only way to prove the reader gets PAST the mismatch check without a network call.
    writeFileSync(join(root, prViewFileName('o/n', 7)), JSON.stringify(VIEW));
    const before = process.env.WE_PR_VIEW_DIR;
    process.env.WE_PR_VIEW_DIR = root;
    try {
      const reader = createReviewPrReader({ exec: () => '', originRepo: () => 'o/n' });
      const out = reader({ pr: 7, repo: 'o/n' });
      expect(out.headRefName).toBe('lane/x');
    } finally {
      if (before === undefined) delete process.env.WE_PR_VIEW_DIR;
      else process.env.WE_PR_VIEW_DIR = before;
    }
  });
});

describe('readPr wires the injected view transport', () => {
  const VIEW = {
    number: 7, title: 'a title', url: 'https://example.invalid/7', body: 'a body',
    labels: [{ name: 'review:pending' }], comments: [], files: [{ path: 'a.mjs', additions: 1, deletions: 0 }],
    headRefName: 'lane/x',
  };
  // Enough of a git for the net-diff helpers to resolve a basis and an empty diff without touching a repo.
  const execStub = () => '';
  // #3137 — this checkout's origin, stubbed to match `repo: 'o/n'` in every call below, so these tests
  // exercise the WIRING (readView, exec) rather than the repo-mismatch refusal, which has its own tests.
  const originRepoStub = () => 'o/n';

  it('calls readView with the pr, repo and cwd it was given', () => {
    const seen = [];
    readPr({
      pr: 7, repo: 'o/n', exec: execStub, cwd: '/somewhere', originRepo: originRepoStub, readView: (o) => { seen.push(o); return VIEW; },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ pr: 7, repo: 'o/n', cwd: '/somewhere' });
  });

  it('carries the transport-supplied view through into the read finding', () => {
    const out = readPr({
      pr: 7, repo: 'o/n', exec: execStub, originRepo: originRepoStub, readView: () => VIEW,
    });
    expect(out.headRefName).toBe('lane/x');
    expect(out.body).toBe('a body');
  });

  /**
   * #3322 — THE TWO HALVES OF THE INDEPENDENCE COMPARISON REACH THE PURE SHAPER.
   *
   * The refusal itself lives in `shapeReadFinding` (`we:scripts/operations/review-pr.mjs`) and is tested
   * there. What can only be tested HERE is the wiring: the shaper is pure, so if the io shell drops either
   * field the guard silently answers `unknown-clearer` on every run and refuses nothing — green tests, dead
   * guard. That is the same shape of miss the `readView` block above exists for.
   */
  it('#3322 — carries the PR open date and this process\'s actor id up for the independence check', () => {
    const before = process.env.CLAUDE_CODE_SESSION_ID;
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-under-test';
    try {
      const out = readPr({
        pr: 7, repo: 'o/n', exec: execStub, originRepo: originRepoStub,
        readView: () => ({ ...VIEW, createdAt: '2026-08-20T00:00:00Z' }),
      });
      expect(out.createdAt).toBe('2026-08-20T00:00:00Z');
      // READ FROM THE ENVIRONMENT, never from argv or the view — the #2844 property this whole comparison
      // rests on. Setting the env var moves this value; nothing a caller passes can.
      expect(out.clearerId).toBe('sess-under-test');
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
      else process.env.CLAUDE_CODE_SESSION_ID = before;
    }
  });

  it('#3322 — a view with no `createdAt` degrades to "" rather than undefined, and never throws', () => {
    // A pre-fetched view staged by hand (`WE_PR_VIEW_DIR`) may simply omit it. `distinguishMissingAuthorStamp`
    // treats an unparseable date as NEVER_STAMPED, i.e. the pre-#3067 behaviour — no new false refusal.
    const out = readPr({
      pr: 7, repo: 'o/n', exec: execStub, originRepo: originRepoStub, readView: () => VIEW,
    });
    expect(out.createdAt).toBe('');
  });

  it('validates pr and repo BEFORE calling the transport — a bad request never reaches it', () => {
    let called = 0;
    const readView = () => { called += 1; return VIEW; };
    expect(() => readPr({ pr: 0, repo: 'o/n', exec: execStub, readView })).toThrow(/positive integer/);
    expect(() => readPr({ pr: 7, repo: 'not-a-slug', exec: execStub, readView })).toThrow(/owner\/name/);
    expect(called).toBe(0);
  });

  it('propagates a transport failure rather than reviewing an empty view', () => {
    expect(() => readPr({
      pr: 7, repo: 'o/n', exec: execStub, originRepo: originRepoStub,
      readView: () => { throw new Error('no pre-fetched view at /x.json'); },
    })).toThrow(/no pre-fetched view/);
  });

  /**
   * THE SUBJECT CROSS-CHECK. Round 1 of this PR's review made the FILENAME injective; the juror's round-2
   * finding was that the CONTENT under it was still never checked. A view for a different PR — staged by
   * copy-paste, or left stale under the right name — was accepted whole, and since `headRefName` decides the
   * diff basis, the judged DIFF was that other PR's too. Nothing downstream could notice: every consumer is
   * told it is looking at the PR that was requested. `impactIfUnfixed: broken`, and no test defended it.
   */
  it('REFUSES a view whose number is not the PR that was asked for', () => {
    expect(() => readPr({
      pr: 7, repo: 'o/n', exec: execStub, originRepo: originRepoStub, readView: () => ({ ...VIEW, number: 999 }),
    })).toThrow(/refusing to review o\/n#7 .*has #999/);
  });

  it('names the file to re-stage, so the operator can act on the refusal', () => {
    let message = '';
    try {
      readPr({
        pr: 7, repo: 'o/n', exec: execStub, originRepo: originRepoStub, readView: () => ({ ...VIEW, number: 999 }),
      });
    } catch (e) { message = e.message; }
    expect(message).toContain(prViewFileName('o/n', 7));
    expect(message).toContain('WE_PR_VIEW_DIR');
  });

  it('refuses a view with NO number — absent is not better evidence than wrong', () => {
    const { number, ...noNumber } = VIEW;
    expect(() => readPr({
      pr: 7, repo: 'o/n', exec: execStub, originRepo: originRepoStub, readView: () => noNumber,
    })).toThrow(/no `number` field at all/);
  });

  it('refuses BEFORE the diff basis is resolved — the wrong PR never reaches git', () => {
    let gitCalls = 0;
    const countingExec = () => { gitCalls += 1; return ''; };
    expect(() => readPr({
      pr: 7, repo: 'o/n', exec: countingExec, originRepo: originRepoStub, readView: () => ({ ...VIEW, number: 999 }),
    })).toThrow();
    expect(gitCalls).toBe(0);
  });

  it('accepts a number that matches, however the transport spells it', () => {
    // `gh --json` yields a JSON number; a hand-staged file may carry the string. Both name the same PR.
    for (const number of [7, '7']) {
      expect(() => readPr({
        pr: 7, repo: 'o/n', exec: execStub, originRepo: originRepoStub, readView: () => ({ ...VIEW, number }),
      })).not.toThrow();
    }
  });
});


describe('the subject checkout is DERIVED from the constellation siblings (#xgmzd0y)', () => {
  // Origins keyed by path — the only fact the resolver is allowed to match on.
  const origins = {
    '/pool/lane-1': 'web-everything/web-everything',
    '/pool/frontierui': 'frontier-ui/frontierui',
    '/pool/plateau-app': 'plateauapp/plateau-app',
  };
  const originRepo = (cwd) => origins[cwd] ?? '';
  const siblings = () => ([
    { name: 'frontierui', path: '/pool/frontierui', present: true },
    { name: 'plateau-app', path: '/pool/plateau-app', present: true },
  ]);

  it('returns the current checkout when it already IS the requested repo', () => {
    const got = resolveSubjectCheckout({ repo: 'web-everything/web-everything', cwd: '/pool/lane-1', originRepo, siblings });
    expect(got.path).toBe('/pool/lane-1');
    // Resolved on the first probe — no sibling walk when the answer is underfoot.
    expect(got.probed).toEqual(['/pool/lane-1']);
  });

  it('finds the sibling clone whose ORIGIN matches, which is the whole point', () => {
    expect(resolveSubjectCheckout({ repo: 'frontier-ui/frontierui', cwd: '/pool/lane-1', originRepo, siblings }).path)
      .toBe('/pool/frontierui');
    expect(resolveSubjectCheckout({ repo: 'plateauapp/plateau-app', cwd: '/pool/lane-1', originRepo, siblings }).path)
      .toBe('/pool/plateau-app');
  });

  it('matches on origin and NEVER on directory name — the constellation answers to several basenames', () => {
    // The directory is called `frontierui`, but its origin is somebody else's fork. Name says yes, origin says
    // no, and origin is the fact that decides.
    const forked = (cwd) => (cwd === '/pool/frontierui' ? 'someone-else/frontierui' : origins[cwd] ?? '');
    expect(resolveSubjectCheckout({ repo: 'frontier-ui/frontierui', cwd: '/pool/lane-1', originRepo: forked, siblings }).path)
      .toBeNull();
  });

  it('skips an ABSENT sibling rather than probing a path that is not there', () => {
    const missing = () => ([{ name: 'frontierui', path: '/pool/frontierui', present: false }]);
    const got = resolveSubjectCheckout({ repo: 'frontier-ui/frontierui', cwd: '/pool/lane-1', originRepo, siblings: missing });
    expect(got.path).toBeNull();
    expect(got.probed).toEqual(['/pool/lane-1']);
  });

  it('returns null (never a guess) when no checkout has that origin, naming everywhere it looked', () => {
    const got = resolveSubjectCheckout({ repo: 'chalbert/nothing-here', cwd: '/pool/lane-1', originRepo, siblings });
    expect(got.path).toBeNull();
    expect(got.probed).toEqual(['/pool/lane-1', '/pool/frontierui', '/pool/plateau-app']);
  });

  it('prefers the POOL-LOCAL clone over the shared primary (#2123)', () => {
    // What the real table answers from a lane: the PRIMARY checkout, because `siblingsFor` probes the
    // primary's parent first. Both clones exist and both have the right origin — the isolated one must win.
    const bothExist = (cwd) => ({
      '/pool/lane-1': 'web-everything/web-everything',
      '/home/user/frontierui': 'frontier-ui/frontierui',
      '/pool/frontierui': 'frontier-ui/frontierui',
    })[cwd] ?? '';
    const primaryFirst = () => ([{ name: 'frontierui', path: '/home/user/frontierui', present: true }]);

    const got = resolveSubjectCheckout({
      repo: 'frontier-ui/frontierui', cwd: '/pool/lane-1', originRepo: bothExist, siblings: primaryFirst,
    });
    expect(got.path).toBe('/pool/frontierui');
    // And it tried the pool-local path BEFORE the primary, which is the ordering being pinned.
    expect(got.probed.indexOf('/pool/frontierui')).toBeLessThan(
      got.probed.indexOf('/home/user/frontierui') === -1 ? Infinity : got.probed.indexOf('/home/user/frontierui'),
    );
  });

  it('falls back to the table path when no pool-local clone exists', () => {
    const onlyPrimary = (cwd) => (cwd === '/home/user/plateau-app' ? 'plateauapp/plateau-app' : '');
    const table = () => ([{ name: 'plateau-app', path: '/home/user/plateau-app', present: true }]);
    expect(resolveSubjectCheckout({
      repo: 'plateauapp/plateau-app', cwd: '/pool/lane-1', originRepo: onlyPrimary, siblings: table,
    }).path).toBe('/home/user/plateau-app');
  });

  it('covers EVERY constellation member, not just frontierui', () => {
    const pool = (cwd) => ({
      '/pool/lane-1': 'web-everything/web-everything',
      '/pool/frontierui': 'frontier-ui/frontierui',
      '/pool/plateau-app': 'plateauapp/plateau-app',
    })[cwd] ?? '';
    const table = () => ([
      { name: 'frontierui', path: '/pool/frontierui', present: true },
      { name: 'plateau-app', path: '/pool/plateau-app', present: true },
    ]);
    const at = (repo) => resolveSubjectCheckout({ repo, cwd: '/pool/lane-1', originRepo: pool, siblings: table }).path;
    expect(at('web-everything/web-everything')).toBe('/pool/lane-1');
    expect(at('frontier-ui/frontierui')).toBe('/pool/frontierui');
    expect(at('plateauapp/plateau-app')).toBe('/pool/plateau-app');
  });

  it('survives a throwing sibling table — the GUARD speaks, not a crash', () => {
    const exploding = () => { throw new Error('no constellation table here'); };
    const got = resolveSubjectCheckout({ repo: 'frontier-ui/frontierui', cwd: '/pool/lane-1', originRepo, siblings: exploding });
    expect(got.path).toBeNull();
  });

  it('the reader roots `readPr` at the resolved sibling, so a FUI PR gets PAST the cross-repo guard', () => {
    // The guard's own fact is `originRepo(cwd)`, so spying on it records exactly which checkout `readPr` was
    // rooted at — the thing under test. The read fails afterwards (no `gh` here), which is fine: what is being
    // pinned is that the failure is NOT the #3137 refusal.
    const checked = [];
    const spyOrigin = (cwd) => { checked.push(cwd); return originRepo(cwd); };
    const reader = createReviewPrReader({ cwd: '/pool/lane-1', originRepo: spyOrigin, siblings });

    let err;
    try { reader({ pr: 43, repo: 'frontier-ui/frontierui' }); } catch (e) { err = e; }

    // Rooted at the FUI clone, not the WE lane it was driven from.
    expect(checked.at(-1)).toBe('/pool/frontierui');
    // And it cleared the guard: whatever went wrong next, it was not the cross-repo refusal.
    expect(String(err?.message ?? '')).not.toMatch(/refusing to review/);
  });

  it('an unresolvable subject still hits the #3137 refusal, which now names where it looked', () => {
    const reader = createReviewPrReader({ cwd: '/pool/lane-1', originRepo, siblings });
    expect(() => reader({ pr: 1, repo: 'chalbert/nothing-here' }))
      .toThrow(/refusing to review chalbert\/nothing-here#1[\s\S]*probed 3 checkout\(s\)[\s\S]*\/pool\/frontierui/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
// #xu2pp2m — `--cwd` REACHES THE DIFF READER, NOT ONLY THE JURORS.
//
// THE LIVE DEFECT (PR #2122, 2026-09-12, and the PR MERGED on it). `run.mjs`'s operation table built
// `createReviewPrReader()` with NO arguments, so the reader's `cwd` was `REPO_ROOT` on every call. `--cwd=`
// reached `createCliJudgeFactory` and stopped there. Every MECHANICAL review — which always passes a lane,
// that being the whole point of the wrapper — therefore read its diff from a checkout nobody had chosen; in a
// single-branch lane clone with no remote-tracking ref for the PR's head branch that produced
// `degraded: 'ref-unresolved'` and a zero-byte diff, which nothing then refused.
//
// WHY THE TEST DRIVES `resolveOperation` AND NOT A HAND-BUILT READER. The whole defect WAS the table entry:
// `createReviewPrReader({ cwd })` already worked perfectly (the block above proves it), and nothing called it
// that way. A test that re-creates the wiring instead of exercising it is exactly the shape that let this
// ship — the same reason `createCliJudgeFactory` is exported and driven directly rather than re-derived
// (#3151, "deleting the flags from this file entirely left 14 of 15 tests green").
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════

describe('#xu2pp2m — `--cwd` decides which checkout the DIFF is read from', () => {
  /**
   * A REAL git checkout with a DISTINCTIVE origin, because the cwd is not otherwise observable from outside
   * the reader. The #3137 guard's refusal quotes `git remote get-url origin` AS RESOLVED AT THE READ'S CWD —
   * so a unique origin slug there is a direct, unforgeable read of which checkout the diff would have come
   * from. (The earlier attempt used a nonexistent path and asserted on the probed-checkout list; that list is
   * only printed when more than one candidate was probed, so it said nothing here.)
   */
  let namedCwd;
  const NAMED_ORIGIN = 'xu2pp2m-owner/xu2pp2m-subject';
  beforeEach(() => {
    namedCwd = mkdtempSync(join(tmpdir(), 'xu2pp2m-cwd-'));
    const git = (...args) => execFileSync('git', args, { cwd: namedCwd, stdio: 'ignore' });
    git('init', '-q');
    git('remote', 'add', 'origin', `git@github.com:${NAMED_ORIGIN}.git`);
  });
  afterEach(() => { rmSync(namedCwd, { recursive: true, force: true }); });

  const driveRead = (opts) => {
    const { registry } = resolveOperation(REVIEW_PR_OP, opts);
    try {
      advanceWhileRunning(
        startRun({ op: REVIEW_PR_OP, id: `run-cwd-${Math.random()}`, input: { pr: 1, repo: 'o/n' }, registry }),
        { registry },
      );
    } catch (e) { return String(e.message); }
    return '';
  };

  it('`cwdFlagValue` reads both `--cwd=<v>` and `--cwd <v>`, and answers null for neither', () => {
    expect(cwdFlagValue(['--pr=1', '--cwd=/lanes/lane-3', '--json'])).toBe('/lanes/lane-3');
    // The space-separated form matters: `parseOperationArgv` accepts it for control flags, so a helper that
    // only understood `--cwd=` would silently fall back to REPO_ROOT for exactly the shape that DID name a lane.
    expect(cwdFlagValue(['--pr=1', '--cwd', '/lanes/lane-4'])).toBe('/lanes/lane-4');
    expect(cwdFlagValue(['--pr=1', '--json'])).toBeNull();
    expect(cwdFlagValue(['--cwd', '--json'])).toBeNull(); // a flag is not a value
    expect(cwdFlagValue(['--cwd='])).toBeNull();
    expect(cwdFlagValue([])).toBeNull();
  });

  it('the REAL operation table roots the reader at the `cwd` it was given', () => {
    // The guard resolves `git remote get-url origin` AT THE READ'S CWD and quotes the answer. Only a read
    // actually rooted at `namedCwd` can produce this slug.
    expect(driveRead({ cwd: namedCwd })).toContain(NAMED_ORIGIN);
  });

  it('REGRESSION — with no `cwd`, the read is NOT rooted there, which is exactly how #2122 happened', () => {
    // THE BEFORE/AFTER, as one pair: "not rooted at the named checkout" is the state the old table entry was
    // ALWAYS in — for every invocation, `--cwd` or not. Revert the fix and the test above produces this.
    expect(driveRead({})).not.toContain(NAMED_ORIGIN);
    expect(driveRead({ cwd: null })).not.toContain(NAMED_ORIGIN);
  });
});

describe('operator-ruling carry: default changed-lines reader', () => {
  const patch = '@@ -1,2 +1,3 @@\n a\n+b\n c\n@@ -20 +21,2 @@\n x\n+y';
  const compare = (files, status = 'ahead') => ({ status, files });
  it('parses hunk ranges from a compare payload (new side)', () => {
    expect([...changedLinesFromCompare(compare([{ filename: 'a.mjs', status: 'modified', patch }]), 'a.mjs')]).toEqual([1, 2, 3, 21, 22]);
  });
  it.each([
    ['a diverged compare (three-dot diffs from the merge base, not the ruled head)', compare([], 'diverged')],
    ['a behind compare', compare([], 'behind')],
    ['a missing file list', { status: 'ahead' }],
    ['a rename', compare([{ filename: 'a.mjs', previous_filename: 'old.mjs', status: 'renamed', patch }])],
    ['a removed file', compare([{ filename: 'a.mjs', status: 'removed', patch: '@@ -1,2 +0,0 @@\n-a\n-b' }])],
    ['a missing patch', compare([{ filename: 'a.mjs', status: 'modified' }])],
    ['a payload without hunks', compare([{ filename: 'a.mjs', status: 'modified', patch: 'Binary files differ' }])],
    ['a truncated file list that omits the file', compare(Array.from({ length: COMPARE_FILE_CAP }, (_, i) => ({ filename: `f${i}`, status: 'modified', patch })))],
    ['null', null],
  ])('fails closed (null) on %s', (_, payload) => {
    expect(changedLinesFromCompare(payload, 'a.mjs', () => true)).toBeNull();
  });
  it('treats a file absent from a complete list as unchanged only when it exists at both ends', () => {
    expect(changedLinesFromCompare(compare([]), 'a.mjs', () => true)).toEqual(new Set());
    expect(changedLinesFromCompare(compare([]), 'A.MJS', () => false)).toBeNull();
    expect(changedLinesFromCompare(compare([], 'identical'), 'a.mjs', () => true)).toEqual(new Set());
  });
  it('stubbed gh: one compare per (repo, base, head), existence probed at both refs, failures fail closed', () => {
    const calls = [];
    const reader = createChangedLinesReader(args => {
      calls.push(args[1]);
      if (args[1].includes('/compare/')) return compare([{ filename: 'a.mjs', status: 'modified', patch }]);
      if (args[1].includes('gone.mjs')) throw new Error('404');
      if (args[1].includes('contents/src/dir')) return [{ type: 'file', name: 'x.mjs' }];
      if (args[1].includes('contents/sub.mjs')) return { type: 'submodule' };
      return { type: 'file' };
    });
    expect(reader('o/r', 'b'.repeat(40), 'h'.repeat(40), 'a.mjs')).toEqual(new Set([1, 2, 3, 21, 22]));
    expect(reader('o/r', 'b'.repeat(40), 'h'.repeat(40), 'other.mjs')).toEqual(new Set());
    expect(reader('o/r', 'b'.repeat(40), 'h'.repeat(40), 'gone.mjs')).toBeNull();
    expect(reader('o/r', 'b'.repeat(40), 'h'.repeat(40), 'src/dir')).toBeNull(); // a directory is not a file
    expect(reader('o/r', 'b'.repeat(40), 'h'.repeat(40), 'sub.mjs')).toBeNull(); // nor a submodule
    expect(calls.filter(c => c.includes('/compare/'))).toHaveLength(1);
    expect(calls.some(c => c.includes(`contents/other.mjs?ref=${'b'.repeat(40)}`))).toBe(true);
    expect(calls.some(c => c.includes(`contents/other.mjs?ref=${'h'.repeat(40)}`))).toBe(true);
    const failing = createChangedLinesReader(() => { throw new Error('boom'); });
    expect(failing('o/r', 'b', 'h', 'a.mjs')).toBeNull();
  });
  // Every way a diff can change code without ADDING a line: a pure deletion (`+N,0`), a pure insertion's old side
  // (`-N,0`), and deleted old lines whose surviving new-side range sits somewhere else entirely.
  it.each([
    ['a pure deletion (+N,0) marks the neighbouring new lines', '@@ -10,3 +9,0 @@\n-a\n-b\n-c', [9, 10], [10, 11, 12]],
    ['a deletion at the top of the file (+0,0)', '@@ -1,2 +0,0 @@\n-a\n-b', [0, 1], [1, 2]],
    ['a pure insertion marks the neighbouring old lines (-N,0)', '@@ -5,0 +6,2 @@\n+a\n+b', [6, 7], [5, 6]],
    ['a single-line hunk without counts', '@@ -4 +4 @@\n-a\n+b', [4], [4]],
  ])('%s', (_, hunkPatch, expectedNew, expectedOld) => {
    const changed = changedLinesFromCompare(compare([{ filename: 'a.mjs', status: 'modified', patch: hunkPatch }]), 'a.mjs');
    expect([...changed].sort((a, b) => a - b)).toEqual(expectedNew);
    expect([...changed.old].sort((a, b) => a - b)).toEqual(expectedOld);
  });
  it('a deletion next to a cited line blocks the carry (the empty-set bug)', () => {
    const changed = changedLinesFromCompare(compare([{ filename: 'a.mjs', status: 'modified', patch: '@@ -13,2 +12,0 @@\n-a\n-b' }]), 'a.mjs');
    expect(changed.size).toBeGreaterThan(0);
    expect(changesTouchCitedLines(changed, [12, 12])).toBe(true);
    expect(changesTouchCitedLines(changed, [null, null])).toBe(true);
  });
  it('window boundary: a change within ±3 of either cited line blocks the carry, ±4 does not', () => {
    expect(changesTouchCitedLines(new Set([15]), [12, 40])).toBe(true);
    expect(changesTouchCitedLines(new Set([16]), [12, 40])).toBe(false);
    expect(changesTouchCitedLines(new Set([9]), [12, 40])).toBe(true);
    expect(changesTouchCitedLines(new Set([8]), [12, 40])).toBe(false);
    expect(changesTouchCitedLines(new Set([37]), [12, 40])).toBe(true);
    expect(changesTouchCitedLines(new Set([100]), [12, null])).toBe(true);
    expect(changesTouchCitedLines(new Set(), [12, null])).toBe(false);
  });
});

describe('#4315 durable referral effects', () => {
  function harness({ result = 'not-real', failure, env = {}, readChangedLines = () => new Set() } = {}) {
    const head = 'a'.repeat(40), trace = [], lines = [];
    let posts = 0;
    const state = { headRefOid: head, body: '<!-- authored-by-actor: author -->', comments: [], labels: ['review:pending'] };
    const payload = { read: { repo: 'o/r', pr: 7, title: 'review', body: state.body, netBasis: { rev: head },
      netChangedFiles: ['x.mjs'], diffText: '+ change' },
      referrals: [{ seat: 'judgeCorrectnessAdvisory', original: { summary: 'broken', file: 'x.mjs', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' } }] };
    const provider = {
      readPrState: () => { trace.push('read'); return structuredClone(state); },
      postComment: (repo, pr, body) => {
        trace.push('post');
        if (!body.includes('<!-- mandatory-referrals-v1:')) { state.comments.push({ body, author: { login: 'web-everything' } }); return; }
        posts++;
        if (failure === 'post' || (failure === 'attempt' && posts === 2)
          || (['completion', 'failure-snapshot'].includes(failure) && posts === 3)) throw new Error('post unavailable');
        if (failure !== 'read-back') state.comments.push({ body, author: { login: 'web-everything' } });
        if (failure === 'changed-head') state.headRefOid = 'b'.repeat(40);
      },
      setLabels: (repo, pr, plan) => { trace.push(`label:${plan.add}`); state.labels = [...state.labels.filter(l => !plan.remove.includes(l)), plan.add]; },
    };
    const judge = vi.fn(async request => {
      trace.push('judge');
      if (['judge', 'failure-snapshot'].includes(failure)) throw new Error('budget exhausted');
      const referrals = JSON.parse(request.input.split('\nUntrusted reported findings:\n')[1]);
      return { sessionId: failure === 'identity' ? 'forged' : request.sessionId,
        timedOut: failure === 'timeout', value: { rulings: failure === 'omitted' ? [] : referrals.map(f => ({
          key: f.key, result, rationale: 'Checked diff', evidence: ['diff:x'],
          card: result === 'card' ? 'we:backlog/7-filed.md' : '',
        })) } };
    });
    const make = () => createReviewPrSinks({ root, env, readChangedLines, labelProvider: provider, referralJudge: judge,
      mirrorReferral: record => trace.push(`mirror:${record.attempted}`), out: line => lines.push(line), cardReadable: () => failure !== 'card' });
    return { state, trace, lines, payload, judge, make, provider };
  }

  it.each(['unchanged', 'changed', 'old-line-changed', 'unknown', 'disabled'])('carries an earlier operator ruling only with unchanged lines: %s', async mode => {
    const h = harness({ failure: 'omitted', env: mode === 'disabled' ? { WE_REFERRAL_CARRY_OPERATOR_RULINGS: '0' } : {},
      readChangedLines: () => mode === 'unknown' ? null : new Set(mode === 'changed' ? [12] : mode === 'old-line-changed' ? [18] : []) });
    // The earlier ruled finding cited line 15, this one cites 12: line 18 is within ±3 of the OLD line only.
    h.payload.referrals[0].original.line = mode === 'old-line-changed' ? 15 : 12;
    const old = seedReferrals(h, ['judgeCorrectnessAdvisory']);
    const original = { ...old.referrals[0].original, line: 12 };
    const current = { ...old, head: h.state.headRefOid, runId: 'current',
      referrals: [{ ...old.referrals[0], original, finding: normalizeFinding(original),
        key: referralFindingKey('judgeCorrectnessAdvisory', original) }],
      reviewer: mandatoryReferralReviewer('current'), attempted: false };
    h.state.comments.push({ body: renderReferralRecord(current), author: { login: 'web-everything' } });
    h.state.comments.push({ author: { login: 'chalbert' }, body: buildOperatorRulingComment({
      version: 1, repo: old.repo, pr: old.pr, head: old.head, actor: 'chalbert', channel: 'test',
      reason: 'not a defect', at: '2026-10-04T12:00:00Z', clearerId: '',
      rulings: [{ runId: old.runId, key: old.referrals[0].key, result: 'not-real' }],
    }) });
    const result = await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX);
    const latest = readReferralRecords(h.state.comments).records.find(r => r.runId === 'current');
    if (mode === 'unchanged') {
      expect(latest.carried).toHaveLength(1);
      expect(h.judge).not.toHaveBeenCalled();
      expect(result.pending).toEqual([]);
    } else {
      expect(latest.carried).toBeUndefined();
      // (the old-line mode seeds a second, differently keyed record, so the judge may sit twice; the current finding is always sent)
      expect(h.judge.mock.calls.some(([req]) => JSON.parse(req.input.split('\nUntrusted reported findings:\n')[1])
        .some(f => f.key === current.referrals[0].key))).toBe(true);
      expect(result.pending).toContain(current.referrals[0].key);
    }
  });

  // An earlier-head operator not-real on `oldLine`, and the SAME finding on the current head at `curLine`.
  function seedCarry(h, { oldLine = 12, curLine = 12, attempted = false, rule = () => [], operatorRuling = { result: 'not-real' }, curPatch = {} } = {}) {
    h.payload.referrals[0].original.line = oldLine;
    const old = seedReferrals(h, ['judgeCorrectnessAdvisory']);
    const original = { ...old.referrals[0].original, line: curLine, ...curPatch };
    const current = { ...old, head: h.state.headRefOid, runId: 'current',
      referrals: [{ ...old.referrals[0], original, finding: normalizeFinding(original),
        key: referralFindingKey('judgeCorrectnessAdvisory', original) }],
      reviewer: mandatoryReferralReviewer('current'), attempted, rulings: [] };
    current.rulings = rule(current);
    h.state.comments.push({ body: renderReferralRecord(current), author: { login: 'web-everything' } });
    h.state.comments.push({ author: { login: 'chalbert' }, body: buildOperatorRulingComment({
      version: 1, repo: old.repo, pr: old.pr, head: old.head, actor: 'chalbert', channel: 'test',
      reason: 'not a defect', at: '2026-10-04T12:00:00Z', clearerId: '',
      rulings: [{ runId: old.runId, key: old.referrals[0].key, ...operatorRuling }] }) });
    return { old, current };
  }
  const realReader = patch => () => changedLinesFromCompare({ status: 'ahead', files: [{ filename: 'x.mjs', status: 'modified', patch }] }, 'x.mjs');

  it.each([
    ['a pure deletion next to the cited line', { oldLine: 12, curLine: 12 }, '@@ -13,2 +12,0 @@\n-a\n-b'],
    ['a deletion of the OLD cited line whose surviving new-side range lies elsewhere', { oldLine: 15, curLine: 12 }, '@@ -15,1 +40,0 @@\n-a'],
  ])('does not carry an operator ruling across %s', async (_, lines, patch) => {
    const h = harness({ failure: 'omitted', readChangedLines: realReader(patch) });
    const { current } = seedCarry(h, lines);
    const result = await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX);
    expect(readReferralRecords(h.state.comments).records.find(r => r.runId === 'current').carried).toBeUndefined();
    expect(result.pending).toContain(current.referrals[0].key);
  });

  // #76c — the mandatory reviewer's OWN earlier counted ruling carries onto the same finding (moved line, same
  // identity) on the new head, with no operator involved, and never a block, never over changed cited lines.
  const reviewerCarryHarness = (h, result, { curLine = 12, card, summary, ruled = [] } = {}) => {
    h.payload.referrals[0].original.line = 12;
    h.payload.referrals[0].original.quote = 'await withListLock(() => writeHeld(list));';
    const old = seedReferrals(h, ['judgeCorrectnessAdvisory'], 'c'.repeat(40), (r) => [{
      id: 'earlier-run:0', key: r.referrals[0].key, reviewerId: r.reviewer.id, lens: r.reviewer.lens, result,
      rationale: 'Checked the diff', evidence: ['diff:x'], ...(card ? { card } : {}) }]);
    // Same claim, the line moved: only a punctuation-level re-wording carries (a different claim is re-ruled).
    const original = { ...old.referrals[0].original, line: curLine, summary: summary ?? `${old.referrals[0].original.summary}.` };
    // `ruled`: other findings already ruled `not-real` by the reviewer on this record (ids `current:0`…).
    const others = ruled.map(o => ({ seat: 'judgeCorrectnessAdvisory', original: o, finding: normalizeFinding(o),
      key: referralFindingKey('judgeCorrectnessAdvisory', o) }));
    const current = { ...old, head: h.state.headRefOid, runId: 'current', rulings: [],
      referrals: [{ seat: 'judgeCorrectnessAdvisory', original, finding: normalizeFinding(original),
        key: referralFindingKey('judgeCorrectnessAdvisory', original) }, ...others],
      reviewer: mandatoryReferralReviewer('current'), attempted: false };
    current.rulings = others.map((x, n) => ({ id: `current:${n}`, key: x.key, reviewerId: current.reviewer.id,
      lens: current.reviewer.lens, result: 'not-real', rationale: 'Checked the diff', evidence: ['diff:x'] }));
    h.state.comments.push({ body: renderReferralRecord(current), author: { login: 'web-everything' } });
    return { old, current };
  };

  it.each(['not-real', 'card'])('carries the reviewer\'s own earlier %s ruling onto a re-worded finding with unchanged lines', async (result) => {
    const h = harness({ failure: 'omitted', readChangedLines: () => new Set() });
    const { current } = reviewerCarryHarness(h, result, { card: result === 'card' ? 'we:backlog/7-filed.md' : undefined });
    const out = await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX);
    const latest = readReferralRecords(h.state.comments).records.find(r => r.runId === 'current');
    expect(latest.carried).toHaveLength(1);
    expect(latest.carried[0]).toMatchObject({ result, from: { rulingId: 'earlier-run:0', runId: 'earlier-run' } });
    expect(h.judge).not.toHaveBeenCalled();           // one ruling stands: the reviewer is not asked again
    expect(out.pending).toEqual([]);
    expect(h.lines.join('\n')).toContain('reviewer ' + result);
    expect(current.referrals[0].key).toBe(latest.referrals[0].key);
  });

  it('never carries a reviewer BLOCK, and not a not-real over changed cited lines', async () => {
    const blocked = harness({ failure: 'omitted', readChangedLines: () => new Set() });
    const b = reviewerCarryHarness(blocked, 'block');
    await blocked.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](blocked.payload, CTX);
    expect(readReferralRecords(blocked.state.comments).records.find(r => r.runId === 'current').carried).toBeUndefined();
    const changed = harness({ failure: 'omitted', readChangedLines: () => new Set([12]) });
    const c = reviewerCarryHarness(changed, 'not-real');
    const out = await changed.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](changed.payload, CTX);
    expect(readReferralRecords(changed.state.comments).records.find(r => r.runId === 'current').carried).toBeUndefined();
    expect(out.pending).toContain(c.current.referrals[0].key);
    expect(b.current.referrals[0].key).toBeTruthy();
  });

  it('does not carry a reviewer ruling onto another claim quoting the same code, nor onto the same claim far away', async () => {
    for (const opts of [{ summary: 'writeHeld swallows errors, so a failed write is reported as filed.' }, { curLine: 400 }]) {
      const h = harness({ failure: 'omitted', readChangedLines: () => new Set() });
      const { current } = reviewerCarryHarness(h, 'not-real', opts);
      const out = await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX);
      expect(readReferralRecords(h.state.comments).records.find(r => r.runId === 'current').carried).toBeUndefined();
      expect(out.pending).toContain(current.referrals[0].key);
    }
  });

  // A reviewer carry stands only while its backing does. When the SOURCE ruling is later superseded the carry is
  // withdrawn and the gate holds the finding pending (no block anywhere, so nothing links it); the dispatcher must
  // then ask the reviewer afresh (once) — `liveReferrals` used to drop every carried key, leaving a hold with no
  // owner and no automatic way out.
  const withdrawnCarry = (h, extra = {}, harnessOptions = {}) => {
    const { old, current } = reviewerCarryHarness(h, 'not-real', harnessOptions);
    const key = current.referrals[0].key;
    const carried = [{ key, reason: REFERRAL_CARRY_REASON, result: 'not-real',
      from: { head: old.head, runId: old.runId, key: old.referrals[0].key, rulingId: 'earlier-run:0' } }];
    h.state.comments.push({ body: renderReferralRecord({ ...current, carried, ...extra }), author: { login: 'web-everything' } });
    const reRuled = { ...old, rulings: [...old.rulings, { ...old.rulings[0], id: 'earlier-run:1', supersedes: ['earlier-run:0'] }] };
    h.state.comments.push({ body: renderReferralRecord(reRuled), author: { login: 'web-everything' } });
    return { key };
  };
  const askedKeys = (h) => h.judge.mock.calls.flatMap(([req]) => JSON.parse(req.input.split('\nUntrusted reported findings:\n')[1]).map(f => f.key));
  const currentOf = (h) => readReferralRecords(h.state.comments).records.find(r => r.runId === 'current');

  it.each([[false, 'not yet attempted'], [true, 'already attempted']])('asks the reviewer about a carry whose backing was withdrawn (%s: %s)', async (attempted) => {
    const h = harness({ readChangedLines: () => new Set() });
    const { key } = withdrawnCarry(h, { attempted });
    // The hold, read with the PR's own author stamp (without it every ruling is uncounted and this proves nothing).
    expect(mandatoryReferralState(h.state.comments, { head: h.state.headRefOid, body: h.state.body, cardReadable: () => true }).pending).toContain(key);
    const out = await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX);
    expect(askedKeys(h)).toEqual([key]);                      // the reviewer is asked, exactly once
    expect(currentOf(h).rulings.map(r => r.key)).toEqual([key]);
    expect(currentOf(h).failure).toBeUndefined();             // an answered re-ask leaves nothing parked
    expect(out.pending).not.toContain(key);
  });

  it('a re-ask on a record that already holds rulings numbers its answer past them, so the record stays valid', async () => {
    const h = harness({ readChangedLines: () => new Set() });
    const other = { summary: 'unrelated defect', file: 'y.mjs', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
    const { key } = withdrawnCarry(h, { attempted: true }, { ruled: [other] });
    const out = await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX);
    expect(askedKeys(h)).toEqual([key]);
    expect(currentOf(h).rulings.map(r => r.id)).toEqual(['current:0', 'current:1']);
    expect(currentOf(h).failure).toBeUndefined();
    expect(out.pending).not.toContain(key);
  });

  it('asks about a withdrawn carry only once: an omitted ruling parks it, and a record parked on a failure is never re-asked', async () => {
    const h = harness({ failure: 'omitted', readChangedLines: () => new Set() });
    const { key } = withdrawnCarry(h, { attempted: true });
    await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX);
    expect(askedKeys(h)).toEqual([key]);
    expect(currentOf(h).failure).toMatch(/withdrawn carry/);
    const second = await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX);
    expect(askedKeys(h)).toEqual([key]);                      // still one ask
    expect(second.pending).toContain(key);                    // held for a person, as before
    const parked = harness({ readChangedLines: () => new Set() });
    withdrawnCarry(parked, { attempted: true, failure: 'budget exhausted' });
    await parked.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](parked.payload, CTX);
    expect(parked.judge).not.toHaveBeenCalled();
  });

  // A real top-level `a/` directory is a real path: the compare lookup must use the cited path as written, never
  // a diff-prefix-stripped alias that may name a different (root) file.
  it('looks a carried finding up by its exact cited path, and never carries across a diff-prefix alias', async () => {
    const asked = [];
    const h = harness({ failure: 'omitted', readChangedLines: (_repo, _base, _head, file) => { asked.push(file); return new Set(); } });
    h.payload.referrals[0].original.file = 'a/x.mjs';
    seedCarry(h, { curPatch: { file: 'a/x.mjs' } });
    await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX);
    expect(readReferralRecords(h.state.comments).records.find(r => r.runId === 'current').carried).toHaveLength(1);
    expect(asked).toEqual(['a/x.mjs']);
  });
  it('does not carry a ruling on root x.mjs onto a finding cited at the different file a/x.mjs', async () => {
    const asked = [];
    const h = harness({ failure: 'omitted', readChangedLines: (_repo, _base, _head, file) => { asked.push(file); return new Set(); } });
    const { current } = seedCarry(h, { curPatch: { file: 'a/x.mjs' } });
    const result = await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX);
    expect(readReferralRecords(h.state.comments).records.find(r => r.runId === 'current').carried).toBeUndefined();
    expect(result.pending).toContain(current.referrals[0].key);
  });

  it.each([['block'], ['not-real']])('never replaces a current-head reviewer %s ruling with an earlier-head operator ruling', async result => {
    const h = harness({ failure: 'omitted', readChangedLines: () => new Set() });
    const { current } = seedCarry(h, { attempted: true, rule: r => [{ id: 'r1', key: r.referrals[0].key, reviewerId: r.reviewer.id,
      lens: r.reviewer.lens, result, rationale: 'Checked diff', evidence: ['diff:x'] }] });
    const state = await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX);
    const latest = readReferralRecords(h.state.comments).records.find(r => r.runId === 'current');
    expect(latest.carried).toBeUndefined();
    const key = current.referrals[0].key;
    expect(mandatoryReferralState(h.state.comments, { head: h.state.headRefOid }).blocked).toEqual(result === 'block' ? [key] : []);
    expect(state.pending).not.toContain(key);
  });

  // The carry persists a `carried` entry that `liveReferrals` excludes from dispatch, while `referralRecordState` keeps
  // the finding pending for an unreadable card: carrying it would strand the finding with no reviewer and a held gate.
  it('does not suppress mandatory review when an earlier operator card is unreadable', async () => {
    const h = harness({ failure: 'card', readChangedLines: () => new Set() });
    const { current } = seedCarry(h, { operatorRuling: { result: 'card', card: 'we:backlog/7-filed.md' } });
    const state = await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX);
    const key = current.referrals[0].key;
    expect(readReferralRecords(h.state.comments).records.find(r => r.runId === 'current').carried).toBeUndefined();
    expect(h.judge.mock.calls.some(([req]) => JSON.parse(req.input.split('\nUntrusted reported findings:\n')[1])
      .some(f => f.key === key))).toBe(true);
    // The reviewer (harness default: not-real) adjudicated it, so the gate is not left holding an unattended finding.
    expect(state.pending).not.toContain(key);
  });

  // An operator ruling is scoped to the severity they saw: the same finding re-reported at a higher impact goes to the
  // mandatory reviewer instead of inheriting the earlier not-real.
  it('does not carry an operator ruling onto the same finding re-reported at a higher impact', async () => {
    const h = harness({ failure: 'omitted', readChangedLines: () => new Set() });
    const { old, current } = seedCarry(h, { curPatch: { impactIfUnfixed: 'unrecoverable' } });
    expect(current.referrals[0].original.impactIfUnfixed).not.toBe(old.referrals[0].original.impactIfUnfixed);
    await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX);
    expect(readReferralRecords(h.state.comments).records.find(r => r.runId === 'current').carried).toBeUndefined();
    expect(h.judge.mock.calls.some(([req]) => JSON.parse(req.input.split('\nUntrusted reported findings:\n')[1])
      .some(f => f.key === current.referrals[0].key))).toBe(true);
  });

  it('still carries an earlier operator card ruling when the card is readable', async () => {
    const h = harness({ failure: 'omitted', readChangedLines: () => new Set() });
    const { current } = seedCarry(h, { operatorRuling: { result: 'card', card: 'we:backlog/7-filed.md' } });
    const state = await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX);
    expect(readReferralRecords(h.state.comments).records.find(r => r.runId === 'current').carried).toHaveLength(1);
    expect(h.judge).not.toHaveBeenCalled();
    expect(state.pending).not.toContain(current.referrals[0].key);
  });

  it('still carries when the current-head reviewer ruling does not count (card naming an unreadable card)', async () => {
    const h = harness({ failure: 'card', readChangedLines: () => new Set() });
    const { current } = seedCarry(h, { attempted: true, rule: r => [{ id: 'r1', key: r.referrals[0].key, reviewerId: r.reviewer.id,
      lens: r.reviewer.lens, result: 'card', card: 'we:backlog/7-filed.md', rationale: 'Checked diff', evidence: ['diff:x'] }] });
    const state = await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX);
    expect(readReferralRecords(h.state.comments).records.find(r => r.runId === 'current').carried).toHaveLength(1);
    expect(state.pending).not.toContain(current.referrals[0].key);
  });

  function seedReferrals(h, seats, head = 'b'.repeat(40), rule = () => []) {
    const referrals = seats.map((seat, i) => {
      const original = { ...h.payload.referrals[0].original, summary: `pending finding ${i}` };
      return { seat, original, finding: normalizeFinding(original), key: referralFindingKey(seat, original) };
    });
    const record = { version: 1, repo: 'o/r', pr: 7, head, runId: 'earlier-run',
      reviewer: mandatoryReferralReviewer('earlier-run'), authorBody: h.state.body,
      attempted: true, referrals, rulings: [] };
    record.rulings = rule(record);
    h.state.comments.push({ body: renderReferralRecord(record), author: { login: 'web-everything' } });
    h.payload.referrals = [];
    return record;
  }

  it.each([undefined, '0'])('advisory duplicate respects mandatory not-real (switch %s)', async enabled => {
    const h = harness({ failure: 'judge', env: enabled ? { WE_REFERRAL_ADVISORY_SUPERSEDE: enabled } : {} });
    const old = seedReferrals(h, ['judge'], h.state.headRefOid, r => [{
      id: 'r1', key: r.referrals[0].key, reviewerId: r.reviewer.id, lens: r.reviewer.lens,
      result: 'not-real', rationale: 'Verified pinned diff', evidence: ['diff:x'],
    }]);
    h.payload.referrals = [{ seat: 'judgeCorrectnessAdvisory', original: old.referrals[0].original }];
    const result = await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX);
    const added = result.records.find(r => r.runId !== old.runId);
    if (enabled === '0') {
      expect(added.superseded).toBeUndefined();
      expect(h.judge).toHaveBeenCalledOnce();
      expect(result.pending).toHaveLength(1);
    } else {
      expect(added.superseded).toEqual([{ key: added.referrals[0].key,
        reason: 'superseded: the mandatory owner already ruled this finding not-real on this head',
        by: { runId: old.runId, key: old.referrals[0].key, rulingId: 'r1' } }]);
      expect(added.attempted).toBe(false);
      expect(h.judge).not.toHaveBeenCalled();
      expect(result.pending).toEqual([]);
      expect(h.trace).not.toContain('label:review:pending');
      expect(h.lines.some(line => line.startsWith('referral superseded: judgeCorrectnessAdvisory'))).toBe(true);
      const count = h.state.comments.length;
      await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX);
      expect(h.state.comments).toHaveLength(count);
    }
  });

  it('keeps superseded additions out of live chunks and judge input', async () => {
    const h = harness({});
    const old = seedReferrals(h, ['judge'], h.state.headRefOid, r => [{
      id: 'r1', key: r.referrals[0].key, reviewerId: r.reviewer.id, lens: r.reviewer.lens,
      result: 'not-real', rationale: 'Verified pinned diff', evidence: ['diff:x'],
    }]);
    h.payload.referrals = [
      { seat: 'judgeCorrectnessAdvisory', original: old.referrals[0].original },
      { seat: 'judge', original: { ...old.referrals[0].original, file: 'different.mjs' } },
    ];
    const result = await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX);
    const added = result.records.filter(r => r.runId !== old.runId);
    expect(added).toHaveLength(2);
    expect(added.find(r => r.superseded).attempted).toBe(false);
    expect(added.find(r => !r.superseded).attempted).toBe(true);
    expect(h.judge).toHaveBeenCalledOnce();
    const input = JSON.parse(h.judge.mock.calls[0][0].input.split('\nUntrusted reported findings:\n')[1]);
    expect(input.map(f => f.seat)).toEqual(['judge']);
  });

  it.each(['block', 'not-real'])('a disabled seat never retires a finding that already has a %s ruling', async result => {
    const h = harness({ failure: 'judge', env: { REVIEW_PR_ANTIGRAVITY_REVIEW: '0', WE_REVIEW_SEAT_CAP_AGY_GEMINI: '0' } });
    const old = seedReferrals(h, ['judgeAntigravityReview', 'judgeAntigravityReview'], 'b'.repeat(40), r => [{
      id: 'r1', key: r.referrals[0].key, reviewerId: r.reviewer.id, lens: r.reviewer.lens, result,
      rationale: 'Verified against the pinned diff', evidence: ['diff:x'] }]);
    const result_ = await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX);
    const historical = result_.records.find(r => r.runId === old.runId);
    // Only the unruled finding is retired; the ruled one keeps counting, so a `block` still holds the PR.
    expect(historical.dropped).toEqual([{ key: old.referrals[1].key, reason: 'dropped: seat disabled by operator config' }]);
    expect(mandatoryReferralState(h.state.comments, { head: 'b'.repeat(40) }).blocked).toEqual(result === 'block' ? [old.referrals[0].key] : []);
  });

  it('flag on with the Gemini cap left unset keeps the seat\'s referrals pending', async () => {
    const h = harness({ failure: 'judge', env: { REVIEW_PR_ANTIGRAVITY_REVIEW: '1' } });
    seedReferrals(h, Array(2).fill('judgeAntigravityReview'));
    const result = await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX);
    expect(result.pending).toHaveLength(2);
    expect(result.records.every(r => !r.dropped)).toBe(true);
  });

  it.each([
    ['agy-gemini', { WE_REVIEW_SEAT_CAP_AGY_GEMINI: '0', WE_REVIEW_SEAT_CAP_AGY_CLAUDE: '40' }, 'agy-claude'],
    ['agy-claude', { WE_REVIEW_SEAT_CAP_AGY_GEMINI: '40', WE_REVIEW_SEAT_CAP_AGY_CLAUDE: '0' }, 'agy-gemini'],
  ])('disabling only %s drops only its referrals and keeps %s pending', async (disabled, env, enabled) => {
    const h = harness({ failure: 'judge', env });
    const old = seedReferrals(h, [disabled, enabled]);
    const result = await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX);
    expect(result.pending).toEqual([old.referrals[1].key]);
    expect(result.records.find(r => r.runId === old.runId).dropped).toEqual([
      { key: old.referrals[0].key, reason: 'dropped: seat disabled by operator config' }]);
  });

  it.each([
    [{ REVIEW_PR_ANTIGRAVITY_REVIEW: '0', WE_REVIEW_SEAT_CAP_AGY_GEMINI: '40' }, 1],
    [{ REVIEW_PR_ANTIGRAVITY_REVIEW: '1', WE_REVIEW_SEAT_CAP_AGY_GEMINI: '0' }, 1],
    [{ REVIEW_PR_ANTIGRAVITY_REVIEW: '0', WE_REVIEW_SEAT_CAP_AGY_GEMINI: '0' }, 1],
    [{ REVIEW_PR_ANTIGRAVITY_REVIEW: '1', WE_REVIEW_SEAT_CAP_AGY_GEMINI: '40' }, 5],
  ])('replays #3481: config %j leaves %i pending', async (env, count) => {
    const h = harness({ failure: 'judge', env });
    const old = seedReferrals(h, ['judge', ...Array(4).fill('judgeAntigravityReview')]);
    const result = await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX);
    expect(result.malformed).toBe(false);
    expect(result.pending).toHaveLength(count);
    expect(result.pending).toContain(old.referrals[0].key);
    expect(result.records.filter(r => r.head === h.state.headRefOid).flatMap(activeReferrals)).toHaveLength(count);
    const historical = result.records.find(r => r.runId === old.runId);
    expect(historical.referrals).toEqual(old.referrals);
    expect(historical.dropped ?? []).toEqual(count === 5 ? [] : old.referrals.slice(1).map(f => ({
      key: f.key, reason: 'dropped: seat disabled by operator config',
    })));
    // Fresh durable reads and replay agree, without an injected filter at the acceptance boundary.
    expect(mandatoryReferralState(h.state.comments, { head: h.state.headRefOid }).pending).toHaveLength(count);
    const posts = h.state.comments.length;
    expect((await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX)).pending).toHaveLength(count);
    expect(h.state.comments).toHaveLength(posts);
  });

  it.each(['judge', 'judgeSecurity', 'judgeCorrectnessAdvisory', 'unknown-seat'])('%s still fails closed with all Antigravity switches off', async seat => {
    const h = harness({ failure: 'judge', env: { REVIEW_PR_ANTIGRAVITY_REVIEW: '0',
      WE_REVIEW_SEAT_CAP_AGY_GEMINI: '0', WE_REVIEW_SEAT_CAP_AGY_CLAUDE: '0' } });
    const old = seedReferrals(h, [seat]);
    const result = await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX);
    expect(result.pending).toEqual([old.referrals[0].key]);
    expect(result.records.every(r => !r.dropped)).toBe(true);
    expect(() => assertMandatoryReferralsCleared(h.state, { repo: 'o/r', pr: 7 })).toThrow(/mandatory referral hold/);
  });

  it.each(['agy-gemini', 'agy-claude'])('uses the %s cap and allows acceptance after audited drops', async seat => {
    const env = { WE_REVIEW_SEAT_CAP_AGY_GEMINI: '0', WE_REVIEW_SEAT_CAP_AGY_CLAUDE: '0' };
    const h = harness({ env });
    seedReferrals(h, [seat], h.state.headRefOid);
    const result = await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX);
    expect(result.pending).toEqual([]);
    expect(h.judge).not.toHaveBeenCalled();
    expect(h.state.comments.at(-1).body).toContain('dropped: seat disabled by operator config');
    expect(() => assertMandatoryReferralsCleared(h.state, { repo: 'o/r', pr: 7 })).not.toThrow();
  });

  it('re-enabling the seat keeps old drops and holds new findings, including a repeated finding', async () => {
    const env = { REVIEW_PR_ANTIGRAVITY_REVIEW: '0', WE_REVIEW_SEAT_CAP_AGY_GEMINI: '0' };
    const h = harness({ env, failure: 'judge' });
    const old = seedReferrals(h, ['judgeAntigravityReview']);
    expect((await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX)).pending).toEqual([]);
    env.REVIEW_PR_ANTIGRAVITY_REVIEW = '1';
    env.WE_REVIEW_SEAT_CAP_AGY_GEMINI = '40';
    expect((await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX)).pending).toEqual([]);
    h.payload.referrals = old.referrals;
    const result = await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX);
    expect(result.pending).toEqual([old.referrals[0].key]);
    expect(result.records.find(r => r.runId === old.runId).dropped).toHaveLength(1);
    expect(h.judge).toHaveBeenCalledTimes(1);
  });

  it('a drop that cannot be persisted retains the hold', async () => {
    const h = harness({ failure: 'post', env: { REVIEW_PR_ANTIGRAVITY_REVIEW: '0' } });
    seedReferrals(h, ['judgeAntigravityReview']);
    const result = await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX);
    expect(result.pending).toEqual(['referral-persistence-failed']);
    // The operation runner persists this failure evidence; old-head referrals alone are no longer a hold.
    expect(() => assertMandatoryReferralsCleared(h.state, { repo: 'o/r', pr: 7,
      readRuns: () => [{ repo: 'o/r', pr: 7, head: h.state.headRefOid, completedAt: 1,
        persistenceFailed: result.pending.includes('referral-persistence-failed') }],
    })).toThrow(/referral-persistence-failed/);
  });
  it.each(['pending', 'human-and-changes'])('parks with live %s labels without consuming a send-back', async initial => {
    const h = harness({ failure: 'judge' });
    if (initial === 'human-and-changes') h.state.labels = ['review:human', 'review:changes'];
    const result = await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX);
    expect(result.pending).toHaveLength(1);
    expect(h.state.labels).toEqual(initial === 'pending' ? ['review:human'] : ['review:human', 'review:changes']);
    expect(h.lines.filter(line => line.includes('review:changes preserved'))).toHaveLength(initial === 'pending' ? 0 : 1);
  });

  it('replays #3507: a send-back during the in-flight review survives its pending-referral park', async () => {
    const h = harness();
    h.state.labels = ['review:human']; // 02:02:37Z: the run starts before the send-back.
    h.payload.read.labels = [...h.state.labels];
    let finishJudge;
    h.judge.mockImplementationOnce(() => new Promise(resolve => { finishJudge = resolve; }));
    const running = h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX);
    expect(h.judge).toHaveBeenCalledTimes(1);
    // 02:02:39Z: --to=changes lands while the referral judge is still running.
    h.provider.setLabels('o/r', 7, { add: 'review:changes', remove: [] });
    h.state.comments.push({ body: '🔁 review — changes requested' });
    finishJudge({ timedOut: true }); // 02:08:37Z: pending referrals park the run.
    const result = await running;
    expect(result.pending).toHaveLength(1);
    expect(h.state.labels).toEqual(['review:human', 'review:changes']);
    expect(h.trace.slice(h.trace.indexOf('label:review:changes') + 1)).toContain('read');
    expect(h.lines.filter(line => line.includes('review:changes preserved'))).toHaveLength(1);
  });

  it('a head that moves mid-run leaves labels and comments untouched and is retried against the new head', async () => {
    const h = harness({ failure: 'changed-head' });
    await expect(h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX)).rejects.toThrow(/reviewed head changed/);
    expect(h.judge).not.toHaveBeenCalled();
    // The hold the earlier pass left stays exactly as it was: not parked to review:human, no park comment.
    expect(h.state.labels).toEqual(['review:pending']);
    expect(h.state.comments.some(c => c.body.includes('parked to review:human'))).toBe(false);
  });
  it('resuming after a partial chunk post keeps every chunk runId unique and reads back non-malformed', async () => {
    const h = harness();
    const seat = h.payload.referrals[0].seat;
    h.payload.referrals = Array.from({ length: 40 }, (_, i) => ({ seat,
      original: { ...h.payload.referrals[0].original, summary: `finding ${i}`, detail: 'evidence '.repeat(500) } }));
    const record = (b) => b.includes('<!-- mandatory-referrals-v1:');
    const post = h.provider.postComment;
    let recordPosts = 0;
    h.provider.postComment = (repo, pr, body) => {
      if (record(body) && ++recordPosts === 2) throw new Error('post unavailable'); // chunk 1 lands, chunk 2 fails
      post(repo, pr, body);
    };
    const first = await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX);
    expect(first.pending).toEqual(['referral-persistence-failed']);
    expect(readReferralRecords(h.state.comments).records).toHaveLength(1);
    h.provider.postComment = post;
    h.state.labels = ['review:pending'];
    // Same ctx.runId: chunk 1's runId is already taken by the record that landed.
    const second = await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX);
    expect(second.pending).toEqual([]);
    const parsed = readReferralRecords(h.state.comments, { head: h.state.headRefOid });
    expect(parsed.malformed).toBe(false);
    const current = parsed.records.filter(r => r.head === h.state.headRefOid);
    expect(current.length).toBeGreaterThan(1);
    expect(new Set(current.map(r => r.runId)).size).toBe(current.length);
    const keys = current.flatMap(r => r.referrals.map(f => f.key));
    expect(new Set(keys).size).toBe(40);
    expect(keys).toHaveLength(40);
  });
  it.each(['post', 'read-back'])('%s cannot clear a hold or dispatch before persistence', async failure => {
    const h = harness({ failure });
    const result = await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX);
    expect(result.pending).toEqual(['referral-persistence-failed']);
    expect(h.judge).not.toHaveBeenCalled();
    expect(h.state.labels).toEqual(['review:human']);
    expect(h.state.comments.at(-1).body).toContain(`parked to review:human: ${result.reason}`);
  });
  it.each(['attempt', 'completion', 'failure-snapshot'])('%s persistence failure parks with its reason', async failure => {
    const h = harness({ failure });
    const result = await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX);
    expect(result.pending).toEqual(['referral-persistence-failed']);
    expect(h.judge).toHaveBeenCalledTimes(failure === 'attempt' ? 0 : 1);
    expect(h.state.labels).toEqual(['review:human']);
    expect(h.state.comments.at(-1).body).toContain('parked to review:human: post unavailable');
  });
  it('a persistence failure finishes the operation at human confirmation and classifies as parked', async () => {
    const h = harness({ failure: 'post' });
    const registry = createRegistry();
    registry.register(reviewPrOperation({ codexAdvisory: false, correctnessAdvisory: false, antigravityReview: false,
      readPr: () => ({ state: 'OPEN', body: h.state.body,
        detail: { repo: 'o/r', pr: 7, title: 'referral persistence', labels: ['review:pending'], humanRequired: false,
          reviewClass: 'pending', disposition: { mode: 'converge', autoLand: false }, diffStat: [] },
        net: { paths: ['x.mjs'], base: 'b'.repeat(40), rev: h.state.headRefOid, scored: true },
        diff: { text: '--- a/x.mjs\n+++ b/x.mjs\n+change\n', scored: true },
      }),
    }));
    let run = advanceWhileRunning(startRun({ op: REVIEW_PR_OP, id: CTX.runId, input: { repo: 'o/r', pr: 7 }, registry }), { registry });
    while (run.pending?.kind === 'judge') {
      run = advanceWhileRunning(run, { registry, resume: { value: { summary: 'reported finding',
        findings: run.pending.step === 'judge' ? [h.payload.referrals[0].original] : [] } } });
    }
    expect(run.pending?.kind).toBe('effect');
    ({ run } = await applyPendingEffects(run, { sinks: h.make(), store: createMemoryRunStore() }));
    run = advanceWhileRunning(run, { registry });
    expect(run.pending).toMatchObject({ kind: 'confirm', of: 'human' });
    expect(run.verdict.verdict).toBe('needs-human');
    expect(classifyReviewLoopOutcome({ stopped: run.pending.kind, verdict: run.verdict }).outcome).toBe('parked');
    expect(h.state.labels).toEqual(['review:human']);
  });
  it('replays #3481: 42 earlier heads, duplicates, and a carried set over the comment budget', async () => {
    const h = harness();
    const seat = h.payload.referrals[0].seat;
    const referrals = Array.from({ length: 42 }, (_, i) => {
      const original = { ...h.payload.referrals[0].original, summary: `earlier finding ${i}`, detail: 'evidence '.repeat(500) };
      return { seat, key: referralFindingKey(seat, original), original, finding: normalizeFinding(original) };
    });
    const oldRecord = (i, findings) => ({ version: 1, repo: 'o/r', pr: 7,
      head: (i + 1).toString(16).padStart(40, '0'), runId: `earlier-${i}`, reviewer: mandatoryReferralReviewer(`earlier-${i}`),
      authorBody: h.state.body, attempted: true, referrals: findings, rulings: [] });
    h.state.comments = referrals.map((f, i) => ({ body: renderReferralRecord(oldRecord(i, i ? [referrals[0], f] : [f])),
      author: { login: 'web-everything' } }));
    expect(renderReferralRecord(oldRecord(0, referrals)).length).toBeGreaterThan(60_000);
    const result = await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX);
    const posted = h.state.comments.slice(42);
    expect(posted.length).toBeGreaterThan(3);
    for (const { body } of posted) expect(body.length).toBeLessThanOrEqual(60_000);
    const parsed = readReferralRecords(h.state.comments);
    expect(parsed.malformed).toBe(false);
    const current = parsed.records.filter(r => r.head === h.state.headRefOid);
    expect(current.length).toBeGreaterThan(1);
    expect(new Set(current.map(r => r.runId)).size).toBe(current.length);
    expect(current.every(validateReferralRecord)).toBe(true);
    const keys = current.flatMap(r => r.referrals.map(f => f.key));
    const expected = [...referrals.map(f => f.key), referralFindingKey(seat, h.payload.referrals[0].original)];
    expect(keys.sort()).toEqual(expected.sort());
    expect(result.pending).toEqual([]);
    expect(h.judge).toHaveBeenCalledTimes(current.length);
    await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, { ...CTX, runId: 'resume' });
    expect(h.judge).toHaveBeenCalledTimes(current.length);
  });
  it.each(['1', '0'])('replays the 14:08Z run shape with optional seat=%s: all 55 keys read back', async enabled => {
    const h = harness({ env: { REVIEW_PR_ANTIGRAVITY_REVIEW: enabled } });
    const fixture = JSON.parse(readFileSync('scripts/operations/__tests__/fixtures/referral-3481-shape.json', 'utf8'));
    h.payload = { read: fixture.read, referrals: fixture.referrals };
    h.state.headRefOid = fixture.read.netBasis.rev;
    const referrals = fixture.carried.map(({ seat, fields }, i) => {
      const original = Object.fromEntries(Object.entries(fields).map(([field, value]) => [field,
        typeof value === 'object' && value?.length ? `${i}:`.padEnd(value.length, 'x') : value]));
      return { seat, original, key: referralFindingKey(seat, original), finding: normalizeFinding(original) };
    });
    const old = { version: 1, repo: 'o/r', pr: 7, head: 'b'.repeat(40), runId: 'historical',
      reviewer: mandatoryReferralReviewer('historical'), authorBody: h.state.body,
      attempted: true, referrals: fixture.historical.indexes.map(i => referrals[i]), rulings: [] };
    expect(renderReferralRecord(old).length).toBeGreaterThan(60_000);
    h.state.comments = [{ url: 'https://github.com/o/r/pull/7#issuecomment-123', body: renderReferralRecord(old), author: { login: 'web-everything' } },
      ...referrals.filter((_, i) => !fixture.historical.indexes.includes(i)).map((f, i) => ({
        body: renderReferralRecord({ ...old, runId: `other-${i}`, reviewer: mandatoryReferralReviewer(`other-${i}`), referrals: [f] }),
        author: { login: 'web-everything' },
      }))];
    const priorCount = h.state.comments.length;
    const result = await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX);
    expect(result.pending).toEqual(enabled === '1' ? [] : ['referral-overflow']);
    if (enabled === '0') expect(result.reason).toContain('historical run historical retirement');
    expect(h.state.comments.slice(priorCount).every(c => c.body.length < 60_000)).toBe(true);
    const parsed = readReferralRecords(h.state.comments);
    expect(parsed.malformed).toBe(false);
    const current = parsed.records.filter(r => r.head === h.state.headRefOid);
    expect(current.length).toBeGreaterThan(1);
    expect(current.every(validateReferralRecord)).toBe(true);
    expect(current.flatMap(r => r.referrals.map(f => f.key)).sort()).toEqual(referrals.map(f => f.key).sort());
  });
  it('bounds an oversized entry with a hash and original-comment pointer, retaining ruling identity', async () => {
    const h = harness();
    h.payload.referrals[0].original.quote = '🧪 long source '.repeat(20_000);
    h.payload.referrals[0].original.detail = { text: 'nested evidence '.repeat(20_000) };
    const original = h.payload.referrals[0].original;
    const key = referralFindingKey(h.payload.referrals[0].seat, original);
    const old = { version: 1, repo: 'o/r', pr: 7, head: 'b'.repeat(40), runId: 'oversized',
      reviewer: mandatoryReferralReviewer('oversized'), authorBody: h.state.body, attempted: true,
      referrals: [{ key, seat: h.payload.referrals[0].seat, original, finding: normalizeFinding(original) }], rulings: [] };
    const url = 'https://github.com/o/r/pull/7#issuecomment-456';
    // Identical identity can have different evidence across records: link the actual source bytes.
    const earlier = structuredClone(old);
    earlier.runId = 'earlier-evidence';
    earlier.reviewer = mandatoryReferralReviewer(earlier.runId);
    earlier.referrals[0].original.quote = 'different evidence '.repeat(20_000);
    earlier.referrals[0].finding = normalizeFinding(earlier.referrals[0].original);
    h.state.comments = [{ url: 'https://github.com/o/r/pull/7#issuecomment-123', body: renderReferralRecord(earlier), author: { login: 'web-everything' } },
      { url, body: renderReferralRecord(old), author: { login: 'web-everything' } }];
    h.payload.referrals = [];
    const result = await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX);
    expect(result.pending).toEqual([]);
    const record = result.records.find(r => r.head === h.state.headRefOid);
    expect(record.referrals[0].key).toBe(key);
    expect(record.rulings[0].key).toBe(key);
    expect(record.referrals[0].original.quote).toContain(`source:${url}`);
    expect(record.referrals[0].original.quote).toMatch(/sha256:[a-f0-9]{64}/);
    expect(record.referrals[0].original.detail.length).toBeLessThan(1024);
    expect(readReferralRecords(h.state.comments).malformed).toBe(false);
    expect(h.state.comments.slice(2).every(c => c.body.length < 60_000)).toBe(true);
  });
  it('does not repeat a large author body across chunks and retains author independence', async () => {
    const h = harness();
    h.state.body += ' large PR description'.repeat(20_000);
    h.payload.referrals = Array.from({ length: 30 }, (_, i) => ({ ...h.payload.referrals[0],
      original: { ...h.payload.referrals[0].original, summary: `finding ${i}`, quote: 'evidence '.repeat(100) } }));
    const result = await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX);
    expect(result.pending).toEqual([]);
    expect(result.records.length).toBeGreaterThan(1);
    for (const r of result.records) {
      expect(r.authorBody.length).toBeLessThan(1024);
      expect(r.authorBody).toContain('<!-- authored-by-actor: author -->');
      expect(r.authorBody).toContain('sha256:');
    }
    expect(h.state.comments.every(c => c.body.length < 60_000)).toBe(true);
  });
  it('persists fitting findings beside an unrepresentable key and visibly holds the overflow', async () => {
    const h = harness();
    h.payload.referrals.unshift({ ...h.payload.referrals[0], original: {
      ...h.payload.referrals[0].original, summary: 'oversized key '.repeat(20_000) } });
    const result = await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX);
    expect(result.pending).toContain('referral-overflow');
    expect(result.records.flatMap(r => r.referrals)).toHaveLength(1);
    expect(result.reason).toContain('key sha256:');
    expect(h.state.comments.at(-1).body).toContain('referral-overflow');
    expect(h.state.labels).toContain('review:human');
  });
  it('retains an oversized immutable historical snapshot while persisting new chunks', async () => {
    const h = harness({ env: { REVIEW_PR_ANTIGRAVITY_REVIEW: '0' } });
    const old = seedReferrals(h, ['judgeAntigravityReview']);
    old.authorBody += 'historical body '.repeat(10_000);
    h.state.comments = [{ body: renderReferralRecord(old), author: { login: 'web-everything' } }];
    const result = await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX);
    expect(result.reason).toContain('historical run earlier-run retirement');
    expect(result.pending).toContain('referral-overflow');
    expect(result.records.some(r => r.head === h.state.headRefOid)).toBe(true);
    expect(h.state.comments.slice(1).every(c => c.body.length < 60_000)).toBe(true);
    expect(readReferralRecords(h.state.comments).malformed).toBe(false);
  });
  it('parks an indivisible oversized finding without posting it or dispatching', async () => {
    const h = harness();
    h.payload.referrals[0].original.summary = 'large '.repeat(20_000);
    const result = await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX);
    expect(result.reason).toContain('exceeds 60000 characters with its v1 identity intact');
    expect(h.state.labels).toEqual(['review:human']);
    expect(h.state.comments).toHaveLength(1);
    expect(h.state.comments[0].body.length).toBeLessThan(60_000);
    expect(h.judge).not.toHaveBeenCalled();
  });
  it('also bounds completed records whose rulings exceed the budget', async () => {
    const h = harness();
    h.judge.mockImplementation(async request => ({ sessionId: request.sessionId, value: { rulings: [{
      key: referralFindingKey(h.payload.referrals[0].seat, h.payload.referrals[0].original), result: 'not-real',
      rationale: 'long evidence '.repeat(10_000), evidence: ['diff:x'], card: '',
    }] } }));
    const result = await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX);
    expect(result.reason).toContain('exceeds 60000 characters');
    expect(result.pending).toContain('referral-overflow');
    expect(h.state.labels).toEqual(['review:human']);
    expect(h.state.comments.every(c => c.body.length <= 60_000)).toBe(true);
    expect(readReferralRecords(h.state.comments).records[0]).toMatchObject({ attempted: true, rulings: [] });
  });
  it('persists a fitting ruling when a sibling ruling overflows', async () => {
    const h = harness();
    h.payload.referrals.push({ ...h.payload.referrals[0], original: { ...h.payload.referrals[0].original, summary: 'second' } });
    const judge = h.judge.getMockImplementation();
    h.judge.mockImplementation(async request => {
      const answer = await judge(request);
      answer.value.rulings[0].rationale = 'verbose '.repeat(20_000);
      return answer;
    });
    const result = await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX);
    expect(result.pending).toContain('referral-overflow');
    expect(result.records[0].rulings).toHaveLength(1);
    expect(result.records[0].rulings[0].key).toBe(referralFindingKey(h.payload.referrals[1].seat, h.payload.referrals[1].original));
    expect(result.records[0].failure).toContain('withheld, key remains pending');
    expect(readReferralRecords(h.state.comments).malformed).toBe(false);
    expect(h.state.comments.every(c => c.body.length < 60_000)).toBe(true);
  });
  it('still parks if posting the short explanation also fails', async () => {
    const h = harness();
    h.provider.postComment = () => { throw new Error('all comments unavailable'); };
    const result = await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX);
    expect(result.pending).toEqual(['referral-persistence-failed']);
    expect(result.reason).toBe('all comments unavailable');
    expect(h.state.labels).toEqual(['review:human']);
  });
  it('parks using observed labels when persistence read-back and the refresh both fail', async () => {
    const h = harness();
    const read = h.provider.readPrState;
    h.provider.readPrState = () => {
      if (h.state.comments.length) throw new Error('read unavailable');
      return read();
    };
    const result = await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX);
    expect(result.reason).toBe('read unavailable');
    expect(h.state.labels).toEqual(['review:human']);
    expect(h.state.comments.at(-1).body).toContain('read unavailable');
    expect(h.judge).not.toHaveBeenCalled();
  });
  it('ignores stale malformed records through persistence and retains the current-head clear-human guard', async () => {
    const h = harness();
    h.state.comments.push({ body: `<!-- mandatory-referrals-v1: ${encodeURIComponent(JSON.stringify({ head: 'b'.repeat(40) }))} -->`, author: { login: 'web-everything' } });
    const result = await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX);
    expect(result.pending).toEqual([]);
    expect(() => assertMandatoryReferralsCleared(h.state, { repo: 'o/r', pr: 7 })).not.toThrow();
    h.state.comments.push({ body: '<!-- mandatory-referrals-v1: %truncated', author: { login: 'web-everything' } });
    expect(() => assertMandatoryReferralsCleared(h.state, { repo: 'o/r', pr: 7 })).toThrow(/mandatory referral hold/);
    const pending = harness({ failure: 'judge' });
    await pending.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](pending.payload, CTX);
    expect(() => assertMandatoryReferralsCleared(pending.state, { repo: 'o/r', pr: 7 })).toThrow(/mandatory referral hold/);
  });
  it.each(['judge', 'timeout', 'omitted', 'identity', 'card'])('%s is bounded and human-owned across fresh sink instances', async failure => {
    const h = harness({ failure, result: failure === 'card' ? 'card' : 'not-real' });
    for (let i = 0; i < 3; i++) {
      const result = await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, { ...CTX, runId: `run-${i}` });
      expect(result.pending).toHaveLength(1);
    }
    expect(h.judge).toHaveBeenCalledTimes(1);
    expect(h.state.labels).toEqual(['review:human']);
    expect(h.trace.indexOf('post')).toBeLessThan(h.trace.indexOf('judge'));
    expect(h.trace.slice(0, h.trace.indexOf('judge'))).toContain('read');
  });
  it('requires an unattempted new record to obtain its own ruling', async () => {
    const h = harness();
    await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX);
    const old = readReferralRecords(h.state.comments).records[0];
    const next = { ...old, runId: 'new-record', reviewer: mandatoryReferralReviewer('new-record'), attempted: false, rulings: [] };
    h.state.comments.push({ body: renderReferralRecord(next), author: { login: 'web-everything' } });
    const result = await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, { ...CTX, runId: 'next' });
    expect(result.pending).toEqual([]);
    expect(h.judge).toHaveBeenCalledTimes(2);
    expect(h.state.comments).toHaveLength(6);
  });
  it('keeps referrals tool-free without a checkout', async () => {
    const h = harness();
    const result = await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX);
    expect(result.pending).toEqual([]);
    const request = h.judge.mock.calls[0][0];
    expect(request.allowedTools).toBeNull();
    expect(request).not.toHaveProperty('cwd');
    expect(request.mandate).not.toContain('using tools');
  });
  it('posts and reads back rulings before returning clearance, then reuses them', async () => {
    const h = harness();
    const result = await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX);
    expect(result.pending).toEqual([]);
    expect(result.blocked).toEqual([]);
    expect(h.trace.filter(x => x === 'post')).toHaveLength(3);
    expect(h.trace.lastIndexOf('read')).toBeGreaterThan(h.trace.lastIndexOf('post'));
    expect(h.trace.at(-1)).toBe('mirror:true');
    await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, { ...CTX, runId: 'another-checkout' });
    expect(h.judge).toHaveBeenCalledTimes(1);
  });

  describe('#76b finding identity referral rulings', () => {
    const seat = 'judgeCorrectnessAdvisory';
    const reportedSection = '\nUntrusted reported findings:\n';
    const knownSection = '\nUntrusted known findings on this PR (identity table; for sameAs only):\n';
    const findingA = { summary: 'Concurrent writers overwrite reservations', file: 'x.mjs', line: 136,
      category: 'correctness', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
    const findingB = { ...findingA, summary: 'Parallel submissions lose ownership', line: 133 };
    const recordsOf = h => readReferralRecords(h.state.comments).records;

    function seedFinding(h, original, runId, result, sameAs) {
      h.payload.referrals = [{ seat, original }];
      return seedReferrals(h, [seat], h.state.headRefOid, record => {
        record.runId = runId;
        record.reviewer = mandatoryReferralReviewer(runId);
        record.referrals = [{ seat, original, finding: normalizeFinding(original), key: referralFindingKey(seat, original) }];
        return [{ id: `${runId}:0`, key: record.referrals[0].key, reviewerId: record.reviewer.id,
          lens: record.reviewer.lens, result, rationale: 'Checked diff', evidence: ['diff:x'],
          ...(sameAs ? { sameAs } : {}) }];
      });
    }

    function answerWith(h, sameAs) {
      h.judge.mockImplementation(async request => ({ sessionId: request.sessionId, value: {
        rulings: JSON.parse(request.input.split(reportedSection)[1]).map(f => ({
          key: f.key, result: 'not-real', rationale: 'Checked diff', evidence: ['diff:x'], card: '', sameAs: sameAs(f),
        })),
      } }));
    }

    it('one referral ruling per finding per head: a re-worded finding linked by sameAs to a block is not asked again', async () => {
      const { findingIdentityTable } = await import('../../lib/jury-core.mjs');
      const h = harness();
      const head = h.state.headRefOid;
      const first = seedFinding(h, findingA, 'first', 'block');
      const aId = findingIdentityTable(recordsOf(h))[0].findingId;
      const second = seedFinding(h, findingB, 'second', 'not-real', aId);
      const aKey = first.referrals[0].key, bKey = second.referrals[0].key;
      const state = mandatoryReferralState(h.state.comments, { head });
      expect(state.blocked).toEqual(expect.arrayContaining([aKey, bKey]));
      expect(state.pending).toEqual([]);

      const unlinked = structuredClone(second);
      delete unlinked.rulings[0].sameAs;
      const withoutLink = [first, unlinked].map(record => ({ body: renderReferralRecord(record), author: { login: 'web-everything' } }));
      const control = mandatoryReferralState(withoutLink, { head });
      expect(control.blocked).toEqual([aKey]);
      expect(control.blocked).not.toContain(bKey);
      expect(control.pending).toEqual([]);

      const findingC = { ...findingB, line: 134 };
      const cKey = referralFindingKey(seat, findingC);
      expect(cKey).not.toBe(bKey);
      h.payload.referrals = [{ seat, original: findingC }];
      const result = await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX);
      const askedKeys = h.judge.mock.calls.flatMap(([request]) => JSON.parse(request.input.split(reportedSection)[1]).map(f => f.key));
      expect(askedKeys).not.toContain(cKey);
      expect(result.blocked).toContain(cKey);
    });

    it('one referral ruling per finding per head: the judge sees the identity table and a valid sameAs is recorded on the ruling', async () => {
      const { findingIdentityTable } = await import('../../lib/jury-core.mjs');
      const h = harness();
      const first = seedFinding(h, findingA, 'first', 'block');
      const aId = findingIdentityTable(recordsOf(h))[0].findingId;
      h.payload.referrals = [{ seat, original: findingB }];
      answerWith(h, () => aId);
      await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX);
      expect(h.judge).toHaveBeenCalledOnce();
      const request = h.judge.mock.calls[0][0];
      expect(request.input).toContain(knownSection);
      expect(request.input.indexOf(knownSection)).toBeLessThan(request.input.indexOf(reportedSection));
      const rows = JSON.parse(request.input.split(knownSection)[1].split(reportedSection)[0]);
      expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ findingId: aId })]));
      const bKey = referralFindingKey(seat, findingB);
      const reported = JSON.parse(request.input.split(reportedSection)[1]);
      expect(reported).toEqual([expect.objectContaining({ key: bKey, findingId: expect.stringMatching(/^f-[0-9a-f]{12}$/) })]);
      expect(reported[0].findingId).not.toBe(aId);
      expect(request.shape.properties.rulings.items.required).toContain('sameAs');
      expect(request.shape.properties.rulings.items.properties.sameAs).toEqual({ type: 'string' });
      const records = recordsOf(h);
      expect(records.flatMap(r => r.rulings).find(r => r.key === bKey).sameAs).toBe(aId);
      const table = findingIdentityTable(records);
      expect(table).toHaveLength(1);
      expect(table[0].keys.map(k => k.key)).toEqual(expect.arrayContaining([first.referrals[0].key, bKey]));
    });

    it.each(['new', 'self', 'unknown', 'different file', 'far line'])(
      'one referral ruling per finding per head: a refused sameAs is never recorded (%s)', async mode => {
        const { findingIdentityTable } = await import('../../lib/jury-core.mjs');
        const h = harness();
        const original = { ...findingA, ...(mode === 'different file' ? { file: 'y.mjs' } : {}),
          ...(mode === 'far line' ? { line: 40 } : {}) };
        seedFinding(h, original, 'first', 'block');
        const aId = findingIdentityTable(recordsOf(h))[0].findingId;
        h.payload.referrals = [{ seat, original: findingB }];
        answerWith(h, f => mode === 'new' ? 'new' : mode === 'self' ? f.findingId : mode === 'unknown' ? 'f-000000000000' : aId);
        await h.make()[REVIEW_EFFECTS.MANDATORY_REFERRALS](h.payload, CTX);
        expect(h.judge).toHaveBeenCalledOnce();
        const reported = JSON.parse(h.judge.mock.calls[0][0].input.split(reportedSection)[1]);
        expect(reported[0].findingId).toMatch(/^f-[0-9a-f]{12}$/);
        const bKey = referralFindingKey(seat, findingB);
        const records = recordsOf(h);
        const ruling = records.flatMap(r => r.rulings).find(r => r.key === bKey);
        expect(ruling).toBeDefined();
        expect(ruling).not.toHaveProperty('sameAs');
        expect(findingIdentityTable(records)).toHaveLength(2);
      });
  });

});

describe('legacy vs current owner slugs compare equal (outage 2026-10-03)', () => {
  it('resolveSubjectCheckout accepts a chalbert/ origin for the web-everything/ slug and the reverse', () => {
    const a = resolveSubjectCheckout({ repo: 'web-everything/web-everything', cwd: '/x', originRepo: () => 'chalbert/web-everything', siblings: () => [] });
    expect(a.path).toBe('/x');
    const b = resolveSubjectCheckout({ repo: 'chalbert/web-everything', cwd: '/x', originRepo: () => 'web-everything/web-everything', siblings: () => [] });
    expect(b.path).toBe('/x');
  });
});


describe('#5135 latest fix range', () => {
  const comment = head => ({ author: { login: 'web-everything' }, body: `Net basis: \`0000..${head}\`` });
  const priorHead = 'a'.repeat(40);
  const head = 'b'.repeat(40);
  const read = (exec, comments = [comment(priorHead)], current = head) => readLatestFixRange({ exec, comments, head: current });
  it('does not diff without a trusted prior head', () => {
    const exec = () => { throw new Error('must not run'); };
    expect(read(exec, [])).toEqual({ priorHead: null });
    expect(read(exec, [{ ...comment(priorHead), author: { login: 'outsider' } }])).toEqual({ priorHead: null });
    expect(read(exec, [comment(head.slice(0, 8))])).toEqual({ priorHead: null });
    expect(read(exec, null, null)).toEqual({ priorHead: null });
  });
  it('selects the newest distinct reviewed head and uses the diff exec contract', () => {
    const calls = [];
    const exec = (...args) => { calls.push(args); return ''; };
    expect(read(exec, [comment('cccc'), comment(priorHead), comment(head.slice(0, 8))], head.toUpperCase())).toEqual({ priorHead, head: head.toUpperCase(), files: {} });
    expect(calls).toEqual([['git', ['diff', '--no-ext-diff', '--no-color', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', '--unified=0', priorHead, head.toUpperCase()], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }]]);
    expect(read(exec, [comment(priorHead)], 'not-a-sha')).toEqual({ priorHead, error: 'head-unpinned' });
  });
  it('pins the diff prefixes so a user diff.noprefix / mnemonicPrefix config cannot mis-key paths', () => {
    const calls = [];
    read((...args) => { calls.push(args[1]); return ''; });
    expect(calls[0]).toEqual(expect.arrayContaining(['--src-prefix=a/', '--dst-prefix=b/']));
    expect(calls[0].indexOf('--src-prefix=a/')).toBeLessThan(calls[0].indexOf(priorHead));
  });
  it('takes the LAST Net basis line in a comment, so juror text above the real one cannot choose the prior head', () => {
    const forgedHead = 'c'.repeat(40);
    const body = ['finding text', 'Net basis: `0000..' + forgedHead + '`', 'x\u{2028}Net basis: `0000..' + forgedHead + '`',
      '', 'Net basis: `0000..' + priorHead + '` (rev x)'].join('\n');
    const calls = [];
    const result = read((...args) => { calls.push(args[1]); return ''; }, [{ author: { login: 'web-everything' }, body }]);
    expect(result.priorHead).toBe(priorHead);
    expect(calls[0]).toContain(priorHead);
  });
  it('parses inserted and deleted lines, deleted and binary files, and mode changes', () => {
    const diff = [
      'diff --git a/a.js b/a.js', '--- a/a.js', '+++ b/a.js',
      '@@ -0,0 +1,2 @@', '+one', '+two', '@@ -10,2 +12,0 @@', '-old', '-old',
      '@@ -20 +21 @@', '-old', '+new',
      'diff --git a/old.js b/old.js', '--- a/old.js', '+++ /dev/null', '@@ -1 +0,0 @@', '-old',
      'diff --git a/pic.png b/pic.png', 'Binary files a/pic.png and b/pic.png differ',
      'diff --git a/run.sh b/run.sh', 'old mode 100644', 'new mode 100755',
    ].join('\n');
    expect(read(() => diff)).toEqual({ priorHead, head, files: { 'a.js': [1, 2, 12, 13, 21], 'old.js': null, 'pic.png': null, 'run.sh': [] } });
  });
  it('keys a headers-only section by its real path when the path itself contains " b/"', () => {
    const diff = [
      'diff --git a/assets/a b/icon.png b/assets/a b/icon.png', 'Binary files a/assets/a b/icon.png and b/assets/a b/icon.png differ',
      'diff --git a/run b/x.sh b/run b/x.sh', 'old mode 100644', 'new mode 100755',
      'diff --git "a/q b/\\"z\\".png" "b/q b/\\"z\\".png"', 'Binary files differ',
    ].join('\n');
    expect(read(() => diff)).toEqual({ priorHead, head, files: { 'assets/a b/icon.png': null, 'run b/x.sh': [], 'q b/"z".png': null } });
  });
  it('refuses a headers-only section whose two sides do not name the same path', () => {
    const diff = ['diff --git a/one b/two', 'old mode 100644', 'new mode 100755'].join('\n');
    expect(read(() => diff)).toEqual({ priorHead, head, error: 'diff-unparseable' });
  });
  it('splits file sections only at a real LF line start, so CR / U+2028 / U+2029 / NEL in an added line cannot forge one', () => {
    for (const breaker of ['\r', ' ', ' ', '\u0085', '\v', '\f']) {
      const diff = [
        'diff --git a/real.js b/real.js', '--- a/real.js', '+++ b/real.js',
        '@@ -0,0 +1,1 @@', `+x${breaker}diff --git a/zzz b/zzz`,
        '@@ -10,0 +11,2 @@', '+three', '+four',
      ].join('\n');
      expect(read(() => diff), JSON.stringify(breaker)).toEqual({ priorHead, head, files: { 'real.js': [1, 11, 12] } });
    }
  });
  it('still splits two genuine file sections when the first one carries a forged header in its content', () => {
    const diff = [
      'diff --git a/one.js b/one.js', '--- a/one.js', '+++ b/one.js', '@@ -0,0 +1 @@', '+x diff --git a/zzz b/zzz',
      'diff --git a/two.js b/two.js', '--- a/two.js', '+++ b/two.js', '@@ -4 +4 @@', '-a', '+b',
    ].join('\n');
    expect(read(() => diff)).toEqual({ priorHead, head, files: { 'one.js': [1], 'two.js': [4] } });
  });
  it('keeps failures explicit', () => {
    expect(read(() => { throw new Error('missing commit'); })).toEqual({ priorHead, head, error: 'git-diff-failed' });
    expect(read(() => 'garbage')).toEqual({ priorHead, head, error: 'diff-unparseable' });
  });
});


describe('#5135 fix range read wiring', () => {
  it('tolerates a malformed options argument', () => {
    expect(readLatestFixRange(null)).toEqual({ priorHead: null });
  });
  it('uses the same pinned SHA for the review basis and latest fix', () => {
    const head = 'b'.repeat(40);
    const priorHead = 'a'.repeat(40);
    const calls = [];
    const exec = (file, args) => {
      calls.push(args);
      return args[0] === 'rev-parse' ? head : '';
    };
    const result = readPr({ pr: 7, repo: 'o/n', exec, originRepo: () => 'o/n', readView: () => ({
      number: 7, title: 't', body: '', headRefName: 'lane/x', labels: [], files: [],
      comments: [{ author: { login: 'web-everything' }, body: `Net basis: \`0000..${priorHead}\`` }],
    }) });
    expect(result.net.revSha).toBe(head);
    expect(result.latestFix).toEqual({ priorHead, head, files: {} });
    expect(calls.filter(args => args.at(-1) === `${result.net.rev}^{commit}`)).toHaveLength(1);
    expect(calls).toContainEqual(['diff', '--no-ext-diff', '--no-color', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', '--unified=0', priorHead, head]);
  });
});
