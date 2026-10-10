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

import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, vi } from 'vitest';

import { createRegistry } from '../registry.mjs';
import { createMemoryRunStore } from '../run-store.mjs';
import { judgeOutcome, parseOperationArgv } from '../cli-adapter.mjs';
import { fileItemOperation } from '../file-item.mjs';
import { REVIEW_EFFECTS, reviewPrOperation } from '../review-pr.mjs';
import { buildPreventionFilingInput, buildRoundCardsFilingInput, roundCardsFindingsFingerprint } from '../../lib/review-loop-policy.mjs';
import {
  applyUnattendedActorDefault, buildFileItemArgv, fileItemForPrevention, fileItemForPreventionViaLandingJob,
  findFiledPreventionCard, findFiledRoundCardsCard, findRetainedRoundCardsReceipt, QUEUED_RECEIPT_TTL_MS, retainedRoundCardsReceipt,
  runReviewLoopOnce, UNATTENDED_REVIEW_ACTOR,
} from '../review-loop-cli.mjs';
import { createReviewPrSinks } from '../review-pr-io.mjs';
import { spawnPreventionLandingJob } from '../../lib/prevention-landing-job.mjs';

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
  const run = async ({ answer, round, budget = 3, json = false, fileItem }) => {
    const declaration = reviewPrOperation({ readPr: stubReader({ rev: HEAD_A, extra: { roundBudget: budget, reviewRound: round } }) });
    const registry = createRegistry();
    registry.register(declaration);
    const seen = [];
    const out = await runReviewLoopOnce({
      declaration, registry, argv: [...BASE_ARGV, ...(json ? ['--json'] : [])], store: createMemoryRunStore(), sinks: recordingSinks(seen),
      makeJudge: cannedJudge(answer), mintRunId: () => `r-budget-${round}`, fileItem,
      findFiledRoundCards: () => null,
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
    return runReviewLoopOnce({
      declaration, registry, argv, store, sinks, makeJudge: cannedJudge(answer), mintRunId: () => id,
      fileItem, findFiledRoundCards: () => null,
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
