// @vitest-environment node
import {afterEach, describe, expect, it, vi} from 'vitest';
import {mkdtemp, mkdir, readFile, writeFile, rm, symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {createRunner} from '../forge-exec-run.mjs';
import * as pruner from '../forge-cache-prune.mjs';
import {readForgeTelemetry} from '../forge-telemetry.mjs';
import {checkRemoteHealth} from '../forge-remote-health.mjs';
import smell from '../../conveyor/health-smells/forge-disk-prune.mjs';
import {emptyHealthState, runHealthTick} from '../../conveyor/health-watch-core.mjs';

const roots = [];
const now = Date.parse('2026-11-16T06:00:00Z');
// Keep the shipped apply path real; Darwin uses the same kernel flock via Python as the existing pruner fixtures.
const leaseSpawn = (command, args, options) => command === '/usr/bin/flock' && process.platform === 'darwin'
  ? spawn('/usr/bin/python3', ['-I', '-c', 'import fcntl; fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)'], options)
  : spawn(command, args, options);
async function fixture(disk = {blocks: 100, bfree: 0, bavail: 0}) {
  const root = await mkdtemp(join(tmpdir(), 'forge-disk-pipeline-')); roots.push(root);
  const receipts = join(root, 'receipts'); await mkdir(receipts, {mode: 0o700});
  const statfs = vi.fn(async () => disk);
  const server = createRunner({testRoot: root, testStatfs: statfs, clock: () => now});
  const exec = vi.fn((_file, _args, _options, done) => ({stdin: {on() {}, end(input) {
    server.telemetry(JSON.parse(input)).then(value => done(null, JSON.stringify(value)), done);
  }}}));
  return {root, receipts, statfs, server, exec};
}
async function healthTick(f, state = emptyHealthState(), time = now) {
  const healthRoot = join(f.root, 'remote');
  const result = await checkRemoteHealth({root: healthRoot, clock: () => time,
    settings: {maxLoadPerCore: 1e9, minFreeRamPct: 0, backoffMs: 1000},
    readTelemetry: options => readForgeTelemetry({...options, exec: f.exec})});
  expect(result).toEqual({ok: true});
  const health = JSON.parse(await readFile(join(healthRoot, 'health.json'), 'utf8'));
  const wired = {...smell, evaluate(probes, ctx) {
    return smell.evaluate(probes, {...ctx, readForgeHealth: () => health});
  }};
  return {health, ...runHealthTick(state, {}, [wired], time)};
}
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true})));
});

describe('Forge producer → client parser → health.json → alarm', () => {
  it.each([
    ['disk full', {blocks: 100, bfree: 0, bavail: 0}, 0],
    ['prune refused', {blocks: 100, bfree: 65, bavail: 65}, 469],
    ['both', {blocks: 100, bfree: 0, bavail: 0}, 469],
  ])('raises a needs-you notification for %s through shipped producers and readers', async (_label, disk, count) => {
    const f = await fixture(disk);
    await writeFile(join(f.receipts, 'forge-cache-prune.json'), JSON.stringify({consecutiveRefused: count,
      lastRefusal: count ? 'Invalid reserved lock evidence' : ''}));
    const tick = await healthTick(f);
    expect(tick.health.telemetry.diskUsedPct).toBe(100 - disk.bfree);
    expect(tick.health.telemetry.prune.consecutiveRefused).toBe(count);
    expect(f.statfs).toHaveBeenCalledWith('/');
    expect(f.exec).toHaveBeenCalledTimes(1);
    expect(tick.state.episodes['forge-disk-prune::forge-disk-prune'].escalation.status).toBe('needs-you');
    expect(tick.plan.filter(p => p.kind === 'notify' && !p.suppressed)).toHaveLength(1);
  });
  it('keeps healthy readings quiet and unavailable evidence observable', async () => {
    const f = await fixture({blocks: 100, bfree: 65, bavail: 65});
    await pruner.recordPruneResult(f.receipts, null);
    expect((await healthTick(f)).plan).toHaveLength(0);
    await rm(join(f.receipts, 'forge-cache-prune.json'));
    f.statfs.mockRejectedValue(new Error('unreadable root disk'));
    const tick = await healthTick(f, emptyHealthState(), now + 11_000);
    expect(tick.health.telemetry).toMatchObject({diskUsedPct: null, prune: null});
    expect(tick.state.episodes['forge-disk-prune::forge-disk-prune'].severity).toBe('low');
    expect(tick.plan.filter(p => p.kind === 'notify' && !p.suppressed)).toHaveLength(0);
  });
  it('preserves a prune breach when disk sampling fails', async () => {
    const f = await fixture();
    await writeFile(join(f.receipts, 'forge-cache-prune.json'), JSON.stringify({consecutiveRefused: 3, lastRefusal: 'refused'}));
    f.statfs.mockRejectedValue(new Error('disk unavailable'));
    const tick = await healthTick(f);
    expect(tick.health.telemetry.diskUsedPct).toBeNull();
    expect(tick.state.episodes['forge-disk-prune::forge-disk-prune'].escalation.status).toBe('needs-you');
  });
  it('does not send new fields to legacy clients', async () => {
    const f = await fixture();
    expect(await f.server.telemetry()).not.toHaveProperty('diskUsedPct');
    expect(f.statfs).not.toHaveBeenCalled();
  });
});

describe('persisted prune outcomes', () => {
  it('serializes concurrent refusals, bounds the refusal line, and resets after success', async () => {
    const f = await fixture();
    await Promise.all([1, 2, 3].map(async () => {
      // Each completed attempt must be counted, including concurrent completions.
      await pruner.recordPruneResult(f.receipts, 'refused\n' + 'x'.repeat(1000));
    }));
    const value = await pruner.readPruneStatus(f.receipts);
    expect(value.consecutiveRefused).toBe(3);
    expect(value.lastRefusal.length).toBeLessThanOrEqual(200);
    expect(value.lastRefusal).not.toMatch(/[\r\n]/);
    await pruner.recordPruneResult(f.receipts, null);
    expect(await pruner.readPruneStatus(f.receipts)).toEqual({consecutiveRefused: 0, lastRefusal: ''});
  });
  it('records actual apply refusals, while a dry-run cannot clear them', async () => {
    const f = await fixture(); const cache = join(f.root, 'cache'); await mkdir(cache);
    vi.stubEnv('FORGE_CACHE_MAX_BYTES', 'invalid');
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    for (let i = 0; i < 3; i++) expect(await pruner.main([`--root=${cache}`, `--receipts=${f.receipts}`, '--apply', '--json'])).toBe(1);
    expect(await pruner.readPruneStatus(f.receipts)).toMatchObject({consecutiveRefused: 3, lastRefusal: expect.stringContaining('FORGE_CACHE_')});
    await pruner.main([`--root=${cache}`, `--receipts=${f.receipts}`, '--json']);
    expect((await pruner.readPruneStatus(f.receipts)).consecutiveRefused).toBe(3);
    const tick = await healthTick(f);
    expect(tick.state.episodes['forge-disk-prune::forge-disk-prune'].escalation.status).toBe('needs-you');
    vi.stubEnv('FORGE_CACHE_MAX_AGE_HOURS', '12');
    vi.stubEnv('FORGE_CACHE_MAX_BYTES', '214748364800');
    vi.stubEnv('FORGE_CACHE_HIGH_WATER_PCT', '80');
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(await pruner.main([`--root=${cache}`, `--receipts=${f.receipts}`, '--apply', '--json'], {spawnProcess: leaseSpawn})).toBe(0);
    expect((await pruner.readPruneStatus(f.receipts)).consecutiveRefused).toBe(0);
    f.statfs.mockResolvedValue({blocks: 100, bfree: 65, bavail: 65});
    const firstHealthy = await healthTick(f, tick.state, now + 11_000);
    expect(firstHealthy.state.episodes['forge-disk-prune::forge-disk-prune']).toBeDefined();
    const recovered = await healthTick(f, firstHealthy.state, now + 22_000);
    expect(recovered.state.episodes['forge-disk-prune::forge-disk-prune']).toBeUndefined();
  }, 30_000);
  it.each(['oversized', 'corrupt', 'symlink'])('reports %s status as unavailable without blocking a disk alarm', async fault => {
    const f = await fixture(); const path = join(f.receipts, 'forge-cache-prune.json');
    if (fault === 'symlink') { await writeFile(join(f.root, 'target'), '{}'); await symlink(join(f.root, 'target'), path); }
    else await writeFile(path, fault === 'oversized' ? 'x'.repeat(4097) : '{}');
    const tick = await healthTick(f);
    expect(tick.health.telemetry.prune).toBeNull();
    expect(tick.state.episodes['forge-disk-prune::forge-disk-prune'].escalation.status).toBe('needs-you');
  });
});
