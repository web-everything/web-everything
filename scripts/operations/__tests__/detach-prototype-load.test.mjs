/** @file Detached prototype-load routing and same-job resume contract. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { maybeHandleDetach } from '../run.mjs';
import { PROTOTYPE_LOAD_OP } from '../prototype-load.mjs';

const scriptPath = resolve(process.cwd(), 'scripts/operations/run.mjs');
let dir;
beforeEach(() => {
  dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'prototype-load-detach-'));
  vi.stubEnv('DETACHED_OPS_DIR', dir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('maybeHandleDetach', () => {
  it.each([['done', 0, 0], ['failed', 7, 1], ['running', null, 75]])(
    'flushes both full log tails through a pipe for a %s CLI wait', (status, exitCode, code) => {
      const id = 'large-response';
      // Quotes, newlines and Unicode also exercise JSON escaping and byte lengths.
      const log = '"\n雪'.repeat(20000);
      const stdoutPath = join(dir, `${id}.stdout.log`);
      const stderrPath = join(dir, `${id}.stderr.log`);
      writeFileSync(stdoutPath, log);
      writeFileSync(stderrPath, log);
      writeFileSync(join(dir, `${id}.json`), JSON.stringify({
        id, kind: 'prototype-load', status, exitCode, pid: process.pid, stdoutPath, stderrPath,
      }));
      const result = spawnSync(process.execPath,
        [scriptPath, PROTOTYPE_LOAD_OP, `--wait-for=${id}`, '--max-wait-ms=250'],
        { env: process.env, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stderr).toBe(code);
      const response = JSON.parse(result.stdout);
      const expectedTail = Buffer.from(log).subarray(-65536).toString('utf8');
      expect(response).toMatchObject({ id, status, exitCode, code,
        stdoutTail: expectedTail, stderrTail: expectedTail });
      expect(result.stdout).toBe(`${JSON.stringify(response)}\n`);
    }, 20000,
  );

  it.each([
    ['review-pr', ['--detach']],
    ['review-pr', ['--wait-for=job']],
    [PROTOTYPE_LOAD_OP, ['--help']],
    [PROTOTYPE_LOAD_OP, []],
  ])('leaves %s %j on the normal operation path', async (name, rest) => {
    const spawnFn = vi.fn();
    const out = vi.fn();
    expect(await maybeHandleDetach(name, rest, { spawnFn, out })).toBeNull();
    expect(spawnFn).not.toHaveBeenCalled();
    expect(out).not.toHaveBeenCalled();
  });

  async function launch() {
    const unref = vi.fn();
    const spawnFn = vi.fn(() => ({ pid: process.pid, unref }));
    const out = vi.fn();
    const rest = ['--detach', '--example=value', 'input with spaces'];
    expect(await maybeHandleDetach(PROTOTYPE_LOAD_OP, rest, { spawnFn, out })).toBe(0);
    expect(rest).toEqual(['--detach', '--example=value', 'input with spaces']);
    expect(out).toHaveBeenCalledOnce();
    const record = JSON.parse(out.mock.calls[0][0]);
    expect(record.id).toEqual(expect.stringMatching(/^[A-Za-z0-9][A-Za-z0-9_-]*$/));
    return { record, spawnFn, unref };
  }

  it('spawns run.mjs prototype-load with remaining argv, persists a running record and prints its id', async () => {
    const { record, spawnFn, unref } = await launch();
    expect(spawnFn).toHaveBeenCalledTimes(2);
    const [command, argv, options] = spawnFn.mock.calls[0];
    expect(command).toBe(process.execPath);
    expect(argv.slice(argv.indexOf('--') + 1)).toEqual([
      process.execPath, scriptPath, PROTOTYPE_LOAD_OP, '--example=value', 'input with spaces',
    ]);
    expect(argv).not.toContain('--detach');
    expect(options).toMatchObject({ detached: true, env: { DETACHED_OPS_DIR: dir } });
    expect(unref).toHaveBeenCalledTimes(2);
    expect(record).toMatchObject({ kind: 'prototype-load', status: 'running', exitCode: null });
    expect(JSON.parse(readFileSync(join(dir, `${record.id}.json`), 'utf8'))).toEqual(record);
  });

  it('resumes the SAME record: running returns 75, done returns 0, failed returns 1', async () => {
    const { record, spawnFn } = await launch();
    const path = join(dir, `${record.id}.json`);
    let clock = 0;
    const out = vi.fn();
    const wait = () => maybeHandleDetach(PROTOTYPE_LOAD_OP,
      [`--wait-for=${record.id}`, '--max-wait-ms=250'], {
        out, spawnFn, now: () => clock, isAlive: () => true,
        sleep: async ms => { clock += ms; },
      });
    expect(await wait()).toBe(75);
    expect(JSON.parse(out.mock.lastCall[0])).toMatchObject({ id: record.id, status: 'running', code: 75 });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(record);
    writeFileSync(path, JSON.stringify({ ...record, status: 'done', exitCode: 0 }));
    expect(await wait()).toBe(0);
    expect(JSON.parse(out.mock.lastCall[0])).toMatchObject({ id: record.id, status: 'done', exitCode: 0 });
    writeFileSync(path, JSON.stringify({ ...record, status: 'failed', exitCode: 3 }));
    expect(await wait()).toBe(1);
    expect(JSON.parse(out.mock.lastCall[0])).toMatchObject({ id: record.id, status: 'failed', exitCode: 3 });
    expect(spawnFn).toHaveBeenCalledTimes(2);
  });

  it('T10: routes prototype-load cancellation through the shared record without launching work', async () => {
    const { record, spawnFn } = await launch();
    const out = vi.fn();
    let time = 0;
    expect(await maybeHandleDetach(PROTOTYPE_LOAD_OP, [`--cancel=${record.id}`, '--max-wait-ms=250'], {
      out, spawnFn, isAlive: async () => null, now: () => time, sleep: async ms => { time += ms; },
    })).toBe(75);
    expect(JSON.parse(out.mock.lastCall[0])).toMatchObject({ id: record.id, code: 75, liveness: 'unknown' });
    expect(readFileSync(join(dir, `${record.id}.json.cancel`), 'utf8')).toBe('SIGTERM\n');
    expect(spawnFn).toHaveBeenCalledTimes(2);
  });

  it('T10: real prototype-load CLI rejects an unknown cancellation id', () => {
    const result = spawnSync(process.execPath, [scriptPath, PROTOTYPE_LOAD_OP, '--cancel=missing'], {
      env: process.env, encoding: 'utf8', timeout: 15000,
    });
    expect(result.status, result.stderr).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ code: 1, reason: 'unknown-job' });
  });
});
