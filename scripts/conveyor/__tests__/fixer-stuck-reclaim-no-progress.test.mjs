import { describe, expect, it, vi } from 'vitest';
import { planFixerStuckReclaim, runFixerStuckReclaimPass } from '../fixer-stuck-reclaim.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ESCALATION_EVENT_TYPE, escalationKey, escalationAckKey, runSessionWatchdogPass, summarizeTail } from '../session-watchdog.mjs';

const MIN = 60_000;
const NOW = Date.parse('2026-11-14T23:47:00Z');
const SID = 'sid-fix-6770';
const HEAD = 'a'.repeat(40);
const EVENT = {
  type: ESCALATION_EVENT_TYPE, v: 1,
  key: escalationKey({ repo: 'we', pr: 6770, sessionId: SID, classification: 'no-progress', headSha: HEAD }),
  at: new Date(NOW - 16 * MIN).toISOString(), repo: 'we', pr: 6770, claimKind: 'fixing',
  session: { name: 'fix-6770', id: 'f6770001', sessionId: SID },
  classification: 'no-progress', reason: 'no-new-head-or-verdict', headSha: HEAD, ask: 'escalate-fixer',
};
const CLAIM = { owner: 'fixer:fix-6770', meta: {
  kind: 'fixing', repo: 'we', pr: 6770, who: 'fix-6770', sessionId: SID,
  headSha: HEAD, claimedAt: new Date(NOW - 180 * MIN).toISOString(),
} };
const PROGRESS = { known: true, lastCommitMs: NOW - 190 * MIN, awaitRecord: null,
  verifyMarker: { status: 'infrastructure-failure' } };
const BASE = {
  events: [EVENT], acked: new Set(), claims: [CLAIM], nowMs: NOW,
  awaitFor: () => null, prHeadFor: () => HEAD, progressFor: () => PROGRESS,
  // No-progress is not an idle classification: recent activity must not block this reclaim.
  lastActivityMsFor: () => NOW - MIN,
};

describe('fixer-stuck reclaim — no-progress uses the existing 15-minute event grace', () => {
  it('reclaims a 16m no-progress event even though the holder is active', () => {
    const rows = planFixerStuckReclaim(BASE);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: escalationAckKey(EVENT), decision: 'reclaim', claim: CLAIM });
    expect(rows[0].reason).toMatch(/no-progress/);
  });

  it('holds a 10m no-progress event inside the grace period', () => {
    const rows = planFixerStuckReclaim({ ...BASE, events: [
      { ...EVENT, at: new Date(NOW - 10 * MIN).toISOString() },
    ] });
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe('hold');
    expect(rows[0].reason).toMatch(/no-progress.*10 min.*grace 15 min/);
  });

  it('holds a 16m no-progress event while a fresh await targets an unpushed commit', () => {
    const rows = planFixerStuckReclaim({ ...BASE, awaitFor: () => ({
      v: 1, sessionId: SID, who: 'fix-6770', pr: 6770, kind: 'fix',
      sha: 'b'.repeat(40), requestedAt: new Date(NOW - MIN).toISOString(),
    }) });
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe('hold');
    expect(rows[0].reason).toMatch(/unpushed/);
  });
});


describe('no-progress reclaim revalidation', () => {
  it('acks a moved PR head as superseded', () => {
    expect(planFixerStuckReclaim({ ...BASE, prHeadFor: () => 'b'.repeat(40) })[0])
      .toMatchObject({ decision: 'ack', reason: expect.stringMatching(/superseded/) });
  });
  it.each([
    ['lane commit', { ...PROGRESS, lastCommitMs: NOW - MIN }],
    ['green verdict', { ...PROGRESS, verifyMarker: { status: 'green', finishedAt: new Date(NOW - MIN).toISOString() } }],
    ['red verdict', { ...PROGRESS, verifyMarker: { status: 'red', finishedAt: new Date(NOW - MIN).toISOString() } }],
  ])('acks resumed progress (%s) as superseded', (_label, progress) => {
    expect(planFixerStuckReclaim({ ...BASE, progressFor: () => progress })[0])
      .toMatchObject({ decision: 'ack', reason: expect.stringMatching(/superseded/) });
  });
  it.each([null, {}, { ...PROGRESS, verifyMarker: { status: 'unrecognized' } },
    { ...PROGRESS, verifyMarker: { status: 'green' } }])('holds unknown progress evidence %j', (progress) => {
    expect(planFixerStuckReclaim({ ...BASE, progressFor: () => progress })[0].decision).toBe('hold');
  });
  it('holds an unknown PR head', () => {
    expect(planFixerStuckReclaim({ ...BASE, prHeadFor: () => null })[0].decision).toBe('hold');
  });
  it.each(['headSha', 'claimedAt'])('holds incomplete claim evidence: %s', (field) => {
    const meta = { ...CLAIM.meta, [field]: null };
    expect(planFixerStuckReclaim({ ...BASE, claims: [{ ...CLAIM, meta }] })[0].decision).toBe('hold');
  });
  it('honours the no-progress window recorded by the watchdog', () => {
    const event = { ...EVENT, evidence: { noProgressMinutes: 200 } };
    expect(planFixerStuckReclaim({ ...BASE, events: [event] })[0].decision).toBe('hold');
  });
  it('holds a throwing progress reader', () => {
    expect(planFixerStuckReclaim({ ...BASE, progressFor: () => { throw new Error('unreadable'); } })[0].decision).toBe('hold');
  });
  it.each(['head moved', 'progress resumed'])('writes the existing superseded ack without stopping the holder: %s', async (cause) => {
    const appendAck = vi.fn();
    const stopSession = vi.fn();
    const result = await runFixerStuckReclaimPass({ ...BASE, env: {},
      readEvents: () => [EVENT], readAcked: () => new Set(), listClaims: () => [CLAIM],
      appendAck, stopSession, orphanPass: null,
      endFix: vi.fn(), releaseDispatch: vi.fn(), clearAwait: vi.fn(),
      prHeadFor: () => cause === 'head moved' ? 'b'.repeat(40) : HEAD,
      progressFor: () => ({ ...PROGRESS, lastCommitMs: NOW - MIN }),
    });
    expect(result.rows[0]).toMatchObject({ decision: 'ack', result: 'acked' });
    expect(appendAck).toHaveBeenCalledWith(expect.objectContaining({ key: escalationAckKey(EVENT), action: 'superseded' }));
    expect(stopSession).not.toHaveBeenCalled();
  });
});


describe('no-progress reclaim default lane reader', () => {
  it.each([[], [{ name: 'other', sessionId: 'other' }], [{ name: 'fix-6770', sessionId: SID }]])(
    'holds when the live holder lane is missing: %j', async (agents) => {
      const stopSession = vi.fn();
      const result = await runFixerStuckReclaimPass({ ...BASE, progressFor: null, env: {},
        readEvents: () => [EVENT], readAcked: () => new Set(), listClaims: () => [CLAIM],
        listAgents: () => agents, stopSession, orphanPass: null,
      });
      expect(result.rows[0].decision).toBe('hold');
      expect(stopSession).not.toHaveBeenCalled();
    },
  );
  it('holds every event and reads the agent listing only once when the listing throws', async () => {
    const listAgents = vi.fn(() => { throw new Error('listing unreadable'); });
    const second = { ...EVENT, key: 'second', pr: 6771 };
    const stopSession = vi.fn();
    const result = await runFixerStuckReclaimPass({ ...BASE, progressFor: null, env: {},
      readEvents: () => [EVENT, second], readAcked: () => new Set(),
      listClaims: () => [CLAIM, { ...CLAIM, meta: { ...CLAIM.meta, pr: 6771 } }],
      listAgents, stopSession, orphanPass: null,
    });
    expect(result.rows.map((row) => row.decision)).toEqual(['hold', 'hold']);
    expect(listAgents).toHaveBeenCalledTimes(1);
    expect(stopSession).not.toHaveBeenCalled();
  });
});

it('rearms the same session/head after an unpushed commit, with a fresh event grace and no repeated emission', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reclaim-rearm-'));
  try {
    const agent = { ...EVENT.session, kind: 'background', state: 'working', startedAt: NOW - 200 * MIN, pid: 99 };
    const acked = new Set();
    let progress = PROGRESS;
    const pass = (nowMs) => runSessionWatchdogPass({ nowMs, act: true, agents: [agent],
      processes: [{ pid: 99, command: 'claude' }], eventDir: dir,
      readTail: () => summarizeTail([{ kind: 'assistant', ts: new Date(nowMs - MIN).toISOString(),
        blocks: [{ kind: 'tool_use', id: 'edit', name: 'Edit', rawInput: {} }] }], { nowMs }),
      readHeavy: () => null, completionFor: () => null, listClaims: () => [CLAIM],
      prHeadFor: () => HEAD, progressFor: () => progress,
    });
    const first = pass(NOW).events[0];
    expect(first).toBeDefined();
    progress = { ...PROGRESS, lastCommitMs: NOW + MIN };
    const resumed = await runFixerStuckReclaimPass({ ...BASE, nowMs: NOW + 2 * MIN,
      readEvents: () => [first], readAcked: () => acked, listClaims: () => [CLAIM],
      progressFor: () => progress, eventDir: dir, orphanPass: null, stopSession: vi.fn(),
      appendAck: undefined,
    });
    expect(resumed.rows[0].decision).toBe('ack');
    const later = NOW + 122 * MIN;
    const second = pass(later).events[0];
    expect(second).toMatchObject({ written: true, at: new Date(later).toISOString() });
    const { readFileSync } = await import('node:fs');
    const events = readFileSync(join(dir, 'fixer-escalations.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(events).toHaveLength(2);
    const acks = new Set(readFileSync(join(dir, 'fixer-escalations.ack.jsonl'), 'utf8').trim().split('\n').map((s) => JSON.parse(s).key));
    const plan = (nowMs) => planFixerStuckReclaim({ ...BASE, events, acked: acks, nowMs, progressFor: () => progress });
    expect(plan(later)).toHaveLength(1);
    expect(plan(later)[0].decision).toBe('hold');
    expect(plan(later + 16 * MIN)[0].decision).toBe('reclaim');
    pass(later + MIN);
    expect(readFileSync(join(dir, 'fixer-escalations.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('revalidates legacy session/head acks instead of suppressing future no-progress instances', () => {
  const future = { ...EVENT, at: new Date(NOW).toISOString() };
  const rows = planFixerStuckReclaim({ ...BASE, events: [EVENT, future], acked: new Set([EVENT.key]) });
  expect(rows.map((r) => r.decision)).toEqual(['reclaim', 'hold']);
  expect(new Set(rows.map((r) => r.key)).size).toBe(2);
});
