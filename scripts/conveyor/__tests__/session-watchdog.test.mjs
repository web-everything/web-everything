/**
 * @file scripts/conveyor/__tests__/session-watchdog.test.mjs
 * @description xegykal — the session watchdog: config merge, kind grammar, standard duration from heavy-admission
 *   medians, command signatures, every classification, every planned action, the IO pass (acting and report-only,
 *   event dedupe and ack), the four smells, and the health-watch probe's interval cache. The fix-3771 replay uses
 *   the recorded transcript fixture (`soak/breaks/fixtures/fix-3771-wait-loop.jsonl`) read through agent-health's own
 *   bounded reader.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_SESSION_WATCHDOG, CLASSES, ESCALATION_EVENT_TYPE, resolveSessionWatchdogConfig, watchdogKindOf, standardDuration,
  commandSegments, summarizeTail, classifyWatchdogSession, planWatchdog, runSessionWatchdogPass, escalationKey,
  readEscalationLedger, appendEscalationEvent, renderWatchdogPass, defaultClaimStoreReadable, readWatchdogTail, makeStopAwaitingVerifyResolver, makeStopChatSpawnGuardResolver,
} from '../session-watchdog.mjs';
import { tailLines, summarizeEntry } from '../../../skills-src/inspect-agent-health/agent-health.mjs';
import fixerStuck from '../health-smells/fixer-stuck.mjs';
import claimNoProgress from '../health-smells/fix-claim-held-no-progress.mjs';
import sessionStuck from '../health-smells/session-stuck.mjs';
import ghostListed from '../health-smells/ghost-session-listed.mjs';
import { probeSessionWatchdog } from '../health-watch.mjs';
import { runHealthTick, emptyHealthState } from '../health-watch-core.mjs';
import { fixDispatchClaimRoot, listFixDispatchClaims } from '../fix-claim-store.mjs';
import { listLiveFixClaims } from '../fix-procedure.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '..', 'soak', 'breaks', 'fixtures', 'fix-3771-wait-loop.jsonl');
const MIN = 60_000;
const T0 = Date.parse('2026-10-04T12:00:00Z');
const CFG = DEFAULT_SESSION_WATCHDOG;

/** A `summarizeEntry`-shaped tool_use entry and its result. */
let seq = 0;
function call(name, input, atMs, durMs = 1000, { pending = false } = {}) {
  const id = `t${++seq}`;
  const use = { kind: 'assistant', ts: new Date(atMs).toISOString(), blocks: [{ kind: 'tool_use', id, name, input: '', rawInput: input }] };
  if (pending) return [use];
  return [use, { kind: 'user', ts: new Date(atMs + durMs).toISOString(), blocks: [{ kind: 'tool_result', toolUseId: id, isError: false, content: '' }] }];
}
const bash = (command, atMs, durMs, o) => call('Bash', { command }, atMs, durMs, o);
const WAIT = 'cd /lanes/lane-1; node /w/wev-review-daemon/scripts/verify-lane.mjs check --wait=540000 --json --repo=. 2>/dev/null | cut -c1-900 | tail -1';
const reply = (atMs) => ({ kind: 'assistant', ts: new Date(atMs).toISOString(), blocks: [{ kind: 'text', text: 'Done — PR merged.' }] });

const standard20 = { ms: 20 * MIN, minutes: 20 };
const row = (over = {}) => ({ name: 'fix-3771', kind: 'background', state: 'working', startedAt: T0 - 90 * MIN, sessionId: 'sid-1', id: 'f29aeb29', ...over });

function loopTail(nowMs, n = 4, { pendingLast = true } = {}) {
  const entries = [...bash('git add -u; git commit -q -F .m', T0 - 60 * MIN, 2000), ...call('Edit', { file_path: '/x/a.mjs' }, T0 - 61 * MIN)];
  for (let i = 0; i < n; i++) {
    const at = T0 - 50 * MIN + i * 9 * MIN;
    entries.push(...bash(WAIT, at, 9 * MIN, { pending: pendingLast && i === n - 1 }));
  }
  return summarizeTail(entries, { nowMs });
}

describe('resolveSessionWatchdogConfig — config extends the platform default', () => {
  it('no override is the default', () => {
    expect(resolveSessionWatchdogConfig(undefined)).toEqual({ config: CFG, error: null });
  });
  it('scalar keys replace; per-kind maps merge by kind', () => {
    const { config, error } = resolveSessionWatchdogConfig({ intervalMinutes: 10, fallbackMinutes: { fix: 60 }, act: false });
    expect(error).toBeNull();
    expect(config.intervalMinutes).toBe(10);
    expect(config.fallbackMinutes).toEqual({ ...CFG.fallbackMinutes, fix: 60 });
    expect(config.act).toBe(false);
    expect(config.waitLoopRepeats).toBe(CFG.waitLoopRepeats);
  });
  it('an invalid override is reported and ignored, never half-applied', () => {
    for (const bad of [{ intervalMinutes: 0 }, { nope: 1 }, { fallbackMinutes: { lint: 3 } }, { act: 'yes' }, [1]]) {
      const r = resolveSessionWatchdogConfig(bad);
      expect(r.config).toBe(CFG);
      expect(r.error).toMatch(/session-watchdog config/);
    }
  });
});

describe('watchdogKindOf', () => {
  it.each([
    ['fix-3771', 'fix', true], ['ci-heal-pa-202', 'ci-heal', true], ['review-3890', 'review', true],
    ['conveyor-4123', 'build', false], ['build-4100', 'build', false], ['prepare-2768', 'prepare', false], ['prepare-decision-12', 'prepare', false],
  ])('%s → %s', (name, kind, prBound) => {
    expect(watchdogKindOf(name)).toMatchObject({ kind, prBound });
  });
  it('an interactive or unknown name is not a conveyor session', () => {
    expect(watchdogKindOf('my-terminal')).toBeNull();
    expect(watchdogKindOf(undefined)).toBeNull();
  });
});

describe('standardDuration — heavy-admission medians x factor, with fallback', () => {
  const rolling = { minutes: { selected: 4.8, standards: 1, FULL: 0.1, files: 0.07, other: 5 }, source: { selected: { from: 'rolling', samples: 20 }, standards: { from: 'rolling', samples: 20 } } };
  it('uses the rolling demand x factor, floored per kind', () => {
    expect(standardDuration('fix', rolling)).toMatchObject({ source: 'rolling', minutes: 20 }); // 5.8 x 2 = 11.6 < floor 20
    expect(standardDuration('fix', rolling, { ...CFG, floorMinutes: { ...CFG.floorMinutes, fix: 5 } })).toMatchObject({ minutes: 11.6 });
    expect(standardDuration('build', { ...rolling, minutes: { ...rolling.minutes, selected: 20 } })).toMatchObject({ source: 'rolling', minutes: 84 }); // (20 + 1) x 2 runs for a size-3 build, x 2
  });
  it('falls back with too few samples, and for a kind with no heavy demand', () => {
    const thin = { ...rolling, source: { selected: { from: 'rolling', samples: 2 }, standards: { from: 'rolling', samples: 2 } } };
    expect(standardDuration('fix', thin)).toMatchObject({ source: 'fallback', minutes: 45 });
    expect(standardDuration('review', rolling)).toMatchObject({ source: 'fallback', minutes: 30 });
    expect(standardDuration('fix', null)).toMatchObject({ source: 'fallback', minutes: 45 });
  });
});

describe('commandSegments', () => {
  it('reads the same wait whatever it is piped into, chained with, or where the script lives', () => {
    expect(commandSegments('Bash', { command: WAIT })).toEqual(['node verify-lane.mjs check --wait=540000 --json --repo=.']);
    expect(commandSegments('Bash', { command: 'node /a/b/verify-lane.mjs check --wait=540000 --json --repo=. | tail -2; echo ok' }))
      .toContain('node verify-lane.mjs check --wait=540000 --json --repo=.');
  });
  it('a quoted commit message never splits or signs a command', () => {
    expect(commandSegments('Bash', { command: 'printf "%s\\n" "a; b && c" > .m; git commit -q -F .m' })).toEqual(['printf "" ""', 'git commit -q -F .m']);
  });
  it('other tools sign by tool and target basename', () => {
    expect(commandSegments('Edit', { file_path: '/x/y/z.mjs' })).toEqual(['Edit:z.mjs']);
  });
});

describe('classifyWatchdogSession — each class', () => {
  const NOW = T0;
  it('within-standard: not inspected before its standard duration', () => {
    expect(classifyWatchdogSession({ row: row({ startedAt: NOW - 5 * MIN }), tail: null, nowMs: NOW, standard: standard20 }).class).toBe(CLASSES.WITHIN);
  });
  it('waiting-loop: the same long command repeated with no change since its first run', () => {
    const v = classifyWatchdogSession({ row: row(), tail: loopTail(NOW), nowMs: NOW, standard: standard20 });
    expect(v.class).toBe(CLASSES.WAITING);
    expect(v.evidence).toMatchObject({ repeats: 4, signature: 'node verify-lane.mjs check --wait=540000 --json --repo=.' });
  });
  it('not a waiting-loop when the repeats are quick (habit, not a wait) or interleaved with edits (iterating)', () => {
    const quick = [];
    for (let i = 0; i < 5; i++) quick.push(...bash('git log --oneline -1', NOW - 10 * MIN + i * MIN, 500), ...call('Read', { file_path: `/f${i}` }, NOW - 10 * MIN + i * MIN + 1000));
    expect(classifyWatchdogSession({ row: row(), tail: summarizeTail(quick, { nowMs: NOW }), nowMs: NOW, standard: standard20 }).class).toBe(CLASSES.ACTIVE);
    const iterating = [];
    for (let i = 0; i < 4; i++) iterating.push(...bash('npx vitest run a.test.mjs', NOW - 40 * MIN + i * 9 * MIN, 6 * MIN), ...call('Edit', { file_path: '/a.mjs' }, NOW - 40 * MIN + i * 9 * MIN + 7 * MIN));
    expect(classifyWatchdogSession({ row: row(), tail: summarizeTail(iterating, { nowMs: NOW }), nowMs: NOW, standard: standard20 }).class).toBe(CLASSES.ACTIVE);
  });
  it('active-progress: distinct calls with edits and commits', () => {
    const t = summarizeTail([...call('Edit', { file_path: '/a' }, NOW - 3 * MIN), ...bash('git commit -q -m x', NOW - 2 * MIN), ...bash('npx vitest run', NOW - MIN, 30_000)], { nowMs: NOW });
    expect(classifyWatchdogSession({ row: row(), tail: t, nowMs: NOW, standard: standard20 })).toMatchObject({ class: CLASSES.ACTIVE, reason: 'edits-or-commits' });
  });
  it('stalled: idle with nothing pending past stalledIdleMinutes', () => {
    const t = summarizeTail(bash('ls', NOW - 40 * MIN), { nowMs: NOW });
    expect(classifyWatchdogSession({ row: row(), tail: t, nowMs: NOW, standard: standard20 })).toMatchObject({ class: CLASSES.STALLED, reason: 'idle' });
  });
  it('stalled: one call pending past stalledBlockedMinutes', () => {
    const t = summarizeTail(bash('node hang.mjs', NOW - 50 * MIN, 0, { pending: true }), { nowMs: NOW });
    expect(classifyWatchdogSession({ row: row(), tail: t, nowMs: NOW, standard: standard20 })).toMatchObject({ class: CLASSES.STALLED, reason: 'blocked-on-one-call' });
  });
  it('a pending call inside the blocked threshold is not stalled', () => {
    const t = summarizeTail(bash('node verify.mjs', NOW - 8 * MIN, 0, { pending: true }), { nowMs: NOW });
    expect(classifyWatchdogSession({ row: row(), tail: t, nowMs: NOW, standard: standard20 }).class).toBe(CLASSES.ACTIVE);
  });
  it('finished-but-listed: a done completion record, or a transcript that ended on a plain reply', () => {
    const t = summarizeTail([...bash('gh pr view 1', NOW - 20 * MIN), reply(NOW - 19 * MIN)], { nowMs: NOW });
    expect(t.endedOnReply).toBe(true);
    expect(classifyWatchdogSession({ row: row(), tail: t, nowMs: NOW, standard: standard20 })).toMatchObject({ class: CLASSES.FINISHED, reason: 'transcript-ended' });
    expect(classifyWatchdogSession({ row: row(), tail: loopTail(NOW), nowMs: NOW, standard: standard20, completionDone: true })).toMatchObject({ class: CLASSES.FINISHED, reason: 'completion-record-done' });
  });
  it('ghost: transcript older than ghostHours and no live process', () => {
    const old = NOW - 20 * 24 * 60 * MIN;
    const t = summarizeTail([...bash('ls', old), reply(old + 1000)], { nowMs: NOW });
    const r = row({ startedAt: old - MIN });
    expect(classifyWatchdogSession({ row: r, tail: t, nowMs: NOW, standard: standard20, pidAlive: false }).class).toBe(CLASSES.GHOST);
    // a live process is never a ghost, however old its transcript
    expect(classifyWatchdogSession({ row: r, tail: t, nowMs: NOW, standard: standard20, pidAlive: true }).class).not.toBe(CLASSES.GHOST);
    // no transcript at all: a ghost only when the process is confirmed gone
    expect(classifyWatchdogSession({ row: r, tail: null, nowMs: NOW, standard: standard20, pidAlive: false }).class).toBe(CLASSES.GHOST);
    expect(classifyWatchdogSession({ row: r, tail: null, nowMs: NOW, standard: standard20, pidAlive: null }).class).toBe(CLASSES.NO_SIGNAL);
  });
});

describe('the fix-3771 replay (recorded transcript, 2026-10-04)', () => {
  const entries = tailLines(FIXTURE, 200, 1_500_000).lines.map((l) => summarizeEntry(l, 200));
  const at = (iso) => {
    const now = Date.parse(iso);
    const upTo = entries.filter((e) => Date.parse(e.ts) <= now);
    return classifyWatchdogSession({ row: row({ startedAt: Date.parse('2026-10-04T11:53:10.915Z') }), tail: summarizeTail(upTo, { nowMs: now }), nowMs: now, standard: standard20 });
  };
  it('reads waiting-loop at the 09:20 ET manual check (13:20Z), on the verify-lane wait', () => {
    const v = at('2026-10-04T13:20:00Z');
    expect(v.class).toBe(CLASSES.WAITING);
    expect(v.evidence.signature).toBe('node verify-lane.mjs check --wait=540000 --json --repo=.');
    expect(v.evidence.repeats).toBeGreaterThanOrEqual(3);
  });
  it('already reads waiting-loop at 12:20Z, an hour before the manual check', () => {
    expect(at('2026-10-04T12:20:00Z').class).toBe(CLASSES.WAITING);
  });
});

describe('planWatchdog — findings, actions, events', () => {
  const NOW = T0;
  const claim = (over = {}) => ({ meta: { repo: 'we', pr: 3771, kind: 'fixing', who: 'fix-3771', sessionId: 'sid-1', headSha: 'abc123', claimedAt: new Date(NOW - 87 * MIN).toISOString(), ...over } });
  const standardFor = () => standard20;
  const stuckRow = { name: 'fix-3771', id: 'f29aeb29', sessionId: 'sid-1', kind: 'fix', class: CLASSES.WAITING, reason: 'same-command-repeated', evidence: { repeats: 4 } };

  it('a fixer holding a claim in a waiting-loop → fixer-stuck finding + one typed escalation event', () => {
    const p = planWatchdog({ rows: [stuckRow], claims: [claim()], standardFor, nowMs: NOW });
    expect(p.findings.find((f) => f.type === 'fixer-stuck')).toMatchObject({ repo: 'we', pr: 3771, classification: 'waiting-loop', claimAgeMinutes: 87 });
    expect(p.events).toHaveLength(1);
    expect(p.events[0]).toMatchObject({ type: ESCALATION_EVENT_TYPE, v: 1, repo: 'we', pr: 3771, claimKind: 'fixing', classification: 'waiting-loop', headSha: 'abc123', ask: 'escalate-fixer', session: { name: 'fix-3771', id: 'f29aeb29', sessionId: 'sid-1' } });
    expect(p.events[0].key).toBe(escalationKey({ repo: 'we', pr: 3771, sessionId: 'sid-1', classification: 'waiting-loop', headSha: 'abc123' }));
  });
  it('a claim held past standard with the PR head unchanged → fix-claim-held-no-progress; a moved head does not', () => {
    const active = { ...stuckRow, class: CLASSES.ACTIVE };
    expect(planWatchdog({ rows: [active], claims: [claim()], prHeadFor: () => 'abc123', standardFor, nowMs: NOW }).findings.map((f) => f.type)).toEqual(['fix-claim-held-no-progress']);
    expect(planWatchdog({ rows: [active], claims: [claim()], prHeadFor: () => 'def456', standardFor, nowMs: NOW }).findings).toEqual([]);
    expect(planWatchdog({ rows: [active], claims: [claim()], prHeadFor: () => null, standardFor, nowMs: NOW }).findings).toEqual([]);
    expect(planWatchdog({ rows: [active], claims: [claim({ claimedAt: new Date(NOW - 5 * MIN).toISOString() })], prHeadFor: () => 'abc123', standardFor, nowMs: NOW }).findings).toEqual([]);
  });
  it('a stuck session with no claim → session-stuck, no event', () => {
    const p = planWatchdog({ rows: [{ ...stuckRow, name: 'conveyor-4100', sessionId: 'sid-9', kind: 'build', class: CLASSES.STALLED }], claims: [claim()], standardFor, nowMs: NOW });
    expect(p.findings.map((f) => f.type)).toContain('session-stuck');
    expect(p.events).toEqual([]);
  });
  it('a ghost → clear-ghost (safe only with a confirmed-dead process and a handle) + claim releases', () => {
    const ghost = { name: 'fix-2115', id: '3e63a0f4', sessionId: 'sid-g', listingKind: 'background', kind: 'fix', prBound: true, repo: 'we', target: '2115', class: CLASSES.GHOST, pidAlive: false };
    const p = planWatchdog({ rows: [ghost], claims: [claim({ pr: 2115, who: 'fix-2115', sessionId: 'sid-g' })], standardFor, nowMs: NOW });
    expect(p.actions).toEqual(expect.arrayContaining([
      { type: 'clear-ghost', handle: '3e63a0f4', session: 'fix-2115', safe: true },
      { type: 'release-dispatch-claims', repo: 'we', pr: 2115, session: 'fix-2115' },
      expect.objectContaining({ type: 'release-fix-claim', repo: 'we', pr: 2115, who: 'fix-2115', sessionId: 'sid-g' }),
    ]));
    const unknown = planWatchdog({ rows: [{ ...ghost, pidAlive: null }], claims: [], standardFor, nowMs: NOW });
    expect(unknown.actions.find((a) => a.type === 'clear-ghost').safe).toBe(false);
  });
  const ghostRow = { name: 'fix-2115', id: '3e63a0f4', sessionId: 'sid-g', listingKind: 'background', kind: 'fix', prBound: true, repo: 'we', target: '2115', class: CLASSES.GHOST, pidAlive: false };
  const liveRow = { ...ghostRow, id: 'a1b2c3d4', sessionId: 'sid-live', class: CLASSES.ACTIVE, pidAlive: true, reason: 'distinct-tool-calls', evidence: {} };
  const releases = (p) => p.actions.filter((a) => a.type !== 'clear-ghost');
  it('a same-name ghost listed BEFORE a live session never releases the live session\'s claims', () => {
    const liveClaim = claim({ pr: 2115, who: 'fix-2115', sessionId: 'sid-live' });
    for (const rows of [[ghostRow, liveRow], [liveRow, ghostRow]]) {
      const p = planWatchdog({ rows, claims: [liveClaim], standardFor, nowMs: NOW });
      expect(releases(p)).toEqual([]);
      expect(p.findings.find((f) => f.type === 'fixer-stuck')).toBeUndefined();
    }
  });
  it('a claim with a sessionId is held by that session only; the name is the fallback for a claim without one', () => {
    const p = planWatchdog({ rows: [ghostRow, liveRow], claims: [claim({ pr: 2115, who: 'fix-2115', sessionId: 'sid-g' })], standardFor, nowMs: NOW });
    // the ghost's OWN claim is releasable by sessionId, but its dispatch-claim release is withheld: a live row shares its name
    expect(releases(p)).toEqual([expect.objectContaining({ type: 'release-fix-claim', sessionId: 'sid-g' })]);
    const noSid = planWatchdog({ rows: [ghostRow], claims: [claim({ pr: 2115, who: 'fix-2115', sessionId: undefined })], standardFor, nowMs: NOW });
    expect(releases(noSid).map((a) => a.type).sort()).toEqual(['release-dispatch-claims', 'release-fix-claim']);
    const sharedNoSid = planWatchdog({ rows: [ghostRow, liveRow], claims: [claim({ pr: 2115, who: 'fix-2115', sessionId: undefined })], standardFor, nowMs: NOW });
    expect(releases(sharedNoSid)).toEqual([]);
  });
  it('liveness matrix: only a CONFIRMED-dead ghost releases claims or is cleared safely', () => {
    const c = claim({ pr: 2115, who: 'fix-2115', sessionId: 'sid-g' });
    for (const [pidAlive, expected] of [[false, true], [null, false], [true, false]]) {
      const p = planWatchdog({ rows: [{ ...ghostRow, pidAlive }], claims: [c], standardFor, nowMs: NOW });
      expect(releases(p).length > 0, `pidAlive=${pidAlive}`).toBe(expected);
      expect(p.actions.find((a) => a.type === 'clear-ghost').safe).toBe(expected);
    }
  });
});

describe('runSessionWatchdogPass — the IO shell with fakes', () => {
  const NOW = T0;
  const listing = [
    { name: 'fix-3771', id: 'f29aeb29', kind: 'background', state: 'working', startedAt: NOW - 90 * MIN, sessionId: 'sid-1', pid: 2009, cwd: '/d' },
    { name: 'fix-2115', id: '3e63a0f4', kind: 'background', state: 'working', startedAt: NOW - 20 * 24 * 60 * MIN, sessionId: 'sid-g', cwd: '/w' },
    { name: 'review-3890', id: 'r1', kind: 'background', state: 'working', startedAt: NOW - 2 * MIN, sessionId: 'sid-r', pid: 3, cwd: '/r' },
    { name: 'fix-1', id: 'done1', kind: 'background', state: 'done', startedAt: NOW - 99 * MIN, sessionId: 'sid-d' },
    { name: 'operator', kind: 'interactive', startedAt: NOW - 999 * MIN, sessionId: 'sid-i' },
  ];
  const old = NOW - 19 * 24 * 60 * MIN;
  const tails = { 'sid-1': loopTail(NOW), 'sid-g': summarizeTail([...bash('ls', old), reply(old + 1000)], { nowMs: NOW }) };
  const claims = [{ meta: { repo: 'we', pr: 3771, kind: 'fixing', who: 'fix-3771', sessionId: 'sid-1', headSha: 'abc', claimedAt: new Date(NOW - 87 * MIN).toISOString() } }];
  const base = (over = {}) => {
    const calls = { rm: [], events: [], tailReads: [] };
    const opts = {
      nowMs: NOW, agents: listing, processes: [{ pid: 2009, command: 'claude' }, { pid: 3, command: 'claude' }],
      readTail: (r) => { calls.tailReads.push(r.name); return tails[r.sessionId] ?? null; },
      listDispatchClaims: () => [], chatSpawnGuardFor: () => ({ blocked: false }), awaitingVerifyFor: () => ({ awaiting: false }), readHeavy: () => null, listClaims: () => claims, prHeadFor: () => 'abc', completionFor: () => null,
      rm: ({ handle }) => { calls.rm.push(handle); return { removed: true, alreadyGone: false }; },
      releaseFixing: () => ({ released: false, reason: 'absent' }), releaseDispatch: () => ({ released: [], skipped: [] }),
      readLedger: () => ({ emitted: new Set(), acked: new Set() }), appendEvent: (e) => calls.events.push(e),
      relist: () => [], readRmLedger: () => ({}), writeRmLedger: (l) => { calls.rmLedger = l; },
      ...over,
    };
    return { calls, result: runSessionWatchdogPass(opts) };
  };

  it('lists only live background conveyor sessions, and reads a transcript only past the standard duration', () => {
    const { result, calls } = base({ act: false });
    expect(result.rows.map((r) => [r.name, r.class])).toEqual([
      ['fix-3771', CLASSES.WAITING], ['fix-2115', CLASSES.GHOST], ['review-3890', CLASSES.WITHIN],
    ]);
    expect(calls.tailReads).toEqual(['fix-3771', 'fix-2115']);
  });
  it('report-only takes no action and writes no event', () => {
    const { result, calls } = base({ act: false });
    expect(calls.rm).toEqual([]);
    expect(calls.events).toEqual([]);
    expect(result.actions.every((a) => a.ok === null)).toBe(true);
    expect(result.findings.map((f) => f.type).sort()).toEqual(['fix-claim-held-no-progress', 'fixer-stuck']);
  });
  it('acting clears the ghost with claude rm and writes the escalation event once', () => {
    const { result, calls } = base({ act: true });
    expect(calls.rm).toEqual(['3e63a0f4']);
    expect(result.actions.find((a) => a.type === 'clear-ghost')).toMatchObject({ ok: true, detail: 'removed' });
    expect(calls.events).toHaveLength(1);
    const again = base({ act: true, readLedger: () => ({ emitted: new Set([calls.events[0].key]), acked: new Set() }) });
    expect(again.calls.events).toEqual([]);
    expect(again.result.events[0].written).toBe(true);
  });
  it('claude rm that reports success but leaves the row listed (issue #77683) is not counted cleared, and is remembered', () => {
    const { result, calls } = base({ act: true, relist: () => listing });
    expect(result.actions.find((a) => a.type === 'clear-ghost')).toMatchObject({ ok: false, ineffective: true });
    expect(Object.keys(calls.rmLedger)).toEqual(['3e63a0f4']);
    const next = base({ act: true, relist: () => listing, readRmLedger: () => ({ '3e63a0f4': new Date(NOW - 60 * MIN).toISOString() }) });
    expect(next.calls.rm).toEqual([]);
    expect(next.result.actions.find((a) => a.type === 'clear-ghost')).toMatchObject({ ok: false, ineffective: true });
    const smell = ghostListed.evaluate({ sessionWatchdog: next.result });
    expect(smell[0]).toMatchObject({ breach: true });
    expect(smell[0].recommendation).toMatch(/clear-stuck-session/);
  });
  it('a failing claude rm is reported, never thrown', () => {
    const { result } = base({ act: true, rm: () => { throw new Error('rm exploded'); } });
    expect(result.actions.find((a) => a.type === 'clear-ghost')).toMatchObject({ ok: false, detail: 'rm exploded' });
  });
  it('renders one line per session', () => {
    const text = renderWatchdogPass(base({ act: false }).result);
    expect(text).toMatch(/fix-3771\s+waiting-loop/);
    expect(text).toMatch(/fix-2115\s+ghost/);
  });
});

describe('escalation event log + ack', () => {
  it('appends JSONL and reads emitted and acknowledged keys back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'watchdog-events-'));
    appendEscalationEvent({ type: ESCALATION_EVENT_TYPE, key: 'k1' }, dir);
    writeFileSync(join(dir, 'fixer-escalations.ack.jsonl'), `${JSON.stringify({ key: 'k1', by: 'ladder' })}\n`);
    const l = readEscalationLedger(dir);
    expect([...l.emitted]).toEqual(['k1']);
    expect([...l.acked]).toEqual(['k1']);
    expect(JSON.parse(readFileSync(join(dir, 'fixer-escalations.jsonl'), 'utf8').trim())).toMatchObject({ key: 'k1' });
  });
});

describe('the four smells', () => {
  const pass = {
    acked: [],
    findings: [
      { type: 'fixer-stuck', repo: 'we', pr: 3771, session: { name: 'fix-3771' }, classification: 'waiting-loop', reason: 'same-command-repeated', evidence: { repeats: 11, signature: 'node verify-lane.mjs check' }, claimAgeMinutes: 87, standardMinutes: 20, key: 'k1' },
      { type: 'fix-claim-held-no-progress', repo: 'we', pr: 3771, session: { name: 'fix-3771' }, claimAgeMinutes: 87, standardMinutes: 20, headSha: 'abc123456789', holderClass: 'waiting-loop' },
      { type: 'session-stuck', session: { name: 'conveyor-4100' }, kind: 'build', classification: 'stalled', reason: 'idle', evidence: { runtimeMinutes: 200, standardMinutes: 30, idleMinutes: 40 } },
    ],
    rows: [
      { name: 'fix-2115', class: 'ghost', state: 'working', id: '3e63a0f4', pidAlive: false, evidence: { idleMinutes: 28000 } },
      { name: 'fix-2267', class: 'ghost', state: 'working', id: '3a95799b', pidAlive: false, evidence: { idleMinutes: 27000 } },
    ],
    actions: [
      { type: 'clear-ghost', session: 'fix-2115', ok: true, detail: 'removed' },
      { type: 'clear-ghost', session: 'fix-2267', ok: false, detail: 'refused: process liveness unknown or no handle' },
    ],
  };
  it('fixer-stuck: human-only until the ladder acknowledges the event', () => {
    const [r] = fixerStuck.evaluate({ sessionWatchdog: pass });
    expect(r).toMatchObject({ subject: 'pr:we#3771', breach: true, escalation: { humanOnly: true, actionRef: 'pr:we#3771' } });
    expect(r.summary).toMatch(/11x/);
    const [acked] = fixerStuck.evaluate({ sessionWatchdog: { ...pass, acked: ['k1'] } });
    expect(acked.escalation.humanOnly).toBe(false);
  });
  it('the episode carries the escalation, so the WIP page lists it as needing a person', () => {
    const { state } = runHealthTick(emptyHealthState(), { sessionWatchdog: pass }, [fixerStuck], T0);
    const ep = Object.values(state.episodes)[0];
    expect(ep).toMatchObject({ status: 'open', smell: 'fixer-stuck', escalation: { humanOnly: true, actionRef: 'pr:we#3771' } });
  });
  it('fix-claim-held-no-progress', () => {
    expect(claimNoProgress.evaluate({ sessionWatchdog: pass })).toEqual([expect.objectContaining({ subject: 'pr:we#3771', breach: true })]);
  });
  it('session-stuck opens only after two passes', () => {
    expect(sessionStuck.openAfter).toBe(2);
    expect(sessionStuck.evaluate({ sessionWatchdog: pass })).toEqual([expect.objectContaining({ subject: 'session:conveyor-4100', breach: true })]);
  });
  it('ghost-session-listed breaches only for a ghost the watchdog could not clear', () => {
    const out = ghostListed.evaluate({ sessionWatchdog: pass });
    expect(out.find((r) => r.subject === 'session:fix-2115')).toMatchObject({ breach: false });
    expect(out.find((r) => r.subject === 'session:fix-2267')).toMatchObject({ breach: true, escalation: { humanOnly: true } });
  });
});

describe('probeSessionWatchdog — interval cache in the health dir', () => {
  it('runs a pass when due, reuses the cached result until intervalMinutes passes, and never acts on --dry-run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'watchdog-health-'));
    const runs = [];
    const runPass = (o) => { runs.push(o); return { at: new Date(o.nowMs).toISOString(), rows: [], findings: [], actions: [], events: [], acked: [] }; };
    probeSessionWatchdog({ dir, now: T0, runPass, processes: [] });
    expect(runs).toHaveLength(1);
    expect(runs[0].act).toBe(true);
    expect(probeSessionWatchdog({ dir, now: T0 + 2 * MIN, runPass }).cached).toBe(true);
    expect(runs).toHaveLength(1);
    probeSessionWatchdog({ dir, now: T0 + 5 * MIN, runPass });
    expect(runs).toHaveLength(2);
    probeSessionWatchdog({ dir, now: T0 + 120 * MIN, runPass, config: { sessionWatchdog: { intervalMinutes: 60 } }, flags: { 'dry-run': true } });
    expect(runs.at(-1).act).toBe(false);
  });
  it('every fixture flag and every fixture-scoped tick flag disables acting on its own, and a scoped tick reads no host state', () => {
    const empty = (o) => ({ at: new Date(o.nowMs).toISOString(), rows: [], findings: [], actions: [], events: [], acked: [] });
    const fx = join(mkdtempSync(join(tmpdir(), 'watchdog-fx-')), 'f.json');
    writeFileSync(fx, '[]');
    const cases = [
      { 'watchdog-agents-fixture': fx }, { 'watchdog-claims-fixture': fx }, { 'watchdog-heads-fixture': fx },
      { 'state-root': '/x' }, { 'logs-dir': '/x' }, { 'lock-root': '/x' },
      { 'watchdog-claims-fixture': fx, 'watchdog-heads-fixture': fx },
    ];
    for (const flags of cases) {
      const dir = mkdtempSync(join(tmpdir(), 'watchdog-health-'));
      const runs = [];
      probeSessionWatchdog({ dir, now: T0, flags, runPass: (o) => { runs.push(o); return empty(o); } });
      expect(runs[0].act, JSON.stringify(Object.keys(flags))).toBe(false);
      const isScoped = !!(flags['state-root'] || flags['logs-dir'] || flags['lock-root']);
      // a fixture replay never writes the cache the live host reads back
      if (!isScoped) expect(() => readFileSync(join(dir, 'session-watchdog.json'))).toThrow(/ENOENT/);
      if (isScoped) {
        // no real `claude agents`, claims, PR heads, heavy-admission read or coordination-root event log
        expect(runs[0].agents).toEqual([]);
        expect(runs[0].listClaims()).toEqual([]);
        expect(runs[0].prHeadFor('we', 1)).toBeNull();
        expect(runs[0].readHeavy()).toBeNull();
        expect(runs[0].eventDir.startsWith(dir)).toBe(true);
      }
    }
  });
  it('tick() under --state-root never executes `claude` or acts on the host', async () => {
    const { tick } = await import('../health-watch.mjs');
    const bin = mkdtempSync(join(tmpdir(), 'watchdog-bin-'));
    const sentinel = join(bin, 'claude-ran');
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\necho ran >> "${sentinel}"\necho '[]'\n`, { mode: 0o755 });
    const root = mkdtempSync(join(tmpdir(), 'watchdog-tick-'));
    const prevPath = process.env.PATH;
    process.env.PATH = `${bin}:${prevPath}`;
    try {
      const out = await tick({ 'state-root': root, 'logs-dir': root, 'lock-root': root, 'no-gh': true });
      expect(JSON.stringify(out).includes('sessionWatchdogConfig')).toBe(false);
    } finally { process.env.PATH = prevPath; }
    expect(() => readFileSync(sentinel)).toThrow(/ENOENT/);
  }, 60_000);
  it('an invalid sessionWatchdog config is reported, and the default stands', () => {
    const dir = mkdtempSync(join(tmpdir(), 'watchdog-health-'));
    const r = probeSessionWatchdog({ dir, now: T0, runPass: (o) => ({ at: new Date(o.nowMs).toISOString(), cfg: o.config }), config: { sessionWatchdog: { intervalMinutes: -1 } } });
    expect(r.configError).toMatch(/intervalMinutes/);
    expect(r.cfg).toBe(CFG);
  });
});

describe('R502 item 3: stale claim (holder silent, head unmoved, claim old) — detection only', () => {
  const NOW = T0;
  const claim = (over = {}) => ({ meta: { repo: 'we', pr: 6300, kind: 'fixing', who: 'fix-6300', sessionId: 'sid-6', headSha: 'abc123', claimedAt: new Date(NOW - 120 * MIN).toISOString(), ...over } });
  const row = (idle) => ({ name: 'fix-6300', id: 'h', sessionId: 'sid-6', kind: 'fix', class: CLASSES.ACTIVE, reason: 'x', evidence: idle == null ? {} : { idleMinutes: idle } });
  const standardFor = () => ({ ms: 20 * MIN, minutes: 20 });
  const plan = (rows, claims, head = 'abc123', cfg) => planWatchdog({ rows, claims, prHeadFor: () => head, standardFor, nowMs: NOW, ...(cfg ? { cfg } : {}) }).findings.filter((f) => f.type === 'stale-claim');
  it('old claim + silent holder + unmoved head → one stale-claim finding with the thresholds in it', () => {
    expect(plan([row(40)], [claim()])).toEqual([expect.objectContaining({ type: 'stale-claim', repo: 'we', pr: 6300, claimAgeMinutes: 120, holderIdleMinutes: 40, holderClass: CLASSES.ACTIVE, thresholdMinutes: 90, idleThresholdMinutes: 20 })]);
  });
  it('a holder missing from the rows might be an interactive session: it never alerts (fail closed)', () => {
    expect(plan([], [claim()])).toEqual([]);
  });
  it('fails closed: young claim, active holder, moved head, unknown head or unknown idle never alert', () => {
    expect(plan([row(40)], [claim({ claimedAt: new Date(NOW - 30 * MIN).toISOString() })])).toEqual([]);
    expect(plan([row(5)], [claim()])).toEqual([]);
    expect(plan([row(40)], [claim()], 'def456')).toEqual([]);
    expect(plan([row(40)], [claim()], null)).toEqual([]);
    expect(plan([row(null)], [claim()])).toEqual([]);
  });
  it('thresholds come from the (overridable) config', () => {
    expect(plan([row(40)], [claim()], 'abc123', resolveSessionWatchdogConfig({ staleClaimMinutes: 200 }).config)).toEqual([]);
    expect(plan([row(10)], [claim()], 'abc123', resolveSessionWatchdogConfig({ staleClaimIdleMinutes: 5 }).config)).toHaveLength(1);
    expect(resolveSessionWatchdogConfig({ staleClaimMinutes: -1 }).error).toMatch(/staleClaimMinutes/);
  });
});


describe('session reaping — config scalars', () => {
  it('defaults to a 10 minute grace and five stops per tick', () => {
    expect(DEFAULT_SESSION_WATCHDOG).toMatchObject({ reapFinishedGraceMinutes: 10, reapMaxStopsPerTick: 5 });
  });
  it.each(['reapFinishedGraceMinutes', 'reapMaxStopsPerTick'])('accepts %s as a positive numeric scalar override', (key) => {
    const { config, error } = resolveSessionWatchdogConfig({ [key]: 3 });
    expect(error).toBeNull();
    expect(config[key]).toBe(3);
    expect(config.intervalMinutes).toBe(CFG.intervalMinutes);
  });
  it.each(['reapFinishedGraceMinutes', 'reapMaxStopsPerTick'])('rejects non-positive and unreadable %s without partially applying config', (key) => {
    for (const value of [0, -1, NaN, Infinity, '3', null]) {
      const { config, error } = resolveSessionWatchdogConfig({ intervalMinutes: 7, [key]: value });
      expect(error).toMatch(new RegExp(`${key}.*positive number`));
      expect(config).toBe(CFG);
    }
  });
});

describe('planWatchdog — finished and duplicate stop-session contract', () => {
  const cfg = { ...CFG, reapFinishedGraceMinutes: 10, reapMaxStopsPerTick: 5 };
  const finished = (over = {}) => row({
    listingKind: 'background', kind: 'fix', repo: 'we', target: '3771', prBound: true,
    state: 'idle', class: CLASSES.FINISHED, evidence: { idleMinutes: 40, idleMs: 40 * MIN, pendingTool: null }, ...over,
  });
  // ACTIVE isolates duplicate selection from the separate finished-session rule.
  const duplicate = (over = {}) => finished({ class: CLASSES.ACTIVE, ...over });
  const newer = (over = {}) => duplicate({ id: 'new-handle', sessionId: 'sid-new', startedAt: T0 - 60 * MIN, ...over });
  const claim = (over = {}) => ({ meta: {
    repo: 'we', pr: 3771, kind: 'fixing', who: 'fix-3771', sessionId: 'sid-1',
    claimedAt: new Date(T0 - 5 * MIN).toISOString(), ...over,
  } });
  const stops = (rows, claims = [], config = cfg) => planWatchdog({
    rows, claims, cfg: config, standardFor: () => standard20, nowMs: T0,
  }).actions.filter((a) => a.type === 'stop-session');

  it.each(['fix', 'ci-heal', 'prepare'])('stops an idle FINISHED %s background session at the grace boundary', (kind) => {
    const r = finished({ kind, evidence: { idleMinutes: 10, idleMs: 10 * MIN }, prBound: kind !== 'prepare' });
    expect(stops([r])).toEqual([{
      type: 'stop-session', handle: r.id, session: r.name, sessionId: r.sessionId,
      mode: 'finished', reason: expect.stringMatching(/\S/), idleMinutes: 10,
    }]);
  });
  it('uses the configured finished grace rather than a hardcoded ten minutes', () => {
    const r = finished({ evidence: { idleMinutes: 3, idleMs: 3 * MIN } });
    expect(stops([r])).toEqual([]);
    expect(stops([r], [], { ...cfg, reapFinishedGraceMinutes: 3 })).toHaveLength(1);
  });
  it.each([
    ['idle below grace', { evidence: { idleMinutes: 9.9, idleMs: 9.9 * MIN } }],
    ['working (busy)', { state: 'working' }],
    ['unknown state', { state: undefined }],
    ['another non-idle state', { state: 'paused' }],
    ['pending tool', { evidence: { idleMinutes: 40, idleMs: 40 * MIN, pendingTool: 'Bash' } }],
    ['missing idle evidence', { evidence: {} }],
    ['NaN idle evidence', { evidence: { idleMinutes: NaN, idleMs: NaN * MIN } }],
    ['infinite idle evidence', { evidence: { idleMinutes: Infinity, idleMs: Infinity * MIN } }],
    ['review kind', { kind: 'review' }],
    ['build kind', { kind: 'build' }],
    ['interactive listing', { listingKind: 'interactive' }],
    ['ACTIVE background wait', { class: CLASSES.ACTIVE }],
    ['WAITING background wait', { class: CLASSES.WAITING }],
    ['STALLED without completion', { class: CLASSES.STALLED }],
  ])('keeps a finished-mode candidate with %s', (_label, over) => {
    expect(stops([finished(over)])).toEqual([]);
  });
  it('keeps a FINISHED session holding a live claim by sessionId even when the claim name differs', () => {
    expect(stops([finished()], [claim({ who: 'another-name' })])).toEqual([]);
  });
  it('keeps a FINISHED session holding a live claim by name when claim sessionId is absent', () => {
    expect(stops([finished()], [claim({ sessionId: undefined })])).toEqual([]);
  });
  it('does not fall back to name when a claim has a different sessionId', () => {
    expect(stops([finished()], [claim({ sessionId: 'not-listed' })])).toHaveLength(1);
  });
  it('a same-name live claim protects only its sessionId holder, regardless of listing order', () => {
    const old = finished();
    const keeper = newer({ class: CLASSES.FINISHED });
    for (const rows of [[old, keeper], [keeper, old]]) {
      expect(stops(rows, [claim({ sessionId: keeper.sessionId })])).toEqual([
        expect.objectContaining({ handle: old.id, mode: 'finished' }),
      ]);
    }
  });
  it('a name-only claim protects every same-name row from stops in either listing order', () => {
    const first = finished();
    const second = newer({ class: CLASSES.FINISHED });
    for (const rows of [[first, second], [second, first]]) {
      expect(stops(rows, [claim({ sessionId: undefined })])).toEqual([]);
    }
  });
  it('a sessionId-bearing claim protects only its holder from duplicate stops', () => {
    const old = duplicate();
    const keeper = newer();
    expect(stops([old, keeper], [claim({ sessionId: keeper.sessionId })])).toEqual([
      expect.objectContaining({ handle: old.id, mode: 'duplicate' }),
    ]);
  });

  it('keeps the newest idle duplicate and names that keeper in every older duplicate stop reason', () => {
    const old = duplicate();
    const middle = duplicate({ id: 'middle', sessionId: 'sid-middle', startedAt: T0 - 75 * MIN });
    const keeper = newer();
    for (const rows of [[old, keeper, middle], [middle, old, keeper]]) {
      const actions = stops(rows);
      expect(actions.map((a) => a.handle).sort()).toEqual([old.id, middle.id].sort());
      for (const a of actions) {
        expect(a).toMatchObject({ type: 'stop-session', mode: 'duplicate', idleMinutes: 40 });
        expect(a.reason).toContain(keeper.name);
        const source = rows.find((r) => r.id === a.handle);
        expect(a).toMatchObject({ session: source.name, sessionId: source.sessionId });
      }
    }
  });
  it('a busy keeper outranks a newer idle row; only rows strictly older than that keeper are stopped', () => {
    const old = duplicate();
    const busy = newer({ state: 'working' });
    const newestIdle = newer({ id: 'newest', sessionId: 'sid-newest', startedAt: T0 - 30 * MIN });
    expect(stops([newestIdle, old, busy])).toEqual([
      expect.objectContaining({ handle: old.id, mode: 'duplicate', reason: expect.stringContaining(busy.name) }),
    ]);
  });
  it('a claimed keeper outranks a newer idle row and is never stopped', () => {
    const old = duplicate({ id: 'older', sessionId: 'sid-older', startedAt: T0 - 120 * MIN });
    const keeper = duplicate();
    expect(stops([old, keeper, newer()], [claim()])).toEqual([
      expect.objectContaining({ handle: old.id, mode: 'duplicate' }),
    ]);
  });
  it('selects the newest among busy or claimed rows and never stops another busy or claimed duplicate', () => {
    const old = duplicate({ id: 'old', sessionId: 'sid-old', startedAt: T0 - 120 * MIN });
    const claimed = duplicate();
    const busy = newer({ state: 'working' });
    const laterIdle = newer({ id: 'later', sessionId: 'sid-later', startedAt: T0 - 30 * MIN });
    expect(stops([laterIdle, old, claimed, busy], [claim()])).toEqual([
      expect.objectContaining({ handle: old.id, mode: 'duplicate', reason: expect.stringContaining(busy.name) }),
    ]);
  });
  it.each([
    ['busy duplicate', { state: 'working' }],
    ['pending tool call', { evidence: { idleMinutes: 40, idleMs: 40 * MIN, pendingTool: 'Bash' } }],
    ['unreadable idle evidence', { evidence: {} }],
    ['NaN idle evidence', { evidence: { idleMinutes: NaN, idleMs: NaN * MIN } }],
    ['infinite idle evidence', { evidence: { idleMinutes: Infinity, idleMs: Infinity * MIN } }],
    ['idle below grace', { evidence: { idleMinutes: 9, idleMs: 9 * MIN } }],
    ['unknown startedAt', { startedAt: undefined }],
    ['invalid startedAt', { startedAt: 'unreadable' }],
    ['same start time as keeper', { startedAt: T0 - 60 * MIN }],
    ['non-idle state', { state: 'paused' }],
  ])('does not stop a duplicate with %s', (_label, over) => {
    expect(stops([duplicate(over), newer({ state: 'working' })])).toEqual([]);
  });
  it('accepts finite idle evidence exactly at grace for an older duplicate', () => {
    expect(stops([duplicate({ evidence: { idleMinutes: 10, idleMs: 10 * MIN } }), newer()])).toEqual([
      expect.objectContaining({ handle: 'f29aeb29', mode: 'duplicate', idleMinutes: 10 }),
    ]);
  });
  it.each(['fix', 'ci-heal', 'prepare'])('reaps an older PR-bound %s duplicate', (kind) => {
    expect(stops([duplicate({ kind }), newer({ kind })])).toEqual([
      expect.objectContaining({ handle: 'f29aeb29', mode: 'duplicate' }),
    ]);
  });
  it('keeps a single-session group and its keeper', () => {
    expect(stops([duplicate()])).toEqual([]);
  });
  it.each([
    ['different repo', { repo: 'pa' }],
    ['different kind', { kind: 'ci-heal' }],
    ['different PR', { target: '3772' }],
  ])('groups duplicates by repo + kind + target: %s stays separate', (_label, over) => {
    expect(stops([duplicate(), newer(over)])).toEqual([]);
  });
  it.each([
    ['non-prBound', { prBound: false }],
    ['review', { kind: 'review' }],
    ['build', { kind: 'build' }],
  ])('never reaps %s groups as duplicates', (_label, over) => {
    expect(stops([duplicate(over), newer(over)])).toEqual([]);
  });
  it.each(['finished', 'duplicate'])('missing exact idleMs refuses %s stops even with rounded idle minutes', (mode) => {
    const old = (mode === 'finished' ? finished : duplicate)({ evidence: { idleMinutes: 40 } });
    expect(stops(mode === 'finished' ? [old] : [old, newer()])).toEqual([]);
  });

  it('finished mode wins when the same row is also an eligible older duplicate: no double stop', () => {
    const old = finished();
    expect(stops([old, newer()])).toEqual([
      expect.objectContaining({ handle: old.id, mode: 'finished' }),
    ]);
  });
});

describe('runSessionWatchdogPass — reaping with hermetic IO', () => {
  const listing = (over = {}) => row({ kind: 'background', state: 'idle', pid: 2009, ...over });
  const finishedTail = () => summarizeTail([
    ...bash('git status --short', T0 - 41 * MIN), reply(T0 - 40 * MIN),
  ], { nowMs: T0 });
  const base = (over = {}) => {
    const calls = { stop: [], reapEvents: [], logs: [], tailReads: [] };
    const result = runSessionWatchdogPass({
      nowMs: T0, act: true, agents: [listing()], processes: [{ pid: 2009, command: 'claude' }],
      readTail: (r) => { calls.tailReads.push(r.sessionId); return finishedTail(); },
      listDispatchClaims: () => [], chatSpawnGuardFor: () => ({ blocked: false }), awaitingVerifyFor: () => ({ awaiting: false }), readHeavy: () => null, listClaims: () => [], prHeadFor: () => null, completionFor: () => null,
      stop: ({ handle }) => { calls.stop.push(handle); return { stopped: true }; },
      appendReapEvent: (e) => calls.reapEvents.push(e), log: (line) => calls.logs.push(line),
      ownSessionId: 'orchestrator-not-listed',
      rm: () => { throw new Error('unexpected ghost removal'); },
      releaseFixing: () => { throw new Error('unexpected claim release'); },
      releaseDispatch: () => { throw new Error('unexpected dispatch release'); },
      readLedger: () => ({ emitted: new Set(), acked: new Set() }),
      appendEvent: () => { throw new Error('unexpected escalation event'); },
      relist: () => [], readRmLedger: () => ({}),
      writeRmLedger: () => { throw new Error('unexpected rm ledger write'); },
      ...over,
    });
    return { result, calls, actions: result.actions.filter((a) => a.type === 'stop-session') };
  };

  it('act:true executes a finished stop through the injected stop function', () => {
    const { calls, actions } = base();
    expect(calls.stop).toEqual(['f29aeb29']);
    expect(actions).toEqual([expect.objectContaining({ mode: 'finished', ok: true })]);
  });
  it.each([
    ['false', () => false],
    ['undefined', () => undefined],
    ['truthy but not true', () => 'readable'],
    ['throws', () => { throw new Error('unreadable'); }],
  ])('refuses stops when the claim-store probe %s', (_label, claimStoreReadable) => {
    const { calls, actions } = base({ claimStoreReadable });
    expect(calls.stop).toEqual([]);
    expect(calls.reapEvents).toEqual([]);
    expect(actions).toEqual([expect.objectContaining({ ok: false, detail: 'refused: claim store unreadable' })]);
    expect(calls.logs).toContain('session-watchdog: claim store unreadable; stops refused until a successful read');
  });
  it.each(['success', 'ENOENT', 'EACCES'])('the default claim-store probe handles %s', (outcome) => {
    const read = vi.fn(() => {
      if (outcome === 'success') return [];
      throw Object.assign(new Error(outcome), { code: outcome });
    });
    const claimStoreReadable = () => defaultClaimStoreReadable(read);
    expect(claimStoreReadable()).toBe(outcome !== 'EACCES');
    const { calls, actions } = base({ claimStoreReadable });
    expect(read).toHaveBeenCalledWith(fixDispatchClaimRoot());
    if (outcome === 'EACCES') {
      expect(calls.stop).toEqual([]);
      expect(calls.reapEvents).toEqual([]);
      expect(actions).toEqual([expect.objectContaining({ ok: false, detail: 'refused: claim store unreadable' })]);
    } else {
      expect(calls.stop).toEqual(['f29aeb29']);
      expect(actions).toEqual([expect.objectContaining({ ok: true })]);
    }
  });
  it.each(['EACCES', 'ENOENT', 'malformed'])('refuses stops for an unreadable entry (%s), naming only the entry', (failure) => {
    const logs = [];
    const path = join(fixDispatchClaimRoot(), 'bad-entry', 'lock.json');
    const readEntry = vi.fn(() => {
      if (failure === 'malformed') return '{secret-content';
      throw Object.assign(new Error('secret-content'), { code: failure });
    });
    const { calls, actions } = base({
      claimStoreReadable: () => defaultClaimStoreReadable(() => ['bad-entry'], readEntry, line => logs.push(line)),
      log: line => logs.push(line),
    });
    expect(readEntry).toHaveBeenCalledWith(path, 'utf8');
    expect(calls.stop).toEqual([]);
    expect(calls.reapEvents).toEqual([]);
    expect(actions).toEqual([expect.objectContaining({ detail: 'refused: claim store unreadable' })]);
    expect(logs.some(line => line.includes('claim store unreadable') && line.includes('bad-entry/lock.json'))).toBe(true);
    expect(logs.join(' ')).not.toContain('secret-content');
  });

  it('reads every entry, including entries after a valid lock', () => {
    const read = vi.fn(path => path.includes('good-entry')
      ? JSON.stringify({ owner: 'holder', heartbeatAt: new Date(T0).toISOString(), meta: { repo: 'we', pr: 3771, kind: 'fix' } }) : '{}');
    expect(defaultClaimStoreReadable(() => ['good-entry', 'bad-entry'], read)).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each(['finished', 'duplicate'])('live dispatch claims of every kind protect %s holders by sessionId or name', (mode) => {
    const agents = [listing(), listing({ id: 'keeper', sessionId: 'sid-keeper', startedAt: T0 - 60 * MIN })];
    const tail = mode === 'finished' ? finishedTail() : summarizeTail(bash('git status --short', T0 - 15 * MIN), { nowMs: T0 });
    for (const kind of ['fix', 'ci-heal', 'future-kind']) {
      for (const sessionId of ['sid-1', undefined]) {
        const dispatch = { meta: { repo: 'we', pr: 3771, kind, who: 'fix-3771', sessionId } };
        const listDispatchClaims = vi.fn(() => [dispatch]);
        const { calls, actions, result } = base({ agents, readTail: () => tail, listDispatchClaims });
        expect(calls.stop).not.toContain(agents[0].id);
        if (!sessionId) expect(calls.stop).toEqual([]);
        expect(actions.every(a => a.sessionId !== 'sid-1')).toBe(true);
        expect(listDispatchClaims).toHaveBeenCalledWith(fixDispatchClaimRoot(), { liveOnly: true, nowMs: T0 });
        expect(result.findings.filter(f => ['fixer-stuck', 'stale-claim', 'fix-claim-held-no-progress'].includes(f.type))).toEqual([]);
        expect(result.events).toEqual([]);
      }
    }
  });

  it('dispatch claims without who use their canonical session name and protect every same-name row', () => {
    const agents = [listing(), listing({ id: 'keeper', sessionId: 'sid-keeper', startedAt: T0 - 60 * MIN })];
    const { calls } = base({ agents, listDispatchClaims: () => [{ meta: { repo: 'we', pr: 3771, kind: 'fix' } }] });
    expect(calls.stop).toEqual([]);
  });

  it.each(['throws', 'null'])('unreadable dispatch listing (%s) refuses stops', (failure) => {
    const { calls, actions } = base({ listDispatchClaims: () => {
      if (failure === 'throws') throw new Error('unreadable');
      return null;
    } });
    expect(calls.stop).toEqual([]);
    expect(actions).toEqual([expect.objectContaining({ detail: 'refused: claim store unreadable' })]);
  });

  it('expired dispatch claims do not protect finished or duplicate holders', () => {
    const root = mkdtempSync(join(tmpdir(), 'watchdog-dispatch-'));
    try {
      mkdirSync(join(root, 'expired'));
      writeFileSync(join(root, 'expired', 'lock.json'), JSON.stringify({
        owner: 'holder', heartbeatAt: new Date(T0 - 11 * MIN).toISOString(),
        meta: { repo: 'we', pr: 3771, kind: 'fix', who: 'fix-3771', sessionId: 'sid-1' },
      }));
      for (const mode of ['finished', 'duplicate']) {
        const agents = [listing(), listing({ id: 'keeper', sessionId: 'sid-keeper', startedAt: T0 - 60 * MIN })];
        const tail = mode === 'finished' ? finishedTail() : summarizeTail(bash('git status --short', T0 - 15 * MIN), { nowMs: T0 });
        const { calls } = base({ agents, readTail: () => tail,
          listDispatchClaims: (_root, options) => listFixDispatchClaims(root, options) });
        expect(calls.stop).toContain(agents[0].id);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['finished', 'duplicate'])('awaiting verification, resolver throws and null refuse %s stops; definite false allows them', (mode) => {
    const old = listing({ cwd: 'scratch/session', extraListingEvidence: true });
    const keeper = listing({ id: 'keeper', sessionId: 'sid-keeper', startedAt: T0 - 60 * MIN });
    const tail = mode === 'finished' ? finishedTail() : summarizeTail(bash('git status --short', T0 - 15 * MIN), { nowMs: T0 });
    for (const outcome of ['awaiting', 'throws', 'false', 'null']) {
      const awaitingVerifyFor = vi.fn(session => {
        expect(session).toBe(old);
        if (outcome === 'throws') throw new Error('unknown verification');
        return outcome === 'null' ? null : { awaiting: outcome === 'awaiting' };
      });
      const { calls } = base({ agents: mode === 'finished' ? [old] : [old, keeper], readTail: () => tail, awaitingVerifyFor });
      expect(awaitingVerifyFor).toHaveBeenCalledWith(old);
      expect(calls.stop).toEqual(outcome === 'false' ? [old.id] : []);
    }
  });

  it.each([
    ['finished', 'sentinel'], ['completion', 'sentinel'], ['duplicate', 'sentinel'],
    ['finished', 'throw'], ['completion', 'throw'], ['duplicate', 'throw'],
  ])('unparseable transcript tool-call lines refuse %s stops (parser %s)', (mode, parseFailure) => {
    const old = listing({ cwd: 'scratch/session' });
    const keeper = listing({ id: 'keeper', sessionId: 'sid-keeper', startedAt: T0 - 60 * MIN });
    const timestamp = new Date(T0 - 40 * MIN).toISOString();
    const lines = mode === 'finished' ? [JSON.stringify({ type: 'assistant', timestamp,
      message: { content: [{ type: 'text', text: 'Done.' }] } })] : [
      JSON.stringify({ type: 'assistant', timestamp, message: { content: [
        { type: 'tool_use', id: 'probe-call', name: 'Bash', input: { command: 'git status --short' } },
      ] } }),
      JSON.stringify({ type: 'user', timestamp, message: { content: [
        { type: 'tool_result', tool_use_id: 'probe-call', content: 'clean' },
      ] } }),
    ];
    for (const malformed of [false, true]) {
      const tail = readWatchdogTail(old, CFG, T0, {
        resolveTranscript: () => 'fixture.jsonl',
        summarizeEntryFn: (raw, fieldMax) => {
          const entry = summarizeEntry(raw, fieldMax);
          if (parseFailure === 'throw' && entry.kind === 'unparseable') throw new Error('parse failed');
          return entry;
        },
        tailLinesFn: () => ({ lines: malformed ? [...lines, '{"type":"assistant","tool_call":'] : lines }),
      });
      expect(tail.hadUnparseableLine).toBe(malformed);
      const { result, calls, actions } = base({
        agents: mode === 'duplicate' ? [old, keeper] : [old], readTail: () => tail,
        completionFor: () => mode === 'completion' ? { done: true } : null,
      });
      if (malformed) {
        expect(result.rows[0].evidence.unparseableTail).toBe(true);
        expect(actions).toEqual([]);
        expect(calls.reapEvents).toEqual([]);
      } else {
        expect(actions).toEqual([expect.objectContaining({ mode: mode === 'duplicate' ? 'duplicate' : 'finished', ok: true })]);
      }
      expect(calls.stop).toEqual(malformed ? [] : [old.id]);
    }
  });

  it.each(['meta', 'repo', 'pr', 'kind'])('incomplete lock %s refuses stops and logs only the entry name', (missing) => {
    const logs = [];
    const meta = { repo: 'we', pr: 3771, kind: 'fix', who: 'fix-3771', sessionId: 'sid-1' };
    delete meta[missing];
    const entry = { owner: 'secret-owner', heartbeatAt: new Date(T0).toISOString(), ...(missing === 'meta' ? {} : { meta }) };
    const { calls, actions } = base({ claimStoreReadable: () => defaultClaimStoreReadable(
      () => ['incomplete-entry'], () => JSON.stringify(entry), line => logs.push(line)),
    });
    expect(calls.stop).toEqual([]);
    expect(calls.reapEvents).toEqual([]);
    expect(actions).toEqual([expect.objectContaining({ detail: 'refused: claim store unreadable' })]);
    expect(logs).toEqual([expect.stringContaining('incomplete-entry/lock.json')]);
    expect(logs.join(' ')).not.toContain('secret-owner');
    expect(logs.join(' ')).not.toContain('sid-1');
  });

  it.each(['finished', 'duplicate'])('unreadable lane or shared await records (EACCES) refuse %s stops', (mode) => {
    const old = listing({ cwd: 'scratch/session' });
    const keeper = listing({ id: 'keeper', sessionId: 'sid-keeper', startedAt: T0 - 60 * MIN });
    const tail = mode === 'finished' ? finishedTail() : summarizeTail(bash('git status --short', T0 - 15 * MIN), { nowMs: T0 });
    for (const unreadable of ['.fix-await-verify', 'sid-1.json', 'fix-3771.json']) {
      const read = vi.fn(path => {
        throw Object.assign(new Error('secret-record'), { code: path.endsWith(unreadable) ? 'EACCES' : 'ENOENT' });
      });
      const awaitingVerifyFor = makeStopAwaitingVerifyResolver({
        statFn: () => ({ isDirectory: () => true }), readFileSyncFn: read, dir: 'await-store', now: () => T0,
      });
      const { calls, actions } = base({ agents: mode === 'finished' ? [old] : [old, keeper], readTail: () => tail, awaitingVerifyFor });
      expect(read.mock.calls.some(([path]) => path.endsWith(unreadable))).toBe(true);
      expect(calls.stop).toEqual([]);
      expect(calls.reapEvents).toEqual([]);
      expect(actions).toEqual([expect.objectContaining({ detail: 'refused: awaiting verification unreadable' })]);
    }
  });

  it.each(['finished', 'duplicate'])('missing await records (ENOENT) allow %s stops after probing lane and shared paths', (mode) => {
    const old = listing({ cwd: 'scratch/session' });
    const keeper = listing({ id: 'keeper', sessionId: 'sid-keeper', startedAt: T0 - 60 * MIN });
    const read = vi.fn(() => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); });
    const awaitingVerifyFor = makeStopAwaitingVerifyResolver({
      statFn: () => ({ isDirectory: () => true }), readFileSyncFn: read, dir: 'await-store', now: () => T0,
    });
    const tail = mode === 'finished' ? finishedTail() : summarizeTail(bash('git status --short', T0 - 15 * MIN), { nowMs: T0 });
    const { calls } = base({ agents: mode === 'finished' ? [old] : [old, keeper], readTail: () => tail, awaitingVerifyFor });
    expect(read.mock.calls.map(([path]) => path)).toEqual([
      expect.stringContaining('.git/.fix-await-verify'), join('await-store', 'sid-1.json'), join('await-store', 'fix-3771.json'),
    ]);
    expect(calls.stop).toEqual([old.id]);
  });

  it('a missing session gitdir still probes shared await records before allowing a stop', () => {
    const read = vi.fn(() => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); });
    const awaitingVerifyFor = makeStopAwaitingVerifyResolver({
      statFn: () => { throw Object.assign(new Error('no gitdir'), { code: 'ENOENT' }); },
      readFileSyncFn: read, dir: 'await-store', now: () => T0,
    });
    const { calls } = base({ agents: [listing({ cwd: 'scratch/session' })], awaitingVerifyFor });
    expect(read.mock.calls.map(([path]) => path)).toEqual([join('await-store', 'sid-1.json'), join('await-store', 'fix-3771.json')]);
    expect(calls.stop).toEqual(['f29aeb29']);
  });

  it.each(['awaiting', 'expired'])('the strict resolver classifies a readable %s await record', (state) => {
    const awaitingVerifyFor = makeStopAwaitingVerifyResolver({
      statFn: () => ({ isDirectory: () => true }),
      readFileSyncFn: path => {
        if (!path.endsWith('sid-1.json')) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return JSON.stringify({ v: 1, pr: 3771, sessionId: 'sid-1', requestedAt: new Date(T0 - (state === 'expired' ? 2 : 0) * MIN).toISOString() });
      },
      dir: 'await-store', now: () => T0, ttlMs: MIN,
    });
    const { calls } = base({ agents: [listing({ cwd: 'scratch/session' })], awaitingVerifyFor });
    expect(calls.stop).toEqual(state === 'awaiting' ? [] : ['f29aeb29']);
  });

  it.each(['EACCES', 'malformed', 'null', 'unbound'])('unknown await evidence (%s) refuses stops', (failure) => {
    const awaitingVerifyFor = makeStopAwaitingVerifyResolver({
      statFn: () => {
        if (failure === 'EACCES') throw Object.assign(new Error('unreadable gitdir'), { code: 'EACCES' });
        return { isDirectory: () => true };
      },
      readFileSyncFn: () => failure === 'malformed' ? '{bad' : failure === 'null' ? 'null' : JSON.stringify({
        v: 1, pr: 3771, requestedAt: new Date(T0).toISOString(),
      }),
      dir: 'await-store', now: () => T0,
    });
    const { calls, actions } = base({ agents: [listing({ cwd: 'scratch/session' })], awaitingVerifyFor });
    expect(calls.stop).toEqual([]);
    expect(actions).toEqual([expect.objectContaining({ detail: 'refused: awaiting verification unreadable' })]);
  });

  it.each(['finished', 'duplicate'])('chat-spawn guarded, throwing and unknown guards refuse %s stops; unguarded allows them', (mode) => {
    const old = listing({ cwd: 'scratch/session', extraListingEvidence: true });
    const keeper = listing({ id: 'keeper', sessionId: 'sid-keeper', startedAt: T0 - 60 * MIN });
    const tail = mode === 'finished' ? finishedTail() : summarizeTail(bash('git status --short', T0 - 15 * MIN), { nowMs: T0 });
    for (const outcome of ['guarded', 'throws', 'null', 'incomplete', 'unguarded']) {
      const chatSpawnGuardFor = vi.fn(session => {
        if (outcome === 'throws') throw new Error('unknown chat ownership');
        if (outcome === 'null') return null;
        if (outcome === 'incomplete') return {};
        return { blocked: outcome === 'guarded', reason: outcome === 'guarded' ? 'chat-not-ended' : 'no-link' };
      });
      const { calls, actions } = base({ agents: mode === 'finished' ? [old] : [old, keeper], readTail: () => tail, chatSpawnGuardFor });
      expect(chatSpawnGuardFor).toHaveBeenCalledWith(old);
      expect(chatSpawnGuardFor.mock.calls[0][0]).toBe(old);
      expect(calls.stop).toEqual(outcome === 'unguarded' ? [old.id] : []);
      expect(calls.reapEvents).toHaveLength(outcome === 'unguarded' ? 1 : 0);
      if (outcome !== 'unguarded') expect(actions).toEqual([expect.objectContaining({
        ok: false, detail: outcome === 'guarded' ? 'refused: chat-spawn guarded' : 'refused: chat-spawn guard unreadable',
      })]);
    }
  });

  it('an unrelated corrupt lock preserves fixing findings and escalation events while refusing stops', () => {
    const root = mkdtempSync(join(tmpdir(), 'watchdog-corrupt-claims-'));
    try {
      for (const name of ['valid', 'corrupt']) mkdirSync(join(root, name));
      writeFileSync(join(root, 'valid', 'lock.json'), JSON.stringify({
        owner: 'fixer', heartbeatAt: new Date(T0 - MIN).toISOString(),
        meta: { repo: 'we', pr: 3771, kind: 'fixing', who: 'fix-3771', sessionId: 'sid-1',
          headSha: 'abc', claimedAt: new Date(T0 - 120 * MIN).toISOString(), ttlMinutes: 240 },
      }));
      writeFileSync(join(root, 'corrupt', 'lock.json'), '{corrupt');
      const listClaims = vi.fn(() => listLiveFixClaims({ lockRoot: root, nowMs: T0 }));
      const events = [];
      const stalled = summarizeTail(bash('git status --short', T0 - 41 * MIN, MIN), { nowMs: T0 });
      const { result, calls, actions } = base({
        agents: [listing(), listing({ name: 'fix-3772', id: 'finished', sessionId: 'sid-finished' })],
        readTail: session => session.sessionId === 'sid-1' ? stalled : finishedTail(),
        listClaims, prHeadFor: () => 'abc', appendEvent: event => events.push(event),
        claimStoreReadable: () => defaultClaimStoreReadable(() => readdirSync(root),
          (path, encoding) => readFileSync(join(root, basename(dirname(path)), 'lock.json'), encoding)),
      });
      expect(listClaims).toHaveBeenCalledTimes(1);
      expect(result.findings.map(f => f.type).sort()).toEqual(['fix-claim-held-no-progress', 'fixer-stuck', 'stale-claim']);
      expect(events).toEqual([expect.objectContaining({ type: ESCALATION_EVENT_TYPE, session: expect.objectContaining({ sessionId: 'sid-1' }) })]);
      expect(result.events).toEqual([expect.objectContaining({ written: true })]);
      expect(calls.stop).toEqual([]);
      expect(calls.reapEvents).toEqual([]);
      expect(actions).toEqual([expect.objectContaining({ handle: 'finished', detail: 'refused: claim store unreadable' })]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['throws', 'null'])('a failed fixing-claim read (%s) still refuses stops after separating the findings read', (failure) => {
    const { calls, actions } = base({ listClaims: () => {
      if (failure === 'throws') throw new Error('unreadable fixing claims');
      return null;
    } });
    expect(calls.stop).toEqual([]);
    expect(actions).toEqual([expect.objectContaining({ detail: 'refused: claim store unreadable' })]);
  });

  it.each(['fix', 'fixing'])('invalid heartbeat timestamps refuse stops for %s claims, naming only the entry', (kind) => {
    const logs = [];
    const { calls, actions } = base({ claimStoreReadable: () => defaultClaimStoreReadable(
      () => ['invalid-heartbeat'], () => JSON.stringify({ owner: 'secret-owner', heartbeatAt: 'secret-invalid-date',
        meta: { repo: 'we', pr: 3771, kind, who: 'fix-3771', sessionId: 'sid-1' } }), line => logs.push(line)),
    });
    expect(calls.stop).toEqual([]);
    expect(calls.reapEvents).toEqual([]);
    expect(actions).toEqual([expect.objectContaining({ detail: 'refused: claim store unreadable' })]);
    expect(logs).toEqual([expect.stringContaining('invalid-heartbeat/lock.json')]);
    expect(logs.join(' ')).not.toContain('secret-owner');
    expect(logs.join(' ')).not.toContain('secret-invalid-date');
  });

  it.each(['Infinity', 'NaN', -1, 0])('invalid fixing claim TTL %s refuses stops', (ttlMinutes) => {
    const logs = [];
    const { calls, actions } = base({ claimStoreReadable: () => defaultClaimStoreReadable(
      () => ['invalid-ttl'], () => JSON.stringify({ owner: 'holder', heartbeatAt: new Date(T0).toISOString(),
        meta: { repo: 'we', pr: 3771, kind: 'fixing', ttlMinutes } }), line => logs.push(line)),
    });
    expect(calls.stop).toEqual([]);
    expect(actions).toEqual([expect.objectContaining({ detail: 'refused: claim store unreadable' })]);
    expect(logs).toEqual([expect.stringContaining('invalid-ttl/lock.json')]);
  });

  it('valid historical heartbeat timestamps remain readable even when the lease has expired', () => {
    expect(defaultClaimStoreReadable(() => ['expired'], () => JSON.stringify({
      owner: 'holder', heartbeatAt: new Date(T0 - 24 * 60 * MIN).toISOString(),
      meta: { repo: 'we', pr: 3771, kind: 'fix' },
    }))).toBe(true);
  });

  it.each(['finished', 'duplicate'])('default chat guard refuses %s stops on EACCES reading the spawn link', (mode) => {
    const old = listing();
    const keeper = listing({ id: 'keeper', sessionId: 'sid-keeper', startedAt: T0 - 60 * MIN });
    const read = vi.fn(() => { throw Object.assign(new Error('secret-link-contents'), { code: 'EACCES' }); });
    const chatSpawnGuardFor = makeStopChatSpawnGuardResolver({
      spawnsDir: 'spawn-links', endedDir: 'chat-ended', readFileSyncFn: read, now: () => T0,
    });
    const tail = mode === 'finished' ? finishedTail() : summarizeTail(bash('git status --short', T0 - 15 * MIN), { nowMs: T0 });
    const { calls, actions } = base({ agents: mode === 'finished' ? [old] : [old, keeper], readTail: () => tail, chatSpawnGuardFor });
    expect(read).toHaveBeenCalledWith(join('spawn-links', 'sid-1.json'), 'utf8');
    expect(calls.stop).toEqual([]);
    expect(calls.reapEvents).toEqual([]);
    expect(actions).toEqual([expect.objectContaining({ detail: 'refused: chat-spawn guard unreadable' })]);
    expect(JSON.stringify({ actions, logs: calls.logs })).not.toContain('secret-link-contents');
  });

  it.each(['finished', 'duplicate'])('default chat guard refuses %s stops on EACCES reading the ended marker even past its ceiling', (mode) => {
    const old = listing();
    const keeper = listing({ id: 'keeper', sessionId: 'sid-keeper', startedAt: T0 - 60 * MIN });
    const read = vi.fn(path => {
      if (path === join('spawn-links', 'sid-1.json')) return JSON.stringify({
        v: 1, spawnedSessionId: 'sid-1', spawnedByChatSessionId: 'parent-chat', recordedAt: new Date(T0 - 2 * MIN).toISOString(),
      });
      throw Object.assign(new Error('secret-marker-contents'), { code: 'EACCES' });
    });
    const chatSpawnGuardFor = makeStopChatSpawnGuardResolver({
      spawnsDir: 'spawn-links', endedDir: 'chat-ended', readFileSyncFn: read, now: () => T0, ceilingMs: MIN,
    });
    const tail = mode === 'finished' ? finishedTail() : summarizeTail(bash('git status --short', T0 - 15 * MIN), { nowMs: T0 });
    const { calls, actions } = base({ agents: mode === 'finished' ? [old] : [old, keeper], readTail: () => tail, chatSpawnGuardFor });
    expect(read).toHaveBeenCalledWith(join('chat-ended', 'parent-chat.json'), 'utf8');
    expect(calls.stop).toEqual([]);
    expect(calls.reapEvents).toEqual([]);
    expect(actions).toEqual([expect.objectContaining({ detail: 'refused: chat-spawn guard unreadable' })]);
    expect(JSON.stringify({ actions, logs: calls.logs })).not.toContain('secret-marker-contents');
  });

  it.each(['finished', 'duplicate'])('default chat guard allows %s stops when the spawn link is missing (ENOENT)', (mode) => {
    const old = listing();
    const keeper = listing({ id: 'keeper', sessionId: 'sid-keeper', startedAt: T0 - 60 * MIN });
    const read = vi.fn(() => { throw Object.assign(new Error('missing link'), { code: 'ENOENT' }); });
    const chatSpawnGuardFor = makeStopChatSpawnGuardResolver({
      spawnsDir: 'spawn-links', endedDir: 'chat-ended', readFileSyncFn: read, now: () => T0,
    });
    const tail = mode === 'finished' ? finishedTail() : summarizeTail(bash('git status --short', T0 - 15 * MIN), { nowMs: T0 });
    const { calls, actions } = base({ agents: mode === 'finished' ? [old] : [old, keeper], readTail: () => tail, chatSpawnGuardFor });
    expect(read).toHaveBeenCalledWith(join('spawn-links', 'sid-1.json'), 'utf8');
    expect(calls.stop).toEqual([old.id]);
    expect(actions).toEqual([expect.objectContaining({ mode, ok: true })]);
  });

  it('default chat guard resets recorded read errors for each session', () => {
    let code = 'EACCES';
    const chatSpawnGuardFor = makeStopChatSpawnGuardResolver({
      spawnsDir: 'spawn-links', endedDir: 'chat-ended', now: () => T0,
      readFileSyncFn: () => { throw Object.assign(new Error('read failed'), { code }); },
    });
    expect(chatSpawnGuardFor(listing())).toBeNull();
    code = 'ENOENT';
    expect(chatSpawnGuardFor(listing({ sessionId: 'sid-next' }))).toMatchObject({ blocked: false, reason: 'no-link' });
  });

  it.each(['finished', 'duplicate'])('exact idle below grace (9.6 min) refuses %s stops; 10.0 min allows them', (mode) => {
    const old = listing();
    const keeper = listing({ id: 'keeper', sessionId: 'sid-keeper', startedAt: T0 - 60 * MIN });
    for (const idleMinutes of [9.6, 10]) {
      const idleMs = idleMinutes * MIN;
      const tail = summarizeTail(bash('git status --short', T0 - idleMs - 1000, 1000), { nowMs: T0 });
      const { result, calls, actions } = base({
        agents: mode === 'finished' ? [old] : [old, keeper], readTail: () => tail,
        completionFor: () => mode === 'finished' ? { done: true } : null,
      });
      expect(result.rows[0].evidence).toMatchObject({ idleMinutes: 10, idleMs });
      expect(calls.stop).toEqual(idleMinutes === 10 ? [old.id] : []);
      expect(actions).toEqual(idleMinutes === 10 ? [expect.objectContaining({ mode, idleMinutes: 10, ok: true })] : []);
      expect(calls.reapEvents).toEqual(idleMinutes === 10 ? [expect.objectContaining({ mode, idleMinutes: 10 })] : []);
    }
  });

  it.each(['finished', 'duplicate'])('byte- or line-truncated transcript tails refuse %s stops; a complete tail allows them', (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'watchdog-truncated-tail-'));
    try {
      const file = join(root, 'session.jsonl');
      const old = listing({ cwd: root });
      const keeper = listing({ id: 'keeper', sessionId: 'sid-keeper', startedAt: T0 - 60 * MIN });
      const timestamp = new Date(T0 - 40 * MIN).toISOString();
      const pending = JSON.stringify({ type: 'assistant', timestamp, message: { content: [
        { type: 'tool_use', id: 'hidden-pending-tool', name: 'Bash', input: { command: 'wait ' + 'x'.repeat(2048) } },
      ] } });
      const retained = JSON.stringify({ type: mode === 'finished' ? 'assistant' : 'user', timestamp, message: { content: [
        mode === 'finished' ? { type: 'text', text: 'Done.' } : { type: 'tool_result', tool_use_id: 'another-tool', content: 'done' },
      ] } });
      for (const bound of ['bytes', 'lines', 'complete']) {
        writeFileSync(file, (bound === 'complete' ? '' : pending + '\n') + retained + '\n');
        const config = { ...CFG, tailLines: bound === 'lines' ? 1 : CFG.tailLines,
          tailMaxBytes: bound === 'bytes' ? Buffer.byteLength(retained) + 2 : CFG.tailMaxBytes };
        const tail = readWatchdogTail(old, config, T0, { resolveTranscript: () => file });
        expect(tail.pending).toBeNull();
        expect(tail.truncatedTail).toBe(bound !== 'complete');
        const { result, calls, actions } = base({ config,
          agents: mode === 'finished' ? [old] : [old, keeper], readTail: () => tail,
          completionFor: () => mode === 'finished' ? { done: true } : null,
        });
        if (bound !== 'complete') {
          expect(result.rows[0].evidence.truncatedTail).toBe(true);
          expect(actions).toEqual([]);
          expect(calls.reapEvents).toEqual([]);
        } else {
          expect(actions).toEqual([expect.objectContaining({ mode, ok: true })]);
        }
        expect(calls.stop).toEqual(bound === 'complete' ? [old.id] : []);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each([
    ['truncatedHead', { truncatedHead: true }], ['truncated', { truncated: true }],
    ['partial-first-line', { partialFirstLine: true }], ['byte-count cap', { bytesRead: CFG.tailMaxBytes }],
    ['file-size cap', { size: CFG.tailMaxBytes }],
  ])('reader truncation evidence (%s) is preserved and refuses stops', (_label, metadata) => {
    const old = listing({ cwd: 'scratch/session' });
    const tail = readWatchdogTail(old, CFG, T0, {
      resolveTranscript: () => 'fixture.jsonl',
      tailLinesFn: () => ({ ...metadata, lines: [JSON.stringify({ type: 'assistant', timestamp: new Date(T0 - 40 * MIN).toISOString(),
        message: { content: [{ type: 'text', text: 'Done.' }] } })] }),
    });
    const { result, calls, actions } = base({ readTail: () => tail });
    expect(result.rows[0].evidence.truncatedTail).toBe(true);
    expect(calls.stop).toEqual([]);
    expect(actions).toEqual([]);
  });

  it.each(['finished', 'duplicate'])('an earlier unresolved Agent call survives a later resolved Read and refuses %s stops', (mode) => {
    const old = listing();
    const keeper = listing({ id: 'keeper', sessionId: 'sid-keeper', startedAt: T0 - 60 * MIN });
    for (const resolved of [false, true]) {
      const entries = [
        ...call('Agent', { prompt: 'still running' }, T0 - 50 * MIN, MIN, { pending: !resolved }),
        ...call('Read', { file_path: 'status.txt' }, T0 - 41 * MIN, MIN),
      ];
      const tail = summarizeTail(entries, { nowMs: T0 });
      const { calls, actions } = base({ agents: mode === 'finished' ? [old] : [old, keeper], readTail: () => tail,
        completionFor: () => mode === 'finished' ? { done: true } : null });
      expect(calls.stop).toEqual(resolved ? [old.id] : []);
      expect(actions).toEqual(resolved ? [expect.objectContaining({ mode, ok: true })] : []);
      expect(calls.reapEvents).toHaveLength(resolved ? 1 : 0);
    }
  });

  it.each(['parent-B', null])('an ended marker for %s cannot unblock parent-A session even past the chat guard ceiling', (markerParent) => {
    const chatSpawnGuardFor = makeStopChatSpawnGuardResolver({
      spawnsDir: 'spawn-links', endedDir: 'chat-ended', now: () => T0, ceilingMs: MIN,
      readFileSyncFn: path => path === join('spawn-links', 'sid-1.json') ? JSON.stringify({
        v: 1, spawnedSessionId: 'sid-1', spawnedByChatSessionId: 'parent-A', recordedAt: new Date(T0 - 2 * MIN).toISOString(),
      }) : JSON.stringify(markerParent ? { chatSessionId: markerParent } : {}),
    });
    const { calls, actions } = base({ chatSpawnGuardFor });
    expect(calls.stop).toEqual([]);
    expect(calls.reapEvents).toEqual([]);
    expect(actions).toEqual([expect.objectContaining({ detail: 'refused: chat-spawn guarded' })]);
  });

  it('an ended marker with matching parent identity allows the stop', () => {
    const chatSpawnGuardFor = makeStopChatSpawnGuardResolver({
      spawnsDir: 'spawn-links', endedDir: 'chat-ended', now: () => T0,
      readFileSyncFn: path => path === join('spawn-links', 'sid-1.json') ? JSON.stringify({
        v: 1, spawnedSessionId: 'sid-1', spawnedByChatSessionId: 'parent-A', recordedAt: new Date(T0).toISOString(),
      }) : JSON.stringify({ chatSessionId: 'parent-A' }),
    });
    expect(base({ chatSpawnGuardFor }).calls.stop).toEqual(['f29aeb29']);
  });

  it.each(['EACCES', 'corrupt', 'directory-EACCES'])('the actual strict claim read refuses stops after a successful probe (%s)', (failure) => {
    const claimStoreReadable = vi.fn(() => true);
    const readClaimDirectory = vi.fn(() => {
      if (failure === 'directory-EACCES') throw Object.assign(new Error('secret-directory'), { code: 'EACCES' });
      return ['changed-entry'];
    });
    const readClaimEntry = vi.fn(() => {
      if (failure === 'EACCES') throw Object.assign(new Error('secret-entry'), { code: 'EACCES' });
      return '{secret-corrupt';
    });
    const { calls, actions } = base({ claimStoreReadable, listDispatchClaims: undefined, readClaimDirectory, readClaimEntry });
    expect(claimStoreReadable).toHaveBeenCalledOnce();
    expect(calls.stop).toEqual([]);
    expect(calls.reapEvents).toEqual([]);
    expect(actions).toEqual([expect.objectContaining({ detail: 'refused: claim store unreadable' })]);
    expect(readClaimDirectory).toHaveBeenCalledWith(fixDispatchClaimRoot());
    if (failure !== 'directory-EACCES') {
      expect(readClaimEntry).toHaveBeenCalledWith(join(fixDispatchClaimRoot(), 'changed-entry', 'lock.json'), 'utf8');
      expect(calls.logs.some(line => line.includes('changed-entry/lock.json'))).toBe(true);
    }
    expect(JSON.stringify({ actions, logs: calls.logs })).not.toContain('secret-');
  });

  it.each(['finished', 'duplicate'])('a 240-minute fixing lease with a 30-minute heartbeat protects its %s holder in the strict snapshot', (mode) => {
    const old = listing();
    const keeper = listing({ id: 'keeper', sessionId: 'sid-keeper', startedAt: T0 - 60 * MIN });
    const tail = mode === 'finished' ? finishedTail() : summarizeTail(bash('git status --short', T0 - 15 * MIN), { nowMs: T0 });
    const { calls, actions } = base({
      agents: mode === 'finished' ? [old] : [old, keeper], readTail: () => tail,
      claimStoreReadable: () => true, listDispatchClaims: undefined,
      readClaimDirectory: () => ['long-lease'], readClaimEntry: () => JSON.stringify({
        owner: 'holder', heartbeatAt: new Date(T0 - 30 * MIN).toISOString(),
        meta: { repo: 'we', pr: 3771, kind: 'fixing', ttlMinutes: 240, sessionId: old.sessionId, who: old.name },
      }),
    });
    expect(calls.stop).toEqual([]);
    expect(calls.reapEvents).toEqual([]);
    expect(actions).toEqual([]);
  });

  it.each([
    ['sessionId', 42], ['sessionId', ''], ['sessionId', '  '], ['sessionId', null],
    ['who', 42], ['who', ''], ['who', '  '], ['who', null], ['name', 42],
  ])('malformed claim holder identity %s=%s refuses stops and names only the entry', (field, value) => {
    const { calls, actions } = base({
      claimStoreReadable: () => true, listDispatchClaims: undefined,
      readClaimDirectory: () => ['bad-identity'], readClaimEntry: () => JSON.stringify({
        owner: 'secret-owner', heartbeatAt: new Date(T0).toISOString(),
        meta: { repo: 'we', pr: 3771, kind: 'fix', who: 'another-name', [field]: value },
      }),
    });
    expect(calls.stop).toEqual([]);
    expect(calls.reapEvents).toEqual([]);
    expect(actions).toEqual([expect.objectContaining({ detail: 'refused: claim store unreadable' })]);
    expect(calls.logs.some(line => line.includes('bad-identity/lock.json'))).toBe(true);
    expect(calls.logs.join(' ')).not.toContain('secret-owner');
  });

  it('report-only plans the stop with ok:null and never calls stop or appends a reap event', () => {
    const { calls, actions } = base({ act: false });
    expect(actions).toEqual([expect.objectContaining({ type: 'stop-session', ok: null })]);
    expect(calls.stop).toEqual([]);
    expect(calls.reapEvents).toEqual([]);
  });
  it('bounds eight eligible sessions to five stop calls and reports three explicitly deferred actions', () => {
    const agents = Array.from({ length: 8 }, (_, i) => listing({
      name: `fix-${3771 + i}`, id: `handle-${i}`, sessionId: `sid-${i}`,
    }));
    const { calls, actions } = base({ agents, config: { ...CFG, reapMaxStopsPerTick: 5 } });
    expect(actions).toHaveLength(8);
    expect(calls.stop).toHaveLength(5);
    expect(new Set(calls.stop).size).toBe(5);
    expect(actions.filter((a) => a.ok === true)).toHaveLength(5);
    expect(actions.filter((a) => a.deferred)).toEqual(Array.from({ length: 3 }, () => expect.objectContaining({
      ok: false, deferred: true, detail: 'deferred: per-tick stop bound',
    })));
    expect(calls.reapEvents).toHaveLength(5);
    expect(calls.reapEvents.map((e) => e.handle).sort()).toEqual([...calls.stop].sort());
  });
  it('appends exactly one versioned stopped event with the executed action evidence', () => {
    const { calls, actions } = base();
    expect(actions).toHaveLength(1);
    expect(calls.reapEvents).toEqual([{
      type: 'session-watchdog.session-stopped', v: 1, sessionId: 'sid-1', name: 'fix-3771',
      handle: 'f29aeb29', mode: 'finished', reason: actions[0].reason, idleMinutes: 40,
      at: new Date(T0).toISOString(),
    }]);
  });
  it('executes duplicate-mode stops and records their keeper reason in the event', () => {
    const old = listing();
    const keeper = listing({ id: 'keeper', sessionId: 'sid-keeper', startedAt: T0 - 60 * MIN });
    const tail = summarizeTail(bash('git status --short', T0 - 15 * MIN), { nowMs: T0 });
    const { calls, actions } = base({ agents: [old, keeper], readTail: () => tail });
    expect(calls.stop).toEqual([old.id]);
    expect(actions).toEqual([expect.objectContaining({ mode: 'duplicate', ok: true, reason: expect.stringContaining(keeper.name) })]);
    expect(calls.reapEvents).toEqual([expect.objectContaining({
      type: 'session-watchdog.session-stopped', mode: 'duplicate', handle: old.id, reason: actions[0].reason,
    })]);
  });
  it.each(['returns stopped:false', 'throws'])('a failed stop (%s) reports ok:false and emits no reap event', (failure) => {
    const attempts = [];
    const { calls, actions } = base({ stop: ({ handle }) => {
      attempts.push(handle);
      if (failure === 'throws') throw new Error('stop failed');
      return { stopped: false, reason: 'stop failed' };
    } });
    expect(attempts).toEqual(['f29aeb29']);
    expect(actions).toEqual([expect.objectContaining({ ok: false })]);
    expect(calls.reapEvents).toEqual([]);
  });
  it('refuses to stop the orchestrator ownSessionId even when otherwise eligible', () => {
    const { calls, actions } = base({ ownSessionId: 'sid-1' });
    expect(actions).toEqual([expect.objectContaining({ ok: false, detail: expect.stringContaining('own session') })]);
    expect(calls.stop).toEqual([]);
    expect(calls.reapEvents).toEqual([]);
  });
  it('excludes an interactive listing named fix-3771 before planning stops', () => {
    const { result, calls, actions } = base({ agents: [listing({ kind: 'interactive' })] });
    expect(result.rows).toEqual([]);
    expect(actions).toEqual([]);
    expect(calls.tailReads).toEqual([]);
    expect(calls.stop).toEqual([]);
    expect(calls.reapEvents).toEqual([]);
  });
  it('logs effective default grace 10 and standard/default provenance exactly once per pass', () => {
    const { calls } = base();
    const lines = calls.logs.filter((line) => line.includes('reapFinishedGraceMinutes'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/\b10\b/);
    expect(lines[0]).toMatch(/standard|default/i);
  });
  it('logs effective overridden grace 3 with override/tool provenance exactly once per pass', () => {
    const { config, error } = resolveSessionWatchdogConfig({ reapFinishedGraceMinutes: 3 });
    expect(error).toBeNull();
    const { calls } = base({ config });
    const lines = calls.logs.filter((line) => line.includes('reapFinishedGraceMinutes'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/\b3\b/);
    expect(lines[0]).toMatch(/override|tool/i);
  });
  it('keeps a WAITING same-command background job idle 40 minutes without a done record or endedOnReply', () => {
    const entries = [0, 1, 2, 3].flatMap((i) => bash(WAIT, T0 - (67 - i * 9) * MIN, MIN, { pending: i === 3 }));
    const tail = summarizeTail(entries, { nowMs: T0 });
    const { result, calls, actions } = base({ readTail: () => tail });
    expect(tail.endedOnReply).toBe(false);
    expect(result.rows[0]).toMatchObject({ class: CLASSES.WAITING, evidence: { idleMinutes: 40 } });
    expect(actions).toEqual([]);
    expect(calls.stop).toEqual([]);
    expect(calls.reapEvents).toEqual([]);
  });
  it('keeps a STALLED background job idle 40 minutes without a done record or endedOnReply', () => {
    const tail = summarizeTail(bash(WAIT, T0 - 41 * MIN, MIN), { nowMs: T0 });
    const { result, calls, actions } = base({ readTail: () => tail });
    expect(tail.endedOnReply).toBe(false);
    expect(result.rows[0]).toMatchObject({ class: CLASSES.STALLED, evidence: { idleMinutes: 40 } });
    expect(actions).toEqual([]);
    expect(calls.stop).toEqual([]);
    expect(calls.reapEvents).toEqual([]);
  });
  it('stops a completion-record-done session past grace with a readable tail and no pending call', () => {
    const tail = summarizeTail(bash('git status --short', T0 - 41 * MIN, MIN), { nowMs: T0 });
    const { result, calls, actions } = base({ completionFor: () => ({ done: true }), readTail: () => tail });
    expect(tail.endedOnReply).toBe(false);
    expect(tail.pending).toBeNull();
    expect(result.rows[0]).toMatchObject({ class: CLASSES.FINISHED, reason: 'completion-record-done' });
    expect(actions).toEqual([expect.objectContaining({ mode: 'finished', ok: true })]);
    expect(calls.stop).toEqual(['f29aeb29']);
    expect(calls.reapEvents).toHaveLength(1);
  });
});
