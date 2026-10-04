/**
 * @file record-verdict-cli.test.mjs — #3540: `record-verdict`, self-sufficient on a host with no `gh`.
 *
 * THE DEADLOCK THIS CLOSES: `record-verdict`'s `read` step refuses without a staged write-up, and the ONLY
 * thing that ever staged one was `review-pr`'s own `record` step — bundled with the label swap, which needs
 * `gh`. So reaching the write-up meant a separate, manual `review-pr --resume=<runId> --answer=accept` first.
 *
 * These tests drive the REAL engine (`advance`/`runStatus` from `engine.mjs`) against the REAL `review-pr`
 * declaration — no re-implementation of the step machinery — with a stub `readPr` (no `gh`) and STUBBED effect
 * sinks (no real filesystem writes), so the property under test is genuinely "one `record-verdict` call
 * advances review-pr's confirm + write-up locally", not "the io shells happen to work in this environment".
 */
import { describe, it, expect } from 'vitest';

import { advance, advanceWhileRunning, runStatus, startRun } from '../engine.mjs';
import { applyPendingEffects } from '../effect-executor.mjs';
import { createRegistry } from '../registry.mjs';
import { createMemoryRunStore } from '../run-store.mjs';
import { reviewPrOperation, REVIEW_PR_OP, REVIEW_EFFECTS } from '../review-pr.mjs';
import { advanceReviewPrToWriteUp } from '../record-verdict-io.mjs';
import { runRecordVerdictSelfSufficient } from '../record-verdict-cli.mjs';
import { recordVerdictOperation, STAGE_REQUEST_EFFECT } from '../record-verdict.mjs';
import { validateRequest, APPLIABLE_TARGETS } from '../../apply-review-request.mjs';

// #3383 — PIN the advisory-seat default for this whole file. `reviewPrOperation({readPr})` below (no
// `codexAdvisory` passed) always seats the seat's hardcoded `false` default; `record-verdict-io.mjs`'s own
// registration (which `advanceReviewPrToWriteUp`/`runRecordVerdictSelfSufficient` drive) instead calls
// `codexAdvisoryFromEnv()`, which now defaults to the LIVE `{provider:'codex', model:CODEX_MODEL}` probation
// status when the env var is unset. Two runs of the SAME operation started/resumed with different seat
// counts throw ("the declaration changed under a suspended run") — a REAL cross-registration invariant
// (`codexAdvisoryFromEnv`'s own header), not a bug in either half. This suite is not testing the advisory
// seat at all, so it pins the env explicitly to keep both halves in agreement regardless of the registry's
// live contents (today or after a future probation/graduation change).
process.env.REVIEW_PR_CODEX_ADVISORY = '0';
// #x8n4crp — the fourth seat's own env var needs the identical pin, for the identical reason.
process.env.REVIEW_PR_CODEX_CORRECTNESS_ADVISORY = '0';
// #3383 — the fifth seat's own env var needs the identical pin, for the identical reason: its probation
// registration (`model-probation.json`'s `antigravity`/`gemini-3.1-pro` entry) defaults it ON too.
process.env.REVIEW_PR_ANTIGRAVITY_REVIEW = '0';

const BASE_INPUT = { pr: 4242, repo: 'web-everything/web-everything' };
const CLEAN_ANSWER = { summary: 'nothing blocking', findings: [] };

/** A stub `readPr` — no `gh`, no network. `labels` decides gate-self. */
function stubReader({ labels = ['review:pending'] } = {}) {
  return ({ pr, repo }) => ({
    state: 'OPEN',
    clearerId: undefined,
    createdAt: '',
    detail: {
      pr, repo, title: 'a PR', url: `https://example.invalid/${pr}`, labels,
      humanRequired: labels.includes('review:human'),
      reviewClass: labels.includes('review:human') ? 'human' : 'pending',
      disposition: null, escalationReason: [], advisoryComment: null, humanComment: null,
      diffStat: [{ path: 'a.mjs', additions: 1, deletions: 0 }],
    },
    headRefName: 'lane/thing',
    body: 'the PR description',
    net: { paths: ['a.mjs'], base: 'abc123', rev: 'def456', scored: true },
    diff: { text: '--- a/a.mjs\n+++ b/a.mjs\n+one line\n', scored: true },
  });
}

/**
 * Build a review-pr registry over the stub reader, and drive a fresh run to its `confirm` suspend — draining
 * the `advise` step's `awaiting-effect` suspend along the way (#xlw02hw), which only fires for a `review:human`
 * PR (its ADVISORY_NOTE effect); an ordinary PR resolves `advise` inline with zero effects.
 */
async function runAtConfirm({ id = 'run-3540', labels = ['review:pending'], codexAdvisory = false } = {}) {
  const registry = createRegistry();
  registry.register(reviewPrOperation({ readPr: stubReader({ labels }), codexAdvisory }));
  const store = createMemoryRunStore();
  let run = advanceWhileRunning(startRun({ op: REVIEW_PR_OP, id, input: BASE_INPUT, registry }), { registry });
  for (;;) {
    const status = runStatus(run, { registry });
    if (status === 'awaiting-judge') {
      run = advanceWhileRunning(run, { registry, resume: { value: CLEAN_ANSWER } });
      continue;
    }
    if (status === 'awaiting-effect') {
      ({ run } = await applyPendingEffects(run, { sinks: { [REVIEW_EFFECTS.ADVISORY_NOTE]: async () => ({ ok: true }), [REVIEW_EFFECTS.ADVISORY_LABEL]: async () => ({ ok: true }) }, store }));
      run = advanceWhileRunning(run, { registry });
      continue;
    }
    break;
  }
  expect(runStatus(run, { registry })).toBe('awaiting-confirm');
  return { run, registry };
}

/** A WRITE_UP sink that never touches a filesystem — records the call instead. */
function stubWriteUpSinks() {
  const calls = [];
  return { calls, sinks: { [REVIEW_EFFECTS.WRITE_UP]: async (payload) => { calls.push(payload); return { path: 'stub', bytes: String(payload.body).length }; } } };
}

describe('#3540 advanceReviewPrToWriteUp — the local, gh-free half of driving review-pr', () => {
  it('answers confirm and stages the write-up, stopping BEFORE record\'s own (gh-needing) effects', async () => {
    const { run, registry } = await runAtConfirm({ id: 'run-adv-1' });
    const store = createMemoryRunStore();
    store.write(run);
    const { calls, sinks } = stubWriteUpSinks();

    const advanced = await advanceReviewPrToWriteUp(run, { to: 'accepted', store, sinks });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ pr: BASE_INPUT.pr, repo: BASE_INPUT.repo });
    // `stageVerdict` is fully resolved (a clean, applied finding); `record` is DECLARED (its label/ledger/notice
    // effects need `gh`) but never applied by this function.
    expect(advanced.findings.stageVerdict).toMatchObject({ applied: true });
    expect(runStatus(advanced, { registry })).toBe('awaiting-effect');
    expect(advanced.pending.step).toBe('record');
    expect(advanced.effects.some((e) => e.step === 'record' && e.type === REVIEW_EFFECTS.LABEL)).toBe(true);
    expect(advanced.effects.every((e) => e.step !== 'record' || e.status !== 'applied')).toBe(true);
  });

  it('is a no-op on a run that is not genuinely awaiting-confirm', async () => {
    const { run, registry } = await runAtConfirm({ id: 'run-adv-2' });
    const store = createMemoryRunStore();
    // Already answered once — no longer `awaiting-confirm` (it is `awaiting-effect` at `stageVerdict`).
    const answered = advance(run, { registry, resume: { value: 'accept' } });
    expect(runStatus(answered, { registry })).not.toBe('awaiting-confirm');
    const { calls, sinks } = stubWriteUpSinks();
    const result = await advanceReviewPrToWriteUp(answered, { to: 'accepted', store, sinks });
    expect(result).toBe(answered);
    expect(calls).toEqual([]);
  });

  it('passes through a `clear-human` target unchanged — it names no review-pr confirm answer', async () => {
    const { run } = await runAtConfirm({ id: 'run-adv-3', labels: ['review:human'] });
    const store = createMemoryRunStore();
    const { calls, sinks } = stubWriteUpSinks();
    const result = await advanceReviewPrToWriteUp(run, { to: 'clear-human', store, sinks });
    expect(result).toBe(run);
    expect(calls).toEqual([]);
  });

  it('passes through a non-review-pr record, and a null record, unchanged', async () => {
    const store = createMemoryRunStore();
    const { sinks } = stubWriteUpSinks();
    expect(await advanceReviewPrToWriteUp(null, { to: 'accepted', store, sinks })).toBeNull();
    const other = { op: 'verify', id: 'x', cursor: 0, findings: {}, effects: [] };
    expect(await advanceReviewPrToWriteUp(other, { to: 'accepted', store, sinks })).toBe(other);
  });

  it('surfaces review-pr\'s OWN refusal verbatim — INVARIANT 2 still refuses accept on a review:human PR', async () => {
    const { run } = await runAtConfirm({ id: 'run-adv-4', labels: ['review:human'] });
    const store = createMemoryRunStore();
    const { sinks } = stubWriteUpSinks();
    await expect(advanceReviewPrToWriteUp(run, { to: 'accepted', store, sinks }))
      .rejects.toThrow(/gate-self: review:human is human-ceremony-only/);
  });

  it('PR #2117 review: a 3-seat run started with the advisory seat is resumed against the SAVED roster even when REVIEW_PR_CODEX_ADVISORY is NOT set now', async () => {
    const { run } = await runAtConfirm({ id: 'run-adv-roster-1', codexAdvisory: true });
    expect(Object.prototype.hasOwnProperty.call(run.findings, 'judgeAdvisory')).toBe(true);
    const prevEnv = process.env.REVIEW_PR_CODEX_ADVISORY;
    delete process.env.REVIEW_PR_CODEX_ADVISORY;
    try {
      const store = createMemoryRunStore();
      store.write(run);
      const { calls, sinks } = stubWriteUpSinks();
      const advanced = await advanceReviewPrToWriteUp(run, { to: 'accepted', store, sinks });
      expect(calls).toHaveLength(1);
      expect(advanced.pending.step).toBe('record');
      expect(advanced.findings.stageVerdict).toMatchObject({ applied: true });
    } finally {
      if (prevEnv === undefined) {
        delete process.env.REVIEW_PR_CODEX_ADVISORY;
      } else {
        process.env.REVIEW_PR_CODEX_ADVISORY = prevEnv;
      }
    }
  });

  it('PR #2117 review: a saved 2-seat run is resumed against the SAVED roster even when REVIEW_PR_CODEX_ADVISORY IS set now', async () => {
    const { run } = await runAtConfirm({ id: 'run-adv-roster-2' });
    expect(Object.prototype.hasOwnProperty.call(run.findings, 'judgeAdvisory')).toBe(false);
    const prevEnv = process.env.REVIEW_PR_CODEX_ADVISORY;
    process.env.REVIEW_PR_CODEX_ADVISORY = '1';
    try {
      const store = createMemoryRunStore();
      store.write(run);
      const { calls, sinks } = stubWriteUpSinks();
      const advanced = await advanceReviewPrToWriteUp(run, { to: 'accepted', store, sinks });
      expect(calls).toHaveLength(1);
      expect(advanced.pending.step).toBe('record');
      expect(advanced.findings.stageVerdict).toMatchObject({ applied: true });
    } finally {
      if (prevEnv === undefined) {
        delete process.env.REVIEW_PR_CODEX_ADVISORY;
      } else {
        process.env.REVIEW_PR_CODEX_ADVISORY = prevEnv;
      }
    }
  });
});

describe('#3540 record-verdict-cli — ONE call, no separate --resume of the review-pr run', () => {
  /**
   * A write-up store standing in for the real filesystem: `advanceReviewPrToWriteUp`'s WRITE_UP sink writes
   * into it, and `readRun` (record-verdict's injected reader) reads back out of it — the SAME two-sided
   * relationship `reviewBodyPath` gives the real sinks, minus any actual disk io.
   */
  function fakeWriteUpFs() {
    const files = new Map();
    return {
      sinks: { [REVIEW_EFFECTS.WRITE_UP]: async (payload, ctx) => {
        files.set(ctx.runId, String(payload.body));
        return { path: `stub/${ctx.runId}`, bytes: String(payload.body).length };
      } },
      readRun: (reviewPrStore) => ({ runId }) => ({ record: reviewPrStore.read(runId), body: files.get(runId) ?? '' }),
    };
  }

  it('records an agent-reviewable accept in ONE call, with the write-up staged locally first', async () => {
    const { run } = await runAtConfirm({ id: 'run-cli-1' });
    const reviewPrStore = createMemoryRunStore();
    reviewPrStore.write(run);
    const { sinks: writeUpSinks, readRun } = fakeWriteUpFs();

    const declaration = recordVerdictOperation(
      { readRun: readRun(reviewPrStore) },
      { validateRequest, appliableTargets: APPLIABLE_TARGETS },
    );
    const registry = createRegistry();
    registry.register(declaration);
    const staged = [];
    const sinks = {
      ...writeUpSinks,
      [STAGE_REQUEST_EFFECT]: async (payload) => { staged.push(payload); return { pushed: true, path: payload.path }; },
    };

    const out = await runRecordVerdictSelfSufficient({
      declaration, registry, sinks, store: reviewPrStore, reviewPrSinks: writeUpSinks,
      argv: ['--runId=run-cli-1', '--to=accepted'],
      newRunId: () => 'record-verdict-run-1',
    });

    expect(out.code).toBe(0);
    expect(staged).toHaveLength(1);
    const request = JSON.parse(staged[0].content);
    expect(request).toMatchObject({ pr: BASE_INPUT.pr, repo: BASE_INPUT.repo, to: 'accepted' });

    // The review-pr run itself is left cleanly `awaiting-effect` at `record` — `stageVerdict` resolved, no
    // `gh`-needing effect was ever attempted. NOT `effect-halted`: the whole point of #3540.
    const reviewPrRun = reviewPrStore.read('run-cli-1');
    expect(reviewPrRun.pending).toMatchObject({ kind: 'effect', step: 'record' });
    expect(reviewPrRun.findings.stageVerdict).toMatchObject({ applied: true });
  });

  it('leaves a `to=clear-human` call to record-verdict\'s OWN refusal, untouched by the pre-pass', async () => {
    const { run } = await runAtConfirm({ id: 'run-cli-2', labels: ['review:human'] });
    const reviewPrStore = createMemoryRunStore();
    reviewPrStore.write(run);
    const { sinks: writeUpSinks, readRun } = fakeWriteUpFs();
    const declaration = recordVerdictOperation(
      { readRun: readRun(reviewPrStore) },
      { validateRequest, appliableTargets: APPLIABLE_TARGETS },
    );
    const registry = createRegistry();
    registry.register(declaration);

    const out = await runRecordVerdictSelfSufficient({
      declaration, registry, sinks: writeUpSinks, store: reviewPrStore,
      argv: ['--runId=run-cli-2', '--to=clear-human', '--operatorInstruction=an operator said so'],
      newRunId: () => 'record-verdict-run-2',
    });

    // `clear-human` names no review-pr confirm answer, so the pre-pass never touched the review-pr run — and
    // record-verdict's own `read` step refuses on the genuinely-missing write-up, exactly as it always has.
    expect(out.code).not.toBe(0);
    expect(out.lines.join('\n')).toMatch(/staged no write-up/);
    expect(reviewPrStore.read('run-cli-2').pending).toMatchObject({ kind: 'confirm' });
  });

  // #3540 round 2 (converge, correctness) — a pre-pass throw (review-pr's own INVARIANT 2 gate-self refusal)
  // used to escape `runRecordVerdictSelfSufficient` as a raw, uncaught exception instead of the CLI's own
  // structured refusal shape.
  it('surfaces a gate-self pre-pass throw as a structured refusal, not an uncaught exception', async () => {
    const { run } = await runAtConfirm({ id: 'run-cli-3', labels: ['review:human'] });
    const reviewPrStore = createMemoryRunStore();
    reviewPrStore.write(run);
    const { sinks: writeUpSinks, readRun } = fakeWriteUpFs();
    const declaration = recordVerdictOperation(
      { readRun: readRun(reviewPrStore) },
      { validateRequest, appliableTargets: APPLIABLE_TARGETS },
    );
    const registry = createRegistry();
    registry.register(declaration);

    const out = await runRecordVerdictSelfSufficient({
      declaration, registry, sinks: writeUpSinks, store: reviewPrStore,
      argv: ['--runId=run-cli-3', '--to=accepted'],
      newRunId: () => 'record-verdict-run-3',
    });

    expect(out.code).toBe(2);
    expect(out.stopped).toBe('refused');
    expect(out.lines.join('\n')).toMatch(/gate-self: review:human is human-ceremony-only/);
    // The review-pr run never advanced — the throw fired BEFORE any effect applied.
    expect(reviewPrStore.read('run-cli-3').pending).toMatchObject({ kind: 'confirm' });
  });

  // #3540 round 2 (converge, security) — a stray `operatorInstruction` on a non-`clear-human` target used to
  // let the pre-pass commit review-pr's confirm answer BEFORE record-verdict's own validator ever got to
  // refuse the request — an irreversible mutation for a call that was always going to fail.
  it('refuses a stray operatorInstruction BEFORE mutating the review-pr run, not after', async () => {
    const { run } = await runAtConfirm({ id: 'run-cli-4' });
    const reviewPrStore = createMemoryRunStore();
    reviewPrStore.write(run);
    const { sinks: writeUpSinks, readRun } = fakeWriteUpFs();
    const declaration = recordVerdictOperation(
      { readRun: readRun(reviewPrStore) },
      { validateRequest, appliableTargets: APPLIABLE_TARGETS },
    );
    const registry = createRegistry();
    registry.register(declaration);

    const out = await runRecordVerdictSelfSufficient({
      declaration, registry, sinks: writeUpSinks, store: reviewPrStore,
      argv: ['--runId=run-cli-4', '--to=accepted', '--operatorInstruction=this does not belong here'],
      newRunId: () => 'record-verdict-run-4',
    });

    expect(out.code).not.toBe(0);
    // The pre-pass SKIPPED (the precheck refused first), so the write-up was never staged — record-verdict's
    // own `read` step refuses on THAT, before its `plan` step ever gets a chance to name the stray field
    // itself. What matters here is which refusal reaches the operator FIRST is irrelevant; that review-pr's
    // run never mutated is the property under test.
    expect(out.lines.join('\n')).toMatch(/staged no write-up/);
    // The pre-pass never ran: review-pr's confirm is UNTOUCHED, still awaiting an answer.
    expect(reviewPrStore.read('run-cli-4').pending).toMatchObject({ kind: 'confirm' });
  });

  // #3540 round 2 (converge, standards-conformance) — locks in the parse-failure delegation the header claims:
  // malformed argv never reaches the pre-pass at all.
  it('never touches the review-pr run on malformed argv — record-verdict\'s own parse refuses first', async () => {
    const { run } = await runAtConfirm({ id: 'run-cli-5' });
    const reviewPrStore = createMemoryRunStore();
    reviewPrStore.write(run);
    const { sinks: writeUpSinks, readRun } = fakeWriteUpFs();
    const declaration = recordVerdictOperation(
      { readRun: readRun(reviewPrStore) },
      { validateRequest, appliableTargets: APPLIABLE_TARGETS },
    );
    const registry = createRegistry();
    registry.register(declaration);

    // No `--to=` at all — a required field is missing.
    const out = await runRecordVerdictSelfSufficient({
      declaration, registry, sinks: writeUpSinks, store: reviewPrStore,
      argv: ['--runId=run-cli-5'],
      newRunId: () => 'record-verdict-run-5',
    });

    expect(out.code).not.toBe(0);
    expect(reviewPrStore.read('run-cli-5').pending).toMatchObject({ kind: 'confirm' });
  });

  // #3540 round 2 (converge, standards-conformance) — a `--runId` absent from the store must not throw out of
  // the pre-pass; it has to fall through to record-verdict's own refusal.
  it('falls through to record-verdict\'s own refusal for a --runId absent from the store', async () => {
    const reviewPrStore = createMemoryRunStore();
    const { sinks: writeUpSinks, readRun } = fakeWriteUpFs();
    const declaration = recordVerdictOperation(
      { readRun: readRun(reviewPrStore) },
      { validateRequest, appliableTargets: APPLIABLE_TARGETS },
    );
    const registry = createRegistry();
    registry.register(declaration);

    const out = await runRecordVerdictSelfSufficient({
      declaration, registry, sinks: writeUpSinks, store: reviewPrStore,
      argv: ['--runId=no-such-run', '--to=accepted'],
      newRunId: () => 'record-verdict-run-6',
    });

    expect(out.code).not.toBe(0);
    expect(out.lines.join('\n')).toMatch(/no run record/);
  });

  // #3540 round 4 (converge, standards-conformance) — `record-verdict`'s own `stage` effect step CAN suspend
  // (an effect step always can), so `--resume=<record-verdict-run-id>` is a real path into this CLI — one
  // that must never re-answer review-pr's confirm a second time. Pin it directly, rather than trusting the
  // `!parsed.control.resume` guard by inspection alone.
  it('never touches the review-pr run on a --resume of record-verdict\'s OWN run', async () => {
    const { run } = await runAtConfirm({ id: 'run-cli-7' });
    const reviewPrStore = createMemoryRunStore();
    reviewPrStore.write(run);
    const { sinks: writeUpSinks, readRun } = fakeWriteUpFs();
    const declaration = recordVerdictOperation(
      { readRun: readRun(reviewPrStore) },
      { validateRequest, appliableTargets: APPLIABLE_TARGETS },
    );
    const registry = createRegistry();
    registry.register(declaration);

    // A `--resume` against a record-verdict run id review-pr's own store knows nothing about — `runId=run-cli-7`
    // is review-pr's run, never record-verdict's, so this also exercises "resume names an unknown run" without
    // touching review-pr's run either way.
    const out = await runRecordVerdictSelfSufficient({
      declaration, registry, sinks: writeUpSinks, store: reviewPrStore,
      argv: ['--resume=run-cli-7'],
      newRunId: () => 'record-verdict-run-7',
    });

    expect(out.code).not.toBe(0);
    // review-pr's run is byte-identical to before the call: still awaiting the SAME confirm, never advanced.
    expect(reviewPrStore.read('run-cli-7').pending).toMatchObject({ kind: 'confirm' });
    expect(reviewPrStore.read('run-cli-7').findings.stageVerdict).toBeUndefined();
  });
});

// #3540 round 3 (converge, correctness/standards-conformance) — THE PIN for the pre-pass precheck's own stated
// residual: it validates a PLACEHOLDER body because the real write-up does not exist yet, so it can only ever
// enforce body-INDEPENDENT rules. This test is the tripwire — if `validateRequest` ever grows a body-dependent
// rule the placeholder satisfies but a real write-up would not, this reddens, which is exactly where #3540's
// own comment says the fix belongs.
describe('#3540 round 3 — the precheck\'s placeholder body agrees with a realistic one', () => {
  const facts = { repo: 'web-everything/web-everything', pr: 4242, actor: 'claude-review-pr' };
  // A write-up-shaped body: never empty, carries real content — standing in for what
  // `renderVerdictWriteUp` actually produces, without depending on that render pipeline here.
  const REALISTIC_BODY = '**Decision:** `accepted`\n\nRecorded through the declared `review-pr` operation.';

  it('agrees with a realistic body for `accepted`', () => {
    const placeholder = validateRequest({ ...facts, to: 'accepted', body: 'placeholder' });
    const realistic = validateRequest({ ...facts, to: 'accepted', body: REALISTIC_BODY });
    expect(placeholder.ok).toBe(realistic.ok);
  });

  it('agrees with a realistic body for `changes`', () => {
    const placeholder = validateRequest({ ...facts, to: 'changes', body: 'placeholder' });
    const realistic = validateRequest({ ...facts, to: 'changes', body: REALISTIC_BODY });
    expect(placeholder.ok).toBe(realistic.ok);
  });

  // The one body-dependent rule `validateRequest` has TODAY: `changes` refuses an EMPTY body. The precheck's
  // non-empty placeholder can never trip it — named here so a reader sees exactly which rule this residual is
  // about, not just that the two calls happen to agree.
  it('the one body-dependent rule today is `changes` + empty body, which the non-empty placeholder never hits', () => {
    expect(validateRequest({ ...facts, to: 'changes', body: '   ' }).ok).toBe(false);
    expect(validateRequest({ ...facts, to: 'changes', body: 'placeholder' }).ok).toBe(true);
  });
});
