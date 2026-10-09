// @vitest-environment node
/** @file Tests for shared resource measurements without probing the host. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cpuIdlePctFromTimes, parseIoregDiskStats, diskFromDeltas, parsePsCpu, fseventsCpuPct, countAgentSessions, memoryPressureLevel, buildSnapshot, createSampler, resourcePaths, writeSnapshot, readSnapshot, appendResourceLog } from '../resource-sampler.mjs';
const roots = [];
const temp = () => { const root = mkdtempSync(join(tmpdir(), 'resource-')); roots.push(root); return root; };
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const cpu = (idle, user) => ({ times: { idle, user, nice: 0, sys: 0, irq: 0 } });
const ioreg = `+-o AppleANS2 <class IOBlockStorageDriver, id 0x1, registered, active>
  { "Statistics" = {"Total Time (Read)"=200000000,"Bytes (Read)"=2000000,"Total Time (Write)"=300000000,"Bytes (Write)"=1000000} }
+-o Other <class IOBlockStorageDriver, id 0x2, registered, active>
  { "Statistics" = {"Total Time (Read)"=0,"Bytes (Read)"=0,"Total Time (Write)"=0,"Bytes (Write)"=0} }`;
describe('resource sampler', () => {
  it('measures interval CPU idle across cores, including reset/no delta', () => {
    expect(cpuIdlePctFromTimes([cpu(100, 100), cpu(200, 100)], [cpu(150, 150), cpu(300, 100)])).toBe(75);
    expect(cpuIdlePctFromTimes([cpu(1, 1)], [cpu(1, 1)])).toBeNull();
    expect(cpuIdlePctFromTimes(null, [])).toBeNull();
    expect(cpuIdlePctFromTimes([cpu(10, 10)], [cpu(1, 1)])).toBeNull();
  });
  it('parses driver statistics and caps interval busy time', () => {
    const next = parseIoregDiskStats(ioreg);
    expect(next).toEqual({ totalTimeNs: 500000000, bytesRead: 2000000, bytesWritten: 1000000 });
    const zero = { totalTimeNs: 0, bytesRead: 0, bytesWritten: 0 };
    expect(diskFromDeltas(zero, next, 1000)).toEqual({ busyPct: 50, ioDepth: 0.5, readMBps: 2, writeMBps: 1 });
    expect(diskFromDeltas(zero, next, 100).ioDepth).toBe(5); // overlapping I/O: depth is uncapped
    expect(diskFromDeltas(zero, next, 100).busyPct).toBe(100);
    expect(diskFromDeltas(null, next, 100)).toBeNull();
    expect(diskFromDeltas(next, zero, 100)).toBeNull();
    expect(diskFromDeltas(zero, next, 0)).toBeNull();
    expect(parseIoregDiskStats('garbage')).toBeNull();
  });
  it('parses process names, sums fseventsd and excludes agent helpers', () => {
    const procs = parsePsCpu(' 1 90.5 /usr/libexec/fseventsd\n2 10.0 fseventsd\n3 1.2 /a path/claude\n4 0 codex\n5 4 claude-otel-collector\nbad');
    expect(procs[2]).toEqual({ pid: 3, pcpu: 1.2, comm: '/a path/claude' });
    expect(fseventsCpuPct(procs)).toBe(100.5);
    expect(countAgentSessions(procs)).toEqual({ claude: 1, codex: 1, total: 2 });
    expect(memoryPressureLevel(' 4\n')).toBe(4);
    expect(memoryPressureLevel('2')).toBe(2);
    expect(memoryPressureLevel('1')).toBe(1);
    expect(memoryPressureLevel('3')).toBeNull();
    expect(memoryPressureLevel('1junk')).toBeNull();
  });
  it('builds freshness and preserves unavailable counters', () => {
    const snapshot = buildSnapshot({ sampledAtMs: 0, intervalMs: 10000 });
    expect(snapshot.freshUntil).toBe('1970-01-01T00:00:30.000Z');
    expect(snapshot.schema).toBe('resource-snapshot/1');
    expect(snapshot.fsevents.backlog).toBeNull();
    expect(snapshot.errors).toEqual([]);
  });
  it('isolates probe failures and uses elapsed deltas with bounded subprocesses', () => {
    let tick = 0;
    const exec = vi.fn((cmd) => { if (cmd === 'sysctl') throw Error('denied'); return cmd === 'ioreg' ? ioreg.replace('200000000', String(200000000 + tick * 100000000)) : '1 3 codex'; });
    const sampler = createSampler({ exec, now: () => tick * 10000, cpus: () => [cpu(100 + tick * 75, 100 + tick * 25)], loadavg: () => [63, 50, 40], freemem: () => 25, totalmem: () => 100, readHeavySlots: () => ({ held: 1, cap: 3 }), countLanes: () => 100 });
    expect(sampler.sample().cpu.idlePct).toBeNull();
    tick++;
    const s = sampler.sample();
    expect(s.cpu.idlePct).toBe(75);
    expect(s.disk.busyPct).toBe(1);
    expect(s.memory).toEqual({ pressureLevel: null, freePct: 25 });
    expect(s.errors).toContainEqual({ probe: 'memPressureLevel', error: 'denied' });
    expect(s.agentSessions.total).toBe(1);
    for (const [, , options] of exec.mock.calls) expect(options).toMatchObject({ timeout: 5000, env: { LC_ALL: 'C' } });
  });
  it('keeps sampling when every host probe fails', () => {
    const fail = () => { throw Error('offline'); };
    const s = createSampler({ exec: fail, cpus: fail, loadavg: fail, freemem: fail, totalmem: fail, readHeavySlots: fail, countLanes: fail, now: () => 0 }).sample();
    expect(s.errors.length).toBeGreaterThanOrEqual(7);
    expect(s.cpu.idlePct).toBeNull();
    expect(s.cpu.cores).toBeNull();
    expect(s.disk.busyPct).toBeNull();
    expect(s.agentSessions).toEqual({ claude: null, codex: null, total: null });
    expect(s.heavySlots).toBeNull();
    expect(s.laneCount).toBeNull();
  });
  it('roundtrips snapshots, tolerates corruption, bounds history', () => {
    const root = temp();
    expect(readSnapshot({ root })).toBeNull();
    const s = buildSnapshot({ sampledAtMs: 0, intervalMs: 10000 });
    writeSnapshot(s, { root });
    expect(readSnapshot({ root })).toEqual(s);
    const paths = resourcePaths(root);
    writeFileSync(paths.history, Array.from({ length: 19999 }, (_, i) => JSON.stringify({ i })).join('\n') + '\n');
    appendResourceLog(paths.history, s, { maxBytes: 1000 }); // over the byte bound: keep the newest half
    const lines = readFileSync(paths.history, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(10000);
    expect(JSON.parse(lines[0])).toEqual({ i: 10000 });
    expect(JSON.parse(lines.at(-1))).toEqual(s);
    appendResourceLog(paths.history, { tail: true }); // under the default bound: append only, no rewrite
    expect(readFileSync(paths.history, 'utf8').trim().split('\n')).toHaveLength(10001);
    writeFileSync(paths.snapshot, '{');
    expect(readSnapshot({ root })).toBeNull();
  });
  it('reads lanes and slots from the given checkout, not from its own (snapshot) location', () => {
    const seen = [];
    const sampler = createSampler({ checkoutRoot: '/ws/.lanes/web-everything/lane-1', exec: () => '', cpus: () => [],
      readHeavySlots: undefined, countLanes: undefined });
    expect(typeof sampler.sample).toBe('function');
    const s = createSampler({ exec: () => '', cpus: () => [], countLanes: () => { seen.push('lanes'); return 3; }, readHeavySlots: () => ({ held: 1, cap: 2 }) }).sample();
    expect(s.laneCount).toBe(3);
    expect(s.heavySlots).toEqual({ held: 1, cap: 2 });
  });
});
