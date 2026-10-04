/**
 * @file scripts/conveyor/__tests__/hung-session.test.mjs
 * @description Unit proof of the shared hung-transcript detector (epic #3383 continuation, live 2026-09-24):
 *   the PURE classifier ({@link classifyHungSession}), the env-driven threshold resolver
 *   ({@link resolveHungThresholdMs}), and the IO shell ({@link readHungInfo}) against a REAL temp
 *   `~/.claude/projects/<slug>/<sessionId>.jsonl`-shaped fixture (no network, no real home dir — the
 *   store root is stubbed via `CLAUDE_PROJECTS_DIR`, the same knob `agent-health.mjs`'s own tests use).
 *   This is the ONE implementation `reconcile-core.mjs#markHungSessions` and `session-reaper.mjs`'s hung
 *   axis both import — see either file's docblock for why a shared module matters here.
 *
 *   `readHungInfo`'s tests drive staleness through the TRANSCRIPT'S OWN embedded entry `timestamp`, not
 *   `utimesSync` on the file's mtime — measured live (web-everything/web-everything `review-2599`, 2026-09-24) that
 *   this environment can bump a transcript's mtime with no new content, so mtime-only staleness would have
 *   been the wrong signal to pin here. One dedicated case proves the mtime FALLBACK path directly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyHungSession, resolveHungThresholdMs, DEFAULT_HUNG_THRESHOLD_MS, PENDING_CALL_GRACE_MULTIPLIER, readTranscriptTailActivity } from '../hung-session.mjs';
import { classifyIdleFinished, resolveIdleFinishedThresholdMs, DEFAULT_IDLE_FINISHED_THRESHOLD_MS } from '../hung-session.mjs';
import {
  NO_OUTCOME_KINDS, resolveNoOutcomeWindowMs, resolveNoOutcomeCeilingMs, classifyNoOutcomeStall, OUTCOME_UNREADABLE,
} from '../hung-session.mjs';
import { DEFAULT_LEASE_TTL_MINUTES } from '../../lib/lane-lease.mjs';

describe('classifyHungSession — PURE core', () => {
  const NOW = 1_000_000_000;
  const THRESHOLD = 30 * 60_000;

  it('fresh transcript (age < threshold) is never hung, pending or not', () => {
    expect(classifyHungSession({ lastActivityMs: NOW - 1, nowMs: NOW, thresholdMs: THRESHOLD }))
      .toEqual({ hung: false, reason: 'fresh', ageMs: 1 });
    expect(classifyHungSession({ lastActivityMs: NOW - (THRESHOLD - 1), nowMs: NOW, thresholdMs: THRESHOLD, pendingToolUse: true }))
      .toEqual({ hung: false, reason: 'fresh', ageMs: THRESHOLD - 1 });
  });

  it('stale with NOTHING pending → hung at once, right at the threshold', () => {
    const ageMs = THRESHOLD;
    expect(classifyHungSession({ lastActivityMs: NOW - ageMs, nowMs: NOW, thresholdMs: THRESHOLD }))
      .toEqual({ hung: true, reason: 'stale-no-activity', ageMs });
  });

  it('stale WITH a pending tool_use gets extra grace — not hung until PENDING_CALL_GRACE_MULTIPLIER x threshold', () => {
    const withinGrace = THRESHOLD * PENDING_CALL_GRACE_MULTIPLIER - 1;
    expect(classifyHungSession({ lastActivityMs: NOW - withinGrace, nowMs: NOW, thresholdMs: THRESHOLD, pendingToolUse: true }))
      .toEqual({ hung: false, reason: 'pending-foreground-call-within-grace', ageMs: withinGrace });
  });

  it('stale WITH a pending tool_use PAST the grace multiplier is hung too — conservative, not infinite', () => {
    const pastGrace = THRESHOLD * PENDING_CALL_GRACE_MULTIPLIER;
    expect(classifyHungSession({ lastActivityMs: NOW - pastGrace, nowMs: NOW, thresholdMs: THRESHOLD, pendingToolUse: true }))
      .toEqual({ hung: true, reason: 'stale-with-pending-call-past-grace', ageMs: pastGrace });
  });

  it('any non-finite/invalid input answers no-signal, never a guess', () => {
    expect(classifyHungSession({})).toEqual({ hung: false, reason: 'no-signal', ageMs: null });
    expect(classifyHungSession({ lastActivityMs: NaN, nowMs: NOW, thresholdMs: THRESHOLD })).toEqual({ hung: false, reason: 'no-signal', ageMs: null });
    expect(classifyHungSession({ lastActivityMs: NOW, nowMs: NOW, thresholdMs: 0 })).toEqual({ hung: false, reason: 'no-signal', ageMs: null });
    expect(classifyHungSession({ lastActivityMs: NOW, nowMs: NOW, thresholdMs: -1 })).toEqual({ hung: false, reason: 'no-signal', ageMs: null });
  });
});

describe('resolveHungThresholdMs — WE_HUNG_TRANSCRIPT_MINUTES, IO shell only', () => {
  it('defaults to 30 minutes when unset/empty', () => {
    expect(resolveHungThresholdMs({})).toBe(DEFAULT_HUNG_THRESHOLD_MS);
    expect(resolveHungThresholdMs({ WE_HUNG_TRANSCRIPT_MINUTES: '' })).toBe(DEFAULT_HUNG_THRESHOLD_MS);
  });
  it('reads a valid override in minutes', () => {
    expect(resolveHungThresholdMs({ WE_HUNG_TRANSCRIPT_MINUTES: '10' })).toBe(10 * 60_000);
  });
  it('falls back to the default on garbage, and floor-clamps a sub-1-minute value rather than disabling the axis', () => {
    expect(resolveHungThresholdMs({ WE_HUNG_TRANSCRIPT_MINUTES: 'not-a-number' })).toBe(DEFAULT_HUNG_THRESHOLD_MS);
    expect(resolveHungThresholdMs({ WE_HUNG_TRANSCRIPT_MINUTES: '0' })).toBe(DEFAULT_HUNG_THRESHOLD_MS);
    expect(resolveHungThresholdMs({ WE_HUNG_TRANSCRIPT_MINUTES: '-5' })).toBe(DEFAULT_HUNG_THRESHOLD_MS);
    expect(resolveHungThresholdMs({ WE_HUNG_TRANSCRIPT_MINUTES: '0.2' })).toBe(60_000); // clamped up to 1 minute
  });
});

// #4090 (epic #3383/#4075, statute `#conveyor-session-lifecycle-policy` clause 2) — the no-net-outcome axis.
describe('NO_OUTCOME_KINDS — names exactly the statute\'s four kinds (prepare-decision mirrors prepare)', () => {
  it('covers conveyor/fix/review/prepare/prepare-decision, never ci-heal/inspect', () => {
    expect([...NO_OUTCOME_KINDS].sort()).toEqual(['conveyor', 'fix', 'prepare', 'prepare-decision', 'review']);
  });
});

describe('resolveNoOutcomeWindowMs / resolveNoOutcomeCeilingMs — the per-kind settings', () => {
  it('default fallback minutes match the statute\'s own stated defaults', () => {
    expect(resolveNoOutcomeWindowMs('conveyor', {})).toBe(45 * 60_000);
    expect(resolveNoOutcomeCeilingMs('conveyor', {})).toBe(240 * 60_000);
    expect(resolveNoOutcomeWindowMs('fix', {})).toBe(30 * 60_000);
    expect(resolveNoOutcomeCeilingMs('fix', {})).toBe(120 * 60_000);
    expect(resolveNoOutcomeWindowMs('review', {})).toBe(30 * 60_000);
    expect(resolveNoOutcomeCeilingMs('review', {})).toBe(60 * 60_000);
    expect(resolveNoOutcomeWindowMs('prepare', {})).toBe(45 * 60_000);
    expect(resolveNoOutcomeCeilingMs('prepare', {})).toBe(180 * 60_000);
    expect(resolveNoOutcomeWindowMs('prepare-decision', {})).toBe(45 * 60_000);
    expect(resolveNoOutcomeCeilingMs('prepare-decision', {})).toBe(180 * 60_000);
  });

  it('null for a kind the statute never named — never a guessed window/ceiling', () => {
    expect(resolveNoOutcomeWindowMs('ci-heal', {})).toBeNull();
    expect(resolveNoOutcomeCeilingMs('inspect', {})).toBeNull();
  });

  it('env override, per kind, named WE_NO_OUTCOME_<KIND>_WINDOW_MIN / _CEILING_MIN', () => {
    expect(resolveNoOutcomeWindowMs('review', { WE_NO_OUTCOME_REVIEW_WINDOW_MIN: '15' })).toBe(15 * 60_000);
    expect(resolveNoOutcomeCeilingMs('fix', { WE_NO_OUTCOME_FIX_CEILING_MIN: '90' })).toBe(90 * 60_000);
    expect(resolveNoOutcomeWindowMs('prepare-decision', { WE_NO_OUTCOME_PREPARE_DECISION_WINDOW_MIN: '20' })).toBe(20 * 60_000);
  });

  it('an unparsable/non-positive override falls back to the default, never disables the axis', () => {
    expect(resolveNoOutcomeWindowMs('review', { WE_NO_OUTCOME_REVIEW_WINDOW_MIN: 'nope' })).toBe(30 * 60_000);
    expect(resolveNoOutcomeCeilingMs('review', { WE_NO_OUTCOME_REVIEW_CEILING_MIN: '0' })).toBe(60 * 60_000);
    expect(resolveNoOutcomeCeilingMs('review', { WE_NO_OUTCOME_REVIEW_CEILING_MIN: '-5' })).toBe(60 * 60_000);
  });

  it('the ceiling NEVER exceeds the lane lease TTL, even if an operator configures a larger one (statute)', () => {
    expect(DEFAULT_LEASE_TTL_MINUTES).toBe(240);
    expect(resolveNoOutcomeCeilingMs('conveyor', { WE_NO_OUTCOME_CONVEYOR_CEILING_MIN: '9999' })).toBe(DEFAULT_LEASE_TTL_MINUTES * 60_000);
    expect(resolveNoOutcomeCeilingMs('review', { WE_NO_OUTCOME_REVIEW_CEILING_MIN: '500' })).toBe(DEFAULT_LEASE_TTL_MINUTES * 60_000);
  });
});

describe('classifyNoOutcomeStall — PURE, the two-trigger verdict (window vs ceiling)', () => {
  const T0 = 1_000_000;
  it('active when neither the window nor the ceiling has elapsed', () => {
    expect(classifyNoOutcomeStall({ startedAtMs: T0, lastOutcomeAtMs: T0 + 1000, nowMs: T0 + 2000, windowMs: 10_000, ceilingMs: 100_000 }))
      .toEqual({ stall: false, reason: 'active' });
  });
  it('stalls on the WINDOW once no outcome has landed for windowMs, measured from the LAST outcome', () => {
    expect(classifyNoOutcomeStall({ startedAtMs: T0, lastOutcomeAtMs: T0 + 5000, nowMs: T0 + 5000 + 10_000, windowMs: 10_000, ceilingMs: 999_999 }))
      .toEqual({ stall: true, reason: 'no-outcome-window' });
  });
  it('with NO outcome ever, the window is measured from startedAtMs, never treated as automatically fresh', () => {
    expect(classifyNoOutcomeStall({ startedAtMs: T0, lastOutcomeAtMs: null, nowMs: T0 + 10_000, windowMs: 10_000, ceilingMs: 999_999 }))
      .toEqual({ stall: true, reason: 'no-outcome-window' });
  });
  it('the CEILING wins even while outcomes keep landing inside the window — an absolute cap', () => {
    expect(classifyNoOutcomeStall({ startedAtMs: T0, lastOutcomeAtMs: T0 + 99_000, nowMs: T0 + 100_000, windowMs: 10_000, ceilingMs: 100_000 }))
      .toEqual({ stall: true, reason: 'ceiling' });
  });
  it('windowMs/ceilingMs of null (an uncovered kind) disables that trigger, never a guess', () => {
    expect(classifyNoOutcomeStall({ startedAtMs: T0, lastOutcomeAtMs: null, nowMs: T0 + 999_999_999, windowMs: null, ceilingMs: null }))
      .toEqual({ stall: false, reason: 'active' });
  });
  it('no-signal when startedAtMs/nowMs are not finite numbers — never a guess', () => {
    expect(classifyNoOutcomeStall({ startedAtMs: null, nowMs: T0, windowMs: 1, ceilingMs: 1 })).toEqual({ stall: false, reason: 'no-signal' });
    expect(classifyNoOutcomeStall({ startedAtMs: T0, nowMs: undefined, windowMs: 1, ceilingMs: 1 })).toEqual({ stall: false, reason: 'no-signal' });
  });
  it('historical outcomes grant a new session its full window — an outcome OLDER than startedAtMs clamps to the start', () => {
    // PR #2676 review: a fix session dispatched onto a lane whose build commit is 3h old, 5 min into its own run.
    const MIN = 60_000;
    const o = { startedAtMs: T0, lastOutcomeAtMs: T0 - 180 * MIN, windowMs: 30 * MIN, ceilingMs: 120 * MIN };
    expect(classifyNoOutcomeStall({ ...o, nowMs: T0 + 5 * MIN })).toEqual({ stall: false, reason: 'active' });
    // …and the window still runs from its OWN start, so it stalls once that elapses with nothing new.
    expect(classifyNoOutcomeStall({ ...o, nowMs: T0 + 30 * MIN })).toEqual({ stall: true, reason: 'no-outcome-window' });
  });
  it('an UNREADABLE outcome source never authorizes a WINDOW stop — only the ceiling can stop on it', () => {
    const o = { startedAtMs: T0, lastOutcomeAtMs: OUTCOME_UNREADABLE, windowMs: 10_000, ceilingMs: 100_000 };
    expect(classifyNoOutcomeStall({ ...o, nowMs: T0 + 50_000 })).toEqual({ stall: false, reason: 'no-signal' });
    expect(classifyNoOutcomeStall({ ...o, nowMs: T0 + 100_000 })).toEqual({ stall: true, reason: 'ceiling' });
  });
});

function entryLine(type, ts, content) {
  return JSON.stringify({ type, timestamp: ts, message: { role: type, content } });
}

describe('readHungInfo — the IO shell, against a REAL temp project store', () => {
  let root, projects, cwd, sessionId, transcriptFile, readHungInfo;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'hung-session-test-'));
    projects = join(root, 'projects');
    cwd = '/Users/fixture/workspace/lane-9';
    sessionId = 'sess-fixture-0001';
    const slug = cwd.replaceAll('/', '-');
    mkdirSync(join(projects, slug), { recursive: true });
    transcriptFile = join(projects, slug, `${sessionId}.jsonl`);
    vi.stubEnv('CLAUDE_PROJECTS_DIR', projects);
    vi.resetModules();
    ({ readHungInfo } = await import('../hung-session.mjs'));
  });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

  it('a transcript whose newest EMBEDDED entry timestamp is recent is not hung', () => {
    const now = Date.now();
    writeFileSync(transcriptFile, entryLine('assistant', new Date(now - 30_000).toISOString(), [{ type: 'text', text: 'ok' }]) + '\n');
    const info = readHungInfo({ cwd, sessionId }, now, 30 * 60_000);
    expect(info.hung).toBe(false);
    expect(info.reason).toBe('fresh');
    expect(info.transcriptPath).toBe(transcriptFile);
  });

  it('a transcript whose newest embedded entry timestamp is stale past the threshold, nothing pending, is hung', () => {
    const now = Date.now();
    const staleTs = new Date(now - 45 * 60_000).toISOString();
    writeFileSync(transcriptFile, entryLine('assistant', staleTs, [{ type: 'text', text: 'done for now' }]) + '\n');
    const info = readHungInfo({ cwd, sessionId }, now, 30 * 60_000);
    expect(info.hung).toBe(true);
    expect(info.reason).toBe('stale-no-activity');
  });

  it("IGNORES the file's mtime when the content itself is stale — the exact live false-negative this axis fixes", () => {
    // Measured live: a transcript's real last line was ~3h old while `fs.statSync` reported the file touched
    // minutes ago. Bump mtime to "now" but keep stale CONTENT — must still read as hung off the embedded ts.
    const now = Date.now();
    const staleTs = new Date(now - 3 * 60 * 60_000).toISOString();
    writeFileSync(transcriptFile, entryLine('assistant', staleTs, [{ type: 'text', text: 'login expired' }]) + '\n');
    utimesSync(transcriptFile, new Date(now), new Date(now)); // mtime bumped to "just now"
    const info = readHungInfo({ cwd, sessionId }, now, 30 * 60_000);
    expect(info.hung).toBe(true);
    expect(info.reason).toBe('stale-no-activity');
  });

  it('FALLS BACK to mtime only when nothing in the tail carries a parseable timestamp at all', () => {
    // No `timestamp` field anywhere in this line — the fallback path, and only the fallback path, applies.
    writeFileSync(transcriptFile, `${JSON.stringify({ type: 'permission-mode' })}\n`);
    const staleMs = Date.now() - 45 * 60_000;
    utimesSync(transcriptFile, new Date(staleMs), new Date(staleMs));
    const now = Date.now();
    const info = readHungInfo({ cwd, sessionId }, now, 30 * 60_000);
    expect(info.hung).toBe(true);
    expect(info.reason).toBe('stale-no-activity');
  });

  it('a stale transcript whose newest entry is a still-pending tool_use gets grace, not an immediate hung verdict', () => {
    const now = Date.now();
    const staleTs = new Date(now - 45 * 60_000).toISOString(); // past the 30-min threshold, within the 3x grace
    writeFileSync(transcriptFile, entryLine('assistant', staleTs, [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'node scripts/verify-lane.mjs' } }]) + '\n');
    const info = readHungInfo({ cwd, sessionId }, now, 30 * 60_000);
    expect(info.hung).toBe(false);
    expect(info.reason).toBe('pending-foreground-call-within-grace');
  });

  it('missing cwd/sessionId on the row answers no-signal, never a guess', () => {
    expect(readHungInfo({}, Date.now(), 30 * 60_000)).toEqual({ hung: false, reason: 'no-signal', ageMs: null });
    expect(readHungInfo({ cwd }, Date.now(), 30 * 60_000)).toEqual({ hung: false, reason: 'no-signal', ageMs: null });
  });

  it('a session id with no transcript on disk answers no-signal, never a guess', () => {
    const info = readHungInfo({ cwd, sessionId: 'no-such-session' }, Date.now(), 30 * 60_000);
    expect(info).toEqual({ hung: false, reason: 'no-signal', ageMs: null });
  });

  it('ANY unparseable line refuses the whole read, wherever it sits in the tail — no-signal, never a partial guess (#4312 converge review)', () => {
    // `null` is valid JSON but not an object — `summarizeEntry` throws reading `.type` off it. The shared
    // primitive itself would tolerate this (skip the line, use the fresh timestamp) — but this caller cannot:
    // a dropped line's `entries` slot is gone, and `detectBlockedOnChild`'s pending-tool-call check has no way
    // to tell "this line never had a tool call" apart from "this line had one and we lost it". So readHungInfo
    // refuses the whole read on ANY parse failure, matching its shape before #4312's extraction, regardless of
    // whether the bad line is older or newer than the good one.
    const now = Date.now();
    const fresh = entryLine('assistant', new Date(now - 30_000).toISOString(), [{ type: 'text', text: 'ok' }]);
    writeFileSync(transcriptFile, `null\n${fresh}\n`);
    expect(readHungInfo({ cwd, sessionId }, now, 30 * 60_000)).toEqual({ hung: false, reason: 'no-signal', ageMs: null });

    const staleTs = new Date(now - 45 * 60_000).toISOString();
    const stale = entryLine('assistant', staleTs, [{ type: 'text', text: 'old' }]);
    writeFileSync(transcriptFile, `${stale}\nnull\n`);
    expect(readHungInfo({ cwd, sessionId }, now, 30 * 60_000)).toEqual({ hung: false, reason: 'no-signal', ageMs: null });
  });
});

// ── SHARED TRANSCRIPT-TAIL PRIMITIVE (#4312) — the one implementation readHungInfo/readIdleFinishedInfo above
// and session-reaper.mjs#resolveLastActivityMs all delegate to ────────────────────────────────────────────────
describe('readTranscriptTailActivity — the shared IO primitive, injected IO (mirrors resolveLastActivityMs\'s own tests)', () => {
  it('degenerate input never throws', () => {
    expect(readTranscriptTailActivity(null)).toBeNull();
    expect(readTranscriptTailActivity({ cwd: '/c' })).toBeNull();
    expect(readTranscriptTailActivity({ sessionId: 's1' })).toBeNull();
  });

  it('an unresolvable transcript answers null, never a guess', () => {
    const result = readTranscriptTailActivity({ cwd: '/c', sessionId: 's1' }, {
      tailLines: 15, maxBytes: 400_000, fieldMax: 200,
      resolveTranscript: () => { throw new Error('not found'); },
    });
    expect(result).toBeNull();
  });

  it('an unreadable tail answers null, never a guess', () => {
    const result = readTranscriptTailActivity({ cwd: '/c', sessionId: 's1' }, {
      tailLines: 15, maxBytes: 400_000, fieldMax: 200,
      resolveTranscript: () => '/fake/path.jsonl',
      tailLinesFn: () => { throw new Error('unreadable'); },
    });
    expect(result).toBeNull();
  });

  it('a malformed tailLinesFn result (no array `lines`) answers null — NEVER throws (#4312 converge review)', () => {
    // Old readHungInfo/readIdleFinishedInfo ran `lines.map(...)` INSIDE the same try/catch as the tailLines()
    // call, so a non-array `lines` was already covered by that catch. This primitive's own try/catch must
    // cover the identical case, or every caller's "NEVER throws" contract breaks on a malformed IO result.
    expect(readTranscriptTailActivity({ cwd: '/c', sessionId: 's1' }, {
      tailLines: 15, maxBytes: 400_000, fieldMax: 200,
      resolveTranscript: () => '/fake/path.jsonl',
      tailLinesFn: () => ({}), // no `lines` at all
    })).toBeNull();
    expect(readTranscriptTailActivity({ cwd: '/c', sessionId: 's1' }, {
      tailLines: 15, maxBytes: 400_000, fieldMax: 200,
      resolveTranscript: () => '/fake/path.jsonl',
      tailLinesFn: () => ({ lines: 'not-an-array' }),
    })).toBeNull();
  });

  it('one unparseable line never aborts the scan — the other lines still resolve a timestamp, and hadUnparseableLine reports it', () => {
    const result = readTranscriptTailActivity({ cwd: '/c', sessionId: 's1' }, {
      tailLines: 15, maxBytes: 400_000, fieldMax: 200,
      resolveTranscript: () => '/fake/path.jsonl',
      tailLinesFn: () => ({ lines: ['not json', JSON.stringify({ type: 'assistant', timestamp: '2026-09-27T20:44:34.000Z' })] }),
      summarizeEntryFn: (raw, fieldMax) => { if (raw === 'not json') throw new Error('bad'); const o = JSON.parse(raw); return { kind: o.type, ts: o.timestamp, blocks: [] }; },
    });
    expect(result.lastActivityMs).toBe(Date.parse('2026-09-27T20:44:34.000Z'));
    expect(result.entries).toHaveLength(1);
    expect(result.hadUnparseableLine).toBe(true);
  });

  it('hadUnparseableLine is false when every line in the tail parses cleanly', () => {
    const result = readTranscriptTailActivity({ cwd: '/c', sessionId: 's1' }, {
      tailLines: 15, maxBytes: 400_000, fieldMax: 200,
      resolveTranscript: () => '/fake/path.jsonl',
      tailLinesFn: () => ({ lines: [JSON.stringify({ type: 'assistant', timestamp: '2026-09-27T20:44:34.000Z' })] }),
      summarizeEntryFn: (raw, fieldMax) => { const o = JSON.parse(raw); return { kind: o.type, ts: o.timestamp, blocks: [] }; },
    });
    expect(result.hadUnparseableLine).toBe(false);
  });

  it('hadUnparseableLine is true regardless of WHERE the bad line sits — position never matters to the primitive itself (#4312 converge review)', () => {
    const oldest = JSON.stringify({ type: 'assistant', timestamp: '2026-09-27T20:44:34.000Z' });
    const result = readTranscriptTailActivity({ cwd: '/c', sessionId: 's1' }, {
      tailLines: 15, maxBytes: 400_000, fieldMax: 200,
      resolveTranscript: () => '/fake/path.jsonl',
      // The GOOD line is FIRST (older); the BAD line is LAST (the tail's own newest) — the primitive still
      // tolerates it and still reports the older timestamp; only the DESTRUCTIVE callers (readHungInfo/
      // readIdleFinishedInfo) refuse to act on a partial `entries` list, not this primitive.
      tailLinesFn: () => ({ lines: [oldest, 'not json'] }),
      summarizeEntryFn: (raw, fieldMax) => { if (raw === 'not json') throw new Error('bad'); const o = JSON.parse(raw); return { kind: o.type, ts: o.timestamp, blocks: [] }; },
    });
    expect(result.lastActivityMs).toBe(Date.parse('2026-09-27T20:44:34.000Z'));
    expect(result.hadUnparseableLine).toBe(true);
  });

  it('falls back to mtime when nothing in the tail carries a parseable timestamp, and answers null if that fails too', () => {
    const okResult = readTranscriptTailActivity({ cwd: '/c', sessionId: 's1' }, {
      tailLines: 15, maxBytes: 400_000, fieldMax: 200,
      resolveTranscript: () => '/fake/path.jsonl',
      tailLinesFn: () => ({ lines: ['not json'] }),
      summarizeEntryFn: () => { throw new Error('unparseable'); },
      statFn: () => ({ mtimeMs: 12345 }),
    });
    expect(okResult.lastActivityMs).toBe(12345);

    const failResult = readTranscriptTailActivity({ cwd: '/c', sessionId: 's1' }, {
      tailLines: 15, maxBytes: 400_000, fieldMax: 200,
      resolveTranscript: () => '/fake/path.jsonl',
      tailLinesFn: () => ({ lines: ['not json'] }),
      summarizeEntryFn: () => { throw new Error('unparseable'); },
      statFn: () => { throw new Error('ENOENT'); },
    });
    expect(failResult).toBeNull();
  });
});

// ── IDLE-TURN-ENDED BACKSTOP — #4075/xg7m2wq, live incident PR #2724, 2026-09-26 ───────────────────────────────
describe('classifyIdleFinished — PURE core', () => {
  const NOW = 1_000_000_000;
  const THRESHOLD = 10 * 60_000;

  it('fresh (age < threshold) is never finished, pending or not', () => {
    expect(classifyIdleFinished({ lastActivityMs: NOW - 1, nowMs: NOW, thresholdMs: THRESHOLD }))
      .toEqual({ finished: false, reason: 'fresh', ageMs: 1 });
  });

  it('idle with NOTHING pending → finished at once, right at the threshold', () => {
    const ageMs = THRESHOLD;
    expect(classifyIdleFinished({ lastActivityMs: NOW - ageMs, nowMs: NOW, thresholdMs: THRESHOLD }))
      .toEqual({ finished: true, reason: 'turn-ended-idle', ageMs });
  });

  it('a pending tool call is an ABSOLUTE gate — never finished, however old, unlike the hung axis\'s grace period', () => {
    const wayPastThreshold = THRESHOLD * 100;
    expect(classifyIdleFinished({ lastActivityMs: NOW - wayPastThreshold, nowMs: NOW, thresholdMs: THRESHOLD, pendingToolUse: true }))
      .toEqual({ finished: false, reason: 'pending-tool-call', ageMs: wayPastThreshold });
  });

  it('any non-finite/invalid input answers no-signal, never a guess', () => {
    expect(classifyIdleFinished({})).toEqual({ finished: false, reason: 'no-signal', ageMs: null });
    expect(classifyIdleFinished({ lastActivityMs: NaN, nowMs: NOW, thresholdMs: THRESHOLD })).toEqual({ finished: false, reason: 'no-signal', ageMs: null });
    expect(classifyIdleFinished({ lastActivityMs: NOW, nowMs: NOW, thresholdMs: 0 })).toEqual({ finished: false, reason: 'no-signal', ageMs: null });
  });
});

describe('resolveIdleFinishedThresholdMs — WE_IDLE_FINISHED_MINUTES, IO shell only', () => {
  it('defaults to 10 minutes when unset/empty', () => {
    expect(resolveIdleFinishedThresholdMs({})).toBe(DEFAULT_IDLE_FINISHED_THRESHOLD_MS);
    expect(resolveIdleFinishedThresholdMs({ WE_IDLE_FINISHED_MINUTES: '' })).toBe(DEFAULT_IDLE_FINISHED_THRESHOLD_MS);
  });
  it('reads a valid override in minutes', () => {
    expect(resolveIdleFinishedThresholdMs({ WE_IDLE_FINISHED_MINUTES: '5' })).toBe(5 * 60_000);
  });
  it('falls back to the default on garbage, floor-clamped to 1 minute', () => {
    expect(resolveIdleFinishedThresholdMs({ WE_IDLE_FINISHED_MINUTES: 'not-a-number' })).toBe(DEFAULT_IDLE_FINISHED_THRESHOLD_MS);
    expect(resolveIdleFinishedThresholdMs({ WE_IDLE_FINISHED_MINUTES: '0' })).toBe(DEFAULT_IDLE_FINISHED_THRESHOLD_MS);
  });
});

describe('readIdleFinishedInfo — the IO shell, against a REAL temp project store', () => {
  let root, projects, cwd, sessionId, transcriptFile, readIdleFinishedInfo;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'idle-finished-test-'));
    projects = join(root, 'projects');
    cwd = '/Users/fixture/workspace/lane-9';
    sessionId = 'sess-fixture-0002';
    const slug = cwd.replaceAll('/', '-');
    mkdirSync(join(projects, slug), { recursive: true });
    transcriptFile = join(projects, slug, `${sessionId}.jsonl`);
    vi.stubEnv('CLAUDE_PROJECTS_DIR', projects);
    vi.resetModules();
    ({ readIdleFinishedInfo } = await import('../hung-session.mjs'));
  });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

  it('the exact live shape (PR #2724): a turn fully ended, idle past 10 minutes → finished', () => {
    const now = Date.now();
    const staleTs = new Date(now - 20 * 60_000).toISOString(); // ~20 min idle, like ci-heal-2724
    writeFileSync(transcriptFile, entryLine('assistant', staleTs, [{ type: 'text', text: 'I rebased PR #2724 onto the latest main and pushed it… No code change was needed' }]) + '\n');
    const info = readIdleFinishedInfo({ cwd, sessionId }, now, 10 * 60_000);
    expect(info.finished).toBe(true);
    expect(info.reason).toBe('turn-ended-idle');
  });

  it('a still-pending tool_use is never finished, no matter how idle', () => {
    const now = Date.now();
    const staleTs = new Date(now - 60 * 60_000).toISOString();
    writeFileSync(transcriptFile, entryLine('assistant', staleTs, [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'node scripts/verify-lane.mjs' } }]) + '\n');
    const info = readIdleFinishedInfo({ cwd, sessionId }, now, 10 * 60_000);
    expect(info.finished).toBe(false);
    expect(info.reason).toBe('pending-tool-call');
  });

  it('missing cwd/sessionId, or no transcript on disk, answers no-signal, never a guess', () => {
    expect(readIdleFinishedInfo({}, Date.now(), 10 * 60_000)).toEqual({ finished: false, reason: 'no-signal', ageMs: null });
    expect(readIdleFinishedInfo({ cwd, sessionId: 'no-such-session' }, Date.now(), 10 * 60_000)).toEqual({ finished: false, reason: 'no-signal', ageMs: null });
  });

  it('ANY unparseable line refuses the whole read, wherever it sits in the tail — no-signal, never a partial guess (#4312 converge review)', () => {
    // Same rule as readHungInfo's own test above, and for the identical reason: a dropped line's `entries`
    // slot is gone, and this axis's pending-tool-call check cannot tell "never had a call" from "had one and
    // we lost it". Position in the tail (older or newest) makes no difference — either way, no-signal.
    const now = Date.now();
    const staleTs = new Date(now - 20 * 60_000).toISOString();
    const idle = entryLine('assistant', staleTs, [{ type: 'text', text: 'done' }]);
    writeFileSync(transcriptFile, `null\n${idle}\n`);
    expect(readIdleFinishedInfo({ cwd, sessionId }, now, 10 * 60_000)).toEqual({ finished: false, reason: 'no-signal', ageMs: null });

    writeFileSync(transcriptFile, `${idle}\nnull\n`);
    expect(readIdleFinishedInfo({ cwd, sessionId }, now, 10 * 60_000)).toEqual({ finished: false, reason: 'no-signal', ageMs: null });
  });
});

// ── CLAUDE AUTH-EXPIRED DETECTION — live incident, night of 2026-09-25/26 ET ────────────────────────────────────
// The fixture line below is the REAL transcript shape read off the actual dead sessions
// (`~/.claude/projects/*/f61f0de3-*.jsonl` and `751f205c-*.jsonl`, both `ci-heal-*` sessions dispatched
// overnight): the session's ENTIRE transcript is one synthetic assistant turn carrying this exact shape.
function authExpiredLine() {
  return JSON.stringify({
    type: 'assistant',
    timestamp: new Date().toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text: 'Login expired · Please run /login' }] },
    error: 'authentication_failed',
    isApiErrorMessage: true,
  });
}

// The summarized shape `readClaudeAuthExpiredInfo` builds for the real synthetic CLI failure turn.
const AUTH_FAIL_ENTRY = Object.freeze({
  kind: 'assistant', isApiErrorMessage: true, apiError: 'authentication_failed',
  blocks: [{ kind: 'text', text: 'Login expired · Please run /login' }],
});

describe('classifyClaudeAuthExpired — PURE core', () => {
  it('detects the real "Login expired · Please run /login" transcript shape', async () => {
    const { classifyClaudeAuthExpired } = await import('../hung-session.mjs');
    expect(classifyClaudeAuthExpired([{ ...AUTH_FAIL_ENTRY }])).toEqual({ authExpired: true, reason: 'claude-auth' });
  });

  it('an API-error turn fires on EITHER the structured error code or the CLI login phrasing (case-insensitive)', async () => {
    const { classifyClaudeAuthExpired } = await import('../hung-session.mjs');
    expect(classifyClaudeAuthExpired([{ kind: 'assistant', isApiErrorMessage: true,
      blocks: [{ kind: 'text', text: 'LOGIN EXPIRED, please run /LOGIN' }] }]))
      .toEqual({ authExpired: true, reason: 'claude-auth' });
    expect(classifyClaudeAuthExpired([{ kind: 'assistant', isApiErrorMessage: true, apiError: 'authentication_failed',
      blocks: [{ kind: 'text', text: 'some future reworded message' }] }]))
      .toEqual({ authExpired: true, reason: 'claude-auth' });
  });

  it('never fires on an unrelated assistant turn, or a user-role entry merely quoting the phrase', async () => {
    const { classifyClaudeAuthExpired } = await import('../hung-session.mjs');
    expect(classifyClaudeAuthExpired([{ kind: 'assistant', blocks: [{ kind: 'text', text: 'PR #2711 is green, landing now' }] }]))
      .toEqual({ authExpired: false, reason: 'no-signal' });
    // A `user`-role entry (e.g. an injected brief) is never scanned — mirrors
    // `transcriptShowsIntendedBlockedOnInfra`'s own `kind === 'assistant'` guard.
    expect(classifyClaudeAuthExpired([{ ...AUTH_FAIL_ENTRY, kind: 'user' }]))
      .toEqual({ authExpired: false, reason: 'no-signal' });
  });

  it('newest match wins — an older auth failure followed by real work is not flagged', async () => {
    const { classifyClaudeAuthExpired } = await import('../hung-session.mjs');
    const entries = [
      { ...AUTH_FAIL_ENTRY },
      { kind: 'assistant', blocks: [{ kind: 'text', text: 'back online, resuming the fix' }] },
    ];
    expect(classifyClaudeAuthExpired(entries)).toEqual({ authExpired: false, reason: 'no-signal' });
  });

  it('empty/missing entries answer no-signal, never a guess', async () => {
    const { classifyClaudeAuthExpired } = await import('../hung-session.mjs');
    expect(classifyClaudeAuthExpired([])).toEqual({ authExpired: false, reason: 'no-signal' });
    expect(classifyClaudeAuthExpired(undefined)).toEqual({ authExpired: false, reason: 'no-signal' });
  });

  // PR #2717 review: a healthy agent working this repo's own GitHub-auth code writes prose naming every
  // supported signature. Only the CLI's own synthetic API-error turn (`isApiErrorMessage: true`) may fire.
  const BENIGN_AUTH_PROSE = [
    'Fixed the bug: previously a 401 (Unauthorized) from the GitHub API was being misread as a hung session',
    'got a 401 response, likely unauthorized due to an expired session token',
    'Fixed the bug where the API returns 401 Unauthorized for invalid webhook signatures',
    'bad-credentials.mjs correctly flags a 401 Unauthorized response from the GitHub API',
    'Writing a test for the authentication_failed error code next',
    'The live incident transcript was one turn: "Login expired · Please run /login"',
    'request failed: 401 Unauthorized',
  ];

  it('does not classify ordinary assistant discussion of authentication errors as session expiry', async () => {
    const { classifyClaudeAuthExpired } = await import('../hung-session.mjs');
    for (const text of BENIGN_AUTH_PROSE) {
      for (const kind of ['text', 'thinking']) {
        expect(classifyClaudeAuthExpired([{ kind: 'assistant', blocks: [{ kind, text }] }]), `${kind}: ${text}`)
          .toEqual({ authExpired: false, reason: 'no-signal' });
      }
    }
  });

  it('a non-auth API error turn is not auth-expired, even when its text mentions 401', async () => {
    const { classifyClaudeAuthExpired } = await import('../hung-session.mjs');
    expect(classifyClaudeAuthExpired([{ kind: 'assistant', isApiErrorMessage: true, apiError: 'rate_limit',
      blocks: [{ kind: 'text', text: 'API Error: 429 (upstream said 401 Unauthorized earlier)' }] }]))
      .toEqual({ authExpired: false, reason: 'no-signal' });
  });

  it('an older auth failure followed by a tool_use-only assistant turn is not flagged', async () => {
    const { classifyClaudeAuthExpired } = await import('../hung-session.mjs');
    const entries = [
      { ...AUTH_FAIL_ENTRY },
      { kind: 'assistant', blocks: [{ kind: 'tool_use', name: 'Bash', input: '{"command":"git status"}' }] },
    ];
    expect(classifyClaudeAuthExpired(entries)).toEqual({ authExpired: false, reason: 'no-signal' });
  });

  it('a user prompt after the failure (re-driven after /login) clears it before the model replies', async () => {
    const { classifyClaudeAuthExpired } = await import('../hung-session.mjs');
    const entries = [{ ...AUTH_FAIL_ENTRY }, { kind: 'user', blocks: [{ kind: 'text', text: 'continue' }] }];
    expect(classifyClaudeAuthExpired(entries)).toEqual({ authExpired: false, reason: 'no-signal' });
  });

  it('metadata / tool_result-only entries after the failure neither signal nor clear', async () => {
    const { classifyClaudeAuthExpired } = await import('../hung-session.mjs');
    const entries = [{ ...AUTH_FAIL_ENTRY }, { kind: 'system', blocks: [] },
      { kind: 'user', blocks: [{ kind: 'tool_result', content: 'ok' }] }, { kind: 'cost-state', blocks: [] }];
    expect(classifyClaudeAuthExpired(entries)).toEqual({ authExpired: true, reason: 'claude-auth' });
  });
});

describe('readClaudeAuthExpiredInfo — the IO shell, against the REAL transcript shape', () => {
  let root, projects, cwd, sessionId, transcriptFile, readClaudeAuthExpiredInfo;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'auth-expired-test-'));
    projects = join(root, 'projects');
    cwd = '/Users/fixture/workspace/.operations/dispatch/e265b052-6d35-4a66-a0bb-ba4c2fac7e34';
    sessionId = 'f61f0de3-f0ad-406c-b392-614272ece0f1';
    const slug = cwd.replaceAll('/', '-');
    mkdirSync(join(projects, slug), { recursive: true });
    transcriptFile = join(projects, slug, `${sessionId}.jsonl`);
    vi.stubEnv('CLAUDE_PROJECTS_DIR', projects);
    vi.resetModules();
    ({ readClaudeAuthExpiredInfo } = await import('../hung-session.mjs'));
  });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

  it('flags the real dead-session transcript shape as auth-expired', () => {
    writeFileSync(transcriptFile, `${authExpiredLine()}\n`);
    const info = readClaudeAuthExpiredInfo({ cwd, sessionId });
    expect(info.authExpired).toBe(true);
    expect(info.reason).toBe('claude-auth');
    expect(info.transcriptPath).toBe(transcriptFile);
  });

  it('a normal, non-auth-failed transcript is never flagged', () => {
    writeFileSync(transcriptFile, `${entryLine('assistant', new Date().toISOString(), [{ type: 'text', text: 'working the fix now' }])}\n`);
    const info = readClaudeAuthExpiredInfo({ cwd, sessionId });
    expect(info.authExpired).toBe(false);
    expect(info.reason).toBe('no-signal');
  });

  it('still flags the failure once many CLI metadata lines have piled up after it (real layout)', () => {
    const meta = ['system', 'last-prompt', 'custom-title', 'agent-name', 'mode', 'permission-mode', 'atis-latch', 'cost-state']
      .map((type) => JSON.stringify({ type, timestamp: new Date().toISOString() }));
    // The live incident's 9 trailing lines, plus three re-attach cycles' worth.
    const trailing = Array.from({ length: 4 }, () => meta).flat();
    writeFileSync(transcriptFile, `${[authExpiredLine(), ...trailing].join('\n')}\n`);
    expect(readClaudeAuthExpiredInfo({ cwd, sessionId }).authExpired).toBe(true);
  });

  it('a healthy session narrating a 401 / quoting the login-expired phrase is never flagged', () => {
    writeFileSync(transcriptFile, `${entryLine('assistant', new Date().toISOString(), [
      { type: 'text', text: 'got a 401 Unauthorized from the GitHub API; the incident said "Login expired · Please run /login"' },
    ])}\n`);
    expect(readClaudeAuthExpiredInfo({ cwd, sessionId }).authExpired).toBe(false);
  });

  it('missing cwd/sessionId, or no transcript on disk, answers no-signal, never a guess', () => {
    expect(readClaudeAuthExpiredInfo({})).toEqual({ authExpired: false, reason: 'no-signal' });
    expect(readClaudeAuthExpiredInfo({ cwd, sessionId: 'no-such-session' })).toEqual({ authExpired: false, reason: 'no-signal' });
  });
});
