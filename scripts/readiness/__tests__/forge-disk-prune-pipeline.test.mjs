// @vitest-environment node
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRunner, parseTelemetry} from '../forge-exec-run.mjs';
import {readForgeTelemetry} from '../forge-telemetry.mjs';
import {checkRemoteHealth, peekRemoteTelemetry} from '../forge-remote-health.mjs';
import {PRUNE_STATUS_FILE, readPruneStatus, recordPruneResult} from '../forge-cache-prune.mjs';
import smell from '../../conveyor/health-smells/forge-disk-prune.mjs';
import {emptyHealthState, runHealthTick} from '../../conveyor/health-watch-core.mjs';

let root, receipts;
const now = Date.parse('2026-11-16T05:00:00Z');
const settings = {maxLoadPerCore: 1e6, minFreeRamPct: 0, backoffMs: 1, backoffFailures: 3};
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'forge-disk-pipeline-'));
  receipts = join(root, 'receipts');
  await mkdir(receipts, {mode: 0o700});
});
afterEach(async () => { await rm(root, {recursive: true, force: true}); });
const runner = (disk = {blocks: 100, bfree: 65, bavail: 65}) => createRunner({
  testRoot: root, testPath: '/usr/bin:/bin', clock: () => now, testDiskStat: async path => {
    expect(path).toBe('/');
    if (disk instanceof Error) throw disk;
    return disk;
  },
});
async function receive(producer) {
  const remote = join(root, 'remote');
  await mkdir(remote, {recursive: true});
  const readTelemetry = () => readForgeTelemetry({exec: (_cmd, _argv, _opts, callback) => {
    producer.telemetry().then(value => callback(null, JSON.stringify(value)), callback);
    return {};
  }});
  expect(await checkRemoteHealth({root: remote, settings, clock: () => now, readTelemetry})).toEqual({ok: true});
  expect(peekRemoteTelemetry({root: remote})).toBeTruthy();
  const health = JSON.parse(await readFile(join(remote, 'health-g2.json'), 'utf8'));
  const wired = {...smell, evaluate: (probes, ctx) => smell.evaluate(probes, {...ctx, readForgeHealth: () => health})};
  return runHealthTick(emptyHealthState(), {}, [wired], now);
}

describe('Forge producer → SSH parser → health cache → notification', () => {
  it.each([['root disk full', 0, {blocks: 100, bfree: 0, bavail: 0}],
    ['three prune refusals', 3, undefined]])('notifies needs-you for %s', async (_label, refused, disk) => {
    for (let i = 0; i < refused; i++) await recordPruneResult(receipts, 'Invalid reserved lock evidence');
    const tick = await receive(runner(disk));
    const episode = tick.state.episodes['forge-disk-prune::forge-disk-prune'];
    expect(episode.escalation.status).toBe('needs-you');
    expect(tick.plan.filter(p => p.kind === 'notify' && !p.suppressed)).toHaveLength(1);
    expect(episode.summary).toContain(refused ? 'Invalid reserved lock evidence' : '100%');
  });
  it('persists a healthy reading and emits no alert', async () => {
    await recordPruneResult(receipts, null);
    const tick = await receive(runner());
    expect(tick.plan.filter(p => p.kind === 'notify' && !p.suppressed)).toEqual([]);
    expect(tick.state.episodes['forge-disk-prune::forge-disk-prune']).toBeUndefined();
    const telemetry = peekRemoteTelemetry({root: join(root, 'remote')});
    expect(telemetry).toMatchObject({diskUsedPct: 35, prune: {consecutiveRefused: 0, lastRefusal: ''}});
    expect(smell.evaluate({}, {now, readForgeHealth: () => ({telemetry})})).toEqual([{
      subject: 'forge-disk-prune', breach: false,
      measure: {diskUsedPct: 35, consecutiveRefused: 0, lastRefusal: ''},
      summary: 'Forge disk 35% used, prune refusals 0 (ok).', recommendation: 'No action.',
    }]);
  });
  it('still delivers a full-disk alarm when Forge cannot write its telemetry cache', async () => {
    await mkdir(join(receipts, 'telemetry.json'));
    const tick = await receive(runner({blocks: 100, bfree: 0, bavail: 0}));
    expect(tick.state.episodes['forge-disk-prune::forge-disk-prune'].escalation.status).toBe('needs-you');
    expect(tick.plan.filter(p => p.kind === 'notify' && !p.suppressed)).toHaveLength(1);
  });
  it('keeps prune evidence when disk sampling fails, and disk evidence when status is malformed', async () => {
    for (let i = 0; i < 3; i++) await recordPruneResult(receipts, 'refused');
    expect((await receive(runner(new Error('statfs failed')))).plan.some(p => p.kind === 'notify' && !p.suppressed)).toBe(true);
    await writeFile(join(receipts, PRUNE_STATUS_FILE), '{bad');
    const sample = parseTelemetry(JSON.stringify(await runner({blocks: 100, bfree: 0, bavail: 0}).telemetry()));
    expect(sample.diskUsedPct).toBe(100);
    expect(sample).not.toHaveProperty('prune');
    expect(smell.evaluate({}, {now, readForgeHealth: () => ({telemetry: sample})})[0].escalation.status).toBe('needs-you');
  });
  it('omits unavailable or invalid fields and leaves an observable low note', async () => {
    for (const disk of [new Error('unavailable'), {blocks: 0, bfree: 0, bavail: 0}, {blocks: 10, bfree: 11, bavail: 0}]) {
      const sample = parseTelemetry(JSON.stringify(await runner(disk).telemetry()));
      expect(sample).not.toHaveProperty('diskUsedPct');
      expect(sample).not.toHaveProperty('prune');
      expect(smell.evaluate({}, {now, readForgeHealth: () => ({telemetry: sample})})[0].severity).toBe('low');
    }
  });
  it('includes reserved blocks in root disk pressure like df and rounds up', async () => {
    expect((await runner({blocks: 1000, bfree: 250, bavail: 200}).telemetry()).diskUsedPct).toBe(79);
    expect((await runner({blocks: 1000, bfree: 250, bavail: 190}).telemetry()).diskUsedPct).toBe(80);
  });
});

describe('prune completion evidence', () => {
  const cli = (apply = true) => spawnSync(process.execPath, [new URL('../forge-cache-prune.mjs', import.meta.url).pathname,
    `--root=${join(root, 'cache')}`, `--receipts=${receipts}`, '--json', ...(apply ? ['--apply'] : [])],
  {encoding: 'utf8', timeout: 10000, env: {...process.env, FORGE_CACHE_MAX_AGE_HOURS: ''}});
  it('counts actual service CLI refusals, leaves dry-run diagnostic results alone, and resets on success', async () => {
    for (let i = 1; i <= 3; i++) {
      const result = cli();
      expect(result.status, result.stderr).toBe(1);
      expect(await readPruneStatus(receipts)).toMatchObject({consecutiveRefused: i, lastRefusal: expect.stringContaining('FORGE_CACHE_MAX_AGE_HOURS')});
    }
    cli(false);
    expect((await readPruneStatus(receipts)).consecutiveRefused).toBe(3);
    const st = await stat(join(receipts, PRUNE_STATUS_FILE));
    expect(st.mode & 0o777).toBe(0o600);
    expect(st.uid).toBe((await stat(receipts)).uid);
    await recordPruneResult(receipts, null);
    expect((await readPruneStatus(receipts)).consecutiveRefused).toBe(0);
  });
  it('carries the reported invalid reservation refusal from the real pruner CLI to a needs-you notification', async () => {
    await mkdir(join(root, 'cache'));
    await mkdir(join(receipts, 'worker-active'));
    const run = 'r-' + 'a'.repeat(32);
    await writeFile(join(receipts, 'worker-active', 'reservation.json'), JSON.stringify({run, writerGuard: 1}));
    await writeFile(join(receipts, run + '.running'), '{}');
    for (let i = 0; i < 3; i++) {
      const result = spawnSync(process.execPath, [new URL('../forge-cache-prune.mjs', import.meta.url).pathname,
        `--root=${join(root, 'cache')}`, `--receipts=${receipts}`, '--apply', '--json'],
      {encoding: 'utf8', timeout: 10000, env: {...process.env,
        FORGE_CACHE_MAX_AGE_HOURS: '12', FORGE_CACHE_MAX_BYTES: '214748364800', FORGE_CACHE_HIGH_WATER_PCT: '80'}});
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain('Invalid reserved lock evidence');
    }
    expect(await readPruneStatus(receipts)).toEqual({consecutiveRefused: 3, lastRefusal: expect.stringContaining('Invalid reserved lock evidence')});
    // The invalid run is intentionally still present; sampling/reaping must preserve the alarm.
    const tick = await receive(runner());
    expect(tick.state.episodes['forge-disk-prune::forge-disk-prune'].escalation.status).toBe('needs-you');
    expect(tick.plan.filter(p => p.kind === 'notify' && !p.suppressed)).toHaveLength(1);
  });
  it('serializes simultaneous results and sanitizes/bounds refusal text', async () => {
    await Promise.all(Array.from({length: 8}, () => recordPruneResult(receipts, '\n\r\u2028\u200b' + 'x'.repeat(500))));
    const value = await readPruneStatus(receipts);
    expect(value.consecutiveRefused).toBe(8);
    expect(value.lastRefusal).toBe('    ' + 'x'.repeat(196));
  });
  it.each(['oversized', 'malformed', 'symlink', 'fifo'])('fails closed on %s status without resetting it', async kind => {
    const path = join(receipts, PRUNE_STATUS_FILE);
    if (kind === 'symlink') await symlink(join(root, 'absent'), path);
    else if (kind === 'fifo') {
      expect(spawnSync('mkfifo', [path]).status).toBe(0);
    } else await writeFile(path, kind === 'oversized' ? 'x'.repeat(4097) : '{bad');
    await expect(readPruneStatus(receipts)).rejects.toThrow();
    await expect(recordPruneResult(receipts, null)).rejects.toThrow();
  });
});
