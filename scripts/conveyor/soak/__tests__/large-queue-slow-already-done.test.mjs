// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import b from '../breaks/large-queue-slow-already-done.mjs';
import { keepAliveScript } from '../../../lib/test-keepalive.mjs';

const dirs = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'slow-queue-oracle-'));
  dirs.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  // Fail closed if the scenario ever stops putting its response-barrier fake gh first on PATH.
  writeFileSync(join(bin, 'gh'), `#!${process.execPath}
throw new Error('scenario must install its GitHub response barrier');
`, { mode: 0o755 });
  // The scenario needs an origin slug and UNKNOWN local history, not writable Git state.
  writeFileSync(join(bin, 'git'), `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === 'init' || (args[0] === 'remote' && args[1] === 'add')) process.exit(0);
if (args.join(' ') === 'remote get-url origin') { console.log('https://github.com/soak/fixture.git'); process.exit(0); }
if (args.join(' ') === 'rev-parse --is-shallow-repository') { console.log('true'); process.exit(0); }
if (args[0] === 'for-each-ref') process.exit(0);
process.exit(1);
`, { mode: 0o755 });
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
  return dir;
}

function blockingPlanner(dir, workerLock) {
  const readiness = join(dir, 'scripts', 'readiness');
  mkdirSync(readiness, { recursive: true });
  writeFileSync(join(readiness, 'dispatch-plan.mjs'), `
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const workerLock = ${JSON.stringify(workerLock)};
if (workerLock !== undefined) writeFileSync(process.env.WE_DISPATCH_PLAN_ALREADY_DONE_CACHE_FILE + '.refresh-lock', workerLock);
try { execFileSync('gh', ['api', 'graphql', 'search=' + process.pid], { stdio: 'ignore' }); } catch {}
console.log(JSON.stringify({ groundTruth: { pending: 444, refresh: { started: false, ids: ['8000', '8001'] } } }));
`);
}

describe('large-queue soak oracle', () => {
  it.each(['x', 'é'])('rejects oversized planner stdout measured in bytes (%s)', async character => {
    const dir = fixture();
    const readiness = join(dir, 'scripts', 'readiness');
    mkdirSync(readiness, { recursive: true });
    writeFileSync(join(readiness, 'dispatch-plan.mjs'), `
process.stdout.write(JSON.stringify({ padding: ${JSON.stringify(character)}.repeat(8 * 1024 * 1024 / Buffer.byteLength(${JSON.stringify(character)}) + 1) }));
${keepAliveScript()}
`);
    const report = await b.run({ root: dir });
    expect(report.violations).toEqual([{
      invariant: 'crash', detail: expect.stringContaining('planner stdout exceeded 8388608 bytes; inspect planner output manually'),
    }]);
  }, 30000);

  it('accepts slow CLI startup while the real GitHub refresh stays detached and single-flight', async () => {
    const dir = fixture();
    const preload = join(dir, 'slow-start.cjs');
    writeFileSync(preload, `
if (process.argv[1]?.endsWith('/scripts/readiness/dispatch-plan.mjs')) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2200);
}
`);
    vi.stubEnv('NODE_OPTIONS', `${process.env.NODE_OPTIONS || ''} --require=${preload}`);
    const report = await b.run();
    expect(b.judge(report)).toEqual([]);
    expect(report.elapsedMs).toBeGreaterThanOrEqual(2200);
    expect(report.calls).toBeGreaterThanOrEqual(1);
    expect(report.calls).toBeLessThanOrEqual(2);
  }, 30000);

  it('rejects a planner that waits for GitHub even when it returns within the runaway ceiling', async () => {
    const dir = fixture();
    blockingPlanner(dir);
    const report = await b.run({ root: dir });
    expect(report.violations).toContainEqual({
      invariant: 'not-awaited', detail: 'slow worker did not outlive planner',
    });
    expect(report.violations.some(v => v.invariant === 'crash')).toBe(false);
  }, 30000);

  it.each([
    ['malformed JSON', '{', /SyntaxError/],
    ['invalid worker pid', '{"pid":0}', /invalid refresh worker pid/],
  ])('keeps %s in worker evidence as a crash', async (_name, workerLock, error) => {
    const dir = fixture();
    blockingPlanner(dir, workerLock);
    const report = await b.run({ root: dir });
    expect(report.violations).toEqual([{ invariant: 'crash', detail: expect.stringMatching(error) }]);
  }, 30000);
});
