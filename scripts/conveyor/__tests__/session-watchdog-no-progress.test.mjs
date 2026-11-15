import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planFixerStuckReclaim } from '../fixer-stuck-reclaim.mjs';
import { describe, expect, it, vi } from 'vitest';
import {
  CLASSES, DEFAULT_SESSION_WATCHDOG, ESCALATION_EVENT_TYPE, escalationKey,
  defaultProgressFor, resolveSessionWatchdogConfig, runSessionWatchdogPass, summarizeTail,
} from '../session-watchdog.mjs';
import { DEFAULT_VERIFY_TTL_MINUTES } from '../../lib/lane-verify.mjs';

const MIN = 60_000;
const NOW = Date.parse('2026-11-14T23:47:00Z');
const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const SID = 'sid-fix-6770';
const isoAgo = (minutes) => new Date(NOW - minutes * MIN).toISOString();
const AGENT = {
  name: 'fix-6770', sessionId: SID, id: 'f6770001', kind: 'background', state: 'working',
  startedAt: NOW - 200 * MIN, pid: 6770, cwd: 'fixture-lane',
};
const CLAIM = {
  owner: 'fixer:fix-6770', heartbeatAt: isoAgo(1),
  meta: { repo: 'we', pr: 6770, kind: 'fixing', who: AGENT.name, sessionId: SID,
    headSha: HEAD, claimedAt: isoAgo(180) },
};

// Synthetic transcript in the existing watchdog fixture format: recent edits keep the holder ACTIVE,
// even though its lane has produced neither a new commit nor a green/red verdict for three hours.
const TAIL = summarizeTail([
  { kind: 'assistant', ts: isoAgo(2), blocks: [
    { kind: 'tool_use', id: 'edit-6770', name: 'Edit', rawInput: { file_path: 'fixture.mjs' } },
  ] },
  { kind: 'user', ts: isoAgo(1), blocks: [
    { kind: 'tool_result', toolUseId: 'edit-6770', isError: false, content: '' },
  ] },
], { nowMs: NOW });

// Proposed progressFor(holder, claim) fact contract: known lane commit time in ms, the native
// verify marker, and the stored await record (null means a successful read found no record).
// These facts are loaded by the IO shell; planWatchdog must remain a pure planner.
const PROGRESS = {
  known: true, lastCommitMs: NOW - 190 * MIN, awaitRecord: null,
  verifyMarker: { status: 'infrastructure-failure', sha: HEAD, startedAt: isoAgo(8), finishedAt: isoAgo(1) },
};

function fixture({ progress = {}, age = 180, ...overrides } = {}) {
  const claim = { ...CLAIM, meta: { ...CLAIM.meta, claimedAt: isoAgo(age) } };
  const emitted = new Set();
  const written = [];
  const progressFor = vi.fn(() => ({ ...PROGRESS, ...progress }));
  const opts = {
    nowMs: NOW, act: true, agents: [AGENT], processes: [{ pid: AGENT.pid, command: 'claude' }],
    readTail: () => TAIL, readHeavy: () => null, completionFor: () => null,
    listClaims: () => [claim], prHeadFor: () => HEAD, progressFor,
    readLedger: () => ({ emitted: new Set(emitted), acked: new Set() }),
    appendEvent: (event) => { written.push(event); emitted.add(event.key); },
    readRmLedger: () => ({}), writeRmLedger: vi.fn(), rm: vi.fn(),
    releaseFixing: vi.fn(), releaseDispatch: vi.fn(), ...overrides,
  };
  return { opts, claim, progressFor, written, pass: () => runSessionWatchdogPass(opts) };
}

function expectHeld(f) {
  const result = f.pass();
  expect(result.rows[0].class).toBe(CLASSES.ACTIVE);
  expect(result.events).toEqual([]);
  expect(f.written).toEqual([]);
  expect(f.progressFor).toHaveBeenCalledTimes(1);
}

describe('session watchdog — live fix claim with no progress (#6770)', () => {
  it('emits exactly ONE no-progress event for an active 180m claim with only infrastructure-failure verifies', () => {
    const f = fixture();
    const result = f.pass();
    expect(result.rows[0].class).toBe(CLASSES.ACTIVE);
    expect(result.events).toHaveLength(1);
    expect(f.written).toHaveLength(1);
    expect(f.written[0]).toMatchObject({
      type: ESCALATION_EVENT_TYPE, v: 1, repo: 'we', pr: 6770, claimKind: 'fixing',
      classification: 'no-progress', reason: 'no-new-head-or-verdict', headSha: HEAD,
      session: { name: AGENT.name, sessionId: SID }, ask: 'escalate-fixer',
      key: escalationKey({ repo: 'we', pr: 6770, sessionId: SID, classification: 'no-progress', headSha: HEAD }),
    });
    expect(f.progressFor).toHaveBeenCalledWith(expect.objectContaining({ sessionId: SID }), f.claim);
  });

  it('holds a fresh await-verify record (requestedAt inside 150m)', () => {
    expectHeld(fixture({ age: 140, progress: { awaitRecord: {
      v: 1, sessionId: SID, who: AGENT.name, kind: 'fix', pr: 6770,
      lane: AGENT.cwd, sha: OTHER_HEAD, requestedAt: isoAgo(149),
    } } }));
  });

  it('holds a fresh running marker while claim age is below N+30, without requiring a SHA match', () => {
    expectHeld(fixture({ age: 120 + DEFAULT_VERIFY_TTL_MINUTES - 1, progress: {
      verifyMarker: { status: 'running', sha: OTHER_HEAD, startedAt: isoAgo(1), finishedAt: null },
    } }));
  });

  it('emits at claim age N+30 despite a fresh running marker (the infra-retry hold is capped)', () => {
    const f = fixture({ age: 120 + DEFAULT_VERIFY_TTL_MINUTES, progress: {
      verifyMarker: { status: 'running', sha: OTHER_HEAD, startedAt: isoAgo(1), finishedAt: null },
    } });
    expect(f.pass().events).toEqual([expect.objectContaining({ classification: 'no-progress' })]);
    expect(f.written).toHaveLength(1);
  });

  it('holds a lane HEAD commit within N even when the PR head has not moved', () => {
    expectHeld(fixture({ progress: { lastCommitMs: NOW - 119 * MIN } }));
  });

  it.each(['green', 'red'])('holds a %s verdict within N', (status) => {
    expectHeld(fixture({ progress: { verifyMarker: {
      status, sha: HEAD, startedAt: isoAgo(121), finishedAt: isoAgo(119),
    } } }));
  });

  it.each([['head differs from claim head', OTHER_HEAD], ['head unknown', null]])(
    'holds and does not read lane progress when %s', (_label, head) => {
      const f = fixture({ prHeadFor: () => head });
      expect(f.pass().events).toEqual([]);
      expect(f.written).toEqual([]);
      expect(f.progressFor).not.toHaveBeenCalled();
    },
  );

  it('holds when progressFor throws (fail closed on unreadable lane facts)', () => {
    const progressFor = vi.fn(() => { throw new Error('lane unreadable'); });
    const f = fixture({ progressFor });
    expect(f.pass().events).toEqual([]);
    expect(f.written).toEqual([]);
    expect(progressFor).toHaveBeenCalledTimes(1);
  });

  it('does not read progress before the configured no-progress age', () => {
    const f = fixture({ age: 119 });
    expect(f.pass().events).toEqual([]);
    expect(f.progressFor).not.toHaveBeenCalled();
  });

  it('deduplicates consecutive passes by session and claim head through the escalation ledger', () => {
    const f = fixture();
    const first = f.pass();
    const second = f.pass();
    expect(first.events).toHaveLength(1);
    expect(second.events).toHaveLength(1);
    expect(second.events[0].key).toBe(first.events[0].key);
    expect(f.written).toHaveLength(1);
    expect(second.events[0].written).toBe(true);
  });
});

describe('session watchdog — noProgressMinutes config', () => {
  it('defaults to 120 minutes', () => {
    expect(DEFAULT_SESSION_WATCHDOG.noProgressMinutes).toBe(120);
  });

  it('accepts an override and uses it to hold a claim below N', () => {
    const { config, error } = resolveSessionWatchdogConfig({ noProgressMinutes: 200 });
    expect(error).toBeNull();
    expect(config.noProgressMinutes).toBe(200);
    const f = fixture({ config });
    expect(f.pass().events).toEqual([]);
    expect(f.progressFor).not.toHaveBeenCalled();
  });

  it('accepts the 45-minute fallback floor and emits at that configured threshold', () => {
    const { config, error } = resolveSessionWatchdogConfig({ noProgressMinutes: 45 });
    expect(error).toBeNull();
    const f = fixture({ config, age: 45 });
    expect(f.pass().events).toEqual([expect.objectContaining({ classification: 'no-progress' })]);
    expect(f.written).toHaveLength(1);
  });

  it.each([0, 44])('rejects %s minutes and retains the whole default config', (noProgressMinutes) => {
    const { config, error } = resolveSessionWatchdogConfig({ noProgressMinutes });
    expect(config).toBe(DEFAULT_SESSION_WATCHDOG);
    expect(error).toMatch(/session-watchdog config.*noProgressMinutes/);
  });
});

describe('defaultProgressFor — unknown verify marker evidence fails closed', () => {
  const exec = (_cmd, args) => (args.includes('--absolute-git-dir') ? '/x/.git\n' : '1700000000\n');
  const holder = { cwd: '/x', sessionId: 's', name: 'n' };
  const read = (marker) => defaultProgressFor(holder, {}, { exec, readMarker: () => marker, readFile: () => { const e = new Error('nf'); e.code = 'ENOENT'; throw e; } });
  it('treats an unrecognized status as unknown', () => { expect(read({ status: 'unrecognized' })).toBeNull(); });
  it.each(['running', 'green', 'red', 'infrastructure-failure'])('accepts known status %s', (status) => {
    expect(read({ status })?.known).toBe(true);
  });
  it('treats an empty-object marker as unknown', () => { expect(read({})).toBeNull(); });
  it('treats a corrupt marker as unknown', () => { expect(read({ corrupt: true })).toBeNull(); });
  it('accepts an absent marker and a well-formed one', () => {
    expect(read(null)?.known).toBe(true);
    expect(read({ status: 'green' })?.known).toBe(true);
  });
});

it('retains a red verdict on uncommitted edits across an infrastructure-failure retry and reader restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-verdict-'));
  try {
    const first = fixture().pass().events[0];
    const holder = { ...AGENT, cwd: 'lane' };
    const exec = (_cmd, args) => args.includes('--absolute-git-dir') ? '/fixture/lane.git' : String((NOW - 190 * MIN) / 1000);
    const absent = () => { const e = new Error('absent'); e.code = 'ENOENT'; throw e; };
    const read = (marker) => defaultProgressFor(holder, CLAIM, { exec, readFile: absent,
      readMarker: () => marker, progressStateDir: dir });
    read({ status: 'red', sha: HEAD, finishedAt: new Date(NOW + 10 * MIN).toISOString() });
    const progress = read({ status: 'infrastructure-failure', sha: HEAD,
      finishedAt: new Date(NOW + 12 * MIN).toISOString() });
    const rows = planFixerStuckReclaim({ events: [first], acked: new Set(), claims: [CLAIM],
      nowMs: NOW + 16 * MIN, prHeadFor: () => HEAD, progressFor: () => progress });
    expect(rows[0]).toMatchObject({ decision: 'ack', reason: expect.stringMatching(/progress/) });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it.each(['green', 'red'])('retains %s verdicts during a running retry, expires them, and holds unreadable durable evidence', (status) => {
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-verdict-closed-'));
  try {
    const absent = () => { const e = new Error('absent'); e.code = 'ENOENT'; throw e; };
    const read = (marker) => defaultProgressFor(AGENT, CLAIM, {
      exec: (_cmd, args) => args.includes('--absolute-git-dir') ? '/fixture/lane.git' : String((NOW - 190 * MIN) / 1000),
      readFile: absent, readMarker: () => marker, progressStateDir: dir,
    });
    read({ status, finishedAt: isoAgo(6) });
    const progress = read({ status: 'running', startedAt: isoAgo(1) });
    expect(fixture({ progress }).pass().events).toEqual([]);
    expect(fixture({ progress, nowMs: NOW + 121 * MIN }).pass().events).toHaveLength(1);
    const file = join(dir, readdirSync(dir)[0]);
    writeFileSync(file, 'unreadable-json');
    expect(read({ status: 'infrastructure-failure' })).toBeNull();
    expect(fixture({ progressFor: () => read({ status: 'infrastructure-failure' }) }).pass().events).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
