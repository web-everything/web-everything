/** @file Detached prototype-load routing and same-job resume contract. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    expect(spawnFn).toHaveBeenCalledOnce();
    const [command, argv, options] = spawnFn.mock.calls[0];
    expect(command).toBe(process.execPath);
    expect(argv.slice(argv.indexOf('--') + 1)).toEqual([
      process.execPath, scriptPath, PROTOTYPE_LOAD_OP, '--example=value', 'input with spaces',
    ]);
    expect(argv).not.toContain('--detach');
    expect(options).toMatchObject({ detached: true, env: { DETACHED_OPS_DIR: dir } });
    expect(unref).toHaveBeenCalledOnce();
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
    expect(spawnFn).toHaveBeenCalledOnce();
  });
});
