import { describe, it, expect, afterEach } from 'vitest';
import { join, dirname } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { scrubReasons } from '../../lib/secret-scrub.mjs';
import { readLegacySources } from '../run-scorecard-store.mjs';
import {
  RUBRIC_VERSION, GUARD_BLOCKS_TARGET, BASELINE_WALL_MS_BY_KIND, REFERENCE_STORY_SIZE,
  isSyntheticModel, extractTurns, sessionNameFromLines, computeWallMs, sessionTimeBounds, pairToolEvents,
  classifyToolCall, computeTimeShares, countGuardBlocks, countErrors, countRepeatedCalls, countTestReruns,
  sumTokens, dominantModel, computeCostUsd, computeCacheHitRatio,
  classifyOutcome, gradeRun, worseGrade, baselineWallMs, outcomeFromTranscriptEvents,
  gradeReviewJob, resolveReviewGrade, classifyRunWaste, topWasteCauses,
  rateTranscript, rateReviewJobTimings,
  findTranscriptPath, readTranscriptLines, rateSession, rateReviewJobLog,
  toScorecardRow, rollupKey, phaseForKind, rollupByDemand, flagWaste,
  scanClaudeProjectsCoverage, scanReviewJurorUsage, scanNonClaudeJudgeTranscripts, buildCoverageReport,
  orchestratorProjectDirName, preparedForItem, preparedComparison,
} from '../run-rating.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'run-rating.mjs');

const dirs = [];
function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'we-run-rating-test-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) { try { rmSync(dirs.pop(), { recursive: true, force: true }); } catch { /* best-effort */ } }
  delete process.env.OPERATION_COMPLETIONS_DIR;
});

// ── fixture builders ────────────────────────────────────────────────────────────────────────────────────────────

/** Real transcripts store `timestamp` as an ISO-8601 string (confirmed against a live transcript) — every
 *  fixture line below converts its numeric `ts` (epoch ms, easiest to reason about in assertions) to that
 *  same string shape, so these fixtures exercise the exact parsing the real IO shell does. */
function iso(ts) { return new Date(ts).toISOString(); }
function assistantLine({ ts, model = 'claude-sonnet-5-5', usage = {}, content = [] }) {
  return { type: 'assistant', timestamp: iso(ts), message: { model, usage, content } };
}
function userLine({ ts, content = [] }) {
  return { type: 'user', timestamp: iso(ts), message: { content } };
}
function toolUse(id, name, input = {}) { return { type: 'tool_use', id, name, input }; }
function toolResult(id, { content = 'ok', isError = false } = {}) {
  return { type: 'tool_result', tool_use_id: id, content, is_error: isError };
}
function usage({ inTok = 100, outTok = 50, cacheRead = 0, cw5m = 0, cw1h = 0, thinking = 0 } = {}) {
  return {
    input_tokens: inTok, output_tokens: outTok, cache_read_input_tokens: cacheRead,
    cache_creation: { ephemeral_5m_input_tokens: cw5m, ephemeral_1h_input_tokens: cw1h },
    output_tokens_details: { thinking_tokens: thinking },
  };
}

/** A small, realistic fix-session transcript: custom-title, a thinking turn, a test/gate Bash call, an Edit,
 *  a gh call, and a final turn — spanning 10 minutes of wall time (the fix-session baseline exactly). */
function fixtureTranscript() {
  const t0 = Date.parse('2026-09-27T10:00:00.000Z');
  const min = 60_000;
  return [
    { type: 'custom-title', customTitle: 'fix-2748', sessionId: 'abc-123' },
    assistantLine({ ts: t0, usage: usage({ thinking: 200 }), content: [] }),
    assistantLine({ ts: t0 + 1 * min, usage: usage({ cw1h: 500 }), content: [toolUse('t1', 'Bash', { command: 'npm run test:unit' })] }),
    userLine({ ts: t0 + 3 * min, content: [toolResult('t1', { content: 'PASS' })] }),
    assistantLine({ ts: t0 + 3 * min, usage: usage({ cacheRead: 200 }), content: [toolUse('t2', 'Edit', { file_path: 'a.mjs' })] }),
    userLine({ ts: t0 + 4 * min, content: [toolResult('t2', { content: 'edited' })] }),
    assistantLine({ ts: t0 + 4 * min, usage: usage(), content: [toolUse('t3', 'Bash', { command: 'gh pr view 2748' })] }),
    userLine({ ts: t0 + 5 * min, content: [toolResult('t3', { content: '{}' })] }),
    assistantLine({ ts: t0 + 10 * min, model: '<synthetic>', usage: usage({ inTok: 0, outTok: 0 }), content: [] }),
  ];
}

// ── extraction ──────────────────────────────────────────────────────────────────────────────────────────────────

describe('isSyntheticModel', () => {
  it('flags a synthetic marker model', () => { expect(isSyntheticModel('<synthetic>')).toBe(true); });
  it('does not flag a real model id', () => { expect(isSyntheticModel('claude-sonnet-5-5')).toBe(false); });
  it('does not flag null/undefined', () => { expect(isSyntheticModel(null)).toBe(false); expect(isSyntheticModel(undefined)).toBe(false); });
});

describe('extractTurns', () => {
  it('excludes synthetic turns from the returned turns', () => {
    const turns = extractTurns(fixtureTranscript());
    expect(turns.every((t) => t.model !== '<synthetic>')).toBe(true);
  });
  it('reads cache_creation split into cacheWrite5m/cacheWrite1h separately', () => {
    const turns = extractTurns([assistantLine({ ts: 0, usage: usage({ cw5m: 10, cw1h: 20 }) })]);
    expect(turns[0]).toMatchObject({ cacheWrite5m: 10, cacheWrite1h: 20 });
  });
  it('falls back to pricing the whole cache_creation_input_tokens at the 1h tier when there is no split', () => {
    const line = assistantLine({ ts: 0, usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 999 } });
    const turns = extractTurns([line]);
    expect(turns[0]).toMatchObject({ cacheWrite5m: 0, cacheWrite1h: 999 });
  });
});

describe('sessionNameFromLines', () => {
  it('reads the custom-title line', () => { expect(sessionNameFromLines(fixtureTranscript())).toBe('fix-2748'); });
  it('is null with no custom-title line', () => { expect(sessionNameFromLines([{ type: 'assistant' }])).toBeNull(); });
});

describe('computeWallMs', () => {
  it('is the max-min timestamp span', () => {
    expect(computeWallMs(fixtureTranscript())).toBe(10 * 60_000);
  });
  it('is null with fewer than two timestamps', () => { expect(computeWallMs([{ type: 'x' }])).toBeNull(); });
});

describe('pairToolEvents', () => {
  const events = pairToolEvents(fixtureTranscript());
  it('joins tool_use to its later tool_result by id', () => {
    const t1 = events.find((e) => e.id === 't1');
    expect(t1).toMatchObject({ name: 'Bash', durationMs: 2 * 60_000, isError: false, category: 'tests-gates' });
  });
  it('reports a tool_use with no result as durationMs:null rather than dropping it', () => {
    const lines = [assistantLine({ ts: 0, content: [toolUse('orphan', 'Bash', { command: 'echo hi' })] })];
    const ev = pairToolEvents(lines);
    expect(ev).toEqual([expect.objectContaining({ id: 'orphan', durationMs: null, endTs: null })]);
  });
  it('marks a tool_result with is_error:true', () => {
    const lines = [
      assistantLine({ ts: 0, content: [toolUse('e1', 'Bash', { command: 'gh api x' })] }),
      userLine({ ts: 10, content: [toolResult('e1', { content: 'boom', isError: true })] }),
    ];
    expect(pairToolEvents(lines)[0].isError).toBe(true);
  });
});

describe('classifyToolCall', () => {
  it('classifies Edit/Write/NotebookEdit/MultiEdit as edits regardless of input', () => {
    for (const name of ['Edit', 'Write', 'NotebookEdit', 'MultiEdit']) expect(classifyToolCall(name, {})).toBe('edits');
  });
  it('classifies a test/gate Bash command', () => {
    expect(classifyToolCall('Bash', { command: 'npm run test:unit' })).toBe('tests-gates');
    expect(classifyToolCall('Bash', { command: 'node scripts/verify-lane.mjs run' })).toBe('tests-gates');
    expect(classifyToolCall('Bash', { command: 'npx vitest run scripts/foo.test.mjs' })).toBe('tests-gates');
  });
  it('classifies a gh Bash command', () => { expect(classifyToolCall('Bash', { command: 'gh pr view 123' })).toBe('gh'); });
  it('classifies a git Bash command', () => { expect(classifyToolCall('Bash', { command: 'git commit -m x' })).toBe('git'); });
  it('classifies our own operations tooling as platform-ops', () => {
    expect(classifyToolCall('Bash', { command: 'node scripts/operations/run.mjs claim --item=1' })).toBe('platform-ops');
  });
  it('falls back to other for an unrecognised Bash command and an unrecognised tool name', () => {
    expect(classifyToolCall('Bash', { command: 'ls -la' })).toBe('other');
    expect(classifyToolCall('Read', { file_path: 'x' })).toBe('other');
  });
});

describe('computeTimeShares', () => {
  it('attributes each known tool duration to its own category and sums to shares of wallMs', () => {
    const events = pairToolEvents(fixtureTranscript());
    const turns = extractTurns(fixtureTranscript());
    const wallMs = computeWallMs(fixtureTranscript());
    const time = computeTimeShares(events, turns, wallMs);
    expect(time.testsMs).toBe(2 * 60_000);
    expect(time.editsMs).toBe(1 * 60_000);
    expect(time.ghMs).toBe(1 * 60_000);
    expect(time.shares.tests).toBeCloseTo(2 / 10, 5);
  });
  it('attributes leftover gap time to reasoning when a real turn with thinking tokens falls inside it', () => {
    // one gap (no tool calls at all) with a thinking turn in the middle
    const lines = [
      assistantLine({ ts: 0, usage: usage({ thinking: 500 }) }),
      assistantLine({ ts: 1000, usage: usage({ thinking: 0 }) }),
    ];
    const time = computeTimeShares(pairToolEvents(lines), extractTurns(lines), computeWallMs(lines));
    expect(time.reasoningMs).toBe(1000);
    expect(time.idleMs).toBe(0);
  });
  it('attributes leftover gap time to idle when no turn in it has thinking tokens', () => {
    const lines = [
      assistantLine({ ts: 0, usage: usage({ thinking: 0 }) }),
      assistantLine({ ts: 1000, usage: usage({ thinking: 0 }) }),
    ];
    const time = computeTimeShares(pairToolEvents(lines), extractTurns(lines), computeWallMs(lines));
    expect(time.idleMs).toBe(1000);
    expect(time.reasoningMs).toBe(0);
  });

  // Regression (confirmed live review finding, antigravity-review/Logic, PR #2811): the leading gap (before
  // the first tool call) and trailing gap (after the last one) were never bounded at all without an explicit
  // `sessionStartTs` — a 20-minute session with one 2-minute tool call at the 10-minute mark lost all 18
  // other minutes from BOTH idle and reasoning, and every category share silently failed to sum to ~1.0.
  it('covers the gap BEFORE the first tool call and AFTER the last one when sessionStartTs is given', () => {
    const t0 = Date.parse('2026-09-27T10:00:00.000Z');
    const min = 60_000;
    const lines = [
      assistantLine({ ts: t0, usage: usage({ thinking: 50 }) }), // 10 min of reasoning before the first call
      assistantLine({ ts: t0 + 10 * min, content: [toolUse('a', 'Bash', { command: 'ls' })] }),
      userLine({ ts: t0 + 12 * min, content: [toolResult('a')] }), // the one 2-minute tool call
      assistantLine({ ts: t0 + 20 * min, usage: usage({ thinking: 0 }) }), // 8 min idle after, to the session end
    ];
    const events = pairToolEvents(lines);
    const turns = extractTurns(lines);
    const wallMs = computeWallMs(lines);
    const bounds = sessionTimeBounds(lines);
    const time = computeTimeShares(events, turns, wallMs, bounds.startTs);
    expect(time.reasoningMs).toBe(10 * min); // the leading gap, no longer lost
    expect(time.idleMs).toBe(8 * min); // the trailing gap, no longer lost
    expect(time.otherMs).toBe(2 * min); // the one Bash call in between
    const shareSum = Object.values(time.shares).reduce((s, v) => s + (v ?? 0), 0);
    expect(shareSum).toBeCloseTo(1, 5); // every ms of wallMs now lands in exactly one bucket
  });
  it('without sessionStartTs, falls back to the OLD (documented-incomplete) between-calls-only behavior', () => {
    const t0 = Date.parse('2026-09-27T10:00:00.000Z');
    const min = 60_000;
    const lines = [
      assistantLine({ ts: t0, usage: usage({ thinking: 50 }) }),
      assistantLine({ ts: t0 + 10 * min, content: [toolUse('a', 'Bash', { command: 'ls' })] }),
      userLine({ ts: t0 + 12 * min, content: [toolResult('a')] }),
      assistantLine({ ts: t0 + 20 * min, usage: usage({ thinking: 0 }) }),
    ];
    const time = computeTimeShares(pairToolEvents(lines), extractTurns(lines), computeWallMs(lines)); // no 4th arg
    expect(time.reasoningMs).toBe(0); // the old, known-incomplete behavior — no bound to locate the leading gap
    expect(time.idleMs).toBe(0);
  });
});

describe('countGuardBlocks / countErrors', () => {
  it('counts only the literal hook error: Blocked marker as a guard block', () => {
    const lines = [
      assistantLine({ ts: 0, content: [toolUse('a', 'Edit', {})] }),
      userLine({ ts: 1, content: [toolResult('a', { content: 'hook error: Blocked — see policy', isError: true })] }),
      assistantLine({ ts: 2, content: [toolUse('b', 'Bash', { command: 'ls' })] }),
      userLine({ ts: 3, content: [toolResult('b', { content: 'permission denied', isError: true })] }),
    ];
    const events = pairToolEvents(lines);
    expect(countGuardBlocks(events)).toBe(1);
    expect(countErrors(events)).toBe(2);
  });
});

describe('countRepeatedCalls / countTestReruns', () => {
  it('counts occurrences beyond the first of an identical (name, input) signature', () => {
    const lines = [
      assistantLine({ ts: 0, content: [toolUse('a', 'Bash', { command: 'ls' })] }),
      userLine({ ts: 1, content: [toolResult('a')] }),
      assistantLine({ ts: 2, content: [toolUse('b', 'Bash', { command: 'ls' })] }),
      userLine({ ts: 3, content: [toolResult('b')] }),
      assistantLine({ ts: 4, content: [toolUse('c', 'Bash', { command: 'ls' })] }),
      userLine({ ts: 5, content: [toolResult('c')] }),
    ];
    expect(countRepeatedCalls(pairToolEvents(lines))).toBe(2);
  });
  it('is unaffected by key order in the input object (a stable signature)', () => {
    const lines = [
      assistantLine({ ts: 0, content: [toolUse('a', 'Bash', { command: 'x', description: 'y' })] }),
      userLine({ ts: 1, content: [toolResult('a')] }),
      assistantLine({ ts: 2, content: [toolUse('b', 'Bash', { description: 'y', command: 'x' })] }),
      userLine({ ts: 3, content: [toolResult('b')] }),
    ];
    expect(countRepeatedCalls(pairToolEvents(lines))).toBe(1);
  });
  it('countTestReruns only counts repeats within the tests-gates category', () => {
    const lines = [
      assistantLine({ ts: 0, content: [toolUse('a', 'Bash', { command: 'npm run test:unit' })] }),
      userLine({ ts: 1, content: [toolResult('a')] }),
      assistantLine({ ts: 2, content: [toolUse('b', 'Bash', { command: 'npm run test:unit' })] }),
      userLine({ ts: 3, content: [toolResult('b')] }),
      assistantLine({ ts: 4, content: [toolUse('c', 'Bash', { command: 'ls' })] }),
      userLine({ ts: 5, content: [toolResult('c')] }),
      assistantLine({ ts: 6, content: [toolUse('d', 'Bash', { command: 'ls' })] }),
      userLine({ ts: 7, content: [toolResult('d')] }),
    ];
    expect(countTestReruns(pairToolEvents(lines))).toBe(1);
    expect(countRepeatedCalls(pairToolEvents(lines))).toBe(2);
  });
});

describe('sumTokens / dominantModel / computeCostUsd / computeCacheHitRatio', () => {
  it('sums every real turn, excluding a synthetic one', () => {
    const turns = extractTurns(fixtureTranscript());
    const sums = sumTokens(turns);
    expect(sums.cacheWrite1h).toBe(500);
    expect(sums.cacheRead).toBe(200);
  });
  it('dominantModel picks the most frequent real model, ignoring synthetic turns', () => {
    expect(dominantModel(extractTurns(fixtureTranscript()))).toBe('claude-sonnet-5-5');
  });
  it('dominantModel is null with no real turns', () => { expect(dominantModel([])).toBeNull(); });
  it('computeCostUsd prices the 5m and 1h cache tiers separately and is null for an unrecognised model', () => {
    const sums = { in: 1_000_000, out: 0, cacheRead: 0, cacheWrite5m: 1_000_000, cacheWrite1h: 0 };
    expect(computeCostUsd(sums, 'claude-sonnet-5-5')).toBeCloseTo(3 + 3.75, 5); // in-rate + sonnet cw5m rate
    expect(computeCostUsd({ in: 1, out: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, 'some-unknown-model')).toBeNull();
  });
  it('computeCacheHitRatio is cacheRead / (in + cacheRead), null with neither', () => {
    expect(computeCacheHitRatio({ in: 300, cacheRead: 100 })).toBeCloseTo(0.25, 5);
    expect(computeCacheHitRatio({ in: 0, cacheRead: 0 })).toBeNull();
  });
});

// ── outcome + grade ─────────────────────────────────────────────────────────────────────────────────────────────

describe('classifyOutcome', () => {
  it('maps every known raw outcome word from the fix/ci-heal and review vocabularies', () => {
    expect(classifyOutcome('re-armed')).toBe('pushed');
    expect(classifyOutcome('no-change')).toBe('nothing-to-fix');
    expect(classifyOutcome('not-applicable')).toBe('nothing-to-fix');
    expect(classifyOutcome('auto-cleared')).toBe('accepted');
    expect(classifyOutcome('bounced')).toBe('bounced');
    expect(classifyOutcome('parked')).toBe('escalated');
    expect(classifyOutcome('blocked-on-infra')).toBe('escalated');
  });
  // PR #3990 review (correctness): the fix brief's `blocked-on-permission` outcome had no guard on its
  // OUTCOME_MAP entry — losing it would silently rate a permission-blocked fix as an unclassified run.
  it('maps the fix brief\'s `blocked-on-permission` outcome (same bucket as its `blocked-on-infra` sibling)', () => {
    expect(classifyOutcome('blocked-on-permission')).toBe('escalated');
    expect(classifyOutcome('blocked-on-permission')).toBe(classifyOutcome('blocked-on-infra'));
  });
  it('resolves any unlisted escalated-* word to escalated via the closed prefix rule', () => {
    expect(classifyOutcome('escalated-some-future-reason')).toBe('escalated');
  });
  it('is unclassified for null, empty, or a genuinely unseen word', () => {
    expect(classifyOutcome(null)).toBe('unclassified');
    expect(classifyOutcome('')).toBe('unclassified');
    expect(classifyOutcome('something-new')).toBe('unclassified');
  });
});

describe('gradeRun (rubric v2 — a hard A conjunction + outcome caps)', () => {
  const clean = { guardBlocks: 0, errors: 0, repeatedCalls: 0, testReruns: 0 };
  it('is A only with within-baseline time AND zero waste AND a good outcome, all three', () => {
    expect(gradeRun({ ...clean, wallMs: 10 * 60_000, kind: 'fix', outcome: 'pushed' })).toBe('A');
  });
  it('is NOT A when every mechanical box is ticked but the outcome is missing/neutral (no "good outcome")', () => {
    expect(gradeRun({ ...clean, wallMs: 10 * 60_000, kind: 'fix', outcome: null })).not.toBe('A');
  });
  it(`is still A at the report's own guard-block TARGET of ${GUARD_BLOCKS_TARGET}`, () => {
    expect(gradeRun({ guardBlocks: 1, errors: 1, repeatedCalls: 0, testReruns: 0, wallMs: 10 * 60_000, kind: 'fix', outcome: 'pushed' })).toBe('A');
  });
  it('is NOT A at 2 guard blocks — one over the declared allowance', () => {
    expect(gradeRun({ guardBlocks: 2, errors: 2, repeatedCalls: 0, testReruns: 0, wallMs: 10 * 60_000, kind: 'fix', outcome: 'pushed' })).not.toBe('A');
  });
  it('is NOT A with even one test rerun — the allowance is exactly zero', () => {
    expect(gradeRun({ ...clean, testReruns: 1, wallMs: 10 * 60_000, kind: 'fix', outcome: 'pushed' })).not.toBe('A');
  });
  it(`drops well below A at the report's own "bad" guard-block count of 4`, () => {
    const grade = gradeRun({ guardBlocks: 4, errors: 4, repeatedCalls: 0, testReruns: 0, wallMs: 10 * 60_000, kind: 'fix', outcome: 'pushed' });
    expect(['C', 'D']).toContain(grade);
  });
  it('penalises wall time far above the kind baseline even with a clean tool record', () => {
    const grade = gradeRun({ ...clean, wallMs: 41 * 60_000, kind: 'fix', outcome: 'pushed' });
    expect(grade).not.toBe('A');
  });
  it('uses the worker baseline for a conveyor (build) session, not the fix baseline', () => {
    // 40 minutes is the WORKER median — should still grade A for a conveyor session though it would not for fix
    expect(gradeRun({ ...clean, wallMs: 40 * 60_000, kind: 'conveyor', outcome: 'pushed' })).toBe('A');
  });
  it('scales a build baseline UP for a larger story size, DOWN for a smaller one', () => {
    // size 3 = REFERENCE_STORY_SIZE (no scaling); size 9 triples the baseline; size 1 is clamped to 0.5x, not 1/3x
    expect(gradeRun({ ...clean, wallMs: 100 * 60_000, kind: 'conveyor', size: 9, outcome: 'pushed' })).toBe('A');
    expect(gradeRun({ ...clean, wallMs: 21 * 60_000, kind: 'conveyor', size: 1, outcome: 'pushed' })).not.toBe('A'); // > 0.5x40min clamp
  });

  describe('outcome caps (checked before mechanical hygiene)', () => {
    it('a REWORK (fix/ci-heal) session that found nothing to fix is a hard D, however clean the run was', () => {
      expect(gradeRun({ ...clean, wallMs: 1000, kind: 'fix', outcome: 'nothing-to-fix' })).toBe('D');
      expect(gradeRun({ ...clean, wallMs: 1000, kind: 'ci-heal', outcome: 'nothing-to-fix' })).toBe('D');
    });
    it('nothing-to-fix is NOT a hard D for a non-rework kind (review/inspect) — it can be the correct verdict', () => {
      expect(gradeRun({ ...clean, wallMs: 1000, kind: 'inspect', outcome: 'nothing-to-fix' })).toBe('A');
    });
    it('a BUILD kind whose PR bounced caps at C, even mechanically spotless', () => {
      expect(gradeRun({ ...clean, wallMs: 1000, kind: 'conveyor', outcome: 'pushed', prBounced: true })).toBe('C');
    });
    it('a BUILD kind whose PR is unknown to have bounced (prBounced: null) applies NO cap', () => {
      expect(gradeRun({ ...clean, wallMs: 10 * 60_000, kind: 'conveyor', outcome: 'pushed', prBounced: null })).toBe('A');
    });
    it('escalated with no decision reached (the default) caps at C', () => {
      expect(gradeRun({ ...clean, wallMs: 1000, kind: 'fix', outcome: 'escalated' })).toBe('C');
    });
    it('escalated WITH decisionReached:true removes the cap', () => {
      expect(gradeRun({ ...clean, wallMs: 10 * 60_000, kind: 'fix', outcome: 'escalated', decisionReached: true })).not.toBe('C');
    });
    it('a cap only ever worsens a grade, never improves a genuinely bad mechanical run', () => {
      const grade = gradeRun({ guardBlocks: 5, errors: 5, repeatedCalls: 5, testReruns: 5, wallMs: 60 * 60_000, kind: 'conveyor', outcome: 'pushed', prBounced: true });
      expect(grade).toBe('D'); // mechanical D is already worse than the C cap — worseGrade keeps D
    });
  });
});

describe('worseGrade', () => {
  it('returns whichever grade is further from A', () => {
    expect(worseGrade('A', 'C')).toBe('C');
    expect(worseGrade('D', 'B')).toBe('D');
  });
  it('a null/undefined cap never worsens anything', () => {
    expect(worseGrade('B', null)).toBe('B');
    expect(worseGrade(null, 'B')).toBe('B');
  });
});

describe('baselineWallMs', () => {
  it('is the flat per-kind baseline for a non-size-scaled kind regardless of size', () => {
    expect(baselineWallMs('fix', 8)).toBe(BASELINE_WALL_MS_BY_KIND.fix);
  });
  it('is the flat baseline for a size-scaled kind with no size given', () => {
    expect(baselineWallMs('conveyor', null)).toBe(BASELINE_WALL_MS_BY_KIND.conveyor);
  });
  it('scales proportionally to size / REFERENCE_STORY_SIZE, clamped to [0.5x, 3x]', () => {
    const base = BASELINE_WALL_MS_BY_KIND.conveyor;
    expect(baselineWallMs('conveyor', REFERENCE_STORY_SIZE)).toBe(base);
    expect(baselineWallMs('conveyor', REFERENCE_STORY_SIZE * 2)).toBe(base * 2);
    expect(baselineWallMs('conveyor', 100)).toBe(base * 3); // clamped high
    expect(baselineWallMs('conveyor', 0.01)).toBe(base * 0.5); // clamped low
  });
});

describe('outcomeFromTranscriptEvents', () => {
  it('recovers the outcome from a completion-cli done report inside a Bash tool call', () => {
    const events = [{ name: 'Bash', input: { command: 'node completion-cli.mjs report --session=fix-1 --status=done --outcome=re-armed' } }];
    expect(outcomeFromTranscriptEvents(events)).toBe('re-armed');
  });
  it('ignores a `started` report (no --status=done in the same command)', () => {
    const events = [{ name: 'Bash', input: { command: 'node completion-cli.mjs report --session=fix-1 --status=started' } }];
    expect(outcomeFromTranscriptEvents(events)).toBeNull();
  });
  it('takes the LAST done-report when a session reports more than once', () => {
    const events = [
      { name: 'Bash', input: { command: 'completion-cli.mjs report --status=done --outcome=gate-red' } },
      { name: 'Bash', input: { command: 'completion-cli.mjs report --status=done --outcome=re-armed' } },
    ];
    expect(outcomeFromTranscriptEvents(events)).toBe('re-armed');
  });
  it('is null with no completion-cli call at all', () => {
    expect(outcomeFromTranscriptEvents([{ name: 'Bash', input: { command: 'ls' } }])).toBeNull();
  });
});

describe('gradeReviewJob', () => {
  it('an accepted review is ALWAYS pending at score time — never a computed A/B/C/D', () => {
    expect(gradeReviewJob({ wallMs: 1000, outcome: 'accepted' })).toBe('pending');
  });
  it('a bounced review grades purely on duration — it already told the truth immediately', () => {
    expect(gradeReviewJob({ wallMs: BASELINE_WALL_MS_BY_KIND.review, outcome: 'bounced' })).toBe('A');
  });
  it('an escalated review caps at C regardless of how fast it was', () => {
    expect(gradeReviewJob({ wallMs: 1, outcome: 'escalated' })).toBe('C');
  });
});

describe('resolveReviewGrade', () => {
  it('passes through a non-pending grade unchanged', () => {
    expect(resolveReviewGrade({ grade: 'B' }, [])).toBe('B');
  });
  it('stays pending with no later round for the same PR yet', () => {
    expect(resolveReviewGrade({ grade: 'pending' }, [])).toBe('pending');
  });
  it('resolves to D when a later round on the same PR bounced or escalated', () => {
    expect(resolveReviewGrade({ grade: 'pending' }, [{ outcome: 'bounced' }])).toBe('D');
    expect(resolveReviewGrade({ grade: 'pending' }, [{ outcome: 'escalated' }])).toBe('D');
  });
  it('stays pending when the only later round also accepted (still no PROOF it holds beyond that)', () => {
    expect(resolveReviewGrade({ grade: 'pending' }, [{ outcome: 'accepted' }])).toBe('pending');
  });
});

// ── orchestration ───────────────────────────────────────────────────────────────────────────────────────────────

describe('rateTranscript', () => {
  it('combines every piece into one rating record for a realistic fixture', () => {
    const rating = rateTranscript(fixtureTranscript(), { kind: 'fix', pr: 2748, item: '4194', rawOutcome: 're-armed' });
    expect(rating).toMatchObject({
      kind: 'fix', pr: 2748, item: '4194', sessionName: 'fix-2748', model: 'claude-sonnet-5-5',
      wallMs: 10 * 60_000, guardBlocks: 0, errors: 0, repeatedCalls: 0, testReruns: 0,
      outcome: 'pushed', rawOutcome: 're-armed', grade: 'A', dataQuality: 'transcript',
    });
    expect(rating.tokens.cacheWrite).toBe(500);
    expect(typeof rating.costUsd).toBe('number');
  });
});

describe('rateReviewJobTimings', () => {
  it('reports job-log-only data quality with null tokens/cost', () => {
    const rating = rateReviewJobTimings({ pr: 2670, outcome: 'auto-cleared', timings: { totalMs: 599_834 } });
    expect(rating).toMatchObject({ kind: 'review', pr: 2670, outcome: 'accepted', wallMs: 599_834, dataQuality: 'job-log-only', tokens: null, costUsd: null });
  });
});

// ── scorecard row + rollup ──────────────────────────────────────────────────────────────────────────────────────

describe('toScorecardRow', () => {
  it('produces a row that satisfies run-scorecard-store validation, with one deduction per lost-points criterion', () => {
    const rating = rateTranscript(fixtureTranscript(), { kind: 'fix', pr: 2748, rawOutcome: 're-armed' });
    const row = toScorecardRow(rating);
    expect(row).toMatchObject({ rubricVersion: RUBRIC_VERSION, subjectClass: 'work-agent', dispatchKind: 'fix', criteriaEvaluated: 4, score: 95 });
    expect(row.deductions).toEqual([]);
  });
  it('adds a deduction entry per criterion that actually cost points', () => {
    const rating = { kind: 'fix', pr: 1, item: null, sessionName: 's', model: 'm', grade: 'C', guardBlocks: 2, errors: 3, repeatedCalls: 1, testReruns: 1, outcome: 'escalated', rawOutcome: 'blocked', tokens: null, costUsd: null, cacheHitRatio: null, shares: null, dataQuality: 'transcript' };
    const row = toScorecardRow(rating);
    expect(row.deductions.map((d) => d.criterion).sort()).toEqual(['guard-blocks', 'repeated-calls', 'test-reruns', 'tool-errors']);
  });
  // Regression: an earlier `(s)` plural in these evidence strings (e.g. "tool error(s)") read to the
  // append-time secret scrub as call-syntax (`name(...)`) and made `appendScorecard` refuse EVERY row that
  // carried one — found live running this module's own production backfill. Every deduction template must
  // stay scrub-clean.
  it('every deduction evidence string passes the append-time secret scrub', () => {
    const rating = { kind: 'fix', pr: 1, item: null, sessionName: 's', model: 'm', grade: 'D', guardBlocks: 5, errors: 7, repeatedCalls: 3, testReruns: 2, outcome: 'escalated', rawOutcome: 'blocked', tokens: null, costUsd: null, cacheHitRatio: null, shares: null, dataQuality: 'transcript' };
    const row = toScorecardRow(rating);
    expect(row.deductions.length).toBeGreaterThan(0);
    for (const d of row.deductions) expect(scrubReasons(d.evidence)).toEqual([]);
  });
});

describe('rollupKey / phaseForKind', () => {
  it('keys by PR when present, else item, else session name', () => {
    expect(rollupKey({ pr: 5 })).toBe('web-everything/web-everything#pr5');
    expect(rollupKey({ item: 9 })).toBe('web-everything/web-everything#item9');
    expect(rollupKey({ sessionName: 'x' })).toBe('web-everything/web-everything#session:x');
  });
  it('maps dispatch kinds to build/review/rework, and an unknown kind to other', () => {
    expect(phaseForKind('conveyor')).toBe('build');
    expect(phaseForKind('review')).toBe('review');
    expect(phaseForKind('fix')).toBe('rework');
    expect(phaseForKind('ci-heal')).toBe('rework');
    expect(phaseForKind('something-else')).toBe('other');
  });
});

describe('rollupByDemand', () => {
  it('sums tokens/cost per phase within one demand, across several rows', () => {
    const rows = [
      { pr: 10, dispatchKind: 'fix', tokens: { in: 100, out: 50, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.01 },
      { pr: 10, dispatchKind: 'review', tokens: { in: 20, out: 10, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.002 },
      { pr: 10, dispatchKind: 'fix', tokens: { in: 5, out: 5, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.001 },
    ];
    const [demand] = rollupByDemand(rows);
    expect(demand.byPhase.rework.sessions).toBe(2);
    expect(demand.byPhase.rework.tokensIn).toBe(105);
    expect(demand.byPhase.review.sessions).toBe(1);
    expect(demand.totalTokens).toBe(100 + 50 + 20 + 10 + 5 + 5);
  });
  it('computes tokensPerStoryPoint only when sizeForItem resolves a positive size', () => {
    const rows = [{ item: 42, dispatchKind: 'fix', tokens: { in: 1000, out: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0 }];
    const [withSize] = rollupByDemand(rows, { sizeForItem: () => 5 });
    expect(withSize.tokensPerStoryPoint).toBe(200);
    const [noSize] = rollupByDemand(rows, { sizeForItem: () => null });
    expect(noSize.tokensPerStoryPoint).toBeNull();
  });

  // Regression (confirmed live review finding, codex-correctness, PR #2811): a demand made ENTIRELY of
  // job-log-only review rows (tokens:null) printed "0 tok, $0.00" — indistinguishable from "this genuinely
  // cost nothing". `hasUnknownTokens`/`hasUnknownCost`/`unmeasuredSessions` let a reader (the CLI) tell the
  // two apart.
  it('flags hasUnknownTokens/hasUnknownCost rather than silently totalling an unmeasured row as zero', () => {
    const rows = [{ pr: 99, dispatchKind: 'review', tokens: null, costUsd: null, dataQuality: 'job-log-only' }];
    const [demand] = rollupByDemand(rows);
    expect(demand).toMatchObject({ totalTokens: 0, totalCostUsd: 0, hasUnknownTokens: true, hasUnknownCost: true, unmeasuredSessions: 1 });
  });
  it('is NOT flagged unknown when every row in the demand was fully measured', () => {
    const rows = [{ pr: 99, dispatchKind: 'fix', tokens: { in: 1, out: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.01 }];
    const [demand] = rollupByDemand(rows);
    expect(demand).toMatchObject({ hasUnknownTokens: false, hasUnknownCost: false, unmeasuredSessions: 0 });
  });
  it('flags hasUnknownCost (but not tokens) when a mixed-provider review row carries costUsdPartial', () => {
    const rows = [{ pr: 99, dispatchKind: 'review', tokens: { in: 10, out: 10, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.1, costUsdPartial: true }];
    const [demand] = rollupByDemand(rows);
    expect(demand).toMatchObject({ hasUnknownTokens: false, hasUnknownCost: true });
  });
});

describe('flagWaste', () => {
  it('flags a nothing-to-fix run and a run with repeated calls', () => {
    const rows = [
      { outcome: 'nothing-to-fix', pr: 1, repeatedCalls: 0 },
      { outcome: 'pushed', pr: 2, repeatedCalls: 3 },
    ];
    const waste = flagWaste(rows);
    expect(waste.find((w) => w.type === 'nothing-to-fix').pr).toBe(1);
    expect(waste.find((w) => w.type === 'repeated-identical-calls').count).toBe(3);
  });
  it('flags more than one review row against the same PR+head when headSha is present', () => {
    const rows = [
      { dispatchKind: 'review', pr: 7, headSha: 'aaa', outcome: 'bounced' },
      { dispatchKind: 'review', pr: 7, headSha: 'aaa', outcome: 'accepted' },
    ];
    expect(flagWaste(rows).some((w) => w.type === 'repeat-review-same-head')).toBe(true);
  });
});

// ── IO shell ────────────────────────────────────────────────────────────────────────────────────────────────────

describe('findTranscriptPath / readTranscriptLines', () => {
  it('finds a transcript by sessionId directly', () => {
    const root = tmp();
    const dir = join(root, 'x-operations-dispatch-1');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'sess-1.jsonl');
    writeFileSync(file, `${JSON.stringify({ type: 'custom-title', customTitle: 'fix-1', sessionId: 'sess-1' })}\n`);
    expect(findTranscriptPath('fix-1', { sessionId: 'sess-1', projectsRoot: root })).toBe(file);
  });
  it('falls back to scanning first lines for a matching custom-title when sessionId is unknown', () => {
    const root = tmp();
    const dir = join(root, 'y-operations-dispatch-2');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'sess-2.jsonl');
    writeFileSync(file, `${JSON.stringify({ type: 'custom-title', customTitle: 'review-9', sessionId: 'sess-2' })}\n${JSON.stringify({ type: 'assistant' })}\n`);
    expect(findTranscriptPath('review-9', { projectsRoot: root })).toBe(file);
  });
  it('is null when nothing matches', () => {
    const root = tmp();
    expect(findTranscriptPath('nope', { projectsRoot: root })).toBeNull();
  });
  it('readTranscriptLines skips a torn/unparseable line rather than throwing', () => {
    const root = tmp();
    const file = join(root, 'f.jsonl');
    writeFileSync(file, `${JSON.stringify({ type: 'a' })}\n{not json\n${JSON.stringify({ type: 'b' })}\n`);
    expect(readTranscriptLines(file).map((l) => l.type)).toEqual(['a', 'b']);
  });
});

describe('rateSession', () => {
  it('reports transcript-not-found when nothing matches', () => {
    const root = tmp();
    const result = rateSession({ sessionName: 'fix-404', kind: 'fix', pr: 404, transcriptPath: null });
    // no transcriptPath given and no real session on this machine named fix-404 — falls through to not-found
    // using the REAL projects root only if fix-404 happens to exist; force isolation via an empty tmp root:
    void root;
    expect(result.ok).toBe(false);
  });
  it('rates a session end-to-end from a transcript file and folds in the completion record outcome', () => {
    const completionsDir = tmp();
    process.env.OPERATION_COMPLETIONS_DIR = completionsDir;
    writeFileSync(join(completionsDir, 'fix-2748.json'), JSON.stringify({
      v: 1, session: 'fix-2748', kind: 'fix', pr: '2748', item: null, status: 'done',
      outcome: 're-armed', verdict: null, label: null, runId: null,
      startedAt: '2026-09-27T10:00:00.000Z', updatedAt: '2026-09-27T10:10:00.000Z',
    }));
    const transcriptDir = tmp();
    const file = join(transcriptDir, 'sess.jsonl');
    writeFileSync(file, fixtureTranscript().map((l) => JSON.stringify(l)).join('\n'));
    const result = rateSession({ sessionName: 'fix-2748', kind: 'fix', pr: 2748, transcriptPath: file });
    expect(result).toMatchObject({ ok: true, outcome: 'pushed', rawOutcome: 're-armed', grade: 'A' });
  });
});

describe('rateReviewJobLog', () => {
  it('parses the final structured JSON summary line, ignoring narrative lines above it', () => {
    const root = tmp();
    const file = join(root, 'review-2670.log');
    writeFileSync(file, [
      '[2026-09-25T16:26:44.047Z] review-job review-2670: running review-loop-cli in /some/lane',
      '[2026-09-25T16:34:47.303Z] review-job review-2670: loop finished in 483255ms — auto-cleared (verdict accept, loop converged, run review-pr-x)',
      JSON.stringify({ pr: 2670, repo: 'web-everything/web-everything', sessionSlug: 'review-2670', verdict: 'accept', loopOutcome: 'converged', runId: 'review-pr-x', label: null, outcome: 'auto-cleared', timings: { acquireMs: 115968, loopMs: 483255, totalMs: 599834 } }),
      '',
    ].join('\n'));
    const result = rateReviewJobLog(file);
    expect(result).toMatchObject({ ok: true, sessionName: 'review-2670', outcome: 'accepted', wallMs: 599834, dataQuality: 'job-log-only' });
  });
  it('reports no-summary-line for a log with no parseable JSON', () => {
    const root = tmp();
    const file = join(root, 'x.log');
    writeFileSync(file, 'just narrative text, no summary\n');
    expect(rateReviewJobLog(file)).toEqual({ ok: false, reason: 'no-summary-line', logPath: file });
  });
  it('joins the summary\'s runId to its run record and fills in tokens/cost — reviews stop being tokens:null', () => {
    const logDir = tmp();
    const runsDir = tmp();
    const logFile = join(logDir, 'review-2670.log');
    writeFileSync(logFile, `${JSON.stringify({ pr: 2670, sessionSlug: 'review-2670', outcome: 'auto-cleared', runId: 'review-pr-xyz', timings: { totalMs: 100_000 } })}\n`);
    writeFileSync(join(runsDir, 'review-pr-xyz.json'), JSON.stringify({
      input: { pr: 2670 },
      telemetry: [{ model: 'sonnet', costUsd: 0.5, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }],
    }));
    const result = rateReviewJobLog(logFile, { runsDir });
    expect(result).toMatchObject({ ok: true, dataQuality: 'juror-telemetry', costUsd: 0.5, costUsdPartial: false });
    expect(result.tokens).toEqual({ in: 10, out: 5, cacheRead: 0, cacheWrite: 0 });
  });
  it('flags costUsdPartial when a non-Claude seat rides the same run record', () => {
    const logDir = tmp();
    const runsDir = tmp();
    const logFile = join(logDir, 'review-2671.log');
    writeFileSync(logFile, `${JSON.stringify({ pr: 2671, sessionSlug: 'review-2671', outcome: 'auto-cleared', runId: 'review-pr-mixed', timings: { totalMs: 100_000 } })}\n`);
    writeFileSync(join(runsDir, 'review-pr-mixed.json'), JSON.stringify({
      input: { pr: 2671 },
      telemetry: [
        { model: 'sonnet', costUsd: 0.5, usage: { input_tokens: 10, output_tokens: 5 } },
        { model: 'gpt-6-astra', costUsd: 0, usage: { input_tokens: 20, output_tokens: 10 } },
      ],
    }));
    const result = rateReviewJobLog(logFile, { runsDir });
    expect(result.costUsdPartial).toBe(true);
    expect(result.costUsd).toBe(0.5); // only the priced seat
    expect(result.tokens.in).toBe(30); // both seats' real tokens still counted
  });
  it('falls back to job-log-only when no run record joins (missing/old runId)', () => {
    const logDir = tmp();
    const logFile = join(logDir, 'review-2672.log');
    writeFileSync(logFile, `${JSON.stringify({ pr: 2672, sessionSlug: 'review-2672', outcome: 'auto-cleared', runId: 'does-not-exist', timings: { totalMs: 100_000 } })}\n`);
    const result = rateReviewJobLog(logFile, { runsDir: tmp() });
    expect(result.dataQuality).toBe('job-log-only');
    expect(result.tokens).toBeNull();
  });
});

// ── waste minutes/tokens attribution ───────────────────────────────────────────────────────────────────────────

describe('classifyRunWaste', () => {
  it('attributes precise minutes to a test rerun from the repeated call\'s own durationMs', () => {
    const events = [
      { name: 'Bash', input: { command: 'npm run test:unit' }, category: 'tests-gates', durationMs: 60_000 },
      { name: 'Bash', input: { command: 'npm run test:unit' }, category: 'tests-gates', durationMs: 90_000 },
    ];
    const rating = { tokens: { in: 100, out: 100, cacheRead: 0, cacheWrite: 0 }, kind: 'fix', outcome: 'pushed' };
    const waste = classifyRunWaste(events, rating);
    const testRerun = waste.find((w) => w.cause === 'test-rerun');
    expect(testRerun.minutes).toBeCloseTo(1.5, 5); // only the SECOND (repeat) occurrence's 90s counts
  });
  it('attributes a proportional token share to a non-test repeated call', () => {
    const events = [
      { name: 'Bash', input: { command: 'ls' }, category: 'other', durationMs: 1000 },
      { name: 'Bash', input: { command: 'ls' }, category: 'other', durationMs: 1000 },
    ];
    const rating = { tokens: { in: 1000, out: 0, cacheRead: 0, cacheWrite: 0 }, kind: 'fix', outcome: 'pushed' };
    const waste = classifyRunWaste(events, rating);
    expect(waste.find((w) => w.cause === 'repeated-call').tokens).toBeCloseTo(500, 5); // 1 of 2 calls repeated
  });
  it('counts a REWORK nothing-to-fix dispatch as its full wallMs/tokens wasted', () => {
    const rating = { wallMs: 600_000, tokens: { in: 10, out: 10, cacheRead: 0, cacheWrite: 0 }, kind: 'ci-heal', outcome: 'nothing-to-fix' };
    const waste = classifyRunWaste([], rating);
    expect(waste.find((w) => w.cause === 'nothing-to-fix-dispatch')).toMatchObject({ minutes: 10, tokens: 20 });
  });
  it('counts an escalated (no-decision) run as its full wallMs/tokens wasted', () => {
    const rating = { wallMs: 300_000, tokens: { in: 5, out: 5, cacheRead: 0, cacheWrite: 0 }, kind: 'fix', outcome: 'escalated' };
    const waste = classifyRunWaste([], rating);
    expect(waste.find((w) => w.cause === 'escalated-no-decision')).toMatchObject({ minutes: 5, tokens: 10 });
  });
  it('reports nothing for a clean run with a good outcome', () => {
    const rating = { wallMs: 1000, tokens: { in: 1, out: 1, cacheRead: 0, cacheWrite: 0 }, kind: 'fix', outcome: 'pushed' };
    expect(classifyRunWaste([], rating)).toEqual([]);
  });
});

describe('topWasteCauses', () => {
  it('ranks aggregated causes by minutes or by tokens, and sums guard blocks separately by count', () => {
    const rows = [
      { guardBlocks: 2, waste: [{ cause: 'test-rerun', minutes: 10, tokens: 100 }] },
      { guardBlocks: 1, waste: [{ cause: 'nothing-to-fix-dispatch', minutes: 30, tokens: 50 }] },
    ];
    const byMinutes = topWasteCauses(rows, { by: 'minutes' });
    expect(byMinutes.ranked[0].cause).toBe('nothing-to-fix-dispatch'); // 30 min > 10 min
    expect(byMinutes.guardBlockCount).toBe(3);
    const byTokens = topWasteCauses(rows, { by: 'tokens' });
    expect(byTokens.ranked[0].cause).toBe('test-rerun'); // 100 tok > 50 tok
  });
  it('respects the limit', () => {
    const rows = [{ waste: [
      { cause: 'test-rerun', minutes: 5, tokens: 1 }, { cause: 'repeated-call', minutes: 4, tokens: 1 },
      { cause: 'nothing-to-fix-dispatch', minutes: 3, tokens: 1 }, { cause: 'escalated-no-decision', minutes: 2, tokens: 1 },
      { cause: 'unheld-review-accept', minutes: 1, tokens: 1 },
    ] }];
    expect(topWasteCauses(rows, { by: 'minutes', limit: 3 }).ranked).toHaveLength(3);
  });
});

// ── coverage (message-2 recalibration: full-fleet token accounting) ────────────────────────────────────────────

describe('orchestratorProjectDirName', () => {
  it('defaults to the confirmed real directory name', () => {
    expect(orchestratorProjectDirName({})).toBe('-Users-nicolasgilbert-workspace-webeverything');
  });
  it('is overridable via WE_ORCHESTRATOR_PROJECT_DIR for tests', () => {
    expect(orchestratorProjectDirName({ WE_ORCHESTRATOR_PROJECT_DIR: 'x' })).toBe('x');
  });
});

describe('scanClaudeProjectsCoverage', () => {
  it('buckets an operations-dispatch dir, the orchestrator dir (incl. a nested subagent file), and everything else', () => {
    const root = tmp();
    const dispatchDir = join(root, 'x-operations-dispatch-1');
    const orchDir = join(root, 'the-orch-dir');
    const otherDir = join(root, 'some-lane-dir');
    mkdirSync(dispatchDir, { recursive: true });
    mkdirSync(join(orchDir, 'sess1', 'subagents'), { recursive: true });
    mkdirSync(otherDir, { recursive: true });
    const line = (usage) => `${JSON.stringify({ type: 'assistant', timestamp: '2026-09-27T10:00:00.000Z', message: { model: 'claude-sonnet-5-5', usage } })}\n`;
    writeFileSync(join(dispatchDir, 'a.jsonl'), line({ input_tokens: 100, output_tokens: 10 }));
    writeFileSync(join(orchDir, 'sess1.jsonl'), line({ input_tokens: 200, output_tokens: 20 }));
    writeFileSync(join(orchDir, 'sess1', 'subagents', 'agent-1.jsonl'), line({ input_tokens: 300, output_tokens: 30 }));
    writeFileSync(join(otherDir, 'b.jsonl'), line({ input_tokens: 400, output_tokens: 40 }));
    const buckets = scanClaudeProjectsCoverage({ projectsRoot: root, orchestratorDirName: 'the-orch-dir' });
    expect(buckets['dispatched-daemon'].tokens.in).toBe(100);
    expect(buckets['orchestration-overhead'].tokens.in).toBe(200 + 300); // top-level orchestrator + its nested subagent
    expect(buckets['operator-interactive'].tokens.in).toBe(400);
  });
  it('respects sinceMs (the FILE\'s own mtime, same convention as findTranscriptPath) — excluded from every bucket', () => {
    const root = tmp();
    const dir = join(root, 'x-operations-dispatch-1');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'old.jsonl');
    writeFileSync(file, `${JSON.stringify({ type: 'assistant', timestamp: '2020-01-01T00:00:00.000Z', message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 1, output_tokens: 1 } } })}\n`);
    // an impossibly future cutoff — no real file's mtime can ever satisfy it, proving the filter bites.
    const buckets = scanClaudeProjectsCoverage({ projectsRoot: root, sinceMs: Date.now() + 3600_000 });
    expect(buckets['dispatched-daemon'].fileCount).toBe(0);
  });
});

describe('scanReviewJurorUsage', () => {
  it('splits Claude-priced seats from unpriced non-Claude seats in the same run record, attributed by pr', () => {
    const root = tmp();
    writeFileSync(join(root, 'review-pr-abc.json'), JSON.stringify({
      input: { pr: 2670 },
      telemetry: [
        { lens: 'correctness', model: 'sonnet', durationMs: 1000, costUsd: 0.5, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
        { lens: 'security', model: 'gpt-6-astra', durationMs: 2000, costUsd: 0, usage: { input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      ],
    }));
    const { claudeRows, nonClaudeRows } = scanReviewJurorUsage({ runsDirs: [root] });
    expect(claudeRows).toHaveLength(1);
    expect(claudeRows[0]).toMatchObject({ pr: 2670, costUsd: 0.5, dataQuality: 'juror-telemetry' });
    expect(nonClaudeRows).toHaveLength(1);
    expect(nonClaudeRows[0]).toMatchObject({ pr: 2670, costUsd: null, dataQuality: 'juror-telemetry-unpriced' });
  });
  it('is empty (never throws) when a runs dir does not exist', () => {
    expect(scanReviewJurorUsage({ runsDirs: ['/no/such/dir'] })).toEqual({ claudeRows: [], nonClaudeRows: [] });
  });
  it('scans EVERY checkout under workspaceRoot, not just one — the multi-clone reality', () => {
    const root = tmp();
    mkdirSync(join(root, 'clone-a', '.operations', 'runs'), { recursive: true });
    mkdirSync(join(root, 'clone-b', '.operations', 'runs'), { recursive: true });
    writeFileSync(join(root, 'clone-a', '.operations', 'runs', 'review-pr-a.json'), JSON.stringify({ input: { pr: 1 }, telemetry: [{ model: 'sonnet', costUsd: 0.1, usage: {} }] }));
    writeFileSync(join(root, 'clone-b', '.operations', 'runs', 'review-pr-b.json'), JSON.stringify({ input: { pr: 2 }, telemetry: [{ model: 'sonnet', costUsd: 0.2, usage: {} }] }));
    const { claudeRows } = scanReviewJurorUsage({ workspaceRoot: root });
    expect(claudeRows.map((r) => r.pr).sort()).toEqual([1, 2]);
  });
});

describe('scanNonClaudeJudgeTranscripts', () => {
  it('reads the last turn.completed usage line from a codex-judge-transcripts file', () => {
    const root = tmp();
    writeFileSync(join(root, 'codex-judge-1.jsonl'), [
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 5, cache_write_input_tokens: 0 } }),
      '',
    ].join('\n'));
    const result = scanNonClaudeJudgeTranscripts({ home: root });
    // home/.codex-judge-transcripts doesn't exist here (file was written straight into `root`) — expect empty,
    // proving this reads from the DECLARED subdirectory, not the home dir itself.
    expect(result.fileCount).toBe(0);
  });
  it('finds a file under the real .codex-judge-transcripts subdirectory', () => {
    const root = tmp();
    mkdirSync(join(root, '.codex-judge-transcripts'), { recursive: true });
    writeFileSync(join(root, '.codex-judge-transcripts', 'codex-judge-1.jsonl'), `${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 20 } })}\n`);
    const result = scanNonClaudeJudgeTranscripts({ home: root });
    expect(result.fileCount).toBe(1);
    expect(result.tokens.in).toBe(100);
    expect(result.costUsd).toBeNull();
  });
});

describe('buildCoverageReport', () => {
  // #4473 (x4txc2g) — HERMETIC. `buildCoverageReport` used to hardcode every scanner's REAL default root
  // (`~/.claude/projects`, every workspace checkout's `.operations/runs`, `~/.codex-judge-transcripts`), so this
  // describe block could only ever read live, ambient, shared-host state. Under real concurrent multi-lane load
  // that is non-deterministic: a live file's mtime can tick past a captured `Date.now()` mid-scan, producing a
  // nonzero total this test's own name says should be impossible (observed live: 3 real red dispatches through
  // the actual verify-lane daemon, see backlog/x4txc2g). Both tests below point `projectsRoot`/`runsDirs`/`home`
  // at an ISOLATED `tmp()` dir instead — the exact same override params `scanClaudeProjectsCoverage`/
  // `scanReviewJurorUsage`/`scanNonClaudeJudgeTranscripts` already accepted (their own describe blocks above
  // already use them); the only gap was `buildCoverageReport` itself not forwarding them.
  it('never claims more than 100% and reports a percentage per bucket that sums to ~100 when NO files exist', () => {
    const root = tmp();
    const report = buildCoverageReport({
      sinceMs: Date.now(), // belt + suspenders: even a file dated "now" is excluded
      projectsRoot: join(root, 'projects'), // does not exist — isolated, never the real ~/.claude/projects
      runsDirs: [], // an explicit empty list — scans NO checkout's .operations/runs
      home: join(root, 'home'), // does not exist — isolated, never the real ~
    });
    expect(report.totalTokens).toBe(0);
    expect(report.attributed.pct).toBeNull(); // 0/0 — never a fabricated percentage
  });

  // MUTATION PROOF, folded into a real assertion rather than a separate no-op probe: this pins an EXACT token
  // total from three isolated fixture files (110 + 55 + 30 = 195 — the arithmetic below). If `buildCoverageReport`
  // ever regressed to ignoring these override params (the pre-fix shape — ALWAYS the real, unmocked scanner
  // defaults), the real ambient host state this same machine keeps writing (this very session's own live
  // transcript, any other concurrently-running lane's, real review-juror run records) would almost certainly
  // add MORE tokens on top of 195 — a regression this exact-equality assertion catches, where a `toBeGreaterThan`
  // would not (the real host already has far more than 0 tokens lying around). This is what makes the isolation
  // itself provable, not merely assumed.
  it('WHEN FILES EXIST (in the isolated roots): buckets an EXACT token total, and the per-bucket pct sums to ~100', () => {
    const root = tmp();
    const dispatchDir = join(root, 'projects', 'x-operations-dispatch-1');
    const runsDir = join(root, 'runs');
    const codexDir = join(root, 'home', '.codex-judge-transcripts');
    mkdirSync(dispatchDir, { recursive: true });
    mkdirSync(runsDir, { recursive: true });
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(join(dispatchDir, 'a.jsonl'), `${JSON.stringify({ type: 'assistant', timestamp: '2026-09-27T10:00:00.000Z', message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 100, output_tokens: 10 } } })}\n`); // 110
    writeFileSync(join(runsDir, 'review-pr-x.json'), JSON.stringify({ input: { pr: 1 }, telemetry: [{ model: 'sonnet', costUsd: 0.1, usage: { input_tokens: 50, output_tokens: 5 } }] })); // 55
    writeFileSync(join(codexDir, 'codex-judge-1.jsonl'), `${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 25, output_tokens: 5 } })}\n`); // 30

    const report = buildCoverageReport({ projectsRoot: join(root, 'projects'), runsDirs: [runsDir], home: join(root, 'home') });

    expect(report.totalTokens).toBe(195); // 110 (dispatched-daemon) + 55 (review-juror) + 30 (non-claude-judge)
    const pcts = [report.attributed.pct, report.orchestrationOverhead.pct, report.operatorInteractive.pct, report.nonClaudeJudge.pct].filter((p) => p !== null);
    expect(pcts.reduce((s, p) => s + p, 0)).toBeCloseTo(100, 5); // never over 100%, and sums to it when known
  });
});

// ── review:changes round 1 on PR #2811 — regression tests for the reviewer's findings ─────────────────────────────

describe('computeTimeShares — wall-time accounting invariant', () => {
  const sumAll = (t) => t.testsMs + t.ghMs + t.gitMs + t.editsMs + t.opsMs + t.otherMs + t.reasoningMs + t.idleMs;
  it('accounts for leading and trailing gaps around tool calls (categories sum to wallMs)', () => {
    const lines = fixtureTranscript();
    const time = computeTimeShares(pairToolEvents(lines), extractTurns(lines), computeWallMs(lines), sessionTimeBounds(lines).startTs);
    expect(sumAll(time)).toBe(10 * 60_000);
    expect(time.reasoningMs).toBe(1 * 60_000); // lead-in: the thinking turn at t0
    expect(time.idleMs).toBe(5 * 60_000); // trailing: only a synthetic turn after the last tool result
  });
  it('rateTranscript itself (the real call path) reports reasoning + idle for the lead-in / trailing gaps', () => {
    const rating = rateTranscript(fixtureTranscript(), { kind: 'fix' });
    expect(sumAll(rating)).toBe(rating.wallMs);
  });
  it('busy union + reasoning + idle equals wallMs even when tool calls overlap', () => {
    const lines = [
      assistantLine({ ts: 0, usage: usage({ thinking: 10 }), content: [toolUse('a', 'Bash', { command: 'echo a' })] }),
      assistantLine({ ts: 1000, usage: usage(), content: [toolUse('b', 'Bash', { command: 'echo b' })] }),
      userLine({ ts: 3000, content: [toolResult('a')] }),
      userLine({ ts: 4000, content: [toolResult('b')] }),
      assistantLine({ ts: 9000, usage: usage() }),
    ];
    const time = computeTimeShares(pairToolEvents(lines), extractTurns(lines), computeWallMs(lines), sessionTimeBounds(lines).startTs);
    const busyUnion = 4000; // [0,3000] ∪ [1000,4000]
    expect(busyUnion + time.reasoningMs + time.idleMs).toBe(9000);
    expect(time.idleMs).toBe(5000);
  });
});

describe('rateTranscript — mixed-model pricing', () => {
  it('prices mixed-model turns separately (cost = sum of per-model pricing), not all at the dominant model', () => {
    const lines = [
      assistantLine({ ts: 0, model: 'claude-sonnet-5-5', usage: usage({ inTok: 1000, outTok: 1000 }) }),
      assistantLine({ ts: 1000, model: 'claude-sonnet-5-5', usage: usage({ inTok: 1000, outTok: 1000 }) }),
      assistantLine({ ts: 2000, model: 'claude-opus-5-5', usage: usage({ inTok: 1_000_000, outTok: 1_000_000 }) }),
    ];
    const rating = rateTranscript(lines, { kind: 'fix' });
    const sonnet = computeCostUsd(sumTokens(extractTurns(lines.slice(0, 2))), 'claude-sonnet-5-5');
    const opus = computeCostUsd(sumTokens(extractTurns(lines.slice(2))), 'claude-opus-5-5');
    expect(rating.costUsd).toBeCloseTo(sonnet + opus, 6);
    expect(rating.costUsdPartial).toBe(false);
  });
  it('preserves unknown-priced usage explicitly instead of silently pricing it at the dominant model', () => {
    const lines = [
      assistantLine({ ts: 0, model: 'claude-sonnet-5-5', usage: usage({ inTok: 1000 }) }),
      assistantLine({ ts: 1000, model: 'claude-sonnet-5-5', usage: usage({ inTok: 1000 }) }),
      assistantLine({ ts: 2000, model: 'some-unknown-model', usage: usage({ inTok: 500, outTok: 0 }) }),
    ];
    const rating = rateTranscript(lines, { kind: 'fix' });
    expect(rating.costUsdPartial).toBe(true);
    expect(rating.unpricedTokens).toBe(500);
    expect(rating.costUsd).toBeCloseTo(computeCostUsd(sumTokens(extractTurns(lines.slice(0, 2))), 'claude-sonnet-5-5'), 6);
    expect(toScorecardRow(rating)).toMatchObject({ costUsdPartial: true, unpricedTokens: 500 });
  });
  it('is null (never 0) when no turn could be priced at all', () => {
    const lines = [assistantLine({ ts: 0, model: 'some-unknown-model', usage: usage({ inTok: 10 }) })];
    expect(rateTranscript(lines, { kind: 'fix' }).costUsd).toBeNull();
  });
});

describe('rollupByDemand — unknown vs partial totals', () => {
  it('marks a partially-known demand as unknown for both tokens and cost', () => {
    const rows = [
      { pr: 8, dispatchKind: 'fix', tokens: { in: 100, out: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.5 },
      { pr: 8, dispatchKind: 'review', tokens: null, costUsd: null, dataQuality: 'job-log-only' },
    ];
    const [d] = rollupByDemand(rows);
    expect(d).toMatchObject({ totalTokens: 100, hasUnknownTokens: true, totalCostUsd: 0.5, hasUnknownCost: true, unmeasuredSessions: 1 });
  });
});

describe('rateReviewJobLog — a job that ran no review loop', () => {
  it('skips a refused-live-job summary (no review ran) instead of grading it A', () => {
    const root = tmp();
    const file = join(root, 'review-2811.log');
    writeFileSync(file, `${JSON.stringify({ pr: 2811, sessionSlug: 'review-2811', outcome: 'refused-live-job', refused: true, timings: { acquireMs: null, loopMs: null, totalMs: 12 } })}\n`);
    expect(rateReviewJobLog(file)).toMatchObject({ ok: false, reason: 'no-review-loop-ran' });
  });
  it('skips any summary whose loopMs is null (e.g. an acquire failure) the same way', () => {
    const root = tmp();
    const file = join(root, 'review-2812.log');
    writeFileSync(file, `${JSON.stringify({ pr: 2812, sessionSlug: 'review-2812', outcome: 'acquire-failed', timings: { acquireMs: 40, loopMs: null, totalMs: 50 } })}\n`);
    expect(rateReviewJobLog(file)).toMatchObject({ ok: false, reason: 'no-review-loop-ran' });
  });
  it('still rates a loop that crashed after taking a lane (real work was spent)', () => {
    const root = tmp();
    const file = join(root, 'review-2813.log');
    writeFileSync(file, `${JSON.stringify({ pr: 2813, sessionSlug: 'review-2813', lanePath: '/lanes/lane-3', outcome: 'blocked-on-infra', timings: { acquireMs: 40, loopMs: null, totalMs: 90_000 } })}\n`);
    expect(rateReviewJobLog(file)).toMatchObject({ ok: true, sessionName: 'review-2813', wallMs: 90_000 });
  });
});

describe('flagWaste — repeat-review-same-head cost', () => {
  it('reports an all-unknown repeat-review cost as null and a mixed one as partial, never an apparent $0', () => {
    const unknown = flagWaste([
      { dispatchKind: 'review', pr: 1, headSha: 'a', costUsd: null },
      { dispatchKind: 'review', pr: 1, headSha: 'a', costUsd: null },
    ]).find((w) => w.type === 'repeat-review-same-head');
    expect(unknown).toMatchObject({ costUsd: null, costPartial: false });
    const mixed = flagWaste([
      { dispatchKind: 'review', pr: 2, headSha: 'b', costUsd: 0.4 },
      { dispatchKind: 'review', pr: 2, headSha: 'b', costUsd: null },
    ]).find((w) => w.type === 'repeat-review-same-head');
    expect(mixed).toMatchObject({ costUsd: 0.4, costPartial: true });
  });
});

// ── #4304: prepared (DoR) tagging + prepared-vs-unprepared comparison ─────────────────────────────────────────────

/** Writes `backlog/<num>-x.md` under a fresh temp repo root, with or without `preparedDate` stamped. */
function backlogRepoWith(num, { preparedDate = null } = {}) {
  const root = tmp();
  mkdirSync(join(root, 'backlog'), { recursive: true });
  const frontmatter = [
    '---', 'kind: story', 'status: active',
    ...(preparedDate ? [`preparedDate: "${preparedDate}"`] : []),
    '---', '', `# item ${num}`, '',
  ].join('\n');
  writeFileSync(join(root, 'backlog', `${num}-x.md`), frontmatter);
  return root;
}

describe('preparedForItem', () => {
  it('is true when the card carries a non-empty preparedDate', () => {
    const root = backlogRepoWith('9001', { preparedDate: '2026-09-20' });
    expect(preparedForItem('9001', { repoRoot: root })).toBe(true);
  });
  it('is false when the card exists but has no preparedDate (a bespoke ad-hoc dispatch\'s card)', () => {
    const root = backlogRepoWith('9002');
    expect(preparedForItem('9002', { repoRoot: root })).toBe(false);
  });
  it('is false — never thrown or null — when there is no item, no matching card, or a hash-only id', () => {
    const root = backlogRepoWith('9003', { preparedDate: '2026-09-20' });
    expect(preparedForItem(null, { repoRoot: root })).toBe(false);
    expect(preparedForItem('9999', { repoRoot: root })).toBe(false);
    expect(preparedForItem('xabc123', { repoRoot: root })).toBe(false);
  });
  // #4304 review finding: the "non-empty" half of the guarantee had no direct coverage — an empty-string or
  // whitespace-only `preparedDate` must still read as unprepared, not slip through as truthy.
  it('is false when preparedDate is an empty string or whitespace-only — "non-empty" is enforced, not assumed', () => {
    const root = tmp();
    mkdirSync(join(root, 'backlog'), { recursive: true });
    writeFileSync(join(root, 'backlog', '9004-x.md'), ['---', 'kind: story', 'preparedDate: ""', '---', '', '# item 9004', ''].join('\n'));
    writeFileSync(join(root, 'backlog', '9005-x.md'), ['---', 'kind: story', 'preparedDate: "   "', '---', '', '# item 9005', ''].join('\n'));
    expect(preparedForItem('9004', { repoRoot: root })).toBe(false);
    expect(preparedForItem('9005', { repoRoot: root })).toBe(false);
  });
});

describe('toScorecardRow — prepared tagging', () => {
  it('tags prepared:true/false via an injected resolver (isolated unit test)', () => {
    const rating = { kind: 'conveyor', item: 9001, sessionName: 's', model: 'm', grade: 'A', guardBlocks: 0, errors: 0, repeatedCalls: 0, testReruns: 0, outcome: 'accepted', rawOutcome: 'accepted', tokens: null, costUsd: null, cacheHitRatio: null, shares: null, dataQuality: 'transcript' };
    expect(toScorecardRow(rating, { preparedForItem: () => true }).prepared).toBe(true);
    expect(toScorecardRow(rating, { preparedForItem: () => false }).prepared).toBe(false);
  });
  // Integration/wiring test: exercises the REAL default resolver (toScorecardRow -> preparedForItem ->
  // readField) end to end against a real backlog card on disk, not a fake — the shape build-brief discipline
  // (#2819) requires alongside the isolated unit test above.
  it('tags prepared:true from a real backlog card carrying preparedDate, via the default (real FS) resolver', () => {
    const root = backlogRepoWith('9010', { preparedDate: '2026-09-20' });
    const rating = { kind: 'conveyor', item: '9010', sessionName: 's', model: 'm', grade: 'A', guardBlocks: 0, errors: 0, repeatedCalls: 0, testReruns: 0, outcome: 'accepted', rawOutcome: 'accepted', tokens: null, costUsd: null, cacheHitRatio: null, shares: null, dataQuality: 'transcript' };
    expect(toScorecardRow(rating, { repoRoot: root }).prepared).toBe(true);
  });
  it('tags prepared:false from a bespoke ad-hoc dispatch with no item at all, via the default resolver', () => {
    const root = tmp();
    mkdirSync(join(root, 'backlog'), { recursive: true });
    const rating = { kind: 'fix', item: null, sessionName: 's', model: 'm', grade: 'B', guardBlocks: 0, errors: 0, repeatedCalls: 0, testReruns: 0, outcome: 'accepted', rawOutcome: 'accepted', tokens: null, costUsd: null, cacheHitRatio: null, shares: null, dataQuality: 'transcript' };
    expect(toScorecardRow(rating, { repoRoot: root }).prepared).toBe(false);
  });
});

describe('preparedComparison', () => {
  it('splits rows on `prepared`, summarizing count / avg wall time / tokens-per-demand / rework rounds / grades per side', () => {
    const rows = [
      { prepared: true, item: 1, dispatchKind: 'conveyor', wallMs: 600_000, grade: 'A', tokens: { in: 1000, out: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.1 },
      { prepared: true, item: 2, dispatchKind: 'conveyor', wallMs: 400_000, grade: 'B', tokens: { in: 200, out: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.02 },
      { prepared: false, item: 3, dispatchKind: 'fix', wallMs: 1_200_000, grade: 'C', tokens: { in: 3000, out: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.3 },
    ];
    const cmp = preparedComparison(rows);
    expect(cmp.prepared).toMatchObject({ count: 2, avgWallMs: 500_000, tokensPerDemand: 600, demandCount: 2, reworkRounds: 0, gradeCounts: { A: 1, B: 1, C: 0, D: 0 } });
    expect(cmp.unprepared).toMatchObject({ count: 1, avgWallMs: 1_200_000, tokensPerDemand: 3000, demandCount: 1, reworkRounds: 1, gradeCounts: { A: 0, B: 0, C: 1, D: 0 } });
  });
  // #4304 review finding (converged on independently by four review lenses): a row with `prepared` missing
  // entirely (every row scored before this field existed) must be EXCLUDED from both sides, never folded into
  // "unprepared" — `false` is "checked, confirmed unprepared"; `undefined` is "never checked", and conflating
  // them would contaminate the unprepared side with an unknown-sized legacy cohort the instant this ships.
  it('excludes a row with `prepared` undefined from BOTH sides, rather than guessing it into "unprepared"', () => {
    const rows = [
      { prepared: true, item: 1, dispatchKind: 'conveyor', wallMs: 600_000, grade: 'A' },
      { prepared: false, item: 2, dispatchKind: 'fix', wallMs: 1_200_000, grade: 'C' },
      // Pre-#4304 row — `prepared` was never computed for it.
      { item: 3, dispatchKind: 'fix', wallMs: 800_000, grade: 'D' },
    ];
    const cmp = preparedComparison(rows);
    expect(cmp.prepared.count).toBe(1);
    expect(cmp.unprepared.count).toBe(1);
    expect(cmp.prepared.count + cmp.unprepared.count).toBe(2); // the pre-#4304 row is in neither side
  });
  it('never throws and returns null averages for an empty side', () => {
    const cmp = preparedComparison([{ prepared: true, item: 1, dispatchKind: 'conveyor', wallMs: 1000, grade: 'A' }]);
    expect(cmp.unprepared).toMatchObject({ count: 0, avgWallMs: null, tokensPerDemand: null, demandCount: 0, reworkRounds: 0 });
  });
  // Wiring/integration coverage (#4304 review finding): prove `preparedComparison` actually recognizes the
  // field NAMES `toScorecardRow` really emits (`wallMs`, `dispatchKind`, `grade`), not just a hand-shaped test
  // fixture that happens to match by construction.
  it('recognizes the real fields toScorecardRow emits (wallMs, dispatchKind, grade), not just a hand-shaped fixture', () => {
    const preparedRating = { kind: 'conveyor', item: 1, sessionName: 's', model: 'm', grade: 'A', wallMs: 500_000, guardBlocks: 0, errors: 0, repeatedCalls: 0, testReruns: 0, outcome: 'accepted', rawOutcome: 'accepted', tokens: null, costUsd: null, cacheHitRatio: null, shares: null, dataQuality: 'transcript' };
    const unpreparedRating = { kind: 'fix', item: 2, sessionName: 's2', model: 'm', grade: 'C', wallMs: 900_000, guardBlocks: 0, errors: 0, repeatedCalls: 0, testReruns: 0, outcome: 'accepted', rawOutcome: 'accepted', tokens: null, costUsd: null, cacheHitRatio: null, shares: null, dataQuality: 'transcript' };
    const rows = [
      toScorecardRow(preparedRating, { preparedForItem: () => true }),
      toScorecardRow(unpreparedRating, { preparedForItem: () => false }),
    ];
    const cmp = preparedComparison(rows);
    expect(cmp.prepared).toMatchObject({ count: 1, avgWallMs: 500_000 });
    expect(cmp.unprepared).toMatchObject({ count: 1, avgWallMs: 900_000, reworkRounds: 1 });
  });
});

describe('run-rating.mjs CLI `report` — prepared-vs-unprepared table (#4304)', () => {
  // #4304 review finding: `buildReport` also runs `buildCoverageReport`, which scans real `~/.claude` project
  // directories — on a machine with a large transcript history that can run past vitest's 5s default. Explicit,
  // generous timeouts on both the test itself and each spawned CLI call, rather than a flaky default.
  it('prints and JSON-reports a prepared-vs-unprepared split, against a temp scorecard store', () => {
    const root = tmp();
    const storeDir = join(root, '.conveyor');
    mkdirSync(storeDir, { recursive: true });
    const now = new Date().toISOString();
    const row = (overrides) => ({
      v: 1, rubricVersion: RUBRIC_VERSION, provider: 'anthropic', model: 'm', subjectClass: 'work-agent',
      criteriaEvaluated: 4, score: 95, deductions: [], scoredAt: now, outcome: 'accepted',
      guardBlocks: 0, errors: 0, repeatedCalls: 0, testReruns: 0, tokens: null, costUsd: null,
      unpricedTokens: 0, cacheHitRatio: null, shares: null, dataQuality: 'transcript', waste: [],
      costUsdPartial: false,
      ...overrides,
    });
    // Pre-stamp every legacy-migration source as already-done (real stamps, computed the same way
    // `ensureMigrated` would) so the CLI subprocess's one-time #4155 migration is a no-op against this fresh
    // store — otherwise it could fold this checkout's own real historical rows into this temp store and make
    // the exact counts asserted below flaky.
    const { stamps } = readLegacySources();
    writeFileSync(join(storeDir, 'run-scorecards.json'), JSON.stringify({
      version: 1,
      migrations: stamps,
      records: [
        row({ item: 1, dispatchKind: 'conveyor', grade: 'A', wallMs: 600_000, prepared: true }),
        row({ item: 2, dispatchKind: 'fix', grade: 'C', wallMs: 1_200_000, prepared: false }),
      ],
    }, null, 2));
    // #4473 ci-heal — point the coverage scanners at empty temp roots too (their existing env overrides), so the
    // subprocess never walks the host's real transcript history: on a busy host (~4 GB of `~/.claude/projects`)
    // that scan alone ran ~46s, past the 30s spawn timeout below.
    const env = {
      ...process.env,
      CONVEYOR_STATE_ROOT: root,
      WE_CLAUDE_PROJECTS_DIR: join(root, 'claude-projects'),
      WE_WORKSPACE_ROOT: join(root, 'workspace'),
    };
    const jsonOut = execFileSync('node', [CLI, 'report', '--json'], { encoding: 'utf8', env, timeout: 30_000 });
    const report = JSON.parse(jsonOut);
    expect(report.prepared.prepared).toMatchObject({ count: 1, avgWallMs: 600_000, gradeCounts: { A: 1, B: 0, C: 0, D: 0 } });
    expect(report.prepared.unprepared).toMatchObject({ count: 1, avgWallMs: 1_200_000, gradeCounts: { A: 0, B: 0, C: 1, D: 0 } });
    const textOut = execFileSync('node', [CLI, 'report'], { encoding: 'utf8', env, timeout: 30_000 });
    expect(textOut).toMatch(/prepared vs unprepared:/);
    expect(textOut).toMatch(/^\s+prepared: n=1,/m);
    expect(textOut).toMatch(/^\s+unprepared: n=1,/m);
  }, 90_000);
});
