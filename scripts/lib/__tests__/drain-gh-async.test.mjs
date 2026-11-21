// @vitest-environment node
import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execDrainAsync } from '../drain-gh-async.mjs';
import { runEnqueueCandidates } from '../drain-concurrency.mjs';
import { readGhSlotHolders } from '../gh-throttle-holders.mjs';
import { keepAliveScript } from '../test-keepalive.mjs';

it('runs overlapping subprocess reads through the real throttle and isolates a subprocess failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'drain-async-'));
  try {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const eventsFile = join(root, 'events.jsonl');
    writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const num = Number(process.argv.at(-1));
const record = type => appendFileSync(process.env.DRAIN_TEST_EVENTS, JSON.stringify({type, num}) + '\\n');
record('start');
setTimeout(() => {
  record('end');
  if (num === 2) { process.stderr.write('fixture read failed'); process.exit(1); }
  process.stdout.write(JSON.stringify({number: num}));
}, 200);
`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, VITEST: 'true',
      DRAIN_TEST_EVENTS: eventsFile, WE_GH_THROTTLE_LOCK_ROOT: join(root, 'throttle'),
      WE_GH_THROTTLE_GH_BIN: 'host-override-must-not-reach-fixture',
      WE_GH_THROTTLE_CALLER: 'unknown',
      WE_GH_THROTTLE_CAP: '6', WE_GH_THROTTLE_RETRY_MAX_ATTEMPTS: '1' };
    const completed = [], failed = [];
    await runEnqueueCandidates([1, 2, 3].map(num => ({ num })), { concurrency: 3, canParallel: () => true,
      run: async c => {
        const r = await execDrainAsync('gh', ['pr', 'view', String(c.num)], { env, encoding: 'utf8' });
        completed.push(JSON.parse(r.stdout).number);
      }, onError: (c, e) => failed.push([c.num, e.stderr]) });
    expect(completed.sort()).toEqual([1, 3]);
    expect(failed).toEqual([[2, expect.stringContaining('fixture read failed')]]);
    let active = 0, peak = 0;
    for (const event of readFileSync(eventsFile, 'utf8').trim().split('\n').map(JSON.parse)) {
      active += event.type === 'start' ? 1 : -1;
      peak = Math.max(peak, active);
    }
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
    expect(active).toBe(0);
    const calls = readFileSync(join(root, 'throttle', 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(calls).toHaveLength(3);
    expect(calls.map(call => call.caller)).toEqual(Array(3).fill('merge-ai-prs.mjs'));
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 15000);

it('kills the real gh on timeout and releases its throttle slot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'drain-timeout-'));
  const pidFile = join(root, 'pid');
  let pid;
  try {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
require('node:fs').writeFileSync(process.env.DRAIN_TEST_PID, String(process.pid));
process.on('SIGTERM', () => {});
${keepAliveScript({ maxLifetimeMs: 30_000 })}
`, { mode: 0o755 });
    const lockRoot = join(root, 'throttle');
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, VITEST: 'true',
      DRAIN_TEST_PID: pidFile, WE_GH_THROTTLE_LOCK_ROOT: lockRoot,
      WE_GH_THROTTLE_RETRY_MAX_ATTEMPTS: '1' };
    await expect(execDrainAsync('gh', ['pr', 'view', '1'], {
      env, timeout: 1500, killSignal: 'SIGKILL', encoding: 'utf8',
    })).rejects.toThrow();
    pid = Number(readFileSync(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
    expect(readGhSlotHolders({ lockRoot, cap: 6 })).toEqual([]);
  } finally {
    if (!pid) { try { pid = Number(readFileSync(pidFile, 'utf8')); } catch {} }
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

it.each([undefined, 'SIGTERM', 'SIGINT', 15])(
  'bounds a timeout and releases the slot when gh ignores killSignal %s', async killSignal => {
    const root = mkdtempSync(join(tmpdir(), 'drain-soft-timeout-'));
    const pidFile = join(root, 'pid');
    let pid;
    try {
      const bin = join(root, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
process.on('SIGTERM', () => {});
process.on('SIGINT', () => {});
require('node:fs').writeFileSync(process.env.DRAIN_TEST_PID, String(process.pid));
${keepAliveScript({ maxLifetimeMs: 6000 })}
`, { mode: 0o755 });
      const lockRoot = join(root, 'throttle');
      const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, VITEST: 'true',
        DRAIN_TEST_PID: pidFile, WE_GH_THROTTLE_LOCK_ROOT: lockRoot,
        WE_GH_THROTTLE_RETRY_MAX_ATTEMPTS: '1' };
      const started = performance.now();
      await expect(execDrainAsync('gh', ['pr', 'view', '1'], {
        env, timeout: 500, ...(killSignal === undefined ? {} : { killSignal }), encoding: 'utf8',
      })).rejects.toThrow();
      const elapsed = performance.now() - started;
      pid = Number(readFileSync(pidFile, 'utf8'));
      expect(elapsed).toBeLessThan(3000);
      expect(() => process.kill(pid, 0)).toThrow();
      expect(readGhSlotHolders({ lockRoot, cap: 6 })).toEqual([]);
    } finally {
      if (!pid) { try { pid = Number(readFileSync(pidFile, 'utf8')); } catch {} }
      if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      rmSync(root, { recursive: true, force: true });
    }
  }, 15000,
);

it('never serves async gate reads from the gh read memo', async () => {
  const root = mkdtempSync(join(tmpdir(), 'drain-memo-'));
  try {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const counter = join(root, 'count');
    writeFileSync(counter, '0');
    writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const n = Number(fs.readFileSync(process.env.DRAIN_TEST_COUNT, 'utf8')) + 1;
fs.writeFileSync(process.env.DRAIN_TEST_COUNT, String(n));
process.stdout.write(JSON.stringify({ n }));
`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, VITEST: 'true',
      DRAIN_TEST_COUNT: counter, WE_GH_THROTTLE_LOCK_ROOT: join(root, 'throttle'),
      WE_GH_READ_MEMO_DIR: join(root, 'memo') };
    const args = ['pr', 'view', '7', '--repo', 'o/r', '--json', 'statusCheckRollup'];
    const a = await execDrainAsync('gh', args, { env, encoding: 'utf8' });
    const b = await execDrainAsync('gh', args, { env, encoding: 'utf8' });
    expect(JSON.parse(a.stdout).n).toBe(1);
    expect(JSON.parse(b.stdout).n).toBe(2);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 15000);
