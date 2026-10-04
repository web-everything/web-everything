/**
 * @file scripts/conveyor/__tests__/session-watchdog.test.mjs
 * @description xegykal — the session watchdog: config merge, kind grammar, standard duration from heavy-admission
 *   medians, command signatures, every classification, every planned action, the IO pass (acting and report-only,
 *   event dedupe and ack), the four smells, and the health-watch probe's interval cache. The fix-3771 replay uses
 *   the recorded transcript fixture (`soak/breaks/fixtures/fix-3771-wait-loop.jsonl`) read through agent-health's own
 *   bounded reader.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_SESSION_WATCHDOG, CLASSES, ESCALATION_EVENT_TYPE, resolveSessionWatchdogConfig, watchdogKindOf, standardDuration,
  commandSegments, summarizeTail, classifyWatchdogSession, planWatchdog, runSessionWatchdogPass, escalationKey,
  readEscalationLedger, appendEscalationEvent, renderWatchdogPass,
} from '../session-watchdog.mjs';
import { tailLines, summarizeEntry } from '../../../skills-src/inspect-agent-health/agent-health.mjs';
import fixerStuck from '../health-smells/fixer-stuck.mjs';
import claimNoProgress from '../health-smells/fix-claim-held-no-progress.mjs';
import sessionStuck from '../health-smells/session-stuck.mjs';
import ghostListed from '../health-smells/ghost-session-listed.mjs';
import { probeSessionWatchdog } from '../health-watch.mjs';
import { runHealthTick, emptyHealthState } from '../health-watch-core.mjs';

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
      readHeavy: () => null, listClaims: () => claims, prHeadFor: () => 'abc', completionFor: () => null,
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
  it('an invalid sessionWatchdog config is reported, and the default stands', () => {
    const dir = mkdtempSync(join(tmpdir(), 'watchdog-health-'));
    const r = probeSessionWatchdog({ dir, now: T0, runPass: (o) => ({ at: new Date(o.nowMs).toISOString(), cfg: o.config }), config: { sessionWatchdog: { intervalMinutes: -1 } } });
    expect(r.configError).toMatch(/intervalMinutes/);
    expect(r.cfg).toBe(CFG);
  });
});
