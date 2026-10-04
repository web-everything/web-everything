/**
 * @file scripts/conveyor/__tests__/canary-stages.test.mjs
 * @description x0nxuqd — unit proof of the real end-to-end dispatch canary's PURE stage evaluator
 *   (`we:scripts/conveyor/canary-stages.mjs`). Every case is a constructed fixture transcript, no real
 *   `claude --bg` spawn, no network, no filesystem — exactly the seam the prototype-based-dev doctrine
 *   (`we:docs/agent/prototype-based-dev.md`) says a live-only tool still needs a testable pure core for.
 *
 *   The headline fixture (`'permission-prompt stall'` below) is the whole reason this canary exists: a
 *   `we:scripts/conveyor/soak/*.soak.test.mjs` FAKE session can never reproduce PR #2701's real regression
 *   (a dispatched session's own edit into its lane clone hangs on an unanswered permission prompt because the
 *   session's cwd is now a scratch directory outside every trusted checkout) — this suite proves the evaluator
 *   correctly reads that exact transcript shape as a `no-permission-prompt` FAIL, red before the fix landed and
 *   green after (see the "red -> green" pair below).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateCanaryStages, detectPermissionPromptStall, CANARY_STAGES,
  DEFAULT_PERMISSION_PROMPT_GRACE_MS, LANE_ACQUIRED_RE, GATE_GREEN_RE,
  mergeStickyStages, watchCanary, runCanaryCleanup, clipToolResults, TRANSCRIPT_SCAN_FIELD_MAX,
} from '../canary-stages.mjs';
import { gateFor } from '../../lib/repo-profile.mjs';
import { summarizeEntry } from '../../../skills-src/inspect-agent-health/agent-health.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const NOW = 2_000_000_000;

/** Build a `summarizeEntry`-shaped assistant entry carrying one `tool_use` block. */
function toolUse(id, name, ts) {
  return { kind: 'assistant', ts, blocks: [{ kind: 'tool_use', id, name, input: '{}' }] };
}
/** Build a `summarizeEntry`-shaped user entry carrying one `tool_result` block. */
function toolResult(toolUseId, ts, { isError = false, content = 'ok' } = {}) {
  return { kind: 'user', ts, blocks: [{ kind: 'tool_result', toolUseId, isError, content }] };
}

describe('detectPermissionPromptStall — PURE core', () => {
  it('no entries -> not stalled', () => {
    expect(detectPermissionPromptStall({ entries: [], nowMs: NOW, newestEntryAtMs: null }))
      .toEqual({ stalled: false, toolName: null, ageMs: null });
  });

  it('a pending Edit call younger than the grace window is NOT yet a stall (still just latency)', () => {
    const entries = [toolUse('t1', 'Edit', NOW - 1000)];
    const r = detectPermissionPromptStall({ entries, nowMs: NOW, newestEntryAtMs: NOW - 1000, graceMs: DEFAULT_PERMISSION_PROMPT_GRACE_MS });
    expect(r.stalled).toBe(false);
  });

  it('RED: a pending Edit call older than the grace window IS a permission-prompt stall (#2701 shape)', () => {
    const stalledSince = NOW - (DEFAULT_PERMISSION_PROMPT_GRACE_MS + 5000);
    const entries = [toolUse('t1', 'Edit', stalledSince)];
    const r = detectPermissionPromptStall({ entries, nowMs: NOW, newestEntryAtMs: stalledSince, graceMs: DEFAULT_PERMISSION_PROMPT_GRACE_MS });
    expect(r).toEqual({ stalled: true, toolName: 'Edit', ageMs: DEFAULT_PERMISSION_PROMPT_GRACE_MS + 5000 });
  });

  it('GREEN: the same pending Edit call, once RESOLVED, is never a stall regardless of age', () => {
    const oldTs = NOW - (DEFAULT_PERMISSION_PROMPT_GRACE_MS + 5000);
    const entries = [toolUse('t1', 'Edit', oldTs), toolResult('t1', NOW - 1000)];
    const r = detectPermissionPromptStall({ entries, nowMs: NOW, newestEntryAtMs: NOW - 1000, graceMs: DEFAULT_PERMISSION_PROMPT_GRACE_MS });
    expect(r.stalled).toBe(false);
  });

  it('a pending Read (not a file-mutating tool) is never read as a permission-prompt stall', () => {
    const oldTs = NOW - (DEFAULT_PERMISSION_PROMPT_GRACE_MS + 5000);
    const entries = [toolUse('t1', 'Read', oldTs)];
    const r = detectPermissionPromptStall({ entries, nowMs: NOW, newestEntryAtMs: oldTs, graceMs: DEFAULT_PERMISSION_PROMPT_GRACE_MS });
    expect(r.stalled).toBe(false);
  });

  it('no newest-entry timestamp available -> never guesses a stall', () => {
    expect(detectPermissionPromptStall({ entries: [toolUse('t1', 'Edit', null)], nowMs: NOW, newestEntryAtMs: null }).stalled).toBe(false);
  });
});

describe('evaluateCanaryStages — spawn failure short-circuits every later stage', () => {
  it('spawned:false fails every stage, never leaves one pending', () => {
    const { stages, overall } = evaluateCanaryStages({ spawned: false, nowMs: NOW });
    expect(overall).toBe('fail');
    expect(stages.map((s) => s.name)).toEqual(CANARY_STAGES);
    expect(stages.every((s) => s.status === 'fail')).toBe(true);
  });
});

describe('evaluateCanaryStages — the permission-prompt regression, red then green (PR #2701)', () => {
  const laneAcquireResult = [toolUse('t-acq', 'Bash', NOW - 200_000), toolResult('t-acq', NOW - 199_000, { content: 'acquired lane-49 for Mac:1234 (canary)' })];

  it('RED — pre-fix transcript: lane acquired, then the very next Edit hangs past the grace window with no answer', () => {
    const stalledSince = NOW - (DEFAULT_PERMISSION_PROMPT_GRACE_MS + 10_000);
    const entries = [...laneAcquireResult, toolUse('t-edit', 'Edit', stalledSince)];
    const { stages, overall } = evaluateCanaryStages({
      spawned: true, entries, nowMs: NOW, newestEntryAtMs: stalledSince,
      laneAcquiredGroundTruth: true, sessionFinished: null,
    });
    const byName = Object.fromEntries(stages.map((s) => [s.name, s]));
    expect(byName['lane-acquired'].status).toBe('pass');
    expect(byName['no-permission-prompt'].status).toBe('fail');
    expect(byName['no-permission-prompt'].detail).toMatch(/Edit/);
    expect(byName['edit-ok'].status).not.toBe('pass'); // never resolved — pending or fail, but not a false pass
    expect(overall).toBe('fail');
  });

  it('GREEN — post-fix transcript: the same Edit resolves cleanly, gate runs green, branch pushed, session finished, cleaned up', () => {
    const entries = [
      ...laneAcquireResult,
      toolUse('t-edit', 'Edit', NOW - 100_000),
      toolResult('t-edit', NOW - 99_000, { content: 'File created successfully' }),
      toolUse('t-gate', 'Bash', NOW - 80_000),
      toolResult('t-gate', NOW - 79_000, { content: '{"sha":"abc","status":"green","ok":true}' }),
      toolUse('t-push', 'Bash', NOW - 60_000),
      toolResult('t-push', NOW - 59_000, { content: 'pushed to canary/123' }),
    ];
    const { stages, overall } = evaluateCanaryStages({
      spawned: true, entries, nowMs: NOW, newestEntryAtMs: NOW - 59_000,
      laneAcquiredGroundTruth: true, pushedGroundTruth: true, sessionFinished: true,
      cleanup: { laneReleased: true, branchDeleted: true, scratchReaped: true },
    });
    expect(stages.map((s) => s.status)).toEqual(Array(CANARY_STAGES.length).fill('pass'));
    expect(overall).toBe('pass');
  });
});

describe('evaluateCanaryStages — mid-run stages read PENDING, not a premature pass/fail', () => {
  it('a fresh dispatch with no evidence yet is pending everywhere but "spawned", and never fails before its bounded timeout', () => {
    const { stages, overall } = evaluateCanaryStages({ spawned: true, entries: [], nowMs: NOW, timedOut: false });
    const byName = Object.fromEntries(stages.map((s) => [s.name, s]));
    expect(byName.spawned.status).toBe('pass');
    for (const name of CANARY_STAGES.slice(1)) expect(byName[name].status).toBe('pending');
    expect(overall).toBe('pending');
  });

  it('the same empty-evidence run, once the canary\'s own bounded watch times out, fails every still-undecided stage', () => {
    const { stages, overall } = evaluateCanaryStages({ spawned: true, entries: [], nowMs: NOW, timedOut: true });
    const byName = Object.fromEntries(stages.map((s) => [s.name, s]));
    expect(byName.spawned.status).toBe('pass');
    for (const name of CANARY_STAGES.slice(1)) expect(byName[name].status).toBe('fail');
    expect(overall).toBe('fail');
  });
});

describe('evaluateCanaryStages — cleaned-up only ever passes once every one of the three facts is true', () => {
  it('one leaked fact (e.g. the scratch folder) fails cleaned-up even though the session finished fine', () => {
    const { stages } = evaluateCanaryStages({
      spawned: true, entries: [], nowMs: NOW, sessionFinished: true, timedOut: true,
      cleanup: { laneReleased: true, branchDeleted: true, scratchReaped: false },
    });
    const cleaned = stages.find((s) => s.name === 'cleaned-up');
    expect(cleaned.status).toBe('fail');
    expect(cleaned.detail).toMatch(/scratchReaped/);
  });

  it('REGRESSION (caught live on this canary\'s own first real run): a still-ALIVE session never reads as cleaned-up, even when every cleanup fact is vacuously true (nothing was ever acquired/pushed to begin with)', () => {
    // The live shape: the spawned session stalled on an unanswered permission prompt (#2701) and was still a
    // real, running process when the canary's own bounded watch gave up. Nothing was ever acquired or pushed,
    // so a naive "were all three facts true?" check reads this as cleaned-up:pass — which a first cut of this
    // evaluator actually did, because it checked `allTrue` BEFORE `!finished`. `!finished` must win.
    const { stages, overall } = evaluateCanaryStages({
      spawned: true, entries: [], nowMs: NOW, sessionFinished: false, timedOut: true,
      cleanup: { laneReleased: true, branchDeleted: true, scratchReaped: null }, // scratch deliberately left alone
    });
    const byName = Object.fromEntries(stages.map((s) => [s.name, s]));
    expect(byName['session-finished'].status).toBe('fail');
    expect(byName['cleaned-up'].status).toBe('fail');
    expect(byName['cleaned-up'].detail).toMatch(/not yet finished/);
    expect(overall).toBe('fail');
  });
});

describe('regex fixtures used by the evaluator stay honest about what they match', () => {
  it('LANE_ACQUIRED_RE matches real lane-pool.mjs stdout', () => {
    expect(LANE_ACQUIRED_RE.test('acquired lane-49 for Mac:50622 (canary-file-4075) → /path')).toBe(true);
    expect(LANE_ACQUIRED_RE.test('no free lane in pool "we"')).toBe(false);
  });

  it('GATE_GREEN_RE matches a verify-lane check --json green read', () => {
    expect(GATE_GREEN_RE.test('{"sha":"x","status":"green","ok":true}')).toBe(true);
    expect(GATE_GREEN_RE.test('{"sha":"x","status":"red","ok":false}')).toBe(false);
  });

  it('CONTRACT: GATE_GREEN_RE matches the exact plain-text line the wired gate command (`gateFor()` → `verify-lane.mjs run`, no --json) prints', () => {
    // The canary hands the spawned session `gateFor()`'s command, which never passes --json. Assert the regex
    // against that command's REAL output, built from verify-lane.mjs's own `emit()` format + run-mode detail
    // strings (read from the source so a reworded line breaks this test, not a live canary run).
    const src = readFileSync(join(REPO_ROOT, 'scripts', 'verify-lane.mjs'), 'utf8');
    expect(gateFor('web-everything/web-everything', { weRoot: REPO_ROOT })).not.toMatch(/--json/);
    expect(src).toContain('`verify-lane [lane @ ${result.sha ? result.sha.slice(0, 8) : \'?\'}] ${result.status}: ${result.detail}\\n`');
    const greenDetail = /detail: exitCode === 0 \? '([^']+)'/.exec(src)?.[1];
    expect(greenDetail).toBeTruthy();
    const redDetail = 'gate FAILED (exit 1) — run mode, no marker recorded.';
    expect(GATE_GREEN_RE.test(`verify-lane [lane @ 645d67e7] green: ${greenDetail}`)).toBe(true);
    expect(GATE_GREEN_RE.test(`verify-lane [lane @ 645d67e7] red: ${redDetail}`)).toBe(false);
  });
});

describe('evaluateCanaryStages — cleaned-up ordering holds even with every cleanup fact true', () => {
  it('a still-ALIVE session with laneReleased/branchDeleted/scratchReaped ALL true still fails cleaned-up (the finished guard must precede the all-true check)', () => {
    const { stages } = evaluateCanaryStages({
      spawned: true, entries: [], nowMs: NOW, sessionFinished: false, timedOut: true,
      cleanup: { laneReleased: true, branchDeleted: true, scratchReaped: true },
    });
    const cleaned = stages.find((s) => s.name === 'cleaned-up');
    expect(cleaned.status).toBe('fail');
    expect(cleaned.detail).toMatch(/not yet finished/);
  });
});

describe('mergeStickyStages — a pass is never undone by a later poll', () => {
  it('keeps an earlier pass when the next poll reads pending/fail, but takes new passes and new verdicts otherwise', () => {
    const prev = [{ name: 'lane-acquired', status: 'pass', detail: 'acquired lane-7' }, { name: 'edit-ok', status: 'pending', detail: '' }];
    const next = [{ name: 'lane-acquired', status: 'pending', detail: '' }, { name: 'edit-ok', status: 'fail', detail: 'x' }];
    expect(mergeStickyStages(prev, next)).toEqual([prev[0], next[1]]);
    expect(mergeStickyStages(null, next)).toBe(next);
  });
});

/** A scripted fake world for `watchCanary`: each poll pops the next listing (or throws for `'THROW'`). */
function fakeWatchDeps({ listings, transcriptsByRowId, refExists = true }) {
  let t = 0;
  let i = 0;
  const transcriptReads = [];
  return {
    transcriptReads,
    deps: {
      now: () => t,
      sleep: async (ms) => { t += ms; },
      listAgents: () => {
        const l = listings[Math.min(i++, listings.length - 1)];
        if (l === 'THROW') throw new Error('listing failed');
        return l;
      },
      readTranscriptTail: (row) => {
        transcriptReads.push(row?.sessionId ?? null);
        return row ? transcriptsByRowId[row.sessionId] : { entries: [], newestEntryAtMs: null };
      },
      refExistsOnOrigin: () => refExists,
    },
  };
}

describe('watchCanary — the injected watch loop (review finding: stage evidence must survive session disappearance)', () => {
  const successEntries = [
    toolUse('a', 'Bash', 1000), toolResult('a', 1100, { content: 'acquired lane-49 for x (canary)' }),
    toolUse('e', 'Edit', 1200), toolResult('e', 1300, { content: 'File created successfully' }),
    toolUse('g', 'Bash', 1400), toolResult('g', 1500, { content: 'verify-lane [lane @ abcd1234] green: gate passed (run mode — no marker recorded).' }),
  ];
  const row = { name: 'canary-1', sessionId: 's1', cwd: '/scratch/s1', state: 'working' };
  const opts = { sessionSlug: 'canary-1', branchRef: 'canary/1', startedAtMs: 0, timeoutMs: 100_000, pollMs: 10_000, listingGraceMs: 5_000 };

  it('retains successful stages after the session disappears from a SUCCESSFUL listing read', async () => {
    const { deps, transcriptReads } = fakeWatchDeps({ listings: [[row], []], transcriptsByRowId: { s1: { entries: successEntries, newestEntryAtMs: 1500 } } });
    const r = await watchCanary({ ...opts, deps });
    expect(r.sessionFinished).toBe(true);
    expect(r.laneNumberSeen).toBe(49);
    expect(transcriptReads).toEqual(['s1', 's1']); // the vanished session's transcript is still read via its last row
    const byName = Object.fromEntries(r.stages.map((s) => [s.name, s.status]));
    expect(byName).toMatchObject({ 'lane-acquired': 'pass', 'edit-ok': 'pass', 'gate-ran': 'pass', pushed: 'pass', 'session-finished': 'pass' });
  });

  it('retains a pass even when its evidence scrolls out of the bounded tail on a later poll', async () => {
    const { deps } = fakeWatchDeps({ listings: [[row], [row], [{ ...row, state: 'done' }]], transcriptsByRowId: { s1: { entries: successEntries, newestEntryAtMs: 1500 } } });
    let call = 0;
    const read = deps.readTranscriptTail;
    deps.readTranscriptTail = (r) => (++call === 1 ? read(r) : { entries: [], newestEntryAtMs: 1500 });
    const r = await watchCanary({ ...opts, deps });
    const byName = Object.fromEntries(r.stages.map((s) => [s.name, s.status]));
    expect(byName).toMatchObject({ 'lane-acquired': 'pass', 'edit-ok': 'pass', 'gate-ran': 'pass' });
  });

  it('a FAILED listing read never promotes to finished — it runs to the bounded timeout instead', async () => {
    const { deps } = fakeWatchDeps({ listings: ['THROW'], transcriptsByRowId: {} });
    const r = await watchCanary({ ...opts, deps });
    expect(r.sessionFinished).toBe(null);
    expect(r.stages.find((s) => s.name === 'session-finished').status).toBe('fail');
  });
});

/** Recording fake effects for `runCanaryCleanup`. `leasedTo` is either one answer for every lease read, or an
 *  array of successive answers (before release, after release). */
function fakeCleanupDeps({ releaseThrows = false, leasedTo = false, refExists = false, scratchExists = true } = {}) {
  const calls = [];
  let scratch = scratchExists;
  const answers = Array.isArray(leasedTo) ? [...leasedTo] : null;
  return {
    calls,
    deps: {
      releaseLane: (lane, session) => { calls.push(['releaseLane', lane, session]); if (releaseThrows) throw new Error('release timed out'); },
      laneLeasedTo: (lane, session) => { calls.push(['laneLeasedTo', lane, session]); return answers ? answers.shift() : leasedTo; },
      refExistsOnOrigin: () => refExists,
      deleteRemoteBranch: (ref) => { calls.push(['deleteRemoteBranch', ref]); refExists = false; },
      pathExists: () => scratch,
      removeDir: (p) => { calls.push(['removeDir', p]); scratch = false; },
      revokeTrust: (ps) => { calls.push(['revokeTrust', ...ps]); },
    },
  };
}

describe('runCanaryCleanup — the injected cleanup step', () => {
  const base = { laneNumberSeen: 49, sessionSlug: 'canary-1', branchRef: 'canary/1', pushedGroundTruth: null, scratchCwd: '/scratch/s1' };

  it('REGRESSION GUARD: a session NOT confirmed finished never has its lane released, its scratch cwd removed, or its trust revoked', () => {
    for (const sessionFinished of [false, null]) {
      const { deps, calls } = fakeCleanupDeps();
      const r = runCanaryCleanup({ ...base, sessionFinished, deps });
      const destructive = calls.filter(([n]) => n === 'releaseLane' || n === 'removeDir' || n === 'revokeTrust');
      expect(destructive).toEqual([]);
      expect(r.laneReleased).toBe(null);
      expect(r.scratchReaped).toBe(null);
    }
  });

  it('a confirmed-finished session still holding its lease gets it released, scratch removed, trust revoked, pushed branch deleted', () => {
    const { deps, calls } = fakeCleanupDeps({ refExists: true, leasedTo: [true, false] });
    const r = runCanaryCleanup({ ...base, sessionFinished: true, deps });
    expect(r).toEqual({ laneReleased: true, branchDeleted: true, scratchReaped: true, pushedForCleanup: true });
    expect(calls.map(([n]) => n)).toEqual(['laneLeasedTo', 'releaseLane', 'laneLeasedTo', 'deleteRemoteBranch', 'removeDir', 'revokeTrust']);
  });

  it('a lane the agent ALREADY released (and maybe someone else re-leased) is never force-released — and counts as clean', () => {
    const { deps, calls } = fakeCleanupDeps({ leasedTo: false });
    const r = runCanaryCleanup({ ...base, sessionFinished: true, deps });
    expect(r.laneReleased).toBe(true);
    expect(calls.filter(([n]) => n === 'releaseLane')).toEqual([]);
    const { stages } = evaluateCanaryStages({
      spawned: true, entries: [], nowMs: NOW, sessionFinished: true, timedOut: true,
      cleanup: { laneReleased: r.laneReleased, branchDeleted: r.branchDeleted, scratchReaped: r.scratchReaped },
    });
    expect(stages.find((s) => s.name === 'cleaned-up').status).toBe('pass');
  });

  it('a lease still held after the release attempt is a confirmed leak (false); an unreadable lease is never released and stays null', () => {
    expect(runCanaryCleanup({ ...base, sessionFinished: true, deps: fakeCleanupDeps({ releaseThrows: true, leasedTo: [true, true] }).deps }).laneReleased).toBe(false);
    const unreadable = fakeCleanupDeps({ leasedTo: null });
    expect(runCanaryCleanup({ ...base, sessionFinished: true, deps: unreadable.deps }).laneReleased).toBe(null);
    expect(unreadable.calls.filter(([n]) => n === 'releaseLane')).toEqual([]);
  });
});

describe('transcript read path — gate-green evidence survives the summarizer (review finding: the green line is printed LAST)', () => {
  // A realistic `verify-lane.mjs run` tool_result: the whole gate output streams first (thousands of chars of
  // check:standards warnings), and the green line is the very last thing printed.
  const gateOutput = `${'  warn test-only export (#2967): `x` in scripts/y.mjs — no non-test module imports it.\n'.repeat(60)}`
    + '0 error(s), 2374 warning(s)\nverify-lane [lane @ 645d67e7] green: gate passed (run mode — no marker recorded).';
  const rawLine = JSON.stringify({
    type: 'user', timestamp: '2026-09-26T19:00:00.000Z',
    message: { content: [{ type: 'tool_result', tool_use_id: 'g', is_error: false, content: gateOutput }] },
  });
  const gateTool = toolUse('g', 'Bash', 1000);
  const laneAndEdit = [...[toolUse('a', 'Bash', 900), toolResult('a', 901, { content: 'acquired lane-4 for c' })], toolUse('e', 'Edit', 950), toolResult('e', 951)];

  it('CONTRACT: summarize (scan cap) → clipToolResults keeps the green line, so gate-ran passes', () => {
    const entry = clipToolResults(summarizeEntry(rawLine, TRANSCRIPT_SCAN_FIELD_MAX));
    expect(entry.blocks[0].content.length).toBeLessThan(gateOutput.length);
    const { stages } = evaluateCanaryStages({ spawned: true, entries: [...laneAndEdit, gateTool, entry], nowMs: NOW, newestEntryAtMs: NOW, sessionFinished: true });
    expect(stages.find((s) => s.name === 'gate-ran').status).toBe('pass');
  });

  it('RED shape: the old head-only 300-char cut loses the green line entirely', () => {
    const entry = summarizeEntry(rawLine, 300);
    expect(GATE_GREEN_RE.test(entry.blocks[0].content)).toBe(false);
  });
});

describe('priorPasses — the dependency chain honours earlier passes (no stale PENDING on a finished run)', () => {
  it('lane/edit/gate passed on an earlier poll, tail now empty, session finished, branch never pushed → pushed FAILS (not pending)', () => {
    const { stages } = evaluateCanaryStages({
      spawned: true, entries: [], nowMs: NOW, sessionFinished: true, pushedGroundTruth: false,
      priorPasses: ['lane-acquired', 'edit-ok', 'gate-ran'],
    });
    expect(stages.find((s) => s.name === 'pushed').status).toBe('fail');
  });

  it('lane passed earlier, no edit ever seen, session finished → edit-ok FAILS (not "lane not yet acquired")', () => {
    const { stages } = evaluateCanaryStages({ spawned: true, entries: [], nowMs: NOW, sessionFinished: true, priorPasses: ['lane-acquired'] });
    const edit = stages.find((s) => s.name === 'edit-ok');
    expect(edit.status).toBe('fail');
    expect(edit.detail).toMatch(/lane acquired but no resolved edit/);
  });
});
