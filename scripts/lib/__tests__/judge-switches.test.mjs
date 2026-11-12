/**
 * @file scripts/lib/__tests__/judge-switches.test.mjs
 * @description Hermetic fail-closed judge switch and operator CLI guarantees (#5063).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { JUDGE_SWITCHES_PATH } from '../judge-trusted-paths.mjs';
import {
  parseJudgeSwitches, planJudgeSwitchWrite, readJudgeSwitches, writeJudgeSwitches,
} from '../judge-switches.mjs';
import { main } from '../../conveyor/judge-switch.mjs';

let dir;
let path;
const at = '2026-11-10T12:00:00.000Z';
const metadata = { reason: 'operator test', by: 'test-session', at };
beforeEach(() => {
  dir = fs.mkdtempSync(join(process.env.TMPDIR, 'judge-switches-'));
  path = join(dir, 'nested', 'judge-switches.json');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function cli(argv, overrides = {}) {
  let stdout = '';
  let stderr = '';
  const code = main(argv, {
    fs, path, env: { CLAUDE_CODE_SESSION_ID: 'test-session' },
    now: () => new Date(at), userInfo: () => ({ username: 'test-user' }),
    stdout: { write: (s) => { stdout += s; } },
    stderr: { write: (s) => { stderr += s; } },
    ...overrides,
  });
  return { code, stdout, stderr };
}

describe('judge switch store', () => {
  it('kill switch blocks: off persists a state that parses as disabled', () => {
    expect(cli(['on', '--reason=test']).code).toBe(0);
    expect(cli(['off', '--reason=stop']).code).toBe(0);
    expect(parseJudgeSwitches(fs.readFileSync(path, 'utf8'))).toEqual({
      judgeEnabled: false, waitHours: 0, by: 'test-session', at, reason: 'stop',
    });
  });

  it('absent -> OFF store-absent; explicit on -> ON with no wait; deletion -> OFF', () => {
    expect(readJudgeSwitches({ fs, path })).toMatchObject({ judgeEnabled: false, parseError: 'store-absent' });
    expect(cli(['on', '--reason=test']).code).toBe(0);
    expect(readJudgeSwitches({ fs, path })).toEqual({ judgeEnabled: true, waitHours: 0, ...metadata, reason: 'test' });
    fs.unlinkSync(path);
    expect(readJudgeSwitches({ fs, path })).toMatchObject({ judgeEnabled: false, parseError: 'store-absent' });
  });

  it.each([
    ['truncated JSON', '{'], ['array', '[]'], ['null', 'null'],
    ['string flag', '{"judgeEnabled":"true"}'],
    ['negative wait', '{"judgeEnabled":true,"waitHours":-1}'],
    ['fractional wait', '{"judgeEnabled":true,"waitHours":1.5}'],
    ['oversized wait', '{"judgeEnabled":true,"waitHours":999}'],
    ['string wait', '{"judgeEnabled":true,"waitHours":"6"}'],
    ['wrong by', '{"judgeEnabled":true,"by":42}'],
    ['wrong at', '{"judgeEnabled":true,"at":false}'],
    ['wrong reason', '{"judgeEnabled":true,"reason":[]}'],
    ['missing flag', '{}'],
  ])('%s fails closed with an operator-visible parse error', (_, raw) => {
    fs.mkdirSync(join(dir, 'nested'));
    fs.writeFileSync(path, raw);
    expect(readJudgeSwitches({ fs, path })).toMatchObject({ judgeEnabled: false, parseError: expect.any(String) });
    const status = cli(['status']);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain('OFF');
    expect(JSON.parse(status.stdout).parseError).toBeTruthy();
  });

  it('unreadable store fails closed and names the read error', () => {
    const denied = { readFileSync: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } };
    expect(readJudgeSwitches({ fs: denied, path })).toMatchObject({ judgeEnabled: false, parseError: expect.stringContaining('EACCES') });
  });

  it('readable state defaults wait to zero and enables only literal true', () => {
    expect(parseJudgeSwitches('{"judgeEnabled":true}')).toMatchObject({ judgeEnabled: true, waitHours: 0 });
    expect(parseJudgeSwitches('{"judgeEnabled":false}')).toMatchObject({ judgeEnabled: false, waitHours: 0 });
    expect(parseJudgeSwitches(undefined)).toMatchObject({ judgeEnabled: false, parseError: 'store-absent' });
  });

  it('wait 6 and 0 are stored without enabling an absent or disabled judge', () => {
    expect(cli(['wait', '--hours=6', '--reason=delay']).code).toBe(0);
    expect(readJudgeSwitches({ fs, path })).toMatchObject({ judgeEnabled: false, waitHours: 6 });
    expect(cli(['on', '--reason=start']).code).toBe(0);
    expect(readJudgeSwitches({ fs, path })).toMatchObject({ judgeEnabled: true, waitHours: 6 });
    expect(cli(['wait', '--hours=0', '--reason=immediate']).code).toBe(0);
    expect(readJudgeSwitches({ fs, path })).toMatchObject({ judgeEnabled: true, waitHours: 0 });
  });

  it.each(['999', '1.5', '-1', '', 'NaN'])('refuses wait hours %j without changing the store', (hours) => {
    cli(['on', '--reason=test']);
    const before = fs.readFileSync(path, 'utf8');
    expect(cli(['wait', `--hours=${hours}`, '--reason=test']).code).toBe(2);
    expect(fs.readFileSync(path, 'utf8')).toBe(before);
  });

  it('accepts the upper wait bound and rejects nonnumeric pure-core input', () => {
    expect(planJudgeSwitchWrite({}, 'wait', { ...metadata, hours: 168 }).waitHours).toBe(168);
    expect(() => planJudgeSwitchWrite({}, 'wait', { ...metadata, hours: '6' })).toThrow();
  });

  it.each(['on', 'off', 'wait'])('%s without a nonblank reason is refused', (verb) => {
    for (const flags of [[], ['--reason='], ['--reason=   '], ['--reason']]) {
      expect(cli([verb, ...(verb === 'wait' ? ['--hours=6'] : []), ...flags]).code).toBe(2);
    }
    expect(fs.existsSync(path)).toBe(false);
    expect(() => planJudgeSwitchWrite({}, verb, { hours: 6 })).toThrow(/reason/);
  });

  it('records the session actor, OS fallback and ISO timestamp', () => {
    cli(['on', '--reason=test']);
    expect(readJudgeSwitches({ fs, path })).toMatchObject({ by: 'test-session', at });
    cli(['off', '--reason=test'], { env: {} });
    expect(readJudgeSwitches({ fs, path })).toMatchObject({ by: 'test-user', at });
  });

  it('atomically replaces complete JSON with exactly one rename and no leftover temp', () => {
    cli(['off', '--reason=old']);
    const old = fs.readFileSync(path, 'utf8');
    const renameSync = vi.fn((temp, target) => {
      expect(target).toBe(path);
      expect(fs.readFileSync(path, 'utf8')).toBe(old);
      expect(JSON.parse(fs.readFileSync(temp, 'utf8'))).toMatchObject({ judgeEnabled: true });
      fs.renameSync(temp, target);
    });
    writeJudgeSwitches(planJudgeSwitchWrite({}, 'on', metadata), { fs: { ...fs, renameSync }, path });
    expect(renameSync).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(join(dir, 'nested'))).toEqual(['judge-switches.json']);
    expect(readJudgeSwitches({ fs, path }).judgeEnabled).toBe(true);
  });

  it.each(['writeFileSync', 'renameSync'])('cleans the temp and preserves old state after %s failure', (method) => {
    cli(['off', '--reason=old']);
    const broken = { ...fs, [method]: (...args) => {
      if (method === 'writeFileSync') fs.writeFileSync(args[0], '{');
      throw new Error('disk failure');
    } };
    expect(() => writeJudgeSwitches(planJudgeSwitchWrite({}, 'on', metadata), { fs: broken, path })).toThrow('disk failure');
    expect(fs.readdirSync(join(dir, 'nested'))).toEqual(['judge-switches.json']);
    expect(readJudgeSwitches({ fs, path }).judgeEnabled).toBe(false);
  });

  it('status prints the injected path, state and absence error', () => {
    expect(JSON.parse(cli(['status']).stdout)).toMatchObject({ path, state: 'OFF', parseError: 'store-absent' });
  });

  it('rejects unknown verbs and flags, including any path override', () => {
    expect(cli(['start']).code).toBe(2);
    expect(cli(['status', `--path=${path}`]).code).toBe(2);
    expect(cli(['on', '--reason=test', `--path=${path}`]).code).toBe(2);
    expect(fs.existsSync(path)).toBe(false);
  });
});

it('fixed OS-account path ignores env/cwd and never reads a forged override store', async () => {
  const forged = join(dir, 'judge-switches.json');
  fs.writeFileSync(forged, '{"judgeEnabled":true}');
  vi.stubEnv('HOME', dir);
  vi.stubEnv('WE_COORDINATION_ROOT', dir);
  vi.stubEnv('WE_JUDGE_SWITCHES_PATH', forged);
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
  const fresh = await import(`../judge-trusted-paths.mjs?fixed-path-test`);
  const expected = join(os.userInfo().homedir, 'workspace/.operations/coordination/judge-switches.json');
  expect(Object.keys(fresh)).toEqual(['JUDGE_SWITCHES_PATH']);
  expect(fresh.JUDGE_SWITCHES_PATH).toBe(expected);
  expect(JUDGE_SWITCHES_PATH).toBe(expected);
  const readFileSync = vi.fn((target) => {
    expect(target).toBe(expected);
    throw Object.assign(new Error('absent fixture'), { code: 'ENOENT' });
  });
  expect(readJudgeSwitches({ fs: { readFileSync } })).toMatchObject({ judgeEnabled: false, parseError: 'store-absent' });
  const status = cli(['status'], { path: undefined, fs: { readFileSync } });
  expect(JSON.parse(status.stdout)).toMatchObject({ path: expected, state: 'OFF', parseError: 'store-absent' });
  expect(readFileSync).toHaveBeenCalledTimes(2);
});

it('reads OFF even when the fs throws a non-Error or a hostile object', () => {
  const hostile = { get code() { throw new Error('boom'); } };
  for (const thrown of [null, undefined, hostile]) {
    const fs = { readFileSync() { throw thrown; } };
    const out = readJudgeSwitches({ path: '/x', fs });
    expect(out.judgeEnabled).toBe(false);
    expect(out.parseError).toBeTruthy();
  }
});
