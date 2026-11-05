import { describe, it, expect, beforeEach } from 'vitest';
import * as pm from '../package-manager.mjs';
import { resetCascadeLogForTest } from '../policy-cascade.mjs';

// Hermetic: never read the machine's real platform preferences unless a test passes its own reader.
const clean = () => ({ prefs: {}, errors: [] });
const wrap = (f) => (o = {}) => f({ readPlatform: clean, ...o });
const resolvePackageManager = wrap(pm.resolvePackageManager);
const installArgv = wrap(pm.installArgv);
const installCommand = wrap(pm.installCommand);
const installWithFallback = wrap(pm.installWithFallback);
const none = { env: {}, platform: undefined, readPlatform: () => ({ prefs: {}, errors: [] }) };
beforeEach(() => resetCascadeLogForTest());

describe('resolvePackageManager cascade', () => {
  it('standard default is npm', () => {
    const r = resolvePackageManager({ ...none });
    expect(r.manager).toBe('npm');
    expect(r.source).toBe('standard');
  });
  it('platform beats standard', () => {
    const r = resolvePackageManager({ env: {}, platform: 'pnpm' });
    expect(r).toMatchObject({ manager: 'pnpm', source: 'platform' });
  });
  it('repo (tool) beats platform', () => {
    const r = resolvePackageManager({ env: {}, platform: 'pnpm', tool: 'npm' });
    expect(r).toMatchObject({ manager: 'npm', source: 'tool' });
  });
  it('env WE_PACKAGE_MANAGER beats repo', () => {
    const r = resolvePackageManager({ env: { WE_PACKAGE_MANAGER: 'pnpm' }, platform: 'npm', tool: 'npm' });
    expect(r).toMatchObject({ manager: 'pnpm', source: 'env' });
  });
  it('blank env is unset', () => {
    expect(resolvePackageManager({ env: { WE_PACKAGE_MANAGER: '  ' }, platform: 'pnpm' }).source).toBe('platform');
  });
  it('unknown value with a frozen install is refused without a parity proof, allowed with one', () => {
    const o = { ci: true, env: { WE_PACKAGE_MANAGER: 'yarn' }, platform: 'pnpm' };
    expect(() => installArgv(o)).toThrow(/lockfileParity/);
    expect(installArgv({ ...o, lockfileParity: () => true })).toMatchObject({ bin: 'npm', args: ['ci'] });
  });
  it('unknown value fails closed to npm even when a lower layer says pnpm', () => {
    const r = resolvePackageManager({ env: { WE_PACKAGE_MANAGER: 'yarn' }, platform: 'pnpm' });
    expect(r.manager).toBe('npm');
    expect(r.source).toBe('env');
    expect(r.note).toMatch(/unknown.*yarn/);
  });
  it('logs the effective value and source', () => {
    const lines = [];
    resolvePackageManager({ env: { WE_PACKAGE_MANAGER: 'pnpm', WE_POLICY_CASCADE_LOG: '1' }, platform: undefined, log: (l) => lines.push(l) });
    expect(lines.join('\n')).toMatch(/packageManager.*pnpm.*env/);
  });
});

describe('unreadable platform preferences', () => {
  const bad = () => ({ prefs: {}, errors: ['prefs.json: Unexpected token'] });
  it('is flagged on the resolution', () => {
    expect(resolvePackageManager({ env: {}, readPlatform: bad }).degraded).toMatch(/unreadable/);
  });
  it('a frozen install is refused without a parity proof, allowed with one', () => {
    expect(() => installArgv({ ci: true, env: {}, readPlatform: bad })).toThrow(/lockfileParity/);
    expect(installArgv({ ci: true, env: {}, readPlatform: bad, lockfileParity: () => true }).args).toEqual(['ci']);
  });
});

describe('degraded platform layer', () => {
  it.each([['empty object', {}], ['null', null], ['number', 3]])('invalid platform value (%s) is flagged and gates a frozen install', (_n, platform) => {
    const prefs = () => ({ prefs: { packageManager: platform }, errors: [] });
    expect(resolvePackageManager({ env: {}, readPlatform: prefs }).degraded).toMatch(/invalid platform/);
    expect(() => installArgv({ ci: true, env: {}, readPlatform: prefs })).toThrow(/lockfileParity/);
  });
  it('a configured-but-missing preferences file is flagged', () => {
    const r = resolvePackageManager({ env: { WE_PLATFORM_PREFERENCES_FILE: '/nonexistent/we-prefs.json' } });
    expect(r.degraded).toMatch(/missing/);
    expect(() => installArgv({ ci: true, env: { WE_PLATFORM_PREFERENCES_FILE: '/nonexistent/we-prefs.json' } })).toThrow(/lockfileParity/);
  });
});

describe('installArgv / installCommand', () => {
  it('npm: ci when frozen, install otherwise', () => {
    expect(installArgv({ ci: true, ...none })).toMatchObject({ bin: 'npm', args: ['ci'], manager: 'npm' });
    expect(installArgv({ ci: false, ...none }).args).toEqual(['install']);
  });
  it('pnpm: --frozen-lockfile when ci', () => {
    const r = installArgv({ ci: true, env: { WE_PACKAGE_MANAGER: 'pnpm' }, platform: undefined, pnpmVersion: () => '9' });
    expect(r).toMatchObject({ bin: 'pnpm', args: ['install', '--frozen-lockfile'], manager: 'pnpm', source: 'env' });
  });
  it('ignoreScripts adds --ignore-scripts for both', () => {
    expect(installArgv({ ci: true, ignoreScripts: true, ...none }).args).toEqual(['ci', '--ignore-scripts']);
    expect(installArgv({ ci: true, ignoreScripts: true, env: { WE_PACKAGE_MANAGER: 'pnpm' }, pnpmVersion: () => '9' }).args)
      .toEqual(['install', '--frozen-lockfile', '--ignore-scripts']);
  });
  it('pnpm falls back to npm when pnpm --version fails, and says why', () => {
    const r = installArgv({ ci: true, lockfileParity: () => true, env: { WE_PACKAGE_MANAGER: 'pnpm' }, pnpmVersion: () => { throw Object.assign(new Error('no pnpm'), { code: 'ENOENT' }); } });
    expect(r).toMatchObject({ bin: 'npm', args: ['ci'], manager: 'npm' });
    expect(r.note).toMatch(/pnpm --version failed/);
  });
  it('installCommand({frozen}) maps frozen to ci', () => {
    expect(installCommand({ frozen: true, ...none })).toBe('npm ci');
    expect(installCommand({ frozen: false, env: { WE_PACKAGE_MANAGER: 'pnpm' }, pnpmVersion: () => '9' })).toBe('pnpm install');
  });
});

describe('frozen cannot be weakened by passthrough options', () => {
  it('installCommand ignores a stray ci:false and keeps the frozen install', () => {
    expect(installCommand({ frozen: true, ci: false, env: {} })).toBe('npm ci');
  });
  it('installWithFallback keeps ci when frozen even with a stray ci:false', () => {
    const calls = [];
    installWithFallback({ frozen: true, ci: false, env: {}, exec: (b, a) => calls.push([b, ...a]) });
    expect(calls).toEqual([['npm', 'ci']]);
  });
  it('installCommand logs the fallback note when pnpm is unusable', () => {
    const logs = [];
    const cmd = installCommand({ frozen: true, lockfileParity: () => true, env: { WE_PACKAGE_MANAGER: 'pnpm' }, pnpmVersion: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); }, log: (l) => logs.push(l) });
    expect(cmd).toBe('npm ci');
    expect(logs.join('')).toMatch(/pnpm --version failed/);
  });
});

describe('version probe fails closed on integrity-class errors', () => {
  it('rethrows an integrity failure instead of switching to npm', () => {
    expect(() => installArgv({ ci: true, env: { WE_PACKAGE_MANAGER: 'pnpm' }, pnpmVersion: () => { throw new Error('ERR_PNPM_TARBALL_INTEGRITY'); } })).toThrow(/INTEGRITY/);
  });
  it('rethrows an unclassified probe failure such as a signature rejection', () => {
    expect(() => installArgv({ ci: true, env: { WE_PACKAGE_MANAGER: 'pnpm' }, pnpmVersion: () => { throw new Error('Cannot find matching keyid'); } })).toThrow(/keyid/);
  });
  it('a missing pnpm (ENOENT) still falls back to npm', () => {
    const r = installArgv({ ci: true, lockfileParity: () => true, env: { WE_PACKAGE_MANAGER: 'pnpm' }, pnpmVersion: () => { throw Object.assign(new Error('spawn pnpm'), { code: 'ENOENT' }); } });
    expect(r.manager).toBe('npm');
  });
});

describe('a frozen probe fallback needs a parity proof', () => {
  it.each([['no proof', undefined], ['proof false', () => false], ['proof throws', () => { throw new Error('x'); }]])('refuses npm ci (%s)', (_n, lockfileParity) => {
    expect(() => installArgv({ ci: true, lockfileParity, env: { WE_PACKAGE_MANAGER: 'pnpm' }, pnpmVersion: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); } })).toThrow(/lockfileParity/);
  });
  it('a non-frozen install falls back to npm install without a proof', () => {
    const r = installArgv({ ci: false, env: { WE_PACKAGE_MANAGER: 'pnpm' }, pnpmVersion: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); } });
    expect(r).toMatchObject({ bin: 'npm', args: ['install'] });
  });
});

describe('installWithFallback', () => {
  it('runs pnpm and does not touch npm on success', () => {
    const calls = [];
    const r = installWithFallback({ frozen: true, env: { WE_PACKAGE_MANAGER: 'pnpm' }, pnpmVersion: () => '9',
      exec: (bin, args) => { calls.push([bin, ...args]); } });
    expect(calls).toEqual([['pnpm', 'install', '--frozen-lockfile']]);
    expect(r.fellBack).toBe(false);
  });
  it('a failed pnpm install falls back to npm ci and logs it (parity proven)', () => {
    const calls = []; const logs = [];
    const r = installWithFallback({ frozen: true, lockfileParity: () => true, env: { WE_PACKAGE_MANAGER: 'pnpm' }, pnpmVersion: () => '9', log: (l) => logs.push(l),
      exec: (bin, args) => { calls.push([bin, ...args]); if (bin === 'pnpm') throw Object.assign(new Error('ERR_PNPM_FETCH_FAIL GET registry'), { stderr: 'ERR_PNPM_FETCH_FAIL' }); } });
    expect(calls).toEqual([['pnpm', 'install', '--frozen-lockfile'], ['npm', 'ci']]);
    expect(r).toMatchObject({ fellBack: true, manager: 'npm', pnpmError: 'ERR_PNPM_FETCH_FAIL GET registry' });
    
    expect(logs.join('\n')).toMatch(/pnpm install failed.*falling back to npm ci/);
  });
  it.each([
    ['lockfile refusal on stderr', { stderr: 'ERR_PNPM_OUTDATED_LOCKFILE frozen-lockfile' }],
    ['lockfile refusal on stdout', { stdout: 'ERR_PNPM_OUTDATED_LOCKFILE frozen-lockfile' }],
    ['integrity failure', { stderr: 'ERR_PNPM_TARBALL_INTEGRITY' }],
    ['lifecycle script failure', { stderr: 'ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL postinstall' }],
    ['unrecognised failure', {}],
    ['fetch failure alongside a signature rejection', { stderr: 'ERR_PNPM_FETCH_FAIL Cannot find matching keyid' }],
    ['fetch failure alongside a lifecycle failure', { stderr: 'ERR_PNPM_FETCH_FAIL ELIFECYCLE' }],
    ['timeout carrying a lifecycle failure', { code: 'ETIMEDOUT', stderr: 'ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL' }],
    ['spawn code carrying an integrity code', { code: 'ENOENT', stderr: 'ERR_PNPM_TARBALL_INTEGRITY' }],
    ['lifecycle failure that merely mentions ENOENT', { stderr: 'ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL postinstall ENOENT' }],
    ['lockfile refusal alongside a network word', { stderr: 'ERR_PNPM_OUTDATED_LOCKFILE ENOTFOUND' }],
  ])('fails closed (no npm fallback) on %s', (_n, extra) => {
    const calls = []; const logs = [];
    expect(() => installWithFallback({ frozen: true, lockfileParity: () => true, env: { WE_PACKAGE_MANAGER: 'pnpm' }, pnpmVersion: () => '9', log: (l) => logs.push(l),
      exec: (bin, args) => { calls.push([bin, ...args]); throw Object.assign(new Error('pnpm failed'), extra); } })).toThrow('pnpm failed');
    expect(calls).toEqual([['pnpm', 'install', '--frozen-lockfile']]);
    expect(logs.join('\n')).toMatch(/NOT falling back/);
  });
  it.each([['no proof supplied', undefined], ['proof says false', () => false], ['proof throws', () => { throw new Error('x'); }]])(
    'a frozen fallback is refused when lockfile parity is not proven (%s)', (_n, lockfileParity) => {
      const calls = [];
      expect(() => installWithFallback({ frozen: true, lockfileParity, env: { WE_PACKAGE_MANAGER: 'pnpm' }, pnpmVersion: () => '9', log: () => {},
        exec: (bin, args) => { calls.push([bin, ...args]); throw Object.assign(new Error('ERR_PNPM_FETCH_FAIL'), {}); } })).toThrow();
      expect(calls).toEqual([['pnpm', 'install', '--frozen-lockfile']]);
    });
  it('a non-frozen install falls back on a network failure without a parity proof', () => {
    const calls = [];
    const r = installWithFallback({ frozen: false, env: { WE_PACKAGE_MANAGER: 'pnpm' }, pnpmVersion: () => '9', log: () => {},
      exec: (bin, args) => { calls.push([bin, ...args]); if (bin === 'pnpm') throw new Error('ERR_PNPM_FETCH_FAIL'); } });
    expect(calls).toEqual([['pnpm', 'install'], ['npm', 'install']]);
    expect(r.fellBack).toBe(true);
  });
  it('a failed npm install propagates (no silent success)', () => {
    expect(() => installWithFallback({ frozen: true, env: {}, exec: () => { throw new Error('npm down'); } })).toThrow('npm down');
  });
});
