/** @file Real admission CLI detach, bounded wait and command-tail preservation contract. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { main, tryAcquireSlot } from '../heavy-admission.mjs';
import { startDetachedOp } from '../../lib/detached-op.mjs';

vi.mock('../../lib/detached-op.mjs', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, startDetachedOp: vi.fn(actual.startDetachedOp) };
});

const CLI = resolve(process.cwd(), 'scripts/readiness/heavy-admission.mjs');
const waitModes = [['bare', []], ['run', ['run']], ['status', ['status']]];
let root, lockRoot, env;
beforeEach(() => {
  root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'heavy-admission-detach-'));
  const pool = join(root, '.lanes');
  lockRoot = join(pool, '.admission', 'heavy');
  mkdirSync(lockRoot, { recursive: true });
  env = {
    ...process.env, LANE_POOL_ROOT: pool, DETACHED_OPS_DIR: join(root, 'ops'),
    WE_PLATFORM_PREFERENCES: join(root, 'no-preferences.json'),
    WE_HEAVY_ADMISSION_CAP: '1', WE_HEAVY_ADMISSION_FAST_SLOTS: '0',
    WE_HEAVY_ADMISSION_RUN_WAIT_MS: '0', WE_HEAVY_ADMISSION_CONTAINER: '0',
    WE_HEAVY_ADMISSION_CONTAINER_NODE_MODULES: '0',
    VITEST: 'true', WE_TEST_HOST_LOAD1: '0', WE_TEST_HOST_MEMORY_MB: '16384',
    WE_RESOURCE_SHADOW: 'off', WE_RESOURCE_CUTOVER: 'shadow',
  };
  delete env.CI;
  delete env.WE_HEAVY_ADMISSION;
  delete env.WE_HEAVY_ADMISSION_HELD;
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function cli(args, status = 0, timeout = 25_000) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: root, env, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024,
  });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(status);
  return result.stdout.trim();
}
function detach(source, tail = []) {
  // A foreground implementation must hit this short timeout for a long wrapped command.
  const stdout = cli(['run', '--detach', '--', process.execPath, '-e', source, ...tail], 0, 2500);
  expect(stdout.split('\n')).toHaveLength(1);
  const record = JSON.parse(stdout);
  expect(record.id).toEqual(expect.stringMatching(/^[A-Za-z0-9][A-Za-z0-9_-]*$/));
  return record.id;
}
function wait(id, { mode = [], maxWaitMs = 20_000, status = 0 } = {}) {
  return JSON.parse(cli([...mode, `--wait-for=${id}`, `--max-wait-ms=${maxWaitMs}`], status));
}
function holdSlot() {
  const nowMs = Date.now();
  expect(tryAcquireSlot({ lockRoot, cap: 1, owner: 'test-holder',
    nowMs, nowIso: new Date(nowMs).toISOString() }).ok).toBe(true);
}

describe('heavy-admission detached CLI', () => {
  it.each([
    ['SIGTERM', 143, false], ['SIGINT', 130, false], ['SIGHUP', 129, false], ['SIGTERM', 143, true],
  ])('stops the command subtree after runner %s (exit %s, detached descendant %s)', async (signal, exitCode, detached) => {
    const started = join(root, 'command-started');
    const survived = join(root, 'command-survived');
    const descendantStarted = join(root, 'descendant-started');
    const descendantSurvived = join(root, 'descendant-survived');
    const descendantSource = `
      const fs = require('node:fs');
      process.on('SIGTERM', () => {});
      fs.writeFileSync(${JSON.stringify(descendantStarted)}, String(process.pid));
      setInterval(() => fs.writeFileSync(${JSON.stringify(descendantSurvived)}, 'DESCENDANT_SURVIVED'), 50);
      setTimeout(() => process.exit(0), 20000);
    `;
    const source = `
      const fs = require('node:fs');
      require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}],
        { detached: ${detached}, stdio: 'ignore' });
      process.on('SIGTERM', () => {});
      process.on('SIGINT', () => {});
      process.on('SIGHUP', () => {});
      fs.writeFileSync(${JSON.stringify(started)}, String(process.pid));
      setInterval(() => fs.writeFileSync(${JSON.stringify(survived)}, 'COMMAND_SURVIVED'), 50);
      setTimeout(() => process.exit(0), 20000);
    `;
    const record = JSON.parse(cli(['run', '--detach', '--', process.execPath, '-e', source]));
    let commandPid, descendantPid;
    try {
      await vi.waitFor(() => expect(existsSync(started)).toBe(true), { timeout: 12000, interval: 25 });
      commandPid = Number(readFileSync(started, 'utf8'));
      await vi.waitFor(() => expect(existsSync(descendantStarted)).toBe(true), { timeout: 12000, interval: 25 });
      descendantPid = Number(readFileSync(descendantStarted, 'utf8'));
      process.kill(record.pid, signal);
      const result = wait(record.id, { status: 1 });
      expect(result).toMatchObject({ status: 'failed', code: 1, exitCode });
      rmSync(survived, { force: true });
      rmSync(descendantSurvived, { force: true });
      await new Promise(done => setTimeout(done, 250));
      expect(existsSync(survived), 'command kept executing after wait reported terminal failure').toBe(false);
      expect(existsSync(descendantSurvived), 'descendant kept executing after wait reported terminal failure').toBe(false);
      expect(result.reason).not.toBe('runner-died');
      // A forcibly stopped admission holder is reclaimed on the next acquisition.
      expect(cli(['run', '--', process.execPath, '-e', "console.log('reclaimed')"])).toBe('reclaimed');
    } finally {
      if (descendantPid) { try { process.kill(descendantPid, 'SIGKILL'); } catch {} }
      if (commandPid) { try { process.kill(commandPid, 'SIGKILL'); } catch {} }
      try { process.kill(-record.pid, 'SIGKILL'); } catch {}
    }
  }, 30_000);

  it('passes a fresh environment without inherited admission ownership to startDetachedOp', async () => {
    const stopped = new Error('stop before launching the detached runner');
    vi.stubEnv('WE_HEAVY_ADMISSION_HELD', '1');
    vi.stubEnv('DETACHED_OPS_DIR', env.DETACHED_OPS_DIR);
    startDetachedOp.mockRejectedValueOnce(stopped);
    try {
      await expect(main(['run', '--detach', '--', process.execPath, '-e', '']))
        .rejects.toBe(stopped);
      const options = startDetachedOp.mock.lastCall[0];
      expect(options.env).toBeDefined();
      expect(options.env).not.toHaveProperty('WE_HEAVY_ADMISSION_HELD');
      expect(options.env.DETACHED_OPS_DIR).toBe(env.DETACHED_OPS_DIR);
      expect(process.env.WE_HEAVY_ADMISSION_HELD).toBe('1');
    } finally {
      vi.unstubAllEnvs();
      startDetachedOp.mockClear();
    }
  });

  it.each(waitModes)('detaches hi under admission and waits without a command tail (mode %s)', (_label, mode) => {
    const id = detach("if (process.env.WE_HEAVY_ADMISSION_HELD !== '1') process.exit(9); console.log('hi')");
    expect(wait(id, { mode })).toMatchObject({ id, status: 'done', exitCode: 0, stdoutTail: 'hi\n' });
  }, 30_000);

  it('maps a wrapped exit 3 to wait exit 1 while preserving exitCode 3', () => {
    const id = detach('process.exit(3)');
    expect(wait(id, { status: 1 })).toMatchObject({ id, status: 'failed', exitCode: 3 });
  }, 30_000);

  it('reacquires admission for a nested detached command after its outer wrapper releases', async () => {
    const started = join(root, 'started');
    const finish = join(root, 'finish');
    const source = `
      const fs = require('node:fs');
      fs.writeFileSync(${JSON.stringify(started)}, 'started');
      const timer = setInterval(() => {
        if (fs.existsSync(${JSON.stringify(finish)})) clearInterval(timer);
      }, 25);
      setTimeout(() => process.exit(2), 15000).unref();
    `;
    const record = JSON.parse(cli(['run', '--', process.execPath, CLI,
      'run', '--detach', '--wait-ms=10000', '--', process.execPath, '-e', source], 0, 5000));
    try {
      await vi.waitFor(() => expect(existsSync(started)).toBe(true), { timeout: 12000, interval: 25 });
      expect(JSON.parse(cli(['status'])).heldCount).toBe(1);
      expect(cli(['run', '--wait-ms=250', '--', process.execPath, '-e', "console.log('overlap')"], 75)).toBe('');
    } finally {
      writeFileSync(finish, 'finish');
      expect(wait(record.id)).toMatchObject({ status: 'done', exitCode: 0 });
    }
  }, 30_000);

  it('defers a detached command with inherited ownership when the pool stays full', () => {
    holdSlot();
    env.WE_HEAVY_ADMISSION_HELD = '1';
    const record = JSON.parse(cli(['run', '--detach', '--wait-ms=250', '--',
      process.execPath, '-e', "console.log('overlap')"]));
    expect(wait(record.id, { status: 1 })).toMatchObject({
      status: 'failed', exitCode: 75, stdoutTail: '',
    });
    expect(JSON.parse(cli(['status'])).heldCount).toBe(1);
  }, 30_000);

  it.each([false, true])('preserves all detach-like flags after -- (detached=%s)', detached => {
    const source = "console.log(process.argv.slice(1).join(','))";
    const tail = ['--', '--detach', '--wait-for=wrapped', '--max-wait-ms=wrapped', '--cancel=wrapped'];
    const expected = '--detach,--wait-for=wrapped,--max-wait-ms=wrapped,--cancel=wrapped';
    if (detached) {
      const id = detach(source, tail);
      expect(wait(id)).toMatchObject({ id, stdoutTail: `${expected}\n`, exitCode: 0 });
    } else {
      expect(cli(['run', '--', process.execPath, '-e', source, ...tail])).toBe(expected);
    }
  }, 30_000);

  it('returns 75 for a still-running job, then resumes the SAME id to completion', () => {
    const id = detach("setTimeout(() => console.log('finished'), 3000)");
    expect(wait(id, { maxWaitMs: 250, status: 75 })).toMatchObject({ id, status: 'running', exitCode: null });
    expect(wait(id, { mode: ['run'] })).toMatchObject({ id, status: 'done', exitCode: 0, stdoutTail: 'finished\n' });
  }, 30_000);

  it.each(waitModes)('fails closed on an unknown job without acquiring a full pool (mode %s)', (_label, mode) => {
    holdSlot();
    expect(wait('unknown-job', { mode, maxWaitMs: 250, status: 1 })).toMatchObject({
      id: 'unknown-job', status: 'failed', reason: 'unknown-job',
    });
  });

  it.each(waitModes)('T10: cancellation takes no admission slot (mode %s)', (_label, mode) => {
    holdSlot();
    expect(JSON.parse(cli([...mode, '--cancel=missing', '--max-wait-ms=250'], 1)))
      .toMatchObject({ code: 1, reason: 'unknown-job' });
    expect(JSON.parse(cli(['status'])).heldCount).toBe(1);
  });

  it('T10: real cancellation stops a running admission job and leaves its slot reclaimable', async () => {
    const started = join(root, 'cancel-started');
    const pulse = join(root, 'cancel-pulse');
    const id = detach(`
      const fs = require('node:fs');
      fs.writeFileSync(${JSON.stringify(started)}, 'ready');
      process.on('SIGTERM', () => {});
      setInterval(() => fs.writeFileSync(${JSON.stringify(pulse)}, 'alive'), 25);
      setTimeout(() => process.exit(0), 20000);
    `);
    await vi.waitFor(() => expect(existsSync(started)).toBe(true), { timeout: 10000 });
    expect(JSON.parse(cli([`--cancel=${id}`, '--max-wait-ms=15000'], 1)))
      .toMatchObject({ code: 1, status: 'failed', exitCode: 143, reason: 'cancelled' });
    rmSync(pulse, { force: true });
    await new Promise(done => setTimeout(done, 250));
    expect(existsSync(pulse)).toBe(false);
    expect(cli(['run', '--', process.execPath, '-e', "console.log('reclaimed')"])).toBe('reclaimed');
  }, 30000);
});
