// @vitest-environment node
import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execDrainAsync } from '../drain-gh-async.mjs';
import { runEnqueueCandidates } from '../drain-concurrency.mjs';

it('runs overlapping subprocess reads through the real throttle and isolates a subprocess failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'drain-async-'));
  try {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const eventsFile = join(root, 'events.jsonl');
    writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const { appendFileSync, writeFileSync, existsSync } = require('node:fs');
const num = Number(process.argv.at(-1));
const record = type => appendFileSync(process.env.DRAIN_TEST_EVENTS, JSON.stringify({type, num}) + '\\n');
record('start');
writeFileSync(process.env.DRAIN_TEST_EVENTS + '.started-' + num, '');
// Rendezvous after recording every start: process startup under shard load may exceed 200 ms.
// A serial implementation must fail the bounded wait rather than manufacture overlap.
const deadline = Date.now() + 5000;
const timer = setInterval(() => {
  if (![1, 2, 3].every(n => existsSync(process.env.DRAIN_TEST_EVENTS + '.started-' + n))) {
    if (Date.now() >= deadline) {
      clearInterval(timer);
      process.stderr.write('fixture concurrency rendezvous timed out');
      process.exitCode = 1;
    }
    return;
  }
  clearInterval(timer);
  record('end');
  if (num === 2) { process.stderr.write('fixture read failed'); process.exit(1); }
  process.stdout.write(JSON.stringify({number: num}));
}, 10);
`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, VITEST: 'true',
      DRAIN_TEST_EVENTS: eventsFile, WE_GH_THROTTLE_LOCK_ROOT: join(root, 'throttle'),
      WE_GH_THROTTLE_GH_BIN: 'host-override-must-not-reach-fixture',
      WE_GH_THROTTLE_CAP: '6', WE_GH_THROTTLE_PER_CALLER_MAX: '3', WE_GH_THROTTLE_RETRY_MAX_ATTEMPTS: '1' };
    const completed = [], failed = [];
    await runEnqueueCandidates([1, 2, 3].map(num => ({ num })), { concurrency: 3, canParallel: () => true,
      run: async c => {
        const r = await execDrainAsync('gh', ['pr', 'view', String(c.num)], { env, encoding: 'utf8', timeout: 10000 });
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
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);
