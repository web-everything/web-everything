/**
 * @file review-loop-cli.test.mjs — #3072's remaining slice, exercised end to end with no `gh`, no juror
 * subprocess and no real learnings-pool file: a stub `readPr`, a canned judge, recording sinks, an in-memory
 * run store and an injected `appendLearning`.
 *
 * THE FOUR PROPERTIES THIS FILE EXISTS TO PIN (#3434, 2026-09-01, reverses property 1's old shape — it used
 * to say "queues, never auto-accepts"; the operator's live-fire finding, two real PRs sitting queued for no
 * reason, is what prompted the reversal; property 4 added by #3442, finishing `#3434`'s second ratified item):
 *   1. A clean (or already-agreeing) verdict on a non-gate-self PR ACCEPTS MECHANICALLY — the effects apply,
 *      the run completes, and nothing is queued for a human (the old queue-and-notify path is now dead for
 *      this tier; the learnings-pool filing machinery it used stays for `review:human`'s own, unchanged, park).
 *   2. A verdict carrying findings BOUNCES unattended (`changes`, effects applied, run completes) — the round
 *      the operator's automated fix-loop already expects.
 *   3. A gate-self (`review:human`) PR is UNCHANGED: the policy declines (wrong actor), the run parks exactly
 *      as it does for the ordinary human CLI, and no accept — mechanical or manual — happens without one.
 *   4. A `prevention-outstanding` verdict on a non-gate-self PR ALSO accepts mechanically, exactly like
 *      property 1, but files the named guard(s) to the learnings pool as it clears — the notification a human
 *      still needs, without re-entering the bounce/retry loop over documentation debt the code itself doesn't
 *      have. The SAME verdict on a `review:human` PR still parks (property 3's actor refusal fires first).
 */

import { describe, it, expect, vi } from 'vitest';

import { createRegistry } from '../registry.mjs';
import { createMemoryRunStore } from '../run-store.mjs';
import { judgeOutcome } from '../cli-adapter.mjs';
import { REVIEW_EFFECTS, reviewPrOperation } from '../review-pr.mjs';
import { runReviewLoopOnce } from '../review-loop-cli.mjs';
import { createReviewPrSinks } from '../review-pr-io.mjs';

const NET_PATHS = ['scripts/operations/review-pr.mjs'];

/** The same stub-reader shape `review-pr.test.mjs` uses, trimmed to what this file needs. */
function stubReader({ labels = ['review:pending'] } = {}) {
  return ({ pr, repo }) => ({
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
    net: { paths: NET_PATHS, base: 'abc123', rev: 'def456', scored: true },
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

const BASE_ARGV = ['--pr=1234', '--repo=chalbert/web-everything'];

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
    expect(stderrChunks.join('')).toMatch(/^PR chalbert\/web-everything#1234 — human review accepted/);
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

describe('runReviewLoopOnce — property 4: prevention-outstanding also ACCEPTS MECHANICALLY, filing the guard(s) (#3442)', () => {
  it('applies the effects, completes the run, and files the named guard(s) to the learnings pool', async () => {
    const { declaration, registry } = registryFor({});
    const store = createMemoryRunStore();
    const seen = [];
    let filedCount = 0;
    const out = await runReviewLoopOnce({
      declaration, registry, argv: BASE_ARGV, store, sinks: recordingSinks(seen),
      makeJudge: cannedJudge(PREVENTION_ANSWER), mintRunId: () => 'r-prevention',
      appendLearning: (entry) => { filedCount += 1; return { record: entry, path: `pool/${filedCount}.json` }; },
    });

    expect(out.code).toBe(0);
    expect(out.stopped).toBe('complete');
    expect(out.run.findings.confirm).toBe('accept');
    expect(out.run.verdict.verdict).toBe('prevention-outstanding');
    // The SAME effect application a clean accept gets — a label swap to accepted, exactly like property 1.
    expect(seen.map((s) => s.type)).toContain(REVIEW_EFFECTS.LABEL);
    expect(filedCount).toBeGreaterThan(0);
    expect(out.lines.join('\n')).toMatch(/prevention-outstanding auto-cleared to accept/);
    expect(out.lines.join('\n')).not.toMatch(/QUEUED for a human/);
  });

  it('carries `preventionFiled` in --json, with no `queued`/`resumeCommand` fields (those are the OTHER branch)', async () => {
    const { declaration, registry } = registryFor({});
    const store = createMemoryRunStore();
    let filedCount = 0;
    const out = await runReviewLoopOnce({
      declaration, registry, argv: [...BASE_ARGV, '--json'], store, sinks: recordingSinks([]),
      makeJudge: cannedJudge(PREVENTION_ANSWER), mintRunId: () => 'r-prevention-json',
      appendLearning: () => { filedCount += 1; return { record: {}, path: `pool/${filedCount}.json` }; },
    });
    const payload = JSON.parse(out.lines[0]);
    expect(payload.verdict.verdict).toBe('prevention-outstanding');
    expect(payload.preventionFiled.length).toBeGreaterThan(0);
    expect(payload).not.toHaveProperty('queued');
    expect(payload).not.toHaveProperty('resumeCommand');
  });

  it('reports a failed filing loudly without undoing the accept that already recorded', async () => {
    const { declaration, registry } = registryFor({});
    const store = createMemoryRunStore();
    const out = await runReviewLoopOnce({
      declaration, registry, argv: BASE_ARGV, store, sinks: recordingSinks([]),
      makeJudge: cannedJudge(PREVENTION_ANSWER), mintRunId: () => 'r-prevention-filing-fails',
      appendLearning: () => { throw new Error('pool file locked'); },
    });
    expect(out.code).toBe(1);
    expect(out.stopped).toBe('complete');
    expect(out.run.findings.confirm).toBe('accept');
    expect(out.lines.join('\n')).toMatch(/FAILED to file \(some guard\(s\) may be unfiled\): pool file locked/);
  });

  it('isolates a single oversized guard\'s BUILD failure — the OTHER guard(s) in the same run still file, and nothing crashes uncaught', async () => {
    // `buildPreventionQueueEntry` REFUSES (throws) rather than truncates a `prevention` string that overflows
    // `FIELD_CAPS.suggestion` — a realistic case for unbounded juror-authored text. This pins that the build
    // step, not just the append step, is caught PER FINDING: one bad guard must not crash the whole invocation
    // or block filing a sibling guard that would have fit.
    const { declaration, registry } = registryFor({});
    const store = createMemoryRunStore();
    let filedCount = 0;
    const out = await runReviewLoopOnce({
      declaration, registry, argv: BASE_ARGV, store, sinks: recordingSinks([]),
      makeJudge: cannedJudge(MIXED_LENGTH_ANSWER), mintRunId: () => 'r-prevention-mixed-length',
      appendLearning: (entry) => { filedCount += 1; return { record: entry, path: `pool/${filedCount}.json` }; },
    });
    expect(out.stopped).toBe('complete');
    expect(out.run.findings.confirm).toBe('accept');
    expect(out.code).toBe(1); // the oversized guard failed to build
    expect(filedCount).toBeGreaterThan(0); // the short guard still filed despite its sibling's failure
    expect(out.lines.join('\n')).toMatch(/filed →/);
    expect(out.lines.join('\n')).toMatch(/FAILED to file \(some guard\(s\) may be unfiled\)/);
  });

  it('files a below-the-prevention-impact-bar guard too, not just the one that drove the verdict — the WIDE notice predicate, not the narrow verdict one', async () => {
    // `isPreventionOutstandingClear`/the CLI filter on `hasUncapturedPrevention` (WIDE), not `blocksAcceptance`
    // (NARROW, additionally gated on `impactIfUnfixed` vs `PREVENTION_IMPACT_BAR`) — matching
    // `renderPreventionSummary`'s own convention. Only ONE finding needs to cross the bar to reach this
    // verdict at all; a sibling finding below the bar still owes its guard and must still be filed.
    const { declaration, registry } = registryFor({});
    const store = createMemoryRunStore();
    const filedSuggestions = [];
    const out = await runReviewLoopOnce({
      declaration, registry, argv: BASE_ARGV, store, sinks: recordingSinks([]),
      makeJudge: cannedJudge(MIXED_BAR_ANSWER), mintRunId: () => 'r-prevention-mixed-bar',
      appendLearning: (entry) => { filedSuggestions.push(entry.suggestion); return { record: entry, path: `pool/${filedSuggestions.length}.json` }; },
    });
    expect(out.stopped).toBe('complete');
    expect(out.run.verdict.verdict).toBe('prevention-outstanding');
    expect(out.run.findings.confirm).toBe('accept');
    expect(filedSuggestions.some((s) => s.includes('lint rule banning bare magic numbers'))).toBe(true);
    expect(filedSuggestions.some((s) => s.includes('naming-convention doc note'))).toBe(true);
  });

  it('a review:human PR carrying the same verdict is still PARKED, not auto-cleared and nothing filed', async () => {
    const { declaration, registry } = registryFor({ labels: ['review:human'] });
    const store = createMemoryRunStore();
    let filedCount = 0;
    const out = await runReviewLoopOnce({
      declaration, registry, argv: BASE_ARGV, store, sinks: recordingSinks([]),
      makeJudge: cannedJudge(PREVENTION_ANSWER), mintRunId: () => 'r-prevention-human',
      appendLearning: () => { filedCount += 1; return { record: {}, path: '' }; },
    });
    expect(out.stopped).toBe('confirm');
    expect(out.run.pending.of).toBe('human');
    expect(filedCount).toBe(0);
  });

  // Independent review of PR #1784 (CONFIRMED): `isPreventionOutstandingClear` used to treat every stop
  // OTHER than `confirm` as success, so a mid-apply failure (the label-swap effect throwing) on a
  // `prevention-outstanding` run would still take this branch, file the guard(s), and — via the JSON branch's
  // old `code: filingError ? 1 : 0` — report exit code 0 even though the accept never actually landed. Both
  // are fixed now: the halted stop no longer satisfies `isPreventionOutstandingClear`, so this run falls
  // through to the ORDINARY `renderOutcome` rendering for an `effect-halted` stop (code 1, no filing).
  it('an effect-halted run (the accept label swap threw) is NOT treated as prevention-outstanding-clear — no filing, exit code 1', async () => {
    const { declaration, registry } = registryFor({});
    const store = createMemoryRunStore();
    let filedCount = 0;
    const throwingSinks = {
      ...recordingSinks([]),
      [REVIEW_EFFECTS.LABEL]: async () => { throw new Error('gh label edit failed: network error'); },
    };
    const out = await runReviewLoopOnce({
      declaration, registry, argv: BASE_ARGV, store, sinks: throwingSinks,
      makeJudge: cannedJudge(PREVENTION_ANSWER), mintRunId: () => 'r-prevention-effect-halted',
      appendLearning: () => { filedCount += 1; return { record: {}, path: '' }; },
    });
    expect(out.stopped).toBe('effect-halted');
    expect(out.code).toBe(1);
    expect(filedCount).toBe(0);
  });

  it('same effect-halted case, --json: exit code still 1, no `preventionFiled` field — `outcome.stopped` is honored, not ignored', async () => {
    const { declaration, registry } = registryFor({});
    const store = createMemoryRunStore();
    const throwingSinks = {
      ...recordingSinks([]),
      [REVIEW_EFFECTS.LABEL]: async () => { throw new Error('gh label edit failed: network error'); },
    };
    const out = await runReviewLoopOnce({
      declaration, registry, argv: [...BASE_ARGV, '--json'], store, sinks: throwingSinks,
      makeJudge: cannedJudge(PREVENTION_ANSWER), mintRunId: () => 'r-prevention-effect-halted-json',
      appendLearning: () => { throw new Error('must not be called'); },
    });
    expect(out.code).toBe(1);
    const payload = JSON.parse(out.lines[0]);
    expect(payload.stopped).toBe('effect-halted');
    expect(payload).not.toHaveProperty('preventionFiled');
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
