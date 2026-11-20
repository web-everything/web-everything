/**
 * @file review-loop-cli.test.mjs — #3072's remaining slice, exercised end to end with no `gh`, no juror
 * subprocess and no real learnings-pool/backlog file: a stub `readPr`, a canned judge, recording sinks, an
 * in-memory run store, and injected `appendLearning`/`fileItem` bindings.
 *
 * THE FOUR PROPERTIES THIS FILE EXISTS TO PIN (#3434, 2026-09-01, reverses property 1's old shape — it used
 * to say "queues, never auto-accepts"; the operator's live-fire finding, two real PRs sitting queued for no
 * reason, is what prompted the reversal; property 4 REPLACED, not merely reverted, by the #2749 fix,
 * 2026-09-26 — see `review-loop-policy.mjs`'s header for the live incident and the scope ruling):
 *   1. A clean (or already-agreeing) verdict on a non-gate-self PR ACCEPTS MECHANICALLY — the effects apply,
 *      the run completes, and nothing is queued for a human (the old queue-and-notify path is now dead for
 *      this tier; the learnings-pool filing machinery it used stays for `review:human`'s own, unchanged, park).
 *   2. A verdict carrying findings BOUNCES unattended (`changes`, effects applied, run completes) — the round
 *      the operator's automated fix-loop already expects.
 *   3. A gate-self (`review:human`) PR is UNCHANGED: the policy declines (wrong actor), the run parks exactly
 *      as it does for the ordinary human CLI, and no accept — mechanical or manual — happens without one.
 *   4. A `prevention-outstanding` verdict on a non-gate-self PR NEVER auto-clears to `accept` on its own
 *      (`#3442`'s old shape, reversed) and is NEVER queued for a human either (the 2026-09-26 scope ruling:
 *      filing the follow-up is not an operator decision) — instead the loop MECHANICALLY FILES the named
 *      guard(s) as one real backlog card through the declared `file-item` operation and, only once that filing
 *      succeeds, resumes the SAME run with `accept` itself. A filing failure leaves the run parked, unfiled,
 *      unaccepted, and reports loudly. The SAME verdict on a `review:human` PR still parks on its own ceremony
 *      (property 3's actor refusal fires first; `file-item` is never even called).
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, vi, onTestFinished } from 'vitest';

import { createRegistry } from '../registry.mjs';
import { NAME_RE, createMemoryRunStore } from '../run-store.mjs';
import { judgeOutcome, parseOperationArgv } from '../cli-adapter.mjs';
import { fileItemOperation } from '../file-item.mjs';
import { REVIEW_EFFECTS, reviewPrOperation } from '../review-pr.mjs';
import { buildPreventionFilingInput, buildRoundCardsFilingInput, roundCardsFindingsFingerprint, postAcceptAdvisoryShadowReport } from '../../lib/review-loop-policy.mjs';
import {
  runReviewLoopCliOnce, createReviewPassPrReader, defaultFindResumableRun, RESUME_MAX_ATTEMPTS, applyUnattendedActorDefault, buildFileItemArgv, fileItemForPrevention, fileItemForPreventionViaLandingJob,
  findFiledPreventionCard, findFiledRoundCardsCard, findRetainedRoundCardsReceipt, QUEUED_RECEIPT_TTL_MS, retainedRoundCardsReceipt,
  runReviewLoopOnce as driveReviewLoopOnceRaw, UNATTENDED_REVIEW_ACTOR,
} from '../review-loop-cli.mjs';
import { recordPostAcceptAdvisoryShadow, recordPostAcceptAdvisoryLoops, recordPostAcceptAdvisoryRating, createReviewPrSinks } from '../review-pr-io.mjs';
import { planRedTeamOnSkip } from '../../lib/review-red-team-on-skip.mjs';
import { reviewRunEvidence } from '../../conveyor/review-referral-hold.mjs';
import { spawnPreventionLandingJob } from '../../lib/prevention-landing-job.mjs';

import { buildOperatorRulingComment, mandatoryReferralReviewer, normalizeFinding, referralFindingKey,
  renderReferralRecord } from '../../lib/jury-core.mjs';

// #5725 — ordinary orchestration cases never enumerate the checkout backlog: the filed-card lookups default to an
// explicit miss. A case that needs a hit, a structured result, or the REAL lookup passes its own (the spread below
// lets it win). The real lookup/idempotency tests run against tiny temporary backlogs further down.
const LOOKUP_MISS = { findFiledPrevention: () => null, findFiledRoundCards: () => null };
const driveReviewLoopOnce = options => driveReviewLoopOnceRaw({ ...LOOKUP_MISS, advisorySettings: () => ({ value: { mode: 'off' } }), recordAdvisoryLoops: () => null, recordAdvisoryRating: () => null, ...options });

// Legacy filing tests exercise the explicitly disabled safety policy. New boundary tests below
// use the production default through driveReviewLoopOnce.
const runReviewLoopOnce = options => driveReviewLoopOnce({
  acceptPolicy: { value: { unattendedAcceptRequiresCleanReferrals: false } }, ...options,
});

// #4493 converge round-1 (4 of 5 jurors, independently): every existing `runReviewLoopOnce` test injects its own
// `fileItem`, so nothing ever exercised the PRODUCTION DEFAULT wiring — the exact one-line swap
// (`fileItem = fileItemForPreventionViaLandingJob`) this item's whole point is. Mocking only the bottom-most
// seam (`defaultSpawnDetached`, in `../detached-dispatch.mjs`, which `prevention-landing-job.mjs` imports) lets a
// test call `runReviewLoopOnce` with NO override at any layer and still prove no real subprocess/write happens.
const { spawnDetachedCalls } = vi.hoisted(() => ({ spawnDetachedCalls: [] }));
vi.mock('../detached-dispatch.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    defaultSpawnDetached: (argv, opts) => {
      spawnDetachedCalls.push({ argv, opts });
      return { pid: 99999, on: () => {} };
    },
  };
});

const NET_PATHS = ['scripts/operations/review-pr.mjs'];

/** The same stub-reader shape `review-pr.test.mjs` uses, trimmed to what this file needs. */
// Two pinned (40-hex) heads — `netBasis.rev` is null for anything shorter (`pinnedSha`).
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);

function stubReader({ labels = ['review:pending'], rev = 'def456', extra = {} } = {}) {
  return ({ pr, repo }) => ({
    ...extra,
    state: 'OPEN',
    clearerId: undefined,
    createdAt: '',
    detail: {
      pr, repo, title: 'a parked PR', url: `https://example.invalid/${pr}`,
      labels,
      humanRequired: labels.includes('review:human'),
      reviewClass: labels.includes('review:human') ? 'human' : 'pending',
      disposition: { mode: 'converge', autoLand: false },
      escalationReason: ['gate-self'],
      advisoryComment: null,
      humanComment: null,
      diffStat: NET_PATHS.map((p) => ({ path: p, additions: 1, deletions: 0 })),
    },
    headRefName: 'lane/thing',
    body: 'the PR description',
    net: { paths: NET_PATHS, base: 'abc123', rev, scored: true },
    diff: { text: '--- a/x\n+++ b/x\n+one line\n', scored: true },
  });
}

function registryFor(readerOptions) {
  const declaration = reviewPrOperation({ readPr: stubReader(readerOptions) });
  const registry = createRegistry();
  registry.register(declaration);
  return { declaration, registry };
}

/** Recording sinks for every declared effect — no gh, no ledger, no disk. */
function recordingSinks(seen) {
  return Object.fromEntries(
    Object.values(REVIEW_EFFECTS).map((t) => [t, async (payload) => { seen.push({ type: t, payload }); return { ok: true }; }]),
  );
}

const CLEAN_ANSWER = { summary: 'nothing blocking', findings: [] };
const BLOCKING_ANSWER = {
  summary: 'one blocker',
  findings: [{ summary: 'the guard is inverted', file: NET_PATHS[0], disposition: 'blocker' }],
};
// A `nit` (never earns a round — DISPOSITION_EARNS_ROUND) carrying an uncaptured `prevention` at/above the
// impact bar: exactly what `deriveVerdict` requires to reduce to `prevention-outstanding` on round 1, with no
// prior fix pass needed (#3442, #3434's second ratified item).
const PREVENTION_ANSWER = {
  summary: 'no blockers, but a durable guard is owed',
  findings: [{
    summary: 'a magic number should be a named constant',
    file: NET_PATHS[0],
    disposition: 'nit',
    introduced: true,
    worseThanBase: true,
    parallelizable: true,
    prevention: 'add a lint rule banning bare magic numbers in this module',
    preventionCaptured: false,
    impactIfUnfixed: 'broken',
  }],
};
// TWO distinct findings, one with a normal-length guard, one whose guard text alone (500 chars) overflows
// `FIELD_CAPS.suggestion` — `buildPreventionQueueEntry` refuses to truncate it and throws instead. Pins that
// the throw is isolated PER FINDING, not per run (review, finding 1).
const MIXED_LENGTH_ANSWER = {
  summary: 'no blockers, but two durable guards are owed, one with an unreasonably long description',
  findings: [
    {
      summary: 'a magic number should be a named constant',
      file: NET_PATHS[0],
      disposition: 'nit',
      introduced: true,
      worseThanBase: true,
      parallelizable: true,
      prevention: 'add a lint rule banning bare magic numbers in this module',
      preventionCaptured: false,
      impactIfUnfixed: 'broken',
    },
    {
      summary: 'error messages should be centralized',
      file: NET_PATHS[0],
      disposition: 'nit',
      introduced: true,
      worseThanBase: true,
      parallelizable: true,
      prevention: 'x'.repeat(500),
      preventionCaptured: false,
      impactIfUnfixed: 'broken',
    },
  ],
};
// ONE finding AT the prevention impact bar (drives the verdict to `prevention-outstanding`) and one finding
// BELOW it (`cosmetic` < `broken`) — `hasUncapturedPrevention` (the WIDE notice predicate this file's filing
// filters on) does not narrow by the bar, so the below-bar guard must still be filed even though it did not
// itself drive the verdict (review, finding 3 — matches `renderPreventionSummary`'s own convention).
const MIXED_BAR_ANSWER = {
  summary: 'no blockers, but a durable guard is owed even below the prevention impact bar',
  findings: [
    {
      summary: 'a magic number should be a named constant',
      file: NET_PATHS[0],
      disposition: 'nit',
      introduced: true,
      worseThanBase: true,
      parallelizable: true,
      prevention: 'add a lint rule banning bare magic numbers in this module',
      preventionCaptured: false,
      impactIfUnfixed: 'broken',
    },
    {
      summary: 'a helper name could be clearer',
      file: NET_PATHS[0],
      disposition: 'nit',
      introduced: true,
      worseThanBase: true,
      parallelizable: true,
      prevention: 'add a naming-convention doc note for helper functions',
      preventionCaptured: false,
      impactIfUnfixed: 'cosmetic',
    },
  ],
};

const cannedJudge = (answer) => () => async () => judgeOutcome(answer, {});

const BASE_ARGV = ['--pr=1234', '--repo=web-everything/web-everything'];

describe('runReviewLoopOnce — the loop field (converged/in-progress/exhausted/escalated) survives --json on EVERY stop', () => {
  it('on a mechanically-accepted stop, --json carries run.verdict.loop unmodified, no queue fields at all — #3434', async () => {
    const { declaration, registry } = registryFor({});
    const store = createMemoryRunStore();
    const out = await runReviewLoopOnce({
      declaration, registry, argv: [...BASE_ARGV, '--json'], store, sinks: recordingSinks([]),
      makeJudge: cannedJudge(CLEAN_ANSWER), mintRunId: () => 'r-json-accept',
      appendLearning: () => { throw new Error('must not be called — nothing to file when accept lands mechanically'); },
    });
    expect(out.code).toBe(0);
    const payload = JSON.parse(out.lines[0]);
    expect(payload.verdict.loop).toEqual({ outcome: 'converged', round: 1, cap: 5, why: 'accepted at round 1' });
    expect(payload).not.toHaveProperty('queued');
    expect(payload).not.toHaveProperty('resumeCommand');
    expect(payload).not.toHaveProperty('filedTo');
  });

  it('on a bounced (changes) stop, --json carries the loop via the ordinary renderOutcome path', async () => {
    const { declaration, registry } = registryFor({});
    const store = createMemoryRunStore();
    const out = await runReviewLoopOnce({
      declaration, registry, argv: [...BASE_ARGV, '--json'], store, sinks: recordingSinks([]),
      makeJudge: cannedJudge(BLOCKING_ANSWER), mintRunId: () => 'r-json-bounce',
    });
    const payload = JSON.parse(out.lines[0]);
    expect(payload.verdict.loop).toEqual({ outcome: 'in-progress', round: 1, cap: 5, why: 'round 1 of 5 returned `changes`' });
  });
});

/**
 * THE GAP THIS PINS. Every `--json` test above uses `recordingSinks` — a stub that just records the payload it
 * was called with — for EVERY effect, `REVIEW_EFFECTS.NOTICE` included. So none of them ever exercises the
 * REAL notice sink's write, and `out.lines[0]` (the only thing they `JSON.parse`) is only ever the final
 * rendered payload `runReviewLoopOnce` returns — never the actual, ordered bytes that would land on a real
 * process's stdout, which is the notice sink's own write (mid-run, inside `driveRun`) FOLLOWED BY the CLI's
 * `writeAllSync(1, …)` of that final line (`we:scripts/operations/review-loop-cli.mjs`'s `IS_CLI` block). A
 * caller doing a strict `JSON.parse` of the WHOLE captured stdout — exactly what a mechanical, non-agentic
 * consumer does, and exactly what an LLM agent reading its own output does not need to — never had a test.
 *
 * These two tests wire in the REAL `we:scripts/operations/review-pr-io.mjs#createReviewPrSinks` notice sink
 * (every other effect stays the cheap `recordingSinks` stub — no `gh`, no ledger, no disk) and reconstruct the
 * exact bytes a real `--json` invocation would put on fd 1: whatever the notice sink wrote to `process.stdout`
 * during the run, followed by the final rendered line. The first pins the FIX (`json: true` → stderr, stdout
 * stays pure JSON); the second is the harness's own self-check — built with the sink's OLD, un-json-aware
 * default (`json: false`) — proving this file would actually have failed red before the fix, which is the gap
 * that let the bug ship in the first place.
 */
describe('review-loop-cli.mjs --json stdout purity — the notice effect must not land on stdout', () => {
  function sinksWithRealNotice(json) {
    return { ...recordingSinks([]), [REVIEW_EFFECTS.NOTICE]: createReviewPrSinks({ json })[REVIEW_EFFECTS.NOTICE] };
  }

  async function runCapturingStdio(sinks) {
    const { declaration, registry } = registryFor({});
    const store = createMemoryRunStore();
    const stdoutChunks = [];
    const stderrChunks = [];
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { stdoutChunks.push(String(chunk)); return true; });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { stderrChunks.push(String(chunk)); return true; });
    try {
      const out = await runReviewLoopOnce({
        declaration, registry, argv: [...BASE_ARGV, '--json'], store, sinks,
        makeJudge: cannedJudge(CLEAN_ANSWER), mintRunId: () => 'r-json-notice-purity',
        appendLearning: () => { throw new Error('must not be called — nothing to file when accept lands mechanically'); },
      });
      // The exact bytes a real invocation puts on fd 1: the notice sink's own write(s), THEN the CLI's final
      // `writeAllSync(1, \`${lines.join('\n')}\n\`)` — see the IS_CLI block this mirrors.
      const combinedStdout = `${stdoutChunks.join('')}${out.lines.join('\n')}\n`;
      return { out, stdoutChunks, stderrChunks, combinedStdout };
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  }

  it('with the fix (json:true passed to createReviewPrSinks), stdout is ONE parseable JSON document end to end, even though the notice effect fires mid-run', async () => {
    const { out, stdoutChunks, stderrChunks, combinedStdout } = await runCapturingStdio(sinksWithRealNotice(true));
    expect(out.code).toBe(0);
    // The notice really did fire — on stderr, never stdout — or this test would prove nothing.
    expect(stderrChunks.join('')).toMatch(/^PR web-everything\/web-everything#1234 — human review accepted/);
    expect(stdoutChunks).toEqual([]);
    expect(() => JSON.parse(combinedStdout)).not.toThrow();
    expect(JSON.parse(combinedStdout).verdict.loop.outcome).toBe('converged');
  });

  it('self-check: with the sink\'s OLD un-json-aware default (json:false), the notice pollutes stdout and JSON.parse throws — proves this file would have caught the original bug', async () => {
    const { stdoutChunks, combinedStdout } = await runCapturingStdio(sinksWithRealNotice(false));
    expect(stdoutChunks.length).toBeGreaterThan(0);
    expect(() => JSON.parse(combinedStdout)).toThrow();
  });
});

describe('runReviewLoopOnce — property 1: a clean verdict on review:pending ACCEPTS MECHANICALLY (#3434)', () => {
  it('applies the effects, completes the run, and never files a learnings-pool notice', async () => {
    const { declaration, registry } = registryFor({});
    const store = createMemoryRunStore();
    const seen = [];
    const out = await runReviewLoopOnce({
      declaration, registry, argv: BASE_ARGV, store, sinks: recordingSinks(seen),
      makeJudge: cannedJudge(CLEAN_ANSWER), mintRunId: () => 'r-clean',
      appendLearning: () => { throw new Error('must not be called — nothing to file when accept lands mechanically'); },
    });

    expect(out.code).toBe(0);
    expect(out.stopped).toBe('complete');
    expect(out.run.findings.confirm).toBe('accept');
    // The SAME effect application a bounce gets — a label swap lands, this time to accepted, not parked.
    expect(seen.map((s) => s.type)).toContain(REVIEW_EFFECTS.LABEL);
    expect(out.lines.join('\n')).not.toMatch(/QUEUED for a human/);
  });

  it('names the round-cap outcome in its text output, same shape a bounce gets', async () => {
    const { declaration, registry } = registryFor({});
    const store = createMemoryRunStore();
    const out = await runReviewLoopOnce({
      declaration, registry, argv: BASE_ARGV, store, sinks: recordingSinks([]),
      makeJudge: cannedJudge(CLEAN_ANSWER), mintRunId: () => 'r-clean-loop-line',
      appendLearning: () => { throw new Error('must not be called'); },
    });
    expect(out.lines.join('\n')).toMatch(/review loop: converged — accepted at round 1/);
  });
});

describe('runReviewLoopOnce — property 2: findings BOUNCE unattended, and the run completes', () => {
  it('auto-answers `changes`, applies the effects, and never touches the learnings pool', async () => {
    const { declaration, registry } = registryFor({});
    const store = createMemoryRunStore();
    const seen = [];
    let filedCount = 0;
    const out = await runReviewLoopOnce({
      declaration, registry, argv: BASE_ARGV, store, sinks: recordingSinks(seen),
      makeJudge: cannedJudge(BLOCKING_ANSWER), mintRunId: () => 'r-bounce',
      appendLearning: () => { filedCount += 1; return { record: {}, path: '' }; },
    });
    expect(out.stopped).toBe('complete');
    expect(out.code).toBe(0);
    expect(out.run.findings.confirm).toBe('changes');
    expect(seen.map((s) => s.type)).toContain(REVIEW_EFFECTS.LABEL);
    expect(filedCount).toBe(0);
  });

  it('names the round-cap outcome in its text output', async () => {
    const { declaration, registry } = registryFor({});
    const store = createMemoryRunStore();
    const out = await runReviewLoopOnce({
      declaration, registry, argv: BASE_ARGV, store, sinks: recordingSinks([]),
      makeJudge: cannedJudge(BLOCKING_ANSWER), mintRunId: () => 'r-loop-line',
    });
    expect(out.lines.join('\n')).toMatch(/review loop: in-progress — round 1 of 5/);
  });
});

describe('runReviewLoopOnce — property 4, MECHANIZED (#2749 fix, 2026-09-26 scope ruling): prevention-outstanding '
  + 'files the owed guard(s) as ONE real backlog card through file-item, then auto-resumes to accept — NEVER '
  + 'surfaced to a human', () => {
  // #2749 — web-everything/web-everything#2749 reduced to `prevention-outstanding` (both mandatory lenses, correctness
  // and security, CONFIRMED real unfixed defects: a daemon-clone guard bypassable via LANE_GUARD_OFF=1, a
  // chained `git -C` hole, a non-realpathed symlink write hole) and was mechanically recorded `review:accepted`
  // and merged anyway — directly contradicting the verdict's own rendered text, "🚩 prevention outstanding —
  // file the guard before accept". `#3442`'s old mechanical-accept-WITHOUT-filing is reversed; the 2026-09-26
  // scope ruling additionally forbids surfacing the filing as a decision for an operator (see
  // `review-loop-policy.mjs`'s header) — so this is neither the old "accepts mechanically, notifies a human
  // afterward" shape NOR a park; it is "files the real card itself, then accepts."
  const stubFileItem = (num = 9001, rel = 'backlog/9001-file-the-guard.md') => async () => ({
    code: 0,
    lines: [JSON.stringify({ verdict: { num, rel, kind: 'story', status: 'open' } })],
  });

  it('files ONE backlog card via file-item, then completes the run as an accept — no learnings-pool notice at all', async () => {
    const { declaration, registry } = registryFor({});
    const store = createMemoryRunStore();
    const seen = [];
    const fileItemCalls = [];
    const out = await runReviewLoopOnce({
      declaration, registry, argv: BASE_ARGV, store, sinks: recordingSinks(seen),
      makeJudge: cannedJudge(PREVENTION_ANSWER), mintRunId: () => 'r-prevention',
      appendLearning: () => { throw new Error('must not be called — never surfaced to a human'); },
      fileItem: async (input) => { fileItemCalls.push(input); return stubFileItem()(); },
    });

    expect(out.code).toBe(0);
    expect(out.stopped).toBe('complete');
    expect(out.run.findings.confirm).toBe('accept');
    expect(out.run.verdict.verdict).toBe('prevention-outstanding');
    // The SAME effect application a clean accept gets — a label swap to accepted.
    expect(seen.map((s) => s.type)).toContain(REVIEW_EFFECTS.LABEL);
    expect(fileItemCalls).toHaveLength(1);
    expect(fileItemCalls[0].title).toContain('web-everything/web-everything#1234');
    expect(fileItemCalls[0].scope).toContain(`we:${NET_PATHS[0]}`);
    expect(fileItemCalls[0].queue).toBe('true');
    expect(out.lines.join('\n')).toMatch(/prevention guard\(s\) filed mechanically — backlog\/9001-file-the-guard\.md \(#9001\)/);
    expect(out.lines.join('\n')).toMatch(/no human was asked/);
    expect(out.lines.join('\n')).not.toMatch(/QUEUED for a human/);
  });

  // The production-default lookup path (the checkout backlog scan) is not observable from here — only that it runs without
  // breaking the flow; the real lookups' hit/miss/idempotency behavior is pinned against temp backlogs further down.
  it('#5725 — with NO lookup injected (explicit `undefined` restores the production defaults) the default lookup path runs to completion and the card is filed', async () => {
    const { declaration, registry } = registryFor({});
    const fileItemCalls = [];
    const out = await runReviewLoopOnce({
      declaration, registry, argv: BASE_ARGV, store: createMemoryRunStore(), sinks: recordingSinks([]),
      makeJudge: cannedJudge(PREVENTION_ANSWER), mintRunId: () => 'r-prevention-default-lookup',
      findFiledPrevention: undefined, findFiledRoundCards: undefined,
      fileItem: async (input) => { fileItemCalls.push(input); return stubFileItem()(); },
    });
    expect(out.stopped).toBe('complete');
    expect(fileItemCalls).toHaveLength(1);
  });

  it('carries `preventionFiled` (num + path) in --json, with no `queued`/`resumeCommand`/`outstandingGuards` fields', async () => {
    const { declaration, registry } = registryFor({});
    const store = createMemoryRunStore();
    const out = await runReviewLoopOnce({
      declaration, registry, argv: [...BASE_ARGV, '--json'], store, sinks: recordingSinks([]),
      makeJudge: cannedJudge(PREVENTION_ANSWER), mintRunId: () => 'r-prevention-json',
      fileItem: stubFileItem(4242, 'backlog/4242-x.md'),
    });
    const payload = JSON.parse(out.lines[0]);
    expect(payload.verdict.verdict).toBe('prevention-outstanding');
    expect(payload.preventionFiled).toEqual({ num: 4242, path: 'backlog/4242-x.md' });
    expect(payload).not.toHaveProperty('queued');
    expect(payload).not.toHaveProperty('resumeCommand');
    expect(payload).not.toHaveProperty('outstandingGuards');
  });

  it('a filing FAILURE (thrown) leaves the run PARKED — no accept, no effects applied, reported loudly', async () => {
    const { declaration, registry } = registryFor({});
    const store = createMemoryRunStore();
    const seen = [];
    const out = await runReviewLoopOnce({
      declaration, registry, argv: BASE_ARGV, store, sinks: recordingSinks(seen),
      makeJudge: cannedJudge(PREVENTION_ANSWER), mintRunId: () => 'r-prevention-filing-fails',
      fileItem: async () => { throw new Error('backlog write failed: disk full'); },
    });
    expect(out.code).toBe(1);
    expect(out.stopped).toBe('confirm');
    expect(out.run.pending.of).toBe('agent');
    expect(seen).toHaveLength(0);
    expect(out.lines.join('\n')).toMatch(/FAILED to file the owed prevention card mechanically: backlog write failed: disk full/);
    expect(out.lines.join('\n')).toMatch(/never auto-cleared unfiled/);
  });

  it('a filing REFUSAL (file-item itself returns a non-zero exit code) also leaves the run parked, in --json too', async () => {
    const { declaration, registry } = registryFor({});
    const store = createMemoryRunStore();
    const out = await runReviewLoopOnce({
      declaration, registry, argv: [...BASE_ARGV, '--json'], store, sinks: recordingSinks([]),
      makeJudge: cannedJudge(PREVENTION_ANSWER), mintRunId: () => 'r-prevention-refused',
      fileItem: async () => ({ code: 2, lines: ['error: invalid --scope'] }),
    });
    expect(out.code).toBe(1);
    expect(out.stopped).toBe('confirm');
    const payload = JSON.parse(out.lines[0]);
    expect(payload.preventionFilingError).toMatch(/file-item refused: error: invalid --scope/);
  });

  it('scopes the filed card to every OUTSTANDING finding\'s file, including one below the prevention impact bar — '
    + 'the WIDE notice predicate (`hasUncapturedPrevention`), not the narrow verdict one (`blocksAcceptance`)', async () => {
    // Only ONE finding needs to cross the bar to reach this verdict at all; a sibling finding below the bar
    // still owes its guard and must still be named in the filed card, matching `renderPreventionSummary`'s own
    // convention (see `buildPreventionFilingInput`'s doc for the same point).
    const { declaration, registry } = registryFor({});
    const store = createMemoryRunStore();
    const fileItemCalls = [];
    const out = await runReviewLoopOnce({
      declaration, registry, argv: BASE_ARGV, store, sinks: recordingSinks([]),
      makeJudge: cannedJudge(MIXED_BAR_ANSWER), mintRunId: () => 'r-prevention-mixed-bar',
      fileItem: async (input) => { fileItemCalls.push(input); return stubFileItem(1, 'backlog/1.md')(); },
    });
    expect(out.stopped).toBe('complete');
    expect(fileItemCalls[0].digest).toContain('lint rule banning bare magic numbers');
    expect(fileItemCalls[0].digest).toContain('naming-convention doc note');
  });

  it('a SUCCESSFUL filing whose stdout carries a non-JSON line before the JSON (a Node warning) still reads the '
    + 'filed card and accepts — never an uncaught SyntaxError', async () => {
    const { declaration, registry } = registryFor({});
    const store = createMemoryRunStore();
    const out = await runReviewLoopOnce({
      declaration, registry, argv: BASE_ARGV, store, sinks: recordingSinks([]),
      makeJudge: cannedJudge(PREVENTION_ANSWER), mintRunId: () => 'r-prevention-noisy-stdout',
      fileItem: async () => ({
        code: 0,
        lines: [
          '(node:123) [DEP0040] DeprecationWarning: The `punycode` module is deprecated.',
          JSON.stringify({ verdict: { num: 77, rel: 'backlog/77-x.md' } }, null, 2),
        ],
      }),
    });
    expect(out.stopped).toBe('complete');
    expect(out.run.findings.confirm).toBe('accept');
    expect(out.lines.join('\n')).toMatch(/backlog\/77-x\.md \(#77\)/);
  });

  it('a SUCCESSFUL filing whose stdout carries no parseable JSON at all still accepts (the card IS filed — '
    + 're-parking would file a duplicate on the next round), naming the unreadable reference', async () => {
    const { declaration, registry } = registryFor({});
    const store = createMemoryRunStore();
    const out = await runReviewLoopOnce({
      declaration, registry, argv: BASE_ARGV, store, sinks: recordingSinks([]),
      makeJudge: cannedJudge(PREVENTION_ANSWER), mintRunId: () => 'r-prevention-garbled-stdout',
      fileItem: async () => ({ code: 0, lines: ['Warning: something', '{not json'] }),
    });
    expect(out.stopped).toBe('complete');
    expect(out.lines.join('\n')).toMatch(/filed mechanically — \(no path\) \(#\?\)/);
  });

  it('a review:human PR carrying the same verdict is STILL PARKED — its own review:human ceremony is untouched, '
    + 'and file-item is never even called', async () => {
    const { declaration, registry } = registryFor({ labels: ['review:human'] });
    const store = createMemoryRunStore();
    let fileItemCalled = false;
    const out = await runReviewLoopOnce({
      declaration, registry, argv: BASE_ARGV, store, sinks: recordingSinks([]),
      makeJudge: cannedJudge(PREVENTION_ANSWER), mintRunId: () => 'r-prevention-human',
      fileItem: async () => { fileItemCalled = true; return { code: 0, lines: ['{}'] }; },
    });
    expect(out.stopped).toBe('confirm');
    expect(out.run.pending.of).toBe('human');
    expect(fileItemCalled).toBe(false);
  });

  // PR #2766 advisory — re-targets the two effect-halted cases the #2749 fix deleted along with the old
  // `isPreventionOutstandingClear` path: the card is filed FIRST, then the resumed accept's label swap throws.
  const throwingLabelSinks = () => ({
    ...recordingSinks([]),
    [REVIEW_EFFECTS.LABEL]: async () => { throw new Error('gh label edit failed: network error'); },
  });

  it('a successful filing followed by an effect-halted accept exits 1 as `effect-halted`, keeps the filing note, '
    + 'and never claims the accept landed', async () => {
    const { declaration, registry } = registryFor({});
    const out = await runReviewLoopOnce({
      declaration, registry, argv: BASE_ARGV, store: createMemoryRunStore(), sinks: throwingLabelSinks(),
      makeJudge: cannedJudge(PREVENTION_ANSWER), mintRunId: () => 'r-prevention-effect-halted',
      fileItem: stubFileItem(), findFiledPrevention: () => null,
    });
    expect(out.stopped).toBe('effect-halted');
    expect(out.code).toBe(1);
    const text = out.lines.join('\n');
    expect(text).toMatch(/prevention guard\(s\) filed mechanically — backlog\/9001-file-the-guard\.md/);
    expect(text).not.toMatch(/✅ review — accepted/);
  });

  it('same effect-halted case, --json: exit code 1, `stopped: effect-halted`, and `preventionFiled` still names the card', async () => {
    const { declaration, registry } = registryFor({});
    const out = await runReviewLoopOnce({
      declaration, registry, argv: [...BASE_ARGV, '--json'], store: createMemoryRunStore(), sinks: throwingLabelSinks(),
      makeJudge: cannedJudge(PREVENTION_ANSWER), mintRunId: () => 'r-prevention-effect-halted-json',
      fileItem: stubFileItem(), findFiledPrevention: () => null,
    });
    expect(out.code).toBe(1);
    const payload = JSON.parse(out.lines[0]);
    expect(payload.stopped).toBe('effect-halted');
    expect(payload.preventionFiled).toEqual({ num: 9001, path: 'backlog/9001-file-the-guard.md' });
  });
});

// PR #2767 advisory (test-gaming check): the mechanized branch above did NOT retire the learnings-pool
// `isPreventionOutstandingClear` branch — it is still reachable whenever a HUMAN answers `accept` on a parked
// `prevention-outstanding` run (e.g. after a mechanized filing failed and they filed the card by hand). The
// tests that pinned that branch's own guarantees (per-finding failure isolation, loud filing failure, and
// "an effect-halted resume is not a clean clear") are kept here, re-routed through that real path.
describe('runReviewLoopOnce — a human `--answer=accept` resume of a parked prevention-outstanding run still files '
  + 'its guard(s) to the learnings pool (the isPreventionOutstandingClear branch)', () => {
  /** Opens a run whose mechanized filing FAILS, so it stays parked for the resume under test. */
  async function parkedPreventionRun({ answer = PREVENTION_ANSWER, runId }) {
    const { declaration, registry } = registryFor({});
    const store = createMemoryRunStore();
    const opened = await runReviewLoopOnce({
      declaration, registry, argv: BASE_ARGV, store, sinks: recordingSinks([]),
      makeJudge: cannedJudge(answer), mintRunId: () => runId,
      fileItem: async () => { throw new Error('backlog write failed'); },
    });
    expect(opened.stopped).toBe('confirm');
    return { declaration, registry, store };
  }

  it('files every named guard and reports the accept', async () => {
    const { declaration, registry, store } = await parkedPreventionRun({ runId: 'r-clear' });
    const seen = [];
    let filedCount = 0;
    const out = await runReviewLoopOnce({
      declaration, registry, argv: ['--resume=r-clear', '--answer=accept'], store, sinks: recordingSinks(seen),
      makeJudge: cannedJudge(PREVENTION_ANSWER), mintRunId: () => 'unused',
      appendLearning: (entry) => { filedCount += 1; return { record: entry, path: `pool/${filedCount}.json` }; },
    });
    expect(out.code).toBe(0);
    expect(out.stopped).toBe('complete');
    expect(out.run.findings.confirm).toBe('accept');
    expect(seen.map((s) => s.type)).toContain(REVIEW_EFFECTS.LABEL);
    expect(filedCount).toBeGreaterThan(0);
    expect(out.lines.join('\n')).toMatch(/prevention-outstanding auto-cleared to accept/);
  });

  it('reports a failed filing loudly without undoing the accept that already recorded', async () => {
    const { declaration, registry, store } = await parkedPreventionRun({ runId: 'r-clear-fails' });
    const out = await runReviewLoopOnce({
      declaration, registry, argv: ['--resume=r-clear-fails', '--answer=accept'], store, sinks: recordingSinks([]),
      makeJudge: cannedJudge(PREVENTION_ANSWER), mintRunId: () => 'unused',
      appendLearning: () => { throw new Error('pool file locked'); },
    });
    expect(out.code).toBe(1);
    expect(out.stopped).toBe('complete');
    expect(out.run.findings.confirm).toBe('accept');
    expect(out.lines.join('\n')).toMatch(/FAILED to file \(some guard\(s\) may be unfiled\): pool file locked/);
  });

  it('isolates a single oversized guard\'s BUILD failure — the OTHER guard(s) in the same run still file', async () => {
    // `buildPreventionQueueEntry` REFUSES (throws) rather than truncates a `prevention` string that overflows
    // `FIELD_CAPS.suggestion`; the build step, not just the append, is caught PER FINDING.
    const { declaration, registry, store } = await parkedPreventionRun({ answer: MIXED_LENGTH_ANSWER, runId: 'r-clear-mixed' });
    let filedCount = 0;
    const out = await runReviewLoopOnce({
      declaration, registry, argv: ['--resume=r-clear-mixed', '--answer=accept'], store, sinks: recordingSinks([]),
      makeJudge: cannedJudge(MIXED_LENGTH_ANSWER), mintRunId: () => 'unused',
      appendLearning: (entry) => { filedCount += 1; return { record: entry, path: `pool/${filedCount}.json` }; },
    });
    expect(out.stopped).toBe('complete');
    expect(out.code).toBe(1); // the oversized guard failed to build
    expect(filedCount).toBeGreaterThan(0); // the short guard still filed despite its sibling's failure
    expect(out.lines.join('\n')).toMatch(/filed →/);
    expect(out.lines.join('\n')).toMatch(/FAILED to file \(some guard\(s\) may be unfiled\)/);
  });

  // Independent review of PR #1784 (CONFIRMED): a mid-apply failure must not take the filing branch nor exit 0.
  const throwingLabelSinks = () => ({
    ...recordingSinks([]),
    [REVIEW_EFFECTS.LABEL]: async () => { throw new Error('gh label edit failed: network error'); },
  });

  it('an effect-halted resume (the accept label swap threw) is NOT treated as prevention-outstanding-clear — no filing, exit code 1', async () => {
    const { declaration, registry, store } = await parkedPreventionRun({ runId: 'r-clear-halted' });
    let filedCount = 0;
    const out = await runReviewLoopOnce({
      declaration, registry, argv: ['--resume=r-clear-halted', '--answer=accept'], store, sinks: throwingLabelSinks(),
      makeJudge: cannedJudge(PREVENTION_ANSWER), mintRunId: () => 'unused',
      appendLearning: () => { filedCount += 1; return { record: {}, path: '' }; },
    });
    expect(out.stopped).toBe('effect-halted');
    expect(out.code).toBe(1);
    expect(filedCount).toBe(0);
  });

  it('same effect-halted case, --json: exit code still 1, no `preventionFiled` field', async () => {
    const { declaration, registry, store } = await parkedPreventionRun({ runId: 'r-clear-halted-json' });
    const out = await runReviewLoopOnce({
      declaration, registry, argv: ['--resume=r-clear-halted-json', '--answer=accept', '--json'], store, sinks: throwingLabelSinks(),
      makeJudge: cannedJudge(PREVENTION_ANSWER), mintRunId: () => 'unused',
      appendLearning: () => { throw new Error('must not be called'); },
    });
    expect(out.code).toBe(1);
    const payload = JSON.parse(out.lines[0]);
    expect(payload.stopped).toBe('effect-halted');
    expect(payload).not.toHaveProperty('preventionFiled');
  });
});

describe('runReviewLoopOnce — a retry after an effect-halted mechanized accept never double-files a guard (PR #2766)', () => {
  const throwingLabelSinks = () => ({
    ...recordingSinks([]),
    [REVIEW_EFFECTS.LABEL]: async () => { throw new Error('gh label edit failed: network error'); },
  });

  // Round 2 is a FRESH jury on the SAME head: same guard, different words — the realistic retry (self-review).
  const REWORDED_PREVENTION_ANSWER = {
    ...PREVENTION_ANSWER,
    findings: [{ ...PREVENTION_ANSWER.findings[0], prevention: 'lint against unnamed numeric literals here' }],
  };

  /** One temp backlog dir + a `file-item` stub that writes the card the way `renderItem` does (`# <title>`, then the digest). */
  function tempBacklog() {
    const root = mkdtempSync(join(tmpdir(), 'review-loop-prevention-'));
    mkdirSync(join(root, 'backlog'));
    const calls = [];
    const fileItem = async (input) => {
      calls.push(input);
      const name = `x${calls.length}-file-the-guard.md`;
      writeFileSync(join(root, 'backlog', name), `---\nkind: story\n---\n\n# ${input.title}\n\n${input.digest}\n`);
      return { code: 0, lines: [JSON.stringify({ verdict: { num: `x${calls.length}`, rel: `backlog/${name}` } })] };
    };
    const findFiledPrevention = (input, o) => findFiledPreventionCard(input, { ...o, root });
    return { root, calls, fileItem, findFiledPrevention, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  }

  it('a retry after an effect-halted accept, on the SAME head with a freshly-worded jury, does NOT file a second card', async () => {
    const tb = tempBacklog();
    try {
      const reader = { rev: HEAD_A };
      const r1 = registryFor(reader);
      const first = await runReviewLoopOnce({
        declaration: r1.declaration, registry: r1.registry, argv: BASE_ARGV, store: createMemoryRunStore(),
        sinks: throwingLabelSinks(), makeJudge: cannedJudge(PREVENTION_ANSWER), mintRunId: () => 'r-retry-1',
        fileItem: tb.fileItem, findFiledPrevention: tb.findFiledPrevention,
      });
      expect(first.stopped).toBe('effect-halted');
      expect(tb.calls[0].digest).toContain(`reviewed head \`${HEAD_A}\``);

      const r2 = registryFor(reader);
      const second = await runReviewLoopOnce({
        declaration: r2.declaration, registry: r2.registry, argv: [...BASE_ARGV, '--json'], store: createMemoryRunStore(),
        sinks: recordingSinks([]), makeJudge: cannedJudge(REWORDED_PREVENTION_ANSWER), mintRunId: () => 'r-retry-2',
        fileItem: tb.fileItem, findFiledPrevention: tb.findFiledPrevention,
      });
      expect(second.stopped).toBe('complete');
      expect(tb.calls).toHaveLength(1);
      expect(readdirSync(join(tb.root, 'backlog'))).toHaveLength(1);
      expect(JSON.parse(second.lines[0]).preventionFiled).toEqual({
        num: 'x1', path: 'backlog/x1-file-the-guard.md', alreadyFiled: true,
      });
    } finally {
      tb.cleanup();
    }
  });

  it('a round on a NEW head (the PR was pushed again) still files its own card', async () => {
    const tb = tempBacklog();
    try {
      for (const [rev, id] of [[HEAD_A, 'r-head-a'], [HEAD_B, 'r-head-b']]) {
        const r = registryFor({ rev });
        await runReviewLoopOnce({
          declaration: r.declaration, registry: r.registry, argv: BASE_ARGV, store: createMemoryRunStore(),
          sinks: recordingSinks([]), makeJudge: cannedJudge(PREVENTION_ANSWER), mintRunId: () => id,
          fileItem: tb.fileItem, findFiledPrevention: tb.findFiledPrevention,
        });
      }
      expect(tb.calls).toHaveLength(2);
    } finally {
      tb.cleanup();
    }
  });

  // PR #2766 advisory (codex-correctness): a same-head retry whose fresh jury names an EXTRA guard.
  const ADDED_GUARD_ANSWER = {
    ...PREVENTION_ANSWER,
    findings: [
      REWORDED_PREVENTION_ANSWER.findings[0],
      {
        ...PREVENTION_ANSWER.findings[0], summary: 'the retry count is unbounded', line: 40,
        prevention: 'cap the retry loop and pin the cap in a test',
      },
    ],
  };

  it('same-head retry files newly discovered prevention guards before accepting — and ONLY the new ones', async () => {
    const tb = tempBacklog();
    try {
      const reader = { rev: HEAD_A };
      const r1 = registryFor(reader);
      await runReviewLoopOnce({
        declaration: r1.declaration, registry: r1.registry, argv: BASE_ARGV, store: createMemoryRunStore(),
        sinks: throwingLabelSinks(), makeJudge: cannedJudge(PREVENTION_ANSWER), mintRunId: () => 'r-added-1',
        fileItem: tb.fileItem, findFiledPrevention: tb.findFiledPrevention,
      });
      const r2 = registryFor(reader);
      const second = await runReviewLoopOnce({
        declaration: r2.declaration, registry: r2.registry, argv: [...BASE_ARGV, '--json'], store: createMemoryRunStore(),
        sinks: recordingSinks([]), makeJudge: cannedJudge(ADDED_GUARD_ANSWER), mintRunId: () => 'r-added-2',
        fileItem: tb.fileItem, findFiledPrevention: tb.findFiledPrevention,
      });
      expect(second.stopped).toBe('complete');
      expect(tb.calls).toHaveLength(2);
      expect(tb.calls[1].digest).toContain('cap the retry loop and pin the cap in a test');
      expect(tb.calls[1].digest).not.toContain('lint against unnamed numeric literals here');
      expect(JSON.parse(second.lines[0]).preventionFiled).toEqual({ num: 'x2', path: 'backlog/x2-file-the-guard.md' });
    } finally {
      tb.cleanup();
    }
  });

  it('with NO pinned head (a degraded read), a freshly-worded retry of the same guard still files no second card', async () => {
    const tb = tempBacklog();
    try {
      const reader = { rev: 'def456' }; // not 40-hex → netBasis.rev is null
      const r1 = registryFor(reader);
      const first = await runReviewLoopOnce({
        declaration: r1.declaration, registry: r1.registry, argv: BASE_ARGV, store: createMemoryRunStore(),
        sinks: throwingLabelSinks(), makeJudge: cannedJudge(PREVENTION_ANSWER), mintRunId: () => 'r-nohead-1',
        fileItem: tb.fileItem, findFiledPrevention: tb.findFiledPrevention,
      });
      expect(first.stopped).toBe('effect-halted');
      expect(tb.calls[0].digest).not.toContain('reviewed head');
      const r2 = registryFor(reader);
      const second = await runReviewLoopOnce({
        declaration: r2.declaration, registry: r2.registry, argv: BASE_ARGV, store: createMemoryRunStore(),
        sinks: recordingSinks([]), makeJudge: cannedJudge(REWORDED_PREVENTION_ANSWER), mintRunId: () => 'r-nohead-2',
        fileItem: tb.fileItem, findFiledPrevention: tb.findFiledPrevention,
      });
      expect(second.stopped).toBe('complete');
      expect(tb.calls).toHaveLength(1);
    } finally {
      tb.cleanup();
    }
  });

  it('`findFiledPreventionCard` matches PER GUARD: title (+ head when pinned) picks the candidate cards, each '
    + 'guard\'s `file:line` anchor decides whether it is already covered', () => {
    const tb = tempBacklog();
    try {
      const title = 'File the guard for o/r#1';
      writeFileSync(join(tb.root, 'backlog', 'x1-card.md'),
        `# ${title}\n\nfor o/r#1 (reviewed head \`${HEAD_A}\`)\n\n1. \`we:scripts/a.mjs:12\` — old guard\n`);
      const old = { file: 'scripts/a.mjs', line: 12, prevention: 'reworded old guard', preventionCaptured: false };
      const near = { file: 'scripts/a.mjs', line: 1, prevention: 'a different line', preventionCaptured: false };
      const captured = { file: 'scripts/z.mjs', line: 1, prevention: 'handled', preventionCaptured: true };
      const find = (findings, head, t = title) => findFiledPreventionCard({ title: t }, { root: tb.root, head, findings });
      const card = { num: 'x1', path: 'backlog/x1-card.md' };
      expect(find([old], HEAD_A)).toEqual({ filed: [card], uncovered: [] });
      expect(find([old, near, captured], HEAD_A)).toEqual({ filed: [card], uncovered: [near] });
      expect(find([old], HEAD_B)).toEqual({ filed: [], uncovered: [old] });
      expect(find([old], HEAD_A, 'File the guard for o/r#2')).toEqual({ filed: [], uncovered: [old] });
      expect(find([old], null)).toEqual({ filed: [card], uncovered: [] });
      // a resolved card tracks nothing any more — its guard is owed again (self-review).
      writeFileSync(join(tb.root, 'backlog', 'x1-card.md'),
        `---\nstatus: resolved\n---\n\n# ${title}\n\nfor o/r#1 (reviewed head \`${HEAD_A}\`)\n\n1. \`we:scripts/a.mjs:12\` — old guard\n`);
      expect(find([old], null)).toEqual({ filed: [], uncovered: [old] });
      expect(findFiledPreventionCard({ title }, { root: join(tb.root, 'missing'), findings: [old] }))
        .toEqual({ filed: [], uncovered: [old] });
    } finally {
      tb.cleanup();
    }
  });
});

describe('buildFileItemArgv — the production `file-item` binding\'s argv, pinned against the REAL declaration (PR #2766 advisory)', () => {
  const input = buildPreventionFilingInput({
    repo: 'web-everything/web-everything', pr: 1234, parent: '4075',
    findings: [{ file: NET_PATHS[0], line: 7, prevention: 'add a lint rule', preventionCaptured: false }],
  });

  it('parses cleanly under file-item\'s own declaration, every field landing where the builder put it', () => {
    const parsed = parseOperationArgv(fileItemOperation({ readScaffoldContext: () => ({}) }), buildFileItemArgv(input));
    expect(parsed.errors ?? []).toEqual([]);
    expect(parsed.ok).toBe(true);
    expect(parsed.control.json).toBe(true);
    expect(parsed.input).toMatchObject({
      title: input.title, kind: 'story', digest: input.digest, scope: input.scope, parent: '4075',
    });
    expect(String(parsed.input.size)).toBe('3');
    expect(String(parsed.input.queue)).toBe('true');
  });

  it('omits --parent when none is given, and never forwards the juror --cwd (file-item refuses it)', () => {
    const argv = buildFileItemArgv({ ...input, parent: '' });
    expect(argv.some((a) => a.startsWith('--parent'))).toBe(false);
    expect(argv.some((a) => a.startsWith('--cwd'))).toBe(false);
    expect(parseOperationArgv(fileItemOperation({ readScaffoldContext: () => ({}) }), argv).ok).toBe(true);
    expect(parseOperationArgv(fileItemOperation({ readScaffoldContext: () => ({}) }), [...argv, '--cwd=/some/lane']).ok).toBe(false);
  });
});

describe('runReviewLoopOnce — property 3: a gate-self PR is UNCHANGED', () => {
  it('parks exactly as the human CLI would — declines (wrong actor), files nothing, no accept anywhere', async () => {
    const { declaration, registry } = registryFor({ labels: ['review:human'] });
    const store = createMemoryRunStore();
    let filedCount = 0;
    const out = await runReviewLoopOnce({
      declaration, registry, argv: BASE_ARGV, store, sinks: recordingSinks([]),
      makeJudge: cannedJudge(CLEAN_ANSWER), mintRunId: () => 'r-human',
      appendLearning: () => { filedCount += 1; return { record: {}, path: '' }; },
    });
    expect(out.stopped).toBe('confirm');
    expect(out.run.pending.of).toBe('human');
    expect(out.lines.join('\n')).not.toMatch(/QUEUED/);
    expect(filedCount).toBe(0);
  });
});

describe('runReviewLoopOnce — an explicit --resume --answer still works, exactly like the human CLI', () => {
  it('a human resuming a PARKED review:human run with --answer=changes records it — parking itself is UNCHANGED by #3434', async () => {
    // Uses `changes`, not `accept`: clearing a gate-self PR's own accept has a SEPARATE independence guard
    // (unrelated to #3434, untouched by it) that this synthetic stub reader does not satisfy — out of scope
    // here. The property this test exists to pin is narrower and still holds: `review:human` still parks
    // (wrong actor) exactly as before, and the general `--resume=<id> --answer=<x>` mechanism still works.
    const { declaration, registry } = registryFor({ labels: ['review:human'] });
    const store = createMemoryRunStore();
    const seen = [];
    // BLOCKING_ANSWER (real findings), not CLEAN_ANSWER: `record`'s own reasonless-bounce guard refuses a
    // `changes` answer with zero findings behind it (see review-pr.mjs), which is orthogonal to this test's
    // actual property (that review:human still parks and a resume still clears it) — a zero-finding verdict
    // would trip that unrelated guard on resume regardless of #3434.
    const opened = await runReviewLoopOnce({
      declaration, registry, argv: BASE_ARGV, store, sinks: recordingSinks(seen),
      makeJudge: cannedJudge(BLOCKING_ANSWER), mintRunId: () => 'r-explicit',
    });
    expect(opened.stopped).toBe('confirm'); // parked — wrong actor (human-addressed), unchanged by #3434

    const resumed = await runReviewLoopOnce({
      declaration, registry, argv: ['--resume=r-explicit', '--answer=changes'], store, sinks: recordingSinks(seen),
      makeJudge: cannedJudge(BLOCKING_ANSWER), mintRunId: () => 'unused',
    });
    expect(resumed.stopped).toBe('complete');
    expect(resumed.run.findings.confirm).toBe('changes');
    expect(seen.map((s) => s.type)).toContain(REVIEW_EFFECTS.LABEL);
  });
});

describe('runReviewLoopOnce — parse refusals still work, same as the human CLI', () => {
  it('refuses an unknown flag before starting a run', async () => {
    const { declaration, registry } = registryFor({});
    const store = createMemoryRunStore();
    const out = await runReviewLoopOnce({
      declaration, registry, argv: ['--bogus=1'], store, sinks: {}, makeJudge: () => async () => { throw new Error('never'); }, mintRunId: () => 'unused',
    });
    expect(out.code).toBe(2);
    expect(out.stopped).toBe('refused');
    expect(out.lines.join('\n')).toMatch(/unknown flag --bogus/);
  });

  it('prints --help without starting a run', async () => {
    const { declaration, registry } = registryFor({});
    const store = createMemoryRunStore();
    const out = await runReviewLoopOnce({
      declaration, registry, argv: ['--help'], store, sinks: {}, makeJudge: () => async () => { throw new Error('never'); }, mintRunId: () => 'unused',
    });
    expect(out.code).toBe(0);
    expect(out.stopped).toBe('help');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
// #xu2pp2m — AN UNATTENDED CLEAR MUST NOT SIGN ITSELF `operator`.
//
// MEASURED on the live PR #2122 review: a fully mechanical accept — no human anywhere in it, `attemptedBy:
// 'agent'` already threaded into `driveRun` by this very file — recorded its durable verdict as
// `Recorded by operator.` and its notice as `PR … — human review accepted by operator.`, because `actor` is a
// declared `review-pr` input whose default is `'operator'`. Right for `run.mjs review-pr` (a person at a
// terminal); wrong for every run through THIS entry point.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════

describe('#xu2pp2m — the unattended driver attributes its own clears to an agent', () => {
  it('stamps an AGENT actor on the label + ledger + notice when the caller named nobody', async () => {
    const seen = [];
    const { declaration, registry } = registryFor({});
    const store = createMemoryRunStore();
    const out = await runReviewLoopOnce({
      declaration, registry, argv: BASE_ARGV, store, sinks: recordingSinks(seen),
      makeJudge: cannedJudge(CLEAN_ANSWER), mintRunId: () => 'r-actor-default',
    });
    expect(out.stopped).toBe('complete');
    expect(out.run.input.actor).toBe(UNATTENDED_REVIEW_ACTOR);
    // Every durable surface, not just the run record — the label comment, the verdict ledger row and the
    // operator notice each interpolate `actor` separately.
    const actors = seen.map((e) => e.payload.actor).filter(Boolean);
    expect(actors.length).toBeGreaterThan(0);
    for (const actor of actors) expect(actor).toBe(UNATTENDED_REVIEW_ACTOR);
    // THE REGRESSION, named: this is the string that used to be there, and it must not be.
    for (const actor of actors) expect(actor).not.toBe('operator');
    const notice = seen.find((e) => e.payload.notice)?.payload.notice ?? '';
    expect(notice).not.toMatch(/by operator/);
  });

  it('an EXPLICIT `--actor=` still wins — the human `--resume --answer=accept` ceremony is unchanged', async () => {
    const seen = [];
    const { declaration, registry } = registryFor({});
    const store = createMemoryRunStore();
    const out = await runReviewLoopOnce({
      declaration, registry, argv: [...BASE_ARGV, '--actor=nic'], store, sinks: recordingSinks(seen),
      makeJudge: cannedJudge(CLEAN_ANSWER), mintRunId: () => 'r-actor-explicit',
    });
    expect(out.run.input.actor).toBe('nic');
  });

  it('`applyUnattendedActorDefault` reads RAW argv, because the declaration default has already been applied', () => {
    // The distinction the fix turns on: by the time `parseOperationArgv` returns, `actor: 'operator'` is
    // indistinguishable between "nobody said" and "somebody typed it". Only argv still knows.
    expect(applyUnattendedActorDefault({ actor: 'operator' }, ['--pr=1']).actor).toBe(UNATTENDED_REVIEW_ACTOR);
    expect(applyUnattendedActorDefault({ actor: 'operator' }, ['--actor=operator']).actor).toBe('operator');
    expect(applyUnattendedActorDefault({ actor: 'nic' }, ['--actor', 'nic']).actor).toBe('nic');
  });
});

describe('fileItemForPrevention — the production `fileItem` binding (#2749)', () => {
  const input = {
    title: 'File the prevention guard(s) owed by o/r#1', kind: 'story', size: '3',
    digest: 'the digest', scope: 'we:scripts/a.mjs,we:scripts/__tests__/a.test.mjs', parent: '', queue: 'true',
  };
  const fakeDeps = () => {
    const calls = [];
    const stores = [];
    return {
      calls, stores,
      deps: {
        resolve: (name) => ({ declaration: { name }, registry: 'reg', sinks: {} }),
        run: async (o) => { calls.push(o); return { code: 0, lines: [] }; },
        makeStore: () => { const s = { id: stores.length }; stores.push(s); return s; },
      },
    };
  };

  it('drives the declared `file-item` operation with every input mapped to its own flag, plus --json', async () => {
    const { calls, deps } = fakeDeps();
    await fileItemForPrevention(input, deps);
    expect(calls).toHaveLength(1);
    expect(calls[0].declaration.name).toBe('file-item');
    expect(calls[0].argv).toEqual([
      `--title=${input.title}`, '--kind=story', '--size=3', '--digest=the digest',
      `--scope=${input.scope}`, '--queue=true', '--json',
    ]);
    expect(calls[0].newRunId()).toMatch(/file-item/);
  });

  it('passes --parent only when one is given', async () => {
    const { calls, deps } = fakeDeps();
    await fileItemForPrevention({ ...input, parent: '4075' }, deps);
    expect(calls[0].argv).toContain('--parent=4075');
  });

  it('uses a FRESH run store per call, never a shared one', async () => {
    const { calls, stores, deps } = fakeDeps();
    await fileItemForPrevention(input, deps);
    await fileItemForPrevention(input, deps);
    expect(stores).toHaveLength(2);
    expect(calls[0].store).toBe(stores[0]);
    expect(calls[1].store).toBe(stores[1]);
    expect(calls[0].store).not.toBe(calls[1].store);
  });
});

// #4493 — the review daemon's OWN copy of #4317's orphaned-card bug: `fileItemForPrevention` above writes the
// filed card into `file-item`'s own root, wherever THIS process's checkout is — routinely a read-only clone
// (`~/workspace/wev-review-daemon`) that never commits or pushes. `fileItemForPreventionViaLandingJob` is now
// `runReviewLoopOnce`'s production default instead; these tests pin that it never drives `file-item` in
// process, and that `runReviewLoopOnce`'s own mechanized branch renders the "queued for landing" case correctly.
describe('fileItemForPreventionViaLandingJob — routes through the shared detached landing job (#4493), never '
  + 'file-item in-process', () => {
  const input = {
    title: 'web-everything/web-everything#1234', kind: 'story', size: '3', digest: 'd', scope: 'we:a.mjs', parent: '',
    queue: 'true',
  };

  it('spawns the SAME detached landing job #4317 already uses, tagged with its own sessionPrefix, and '
    + 'synthesizes a `file-item`-shaped queued payload — no real card number yet', async () => {
    const spawnCalls = [];
    const spawnJob = (jobInput, opts) => {
      spawnCalls.push({ jobInput, opts });
      return { ok: true, num: null, rel: null, error: null, handle: 'pid:999', session: 'review-loop-prevention-xyz' };
    };
    const out = await fileItemForPreventionViaLandingJob(input, { spawnJob });
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].jobInput).toBe(input);
    expect(spawnCalls[0].opts).toEqual({ sessionPrefix: 'review-loop-prevention' });
    expect(out.code).toBe(0);
    const payload = JSON.parse(out.lines[0]);
    expect(payload).toEqual({
      verdict: { num: null, rel: null }, queued: true, handle: 'pid:999', session: 'review-loop-prevention-xyz',
    });
  });

  it('a failed spawn reports a non-zero code and the spawn error, never throws', async () => {
    const spawnJob = () => ({ ok: false, num: null, rel: null, error: 'could not spawn the landing job: ENOENT' });
    const out = await fileItemForPreventionViaLandingJob(input, { spawnJob });
    expect(out).toEqual({ code: 1, lines: ['could not spawn the landing job: ENOENT'] });
  });

  it('the shared leaf itself (called directly, stubbing only `spawnDetached`) writes NOTHING into a fixture '
    + '"daemon clone" checkout — the regression #4493 exists to close (the full default-wiring proof, with no '
    + 'layer injected at all, is the separate test below)', () => {
    const root = mkdtempSync(join(tmpdir(), 'review-loop-prevention-daemon-clone-'));
    mkdirSync(join(root, 'backlog'));
    try {
      const before = readdirSync(root, { recursive: true }).sort();
      const spawnCalls = [];
      const spawnDetached = (argv, opts) => { spawnCalls.push({ argv, opts }); return { pid: 4242, on: () => {} }; };
      const result = spawnPreventionLandingJob(input, { spawnDetached, root, logPathFor: () => '/dev/null' });
      expect(readdirSync(root, { recursive: true }).sort()).toEqual(before);
      expect(spawnCalls[0].opts.cwd).toBe(root);
      expect(spawnCalls[0].argv[0]).toMatch(/land-prevention-card\.mjs$/);
      expect(result.ok).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('runReviewLoopOnce — the mechanized branch renders a QUEUED landing job correctly (#4493)', () => {
  const stubViaLandingJob = (handle = 'pid:999', session = 'review-loop-prevention-xyz') => async (i) => (
    fileItemForPreventionViaLandingJob(i, { spawnJob: () => ({ ok: true, handle, session }) })
  );

  it('accepts mechanically on a queued (not-yet-numbered) filing, and says so in plain text', async () => {
    const { declaration, registry } = registryFor({});
    const store = createMemoryRunStore();
    const seen = [];
    const out = await runReviewLoopOnce({
      declaration, registry, argv: BASE_ARGV, store, sinks: recordingSinks(seen),
      makeJudge: cannedJudge(PREVENTION_ANSWER), mintRunId: () => 'r-prevention-queued',
      appendLearning: () => { throw new Error('must not be called — never surfaced to a human'); },
      fileItem: stubViaLandingJob(),
    });
    expect(out.code).toBe(0);
    expect(out.stopped).toBe('complete');
    expect(out.run.findings.confirm).toBe('accept');
    expect(seen.map((s) => s.type)).toContain(REVIEW_EFFECTS.LABEL);
    expect(out.lines.join('\n')).toMatch(/prevention guard\(s\) queued for landing via a lane \(tracking pid:999\)/);
    expect(out.lines.join('\n')).toMatch(/no human was asked/);
    expect(out.lines.join('\n')).not.toMatch(/filed mechanically/);
  });

  it('carries `preventionFiled` with `queued: true` + the handle in --json, num/path both null', async () => {
    const { declaration, registry } = registryFor({});
    const store = createMemoryRunStore();
    const out = await runReviewLoopOnce({
      declaration, registry, argv: [...BASE_ARGV, '--json'], store, sinks: recordingSinks([]),
      makeJudge: cannedJudge(PREVENTION_ANSWER), mintRunId: () => 'r-prevention-queued-json',
      fileItem: stubViaLandingJob('pid:555', 'review-loop-prevention-abc'),
    });
    const payload = JSON.parse(out.lines[0]);
    expect(payload.preventionFiled).toEqual({ num: null, path: null, queued: true, handle: 'pid:555' });
  });

  // #4493 converge round-1 finding (correctness/simplicity/standards-conformance/claim-accuracy, independently):
  // the wiring itself — `runReviewLoopOnce`'s DEFAULT `fileItem`, un-overridden — was the one thing no existing
  // test exercised. NO layer is injected here: `fileItem`, `spawnJob` and `logPathFor`/`resolveSettingsEnv` all
  // resolve to their real production defaults; only `defaultSpawnDetached` (the actual `child_process.spawn`
  // call) is mocked, at the module boundary declared above. This is the regression #4493 exists to close: if
  // `runReviewLoopOnce`'s default ever reverts to `fileItemForPrevention` (the in-process binding), this test
  // reddens because NOTHING would reach `defaultSpawnDetached` at all.
  it('with NO fileItem override anywhere, the real production wiring reaches the shared detached landing job — '
    + 'never `file-item` in process', async () => {
    spawnDetachedCalls.length = 0;
    const { declaration, registry } = registryFor({});
    const store = createMemoryRunStore();
    const seen = [];
    const out = await runReviewLoopOnce({
      declaration, registry, argv: BASE_ARGV, store, sinks: recordingSinks(seen),
      makeJudge: cannedJudge(PREVENTION_ANSWER), mintRunId: () => 'r-prevention-real-default',
      appendLearning: () => { throw new Error('must not be called — never surfaced to a human'); },
      // fileItem intentionally OMITTED — this is the point of the test.
    });
    expect(out.code).toBe(0);
    expect(out.stopped).toBe('complete');
    expect(out.run.findings.confirm).toBe('accept');
    expect(spawnDetachedCalls).toHaveLength(1);
    expect(spawnDetachedCalls[0].argv[0]).toMatch(/land-prevention-card\.mjs$/);
    expect(spawnDetachedCalls[0].argv.some((a) => a.startsWith('--session=review-loop-prevention-'))).toBe(true);
    expect(out.lines.join('\n')).toMatch(/prevention guard\(s\) queued for landing via a lane \(tracking pid:99999\)/);
  });
});

describe('descriptive prevention titles preserve filing identity', () => {
  it('finds a legacy heading and a renamed heading only for the same review, head and guard', () => {
    const root = mkdtempSync(join(tmpdir(), 'prevention-title-'));
    const finding = { file: 'scripts/a.mjs', line: 12, prevention: 'old guard', preventionCaptured: false };
    const title = 'Prevention — old guard (from o/r#1 review)';
    try {
      mkdirSync(join(root, 'backlog'));
      for (const heading of ["File the prevention guard(s) owed by o/r#1's independent review", title]) {
        writeFileSync(join(root, 'backlog', 'x123abc-card.md'),
          `---\nstatus: open\n---\n# ${heading}\n\nreviewed head \`${HEAD_A}\`\n1. \`we:scripts/a.mjs:12\` — old guard\n`);
        expect(findFiledPreventionCard({ title }, { root, head: HEAD_A, findings: [finding] }).filed)
          .toEqual([{ num: 'x123abc', path: 'backlog/x123abc-card.md' }]);
        expect(findFiledPreventionCard({ title: title.replace('#1 review', '#2 review') },
          { root, head: HEAD_A, findings: [finding] }).filed).toEqual([]);
        expect(findFiledPreventionCard({ title }, { root, head: HEAD_B, findings: [finding] }).filed).toEqual([]);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

// ── Cards 5471 / 5470 — a later round the round rules turn into cards: file ONE card, then accept ───────────────────
describe('runReviewLoopOnce — cards 5471/5470: a round past the budget files its findings as a card and accepts', () => {
  const DEGRADED_ANSWER = {
    summary: 'one late, non-broken finding',
    findings: [{ summary: 'a retry message could name the PR', file: NET_PATHS[0], line: 3, disposition: 'blocker', impactIfUnfixed: 'degraded' }],
  };
  const BROKEN_ANSWER = {
    summary: 'one late broken finding',
    findings: [{ summary: 'drops queued work on retry', file: NET_PATHS[0], line: 3, disposition: 'blocker', impactIfUnfixed: 'broken' }],
  };
  const stubFileItem = (calls) => async (input) => { calls.push(input); return { code: 0, lines: [JSON.stringify({ verdict: { num: 7001, rel: 'backlog/7001-review-follow-ups.md' } })] }; };
  const run = async ({ answer, round, budget = 3, json = false, fileItem, liveHead = HEAD_A, liveComments = [] }) => {
    const declaration = reviewPrOperation({ readPr: stubReader({ rev: HEAD_A, extra: { roundBudget: budget, reviewRound: round } }) });
    const registry = createRegistry();
    registry.register(declaration);
    const seen = [];
    // The production default accept policy (clean live referrals required), not the legacy disabled wrapper.
    const out = await driveReviewLoopOnce({
      declaration, registry, argv: [...BASE_ARGV, ...(json ? ['--json'] : [])], store: createMemoryRunStore(), sinks: recordingSinks(seen),
      makeJudge: cannedJudge(answer), mintRunId: () => `r-budget-${round}`, fileItem,
      findFiledRoundCards: () => null, readAcceptancePr: () => ({ headRefOid: liveHead, comments: liveComments }),
    });
    return { out, seen };
  };

  it('round 4 > K=3, only non-broken findings: one card filed, then the SAME run accepts with the reason on record', async () => {
    const calls = [];
    const { out, seen } = await run({ answer: DEGRADED_ANSWER, round: 4, fileItem: stubFileItem(calls) });
    expect(out.code).toBe(0);
    expect(out.stopped).toBe('complete');
    expect(out.run.verdict.verdict).toBe('changes');
    expect(out.run.findings.confirm).toBe('accept');
    expect(out.run.input.reason).toMatch(/^Round budget \(card 5471\): round 4 > K=3/);
    expect(seen.map((s) => s.type)).toContain(REVIEW_EFFECTS.LABEL);
    expect(calls).toHaveLength(1);
    expect(calls[0].title).toBe('Review follow-ups (round-budget, round 4) from web-everything/web-everything#1234');
    expect(calls[0].digest).toMatch(/a retry message could name the PR/);
    expect(out.lines.join('\n')).toMatch(/round-cards: web-everything\/web-everything#1234 round 4 \(round-budget, K=3\): accepted; 2 finding\(s\) carded → backlog\/7001-review-follow-ups\.md/);
  });

  it('a live head that moved since the review parks the round-cards accept before any card is filed', async () => {
    const calls = [];
    const { out, seen } = await run({ answer: DEGRADED_ANSWER, round: 4, fileItem: stubFileItem(calls), liveHead: HEAD_B });
    expect(out.stopped).toBe('confirm');
    expect(out.run.findings.confirm).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(seen.some((s) => s.type === REVIEW_EFFECTS.LABEL)).toBe(false);
    expect(out.lines.join('\n')).toMatch(/Unattended accept parked: live head does not match the reviewed head/);
  });

  it('a head that moves between filing and the accept reports NOT accepted, never a silent no-op accept', async () => {
    const calls = [];
    let reads = 0;
    const declaration = reviewPrOperation({ readPr: stubReader({ rev: HEAD_A, extra: { roundBudget: 3, reviewRound: 4 } }) });
    const registry = createRegistry();
    registry.register(declaration);
    const seen = [];
    const out = await driveReviewLoopOnce({
      declaration, registry, argv: BASE_ARGV, store: createMemoryRunStore(), sinks: recordingSinks(seen),
      makeJudge: cannedJudge(DEGRADED_ANSWER), mintRunId: () => 'r-budget-moved-late', fileItem: stubFileItem(calls),
      findFiledRoundCards: () => null, readAcceptancePr: () => ({ headRefOid: reads++ === 0 ? HEAD_A : HEAD_B, comments: [] }),
    });
    expect(calls).toHaveLength(1);
    expect(out.stopped).toBe('confirm');
    expect(seen.some((s) => s.type === REVIEW_EFFECTS.LABEL)).toBe(false);
    const text = out.lines.join('\n');
    expect(text).toMatch(/NOT accepted; 2 finding\(s\) carded/);
    expect(text).toMatch(/Unattended accept parked after filing: live head does not match the reviewed head/);
  });

  it('a bare --answer=accept on a parked round-cards run cannot accept before its card is filed', async () => {
    const declaration = reviewPrOperation({ readPr: stubReader({ rev: HEAD_A, extra: { roundBudget: 3, reviewRound: 4 } }) });
    const registry = createRegistry();
    registry.register(declaration);
    const store = createMemoryRunStore();
    const readAcceptancePr = () => ({ headRefOid: HEAD_A, comments: [] });
    const parked = await driveReviewLoopOnce({
      declaration, registry, argv: BASE_ARGV, store, sinks: recordingSinks([]), makeJudge: cannedJudge(DEGRADED_ANSWER),
      mintRunId: () => 'r-budget-bare-answer', fileItem: async () => ({ code: 1, lines: ['lane pool exhausted'] }),
      findFiledRoundCards: () => null, readAcceptancePr,
    });
    expect(parked.stopped).toBe('confirm');
    const seen = [];
    const out = await driveReviewLoopOnce({
      declaration, registry, argv: ['--resume=r-budget-bare-answer', '--answer=accept'], store, sinks: recordingSinks(seen),
      makeJudge: cannedJudge(DEGRADED_ANSWER), mintRunId: () => 'unused', fileItem: async () => ({ code: 1, lines: ['still down'] }),
      findFiledRoundCards: () => null, readAcceptancePr,
    });
    expect(out.run.findings.confirm).toBeUndefined();
    expect(seen.some((s) => s.type === REVIEW_EFFECTS.LABEL)).toBe(false);
  });

  it('--json carries roundCardsFiled', async () => {
    const { out } = await run({ answer: DEGRADED_ANSWER, round: 4, json: true, fileItem: stubFileItem([]) });
    const payload = JSON.parse(out.lines[0]);
    expect(payload.roundCardsFiled).toMatchObject({ rule: 'round-budget', round: 4, k: 3, count: 2, num: 7001, path: 'backlog/7001-review-follow-ups.md' });
  });

  it('round 3 (within K) still bounces with changes; no card is filed', async () => {
    const calls = [];
    const { out } = await run({ answer: DEGRADED_ANSWER, round: 3, fileItem: stubFileItem(calls) });
    expect(out.run.findings.confirm).toBe('changes');
    expect(calls).toHaveLength(0);
  });

  it('a broken finding at round 4 still bounces', async () => {
    const calls = [];
    const { out } = await run({ answer: BROKEN_ANSWER, round: 4, fileItem: stubFileItem(calls) });
    expect(out.run.findings.confirm).toBe('changes');
    expect(calls).toHaveLength(0);
  });

  it('a failed filing leaves the run parked, unaccepted, and says so loudly', async () => {
    const { out } = await run({ answer: DEGRADED_ANSWER, round: 4, fileItem: async () => ({ code: 1, lines: ['lane pool exhausted'] }) });
    expect(out.code).toBe(1);
    expect(out.stopped).toBe('confirm');
    expect(out.run.findings.confirm).toBeUndefined();
    expect(out.lines.join('\n')).toMatch(/FAILED to file the round's follow-up card: file-item refused: lane pool exhausted/);
  });
});

// ── PR #4714 review round 1 — the round-card filing identity and its retry guarantee, with the REAL lookup ─────────
describe('findFiledRoundCardsCard — the real lookup against a temp backlog (PR #4714)', () => {
  const finding = (summary, line = 3) => ({ file: NET_PATHS[0], line, summary, verdict: 'PLAUSIBLE', impactIfUnfixed: 'degraded', category: 'correctness/x' });
  const decisionOf = (cards) => ({ rule: 'round-budget', apply: true, round: 4, k: 3, cards });
  const inputOf = (cards, head = HEAD_A) => buildRoundCardsFilingInput({ repo: 'o/r', pr: 7, head, decision: decisionOf(cards) });
  const lookup = (root, cards, head = HEAD_A) => findFiledRoundCardsCard(inputOf(cards, head),
    { root, head, fingerprint: roundCardsFindingsFingerprint(cards) });
  const withBacklog = (body, fn) => {
    const root = mkdtempSync(join(tmpdir(), 'round-cards-'));
    try { mkdirSync(join(root, 'backlog')); body(root); fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
  };
  const write = (root, name, input, status = 'open') =>
    writeFileSync(join(root, 'backlog', name), `---\nstatus: ${status}\n---\n\n# ${input.title}\n\n${input.digest}\n`);
  const A = finding('first finding');
  const B = finding('second finding', 9);

  it('hits a card filed for the same title, head and finding set', () => {
    withBacklog((root) => write(root, 'x1-card.md', inputOf([A, B])), (root) => {
      expect(lookup(root, [A, B])).toEqual({ num: 'x1', path: 'backlog/x1-card.md' });
      expect(lookup(root, [B, A])).toEqual({ num: 'x1', path: 'backlog/x1-card.md' });
    });
  });

  it('misses on another head, on a resolved or closed card, and on a card without the head marker', () => {
    withBacklog((root) => write(root, 'x1-card.md', inputOf([A, B])), (root) => {
      expect(lookup(root, [A, B], HEAD_B)).toBeNull();
    });
    for (const status of ['resolved', 'closed', 'done', 'wontfix', 'superseded']) {
      withBacklog((root) => write(root, 'x1-card.md', inputOf([A, B]), status), (root) => expect(lookup(root, [A, B])).toBeNull());
    }
    withBacklog((root) => write(root, 'x1-card.md', { title: inputOf([A, B]).title, digest: 'no marker here' }), (root) => {
      expect(lookup(root, [A, B])).toBeNull();
    });
  });

  it('still hits when a fresh jury re-words the same findings, and misses when a finding moves to another line', () => {
    withBacklog((root) => write(root, 'x1-card.md', inputOf([A, B])), (root) => {
      expect(lookup(root, [finding('reworded one'), finding('reworded two', 9)])).toEqual({ num: 'x1', path: 'backlog/x1-card.md' });
      expect(lookup(root, [A, finding('second finding', 10)])).toBeNull();
    });
  });

  it('rejects an existing same-head card that omits a current finding (a changed finding set is filed again)', () => {
    withBacklog((root) => write(root, 'x1-card.md', inputOf([A])), (root) => {
      expect(lookup(root, [A])).toEqual({ num: 'x1', path: 'backlog/x1-card.md' });
      expect(lookup(root, [A, B])).toBeNull();
      expect(lookup(root, [B])).toBeNull();
    });
  });
});

describe('runReviewLoopOnce — a retry after a queued round-card filing never files a second card (PR #4714)', () => {
  const DEGRADED = {
    summary: 'one late, non-broken finding',
    findings: [{ summary: 'a retry message could name the PR', file: NET_PATHS[0], line: 3, disposition: 'blocker', impactIfUnfixed: 'degraded' }],
  };
  const CHANGED = {
    summary: 'a changed late finding set',
    findings: [...DEGRADED.findings, { summary: 'a second, new finding', file: NET_PATHS[0], line: 8, disposition: 'blocker', impactIfUnfixed: 'degraded' }],
  };
  const queuedFileItem = (calls) => async (input) => {
    calls.push(input);
    return { code: 0, lines: [JSON.stringify({ queued: true, handle: 'pid:4242' })] };
  };
  const throwingLabelSinks = () => ({
    ...recordingSinks([]),
    [REVIEW_EFFECTS.LABEL]: async () => { throw new Error('gh label edit failed: network error'); },
  });
  const drive = ({ answer, store, sinks, argv = BASE_ARGV, fileItem, id }) => {
    const declaration = reviewPrOperation({ readPr: stubReader({ rev: HEAD_A, extra: { roundBudget: 3, reviewRound: 4 } }) });
    const registry = createRegistry();
    registry.register(declaration);
    return driveReviewLoopOnce({
      declaration, registry, argv, store, sinks, makeJudge: cannedJudge(answer), mintRunId: () => id,
      fileItem, findFiledRoundCards: () => null, readAcceptancePr: () => ({ headRefOid: HEAD_A, comments: [] }),
    });
  };

  it('reuses the queued filing receipt after acceptance fails', async () => {
    const calls = [];
    const store = createMemoryRunStore();
    const first = await drive({ answer: DEGRADED, store, sinks: throwingLabelSinks(), fileItem: queuedFileItem(calls), id: 'review-pr-queued' });
    expect(first.stopped).toBe('effect-halted');
    expect(calls).toHaveLength(1);
    expect(store.read('review-pr-queued').input.roundCardsFiling).toMatchObject({ queued: true, handle: 'pid:4242' });
    // The halted run cannot be resumed (its label swap is not idempotent): the real retry is a FRESH run, new id, same head.
    const second = await drive({ answer: DEGRADED, store, sinks: recordingSinks([]), fileItem: queuedFileItem(calls), id: 'review-pr-queued-2' });
    expect(calls).toHaveLength(1);
    expect(second.code).toBe(0);
    expect(second.stopped).toBe('complete');
    expect(second.run.findings.confirm).toBe('accept');
    expect(second.lines.join('\n')).toMatch(/queued for landing \(pid:4242\).*\(already filed\)/);
    expect(second.run.input.reason).toMatch(/queued for landing \(pid:4242\)/);
  });

  it('a fresh jury that WORDS the same findings differently still reuses the receipt (identity is the cited place, not prose)', async () => {
    const calls = [];
    const store = createMemoryRunStore();
    await drive({ answer: DEGRADED, store, sinks: throwingLabelSinks(), fileItem: queuedFileItem(calls), id: 'review-pr-w1' });
    const reworded = { summary: 'other words', findings: [{ ...DEGRADED.findings[0], summary: 'the retry text should say which PR it concerns' }] };
    const second = await drive({ answer: reworded, store, sinks: recordingSinks([]), fileItem: queuedFileItem(calls), id: 'review-pr-w2' });
    expect(calls).toHaveLength(1);
    expect(second.stopped).toBe('complete');
  });

  it('an expired queued receipt (the landing job never landed) is not trusted: the findings are filed again', async () => {
    const calls = [];
    const store = createMemoryRunStore();
    await drive({ answer: DEGRADED, store, sinks: throwingLabelSinks(), fileItem: queuedFileItem(calls), id: 'review-pr-e1' });
    const later = () => new Date(Date.now() + QUEUED_RECEIPT_TTL_MS + 60_000).toISOString();
    const declaration = reviewPrOperation({ readPr: stubReader({ rev: HEAD_A, extra: { roundBudget: 3, reviewRound: 4 } }) });
    const registry = createRegistry();
    registry.register(declaration);
    await runReviewLoopOnce({
      declaration, registry, argv: BASE_ARGV, store, sinks: recordingSinks([]), makeJudge: cannedJudge(DEGRADED),
      mintRunId: () => 'review-pr-e2', fileItem: queuedFileItem(calls), findFiledRoundCards: () => null, now: later,
    });
    expect(calls).toHaveLength(2);
  });

  it('a retry on a NEW head files its own card (the receipt is keyed by head)', async () => {
    const calls = [];
    const store = createMemoryRunStore();
    await drive({ answer: DEGRADED, store, sinks: throwingLabelSinks(), fileItem: queuedFileItem(calls), id: 'review-pr-h1' });
    const declaration = reviewPrOperation({ readPr: stubReader({ rev: HEAD_B, extra: { roundBudget: 3, reviewRound: 4 } }) });
    const registry = createRegistry();
    registry.register(declaration);
    await runReviewLoopOnce({
      declaration, registry, argv: BASE_ARGV, store, sinks: recordingSinks([]), makeJudge: cannedJudge(DEGRADED),
      mintRunId: () => 'review-pr-h2', fileItem: queuedFileItem(calls), findFiledRoundCards: () => null,
    });
    expect(calls).toHaveLength(2);
  });

  it('a retry whose finding set CHANGED files again instead of reusing the stale receipt', async () => {
    const calls = [];
    const store = createMemoryRunStore();
    await drive({ answer: DEGRADED, store, sinks: throwingLabelSinks(), fileItem: queuedFileItem(calls), id: 'review-pr-q1' });
    await drive({ answer: CHANGED, store, sinks: recordingSinks([]), fileItem: queuedFileItem(calls), id: 'review-pr-q2' });
    expect(calls).toHaveLength(2);
  });

  describe('retainedRoundCardsReceipt — only a receipt for THIS head and finding set answers a retry', () => {
    const NOW = Date.parse('2026-10-09T12:00:00.000Z');
    const good = { head: HEAD_A, fingerprint: 'f'.repeat(16), num: null, path: null, queued: true, handle: 'pid:1', at: new Date(NOW - 60_000).toISOString() };
    const want = { head: HEAD_A, fingerprint: 'f'.repeat(16), nowMs: NOW };
    it('accepts a matching queued or landed receipt', () => {
      expect(retainedRoundCardsReceipt(good, want)).toEqual({ num: null, path: null, queued: true, handle: 'pid:1', at: good.at });
      expect(retainedRoundCardsReceipt({ ...good, queued: false, path: 'backlog/x.md', num: 'x1' }, want))
        .toMatchObject({ path: 'backlog/x.md', num: 'x1', queued: false });
    });
    it.each([
      ['another head', { ...good, head: HEAD_B }],
      ['another finding set', { ...good, fingerprint: '0'.repeat(16) }],
      ['nothing filed (not queued, no path)', { ...good, queued: false }],
      ['a queued receipt past its TTL', { ...good, at: new Date(NOW - QUEUED_RECEIPT_TTL_MS - 1).toISOString() }],
      ['a queued receipt with no timestamp', { ...good, at: undefined }],
      ['a queued receipt dated in the future', { ...good, at: new Date(NOW + 60_000).toISOString() }],
      ['null', null], ['an array', []], ['a string', 'x'],
    ])('rejects %s', (_name, receipt) => {
      expect(retainedRoundCardsReceipt(receipt, want)).toBeNull();
    });
    it('a head-less receipt matches only a head-less retry, and a missing fingerprint never matches', () => {
      expect(retainedRoundCardsReceipt({ ...good, head: null }, { head: null, fingerprint: good.fingerprint, nowMs: NOW })).not.toBeNull();
      expect(retainedRoundCardsReceipt({ ...good, head: null }, want)).toBeNull();
      expect(retainedRoundCardsReceipt(good, { head: HEAD_A, fingerprint: '', nowMs: NOW })).toBeNull();
    });
    it('findRetainedRoundCardsReceipt skips other PRs, other ops, other id prefixes and unreadable records', () => {
      const input = { repo: 'o/r', pr: 7, roundCardsFiling: good };
      const reads = [];
      const flaky = {
        list: () => ['review-pr-a', 'review-pr-b', 'review-pr-c', 'review-pr-d', 'file-item-e', 'r-f'],
        read: (id) => {
          reads.push(id);
          if (id === 'review-pr-a') throw new Error('corrupt');
          return { 'review-pr-b': { op: 'review-pr', input: { ...input, pr: 8 } }, 'review-pr-c': { op: 'other', input },
            'review-pr-d': { op: 'review-pr', input } }[id];
        },
      };
      expect(findRetainedRoundCardsReceipt({ store: flaky, repo: 'o/r', pr: 7, ...want })).toMatchObject({ handle: 'pid:1' });
      expect(reads).not.toContain('file-item-e');
      expect(reads).not.toContain('r-f');
      expect(findRetainedRoundCardsReceipt({ store: flaky, repo: 'o/r', pr: 7, ...want })).toMatchObject({ handle: 'pid:1' });
      expect(findRetainedRoundCardsReceipt({ store: flaky, repo: 'o/r', pr: 9, ...want })).toBeNull();
      expect(findRetainedRoundCardsReceipt({ store: { list: () => { throw new Error('x'); }, read: () => null }, repo: 'o/r', pr: 7, ...want })).toBeNull();
    });
  });
});


describe('unattended acceptance safety boundary', () => {
  // Undeclared impact still requires prevention capture, without a `broken` finding.
  const noBroken = { ...PREVENTION_ANSWER,
    findings: PREVENTION_ANSWER.findings.map(({ impactIfUnfixed, ...f }) => f) };
  it('prevention-outstanding with clean referrals and no broken finding files then accepts', async () => {
    const { declaration, registry } = registryFor({ rev: HEAD_A });
    const seen = [];
    const fileItem = vi.fn(async () => {
      expect(seen.some(s => s.type === REVIEW_EFFECTS.LABEL)).toBe(false);
      return { code: 0, lines: [] };
    });
    const out = await driveReviewLoopOnce({ declaration, registry, argv: BASE_ARGV,
      store: createMemoryRunStore(), sinks: recordingSinks(seen),
      readAcceptancePr: () => ({ headRefOid: HEAD_A, comments: [] }),
      makeJudge: cannedJudge(noBroken), mintRunId: () => 'safety-prevention-clean', fileItem });
    expect(out.run.verdict.verdict).toBe('prevention-outstanding');
    expect(out.stopped).toBe('complete');
    expect(fileItem).toHaveBeenCalledOnce();
    expect(seen.some(s => s.type === REVIEW_EFFECTS.LABEL)).toBe(true);
  });
  it('prevention-outstanding with an unruled broken finding cannot accept', async () => {
    const { declaration, registry } = registryFor({ rev: HEAD_A });
    const seen = [];
    const fileItem = vi.fn();
    const out = await driveReviewLoopOnce({ declaration, registry, argv: BASE_ARGV,
      store: createMemoryRunStore(), sinks: recordingSinks(seen),
      readAcceptancePr: () => ({ headRefOid: HEAD_A, comments: [] }),
      makeJudge: cannedJudge(PREVENTION_ANSWER), mintRunId: () => 'safety-prevention-broken', fileItem });
    expect(out.run.verdict.verdict).toBe('prevention-outstanding');
    expect(out.stopped).toBe('confirm');
    expect(seen.some(s => s.type === REVIEW_EFFECTS.LABEL)).toBe(false);
    expect(fileItem).not.toHaveBeenCalled();
    expect(out.lines.join('\n')).toMatch(/broken finding is not ruled/);
  });
  it.each([['accept', CLEAN_ANSWER], ['prevention-outstanding', noBroken]])
  ('%s on a live head that moved since the review cannot accept or file', async (verdict, answer) => {
    const { declaration, registry } = registryFor({ rev: HEAD_A });
    const seen = [];
    const fileItem = vi.fn(async () => ({ code: 0, lines: [] }));
    const out = await driveReviewLoopOnce({ declaration, registry, argv: BASE_ARGV,
      store: createMemoryRunStore(), sinks: recordingSinks(seen),
      readAcceptancePr: () => ({ headRefOid: HEAD_B, comments: [] }),
      makeJudge: cannedJudge(answer), mintRunId: () => `safety-moved-${verdict}`, fileItem });
    expect(out.run.verdict.verdict).toBe(verdict);
    expect(out.stopped).toBe('confirm');
    expect(seen.some(s => s.type === REVIEW_EFFECTS.LABEL)).toBe(false);
    expect(fileItem).not.toHaveBeenCalled();
    expect(out.lines.join('\n')).toMatch(/Unattended accept parked: live head does not match the reviewed head/);
  });
  it('a head that moves between filing and the accept says the accept was held, never that it happened', async () => {
    const { declaration, registry } = registryFor({ rev: HEAD_A });
    const seen = [];
    let reads = 0;
    const fileItem = vi.fn(async () => ({ code: 0, lines: [] }));
    const out = await driveReviewLoopOnce({ declaration, registry, argv: BASE_ARGV,
      store: createMemoryRunStore(), sinks: recordingSinks(seen),
      readAcceptancePr: () => ({ headRefOid: reads++ === 0 ? HEAD_A : HEAD_B, comments: [] }),
      makeJudge: cannedJudge(noBroken), mintRunId: () => 'safety-prevention-moved-late', fileItem });
    expect(fileItem).toHaveBeenCalledOnce();
    expect(out.stopped).toBe('confirm');
    expect(seen.some(s => s.type === REVIEW_EFFECTS.LABEL)).toBe(false);
    expect(out.lines.join('\n')).toMatch(/Unattended accept parked after filing: live head does not match the reviewed head/);
  });
});


describe('unattended accept reads the live head', () => {
  const repo = 'web-everything/web-everything';
  const original = { file: NET_PATHS[0], line: 7, summary: 'launch guard missing', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
  const seat = 'judge';
  const key = referralFindingKey(seat, original);
  const record = { version: 1, repo, pr: 1234, head: HEAD_A, runId: 'referred-run',
    reviewer: mandatoryReferralReviewer('referred-run'), authorBody: '<!-- authored-by-actor: author -->',
    attempted: true, referrals: [{ key, seat, original, finding: normalizeFinding(original) }], rulings: [] };
  const comment = (body, login = 'web-everything') => ({ body, author: { login } });
  it.each(['accept', 'prevention-outstanding'].flatMap(verdict =>
    [null, 'auto-policy', 'card', 'not-real'].map(result => [verdict, result])))
  ('%s with live referral ruling %s gates the actual accept effects', async (verdict, result) => {
    const comments = [comment(renderReferralRecord(record))];
    // The policy ruling is posted by automation; an operator's clearing ruling by that operator (PR #6529: an
    // unstamped automation copy posted after poster stamping shipped keeps only its block rows).
    if (result) comments.push(comment(buildOperatorRulingComment({ version: 1, repo, pr: 1234, head: HEAD_A,
      actor: result === 'auto-policy' ? 'auto-policy' : 'chalbert', channel: 'operator-chat', reason: 'checked the finding', at: '2026-10-15T15:45:00Z', clearerId: 'operator-session',
      rulings: [{ runId: record.runId, key, result: result === 'auto-policy' ? 'block' : result, ...(result === 'card' ? { card: 'we:backlog/7-follow-up.md' } : {}) }] }),
      result === 'auto-policy' ? 'web-everything' : 'chalbert'));
    const { declaration, registry } = registryFor({ rev: HEAD_A });
    const seen = [];
    const readAcceptancePr = vi.fn(() => ({ headRefOid: HEAD_A, body: record.authorBody, comments }));
    const fileItem = vi.fn(async () => ({ code: 0, lines: [] }));
    const answer = verdict === 'accept' ? CLEAN_ANSWER : {
      ...PREVENTION_ANSWER, findings: PREVENTION_ANSWER.findings.map(({ impactIfUnfixed, ...f }) => f),
    };
    const out = await driveReviewLoopOnce({ declaration, registry, argv: BASE_ARGV,
      store: createMemoryRunStore(), sinks: recordingSinks(seen), readAcceptancePr, cardReadable: () => true,
      fileItem, makeJudge: cannedJudge(answer), mintRunId: () => `safety-${verdict}-${result}` });
    const cleared = ['card', 'not-real'].includes(result);
    expect(out.run.verdict.verdict).toBe(verdict);
    expect(readAcceptancePr).toHaveBeenCalled();
    expect(out.stopped).toBe(cleared ? 'complete' : 'confirm');
    expect(seen.some(s => s.type === REVIEW_EFFECTS.LABEL)).toBe(cleared);
    expect(fileItem).toHaveBeenCalledTimes(verdict === 'prevention-outstanding' && cleared ? 1 : 0);
    if (!cleared) expect(out.lines.join('\n')).toMatch(/mandatory referrals remain open/);
  });
});


describe('post-accept advisory shadow wiring', () => {
  it.each(['CONFIRMED', 'PLAUSIBLE', 'writer-error', 'logger-error'])(
    'CLI records later %s broken ratings and preserves off/shadow/on live effects', async scenario => {
      const execute = async mode => {
        const rows = [], effects = [], outcomes = [], logs = [];
        const io = { readLedgerRows: () => structuredClone(rows),
          appendLedgerRow: row => { rows.push(structuredClone(row)); return { ok: true }; } };
        const store = createMemoryRunStore();
        const review = async (head, id, later) => {
          const { declaration, registry } = registryFor({ rev: head });
          const out = await runReviewLoopOnce({ declaration, registry, argv: BASE_ARGV, store,
            sinks: recordingSinks(effects), mintRunId: () => id,
            makeJudge: () => async request => judgeOutcome(request.lens === 'correctness' ? {
              summary: 'review', findings: [{ file: NET_PATHS[0], line: 4,
                summary: later ? 'a fresh description of the defect' : 'improve diagnostic',
                disposition: later ? 'bug' : 'nit', category: 'correctness/correctness',
                verdict: scenario === 'PLAUSIBLE' ? 'PLAUSIBLE' : 'CONFIRMED',
                introduced: true, worseThanBase: true, parallelizable: true,
                impactIfUnfixed: later ? 'broken' : 'cosmetic' }],
            } : CLEAN_ANSWER, {}),
            advisorySettings: () => ({ value: { mode } }),
            recordAdvisoryShadow: facts => recordPostAcceptAdvisoryShadow({ ...facts, ...io }),
            recordAdvisoryLoops: facts => recordPostAcceptAdvisoryLoops({ ...facts, ...io }),
            recordAdvisoryRating: facts => {
              if (later && scenario.endsWith('error')) throw new Error('rating writer unavailable\n');
              return recordPostAcceptAdvisoryRating({ ...facts, ...io });
            },
            advisoryLog: line => { logs.push(line); if (scenario === 'logger-error') throw new Error('logger unavailable'); },
          });
          outcomes.push({ code: out.code, stopped: out.stopped, lines: out.lines, verdict: out.run.verdict });
          return out;
        };
        const accepted = await review(HEAD_A, 'cosmetic-accept', false);
        expect(accepted.run.findings.confirm).toBe('accept');
        if (mode !== 'off') expect(rows.find(row => row.wouldCard)).toMatchObject({
          findings: [expect.objectContaining({ impactIfUnfixed: 'cosmetic' })],
        });
        await review(HEAD_B, 'broken-review', true);
        const beforeReplay = structuredClone(rows);
        await review(HEAD_B, 'broken-review', true);
        expect(rows).toEqual(beforeReplay);
        return { effects, outcomes, rows, logs };
      };
      const baseline = await execute('off');
      expect(baseline.rows).toEqual([]);
      for (const mode of ['shadow', 'on']) {
        const result = await execute(mode);
        expect(result.effects).toEqual(baseline.effects);
        expect(result.outcomes).toEqual(baseline.outcomes);
        expect(postAcceptAdvisoryShadowReport(result.rows)).toMatchObject({
          wouldCard: 1, findings: 1, loopsAfter: 1,
          laterBroken: scenario === 'CONFIRMED' ? 1 : 0,
          unconfirmedBroken: scenario === 'PLAUSIBLE' ? 1 : 0, skipped: 0, unresolved: 0,
        });
        expect(result.rows.filter(row => row.kind === 'advisory-rating')).toHaveLength(scenario.endsWith('error') ? 0 : 1);
        if (scenario.endsWith('error')) expect(result.logs.join('\n')).toContain('live review unaffected');
      }
    });

  it.each([null, {}, { value: [] }, { value: { mode: undefined } },
    { value: { mode: 'off' }, invalid: true }, { value: { mode: 'off' }, invalid: 'false' }])(
    'fails closed on malformed resolved settings %j while preserving a completed accept', async settings => {
      const { declaration, registry } = registryFor({ rev: HEAD_A });
      const decisions = [], logs = [];
      const out = await runReviewLoopOnce({ declaration, registry, argv: BASE_ARGV,
        store: createMemoryRunStore(), sinks: recordingSinks([]), makeJudge: cannedJudge(CLEAN_ANSWER),
        mintRunId: () => 'malformed-settings', advisorySettings: () => settings,
        recordAdvisoryLoops: async () => null,
        recordAdvisoryShadow: facts => { decisions.push(facts.decision); }, advisoryLog: line => logs.push(line),
      });
      expect(out.code).toBe(0);
      expect(out.stopped).toBe('complete');
      expect(out.run.findings.confirm).toBe('accept');
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({ wouldPush: true, wouldCard: false, reason: 'invalid-mode' });
      expect(logs.join('\n')).toContain('invalid resolved settings; using shadow');
    });

  it.each(['shadow', 'on', 'recorder-error', 'logging-error'])(
    '%s measures later review runs once per run ID and preserves mode-off live effects', async scenario => {
      const execute = async mode => {
        const rows = [], effects = [], outcomes = [], logs = [];
        const io = { readLedgerRows: () => structuredClone(rows),
          appendLedgerRow: row => { rows.push(structuredClone(row)); return { ok: true }; } };
        const store = createMemoryRunStore();
        const review = async (rev, id, answer = CLEAN_ANSWER) => {
          const { declaration, registry } = registryFor({ rev });
          const out = await runReviewLoopOnce({ declaration, registry, argv: BASE_ARGV, store,
            sinks: recordingSinks(effects), makeJudge: cannedJudge(answer), mintRunId: () => id,
            advisorySettings: () => ({ value: { mode: mode === 'off' ? 'off' : mode === 'on' ? 'on' : 'shadow' } }),
            recordAdvisoryShadow: facts => recordPostAcceptAdvisoryShadow({ ...facts, ...io }),
            recordAdvisoryLoops: facts => {
              if (facts.head !== HEAD_A && (mode === 'recorder-error' || mode === 'logging-error')) throw new Error('loops ledger unavailable');
              return recordPostAcceptAdvisoryLoops({ ...facts, ...io });
            },
            advisoryLog: line => { logs.push(line); if (mode === 'logging-error') throw new Error('logger failed'); },
          });
          outcomes.push({ code: out.code, stopped: out.stopped, lines: out.lines, verdict: out.run.verdict });
          return out;
        };
        // An actual accepted earlier head, followed by later reviews that need not accept.
        await review(HEAD_A, 'accepted');
        if (mode !== 'off') {
          expect(rows).toHaveLength(2);
          expect(rows[0]).toMatchObject({ kind: 'advisory-run', headSha: HEAD_A, runId: 'accepted' });
          expect(rows[1]).toMatchObject({ headSha: HEAD_A, loopsAfter: null });
        }
        await review(HEAD_B, 'later-1', BLOCKING_ANSWER);
        if (['shadow', 'on'].includes(mode)) expect(rows.filter(row => row.kind === 'loops'))
          .toMatchObject([{ headSha: HEAD_A, loopsAfter: 1, runId: 'later-1' }]);
        await review(HEAD_B, 'later-1', BLOCKING_ANSWER);
        if (['shadow', 'on'].includes(mode)) expect(rows.filter(row => row.kind === 'loops')).toHaveLength(1);
        await review(HEAD_B, 'later-2', BLOCKING_ANSWER);
        return { rows, effects, outcomes, logs };
      };
      const baseline = await execute('off');
      const result = await execute(scenario);
      expect(result.effects).toEqual(baseline.effects);
      expect(result.outcomes).toEqual(baseline.outcomes);
      if (['shadow', 'on'].includes(scenario)) expect(result.rows.filter(row => row.kind === 'loops'))
        .toMatchObject([{ headSha: HEAD_A, loopsAfter: 1, runId: 'later-1' }, { headSha: HEAD_A, loopsAfter: 2, runId: 'later-2' }]);
      else expect(result.logs.join('\n')).toContain('live review unaffected');
    });

  it('normalization-poisoned rows from another PR preserve live effects and recording across replay', async () => {
    const rows = [{ kind: 'we.post-accept-advisory-shadow', repo: 'web-everything/web-everything', pr: 9999,
      headSha: 'poison', wouldCard: true, wouldPush: false, loopsAfter: null,
      findings: [{ category: 'correctness/correctness', summary: 'poison', impactIfUnfixed: 'cosmetic',
        rootCause: { toString: null } }] }];
    const logs = [], effects = [], store = createMemoryRunStore();
    const io = { readLedgerRows: () => rows,
      appendLedgerRow: row => { rows.push(row); return { ok: true }; }, out: line => logs.push(line) };
    const review = async (rev, id) => {
      const { declaration, registry } = registryFor({ rev });
      const out = await runReviewLoopOnce({ declaration, registry, argv: BASE_ARGV, store,
        sinks: recordingSinks(effects), makeJudge: cannedJudge(CLEAN_ANSWER), mintRunId: () => id,
        advisorySettings: () => ({ value: { mode: 'shadow' } }), advisoryLog: line => logs.push(line),
        recordAdvisoryShadow: facts => recordPostAcceptAdvisoryShadow({ ...facts, ...io }),
        recordAdvisoryLoops: facts => recordPostAcceptAdvisoryLoops({ ...facts, ...io }),
        recordAdvisoryRating: facts => recordPostAcceptAdvisoryRating({ ...facts, ...io }),
      });
      expect(out.code).toBe(0);
      expect(out.stopped).toBe('complete');
      expect(out.run.findings.confirm).toBe('accept');
    };
    await review(HEAD_A, 'safe-A');
    const firstCount = effects.length;
    await review(HEAD_B, 'safe-B');
    const before = structuredClone(rows), applied = structuredClone(effects);
    const secondEffects = applied.slice(firstCount);
    expect(secondEffects.length).toBeGreaterThan(0);
    await review(HEAD_B, 'safe-B');
    expect(rows).toEqual(before);
    expect(effects.slice(applied.length)).toEqual(secondEffects);
    expect(rows.filter(row => row.kind === 'loops')).toMatchObject([{ headSha: HEAD_A, loopsAfter: 1 }]);
    expect(rows.filter(row => row.kind === 'we.post-accept-advisory-shadow')).toHaveLength(3);
    expect(postAcceptAdvisoryShadowReport(rows)).toMatchObject({
      prs: 1, wouldPush: 2, loopsAfter: 1, skipped: 1, unresolved: 1,
    });
    expect(logs).toEqual([]);
  });

  it('corrupt persisted loops refuse telemetry on both heads while the live review still completes', async () => {
    const rows = [{ kind: 'we.post-accept-advisory-shadow', repo: 'web-everything/web-everything', pr: 1234, headSha: HEAD_A,
      wouldCard: false, wouldPush: true, findings: [], loopsAfter: null },
    { kind: 'loops', repo: 'web-everything/web-everything', pr: 1234, headSha: HEAD_A, runId: 'R', loopsAfter: 99 }];
    const before = structuredClone(rows), logs = [];
    for (const rev of [HEAD_A, HEAD_B]) {
      const { declaration, registry } = registryFor({ rev });
      const io = { readLedgerRows: () => structuredClone(rows),
        appendLedgerRow: row => { rows.push(structuredClone(row)); return { ok: true }; } };
      const out = await runReviewLoopOnce({ declaration, registry, argv: BASE_ARGV, store: createMemoryRunStore(),
        sinks: recordingSinks([]), makeJudge: cannedJudge(CLEAN_ANSWER), mintRunId: () => 'R',
        advisorySettings: () => ({ value: { mode: 'shadow' } }), advisoryLog: line => logs.push(line),
        recordAdvisoryShadow: facts => recordPostAcceptAdvisoryShadow({ ...facts, ...io }),
        recordAdvisoryLoops: facts => recordPostAcceptAdvisoryLoops({ ...facts, ...io }),
      });
      expect(out.code).toBe(0);
      expect(out.stopped).toBe('complete');
      expect(out.run.findings.confirm).toBe('accept');
      expect(rows).toEqual(before);
    }
    expect(logs.filter(line => line.includes('invalid loop history; inspect shadow ledger'))).toHaveLength(4);
  });

  it('replaying accepted run A after accepted run B never counts A against B', async () => {
    const rows = [], store = createMemoryRunStore();
    const io = { readLedgerRows: () => structuredClone(rows),
      appendLedgerRow: row => { rows.push(structuredClone(row)); return { ok: true }; } };
    const review = async (rev, id) => {
      const { declaration, registry } = registryFor({ rev });
      const out = await runReviewLoopOnce({ declaration, registry, argv: BASE_ARGV, store,
        sinks: recordingSinks([]), makeJudge: cannedJudge(CLEAN_ANSWER), mintRunId: () => id,
        advisorySettings: () => ({ value: { mode: 'shadow' } }), advisoryLog: () => {},
        recordAdvisoryShadow: facts => recordPostAcceptAdvisoryShadow({ ...facts, ...io }),
        recordAdvisoryLoops: facts => recordPostAcceptAdvisoryLoops({ ...facts, ...io }),
      });
      expect(out.code).toBe(0);
      expect(out.stopped).toBe('complete');
      expect(out.run.findings.confirm).toBe('accept');
    };
    await review(HEAD_A, 'accept-A');
    await review(HEAD_B, 'accept-B');
    const before = structuredClone(rows);
    await review(HEAD_A, 'accept-A');
    expect(rows).toEqual(before);
    expect(rows.filter(row => row.kind === 'loops')).toMatchObject([
      { headSha: HEAD_A, runId: 'accept-B', loopsAfter: 1 },
    ]);
  });

  it.each(['shadow', 'on', 'invalid-settings', 'settings-error', 'recorder-error'])(
    '%s preserves all live effects for an advisory-bearing would-card accept', async scenario => {
      const execute = async mode => {
        const { declaration, registry } = registryFor({ rev: HEAD_A });
        const effects = [], rows = [], decisions = [];
        const fileItem = vi.fn(async () => ({ code: 0, lines: [] }));
        const out = await runReviewLoopOnce({ declaration, registry, argv: BASE_ARGV,
          store: createMemoryRunStore(), sinks: recordingSinks(effects), fileItem,
          makeJudge: () => async request => judgeOutcome(request.lens === 'correctness' ? { summary: 'advisory only', findings: [{ file: NET_PATHS[0], line: 4,
            summary: 'improve diagnostic', disposition: 'nit', category: 'correctness/correctness',
            introduced: true, worseThanBase: true, parallelizable: true,
            impactIfUnfixed: 'cosmetic' }] } : CLEAN_ANSWER, {}), mintRunId: () => 'r-advisory-effects',
          advisorySettings: () => {
            if (mode === 'settings-error') throw new Error('settings unavailable');
            return { value: { mode: ['off', 'on'].includes(mode) ? mode : 'shadow' }, invalid: mode === 'invalid-settings' };
          },
          recordAdvisoryShadow: facts => {
            decisions.push(facts.decision);
            if (mode === 'recorder-error') throw new Error('ledger unavailable');
            return recordPostAcceptAdvisoryShadow({ ...facts, readLedgerRows: () => rows,
              appendLedgerRow: row => { rows.push(row); return { ok: true }; } });
          }, advisoryLog: () => {},
        });
        return { out, effects, rows, decisions, filings: fileItem.mock.calls };
      };
      const baseline = await execute('off');
      const result = await execute(scenario);
      expect(result.out.code).toBe(0);
      expect(result.out.stopped).toBe('complete');
      expect(result.out.run.findings.confirm).toBe('accept');
      expect(result.out.run.verdict).toEqual(baseline.out.run.verdict);
      expect(result.out.lines).toEqual(baseline.out.lines);
      expect(result.effects).toEqual(baseline.effects);
      expect(result.filings).toEqual(baseline.filings);
      expect(baseline.rows).toHaveLength(0);
      expect(result.rows).toHaveLength(['shadow', 'on', 'invalid-settings'].includes(scenario) ? 1 : 0);
      if (scenario !== 'settings-error') expect(result.decisions[0]).toMatchObject({
        wouldCard: scenario !== 'invalid-settings', wouldPush: scenario === 'invalid-settings',
      });
      if (result.rows.length) expect(result.rows.find(row => row.kind === 'we.post-accept-advisory-shadow').loopsAfter).toBeNull();
    });

  it.each(['off', 'shadow', 'on'])('%s preserves acceptance and effects, recording only when enabled', async mode => {
    const execute = async currentMode => {
      const { declaration, registry } = registryFor({ rev: HEAD_A });
      const rows = [];
      const effects = [];
      const fileItem = vi.fn(() => { throw new Error('shadow must not file'); });
      const out = await runReviewLoopOnce({ declaration, registry, argv: BASE_ARGV,
        store: createMemoryRunStore(), sinks: recordingSinks(effects),
        makeJudge: cannedJudge(CLEAN_ANSWER), mintRunId: () => 'r-advisory-shadow', fileItem,
        advisorySettings: () => ({ value: { mode: currentMode } }),
        recordAdvisoryShadow: facts => recordPostAcceptAdvisoryShadow({ ...facts,
          readLedgerRows: () => rows, appendLedgerRow: row => { rows.push(row); return { ok: true }; } }),
      });
      expect(fileItem).not.toHaveBeenCalled();
      return { out, rows, effects };
    };
    const baseline = await execute('off');
    const result = await execute(mode);
    expect(result.out.code).toBe(0);
    expect(result.out.stopped).toBe('complete');
    expect(result.out.run.findings.confirm).toBe('accept');
    expect(result.out.lines).toEqual(baseline.out.lines);
    expect(result.effects.map(effect => effect.type)).toEqual(baseline.effects.map(effect => effect.type));
    expect(result.effects.filter(effect => effect.type === REVIEW_EFFECTS.LABEL))
      .toEqual(baseline.effects.filter(effect => effect.type === REVIEW_EFFECTS.LABEL));
    expect(result.rows).toHaveLength(mode === 'off' ? 0 : 1);
    if (mode !== 'off') expect(result.rows.find(row => row.kind === 'we.post-accept-advisory-shadow')).toMatchObject({ pr: 1234, headSha: HEAD_A, wouldPush: true });
  });

  it.each(['settings', 'ledger', 'logging'])('%s failure never changes a completed accept', async failure => {
    const { declaration, registry } = registryFor({ rev: HEAD_A });
    const log = vi.fn(() => { if (failure === 'logging') throw new Error('logger failed'); });
    const out = await runReviewLoopOnce({ declaration, registry, argv: BASE_ARGV,
      store: createMemoryRunStore(), sinks: recordingSinks([]),
      makeJudge: cannedJudge(CLEAN_ANSWER), mintRunId: () => 'r-advisory-error',
      advisorySettings: () => { if (failure === 'settings') throw new Error('unreadable'); return { value: { mode: 'shadow' } }; },
      recordAdvisoryShadow: () => { throw new Error('ledger unavailable'); }, advisoryLog: log,
    });
    expect(out.code).toBe(0);
    expect(out.stopped).toBe('complete');
    expect(out.run.findings.confirm).toBe('accept');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('live review unaffected'));
  });
});


describe('CI-held record driver resume', () => {
  async function fixture(max = 3, { answer = CLEAN_ANSWER, ...overrides } = {}) {
    const declaration = reviewPrOperation({ readPr: input => {
      const view = stubReader({ rev: HEAD_A })(input);
      return { ...view, body: '<!-- authored-by-actor: author -->' };
    } });
    const registry = createRegistry(); registry.register(declaration);
    const store = createMemoryRunStore(), seen = [];
    const judge = vi.fn(async () => judgeOutcome(answer, {}));
    let time = 0;
    const publishGate = vi.fn(() => ({ allowed: false, headSha: HEAD_A, reason: 'required-checks-not-successful' }));
    const runNode = vi.fn(() => { throw Error('CI pending must prevent publication'); });
    const timingEnv = { WE_REVIEW_START_EARLY: 'on', WE_REVIEW_START_EARLY_PUBLISH_WAIT_MS: '1', WE_REVIEW_START_EARLY_POLL_MS: '1' };
    const root = mkdtempSync(join(tmpdir(), 'ci-held-resume-'));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    const label = createReviewPrSinks({
      root, runStore: store, env: timingEnv,
      labelProvider: { readPrState: () => ({ comments: [] }) }, postRedTeamCheckRun: async () => ({ ok: true }), out: () => {},
      publishGate, readPublishHead: () => HEAD_A, now: () => time, sleep: async ms => { time += ms; }, runNode,
    })[REVIEW_EFFECTS.LABEL];
    const sinks = { ...recordingSinks(seen), [REVIEW_EFFECTS.LABEL]: label };
    const env = { WE_REVIEW_RED_TEAM_ON_SKIP_CI_HELD_RECORD_RETRY_MAX: String(max) };
    const find = input => defaultFindResumableRun(input, { env,
      readPr: () => ({ headRefOid: HEAD_A, comments: [] }),
      readRuns: () => [reviewRunEvidence(store.read('ci-held-original'))],
    });
    const args = { declaration, registry, store, sinks, argv: [...BASE_ARGV, '--json'], makeJudge: () => judge,
      mintRunId: () => 'ci-held-original', redTeamOnSkipSettings: () => ({ value: { ciHeldRecordRetryMax: max } }),
      readAcceptancePr: () => ({ headRefOid: HEAD_A, body: '<!-- authored-by-actor: author -->', comments: [] }),
      ...overrides,
    };
    await runReviewLoopOnce(args);
    const saved = store.read('ci-held-original');
    expect(saved.pending).toMatchObject({ kind: 'effect', step: 'record' });
    expect(saved.effects.find(e => e.type === REVIEW_EFFECTS.LABEL)).toMatchObject({ status: 'failed', unknownAttempts: 1,
      error: 'review held: CI still pending on reviewed head' });
    return { args, store, saved, judge, seen, publishGate, runNode, find, timingEnv };
  }

  it.each(['automatic', 'explicit'].flatMap(mode => ['card', 'not-real'].flatMap(result =>
    [false, true].map(cleared => [mode, result, cleared]))))(
    '%s prevention-outstanding CI-held resume rechecks live %s clearance (still holds=%s)', async (mode, result, cleared) => {
      const repo = BASE_ARGV[1].slice(7);
      const original = { file: NET_PATHS[0], line: 7, summary: 'launch guard missing', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
      const seat = 'judge', key = referralFindingKey(seat, original);
      const record = { version: 1, repo, pr: 1234, head: HEAD_A, runId: 'referred-run',
        reviewer: mandatoryReferralReviewer('referred-run'), authorBody: '<!-- authored-by-actor: author -->',
        attempted: true, referrals: [{ key, seat, original, finding: normalizeFinding(original) }], rulings: [] };
      const comments = [{ body: renderReferralRecord(record), author: { login: 'web-everything' } },
        { body: buildOperatorRulingComment({ version: 1, repo, pr: 1234, head: HEAD_A,
          actor: 'chalbert', channel: 'operator-chat', reason: 'checked the finding', at: '2026-10-15T15:45:00Z', clearerId: 'operator-session',
          rulings: [{ runId: record.runId, key, result, ...(result === 'card' ? { card: 'we:backlog/7-follow-up.md' } : {}) }] }),
        author: { login: 'chalbert' } }];
      let cardExists = true;
      const readAcceptancePr = vi.fn(() => ({ headRefOid: HEAD_A, body: record.authorBody, comments }));
      const fileItem = vi.fn(async () => ({ code: 0, lines: [] }));
      const f = await fixture(3, {
        answer: { ...PREVENTION_ANSWER, findings: PREVENTION_ANSWER.findings.map(({ impactIfUnfixed, ...finding }) => finding) },
        acceptPolicy: { value: { unattendedAcceptRequiresCleanReferrals: true } },
        readAcceptancePr, cardReadable: () => cardExists, fileItem,
      });
      expect(f.saved.verdict.verdict).toBe('prevention-outstanding');
      expect(f.saved.findings.confirm).toBe('accept');
      expect(fileItem).toHaveBeenCalledOnce();
      if (!cleared) {
        if (result === 'card') cardExists = false;
        else comments.pop();
      }
      const judges = f.judge.mock.calls.length, writes = f.seen.length, checks = f.publishGate.mock.calls.length;
      readAcceptancePr.mockClear();
      const out = await runReviewLoopOnce({ ...f.args, findResumableRun: f.find,
        ...(mode === 'explicit' ? { argv: [`--resume=${f.saved.id}`, '--json'] } : {}),
        mintRunId: () => { throw Error('fresh panel'); } });
      expect(readAcceptancePr).toHaveBeenCalled();
      expect(out.run.id).toBe(f.saved.id);
      expect(f.judge).toHaveBeenCalledTimes(judges);
      expect(f.seen).toHaveLength(writes);
      expect(fileItem).toHaveBeenCalledOnce();
      expect(f.runNode).not.toHaveBeenCalled();
      if (cleared) {
        expect(out.stopped).toBe('effect-halted');
        expect(out.run.resumedAt).toBeTruthy();
        expect(out.run.recordEffectResumeAttempts).toBe(1);
        expect(out.run.cursor).toBe(f.saved.cursor);
        expect(out.run.effects.find(e => e.type === REVIEW_EFFECTS.LABEL)).toMatchObject({ status: 'failed', unknownAttempts: 2 });
        expect(f.publishGate.mock.calls.length).toBeGreaterThan(checks);
      } else {
        expect(out).toMatchObject({ code: 2, stopped: 'refused', run: f.saved });
        expect(out.lines.join(' ')).toMatch(/unattended accept held: mandatory referrals remain open/);
        expect(f.store.read(f.saved.id)).toEqual(f.saved);
        expect(f.publishGate).toHaveBeenCalledTimes(checks);
      }
    });

  it.each(['automatic', 'explicit'])('%s resume keeps a CI-held label swap held after timing settings change, then applies on green without a fresh panel', async mode => {
    const f = await fixture();
    if (mode === 'explicit') f.args.argv = [`--resume=${f.saved.id}`, '--json'];
    Object.assign(f.timingEnv, { WE_REVIEW_START_EARLY: 'off', WE_REVIEW_START_AFTER: 'ci-green', WE_REVIEW_CANCEL_ON_CI_RED: 'false' });
    // The default lookup resolves the environment setting when no driver override is supplied.
    expect(f.find({ repo: BASE_ARGV[1].slice(7), pr: 1234 })).toBe(f.saved.id);
    const judges = f.judge.mock.calls.length, writes = f.seen.length, checks = f.publishGate.mock.calls.length;
    const out = await runReviewLoopOnce({ ...f.args, findResumableRun: f.find, mintRunId: () => { throw Error('fresh panel'); } });
    expect(out.run.id).toBe(f.saved.id);
    expect(out.run.cursor).toBe(f.saved.cursor);
    expect(out.run.resumedAt).toBeTruthy();
    expect(out.run.recordEffectResumeAttempts).toBe(1);
    expect(out.run.resumeOf).toBeUndefined();
    expect(out.run.effects.find(e => e.type === REVIEW_EFFECTS.LABEL)).toMatchObject({ status: 'failed', unknownAttempts: 2 });
    expect(f.publishGate.mock.calls.length).toBeGreaterThan(checks);
    expect(f.runNode).not.toHaveBeenCalled();
    expect(f.judge).toHaveBeenCalledTimes(judges);
    expect(f.seen).toHaveLength(writes);
    expect(out.stopped).toBe('effect-halted');
    expect(out.run.effects.find(e => e.type === REVIEW_EFFECTS.LABEL).error).toBe('review held: CI still pending on reviewed head');
    f.publishGate.mockReturnValue({ allowed: true, headSha: HEAD_A, reason: 'required-checks-successful' });
    f.runNode.mockReturnValue('{"ok":true}');
    const green = await runReviewLoopOnce({ ...f.args, findResumableRun: f.find, mintRunId: () => { throw Error('fresh panel'); } });
    expect(green.run.id).toBe(f.saved.id);
    expect(green.stopped).toBe('complete');
    expect(green.run.effects.find(e => e.type === REVIEW_EFFECTS.LABEL).status).toBe('applied');
    expect(f.runNode).toHaveBeenCalledOnce();
    expect(f.judge).toHaveBeenCalledTimes(judges);
    for (const [args] of f.publishGate.mock.calls) expect(args.policy)
      .toMatchObject({ startEarly: 'off', startAfter: 'ci-green', startBeforeCi: false });
  });

  it.each(['automatic', 'explicit'].flatMap(mode =>
    ['pending', 'revoked', 'green', 'exhausted', 'unknown'].map(next => [mode, next])))(
    '%s CI-held retry preserves guards after EAGAIN (%s)', async (mode, next) => {
      const original = { file: NET_PATHS[0], line: 7, summary: 'launch guard missing', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
      const seat = 'judge', key = referralFindingKey(seat, original);
      const reviewer = mandatoryReferralReviewer('ci-held-cleared-referral');
      const record = { version: 1, repo: BASE_ARGV[1].slice(7), pr: 1234, head: HEAD_A,
        runId: 'ci-held-cleared-referral', reviewer, authorBody: '<!-- authored-by-actor: author -->', attempted: true,
        referrals: [{ key, seat, original, finding: normalizeFinding(original) }],
        rulings: [{ id: 'clearance', key, reviewerId: reviewer.id, lens: 'correctness', result: 'not-real',
          rationale: 'Verified against the pinned diff', evidence: ['diff:launch-guard'] }],
      };
      // A body edit revokes this reviewer's independence only when a real referral uses its clearance.
      // A clean review with no referral remains acceptable without an author stamp.
      let cleared = true;
      const readAcceptancePr = vi.fn(() => ({ headRefOid: HEAD_A,
        body: cleared ? record.authorBody : `<!-- authored-by-actor: ${reviewer.id} -->`,
        comments: [{ body: renderReferralRecord(record), author: { login: 'web-everything' } }] }));
      const f = await fixture(3, { acceptPolicy: { value: { unattendedAcceptRequiresCleanReferrals: true } },
        readAcceptancePr });
      f.publishGate.mockReturnValue({ allowed: true, headSha: HEAD_A, reason: 'required-checks-successful' });
      f.runNode.mockImplementation(() => { throw Object.assign(Error('spawn EAGAIN'), { code: 'EAGAIN' }); });
      const args = { ...f.args, findResumableRun: f.find,
        ...(mode === 'explicit' ? { argv: [`--resume=${f.saved.id}`, '--json'] } : {}),
        mintRunId: () => { throw Error('fresh panel'); } };
      const failed = await runReviewLoopOnce(args);
      expect(failed.stopped).toBe('effect-halted');
      expect(failed.run.effects.find(e => e.type === REVIEW_EFFECTS.LABEL)).toMatchObject({ status: 'failed',
        error: 'review-set-label.mjs could not be started, nothing was written: EAGAIN' });
      Object.assign(f.timingEnv, { WE_REVIEW_START_EARLY: 'off', WE_REVIEW_START_AFTER: 'ci-green', WE_REVIEW_CANCEL_ON_CI_RED: 'false' });
      f.runNode.mockClear();
      f.runNode.mockReturnValue('{"ok":true}');
      f.publishGate.mockClear();
      readAcceptancePr.mockClear();
      if (next === 'pending') f.publishGate.mockReturnValue({ allowed: false, headSha: HEAD_A, reason: 'required-checks-not-successful' });
      if (next === 'revoked') cleared = false;
      if (next === 'exhausted' || next === 'unknown') {
        const saved = f.store.read(f.saved.id);
        if (next === 'exhausted') saved.recordEffectResumeAttempts = RESUME_MAX_ATTEMPTS;
        else saved.effects.find(e => e.type === REVIEW_EFFECTS.LABEL).status = 'pending';
        f.store.write(saved);
        // Bypass discovery to exercise the driver's/executor's own refusal.
        args.findResumableRun = () => f.saved.id;
        args.argv = [`--resume=${f.saved.id}`, '--json'];
      }
      const before = f.store.read(f.saved.id);
      const out = next === 'unknown' ? await runReviewLoopCliOnce(args) : await runReviewLoopOnce(args);
      if (next === 'green') {
        expect(out.stopped).toBe('complete');
        expect(f.runNode).toHaveBeenCalledOnce();
      } else {
        expect(out.stopped).toBe(next === 'pending' ? 'effect-halted' : 'refused');
        expect(f.runNode).not.toHaveBeenCalled();
      }
      if (['pending', 'revoked', 'green'].includes(next)) expect(readAcceptancePr).toHaveBeenCalled();
      if (next === 'revoked') {
        expect(out.lines.join(' ')).toContain('unattended accept held: mandatory referrals remain open on the live head');
        expect(f.store.read(f.saved.id)).toEqual(before);
      }
      if (['pending', 'green'].includes(next)) expect(f.publishGate).toHaveBeenCalled();
      else expect(f.publishGate).not.toHaveBeenCalled();
    });

  it.each([['at bound', 3, 3, true], ['over bound', 3, 4, false], ['zero disables retries', 0, 1, false]])(
    '%s uses the setting and preserves the fresh path when ineligible', async (_name, max, attempts, resumes) => {
      const f = await fixture(max);
      const saved = f.store.read(f.saved.id);
      saved.effects.find(e => e.type === REVIEW_EFFECTS.LABEL).unknownAttempts = attempts;
      f.store.write(saved);
      const out = await runReviewLoopOnce({ ...f.args, findResumableRun: f.find, mintRunId: () => 'fresh-panel' });
      expect(out.run.id).toBe(resumes ? saved.id : 'fresh-panel');
      expect(out.run.recordEffectResumeAttempts).toBe(resumes ? 1 : undefined);
    });

  it.each([0, 3])('the driver itself rejects an ineligible CI retry even if lookup returns it (max=%i)', async max => {
    const f = await fixture(max);
    const saved = f.store.read(f.saved.id);
    saved.effects.find(e => e.type === REVIEW_EFFECTS.LABEL).unknownAttempts = max + 1;
    f.store.write(saved);
    const out = await runReviewLoopOnce({ ...f.args, findResumableRun: () => saved.id, mintRunId: () => 'fresh-panel' });
    expect(out.run.id).toBe('fresh-panel');
    expect(f.store.read(saved.id).recordEffectResumeAttempts).toBeUndefined();
  });

  it.each(['automatic', 'explicit'])('%s resume refuses at the independent record-attempt guard without starting a fresh panel', async mode => {
    const f = await fixture();
    f.store.write({ ...f.saved, recordEffectResumeAttempts: RESUME_MAX_ATTEMPTS });
    if (mode === 'explicit') f.args.argv = [`--resume=${f.saved.id}`, '--json'];
    const judges = f.judge.mock.calls.length;
    const out = await runReviewLoopOnce({ ...f.args, findResumableRun: () => f.saved.id, mintRunId: () => { throw Error('fresh panel'); } });
    expect(out.stopped).toBe('refused');
    expect(out.lines.join(' ')).toContain('record effect resume attempts spent');
    expect(f.runNode).not.toHaveBeenCalled();
    expect(f.store.read(f.saved.id)).toEqual({ ...f.saved, recordEffectResumeAttempts: RESUME_MAX_ATTEMPTS });
    expect(f.judge).toHaveBeenCalledTimes(judges);
  });

  it.each(['automatic', 'explicit'].flatMap(mode => ['recordEffectResumeAttempts', 'unknownAttempts'].flatMap(field =>
    ['corrupt', -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1].map(value => [mode, field, value]))))(
    '%s resume refuses malformed saved %s=%s without applying the label', async (mode, field, value) => {
      const f = await fixture();
      const raw = f.saved;
      if (field === 'unknownAttempts') raw.effects.find(e => e.type === REVIEW_EFFECTS.LABEL)[field] = value;
      else raw[field] = value;
      // Run-store JSON turns NaN into null; exercise the actual saved representation.
      const saved = JSON.parse(JSON.stringify(raw));
      f.store.write(saved);
      expect(f.find(saved.input)).toBeNull();
      const judges = f.judge.mock.calls.length, checks = f.publishGate.mock.calls.length;
      const out = await runReviewLoopOnce({ ...f.args,
        ...(mode === 'explicit' ? { argv: [`--resume=${saved.id}`, '--json'] } : {}),
        findResumableRun: () => saved.id, mintRunId: () => { throw Error('fresh panel'); } });
      expect(out).toMatchObject({ code: 2, stopped: 'refused', run: saved });
      expect(out.lines.join(' ')).toContain('malformed CI-held record retry counters');
      expect(f.store.read(saved.id)).toEqual(saved);
      expect(f.judge).toHaveBeenCalledTimes(judges);
      expect(f.publishGate).toHaveBeenCalledTimes(checks);
      expect(f.runNode).not.toHaveBeenCalled();
    });

  it.each([['over bound', 3, 4], ['zero disables retries', 0, 1]])(
    'explicit CI-held resume refuses when %s without applying the label', async (_name, max, attempts) => {
      const f = await fixture(max);
      const saved = f.store.read(f.saved.id);
      saved.effects.find(e => e.type === REVIEW_EFFECTS.LABEL).unknownAttempts = attempts;
      f.store.write(saved);
      const checks = f.publishGate.mock.calls.length, judges = f.judge.mock.calls.length;
      const out = await runReviewLoopOnce({ ...f.args, argv: [`--resume=${saved.id}`, '--json'],
        mintRunId: () => { throw Error('fresh panel'); } });
      expect(out).toMatchObject({ code: 2, stopped: 'refused', run: saved });
      expect(out.lines.join(' ')).toContain('CI-held record retry attempts spent or disabled');
      expect(f.store.read(saved.id)).toEqual(saved);
      expect(f.publishGate).toHaveBeenCalledTimes(checks);
      expect(f.judge).toHaveBeenCalledTimes(judges);
      expect(f.runNode).not.toHaveBeenCalled();
    });

  it.each([RESUME_MAX_ATTEMPTS - 1, RESUME_MAX_ATTEMPTS, RESUME_MAX_ATTEMPTS + 1])(
    'driver and planner agree on the independent record resume budget (%s)', async resumeAttempts => {
      const f = await fixture();
      const saved = { ...f.saved, recordEffectResumeAttempts: resumeAttempts };
      f.store.write(saved);
      const { repo, pr } = saved.input;
      const [plan] = planRedTeamOnSkip({ repo,
        refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: HEAD_A }],
        rawPrs: [{ number: pr, headRefOid: HEAD_A, comments: [], reviews: [] }],
        readEvidence: () => ({ ok: false, reason: 'review-unfinished' }),
        readReviewRuns: () => [reviewRunEvidence(saved)], headNeverReviewed: () => false,
        setting: { enabled: true, retryCooldownMin: 30, ciHeldRecordRetryMax: 3 },
        lastDispatch: new Map(), now: 2_000_000,
      });
      const eligible = resumeAttempts < RESUME_MAX_ATTEMPTS;
      expect(f.find({ repo, pr })).toBe(eligible ? saved.id : null);
      expect(plan.action).toBe(eligible ? 'review' : 'skip');
      if (!eligible) expect(plan).toMatchObject({ why: 'review-unfinished', escalate: true });
      // Bypass discovery to probe the driver's own guard against the same saved run.
      const out = await runReviewLoopOnce({ ...f.args, findResumableRun: () => saved.id,
        mintRunId: () => { throw Error('fresh panel'); } });
      expect(out.stopped === 'refused').toBe(!eligible);
      expect(out.run.recordEffectResumeAttempts).toBe(eligible ? resumeAttempts + 1 : resumeAttempts);
      if (!eligible) expect(out.lines.join(' ')).toContain('record effect resume attempts spent');
    });

  it('never replays an unknown pending label outcome on explicit resume', async () => {
    const f = await fixture();
    const saved = f.store.read(f.saved.id);
    saved.effects.find(e => e.type === REVIEW_EFFECTS.LABEL).status = 'pending';
    f.store.write(saved);
    const checks = f.publishGate.mock.calls.length;
    const out = await runReviewLoopCliOnce({ ...f.args, argv: [`--resume=${saved.id}`, '--json'] });
    expect(out.code).not.toBe(0);
    expect(out.stopped).toBe('refused');
    expect(out.run).toBeNull();
    expect(out.lines.join(' ')).toContain('UNKNOWN');
    expect(f.publishGate).toHaveBeenCalledTimes(checks);
    expect(f.runNode).not.toHaveBeenCalled();
  });
});

describe('review pass PR metadata snapshot', () => {
  it('caches resume reads per repo/PR and uses exactly one fresh pr view per acceptance read', () => {
    let head = HEAD_A;
    const exec = vi.fn(() => JSON.stringify({ headRefOid: head, body: 'body', createdAt: 'date' }));
    const readComments = vi.fn(() => [{ body: `thread-${readComments.mock.calls.length}` }]);
    const input = { repo: 'owner/repo', pr: 7 };
    for (const expectedHead of [HEAD_A, HEAD_B]) {
      head = expectedHead;
      const readPr = createReviewPassPrReader({ exec, readComments });
      const views = () => exec.mock.calls.filter(([, args]) => args[0] === 'pr' && args[1] === 'view').length;
      const before = views();
      expect(defaultFindResumableRun(input, { readPr, readRuns: () => [] })).toBeNull();
      expect(readPr(input)).toMatchObject({ headRefOid: expectedHead });
      expect(readPr(input, { refreshHead: true })).toMatchObject({ headRefOid: expectedHead, body: 'body', createdAt: 'date' });
      expect(readPr(input, { refreshHead: true }).comments).toEqual([{ body: `thread-${readComments.mock.calls.length}` }]);
      // Acceptance needs fresh author stamps as well as the head; only resume reads share the cache.
      expect(views() - before).toBe(3);
      readPr({ ...input, repo: 'another/repo' });
      readPr({ ...input, pr: 8 });
      expect(views() - before).toBe(5);
    }
    expect(readComments).toHaveBeenCalledTimes(12);
    expect(exec.mock.calls.filter(([, args]) => args[0] === 'api')).toHaveLength(0);
    expect(exec.mock.calls[0][1]).toContain('headRefOid,body,createdAt');
  });

  it('acceptance sees an author-stamp body edit made after the resume read', () => {
    let body = 'original author stamp';
    const exec = vi.fn(() => JSON.stringify({ headRefOid: HEAD_A, body, createdAt: 'date' }));
    const readPr = createReviewPassPrReader({ exec, readComments: () => [] });
    const input = { repo: 'owner/repo', pr: 7 };
    expect(readPr(input).body).toBe(body);
    body = 'changed author stamp';
    expect(readPr(input, { refreshHead: true })).toMatchObject({ headRefOid: HEAD_A, body });
    expect(readPr(input).body).toBe(body);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls.every(([, args]) => args.at(-1) === 'headRefOid,body,createdAt')).toBe(true);
  });

  it('retains an unreadable metadata failure for the pass and retries on the next pass', () => {
    const exec = vi.fn(() => { throw new Error('unreadable PR'); });
    const readComments = vi.fn();
    const input = { repo: 'owner/repo', pr: 7 };
    const readPr = createReviewPassPrReader({ exec, readComments });
    expect(defaultFindResumableRun(input, { readPr, readRuns: () => [] })).toBeNull();
    expect(() => readPr(input)).toThrow('unreadable PR');
    expect(exec).toHaveBeenCalledTimes(1);
    expect(readComments).not.toHaveBeenCalled();
    expect(() => createReviewPassPrReader({ exec, readComments })(input)).toThrow('unreadable PR');
    expect(exec).toHaveBeenCalledTimes(2);
  });
});


describe('acceptance refreshes the resume snapshot head', () => {
  it.each(['pushed head', 'unreadable head', 'missing head'])(
    'refuses acceptance after resume lookup when the remote has a %s', async scenario => {
      let afterResume = false;
      const exec = vi.fn((_cmd, args) => {
        expect(args).toEqual(['pr', 'view', '1234', '--repo', 'web-everything/web-everything', '--json', 'headRefOid,body,createdAt']);
        if (afterResume && scenario === 'unreadable head') throw new Error('head read failed');
        const headRefOid = !afterResume ? HEAD_A : scenario === 'missing head' ? null : HEAD_B;
        return JSON.stringify({ headRefOid, body: '', createdAt: '' });
      });
      const readComments = vi.fn(() => []);
      const readResumePr = createReviewPassPrReader({ exec, readComments });
      const { declaration, registry } = registryFor({ rev: HEAD_A });
      const seen = [];
      const fileItem = vi.fn();
      const out = await driveReviewLoopOnce({ declaration, registry, argv: BASE_ARGV,
        store: createMemoryRunStore(), sinks: recordingSinks(seen), readResumePr,
        findResumableRun: input => {
          expect(defaultFindResumableRun(input, { readPr: readResumePr, readRuns: () => [] })).toBeNull();
          afterResume = true; // The fresh acceptance view must observe evidence after the resume read.
          return null;
        },
        makeJudge: cannedJudge(CLEAN_ANSWER), mintRunId: () => `snapshot-${scenario.replaceAll(' ', '-')}`, fileItem,
      });
      expect(out.stopped).toBe('confirm');
      expect(out.run.findings.confirm).toBeUndefined();
      expect(seen.some(effect => effect.type === REVIEW_EFFECTS.LABEL)).toBe(false);
      expect(fileItem).not.toHaveBeenCalled();
      expect(out.lines.join('\n')).toContain(scenario === 'pushed head'
        ? 'live head does not match the reviewed head' : 'live referrals unavailable');
      // One resume view, then fresh views for auto-confirm and the parked-outcome refusal.
      expect(exec.mock.calls.filter(([, args]) => args[0] === 'pr' && args[1] === 'view')).toHaveLength(3);
      expect(exec.mock.calls.filter(([, args]) => args[0] === 'api')).toHaveLength(0);
      expect(readComments.mock.calls.length).toBeGreaterThan(1);
    },
  );

  it.each(['unchanged', 'changed'])('uses the fresh %s author body to authorize referral clearance', async scenario => {
    const original = { file: NET_PATHS[0], line: 7, summary: 'launch guard missing', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
    const seat = 'judge';
    const key = referralFindingKey(seat, original);
    const reviewer = mandatoryReferralReviewer('snapshot-body-referral');
    const authorBody = '<!-- authored-by-actor: author -->';
    const record = { version: 1, repo: 'web-everything/web-everything', pr: 1234, head: HEAD_A,
      runId: 'snapshot-body-referral', reviewer, authorBody, attempted: true,
      referrals: [{ key, seat, original, finding: normalizeFinding(original) }],
      rulings: [{ id: 'clearance', key, reviewerId: reviewer.id, lens: 'correctness', result: 'not-real',
        rationale: 'Verified against the pinned diff', evidence: ['diff:launch-guard'] }],
    };
    let body = authorBody;
    const exec = vi.fn((_cmd, args) => {
      expect(args).toEqual(['pr', 'view', '1234', '--repo', record.repo, '--json', 'headRefOid,body,createdAt']);
      return JSON.stringify({ headRefOid: HEAD_A, body, createdAt: '' });
    });
    const readComments = vi.fn(() => [{ body: renderReferralRecord(record), author: { login: 'web-everything' } }]);
    const readResumePr = createReviewPassPrReader({ exec, readComments });
    const { declaration, registry } = registryFor({ rev: HEAD_A });
    const seen = [];
    const fileItem = vi.fn();
    const out = await driveReviewLoopOnce({ declaration, registry, argv: BASE_ARGV,
      store: createMemoryRunStore(), sinks: recordingSinks(seen), readResumePr,
      findResumableRun: input => {
        expect(defaultFindResumableRun(input, { readPr: readResumePr, readRuns: () => [] })).toBeNull();
        if (scenario === 'changed') body = `<!-- authored-by-actor: ${reviewer.id} -->`;
        return null;
      },
      makeJudge: cannedJudge(CLEAN_ANSWER), mintRunId: () => `snapshot-body-${scenario}`, fileItem,
    });
    if (scenario === 'changed') {
      expect(out.stopped).toBe('confirm');
      expect(out.run.findings.confirm).toBeUndefined();
      expect(seen.some(effect => effect.type === REVIEW_EFFECTS.LABEL)).toBe(false);
      expect(out.lines.join('\n')).toContain('mandatory referrals remain open on the live head');
    } else {
      expect(out.stopped).toBe('complete');
      expect(out.run.findings.confirm).toBe('accept');
      expect(seen.some(effect => effect.type === REVIEW_EFFECTS.LABEL)).toBe(true);
    }
    expect(fileItem).not.toHaveBeenCalled();
    // A refusal rechecks acceptance when rendering the parked outcome; a successful accept does not.
    const reads = scenario === 'changed' ? 3 : 2;
    expect(exec).toHaveBeenCalledTimes(reads);
    expect(readComments).toHaveBeenCalledTimes(reads);
  });
});


it('default review-loop minting keys the persisted run by its parsed PR', async () => {
  const { declaration, registry } = registryFor({});
  const out = await runReviewLoopOnce({
    declaration, registry, argv: [...BASE_ARGV, '--json'], store: createMemoryRunStore(),
    sinks: recordingSinks([]), makeJudge: cannedJudge(CLEAN_ANSWER),
  });
  expect(out.code).toBe(0);
  expect(out.run.id.match(NAME_RE)?.[1]).toBe(String(out.run.input.pr));
});


describe('D: tombstoned advisory resume selection', () => {
  it.each(['safe', 'unknown-write', 'record-budget', 'referral-budget'])(
    'tombstone preserves saved-run safeguards: %s', async scenario => {
      const { declaration, registry } = registryFor({ rev: HEAD_A });
      const store = createMemoryRunStore();
      const initial = await runReviewLoopOnce({ declaration, registry, argv: BASE_ARGV, store,
        sinks: recordingSinks([]), makeJudge: cannedJudge(CLEAN_ANSWER), mintRunId: () => 'saved-D' });
      const record = { ...initial.run, cursor: declaration.steps.findIndex(s => s.name === 'advise'),
        pending: { kind: 'effect', step: 'advise' },
        stepTimings: [...initial.run.stepTimings.filter(t => t.step !== 'advise')],
        resumeOf: { verdict: { verdict: 'accept', pendingReferrals: [] }, attempts: 1,
          adviseAttempts: scenario === 'unknown-write' ? RESUME_MAX_ATTEMPTS : 0 },
        effects: scenario === 'unknown-write' ? [{ step: 'advise', status: 'pending', idempotent: false }] : [] };
      if (scenario === 'record-budget') Object.assign(record, { resumeOf: null,
        pending: { kind: 'effect', step: 'record' }, recordEffectResumeAttempts: RESUME_MAX_ATTEMPTS,
        effects: [{ type: 'review.label-swap', status: 'pending', unknownAttempts: 0, error: '--body-file=x is empty — pass the verdict write-up' }] });
      if (scenario === 'referral-budget') Object.assign(record, { resumeOf: null,
        pending: { kind: 'effect', step: 'mandatoryReferrals' }, referralEffectResumeAttempts: RESUME_MAX_ATTEMPTS });
      record.pending.stepIndex = record.cursor;
      record.effects = record.effects.map((e, i) => ({ key: `D-${i}`, type: 'review.note', stepIndex: record.cursor, index: i, ...e }));
      store.write(record);
      const fresh = vi.fn(() => 'fresh-D');
      const result = await runReviewLoopOnce({ declaration, registry, argv: BASE_ARGV, store,
        sinks: recordingSinks([]), makeJudge: cannedJudge(CLEAN_ANSWER), mintRunId: fresh,
        findResumableRun: () => record.id, isAbandoned: () => true });
      if (scenario === 'safe') { expect(result.run.id).toBe('fresh-D'); expect(fresh).toHaveBeenCalledOnce(); }
      else { expect(result.stopped).toBe('refused'); expect(fresh).not.toHaveBeenCalled(); }
    });

  it.each([false, true])('stale tombstone=%s retains candidate for saved-run safeguards', async stale => {
    const { markRunAbandoned } = await import('../../lib/run-abandoned.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'D-resume-'));
    const id = 'review-pr-advisory', repo = 'web-everything/web-everything', pr = 7116, head = 'a'.repeat(40);
    try {
      writeFileSync(join(dir, `${id}.json`), '{}');
      markRunAbandoned({ id, dir, reason: 'dead', by: 'test', probes: {} });
      if (stale) utimesSync(join(dir, `${id}.json`), new Date(Date.now() + 10000), new Date(Date.now() + 10000));
      expect(defaultFindResumableRun({ repo, pr }, { runsDir: dir,
        readPr: () => ({ headRefOid: head, comments: [] }),
        readRuns: () => [{ id, repo, pr, head, startedAt: 1, completedAt: 2, resumeAdvise: true }] }))
        .toBe(id);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
