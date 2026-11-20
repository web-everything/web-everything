// @vitest-environment node
import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execDrainAsync } from '../drain-gh-async.mjs';
import { runEnqueueCandidates } from '../drain-concurrency.mjs';
import { readGhSlotHolders } from '../gh-throttle-holders.mjs';

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
setInterval(() => {}, 1000);
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
