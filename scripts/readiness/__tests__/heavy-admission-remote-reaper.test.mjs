// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { main, reapRemoteSlots, runWithRemoteDecision, resolveAdmissionPolicy, tryAcquireSlot,
  heldSlots, DEFAULT_ADMISSION_CEILING_MS } from '../heavy-admission.mjs';
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
    ['invalid process age', { ...idle, activeRuns: 3, procCount: 1, procEtimesSec: [-1] }],
    ['incomplete process ages', { ...idle, activeRuns: 3, procCount: 2, procEtimesSec: [10] }],
  ])('keeps markers and emits nothing when Forge status is %s', async (_, status) => {
    const f = fixture(); const file = marker(f, { age: oldAge });
    f.readForgeStatus.mockResolvedValue(status);
    expect(await reapRemoteSlots(f)).toEqual([]);
    expect(existsSync(file)).toBe(true);
    expect(f.appendEvent).not.toHaveBeenCalled();
  });
  it.each([true, false])('busy Forge with only short processes clears an aged marker (legacy=%s)', async legacy => {
    const f = fixture(); const file = marker(f, { age: oldAge, legacy });
    f.readForgeStatus.mockResolvedValue({ reachable: true, activeRuns: 4, procCount: 2, procEtimesSec: [10, 60] });
    // New markers use startedAt, even if their filesystem timestamp is fresh.
    if (!legacy) utimesSync(file, new Date(now), new Date(now));
    const detail = { slot: 0, runId: legacy ? null : runId,
      evidence: `no-forge-proc-as-old-as-marker maxProcAgeSec=60 markerAgeSec=${oldAge / 1000}` };
    expect(await reapRemoteSlots(f)).toEqual([{ ...detail, cleared: true }]);
    expect(existsSync(file)).toBe(false);
    expect(f.appendEvent.mock.calls).toEqual([[{ kind: 'remote-slot-reaped', detail }]]);
  });
  it.each([oldAge / 1000, oldAge / 1000 - 300])('busy Forge keeps a marker when one process is old enough (%s seconds)', async age => {
    const f = fixture(); const file = marker(f, { age: oldAge });
    f.readForgeStatus.mockResolvedValue({ reachable: true, activeRuns: 4, procCount: 2, procEtimesSec: [10, age] });
    expect(await reapRemoteSlots(f)).toEqual([]);
    expect(existsSync(file)).toBe(true);
    expect(f.appendEvent).not.toHaveBeenCalled();
  });
  it.each([true, false])('busy Forge retains a marker below maxRun plus margin (live pid=%s)', async live => {
    const f = fixture(); const file = marker(f, { age: oldAge - 1 });
    f.pidAlive.mockReturnValue(live);
    f.readForgeStatus.mockResolvedValue({ reachable: true, activeRuns: 3, procCount: 1, procEtimesSec: [10] });
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
  it('keeps a live pid younger than maxRun plus margin, then clears at the ceiling', async () => {
    const f = fixture(); f.pidAlive.mockReturnValue(true);
    const file = marker(f, { age: oldAge - 1 });
    expect(await reapRemoteSlots(f)).toEqual([]);
    expect(existsSync(file)).toBe(true);
    marker(f, { age: oldAge });
    expect(await reapRemoteSlots(f)).toEqual([{ slot: 0, runId, evidence: expect.any(String), cleared: true }]);
  });
  it('defaults to real pid liveness and preserves a young marker owned by this process', async () => {
    const f = fixture(); const file = marker(f, { overrides: { pid: process.pid } });
    expect(await reapRemoteSlots({ ...f, pidAlive: undefined })).toEqual([]);
    expect(existsSync(file)).toBe(true);
  });
  it('treats EPERM as alive and unknown pid-probe errors as insufficient evidence', async () => {
    const f = fixture(); const file = marker(f);
    const kill = vi.spyOn(process, 'kill');
    for (const code of ['EPERM', 'EIO']) {
      kill.mockImplementation(() => { throw Object.assign(new Error('probe failed'), { code }); });
      expect(await reapRemoteSlots({ ...f, pidAlive: undefined })).toEqual([]);
      expect(existsSync(file)).toBe(true);
    }
  });
  it('honors injected grace, run ceiling and margin', async () => {
    const f = fixture(); f.pidAlive.mockReturnValue(true);
    const file = marker(f, { age: 500 });
    expect(await reapRemoteSlots({ ...f, graceMs: 501, maxRunMs: 300, marginMs: 200 })).toEqual([]);
    expect(existsSync(file)).toBe(true);
    expect(await reapRemoteSlots({ ...f, graceMs: 500, maxRunMs: 300, marginMs: 200 })).toHaveLength(1);
  });
  it('dry-run reports candidates without unlinking leases, logging clears or emitting events', async () => {
    const f = fixture(); const file = marker(f);
    tryAcquireSlot({ lockRoot: f.remoteRoot, cap: 1, owner: 'old', nowMs: now - oldAge,
      nowIso: new Date(now - oldAge).toISOString(), pid: process.pid });
    expect(await reapRemoteSlots({ ...f, dryRun: true })).toEqual([
      { slot: 0, runId, evidence: expect.any(String), cleared: false },
    ]);
    expect(existsSync(file)).toBe(true);
    expect(heldSlots({ lockRoot: f.remoteRoot, cap: 1 })).toHaveLength(1);
    expect(f.appendEvent).not.toHaveBeenCalled();
    expect(f.log).not.toHaveBeenCalled();
  });
  it.each([true, false])('removes only an expired matching slot lease (expired=%s)', async expired => {
    const f = fixture(); marker(f);
    const at = expired ? now - oldAge : now;
    tryAcquireSlot({ lockRoot: f.remoteRoot, cap: 1, owner: 'lease-owner', nowMs: at,
      nowIso: new Date(at).toISOString(), pid: process.pid });
    expect(await reapRemoteSlots(f)).toHaveLength(1);
    expect(heldSlots({ lockRoot: f.remoteRoot, cap: 1 })).toHaveLength(expired ? 0 : 1);
  });
  it.each([
    ['', 0, true],
    ['  60 node /srv/forge-exec-run.mjs run\n 10 node /srv/forge-exec-run.mjs finish\n', 4, true],
    [`10 node /srv/forge-exec-run.mjs prepare\n${oldAge / 1000} node /srv/forge-exec-run.mjs run\n`, 4, false],
    ['10 node /srv/forge-exec-run.mjs run\ninvalid', 0, false],
    ['\n', 0, false],
    ['10 node /srv/forge-exec-run.mjs run\n\n', 0, false],
    ['9007199254740992 node /srv/forge-exec-run.mjs run', 0, false],
    ['ssh-error', 0, false],
    ['telemetry-error', 0, false],
    ['', '0', false],
    ['oversized-output', 0, false],
  ])('default status reader requires bounded SSH process ages and telemetry: %j', async (output, activeRuns, cleared) => {
      const f = fixture(); const file = marker(f, { age: oldAge });
      vi.mocked(execFile).mockImplementation((file, args, options, callback) => {
        expect(file).toBe('ssh');
        expect(args).toEqual(['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', 'forge',
          "set -o pipefail; ps -eo etimes=,args= | { grep -E '[f]orge-exec-run.mjs (prepare|run|finish)$'; rc=$?; [ \"$rc\" -le 1 ]; }"]);
        expect(options).toMatchObject({ timeout: 8000, maxBuffer: 4096 });
        callback(['ssh-error', 'oversized-output'].includes(output) ? new Error('SSH failed or maxBuffer exceeded') : null, output);
      });
      vi.mocked(readForgeTelemetry).mockImplementation(async () => {
        if (output === 'telemetry-error') throw new Error('invalid telemetry');
        return { activeRuns };
      });
      const results = await reapRemoteSlots({ ...f, readForgeStatus: undefined });
      expect(results).toHaveLength(cleared ? 1 : 0);
      expect(existsSync(file)).toBe(!cleared);
      expect(f.appendEvent.mock.calls).toEqual(results.map(({ cleared, ...detail }) => [{ kind: 'remote-slot-reaped', detail }]));
      if (cleared && activeRuns > 0) expect(results[0].evidence).toBe(
        `no-forge-proc-as-old-as-marker maxProcAgeSec=60 markerAgeSec=${oldAge / 1000}`);
    },
  );
});

async function admission(f, remoteExec) {
  const { easternTimestamp } = await import('../forge-exec-run.mjs');
  return runWithRemoteDecision({
    argv: ['npm', 'run', 'test:unit', '--', 'fixture.test.mjs'],
    cwd: 'fixture-checkout', env: {}, clock: f.clock,
    lockRoot: join(f.remoteRoot, '..', 'heavy'), log: f.log, readForgeStatus: f.readForgeStatus,
    policy: resolveAdmissionPolicy({ platform: { remote: { enabled: true, mode: 'always' } } }),
    readTelemetry: async () => ({ sampledAtET: easternTimestamp(now), cores: 8, loadPerCore: 0.1,
      memFreePct: 90, activeRuns: 0, recent: [] }),
    loadPerCore: () => 4, remoteExec,
  });
}

describe('remote admission markers', () => {
  it('writes one JSON line with its own valid runId and passes the same runId to remoteExec', async () => {
    const f = fixture();
    const remoteExec = vi.fn(async options => {
      const raw = readFileSync(join(f.remoteRoot, 'slot-0.unconfirmed'), 'utf8');
      expect(raw.split('\n')).toHaveLength(2);
      const data = JSON.parse(raw);
      expect(data).toEqual({ v: 1, runId: options.runId, slot: 0, startedAt: new Date(now).toISOString(), pid: process.pid });
      expect(data.runId).toMatch(/^20261031[a-z0-9]*-[a-f0-9]{8}$/);
      expect(validateRunId(data.runId)).toBe(true);
      return { mode: 'remote', code: 0 };
    });
    expect(await admission(f, remoteExec)).toEqual({ handled: true, exitCode: 0 });
    expect(remoteExec).toHaveBeenCalledTimes(1);
    expect(f.readForgeStatus).not.toHaveBeenCalled();
    expect(existsSync(join(f.remoteRoot, 'slot-0.unconfirmed'))).toBe(false);
  });
  it('reaps an old marker before scanning for the remote slot', async () => {
    const f = fixture(); marker(f, { legacy: true, age: oldAge });
    const remoteExec = vi.fn(async () => ({ mode: 'remote', code: 0 }));
    expect(await admission(f, remoteExec)).toEqual({ handled: true, exitCode: 0 });
    expect(f.readForgeStatus).toHaveBeenCalledTimes(1);
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
  it('clears the exit-124 ambiguous-result marker once its local pid is dead and Forge is idle', async () => {
    const f = fixture();
    expect(await admission(f, async () => ({ mode: 'unconfirmed' }))).toEqual({ handled: true, exitCode: 124 });
    const file = join(f.remoteRoot, 'slot-0.unconfirmed');
    const persisted = JSON.parse(readFileSync(file, 'utf8'));
    expect(persisted).toMatchObject({ v: 1, pid: process.pid });
    f.pidAlive.mockReturnValue(false);
    const detail = { slot: 0, runId: persisted.runId, evidence: 'forge-idle activeRuns=0 procs=0 age=120000ms' };
    expect(await reapRemoteSlots({ ...f, clock: () => now + 120000 })).toEqual([{ ...detail, cleared: true }]);
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
