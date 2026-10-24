import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { redTeamRecoveryRows, planRedTeamOnSkip, runRedTeamOnSkip } from '../../lib/review-red-team-on-skip.mjs';
import { redTeamForHead, redTeamMarker } from '../../lib/red-team-gate.mjs';
import { runReviewJob, dispatchReviewJob, writeJobRecord, redTeamRunnerArgs } from '../review-job.mjs';

import { acquireRedTeamAdmissionLock, redTeamStatusDir, readFreshRedTeamAttempts, reserveFreshRedTeamAttempt } from '../../lib/drain-red-team-evidence.mjs';
import { writeRun } from '../run-store.mjs';
import { provenanceRun } from '../../lib/__tests__/fixtures/saved-red-team-provenance.mjs';
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const repo = 'web-everything/web-everything', head = 'a'.repeat(40), pr = 5762;
const payload = () => ({ verdict: { verdict: 'accept' }, findings: { read: { netBasis: { rev: head } } } });
function fakeIo(over = {}) {
  const root = mkdtempSync(join(tmpdir(), 'recovery-admission-')); roots.push(root);
  // Status, admission locks and attempt slots follow sharedRunsDir, not OPERATION_RUNS_DIR.
  const env = { CONVEYOR_STATE_ROOT: root, WE_SHARED_RUNS_DIR: join(root, 'runs'), OPERATION_RUNS_DIR: join(root, 'runs'), WE_PLATFORM_PREFERENCES_FILE: join(root, 'missing') };
  const readRecords = over.readRedTeamRecords ?? (() => []);
  // Existing clean-row resume fixtures explicitly gain the completed-job attestation now required.
  const readRedTeamRecords = () => {
    const rows = readRecords();
    if (over.attest !== false && Array.isArray(rows)) rows.forEach((row, index) => {
      if (row.status === 'ok') writeRun(provenanceRun({ env, rows, indexes: [index], id: `review-pr-proof-${index}` }), env.OPERATION_RUNS_DIR);
    });
    return rows;
  };
  return { root: '/daemon', now: () => 1_000, newActorId: () => 'actor',
    readPrevCompletion: () => null, claim: vi.fn(() => ({ ok: true })),
    updateRecord: vi.fn(), unclaim: vi.fn(), acquireLane: vi.fn(() => ({ lanePath: '/lanes/lane-7' })),
    releaseLane: vi.fn(), log: vi.fn(), report: vi.fn(), runLoop: vi.fn(), runExtraSeats: vi.fn(),
    carryAcrossRebaseSetting: vi.fn(), readCarryEvidence: vi.fn(), restampVerdict: vi.fn(),
    speculativeRedTeamSetting: vi.fn(() => ({ enabled: true })), startSpeculativeRedTeam: vi.fn(),
    readRedTeamOnlyPayload: vi.fn(() => ({ head, loopPayload: payload() })),
    readRedTeamComments: vi.fn(() => []),
    readFreshRedTeamAttempts: vi.fn(input => readFreshRedTeamAttempts({ ...input, env })),
    reserveFreshRedTeamAttempt: vi.fn(input => reserveFreshRedTeamAttempt(input, { env })),
    readRedTeamStatus: vi.fn(() => null), readRedTeamRecords: vi.fn(() => []), recordRedTeamQueued: vi.fn(),
    runRedTeam: vi.fn(() => ({ status: 'ran', findings: [], comment: { status: 'posted' } })),
    runRedTeamGate: vi.fn(() => ({ status: 'ok', outcome: 'advisory' })), redTeamStatus: vi.fn(), env, readRedTeamRecoveryEvidence: () => ({ inFlight: false, queued: false }), ...over, readRedTeamRecords: vi.fn(readRedTeamRecords) };
}

describe('red-team-only review job', () => {
  const admissionPath = io => join(redTeamStatusDir(io.env), `${encodeURIComponent(repo.toLowerCase())}-${pr}-${head}.json.admission.lock`);
  it('isolates admission locks and attempt slots between fixture roots', () => {
    const first = fakeIo(), second = fakeIo();
    expect(redTeamStatusDir(first.env)).toBe(join(first.env.CONVEYOR_STATE_ROOT, 'red-team-status'));
    expect(redTeamStatusDir(second.env)).toBe(join(second.env.CONVEYOR_STATE_ROOT, 'red-team-status'));
    const locks = [first, second].map(io => acquireRedTeamAdmissionLock({ repo, pr, head, env: io.env }));
    try {
      for (const lock of locks) {
        expect(lock.ok).toBe(true);
        expect(lock.stillHeld()).toBe(true);
      }
      expect(first.reserveFreshRedTeamAttempt({ repo, pr, head, at: 1, pid: 42, maxFreshPerHead: 2 })).toBe(0);
      expect(readFreshRedTeamAttempts({ repo, pr, head, env: first.env })).toHaveLength(1);
      expect(readFreshRedTeamAttempts({ repo, pr, head, env: second.env })).toEqual([]);
    } finally { for (const lock of locks) lock.release?.(); }
  });
  it('refuses a second admission while the live owner holds the lock, before evidence reads and with zero red-team calls', () => {
    const io = fakeIo();
    const second = { ...io, runRedTeam: vi.fn() };
    io.recordRedTeamQueued.mockImplementation(() => {
      const owner = JSON.parse(readFileSync(admissionPath(io), 'utf8'));
      expect(owner).toMatchObject({ pid: process.pid, at: expect.any(Number) });
      expect(owner).toHaveProperty('pidStart');
      expect(runReviewJob({ pr, repo, redTeamOnly: true }, second)).toMatchObject({
        outcome: 'red-team-not-owed', reason: 'red-team admission in progress',
      });
      expect(second.runRedTeam).not.toHaveBeenCalled();
      expect(io.readRedTeamStatus).toHaveBeenCalledOnce();
      expect(existsSync(admissionPath(io))).toBe(true);
    });
    io.runRedTeam.mockImplementation(() => {
      expect(existsSync(admissionPath(io))).toBe(false);
      return { status: 'ran' };
    });
    expect(runReviewJob({ pr, repo, redTeamOnly: true }, io).outcome).toBe('red-team-only');
    expect(io.recordRedTeamQueued).toHaveBeenCalledOnce();
    expect(io.runRedTeam).toHaveBeenCalledOnce();
    expect(existsSync(admissionPath(io))).toBe(false);
  });
  it('reclaims a stale lock before admitting and releases it after queued', () => {
    const io = fakeIo();
    const { release } = acquireRedTeamAdmissionLock({ repo, pr, head, env: io.env });
    // An impossible PID in the platform PID range is observed as dead by the real probe.
    writeFileSync(admissionPath(io), JSON.stringify({ pid: 2147483647, pidStart: null, at: 1 }));
    expect(runReviewJob({ pr, repo, redTeamOnly: true }, io).outcome).toBe('red-team-only');
    expect(io.runRedTeam).toHaveBeenCalledOnce();
    expect(existsSync(admissionPath(io))).toBe(false);
    release();
  });
  it.each(['status', 'in-flight', 'queued', 'cooldown', 'comments', 'queued-write'])('releases admission after %s refusal', kind => {
    const io = fakeIo({
      ...(kind === 'status' ? { readRedTeamStatus: () => { throw Error('unreadable'); } } : {}),
      ...(['in-flight', 'queued'].includes(kind) ? { readRedTeamRecoveryEvidence: () => ({ inFlight: kind === 'in-flight', queued: kind === 'queued' }) } : {}),
      ...(kind === 'cooldown' ? { readRedTeamStatus: () => ({ updatedAtMs: 999 }) } : {}),
      ...(kind === 'comments' ? { readRedTeamComments: () => { throw Error('unreadable'); } } : {}),
      ...(kind === 'queued-write' ? { recordRedTeamQueued: () => { throw Error('unwritable'); } } : {}),
    });
    expect(runReviewJob({ pr, repo, redTeamOnly: true }, io).outcome).toBe(kind === 'status' ? 'blocked-on-infra' : 'red-team-not-owed');
    expect(io.runRedTeam).not.toHaveBeenCalled();
    expect(existsSync(admissionPath(io))).toBe(false);
  });
  it('fails closed on unreadable lock ownership with zero red-team calls and preserves the lock', () => {
    const io = fakeIo();
    const { release } = acquireRedTeamAdmissionLock({ repo, pr, head, env: io.env });
    writeFileSync(admissionPath(io), '{');
    expect(runReviewJob({ pr, repo, redTeamOnly: true }, io)).toMatchObject({ reason: 'red-team admission in progress' });
    expect(io.runRedTeam).not.toHaveBeenCalled();
    expect(io.readRedTeamStatus).not.toHaveBeenCalled();
    expect(readFileSync(admissionPath(io), 'utf8')).toBe('{');
    release();
  });
  it('reads status time and queued evidence only after exclusive admission', () => {
    const io = fakeIo({
      readRedTeamStatus: () => {
        expect(existsSync(admissionPath(io))).toBe(true);
        return null;
      },
      readRedTeamRecoveryEvidence: () => {
        expect(existsSync(admissionPath(io))).toBe(true);
        return { queued: true };
      },
    });
    expect(runReviewJob({ pr, repo, redTeamOnly: true }, io)).toMatchObject({ reason: 'red-team pass in flight' });
    expect(io.runRedTeam).not.toHaveBeenCalled();
    expect(existsSync(admissionPath(io))).toBe(false);
  });
  it.each(['', '{'])('reclaims unreadable or empty ownership older than 60 seconds (%j)', content => {
    const io = fakeIo();
    mkdirSync(redTeamStatusDir(io.env), { recursive: true });
    writeFileSync(admissionPath(io), content);
    utimesSync(admissionPath(io), new Date(0), new Date(0));
    expect(acquireRedTeamAdmissionLock({ repo, pr, head, env: io.env, now: () => 60_000 })).toEqual({ ok: false, reason: 'red-team admission in progress' });
    const { release } = acquireRedTeamAdmissionLock({ repo, pr, head, env: io.env, now: () => 60_001 });
    expect(release).toBeTypeOf('function');
    release();
    expect(existsSync(admissionPath(io))).toBe(false);
  });
  it.each([
    { stored: null, current: 'reused-start' },
    { stored: 'known-start', current: null },
    { stored: 'known-start', current: undefined },
  ])('reclaims a live-pid owner with unknown identity after 10 minutes (stored=$stored, current=$current)', ({ stored, current }) => {
    const io = fakeIo();
    mkdirSync(redTeamStatusDir(io.env), { recursive: true });
    writeFileSync(admissionPath(io), JSON.stringify({ pid: process.pid, pidStart: stored, at: 600_001 }));
    utimesSync(admissionPath(io), new Date(0), new Date(0));
    const lock = acquireRedTeamAdmissionLock({ repo, pr, head, env: io.env, now: () => 600_001,
      isAlive: () => true, readPidStart: () => current });
    try {
      expect(lock.ok).toBe(true);
      expect(JSON.parse(readFileSync(admissionPath(io), 'utf8')).pidStart).toBe(current);
    } finally { lock.release?.(); }
    expect(existsSync(admissionPath(io))).toBe(false);
  });
  it.each([
    { stored: null, current: 'reused-start' },
    { stored: 'known-start', current: null },
    { stored: 'known-start', current: undefined },
  ].flatMap(identity => [599_999, 600_000].map(age => ({ ...identity, age }))))(
    'keeps unknown identity busy at $age ms (stored=$stored, current=$current)', ({ stored, current, age }) => {
    const io = fakeIo();
    mkdirSync(redTeamStatusDir(io.env), { recursive: true });
    const content = JSON.stringify({ pid: process.pid, pidStart: stored, at: 0 });
    writeFileSync(admissionPath(io), content);
    utimesSync(admissionPath(io), new Date(1_000_000), new Date(1_000_000));
    expect(acquireRedTeamAdmissionLock({ repo, pr, head, env: io.env, now: () => 1_000_000 + age,
      isAlive: () => true, readPidStart: () => current }))
      .toEqual({ ok: false, reason: 'red-team admission in progress' });
    expect(readFileSync(admissionPath(io), 'utf8')).toBe(content);
  });
  it.each([600_000, 600_001, 86_400_000])('keeps a live holder busy even with a lock aged %i ms', age => {
    const io = fakeIo();
    mkdirSync(redTeamStatusDir(io.env), { recursive: true });
    const content = JSON.stringify({ pid: process.pid, pidStart: 'live-start', at: 0 });
    writeFileSync(admissionPath(io), content);
    utimesSync(admissionPath(io), new Date(0), new Date(0));
    expect(acquireRedTeamAdmissionLock({ repo, pr, head, env: io.env, now: () => age,
      isAlive: () => true, readPidStart: () => 'live-start' }))
      .toEqual({ ok: false, reason: 'red-team admission in progress' });
    expect(readFileSync(admissionPath(io), 'utf8')).toBe(content);
  });
  it.each(['missing', 'malformed', 'unreadable', 'pid', 'at'])('stillHeld fails closed for %s ownership', kind => {
    const io = fakeIo();
    const lock = acquireRedTeamAdmissionLock({ repo, pr, head, env: io.env });
    expect(lock.stillHeld()).toBe(true);
    const owner = JSON.parse(readFileSync(admissionPath(io), 'utf8'));
    unlinkSync(admissionPath(io));
    if (kind === 'malformed') writeFileSync(admissionPath(io), '{');
    if (kind === 'unreadable') mkdirSync(admissionPath(io));
    if (['pid', 'at'].includes(kind)) {
      owner[kind]++;
      writeFileSync(admissionPath(io), JSON.stringify(owner));
    }
    expect(lock.stillHeld()).toBe(false);
  });
  it('refuses lost admission before reserve without creating an attempt slot', () => {
    const io = fakeIo();
    io.readRedTeamComments.mockImplementation(() => {
      unlinkSync(admissionPath(io));
      return [];
    });
    expect(runReviewJob({ pr, repo, redTeamOnly: true, redTeamMode: 'fresh' }, io)).toMatchObject({
      outcome: 'red-team-not-owed', reason: 'red-team admission lost',
    });
    expect(io.reserveFreshRedTeamAttempt).not.toHaveBeenCalled();
    expect(readFreshRedTeamAttempts({ repo, pr, head, env: io.env })).toEqual([]);
    expect(io.recordRedTeamQueued).not.toHaveBeenCalled();
    expect(io.runRedTeam).not.toHaveBeenCalled();
  });
  it.each(['fresh', 'resume'])('refuses lost admission immediately before queued in %s mode', redTeamMode => {
    const io = fakeIo(redTeamMode === 'resume' ? {
      readRedTeamStatus: () => ({ status: 'finished', result: 'ran' }),
      readRedTeamRecords: () => [{ dispatchKind: 'review-seat', seat: 'red-team', repo, pr, rev: head, status: 'ok' }],
    } : {});
    const replaceOwner = () => {
      const owner = JSON.parse(readFileSync(admissionPath(io), 'utf8'));
      writeFileSync(admissionPath(io), JSON.stringify({ ...owner, at: owner.at + 1 }));
    };
    if (redTeamMode === 'fresh') {
      io.reserveFreshRedTeamAttempt.mockImplementation(input => {
        const index = reserveFreshRedTeamAttempt(input, { env: io.env });
        replaceOwner();
        return index;
      });
    } else {
      io.readRedTeamComments.mockImplementation(() => { replaceOwner(); return []; });
    }
    expect(runReviewJob({ pr, repo, redTeamOnly: true, redTeamMode }, io)).toMatchObject({
      outcome: 'red-team-not-owed', reason: 'red-team admission lost',
    });
    expect(readFreshRedTeamAttempts({ repo, pr, head, env: io.env })).toHaveLength(redTeamMode === 'fresh' ? 1 : 0);
    expect(io.recordRedTeamQueued).not.toHaveBeenCalled();
    expect(io.runRedTeam).not.toHaveBeenCalled();
    expect(existsSync(admissionPath(io))).toBe(true);
  });
  it('concurrent reclaimers admit exactly one contender while stale-owner inspection is paused', () => {
    const io = fakeIo();
    const input = { repo, pr, head, env: io.env };
    mkdirSync(redTeamStatusDir(io.env), { recursive: true });
    writeFileSync(admissionPath(io), JSON.stringify({ pid: 2147483647, pidStart: null, at: 1 }));
    let competitor;
    const competitorProbe = vi.fn(() => false);
    // Interleave a second acquisition after the first has read stale ownership,
    // before it can rename the path. Without the shared guard both would enter.
    const winner = acquireRedTeamAdmissionLock({ ...input, isAlive: () => {
      competitor = acquireRedTeamAdmissionLock({ ...input, isAlive: competitorProbe });
      expect(runReviewJob({ pr, repo, redTeamOnly: true }, io)).toMatchObject({
        reason: 'red-team admission in progress',
      });
      return false;
    } });
    try {
      expect([winner, competitor].filter(lock => lock.ok)).toHaveLength(1);
      expect(winner.ok).toBe(true);
      expect(competitor).toEqual({ ok: false, reason: 'red-team admission in progress' });
      expect(competitorProbe).not.toHaveBeenCalled();
      expect(io.runRedTeam).not.toHaveBeenCalled();
      expect(io.reserveFreshRedTeamAttempt).not.toHaveBeenCalled();
      expect(JSON.parse(readFileSync(admissionPath(io), 'utf8')).pid).toBe(process.pid);
      expect(acquireRedTeamAdmissionLock(input)).toMatchObject({ ok: false });
    } finally {
      winner.release?.();
      competitor?.release?.();
    }
    expect(readdirSync(redTeamStatusDir(io.env))).toEqual([]);
  });
  it.each([59_999, 60_000])('refuses a mutation guard aged %i ms without reading ownership', age => {
    const io = fakeIo();
    mkdirSync(redTeamStatusDir(io.env), { recursive: true });
    const guard = admissionPath(io) + '.guard';
    const content = JSON.stringify({ pid: 2147483647, at: 1 });
    writeFileSync(guard, content);
    utimesSync(guard, new Date(0), new Date(0));
    const isAlive = vi.fn();
    expect(acquireRedTeamAdmissionLock({ repo, pr, head, env: io.env, now: () => age, isAlive }))
      .toEqual({ ok: false, reason: 'red-team admission in progress' });
    expect(isAlive).not.toHaveBeenCalled();
    expect(readFileSync(guard, 'utf8')).toBe(content);
  });
  it('reclaims an abandoned mutation guard older than 60 seconds', () => {
    const io = fakeIo();
    mkdirSync(redTeamStatusDir(io.env), { recursive: true });
    const guard = admissionPath(io) + '.guard';
    writeFileSync(guard, '{');
    utimesSync(guard, new Date(0), new Date(0));
    const recovered = acquireRedTeamAdmissionLock({ repo, pr, head, env: io.env, now: () => 60_001 });
    expect(recovered.ok).toBe(true);
    expect(existsSync(guard)).toBe(false);
    expect(readdirSync(redTeamStatusDir(io.env))).toEqual([admissionPath(io).split('/').at(-1)]);
    recovered.release();
    expect(readdirSync(redTeamStatusDir(io.env))).toEqual([]);
  });
  it('accepts reclaiming a guard older than 60 seconds even with a live holder', () => {
    const io = fakeIo();
    mkdirSync(redTeamStatusDir(io.env), { recursive: true });
    const guard = admissionPath(io) + '.guard';
    writeFileSync(guard, JSON.stringify({ pid: process.pid, at: 0 }));
    utimesSync(guard, new Date(0), new Date(0));
    const recovered = acquireRedTeamAdmissionLock({ repo, pr, head, env: io.env, now: () => 60_001 });
    expect(recovered.ok).toBe(true);
    expect(existsSync(guard)).toBe(false);
    recovered.release();
    expect(readdirSync(redTeamStatusDir(io.env))).toEqual([]);
  });
  it('release preserves ownership while another mutation holds the guard', () => {
    const io = fakeIo();
    const lock = acquireRedTeamAdmissionLock({ repo, pr, head, env: io.env });
    const content = readFileSync(admissionPath(io), 'utf8');
    const guard = admissionPath(io) + '.guard';
    writeFileSync(guard, '{}');
    expect(lock.release()).toMatchObject({ ok: false });
    expect(readFileSync(admissionPath(io), 'utf8')).toBe(content);
    unlinkSync(guard);
    lock.release();
    expect(readdirSync(redTeamStatusDir(io.env))).toEqual([]);
  });
  it('refuses a second sequential acquire without release', () => {
    const io = fakeIo();
    const input = { repo, pr, head, env: io.env };
    const first = acquireRedTeamAdmissionLock(input);
    expect(first.ok).toBe(true);
    expect(acquireRedTeamAdmissionLock(input)).toEqual({ ok: false, reason: 'red-team admission in progress' });
    first.release();
    first.release(); // Missing files are harmless.
    expect(existsSync(admissionPath(io))).toBe(false);
  });
  it('reclaims a reused PID with a different known birth time', () => {
    const io = fakeIo();
    mkdirSync(redTeamStatusDir(io.env), { recursive: true });
    writeFileSync(admissionPath(io), JSON.stringify({ pid: process.pid, pidStart: 'old', at: 1 }));
    const lock = acquireRedTeamAdmissionLock({ repo, pr, head, env: io.env,
      isAlive: () => true, readPidStart: () => 'new' });
    expect(lock.ok).toBe(true);
    lock.release();
    expect(readdirSync(redTeamStatusDir(io.env))).toEqual([]);
  });
  it('refuses unavailable lock storage with zero red-team calls', () => {
    const io = fakeIo();
    mkdirSync(dirname(redTeamStatusDir(io.env)), { recursive: true });
    writeFileSync(redTeamStatusDir(io.env), 'not a directory');
    expect(runReviewJob({ pr, repo, redTeamOnly: true }, io)).toMatchObject({
      reason: 'red-team admission lock unavailable',
    });
    expect(io.runRedTeam).not.toHaveBeenCalled();
    expect(io.readRedTeamStatus).not.toHaveBeenCalled();
  });
  it.each(['pid', 'at'])('does not unlink a replacement lock with different %s on release', field => {
    const io = fakeIo();
    const { release } = acquireRedTeamAdmissionLock({ repo, pr, head, env: io.env, now: () => 1 });
    unlinkSync(admissionPath(io));
    const replacement = { pid: process.pid, pidStart: null, at: 1 };
    replacement[field]++;
    writeFileSync(admissionPath(io), JSON.stringify(replacement));
    release();
    expect(existsSync(admissionPath(io))).toBe(true);
  });
  it.each(['fresh', 'resume'])('refuses a result posted after the daemon snapshot in %s mode with zero red-team calls', redTeamMode => {
    const io = fakeIo({
      ...(redTeamMode === 'resume' ? {
        readRedTeamStatus: () => ({ status: 'finished', result: 'ran' }),
        readRedTeamRecords: () => [{ dispatchKind: 'review-seat', seat: 'red-team', repo, pr, rev: head, status: 'ok' }],
      } : {}),
      readRedTeamComments: vi.fn(() => [{ author: { login: 'web-everything' }, body: redTeamMarker(pr, head) }]),
    });
    expect(runReviewJob({ pr, repo, redTeamOnly: true, redTeamMode }, io)).toMatchObject({
      outcome: 'red-team-not-owed', reason: 'red-team result already on head',
    });
    expect(io.readRedTeamComments).toHaveBeenCalledOnce();
    expect(io.readRedTeamComments).toHaveBeenCalledWith({ pr, repo });
    for (const hook of ['recordRedTeamQueued', 'runRedTeam', 'runRedTeamGate', 'redTeamStatus']) expect(io[hook]).not.toHaveBeenCalled();
    expect(io.releaseLane).toHaveBeenCalledOnce(); expect(io.unclaim).toHaveBeenCalledOnce();
  });
  it.each(['fresh', 'resume'].flatMap(redTeamMode => ['throws', 'malformed', 'missing-hook'].map(kind => ({ redTeamMode, kind }))))(
    'refuses an unreadable PR comment thread ($kind) in $redTeamMode mode with zero red-team calls', ({ redTeamMode, kind }) => {
      const io = fakeIo({
        ...(redTeamMode === 'resume' ? {
          readRedTeamStatus: () => ({ status: 'finished', result: 'ran' }),
          readRedTeamRecords: () => [{ dispatchKind: 'review-seat', seat: 'red-team', repo, pr, rev: head, status: 'ok' }],
        } : {}),
        readRedTeamComments: kind === 'missing-hook' ? undefined : vi.fn(() => {
          if (kind === 'throws') throw Error('unreadable');
          return null;
        }),
      });
      expect(runReviewJob({ pr, repo, redTeamOnly: true, redTeamMode }, io)).toMatchObject({
        outcome: 'red-team-not-owed', reason: 'PR comments unreadable',
      });
      for (const hook of ['recordRedTeamQueued', 'runRedTeam', 'runRedTeamGate', 'redTeamStatus']) expect(io[hook]).not.toHaveBeenCalled();
      expect(io.releaseLane).toHaveBeenCalledOnce(); expect(io.unclaim).toHaveBeenCalledOnce();
    });
  it.each(['fresh', 'resume'])('writes queued status before releasing the job slot in %s mode', redTeamMode => {
    const calls = [];
    const io = fakeIo({
      ...(redTeamMode === 'resume' ? {
        readRedTeamStatus: () => ({ status: 'finished', result: 'ran' }),
        readRedTeamRecords: () => [{ dispatchKind: 'review-seat', seat: 'red-team', repo, pr, rev: head,
          status: 'ok', findings: [] }],
      } : {}),
      recordRedTeamQueued: vi.fn(input => calls.push(input.status)),
      redTeamStatus: vi.fn(input => calls.push(input.status)),
      unclaim: vi.fn(() => calls.push('unclaim')),
    });
    const out = runReviewJob({ pr, repo, redTeamOnly: true, redTeamMode }, io);
    expect(out.outcome).toBe('red-team-only');
    expect(calls).toEqual(['queued', 'unclaim', 'finished']);
    if (redTeamMode === 'fresh') {
      expect(io.reserveFreshRedTeamAttempt.mock.invocationCallOrder[0]).toBeLessThan(io.recordRedTeamQueued.mock.invocationCallOrder[0]);
      expect(io.recordRedTeamQueued.mock.invocationCallOrder[0]).toBeLessThan(io.unclaim.mock.invocationCallOrder[0]);
    } else expect(io.reserveFreshRedTeamAttempt).not.toHaveBeenCalled();
  });
  it.each(['fresh', 'resume'])('refuses a throwing strict queued hook in %s mode with zero red-team calls', redTeamMode => {
    const io = fakeIo({
      ...(redTeamMode === 'resume' ? {
        readRedTeamStatus: () => ({ status: 'finished', result: 'ran' }),
        readRedTeamRecords: () => [{ dispatchKind: 'review-seat', seat: 'red-team', repo, pr, rev: head, status: 'ok' }],
      } : {}),
      recordRedTeamQueued: vi.fn(() => {
        expect(io.unclaim).not.toHaveBeenCalled();
        expect(io.releaseLane).not.toHaveBeenCalled();
        throw Error('write failed');
      }),
    });
    expect(runReviewJob({ pr, repo, redTeamOnly: true, redTeamMode }, io)).toMatchObject({
      outcome: 'red-team-not-owed', reason: 'queued red-team status could not be persisted',
    });
    expect(io.recordRedTeamQueued).toHaveBeenCalledOnce();
    for (const hook of ['runRedTeam', 'runRedTeamGate', 'redTeamStatus']) expect(io[hook]).not.toHaveBeenCalled();
    expect(io.releaseLane).toHaveBeenCalledOnce(); expect(io.unclaim).toHaveBeenCalledOnce();
  });
  it('uses the stored payload for the existing red team and gate without a new review round', () => {
    const loopPayload = payload();
    const io = fakeIo({ readRedTeamOnlyPayload: vi.fn(() => ({ head, loopPayload })) });
    const out = runReviewJob({ pr, repo, redTeamOnly: true, preferLane: 7 }, io);
    expect(out).toMatchObject({ outcome: 'red-team-only', verdict: null, runId: null, redTeam: { status: 'ran' } });
    expect(io.readRedTeamOnlyPayload).toHaveBeenCalledWith({ pr, repo });
    expect(io.readRedTeamStatus).toHaveBeenCalledWith({ pr, repo, head });
    expect(io.runRedTeam).toHaveBeenCalledTimes(1);
    expect(io.runRedTeam).toHaveBeenCalledWith({ pr, repo, lanePath: '/lanes/lane-7', loopPayload, slug: `review-${pr}`, redTeamMode: 'fresh' });
    expect(io.runRedTeamGate).toHaveBeenCalledTimes(1);
    expect(io.runRedTeamGate).toHaveBeenCalledWith({ pr, repo });
    expect(io.recordRedTeamQueued).toHaveBeenCalledWith({ pr, repo, lanePath: '/lanes/lane-7', loopPayload,
      slug: `review-${pr}`, redTeamMode: 'fresh', status: 'queued' });
    expect(io.redTeamStatus.mock.calls.map(([c]) => c.status)).toEqual(['finished']);
    for (const hook of ['runLoop', 'runExtraSeats', 'report', 'carryAcrossRebaseSetting', 'readCarryEvidence', 'restampVerdict', 'speculativeRedTeamSetting', 'startSpeculativeRedTeam']) {
      expect(io[hook], hook).not.toHaveBeenCalled();
    }
    expect(io.acquireLane.mock.calls[0][0]).toMatchObject({ lane: 7 });
    expect(io.releaseLane).toHaveBeenCalledOnce(); expect(io.unclaim).toHaveBeenCalledOnce();
  });
  it.each([
    ['recorded-result recovery finishes missing comment and miss rows with zero model invocations', false],
    ['two consecutive recovery attempts retry a failed comment then succeed with zero model invocations', true],
  ])('%s', (_name, failFirstComment) => {
    const loopPayload = payload();
    Object.assign(loopPayload.findings.read, { title: 'Recover stored result', netChangedFiles: ['scripts/example.mjs'],
      diffText: 'diff --git a/scripts/example.mjs b/scripts/example.mjs\n+export const example = true;\n' });
    const prior = { dispatchKind: 'review-seat', seat: 'red-team', lens: 'red-team', status: 'ok',
      pr, repo, rev: head, callId: 'recorded-call', provider: 'codex', model: 'm', foldedVerdict: 'changes',
      changedFiles: ['scripts/example.mjs'], findings: [{ summary: 'Stored confirmed break', category: 'failing-input',
        file: 'scripts/example.mjs', line: 1, impactIfUnfixed: 'degraded', confirmedByRecheck: true,
        recheckReason: 'demonstrated break' }] };
    let observed, job, attempt = 0;
    let status = { status: 'finished', result: { status: 'ran', comment: 'error' } };
    const io = fakeIo({ readRedTeamOnlyPayload: () => ({ head, loopPayload }), readRedTeamRecords: () => [prior, ...(observed?.rows ?? [])],
      readRedTeamStatus: () => status,
      redTeamStatus: vi.fn(input => { status = { status: input.status, result: input.result }; }),
      runRedTeam: input => {
        // Mirror the production synchronous job hook's child-process boundary, while running the REAL
        // runRedTeam -> speculateRedTeam -> resumeRedTeam path with only external effects injected.
        const source = `
          import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
          import { tmpdir } from 'node:os';
          import { join } from 'node:path';
          import { runRedTeam } from ${JSON.stringify(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../review-extra-seats.mjs')).href)};
          import { writeRun } from ${JSON.stringify(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../run-store.mjs')).href)};
          import { provenanceRun } from ${JSON.stringify(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../../lib/__tests__/fixtures/saved-red-team-provenance.mjs')).href)};
          const { input, prior, saved, failComment } = JSON.parse(readFileSync(0, 'utf8'));
          const comments = saved?.comments ?? [], rows = saved?.rows ?? [];
          const calls = { model: 0, recheck: 0, reserve: 0, provider: 0 };
          const forbid = key => () => { calls[key]++; throw Error('unexpected ' + key); };
          const root = mkdtempSync(join(tmpdir(), 'red-team-recovery-'));
          const env = { CONVEYOR_STATE_ROOT: root, WE_SHARED_RUNS_DIR: join(root, 'runs'), OPERATION_RUNS_DIR: join(root, 'runs') };
          writeRun(provenanceRun({ env, rows: [prior] }), env.OPERATION_RUNS_DIR);
          let result;
          try { result = await runRedTeam({ ...input, resumeOnly: input.redTeamMode === 'resume', env }, {
            now: () => 1_000, log: () => {}, readRecords: () => [prior, ...rows],
            cliAvailable: forbid('provider'), reserveCalls: forbid('reserve'),
            runSeat: forbid('model'), runRecheck: forbid('recheck'),
            listComments: () => comments,
            postComment: ({ body }) => {
              if (failComment) throw Error('transient comment failure');
              comments.push({ body, author: { login: 'web-everything' } });
            },
            append: row => rows.push(row),
          }); } finally { rmSync(root, { recursive: true, force: true }); }
          process.stdout.write(JSON.stringify({ result, comments, rows, calls }));
        `;
        observed = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source], {
          input: JSON.stringify({ input, prior, saved: observed, failComment: failFirstComment && attempt++ === 0 }), encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
        }));
        return observed.result;
      },
    });
    const history = new Map();
    const recover = at => runRedTeamOnSkip({ repo,
      plan: { refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }] },
      rawPrs: [{ number: pr, headRefOid: head, comments: observed?.comments ?? [] }],
      readEvidence: () => ({ loopPayload, recorded: true }),
      readStatus: () => status,
      readRecoveryRows: input => redTeamRecoveryRows(io.readRedTeamRecords(), { ...input, env: io.env }),
      setting: { enabled: true, retryCooldownMin: 30 }, lastDispatch: history, now: () => at,
      capacity: { lanes: 1 }, dispatch: options => { job = runReviewJob(options, io); return { jobPid: 42 }; },
    });
    const recovery = recover(1_000);
    expect(recovery.dispatched).toEqual([{ prNumber: pr, jobPid: 42, mode: 'resume' }]);
    expect(job).toMatchObject({ outcome: 'red-team-only', redTeam: { status: 'resumed' } });
    if (failFirstComment) {
      expect(observed.result).toMatchObject({ status: 'resumed', comment: { status: 'error' }, rowsWritten: 2 });
      expect(observed.calls).toEqual({ model: 0, recheck: 0, reserve: 0, provider: 0 });
      expect(observed.comments).toEqual([]);
      // Persist the production hook's result object, then retry at the cooldown boundary.
      expect(status).toEqual({ status: 'finished', result: { status: 'resumed',
        reason: `retried (still failing) what the clean pass for #${pr} at ${head.slice(0, 12)} left undone — 2 row(s) written, delegation trial not-delegated, comment error` } });
      expect(recover(1_001).dispatched).toEqual([]);
      expect(recover(1_801_000).dispatched).toEqual([{ prNumber: pr, jobPid: 42, mode: 'resume' }]);
      expect(job).toMatchObject({ outcome: 'red-team-only', redTeam: { status: 'resumed' } });
    }
    expect(observed.result).toMatchObject({ status: 'resumed', comment: { status: 'posted' }, rowsWritten: failFirstComment ? 0 : 2 });
    expect(observed.calls).toEqual({ model: 0, recheck: 0, reserve: 0, provider: 0 });
    expect(observed.comments).toHaveLength(1);
    expect(redTeamForHead(observed.comments, pr, head)).toMatchObject({ pr, rev: head });
    expect(observed.rows.map(row => row.missRole).sort()).toEqual(['accepting-review', 'builder']);
    expect(observed.rows.every(row => row.redTeamCallId === prior.callId && row.rev === head)).toBe(true);
    expect(io.runRedTeamGate).toHaveBeenCalledWith({ pr, repo });
    expect(io.recordRedTeamQueued).toHaveBeenCalledTimes(failFirstComment ? 2 : 1);
    expect(io.redTeamStatus.mock.calls.map(([input]) => input.status)).toEqual(
      failFirstComment ? ['finished', 'finished'] : ['finished']);
    expect(recover(3_601_000).dispatched).toEqual([]);
    expect(io.runLoop).not.toHaveBeenCalled(); expect(io.runExtraSeats).not.toHaveBeenCalled();
  });
  it.each(['error', 'skipped', 'disabled', 'not-owed', null])('refuses resume without verified evidence after result %s without running any seats', prior => {
    const io = fakeIo({ readRedTeamStatus: vi.fn(() => ({ status: 'finished',
      result: { status: prior } })) });
    const out = runReviewJob({ pr, repo, redTeamOnly: true, redTeamMode: 'resume' }, io);
    expect(out).toMatchObject({ outcome: 'red-team-not-owed', reason: 'no verified prior red-team row; inspect stored evidence before retrying' });
    expect(io.readRedTeamStatus).toHaveBeenCalledWith({ pr, repo, head });
    for (const hook of ['runLoop', 'runExtraSeats', 'runRedTeam', 'runRedTeamGate', 'redTeamStatus', 'report']) expect(io[hook]).not.toHaveBeenCalled();
    expect(io.releaseLane).toHaveBeenCalledOnce(); expect(io.unclaim).toHaveBeenCalledOnce();
  });
  const cleanRow = { dispatchKind: 'review-seat', seat: 'red-team', status: 'ok', pr, repo, rev: head };
  it.each(['error', 'skipped', 'disabled', 'not-owed', null])('refuses a finished non-recoverable result %s without running any seats', prior => {
    const io = fakeIo({ readRedTeamStatus: vi.fn(() => ({ status: 'finished',
      result: { status: prior } })), readRedTeamRecords: () => [cleanRow] });
    const out = runReviewJob({ pr, repo, redTeamOnly: true, redTeamMode: 'resume' }, io);
    expect(out).toMatchObject({ outcome: 'red-team-not-owed', reason: `prior result ${prior ?? 'unknown'}; not re-run` });
    expect(io.readRedTeamStatus).toHaveBeenCalledWith({ pr, repo, head });
    for (const hook of ['runLoop', 'runExtraSeats', 'runRedTeam', 'runRedTeamGate', 'redTeamStatus', 'report']) expect(io[hook]).not.toHaveBeenCalled();
    expect(io.releaseLane).toHaveBeenCalledOnce(); expect(io.unclaim).toHaveBeenCalledOnce();
  });
  it.each([null, { status: 'queued', result: 'ran' }, { status: 'running', result: 'resumed' },
    { status: 'unknown', result: 'ran' }, { status: 'finished', result: 'unknown' }])(
    'refuses unfinished or unknown resume status %j despite verified evidence', status => {
      const io = fakeIo({ readRedTeamStatus: () => status, readRedTeamRecords: () => [cleanRow] });
      expect(runReviewJob({ pr, repo, redTeamOnly: true, redTeamMode: 'resume' }, io).outcome).toBe('red-team-not-owed');
      for (const hook of ['recordRedTeamQueued', 'reserveFreshRedTeamAttempt', 'runRedTeam', 'runRedTeamGate', 'redTeamStatus']) {
        expect(io[hook]).not.toHaveBeenCalled();
      }
      expect(io.releaseLane).toHaveBeenCalledOnce(); expect(io.unclaim).toHaveBeenCalledOnce();
    });
  it.each(['ran', { status: 'ran', comment: 'error' }, 'resumed', { status: 'resumed', comment: 'error' }])('resumes both production result shapes %j with a clean stored row', result => {
    const io = fakeIo({ readRedTeamStatus: () => ({ status: 'finished', result }), readRedTeamRecords: () => [cleanRow] });
    expect(runReviewJob({ pr, repo, redTeamOnly: true, redTeamMode: 'resume' }, io).outcome).toBe('red-team-only');
    expect(io.runRedTeam).toHaveBeenCalledOnce();
    expect(io.runRedTeam).toHaveBeenCalledWith({ pr, repo, lanePath: '/lanes/lane-7', loopPayload: payload(), slug: `review-${pr}`, redTeamMode: 'resume' });
  });
  it.each(['error', { status: 'error' }, { status: 'ran', comment: 'posted' }, { status: 'ran', comment: { status: 'posted' } },
    { status: 'resumed', comment: 'posted' }, { status: 'resumed', comment: { status: 'posted' } }])('refuses resume result %j with zero red-team calls', result => {
    const io = fakeIo({ readRedTeamStatus: () => ({ status: 'finished', result }), readRedTeamRecords: () => [cleanRow] });
    expect(runReviewJob({ pr, repo, redTeamOnly: true, redTeamMode: 'resume' }, io).outcome).toBe('red-team-not-owed');
    expect(io.runRedTeam).not.toHaveBeenCalled(); expect(io.redTeamStatus).not.toHaveBeenCalled();
  });
  it.each(['ran', 'resumed'].flatMap(result =>
    ['missing', 'error-row', 'wrong-head', 'wrong-repo', 'unreadable', 'malformed'].map(kind => ({ result, kind }))))('refuses $result resume on $kind scorecards with zero red-team calls', ({ result, kind }) => {
    const io = fakeIo({ readRedTeamStatus: () => ({ status: 'finished', result }),
      readRedTeamRecords: () => {
        if (kind === 'unreadable') throw Error('unreadable');
        if (kind === 'malformed') return null;
        return kind === 'missing' ? [] : [{ ...cleanRow,
          ...(kind === 'error-row' ? { status: 'error' } : {}),
          ...(kind === 'wrong-head' ? { rev: 'b'.repeat(40) } : {}),
          ...(kind === 'wrong-repo' ? { repo: 'other/repo' } : {}) }];
      } });
    expect(runReviewJob({ pr, repo, redTeamOnly: true, redTeamMode: 'resume' }, io).outcome).toBe('red-team-not-owed');
    expect(io.runRedTeam).not.toHaveBeenCalled(); expect(io.redTeamStatus).not.toHaveBeenCalled();
  });
  it.each(['verified', 'cap', 'oversized-cap', 'inFlight', 'queued', 'unreadable', 'unreadable-attempts'])('re-reads and refuses fresh mode on %s evidence with zero red-team calls', kind => {
    const io = fakeIo({ readRedTeamRecords: () => {
      if (kind === 'unreadable') throw Error('unreadable');
      if (kind === 'verified') return [cleanRow];
      return [];
    }, readRedTeamRecoveryEvidence: () => ({ [kind]: true }),
      ...(['cap', 'oversized-cap', 'unreadable-attempts'].includes(kind) ? { readFreshRedTeamAttempts: () => {
        if (kind === 'unreadable-attempts') throw Error('unreadable');
        return Array.from({ length: kind === 'cap' ? 2 : 1000 }, () => ({ at: 1, pid: 42 }));
      } } : {}) });
    expect(runReviewJob({ pr, repo, redTeamOnly: true, redTeamMode: 'fresh' }, io).outcome).toBe('red-team-not-owed');
    expect(io.readRedTeamRecords).toHaveBeenCalledOnce(); expect(io.readRedTeamStatus).toHaveBeenCalledWith({ pr, repo, head });
    expect(io.runRedTeam).not.toHaveBeenCalled(); expect(io.redTeamStatus).not.toHaveBeenCalled();
  });
  it('refuses fresh recovery within persisted cooldown without a model call', () => {
    const io = fakeIo({ readRedTeamStatus: () => ({ status: 'finished', updatedAtMs: 999, result: { status: 'skipped' } }) });
    expect(runReviewJob({ pr, repo, redTeamOnly: true, redTeamMode: 'fresh' }, io)).toMatchObject({ outcome: 'red-team-not-owed', reason: 'retry cooldown active' });
    expect(io.runRedTeam).not.toHaveBeenCalled(); expect(io.recordRedTeamQueued).not.toHaveBeenCalled();
  });
  it('permits one failed seat row below the fresh cap', () => {
    const io = fakeIo({ readRedTeamRecords: () => [{ ...cleanRow, status: 'error' }] });
    expect(runReviewJob({ pr, repo, redTeamOnly: true, redTeamMode: 'fresh' }, io).outcome).toBe('red-team-only');
    expect(io.runRedTeam).toHaveBeenCalledOnce();
  });
  it('admits only two of four fresh recoveries with unattested ok rows and persistently failing comments', () => {
    const rows = [];
    let now = 1_000, status = null;
    const io = fakeIo({ attest: false, now: () => now, readRedTeamRecords: () => rows,
      readRedTeamStatus: () => status,
      redTeamStatus: input => { status = { ...input, updatedAtMs: now }; },
      runRedTeam: vi.fn(() => {
        rows.push({ ...cleanRow }); // No runId: a clean child does not establish resume provenance.
        return { status: 'ran', comment: { status: 'error' } };
      }) });
    for (let i = 0; i < 4; i++, now += 1_800_000) {
      const [decision] = planRedTeamOnSkip({ repo,
        refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }],
        rawPrs: [{ number: pr, headRefOid: head, comments: [] }],
        readEvidence: () => ({ loopPayload: payload() }), readStatus: () => status,
        readRecoveryRows: input => redTeamRecoveryRows(rows, { ...input, env: io.env }),
        now, lastDispatch: new Map(), setting: { enabled: true, retryCooldownMin: 30, maxFreshPerHead: 2 } });
      const out = runReviewJob({ pr, repo, redTeamOnly: true, redTeamMode: 'fresh' }, io);
      if (i < 2) {
        expect(decision).toMatchObject({ action: 'dispatch', mode: 'fresh' });
        expect(out.outcome).toBe('red-team-only');
      } else {
        expect(decision).toMatchObject({ action: 'skip', why: 'fresh attempts exhausted for head' });
        expect(out).toMatchObject({ outcome: 'red-team-not-owed', reason: 'fresh attempts exhausted for head' });
      }
    }
    expect(io.runRedTeam).toHaveBeenCalledTimes(2);
    expect(readFreshRedTeamAttempts({ repo, pr, head, env: io.env })).toHaveLength(2);
  });
  it('refuses an exhausted reservation after a stale below-cap snapshot with zero red-team calls', () => {
    const io = fakeIo({ reserveFreshRedTeamAttempt: vi.fn(() => null) });
    expect(runReviewJob({ pr, repo, redTeamOnly: true, redTeamMode: 'fresh' }, io))
      .toMatchObject({ outcome: 'red-team-not-owed', reason: 'fresh attempts exhausted for head' });
    expect(io.runRedTeam).not.toHaveBeenCalled();
    expect(io.recordRedTeamQueued).not.toHaveBeenCalled();
    expect(io.releaseLane).toHaveBeenCalledOnce();
    expect(io.unclaim).toHaveBeenCalledOnce();
  });
  it.each(['write-failure', 'missing-reservation'])('refuses %s before queued status with zero red-team calls', kind => {
    const io = fakeIo({ reserveFreshRedTeamAttempt: vi.fn(() => {
      if (kind === 'write-failure') throw Error('disk full');
    }) });
    expect(runReviewJob({ pr, repo, redTeamOnly: true, redTeamMode: 'fresh' }, io))
      .toMatchObject({ outcome: 'red-team-not-owed', reason: 'fresh attempt could not be recorded' });
    expect(io.runRedTeam).not.toHaveBeenCalled();
    expect(io.recordRedTeamQueued).not.toHaveBeenCalled();
    expect(io.releaseLane).toHaveBeenCalledOnce();
    expect(io.unclaim).toHaveBeenCalledOnce();
  });
  it('persists admission while holding the job slot before queued status, even if no child row is written', () => {
    const io = fakeIo({ recordRedTeamQueued: vi.fn(() => {
      expect(io.unclaim).not.toHaveBeenCalled();
      expect(io.releaseLane).not.toHaveBeenCalled();
      expect(readFreshRedTeamAttempts({ repo, pr, head, env: io.env })).toHaveLength(1);
      throw Error('interrupted before child');
    }) });
    runReviewJob({ pr, repo, redTeamOnly: true, redTeamMode: 'fresh' }, io);
    expect(io.runRedTeam).not.toHaveBeenCalled();
    expect(redTeamRecoveryRows([], { repo, pr, head, env: io.env }).freshAttempts).toBe(1);
  });
  it('resume admission never writes the fresh attempt files', () => {
    const io = fakeIo({ readRedTeamStatus: () => ({ status: 'finished', result: 'ran' }),
      readRedTeamRecords: () => [cleanRow] });
    expect(runReviewJob({ pr, repo, redTeamOnly: true, redTeamMode: 'resume' }, io).outcome).toBe('red-team-only');
    expect(io.reserveFreshRedTeamAttempt).not.toHaveBeenCalled();
    expect(readFreshRedTeamAttempts({ repo, pr, head, env: io.env })).toEqual([]);
  });
  // Only the #5762 prefix was supplied in the incident; pad the fixture to a full head identity.
  it.each([[5762, '9def7150b' + '0'.repeat(31)], [5530, '1788bc6c54e1578f9828c8117418466f198e1b8c']])('recovers live #%s skipped resume with an unattested ok row as fresh', (pr, head) => {
    const loopPayload = payload(); loopPayload.findings.read.netBasis.rev = head;
    const status = { status: 'finished', skipCardOnly: true, result: { status: 'skipped', reason: 'resume-only: no clean prior red-team row — no call launched' } };
    const rows = [{ ...cleanRow, pr, rev: head }];
    const io = fakeIo({ attest: false, readRedTeamStatus: () => status, readRedTeamRecords: () => rows,
      readRedTeamOnlyPayload: () => ({ head, loopPayload }) });
    // The live review-pr did not finish; even an otherwise matching attestation cannot authorize resume.
    const incomplete = provenanceRun({ env: io.env, rows }); incomplete.cursor = 0;
    writeRun(incomplete, io.env.OPERATION_RUNS_DIR);
    expect(readFreshRedTeamAttempts({ repo, pr, head, env: io.env })).toEqual([]);
    const [decision] = planRedTeamOnSkip({ repo, refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }],
      rawPrs: [{ number: pr, headRefOid: head, comments: [] }], readEvidence: () => ({ loopPayload, recorded: true }),
      readStatus: () => status, readRecoveryRows: input => redTeamRecoveryRows(rows, { ...input, env: io.env }),
      now: 2_000_000, lastDispatch: new Map(), setting: { enabled: true, retryCooldownMin: 30, maxFreshPerHead: 2 } });
    expect(decision).toMatchObject({ action: 'dispatch', mode: 'fresh' });
    expect(runReviewJob({ pr, repo, redTeamOnly: true, redTeamMode: decision.mode }, io).outcome).toBe('red-team-only');
    expect(io.runRedTeam).toHaveBeenCalledOnce();
    expect(io.runRedTeam.mock.calls[0][0].redTeamMode).toBe('fresh');
    expect(io.reserveFreshRedTeamAttempt).toHaveBeenCalledOnce();
    expect(readFreshRedTeamAttempts({ repo, pr, head, env: io.env })).toHaveLength(1);
    expect(redTeamRunnerArgs({ pr, repo, lanePath: '/lane', loopFile: '/loop', redTeamMode: decision.mode })).not.toContain('--resume-only');
  });
  it.each(['row', 'error-row', 'status', 'queued', 'unreadable'])('retains prior-pass fresh refusal on %s evidence with zero red-team calls', kind => {
    const io = fakeIo({ readRedTeamRecords: vi.fn(() => {
      if (kind === 'unreadable') throw Error('unreadable');
      return kind.endsWith('row') ? [{ ...cleanRow, status: kind === 'error-row' ? 'error' : 'ok' }] : [];
    }), readRedTeamStatus: vi.fn(() => ['status', 'queued'].includes(kind) ? { status: kind === 'queued' ? 'queued' : 'finished', result: 'ran' } : null) });
    expect(runReviewJob({ pr, repo, redTeamOnly: true, redTeamMode: 'fresh' }, io).outcome).toBe('red-team-not-owed');
    expect(io.readRedTeamRecords).toHaveBeenCalledOnce(); expect(io.readRedTeamStatus).toHaveBeenCalledWith({ pr, repo, head });
    expect(io.runRedTeam).not.toHaveBeenCalled(); expect(io.redTeamStatus).not.toHaveBeenCalled();
  });
  it('fails closed on an unreadable head status without running the red team', () => {
    const io = fakeIo({ readRedTeamStatus: () => { throw Error('unreadable'); } });
    expect(runReviewJob({ pr, repo, redTeamOnly: true }, io).outcome).toBe('blocked-on-infra');
    expect(io.runRedTeam).not.toHaveBeenCalled(); expect(io.redTeamStatus).not.toHaveBeenCalled();
    expect(io.releaseLane).toHaveBeenCalledOnce(); expect(io.unclaim).toHaveBeenCalledOnce();
  });
  it.each(['mismatched', 'missing', 'not-owed'])('refuses %s evidence without running any seats', kind => {
    const loopPayload = payload();
    if (kind === 'mismatched') loopPayload.findings.read.netBasis.rev = 'b'.repeat(40);
    if (kind === 'not-owed') loopPayload.verdict.verdict = 'changes';
    const io = fakeIo({ readRedTeamOnlyPayload: () => ({ head, loopPayload: kind === 'missing' ? null : loopPayload }) });
    const out = runReviewJob({ pr, repo, redTeamOnly: true }, io);
    expect(out.outcome).toBe('red-team-not-owed'); expect(out.reason).toBeTruthy();
    for (const hook of ['runLoop', 'runExtraSeats', 'runRedTeam', 'runRedTeamGate', 'redTeamStatus', 'report']) expect(io[hook]).not.toHaveBeenCalled();
    expect(io.releaseLane).toHaveBeenCalledOnce(); expect(io.unclaim).toHaveBeenCalledOnce();
  });
  it('fails closed on unreadable stored evidence and releases its lane', () => {
    const io = fakeIo({ readRedTeamOnlyPayload: () => { throw Error('unreadable'); } });
    expect(runReviewJob({ pr, repo, redTeamOnly: true }, io).outcome).toBe('blocked-on-infra');
    expect(io.runRedTeam).not.toHaveBeenCalled(); expect(io.report).not.toHaveBeenCalled();
    expect(io.releaseLane).toHaveBeenCalledOnce();
  });
  it('still refuses a live job before acquiring a lane', () => {
    const io = fakeIo({ claim: () => ({ ok: false, heldBy: 99 }) });
    expect(runReviewJob({ pr, repo, redTeamOnly: true }, io).outcome).toBe('refused-live-job');
    expect(io.acquireLane).not.toHaveBeenCalled(); expect(io.runRedTeam).not.toHaveBeenCalled();
  });
});

describe('red-team-only dispatch', () => {
  function withDispatch(run) {
    const dir = mkdtempSync(join(tmpdir(), 'review-red-team-only-'));
    const options = { pr, repo, redTeamOnly: true, root: '/daemon', dir,
      checkStaleness: () => ({ fresh: true, behind: 0 }), readCompletion: () => null,
      resolveSettingsEnv: () => ({}), ciGate: vi.fn(() => ({ allowed: true })), spawnJob: vi.fn(() => 4242) };
    try { run(options); } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  it.each(['fresh', 'resume'])('passes --red-team-only=%s and preferred lane after CI admission', redTeamMode => withDispatch(options => {
    const out = dispatchReviewJob({ ...options, redTeamMode, preferLane: 7 });
    expect(out.jobPid).toBe(4242); expect(options.ciGate).toHaveBeenCalledOnce();
    expect(options.spawnJob.mock.calls[0][0].argv).toEqual(expect.arrayContaining(['run', `--pr=${pr}`, `--repo=${repo}`, `--red-team-only=${redTeamMode}`, '--prefer-lane=7']));
  }));
  it.each(['fresh', 'resume'])('refuses a denying CI gate in %s mode without spawning', redTeamMode => withDispatch(options => {
    const ci = { allowed: false, headSha: head, reason: 'required-checks-not-successful' };
    options.ciGate.mockReturnValue(ci);
    const out = dispatchReviewJob({ ...options, redTeamMode });
    expect(options.ciGate).toHaveBeenCalledOnce();
    expect(options.ciGate).toHaveBeenCalledWith({ repo, pr, policy: expect.any(Object) });
    expect(out).toMatchObject({ pr, repo, headSha: head, ci });
    expect(out.skipped).toContain('required-checks-not-successful');
    expect(options.spawnJob).not.toHaveBeenCalled();
  }));
  it('still skips live-job with the same slug and record', () => withDispatch(options => {
    writeJobRecord({ slug: `review-${pr}`, pr, repo, pid: 99, cwd: '/daemon', startedAt: new Date().toISOString() }, options.dir);
    expect(dispatchReviewJob({ ...options, isAlive: () => true }).skipped).toBe('live-job');
    expect(options.spawnJob).not.toHaveBeenCalled(); expect(options.ciGate).not.toHaveBeenCalled();
  }));
  it('retains lane cool-off', () => withDispatch(options => {
    expect(dispatchReviewJob({ ...options, now: 1_000_000,
      readCompletion: () => ({ status: 'done', outcome: 'blocked-on-infra', label: 'lane-deferrals:5', updatedAt: new Date(999_000).toISOString() }) }).skipped).toBe('lane-cooloff');
    expect(options.spawnJob).not.toHaveBeenCalled();
  }));
});


describe('red-team child resume enforcement', () => {
  it.each([
    ['fresh', []],
    ['resume', ['--resume-only']],
  ])('builds exact child argv for %s mode', (redTeamMode, modeArgs) => {
    const loopFile = `review-${pr}.red-team.loop.json`;
    expect(redTeamRunnerArgs({ pr, repo, lanePath: '/lanes/lane-7', loopFile, redTeamMode })).toEqual([
      'scripts/operations/review-extra-seats.mjs', 'red-team', `--pr=${pr}`, `--repo=${repo}`,
      '--lane=/lanes/lane-7', `--loop-json=${loopFile}`, ...modeArgs,
    ]);
  });
  it.each(['fresh', 'resume'])('forwards %s mode to the red-team-only job hook', redTeamMode => {
    const io = fakeIo({ readRedTeamStatus: () => redTeamMode === 'resume' ? { status: 'finished', result: 'ran' } : null,
      readRedTeamRecords: () => redTeamMode === 'resume' ? [{ dispatchKind: 'review-seat', seat: 'red-team', status: 'ok', pr, repo, rev: head }] : [],
      runRedTeam: vi.fn(() => ({ status: 'skipped' })) });
    const out = runReviewJob({ pr, repo, redTeamOnly: true, redTeamMode }, io);
    expect(out.outcome).toBe('red-team-only');
    expect(io.runRedTeam).toHaveBeenCalledOnce();
    expect(io.runRedTeam).toHaveBeenCalledWith({ pr, repo, lanePath: '/lanes/lane-7',
      loopPayload: payload(), slug: `review-${pr}`, redTeamMode });
    expect(io.runRedTeam).toHaveReturnedWith({ status: 'skipped' });
    expect(out.redTeam).toMatchObject({ status: 'skipped' });
  });
});
