// @vitest-environment node
import {afterEach, describe, expect, it, vi} from 'vitest';

vi.mock('node:child_process', () => ({spawnSync: vi.fn(() => ({status: 0}))}));
import * as precondition from './fixtures/ops-sudo-precondition.mjs';
const {spawnSync: realSpawnSync} = await vi.importActual('node:child_process');

afterEach(() => vi.clearAllMocks());

describe('ops sudo precondition', () => {
  it('does not skip when command-scoped sudo permits the required Python command', () => {
    const run = vi.fn((file, args) => ({status: file === '/usr/bin/sudo'
      && JSON.stringify(args) === JSON.stringify(['-n', '/usr/bin/python3', '-I', '-c', 'pass']) ? 0 : 1}));
    expect(precondition.probeOpsSudo({platform: 'linux', run, required: false})).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('/usr/bin/sudo', ['-n', '/usr/bin/python3', '-I', '-c', 'pass'],
      {stdio: 'ignore', timeout: 10000});
  });

  it.each(['darwin', 'win32'])('does not probe or skip on %s', platform => {
    const run = vi.fn();
    expect(precondition.probeOpsSudo({platform, run, required: false})).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('skips only a completed Linux probe with denied permission', () => {
    expect(precondition.probeOpsSudo({platform: 'linux', run: () => ({status: 1}), required: false})).toBe(true);
  });

  it.each([
    {status: null, error: Object.assign(new Error('missing sudo'), {code: 'ENOENT'})},
    {status: null, error: Object.assign(new Error('probe timed out'), {code: 'ETIMEDOUT'})},
    {status: null, signal: 'SIGTERM'},
  ])('fails on incomplete probe evidence: %j', result => {
    expect(() => precondition.probeOpsSudo({platform: 'linux', run: () => result, required: false}))
      .toThrow(result.error || /Incomplete ops sudo probe/);
  });

  it('fails rather than skips on an ops host when permission is denied', () => {
    expect(() => precondition.probeOpsSudo({platform: 'linux', run: () => ({status: 1}), required: true}))
      .toThrow(/required.*ops/i);
  });

  it.each([
    ['0', '0', '', 0, 'enabled'],
    ['1', '0', '', 0, 'skipped'],
    ['1', '1', '', 1, 'Required cross-identity'],
    ['0', '0', "throw new Error('test body failed');", 1, 'test body failed'],
  ])('wires module collection and consumer failures: status=%s required=%s body=%s', (status, required, body, expectedStatus, output) => {
    const fixture = new URL('./fixtures/ops-sudo-precondition.mjs', import.meta.url).href;
    const result = realSpawnSync(process.execPath, ['--input-type=module', '-e', `
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
Object.defineProperty(process, 'platform', {value: 'linux'});
process.env.FORGE_OPS_HOST = ${JSON.stringify(required)};
cp.spawnSync = (file, args) => ({status: ${status} === 0 && file === '/usr/bin/sudo'
  && JSON.stringify(args) === JSON.stringify(['-n', '/usr/bin/python3', '-I', '-c', 'pass']) ? 0 : 1});
syncBuiltinESMExports();
const {opsSudoMissing} = await import(${JSON.stringify(fixture)});
if (opsSudoMissing) console.log('skipped');
else { console.log('enabled'); ${body} }
`], {encoding: 'utf8', timeout: 10000, maxBuffer: 64 * 1024});
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(expectedStatus);
    expect(result.stdout + result.stderr).toContain(output);
  });
});
