// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync,
  renameSync, statSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { main, reapRemoteSlots, runWithRemoteDecision, resolveAdmissionPolicy, tryAcquireSlot,
  heldSlots, releaseOwnedSlot, DEFAULT_ADMISSION_CEILING_MS } from '../heavy-admission.mjs';
import { readForgeTelemetry } from '../forge-telemetry.mjs';
import { validateRunId } from '../remote-exec.mjs';
import { writeAllSync } from '../../lib/write-all-sync.mjs';

vi.mock('node:child_process', async (original) => ({ ...await original(), execFile: vi.fn() }));
vi.mock('../../lib/daemon-events.mjs', () => ({
  daemonEventsPath: () => join(process.env.TMPDIR, 'remote-reaper-no-event-directory', 'events.jsonl'),
}));
vi.mock('../../lib/write-all-sync.mjs', () => ({ writeAllSync: vi.fn() }));
vi.mock('../forge-telemetry.mjs', () => ({ readForgeTelemetry: vi.fn() }));

const roots = [];
const now = Date.parse('2026-10-31T12:00:00Z');
const oldAge = DEFAULT_ADMISSION_CEILING_MS + 600000;
const runId = '20261031t080000000z-ab12cd34';
const idle = { reachable: true, activeRuns: 0, procCount: 0 };
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});
function fixture() {
  const root = mkdtempSync(join(process.env.TMPDIR, 'remote-reaper-'));
  roots.push(root);
  const remoteRoot = join(root, 'remote');
  mkdirSync(remoteRoot);
  return { remoteRoot, clock: () => now, readForgeStatus: vi.fn(async () => idle),
    pidAlive: vi.fn(() => false), log: vi.fn(), appendEvent: vi.fn() };
}
function marker(f, { slot = 0, age = 120000, legacy = false, overrides = {} } = {}) {
  const file = join(f.remoteRoot, `slot-${slot}.unconfirmed`);
  writeFileSync(file, legacy ? 'remote termination unconfirmed\n' : JSON.stringify({
    v: 1, runId, slot, startedAt: new Date(now - age).toISOString(), pid: 12345, ...overrides,
  }) + '\n');
  utimesSync(file, new Date(now - age), new Date(now - age));
  return file;
}

describe('remote slot reaper', () => {
  it('skips all Forge IO when no execution markers exist', async () => {
    const f = fixture();
    expect(await reapRemoteSlots(f)).toEqual([]);
    expect(f.readForgeStatus).not.toHaveBeenCalled();
  });
  it('keeps a marker untouched when its slot lease has a live owner, even with another slot free', async () => {
    const f = fixture(); const file = marker(f, { slot: 1 });
    const original = readFileSync(file);
    const info = statSync(file);
    const options = { lockRoot: f.remoteRoot, cap: 2, slots: [1], owner: 'live-dispatcher',
      pid: process.pid, nowMs: now, nowIso: new Date(now).toISOString() };
    expect(tryAcquireSlot(options)).toMatchObject({ ok: true, slot: 1 });
    const lease = heldSlots(options);
    const beforeMarkerUnlink = vi.fn();
    expect(await reapRemoteSlots({ ...f, cap: 2, beforeMarkerUnlink })).toEqual([]);
    expect(statSync(file)).toMatchObject({ ino: info.ino, mtimeMs: info.mtimeMs, atimeMs: info.atimeMs });
    expect(readFileSync(file)).toEqual(original);
    expect(heldSlots(options)).toEqual(lease);
    expect(f.readForgeStatus).not.toHaveBeenCalled();
    expect(f.pidAlive).not.toHaveBeenCalled();
    expect(beforeMarkerUnlink).not.toHaveBeenCalled();
    expect(f.appendEvent).not.toHaveBeenCalled();
  });
  it('retains out-of-capacity markers for operator cleanup without scanning unbounded lease indices', async () => {
    const f = fixture(); const file = marker(f, { slot: Number.MAX_SAFE_INTEGER });
    expect(await reapRemoteSlots({ ...f, cap: 2 })).toEqual([]);
    expect(existsSync(file)).toBe(true);
    expect(f.readForgeStatus).not.toHaveBeenCalled();
    expect(f.log).toHaveBeenCalledWith(expect.stringContaining('outside configured capacity; inspect with reap-remote'));
    expect(heldSlots({ lockRoot: f.remoteRoot, cap: 2 })).toEqual([]);
  });
  it.each(['success', 'kept', 'seam throws', 'fresh status throws', 'event throws'])(
    'releases its slot lease after %s', async outcome => {
      const f = fixture(); const file = marker(f, { slot: 1 });
      const options = { lockRoot: f.remoteRoot, cap: 2, slots: [1], owner: 'next-dispatcher',
        pid: process.pid, nowMs: now, nowIso: new Date(now).toISOString() };
      const observedLeases = [];
      const beforeMarkerUnlink = vi.fn(() => {
        observedLeases.push(heldSlots(options));
        if (outcome === 'kept') writeFileSync(file, 'replacement evidence');
        if (outcome === 'seam throws') throw new Error('injected seam failure');
      });
      if (outcome === 'fresh status throws') f.readForgeStatus.mockResolvedValueOnce(idle)
        .mockRejectedValueOnce(new Error('injected status failure'));
      if (outcome === 'event throws') f.appendEvent.mockRejectedValueOnce(new Error('injected event failure'));
      const cleared = ['success', 'event throws'].includes(outcome);
      expect(await reapRemoteSlots({ ...f, cap: 2, beforeMarkerUnlink })).toHaveLength(cleared ? 1 : 0);
      expect(beforeMarkerUnlink).toHaveBeenCalledTimes(1);
      expect(observedLeases).toEqual([[expect.objectContaining({ slot: 1,
        owner: expect.stringMatching(new RegExp(`^reaper-${process.pid}-[a-f0-9]+$`)), pid: process.pid })]]);
      expect(existsSync(file)).toBe(!cleared);
      expect(heldSlots(options)).toEqual([]);
      expect(tryAcquireSlot(options)).toMatchObject({ ok: true, slot: 1 });
      expect(releaseOwnedSlot({ ...options, fastSlots: 0 })).toEqual({ released: true, slot: 1 });
    },
  );
  it('blocks dispatcher acquisition between marker checks and unlink and through event emission', async () => {
    const f = fixture(); const file = marker(f, { slot: 1 });
    const options = { lockRoot: f.remoteRoot, cap: 2, slots: [1], owner: 'racing-dispatcher',
      pid: process.pid, nowMs: now, nowIso: new Date(now).toISOString() };
    const attempts = [];
    const contend = () => { attempts.push(tryAcquireSlot(options)); };
    const beforeMarkerUnlink = vi.fn(async () => { contend(); });
    f.readForgeStatus.mockResolvedValueOnce(idle).mockImplementationOnce(async () => {
      // This await is after the identity check and before the final pathname unlink.
      contend();
      return idle;
    });
    f.appendEvent.mockImplementationOnce(async () => {
      expect(existsSync(file)).toBe(false);
      contend();
    });
    expect(await reapRemoteSlots({ ...f, cap: 2, beforeMarkerUnlink })).toEqual([
      { slot: 1, runId, evidence: expect.any(String), cleared: true },
    ]);
    expect(beforeMarkerUnlink).toHaveBeenCalledTimes(1);
    expect(attempts).toHaveLength(3);
    expect(attempts).toEqual(Array.from({ length: 3 }, () => expect.objectContaining({ ok: false, slot: null,
      heldBy: [{ slot: 1, owner: expect.stringMatching(/^reaper-/) }] })));
    expect(heldSlots(options)).toEqual([]);
    expect(tryAcquireSlot(options)).toMatchObject({ ok: true, slot: 1 });
    releaseOwnedSlot({ ...options, fastSlots: 0 });
  });
  it('clears legacy-old and new-dead-pid markers with idle Forge evidence and emits events', async () => {
    const f = fixture();
    const legacy = marker(f, { age: oldAge, legacy: true });
    const current = marker(f, { slot: 1 });
    const results = await reapRemoteSlots(f);
    expect(results).toEqual([
      { slot: 0, runId: null, evidence: expect.stringContaining('forge-idle activeRuns=0 procs=0 age='), cleared: true },
      { slot: 1, runId, evidence: expect.any(String), cleared: true },
    ]);
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(current)).toBe(false);
    expect(f.log).toHaveBeenCalledTimes(2);
    expect(f.appendEvent.mock.calls.map(([event]) => event)).toEqual(results.map(({ cleared, ...detail }) => ({
      kind: 'remote-slot-reaped', detail,
    })));
  });
  it.each([
    ['active runs', { ...idle, activeRuns: 1 }],
    ['processes', { ...idle, procCount: 1 }],
    ['unreachable', { reachable: false }],
    ['incomplete', { reachable: true, activeRuns: 0 }],
    ['unparseable', { ...idle, procCount: '0' }],
    ['negative process count', { ...idle, procCount: -1 }],
    ['negative active runs', { ...idle, activeRuns: -1 }],
  ])('keeps markers and emits nothing when Forge status is %s', async (_, status) => {
    const f = fixture(); const file = marker(f, { age: oldAge });
    f.readForgeStatus.mockResolvedValue(status);
    expect(await reapRemoteSlots(f)).toEqual([]);
    expect(existsSync(file)).toBe(true);
    expect(f.appendEvent).not.toHaveBeenCalled();
  });
  it.each([true, false])('busy Forge with only young run processes retains an aged marker after prepare handoff (legacy=%s)', async legacy => {
    const f = fixture(); const file = marker(f, { age: oldAge, legacy });
    // The run process just started after transfer from prepare; neither phase's age is evidence.
    vi.mocked(execFile).mockImplementation((file, args, options, callback) => {
      callback(null, 'node /srv/forge-exec-run.mjs run\n');
    });
    vi.mocked(readForgeTelemetry).mockResolvedValue({ activeRuns: 1 });
    expect(await reapRemoteSlots({ ...f, readForgeStatus: undefined })).toEqual([]);
    expect(existsSync(file)).toBe(true);
    expect(f.appendEvent).not.toHaveBeenCalled();
  });
  it.each([true, false])('busy Forge retains a marker below maxRun plus margin (live pid=%s)', async live => {
    const f = fixture(); const file = marker(f, { age: oldAge - 1 });
    f.pidAlive.mockReturnValue(live);
    f.readForgeStatus.mockResolvedValue({ reachable: true, activeRuns: 3, procCount: 1 });
    expect(await reapRemoteSlots(f)).toEqual([]);
    expect(existsSync(file)).toBe(true);
    expect(f.appendEvent).not.toHaveBeenCalled();
  });
  it('swallows status-reader errors and fails closed', async () => {
    const f = fixture(); const file = marker(f);
    f.readForgeStatus.mockRejectedValue(new Error('unreachable'));
    expect(await reapRemoteSlots(f)).toEqual([]);
    expect(existsSync(file)).toBe(true);
    expect(f.log).toHaveBeenCalled();
  });
  it.each([
    ['busy runs', { ...idle, activeRuns: 1 }],
    ['busy processes', { ...idle, procCount: 1 }],
    ['unreachable', { reachable: false }],
    ['reader throws', null],
  ])('keeps other-host markers when Forge is idle but their host is %s', async (_, status) => {
    const f = fixture();
    const forge = marker(f, { legacy: true, age: oldAge });
    const other = marker(f, { slot: 1, age: oldAge, overrides: { host: 'other' } });
    const another = marker(f, { slot: 2, age: oldAge, overrides: { host: 'other' } });
    f.readForgeStatus.mockImplementation(async ({ host }) => {
      if (host === 'forge') return idle;
      if (status === null) throw new Error('unreachable');
      return status;
    });
    expect(await reapRemoteSlots(f)).toEqual([
      { slot: 0, runId: null, evidence: expect.any(String), cleared: true },
    ]);
    expect(existsSync(forge)).toBe(false);
    expect(existsSync(other)).toBe(true);
    expect(existsSync(another)).toBe(true);
    expect(f.readForgeStatus.mock.calls).toEqual([[{ host: 'forge' }], [{ host: 'forge' }], [{ host: 'other' }]]);
    expect(f.appendEvent).toHaveBeenCalledTimes(1);
  });
  it('caches the first sample per host but refreshes before each unlink, using Forge for hostless markers', async () => {
    const f = fixture();
    const text = marker(f, { legacy: true, age: oldAge });
    const json = marker(f, { slot: 1, age: oldAge });
    const other = marker(f, { slot: 2, overrides: { host: 'other' } });
    const another = marker(f, { slot: 3, overrides: { host: 'other' } });
    f.readForgeStatus.mockImplementation(async ({ host }) => host === 'other' ? idle : { ...idle, activeRuns: 1 });
    expect(await reapRemoteSlots(f)).toEqual([2, 3].map(slot => ({
      slot, runId, evidence: expect.stringContaining('other-idle activeRuns=0 procs=0'), cleared: true,
    })));
    expect(existsSync(text)).toBe(true);
    expect(existsSync(json)).toBe(true);
    expect(existsSync(other)).toBe(false);
    expect(existsSync(another)).toBe(false);
    expect(f.readForgeStatus.mock.calls).toEqual([
      [{ host: 'forge' }], [{ host: 'other' }], [{ host: 'other' }], [{ host: 'other' }],
    ]);
  });
  it.each(['', '-oProxyCommand=bad', 'forge;bad', 'forge\n', null, 123, ['forge'], {}])(
    'retains invalid host %j without reading status or issuing SSH', async host => {
      const f = fixture(); const file = marker(f, { age: oldAge, overrides: { host } });
      expect(await reapRemoteSlots(f)).toEqual([]);
      expect(await reapRemoteSlots({ ...f, readForgeStatus: undefined })).toEqual([]);
      expect(existsSync(file)).toBe(true);
      expect(f.readForgeStatus).not.toHaveBeenCalled();
      expect(execFile).not.toHaveBeenCalled();
      expect(readForgeTelemetry).not.toHaveBeenCalled();
      expect(f.appendEvent).not.toHaveBeenCalled();
    },
  );
  it.each([
    ['new too young', { age: 119999 }],
    ['legacy too young', { legacy: true, age: oldAge - 1 }],
    ['future timestamp', { age: -1 }],
    ['invalid timestamp', { overrides: { startedAt: 'invalid' } }],
    ['invalid pid', { overrides: { pid: -1 } }],
    ['unknown version', { overrides: { v: 2 } }],
  ])('retains %s', async (_, options) => {
    const f = fixture(); const file = marker(f, options);
    expect(await reapRemoteSlots(f)).toEqual([]);
    expect(existsSync(file)).toBe(true);
  });
  it('keeps malformed JSON and oversized markers for operator inspection', async () => {
    const f = fixture(); const file = marker(f, { age: oldAge });
    writeFileSync(file, '{broken');
    expect(await reapRemoteSlots(f)).toEqual([]);
    writeFileSync(file, 'x'.repeat(4097));
    utimesSync(file, new Date(now - oldAge), new Date(now - oldAge));
    expect(await reapRemoteSlots(f)).toEqual([]);
    expect(existsSync(file)).toBe(true);
    expect(f.log).toHaveBeenCalledWith(expect.stringContaining('operator cleanup'));
  });
  it.each([
    '', 'garbage', 'remote termination unconfirmed extra', 'REMOTE termination unconfirmed',
    '"remote termination unconfirmed"', '{broken', '[broken', 'null', 'true', '1', '[]', '{}',
  ])('never reaps unparseable aged marker text %j', async text => {
    const f = fixture(); const file = marker(f, { age: oldAge });
    writeFileSync(file, text);
    utimesSync(file, new Date(now - oldAge), new Date(now - oldAge));
    expect(await reapRemoteSlots(f)).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe(text);
    expect(f.appendEvent).not.toHaveBeenCalled();
  });
  it('accepts only the exact trimmed legacy string', async () => {
    const f = fixture(); const file = marker(f, { age: oldAge });
    writeFileSync(file, ' \tremote termination unconfirmed\n ');
    utimesSync(file, new Date(now - oldAge), new Date(now - oldAge));
    expect(await reapRemoteSlots(f)).toEqual([
      { slot: 0, runId: null, evidence: expect.any(String), cleared: true },
    ]);
    expect(existsSync(file)).toBe(false);
  });
  it.each(['content', 'inode', 'mtime', 'vanished'])('does not unlink or emit an event when marker %s changes before unlink', async change => {
    const f = fixture(); const file = marker(f);
    const original = readFileSync(file, 'utf8');
    const info = statSync(file);
    tryAcquireSlot({ lockRoot: f.remoteRoot, cap: 1, owner: 'old', nowMs: now - oldAge,
      nowIso: new Date(now - oldAge).toISOString(), pid: process.pid });
    const replacement = original.replace(runId, runId.slice(0, -1) + '5');
    const beforeMarkerUnlink = vi.fn(({ file: inspected, slot }) => {
      expect(inspected).toBe(file);
      expect(slot).toBe(0);
      if (change === 'vanished') unlinkSync(file);
      else if (change === 'content') {
        writeFileSync(file, replacement);
        utimesSync(file, info.atime, info.mtime);
      } else if (change === 'inode') {
        // Same bytes and mtime, but a different owner's inode.
        const next = join(f.remoteRoot, 'replacement');
        writeFileSync(next, original);
        utimesSync(next, info.atime, info.mtime);
        renameSync(next, file);
      } else utimesSync(file, new Date(now), new Date(now));
    });
    expect(await reapRemoteSlots({ ...f, beforeMarkerUnlink })).toEqual([]);
    expect(beforeMarkerUnlink).toHaveBeenCalledTimes(1);
    expect(f.readForgeStatus).toHaveBeenCalledTimes(1);
    if (change === 'vanished') expect(existsSync(file)).toBe(false);
    else expect(readFileSync(file, 'utf8')).toBe(change === 'content' ? replacement : original);
    expect(heldSlots({ lockRoot: f.remoteRoot, cap: 1 })).toHaveLength(0);
    expect(f.appendEvent).not.toHaveBeenCalled();
    expect(f.log).not.toHaveBeenCalledWith(expect.stringContaining('reaped ('));
  });
  it('preserves a new marker replacing the inspected marker before unlink', async () => {
    const f = fixture(); const file = marker(f);
    const beforeMarkerUnlink = vi.fn(() => {
      const next = join(f.remoteRoot, 'replacement');
      writeFileSync(next, JSON.stringify({ v: 1, runId: 'replacement-run', slot: 0,
        startedAt: new Date(now).toISOString(), pid: process.pid }) + '\n');
      renameSync(next, file);
    });
    expect(await reapRemoteSlots({ ...f, beforeMarkerUnlink })).toEqual([]);
    expect(beforeMarkerUnlink).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(file, 'utf8')).runId).toBe('replacement-run');
    expect(f.appendEvent).not.toHaveBeenCalled();
  });
  describe.each([true, false])('fresh host evidence (legacy=%s)', legacy => {
    it.each([
      ['busy runs', { ...idle, activeRuns: 1 }],
      ['busy processes', { ...idle, procCount: 1 }],
      ['unreachable', { reachable: false }],
      ['incomplete', { reachable: true, activeRuns: 0 }],
      ['unparseable', { ...idle, procCount: '0' }],
      ['negative count', { ...idle, activeRuns: -1 }],
      ['reader throws', null],
    ])('retains the marker and releases the reaper lease when status turns %s between first sample and unlink', async (_, status) => {
      const f = fixture();
      const host = legacy ? 'forge' : 'other';
      const file = marker(f, { age: oldAge, legacy, overrides: { host } });
      const original = readFileSync(file, 'utf8');
      tryAcquireSlot({ lockRoot: f.remoteRoot, cap: 1, owner: 'old', nowMs: now - oldAge,
        nowIso: new Date(now - oldAge).toISOString(), pid: process.pid });
      let changed = false;
      f.readForgeStatus.mockImplementation(async () => {
        if (!changed) return idle;
        if (status === null) throw new Error('status unavailable');
        return status;
      });
      const beforeMarkerUnlink = vi.fn(() => { changed = true; });
      expect(await reapRemoteSlots({ ...f, beforeMarkerUnlink })).toEqual([]);
      expect(beforeMarkerUnlink).toHaveBeenCalledTimes(1);
      expect(f.readForgeStatus.mock.calls).toEqual([[{ host }], [{ host }]]);
      expect(readFileSync(file, 'utf8')).toBe(original);
      expect(heldSlots({ lockRoot: f.remoteRoot, cap: 1 })).toHaveLength(0);
      expect(f.appendEvent).not.toHaveBeenCalled();
      expect(f.log).not.toHaveBeenCalledWith(expect.stringContaining('reaped ('));
    });
  });
  it('retains a replacement marker written during the fresh idle status read', async () => {
    const f = fixture(); const file = marker(f);
    const replacement = JSON.stringify({ v: 1, runId: 'replacement-run', slot: 0,
      startedAt: new Date(now).toISOString(), pid: process.pid }) + '\n';
    f.readForgeStatus.mockResolvedValueOnce(idle).mockImplementationOnce(async () => {
      const next = join(f.remoteRoot, 'replacement');
      writeFileSync(next, replacement);
      renameSync(next, file);
      return idle;
    });
    expect(await reapRemoteSlots(f)).toEqual([]);
    expect(f.readForgeStatus).toHaveBeenCalledTimes(2);
    expect(readFileSync(file, 'utf8')).toBe(replacement);
    expect(f.appendEvent).not.toHaveBeenCalled();
  });
  it.each([oldAge - 1, oldAge, oldAge * 100])('never reaps a live owner pid even with idle host evidence (age=%s)', async age => {
    const f = fixture(); f.pidAlive.mockReturnValue(true);
    const file = marker(f, { age });
    expect(await reapRemoteSlots(f)).toEqual([]);
    expect(existsSync(file)).toBe(true);
    expect(f.pidAlive).toHaveBeenCalledWith(12345);
    expect(f.appendEvent).not.toHaveBeenCalled();
  });
  it('defaults to real pid liveness and preserves a very old marker owned by this process', async () => {
    const f = fixture(); const file = marker(f, { age: oldAge * 100, overrides: { pid: process.pid } });
    expect(await reapRemoteSlots({ ...f, pidAlive: undefined })).toEqual([]);
    expect(existsSync(file)).toBe(true);
  });
  it('treats EPERM as alive and unknown pid-probe errors as insufficient evidence', async () => {
    const f = fixture(); const file = marker(f, { age: oldAge * 100 });
    const kill = vi.spyOn(process, 'kill');
    for (const code of ['EPERM', 'EIO']) {
      kill.mockImplementation(() => { throw Object.assign(new Error('probe failed'), { code }); });
      expect(await reapRemoteSlots({ ...f, pidAlive: undefined })).toEqual([]);
      expect(existsSync(file)).toBe(true);
    }
  });
  it.each([undefined, null, 0])('keeps very old markers when pid liveness is unknown (%s)', async alive => {
    const f = fixture(); const file = marker(f, { age: oldAge * 100 });
    f.pidAlive.mockReturnValue(alive);
    expect(await reapRemoteSlots(f)).toEqual([]);
    expect(existsSync(file)).toBe(true);
    expect(f.appendEvent).not.toHaveBeenCalled();
  });
  it('honors injected grace for a dead pid independently of the run ceiling and margin', async () => {
    const f = fixture();
    const file = marker(f, { age: 500 });
    expect(await reapRemoteSlots({ ...f, graceMs: 501, maxRunMs: 1000, marginMs: 200 })).toEqual([]);
    expect(existsSync(file)).toBe(true);
    expect(await reapRemoteSlots({ ...f, graceMs: 500, maxRunMs: 1000, marginMs: 200 })).toHaveLength(1);
  });
  it('honors injected run ceiling and margin for legacy markers without probing a pid', async () => {
    const f = fixture(); const file = marker(f, { age: 500, legacy: true });
    expect(await reapRemoteSlots({ ...f, maxRunMs: 301, marginMs: 200 })).toEqual([]);
    expect(existsSync(file)).toBe(true);
    expect(await reapRemoteSlots({ ...f, maxRunMs: 300, marginMs: 200 })).toHaveLength(1);
    expect(f.pidAlive).not.toHaveBeenCalled();
  });
  it('dry-run reports candidates without unlinking leases, logging clears or emitting events', async () => {
    const f = fixture(); const file = marker(f);
    tryAcquireSlot({ lockRoot: f.remoteRoot, cap: 1, owner: 'old', nowMs: now - oldAge,
      nowIso: new Date(now - oldAge).toISOString(), pid: process.pid });
    const leases = heldSlots({ lockRoot: f.remoteRoot, cap: 1 });
    expect(await reapRemoteSlots({ ...f, dryRun: true })).toEqual([
      { slot: 0, runId, evidence: expect.any(String), cleared: false },
    ]);
    expect(existsSync(file)).toBe(true);
    expect(heldSlots({ lockRoot: f.remoteRoot, cap: 1 })).toEqual(leases);
    expect(f.appendEvent).not.toHaveBeenCalled();
    expect(f.log).not.toHaveBeenCalled();
  });
  it('dry-run never creates a slot lease', async () => {
    const f = fixture(); marker(f);
    f.readForgeStatus.mockImplementation(async () => {
      expect(readdirSync(f.remoteRoot)).toEqual(['slot-0.unconfirmed']);
      return idle;
    });
    expect(await reapRemoteSlots({ ...f, dryRun: true })).toHaveLength(1);
    expect(readdirSync(f.remoteRoot)).toEqual(['slot-0.unconfirmed']);
  });
  it.each([true, false])('reclaims an expired lease and skips a held live lease (expired=%s)', async expired => {
    const f = fixture(); const file = marker(f);
    const at = expired ? now - oldAge : now;
    tryAcquireSlot({ lockRoot: f.remoteRoot, cap: 1, owner: 'lease-owner', nowMs: at,
      nowIso: new Date(at).toISOString(), pid: process.pid });
    expect(await reapRemoteSlots(f)).toHaveLength(expired ? 1 : 0);
    expect(existsSync(file)).toBe(!expired);
    expect(heldSlots({ lockRoot: f.remoteRoot, cap: 1 })).toHaveLength(expired ? 0 : 1);
  });
  it('reclaims and releases an unexpired lease held by a provably dead dispatcher', async () => {
    const f = fixture(); const file = marker(f);
    const options = { lockRoot: f.remoteRoot, cap: 1, owner: 'dead-dispatcher', pid: 12345,
      nowMs: now, nowIso: new Date(now).toISOString() };
    expect(tryAcquireSlot(options)).toMatchObject({ ok: true, slot: 0 });
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('dead dispatcher'), { code: 'ESRCH' });
    });
    expect(await reapRemoteSlots({ ...f, cap: 1 })).toHaveLength(1);
    expect(kill).toHaveBeenCalledWith(12345, 0);
    expect(existsSync(file)).toBe(false);
    expect(heldSlots(options)).toEqual([]);
  });
  it.each([
    ['', 0, true],
    ['', 1, false],
    ['node /srv/forge-exec-run.mjs run\nnode /srv/forge-exec-run.mjs finish\n', 4, false],
    ['node /srv/forge-exec-run.mjs prepare\n', 0, false],
    ['node /srv/forge-exec-run.mjs run\n', 0, false],
    ['node /srv/forge-exec-run.mjs finish\n', 0, false],
    ['node /srv/forge-exec-run.mjs run\ninvalid', 0, false],
    ['\n', 0, false],
    ['node /srv/forge-exec-run.mjs run\n\n', 0, false],
    ['ssh-error', 0, false],
    ['telemetry-error', 0, false],
    ['', '0', false],
    ['oversized-output', 0, false],
  ])('default status reader requires bounded SSH process listing and idle telemetry: %j', async (output, activeRuns, cleared) => {
      const f = fixture(); const file = marker(f, { age: oldAge });
      vi.mocked(execFile).mockImplementation((file, args, options, callback) => {
        expect(file).toBe('ssh');
        expect(args).toEqual(['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', 'forge',
          "set -o pipefail; ps -eo args= | { grep -E '[f]orge-exec-run.mjs (prepare|run|finish)$'; rc=$?; [ \"$rc\" -le 1 ]; }"]);
        expect(options).toMatchObject({ timeout: 8000, maxBuffer: 4096 });
        callback(['ssh-error', 'oversized-output'].includes(output) ? new Error('SSH failed or maxBuffer exceeded') : null, output);
      });
      vi.mocked(readForgeTelemetry).mockImplementation(async () => {
        if (output === 'telemetry-error') throw new Error('invalid telemetry');
        return { activeRuns };
      });
      const results = await reapRemoteSlots({ ...f, readForgeStatus: undefined });
      expect(readForgeTelemetry).toHaveBeenCalledWith({ host: 'forge' });
      expect(results).toHaveLength(cleared ? 1 : 0);
      expect(existsSync(file)).toBe(!cleared);
      expect(f.appendEvent.mock.calls).toEqual(results.map(({ cleared, ...detail }) => [{ kind: 'remote-slot-reaped', detail }]));
    },
  );
  it.each(['other', 'worker-1.example'])('default status reader uses marker host %s for both SSH and telemetry', async host => {
    const f = fixture(); const file = marker(f, { overrides: { host } });
    vi.mocked(execFile).mockImplementation((_file, _args, _options, callback) => callback(null, ''));
    vi.mocked(readForgeTelemetry).mockResolvedValue({ activeRuns: 0 });
    expect(await reapRemoteSlots({ ...f, readForgeStatus: undefined })).toHaveLength(1);
    expect(execFile).toHaveBeenCalledTimes(2);
    expect(vi.mocked(execFile).mock.calls[0][1][4]).toBe(host);
    expect(readForgeTelemetry).toHaveBeenCalledTimes(2);
    expect(readForgeTelemetry).toHaveBeenCalledWith({ host });
    expect(existsSync(file)).toBe(false);
  });
});

async function admission(f, remoteExec, host = 'forge') {
  const { easternTimestamp } = await import('../forge-exec-run.mjs');
  return runWithRemoteDecision({
    argv: ['npm', 'run', 'test:unit', '--', 'fixture.test.mjs'],
    cwd: 'fixture-checkout', env: {}, clock: f.clock,
    lockRoot: join(f.remoteRoot, '..', 'heavy'), log: f.log, readForgeStatus: f.readForgeStatus,
    policy: resolveAdmissionPolicy({ platform: { remote: { enabled: true, mode: 'always' } } }),
    readTelemetry: async () => ({ sampledAtET: easternTimestamp(now), cores: 8, loadPerCore: 0.1,
      memFreePct: 90, activeRuns: 0, recent: [] }),
    loadPerCore: () => 4, remoteExec, host,
  });
}

describe('remote admission markers', () => {
  it.each(['forge', 'other'])('writes one JSON line with a valid runId and dispatch host %s before execution', async host => {
    const f = fixture();
    const remoteExec = vi.fn(async options => {
      const raw = readFileSync(join(f.remoteRoot, 'slot-0.unconfirmed'), 'utf8');
      expect(raw.split('\n')).toHaveLength(2);
      const data = JSON.parse(raw);
      expect(options.host).toBe(host);
      expect(data).toEqual({ v: 1, runId: options.runId, slot: 0, host, startedAt: new Date(now).toISOString(), pid: process.pid });
      expect(data.runId).toMatch(/^20261031[a-z0-9]*-[a-f0-9]{8}$/);
      expect(validateRunId(data.runId)).toBe(true);
      return { mode: 'remote', code: 0 };
    });
    expect(await admission(f, remoteExec, host)).toEqual({ handled: true, exitCode: 0 });
    expect(remoteExec).toHaveBeenCalledTimes(1);
    expect(f.readForgeStatus).not.toHaveBeenCalled();
    expect(existsSync(join(f.remoteRoot, 'slot-0.unconfirmed'))).toBe(false);
  });
  it('reaps an old marker before scanning for the remote slot', async () => {
    const f = fixture(); marker(f, { legacy: true, age: oldAge });
    const remoteExec = vi.fn(async () => ({ mode: 'remote', code: 0 }));
    expect(await admission(f, remoteExec)).toEqual({ handled: true, exitCode: 0 });
    expect(f.readForgeStatus).toHaveBeenCalledTimes(2);
    expect(remoteExec).toHaveBeenCalledTimes(1);
    expect(f.log).toHaveBeenCalledWith(expect.stringContaining('slot-0 reaped'));
  });
  it('exit-124 local-rerun refusal still retains its JSON marker and lease', async () => {
    const f = fixture();
    expect(await admission(f, async () => ({ mode: 'unconfirmed' }))).toEqual({ handled: true, exitCode: 124 });
    expect(JSON.parse(readFileSync(join(f.remoteRoot, 'slot-0.unconfirmed'), 'utf8'))).toMatchObject({ v: 1, slot: 0 });
    expect(heldSlots({ lockRoot: f.remoteRoot, cap: 8 })).toHaveLength(1);
    expect(f.log).toHaveBeenCalledWith(expect.stringContaining('refusing local rerun (exit 124)'));
  });
  it('clears the exit-124 ambiguous-result marker once its local pid is dead, its lease expired and Forge is idle', async () => {
    const f = fixture();
    expect(await admission(f, async () => ({ mode: 'unconfirmed' }))).toEqual({ handled: true, exitCode: 124 });
    const file = join(f.remoteRoot, 'slot-0.unconfirmed');
    const persisted = JSON.parse(readFileSync(file, 'utf8'));
    expect(persisted).toMatchObject({ v: 1, pid: process.pid });
    f.pidAlive.mockReturnValue(false);
    const detail = { slot: 0, runId: persisted.runId, evidence: `forge-idle activeRuns=0 procs=0 age=${oldAge}ms` };
    expect(await reapRemoteSlots({ ...f, clock: () => now + oldAge })).toEqual([{ ...detail, cleared: true }]);
    expect(f.pidAlive).toHaveBeenCalledWith(persisted.pid);
    expect(existsSync(file)).toBe(false);
    expect(f.appendEvent.mock.calls).toEqual([[{ kind: 'remote-slot-reaped', detail }]]);
  });
});

describe('reap-remote CLI', () => {
  it.each([true, false])('uses the shared lock root and prints results (dry-run=%s)', async dryRun => {
    const f = fixture();
    const pool = join(f.remoteRoot, '..', 'pool');
    const root = join(pool, '.admission', 'remote');
    mkdirSync(root, { recursive: true });
    const file = marker({ ...f, remoteRoot: root }, { legacy: true, age: oldAge * 2 });
    // Use the wall clock for CLI age checks, while keeping the persisted marker deterministically old.
    utimesSync(file, new Date(Date.now() - oldAge * 2), new Date(Date.now() - oldAge * 2));
    vi.stubEnv('LANE_POOL_ROOT', pool);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await main(['reap-remote', ...(dryRun ? ['--dry-run'] : [])], { readForgeStatus: f.readForgeStatus });
    expect(writeAllSync).toHaveBeenCalledWith(1, expect.any(String));
    const result = JSON.parse(vi.mocked(writeAllSync).mock.calls.at(-1)[1]);
    expect(result).toEqual([{ slot: 0, runId: null, evidence: expect.any(String), cleared: !dryRun }]);
    expect(existsSync(file)).toBe(dryRun);
  });
});
