// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { parse as parseJavaScript } from 'acorn';
import { basename, join, parse, resolve } from 'node:path';
import { boundedGitCommand, BOUNDED_GIT_GRACE_MS } from '../lib/git-bounded.mjs';
import { NETWORK_GIT_TIMEOUT_MS } from '../lib/bounded-child.mjs';
import { findRawPushes } from '../lib/push-gate-lint.mjs';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';
import { gitRun } from '../lib/git-run.mjs';
import { hardenLaneGitArgs, laneGitHardeningEnv, LANE_GIT_CONFIG_PINS, scrubGitRepoEnv } from '../lib/lane-git-hardening.mjs';
import { resolveSiblingRepoName, siblingCloneStatus, provisionMissingSiblingClones } from '../lib/sibling-clone-provision.mjs';
import { runInProcess, childProcessMock } from './fixtures/merge-ai-prs-cli-harness.mjs';
import { createPrestageWorld } from './fixtures/merge-ai-prs-prestage-world.mjs';
import { prestagePorts } from './fixtures/merge-ai-prs-fake-ports.mjs';

vi.mock('../lib/git-run.mjs', () => ({ gitRun: vi.fn() }));
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, userInfo: vi.fn(actual.userInfo) };
});

const roots = [];
afterEach(() => {
  vi.mocked(gitRun).mockReset();
  vi.doUnmock('node:child_process');
  vi.doUnmock('../lib/sibling-clone-provision.mjs');
  vi.doUnmock('../readiness/drain-lock.mjs');
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sibling-clones-'));
  roots.push(root);
  const cwd = join(root, 'lane-1');
  mkdirSync(cwd);
  const home = join(root, 'home');
  const origins = new Map();
  const shallow = vi.fn(() => 'false');
  const read = vi.fn(dir => {
    if (!origins.has(dir)) throw new Error('no origin');
    return origins.get(dir);
  });
  const run = vi.fn((_command, args) => {
    mkdirSync(join(args.at(-1), '.git'), { recursive: true });
    origins.set(args.at(-1), args.at(-2));
  });
  return { cwd, home, run, read, shallow, origins };
}

function expectedGitEnv(options) {
  const base = scrubGitRepoEnv(process.env);
  delete base.GIT_TEMPLATE_DIR;
  return laneGitHardeningEnv(base, options);
}
function expectedReadEnv() {
  return { ...Object.fromEntries(Object.keys(process.env).map(key => [key, undefined])), ...expectedGitEnv() };
}
const childEnv = env => Object.fromEntries(Object.entries({ ...process.env, ...env }).filter(([, value]) => value !== undefined));
const configPins = env => Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) =>
  [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]);

describe('sibling clone git hardening', () => {
  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'sibling-git-env-'));
    roots.push(root);
    // Control every env input, including the CLT probe's short circuit and OS account lookup.
    // Vitest 1.x stringifies undefined in stubEnv; delete explicitly after saving the original.
    for (const key of Object.keys(process.env)) {
      vi.stubEnv(key, '');
      delete process.env[key];
    }
    vi.stubEnv('TMPDIR', root);
    vi.stubEnv('HOME', join(root, 'account-home'));
    vi.stubEnv('DEVELOPER_DIR', join(root, 'developer-tools'));
    vi.mocked(userInfo).mockReturnValue({ homedir: join(root, 'account-home') });
  });
  afterEach(async () => vi.mocked(userInfo).mockImplementation((await vi.importActual('node:os')).userInfo));

  function hostileEnv() {
    for (const [key, value] of Object.entries({
      GIT_DIR: '/evil', GIT_WORK_TREE: '/evil', GIT_CONFIG_PARAMETERS: "'core.hooksPath'='/evil'",
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: '/evil',
      GIT_CONFIG_GLOBAL: '/evil', GIT_SSH_COMMAND: '/evil', GIT_ASKPASS: '/evil', GIT_EXTERNAL_DIFF: '/evil',
      GIT_TEMPLATE_DIR: '/evil-template', HTTPS_PROXY: '/evil', GIT_TRACE_CURL: '/evil',
    })) vi.stubEnv(key, value);
  }
  function gitFixture({ fullPrimary = true } = {}) {
    const options = fixture();
    for (const name of ['frontierui', 'plateau-app']) {
      mkdirSync(join(options.home, 'workspace', name, '.git'), { recursive: true });
    }
    vi.mocked(gitRun).mockImplementation((file, args, { cwd }) => {
      if (file !== 'git') throw new Error('unexpected executable');
      if (JSON.stringify(args) === JSON.stringify(['rev-parse', '--is-shallow-repository'])) {
        return { status: 0, stdout: `${!fullPrimary}\n`, stderr: '' };
      }
      if (JSON.stringify(args) === JSON.stringify(['remote', 'get-url', 'origin']) && options.origins.has(cwd)) {
        return { status: 0, stdout: options.origins.get(cwd) + '\n', stderr: '' };
      }
      throw new Error('unexpected git read');
    });
    return { ...options, read: undefined, shallow: undefined };
  }
  function provision(options) {
    expect(provisionMissingSiblingClones(options)).toEqual({ provisioned: ['frontierui', 'plateau-app'], failed: [] });
    expect(options.run).toHaveBeenCalledTimes(2);
    expect(gitRun).toHaveBeenCalledTimes(4);
  }

  it('clone runs with the primary-form hardened env from the filesystem root, not the inherited env', () => {
    hostileEnv();
    const options = gitFixture();
    const expected = expectedGitEnv({ credentialPins: false });
    provision(options);
    for (const [, , { env, cwd, ...bounds }] of options.run.mock.calls) {
      expect(env).toEqual(expected);
      expect(cwd).toBe(parse(resolve('/')).root);
      expect(bounds).toEqual({ stdio: ['ignore', 'ignore', 'inherit'],
        timeout: NETWORK_GIT_TIMEOUT_MS + BOUNDED_GIT_GRACE_MS, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
      for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_GLOBAL',
        'GIT_SSH_COMMAND', 'GIT_ASKPASS', 'GIT_EXTERNAL_DIFF', 'GIT_TEMPLATE_DIR', 'HTTPS_PROXY', 'GIT_TRACE_CURL']) {
        expect(env).not.toHaveProperty(key);
      }
      expect(env.GIT_TEMPLATE_DIR).toBeUndefined();
      const pins = LANE_GIT_CONFIG_PINS.filter(([key]) => !['credential.helper', 'core.askPass'].includes(key));
      expect(env.GIT_CONFIG_COUNT).toBe(String(pins.length));
      expect(configPins(env)).toEqual(pins);
      expect(configPins(env)).toContainEqual(['core.hooksPath', '/dev/null']);
      expect(configPins(env)).toContainEqual(['core.fsmonitor', 'false']);
      expect(Object.values(env)).not.toContain('/evil');
      expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    }
  });

  it('origin and shallow reads mask every inherited git key and carry the full lane pins', () => {
    hostileEnv();
    const options = gitFixture();
    const expected = expectedGitEnv();
    provision(options);
    expect(gitRun.mock.calls.map(([, args]) => args)).toEqual([
      ['rev-parse', '--is-shallow-repository'], ['remote', 'get-url', 'origin'],
      ['rev-parse', '--is-shallow-repository'], ['remote', 'get-url', 'origin'],
    ]);
    for (const [, , opts] of gitRun.mock.calls) {
      expect(opts.env).toEqual(expectedReadEnv());
      const env = childEnv(opts.env);
      expect(env).toEqual(expected);
      for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_TEMPLATE_DIR', 'GIT_CONFIG_PARAMETERS',
        'GIT_CONFIG_GLOBAL', 'GIT_SSH_COMMAND', 'GIT_ASKPASS', 'GIT_EXTERNAL_DIFF']) expect(env).not.toHaveProperty(key);
      expect(configPins(env)).toEqual(LANE_GIT_CONFIG_PINS);
      expect(configPins(env)).toContainEqual(['credential.helper', '']);
      expect(env.HTTPS_PROXY).toBe('/evil');
      expect(env.GIT_TRACE_CURL).toBe('/evil');
    }
  });

  it('clone retains empty inherited credential restrictions after scrubbing hostile config', () => {
    hostileEnv();
    vi.stubEnv('GIT_CONFIG_COUNT', '2');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'credential.helper');
    vi.stubEnv('GIT_CONFIG_VALUE_0', '');
    vi.stubEnv('GIT_CONFIG_KEY_1', 'core.askPass');
    vi.stubEnv('GIT_CONFIG_VALUE_1', '');
    vi.stubEnv('GIT_CONFIG_PARAMETERS', "'credential.helper'='' 'core.askPass'=''");
    const options = gitFixture();
    provision(options);
    for (const [, , { env }] of options.run.mock.calls) {
      expect(configPins(env)).toContainEqual(['credential.helper', '']);
      expect(configPins(env)).toContainEqual(['core.askPass', '']);
      expect(env).not.toHaveProperty('GIT_CONFIG_PARAMETERS');
      expect(env).not.toHaveProperty('GIT_ASKPASS');
      expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    }
  });

  it('leaves the account global credential helper available when the parent sets no resets', () => {
    const options = gitFixture();
    const accountHome = userInfo().homedir;
    mkdirSync(accountHome);
    const globalConfig = '[credential]\n\thelper = !fixture-gh auth git-credential\n';
    writeFileSync(join(accountHome, '.gitconfig'), globalConfig);
    provision(options);
    for (const [, , { env }] of options.run.mock.calls) {
      expect(env.HOME).toBe(accountHome);
      expect(readFileSync(join(env.HOME, '.gitconfig'), 'utf8')).toBe(globalConfig);
      expect(configPins(env)).toEqual(LANE_GIT_CONFIG_PINS.filter(([key]) =>
        key !== 'credential.helper' && key !== 'core.askPass'));
      expect(env).not.toHaveProperty('GIT_CONFIG_GLOBAL');
      expect(env).not.toHaveProperty('GIT_CONFIG_SYSTEM');
    }
  });

  it.each(['indexed', 'parameters', 'legacy parameters'])('carries exactly the parent empty resets from %s', source => {
    for (const keys of [['credential.helper'], ['core.askPass'], ['credential.helper', 'core.askPass']]) {
      vi.mocked(gitRun).mockClear();
      if (source === 'indexed') {
        vi.stubEnv('GIT_CONFIG_COUNT', String(keys.length));
        keys.forEach((key, index) => {
          vi.stubEnv(`GIT_CONFIG_KEY_${index}`, key);
          vi.stubEnv(`GIT_CONFIG_VALUE_${index}`, '');
        });
      } else {
        vi.stubEnv('GIT_CONFIG_PARAMETERS', keys.map(key =>
          source === 'parameters' ? `'${key}'=''` : `'${key}='`).join(' '));
      }
      const options = gitFixture();
      provision(options);
      for (const [, , { env }] of options.run.mock.calls) {
        const resets = configPins(env).filter(([key]) => key === 'credential.helper' || key === 'core.askPass');
        expect(resets).toEqual(keys.map(key => [key, '']));
        expect(env).not.toHaveProperty('GIT_CONFIG_PARAMETERS');
      }
    }
  });

  it.each([
    { GIT_CONFIG_COUNT: 'broken' },
    { GIT_CONFIG_COUNT: '1025' },
    { GIT_CONFIG_COUNT: '1\n', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '' },
    { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper' },
    { GIT_CONFIG_PARAMETERS: "'credential.helper'" },
    { GIT_CONFIG_PARAMETERS: "'core.askPass'=" },
    { GIT_CONFIG_PARAMETERS: "'credential.helper'='" },
    { GIT_CONFIG_PARAMETERS: 'x'.repeat(65537) },
  ])('refuses malformed or oversized parent config before cloning (%#)', parentEnv => {
    for (const [key, value] of Object.entries(parentEnv)) vi.stubEnv(key, value);
    const options = gitFixture();
    const log = vi.fn();
    const result = provisionMissingSiblingClones({ ...options, log });
    expect(result.provisioned).toEqual([]);
    expect(result.failed).toHaveLength(2);
    for (const { reason } of result.failed) expect(reason).toMatch(/^parent-git-config-invalid:/);
    expect(options.run).not.toHaveBeenCalled();
    expect(gitRun).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('parent-git-config-invalid:'));
  });

  it.each([false, true])('argv is unchanged by the companion rewrites (reference: %s)', fullPrimary => {
    const options = gitFixture({ fullPrimary });
    provision(options);
    for (const [i, name] of ['frontierui', 'plateau-app'].entries()) {
      const argv = ['clone', '--quiet', '-c', 'gc.auto=0',
        ...(fullPrimary ? ['--reference', join(options.home, 'workspace', name)] : []),
        `https://github.com/${CONSTELLATION_REPOS[name].slug}.git`, resolve(options.cwd, '..', name)];
      expect(hardenLaneGitArgs(argv)).toEqual(argv);
      const bounded = boundedGitCommand(argv, NETWORK_GIT_TIMEOUT_MS);
      expect(options.run.mock.calls[i].slice(0, 2)).toEqual([bounded.file, bounded.args]);
    }
    for (const [i, [, argv]] of gitRun.mock.calls.entries()) {
      expect(argv).toEqual(i % 2 === 0 ? ['rev-parse', '--is-shallow-repository'] : ['remote', 'get-url', 'origin']);
      expect(argv).toEqual(hardenLaneGitArgs(argv));
    }
  });

  it('environment changes between calls are observed', () => {
    for (const sentinel of ['one', 'two']) {
      vi.mocked(gitRun).mockClear();
      vi.stubEnv('WEV_SENTINEL', sentinel);
      if (sentinel === 'two') vi.stubEnv('GIT_TEMPLATE_DIR', '/evil-template');
      const options = gitFixture();
      provision(options);
      for (const [, , { env }] of options.run.mock.calls) {
        expect(env.WEV_SENTINEL).toBe(sentinel);
        expect(env).toEqual(expectedGitEnv({ credentialPins: false }));
        expect(env).not.toHaveProperty('GIT_TEMPLATE_DIR');
      }
      for (const [, , { env }] of gitRun.mock.calls) {
        expect(childEnv(env).WEV_SENTINEL).toBe(sentinel);
        expect(childEnv(env)).toEqual(expectedGitEnv());
        expect(childEnv(env)).not.toHaveProperty('GIT_TEMPLATE_DIR');
        if (sentinel === 'two') expect(env).toHaveProperty('GIT_TEMPLATE_DIR', undefined);
      }
    }
  });

  it('clone ignores caller HOME/XDG_CONFIG_HOME for credential config', () => {
    vi.stubEnv('HOME', '/evil-home');
    vi.stubEnv('XDG_CONFIG_HOME', '/evil-xdg');
    vi.stubEnv('GIT_CONFIG_GLOBAL', '/evil.cfg');
    vi.stubEnv('GIT_CONFIG_SYSTEM', '/evil-system.cfg');
    const options = gitFixture();
    provision(options);
    for (const [, , { env }] of options.run.mock.calls) {
      expect(env.HOME).toBe(userInfo().homedir);
      expect(env.HOME).not.toBe(options.home);
      for (const key of ['XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM']) expect(env).not.toHaveProperty(key);
    }
  });

  it('clone drops inherited GIT_TEMPLATE_DIR', () => {
    vi.stubEnv('GIT_TEMPLATE_DIR', '/evil-template');
    const options = gitFixture({ fullPrimary: false });
    provision(options);
    for (const [i, [, args, { env }]] of options.run.mock.calls.entries()) {
      expect(env).not.toHaveProperty('GIT_TEMPLATE_DIR');
      const name = ['frontierui', 'plateau-app'][i];
      expect(args).toEqual(boundedGitCommand(['clone', '--quiet', '-c', 'gc.auto=0',
        `https://github.com/${CONSTELLATION_REPOS[name].slug}.git`, resolve(options.cwd, '..', name)], NETWORK_GIT_TIMEOUT_MS).args);
    }
    for (const [, , { env }] of gitRun.mock.calls) {
      expect(env).toHaveProperty('GIT_TEMPLATE_DIR', undefined);
      expect(childEnv(env)).not.toHaveProperty('GIT_TEMPLATE_DIR');
    }
  });
});

describe('sibling clone provisioning', () => {
  it('resolves every constellation slug, key and directory name, including persisted legacy slugs', () => {
    for (const [key, repo] of Object.entries(CONSTELLATION_REPOS)) {
      const name = repo.slug.split('/').at(-1);
      for (const input of [key, repo.slug, ...repo.dirs, `chalbert/${name}`]) expect(resolveSiblingRepoName(input)).toBe(name);
    }
    for (const input of [null, undefined, '', 'unknown', 'unknown/frontierui']) expect(resolveSiblingRepoName(input)).toBeNull();
  });

  it('lists every missing non-local repo with its path and reason at startup', () => {
    const { cwd } = fixture();
    expect(siblingCloneStatus({ cwd })).toEqual(['frontierui', 'plateau-app'].map(name => {
      const dir = resolve(cwd, '..', name);
      return { name, dir, present: false, reason: `no .git at ${dir}` };
    }));
  });

  it('turns the no-clone skip into available clones for every non-local repo', () => {
    const options = fixture();
    expect(siblingCloneStatus(options).every(s => !s.present)).toBe(true);
    expect(provisionMissingSiblingClones(options)).toEqual({ provisioned: ['frontierui', 'plateau-app'], failed: [] });
    expect(siblingCloneStatus(options).every(s => s.present && s.reason === null)).toBe(true);
    for (const [i, name] of ['frontierui', 'plateau-app'].entries()) {
      const bounded = boundedGitCommand(['clone', '--quiet', '-c', 'gc.auto=0', `https://github.com/${CONSTELLATION_REPOS[name].slug}.git`, resolve(options.cwd, '..', name)], NETWORK_GIT_TIMEOUT_MS);
      expect(options.run.mock.calls[i]).toEqual([bounded.file, bounded.args, expect.objectContaining({
        stdio: ['ignore', 'ignore', 'inherit'],
        timeout: NETWORK_GIT_TIMEOUT_MS + BOUNDED_GIT_GRACE_MS, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
      })]);
    }
  });

  it('uses a primary reference only when its .git exists and it is confirmed non-shallow', () => {
    const options = fixture();
    const primary = join(options.home, 'workspace', 'frontierui');
    mkdirSync(primary, { recursive: true });
    writeFileSync(join(primary, '.git'), 'gitdir: elsewhere');
    provisionMissingSiblingClones(options);
    expect(options.run.mock.calls[0][1]).toContain('--reference');
    expect(options.run.mock.calls[0][1]).toContain(primary);
    expect(options.run.mock.calls[1][1]).not.toContain('--reference');
  });

  it('reports a failed clone and stays fail-closed while continuing with the next repo', () => {
    const options = fixture();
    options.run.mockImplementationOnce(() => { throw new Error('permission denied'); });
    expect(provisionMissingSiblingClones(options)).toEqual({ provisioned: ['plateau-app'], failed: [{ name: 'frontierui', reason: 'permission denied' }] });
    expect(siblingCloneStatus(options)[0].present).toBe(false);
  });

  it('continues provisioning when the logger throws and returns both sibling outcomes', () => {
    const options = fixture();
    options.run.mockImplementationOnce(() => { throw new Error('clone failed'); });
    const log = vi.fn(() => { throw new Error('log sink closed'); });
    expect(provisionMissingSiblingClones({ ...options, log })).toEqual({
      provisioned: ['plateau-app'], failed: [{ name: 'frontierui', reason: 'clone failed' }],
    });
    expect(options.run).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(3);
  });

  it('reports the clone exit error without captured stderr and removes its reserved directory', () => {
    const options = fixture();
    const message = 'Command failed: git clone (exit 128)';
    options.run.mockImplementationOnce(() => {
      throw Object.assign(new Error(message), { status: 128, stdout: null, stderr: null });
    });
    const log = vi.fn();
    expect(provisionMissingSiblingClones({ ...options, log })).toEqual({
      provisioned: ['plateau-app'], failed: [{ name: 'frontierui', reason: message }],
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`failed: ${message}; repair the sibling clone`));
    expect(existsSync(resolve(options.cwd, '..', 'frontierui'))).toBe(false);
  });

  it('refuses to count a successful runner without .git as provisioned', () => {
    const options = fixture();
    options.run.mockImplementation(() => {});
    const result = provisionMissingSiblingClones(options);
    expect(result.provisioned).toEqual([]);
    expect(result.failed).toHaveLength(2);
    expect(result.failed[0].reason).toContain('no .git at');
  });

  it('logs missing status in dry-run without invoking the clone runner', () => {
    const options = fixture();
    const log = vi.fn();
    expect(provisionMissingSiblingClones({ ...options, dryRun: true, log })).toEqual({ provisioned: [], failed: [] });
    expect(options.run).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0][0]).toContain(`no .git at ${resolve(options.cwd, '..', 'frontierui')}`);
    expect(siblingCloneStatus(options).every(s => !s.present)).toBe(true);
  });

  it('never touches existing directories, including a directory without .git', () => {
    const options = fixture();
    const frontier = resolve(options.cwd, '..', 'frontierui');
    mkdirSync(frontier);
    writeFileSync(join(frontier, 'keep'), 'untouched');
    const plateau = resolve(options.cwd, '..', 'plateau-app');
    mkdirSync(join(plateau, '.git'), { recursive: true });
    options.origins.set(plateau, 'https://github.com/plateauapp/plateau-app.git');
    const result = provisionMissingSiblingClones(options);
    expect(options.run).not.toHaveBeenCalled();
    expect(result.failed[0]).toMatchObject({ name: 'frontierui' });
    expect(result.failed[0].reason).toContain('existing directory');
    expect(readFileSync(join(frontier, 'keep'), 'utf8')).toBe('untouched');
    expect(existsSync(join(frontier, '.git'))).toBe(false);
  });

  it('returns unreadable filesystem evidence as a reason without cloning', () => {
    const options = fixture();
    const exists = () => { throw new Error('unreadable'); };
    expect(siblingCloneStatus({ ...options, exists }).every(s => !s.present && s.reason.includes('unreadable'))).toBe(true);
    expect(provisionMissingSiblingClones({ ...options, exists }).failed).toHaveLength(2);
    expect(options.run).not.toHaveBeenCalled();
  });

  it('does not attempt a clone when only the .git probe is unreadable', () => {
    const options = fixture();
    const exists = path => { if (path.endsWith('.git')) throw new Error('unreadable'); return false; };
    expect(provisionMissingSiblingClones({ ...options, exists }).failed).toHaveLength(2);
    expect(options.run).not.toHaveBeenCalled();
  });
});

describe('main sibling provisioning lifecycle', () => {
  async function startup({ dryRun = false, testMarker = null, mainCalls = 1, leaseRefused = false, failClone = false } = {}) {
    vi.doUnmock('../lib/git-run.mjs');
    vi.doMock('node:child_process', () => childProcessMock);
    const options = fixture();
    if (failClone) options.run.mockImplementationOnce(() => { throw new Error('clone failed'); });
    const provision = vi.fn(args => provisionMissingSiblingClones({ ...options, ...args }));
    vi.doMock('../lib/sibling-clone-provision.mjs', async importOriginal => ({
      ...await importOriginal(), provisionMissingSiblingClones: provision,
    }));
    if (leaseRefused) {
      vi.doMock('../readiness/drain-lock.mjs', async importOriginal => ({
        ...await importOriginal(),
        drainLeaseStatus: () => ({ held: true, stale: false, owner: 'fixture:other', scope: null }),
      }));
    }
    let result;
    const world = createPrestageWorld((argv, config) => {
      // The fixture owns this parent. Keep siblings absent so a missing dryRun
      // forwarding argument reaches the fake clone runner instead of being masked.
      rmSync(resolve(config.cwd, '..', 'frontierui'), { recursive: true, force: true });
      rmSync(resolve(config.cwd, '..', 'plateau-app'), { recursive: true, force: true });
      const ports = {
        ...prestagePorts,
        git(args, env) {
          // Also refuse clones that bypass the injected provisioner.
          if (args.includes('clone')) throw new Error('unexpected CLI git clone');
          return prestagePorts.git(args, env);
        },
      };
      return runInProcess(leaseRefused ? ['--this-repo', '--json'] : argv, {
        ...config, env: { ...config.env, WE_UNDER_TEST: undefined, WE_TEST_HERMETIC: undefined,
          ...(testMarker ? { [testMarker]: '1' } : {}) }, ports, mainCalls,
      }).then(value => {
        result = value;
        // Each main call emits its own JSON report; the world fixture consumes one.
        return { ...value, stdout: value.stdout.trim().split('\n').at(-1) + '\n' };
      });
    });
    await world(async ({ run }) => { await run(false, { args: dryRun ? ['--dry-run'] : [] }); },
      { slug: 'web-everything/web-everything' });
    return { provision, clone: options.run, result };
  }

  it.each(['WE_UNDER_TEST', 'WE_TEST_HERMETIC'])('keeps non-dry-run test CLIs status-only with %s without any clone attempt', async testMarker => {
    const { provision, clone, result } = await startup({ testMarker });
    expect(provision).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
    expect(clone).not.toHaveBeenCalled();
    expect(result.stderr).toContain(`${testMarker}=1`);
  });

  it('forwards CLI dry-run to the real provisioner without invoking a clone runner', async () => {
    const { provision, clone } = await startup({ dryRun: true });
    expect(provision).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
    expect(clone).not.toHaveBeenCalled();
  });

  it.each([false, true])('provisions siblings only once across repeated main calls (clone failure: %s)', async failClone => {
    const { provision, clone, result } = await startup({ mainCalls: 2, failClone });
    expect(result.stdout.trim().split('\n').map(JSON.parse)).toHaveLength(2);
    expect(provision).toHaveBeenCalledTimes(1);
    expect(provision).toHaveBeenCalledWith(expect.objectContaining({ dryRun: false }));
    expect(clone).toHaveBeenCalledTimes(2);
  });

  it('makes zero provisioning calls when the drain lease is refused', async () => {
    const { provision, clone, result } = await startup({ leaseRefused: true });
    expect(JSON.parse(result.stdout).skipped).toBe('drain-in-progress');
    expect(provision).not.toHaveBeenCalled();
    expect(clone).not.toHaveBeenCalled();
  });
});

it('keeps all six lifecycle cases on the default five-second timeout without overrides', () => {
  const source = readFileSync(new URL('./sibling-clone-provision.test.mjs', import.meta.url), 'utf8');
  const ast = parseJavaScript(source, { ecmaVersion: 2020, sourceType: 'module' });
  const suite = ast.body.find(node => node.expression?.callee?.name === 'describe'
    && node.expression.arguments[0]?.value === 'main sibling provisioning lifecycle');
  expect(suite).toBeDefined();
  const registrations = suite.expression.arguments[1].body.body
    .filter(node => node.expression?.type === 'CallExpression').map(node => node.expression);
  expect(registrations).toHaveLength(4);
  let cases = 0;
  for (const registration of registrations) {
    expect(registration.arguments).toHaveLength(2);
    const each = registration.callee;
    if (each.type === 'CallExpression') {
      expect(each.callee.object.name).toBe('it');
      expect(each.callee.property.name).toBe('each');
      cases += each.arguments[0].elements.length;
    } else {
      expect(each.name).toBe('it');
      cases++;
    }
  }
  expect(cases).toBe(6);
});


describe('sibling clone audit boundaries', () => {
  it.each([0, 1])('validates default origin reads through gitRun with exit status %s', status => {
    const options = fixture();
    const dir = resolve(options.cwd, '..', 'frontierui');
    mkdirSync(join(dir, '.git'), { recursive: true });
    vi.mocked(gitRun).mockReturnValue({ status, stdout: 'https://github.com/frontier-ui/frontierui.git\n', stderr: '' });
    expect(siblingCloneStatus({ ...options, read: undefined })[0].present).toBe(status === 0);
    expect(gitRun).toHaveBeenCalledTimes(1);
    expect(gitRun).toHaveBeenCalledWith('git', ['remote', 'get-url', 'origin'], {
      cwd: dir, timeoutMs: 5000, maxBuffer: 1024 * 1024, env: expectedReadEnv(),
    });
  });

  it.each([0, 1])('uses default shallow reads through gitRun and requires exit zero (%s)', status => {
    const options = fixture();
    const primary = join(options.home, 'workspace', 'frontierui');
    mkdirSync(join(primary, '.git'), { recursive: true });
    vi.mocked(gitRun).mockReturnValue({ status, stdout: 'false\n', stderr: 'read failed' });
    expect(provisionMissingSiblingClones({ ...options, shallow: undefined }).failed).toEqual([]);
    expect(options.run.mock.calls[0][1].includes('--reference')).toBe(status === 0);
    expect(gitRun).toHaveBeenCalledTimes(1);
    expect(gitRun).toHaveBeenCalledWith('git', ['rev-parse', '--is-shallow-repository'], {
      cwd: primary, timeoutMs: 5000, maxBuffer: 1024 * 1024, env: expectedReadEnv(),
    });
  });

  it.each(['https://github.com/frontier-ui/frontierui.git', 'git@github.com:frontier-ui/frontierui.git',
    'ssh://git@github.com/chalbert/frontierui.git', 'https://github.com/chalbert/frontierui'])('accepts expected origin %s', origin => {
    const options = fixture();
    const dir = resolve(options.cwd, '..', 'frontierui');
    mkdirSync(join(dir, '.git'), { recursive: true });
    options.origins.set(dir, origin);
    expect(siblingCloneStatus(options)[0]).toMatchObject({ present: true, reason: null });
  });

  it.each([null, 'https://github.com/unknown/frontierui.git', 'https://example.com/frontier-ui/frontierui.git',
    'git@github.com:plateauapp/plateau-app.git'])('quarantines missing or mismatched origin %s without mutation', origin => {
    const options = fixture();
    const dir = resolve(options.cwd, '..', 'frontierui');
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, 'keep'), 'untouched');
    if (origin) options.origins.set(dir, origin);
    expect(siblingCloneStatus(options)[0]).toMatchObject({ present: false, reason: 'origin mismatch' });
    expect(provisionMissingSiblingClones(options).failed[0].reason).toContain('origin mismatch');
    expect(options.run.mock.calls.every(([, args]) => basename(args.at(-1)) !== 'frontierui')).toBe(true);
    expect(readFileSync(join(dir, 'keep'), 'utf8')).toBe('untouched');
  });

  it.each(['true', 'unknown', null])('plain-clones when primary shallow evidence is %s', evidence => {
    const options = fixture();
    mkdirSync(join(options.home, 'workspace', 'frontierui', '.git'), { recursive: true });
    options.shallow.mockImplementation(() => {
      if (evidence === null) throw new Error('unreadable');
      return evidence;
    });
    expect(provisionMissingSiblingClones(options).failed).toEqual([]);
    expect(options.run.mock.calls[0][1]).not.toContain('--reference');
  });

  it('removes its partial clone on failure, even with .git, and continues provisioning', () => {
    const options = fixture();
    options.run.mockImplementationOnce((_command, args) => {
      mkdirSync(join(args.at(-1), '.git'));
      writeFileSync(join(args.at(-1), 'partial'), 'incomplete');
      throw new Error('clone timed out');
    });
    expect(provisionMissingSiblingClones(options)).toEqual({ provisioned: ['plateau-app'],
      failed: [{ name: 'frontierui', reason: 'clone timed out' }] });
    expect(existsSync(resolve(options.cwd, '..', 'frontierui'))).toBe(false);
  });

  it('removes a newly cloned directory whose origin fails validation', () => {
    const options = fixture();
    options.run.mockImplementation((_command, args) => mkdirSync(join(args.at(-1), '.git')));
    expect(provisionMissingSiblingClones(options).failed.every(row => row.reason === 'origin mismatch')).toBe(true);
    expect(existsSync(resolve(options.cwd, '..', 'frontierui'))).toBe(false);
  });

  it('uses bounded Git without a push allowlist exemption; a replacement raw push is rejected', () => {
    const source = readFileSync(new URL('../lib/sibling-clone-provision.mjs', import.meta.url), 'utf8');
    const allow = JSON.parse(readFileSync(new URL('../push-gate-allowlist.json', import.meta.url), 'utf8'));
    expect(allow.entries['scripts/lib/sibling-clone-provision.mjs']).toBeUndefined();
    expect(findRawPushes(source)).toEqual([]);
    expect(findRawPushes(source + "\nexecFileSync('git', ['push']);")).toHaveLength(1);
  });

  it('wires provisioning after lease refusal and quarantines failed repos before filesystem routing', () => {
    const source = readFileSync(new URL('../merge-ai-prs.mjs', import.meta.url), 'utf8');
    const provision = source.indexOf('siblingProvisionFailures = provisionMissingSiblingClones(');
    const lease = source.indexOf("if (leaseGate.action === 'noop'");
    expect(provision).toBeGreaterThan(lease);
    expect(provision).toBeGreaterThan(source.indexOf('if (leaseHeld) {', lease));
    const routing = source.slice(source.indexOf('const siblingCloneDir ='), source.indexOf('const siblingCloneReason ='));
    const status = vi.fn(() => [{ name: 'frontierui', present: true, dir: 'valid-clone' }]);
    const failures = [{ name: 'frontierui', reason: 'clone failed' }];
    const route = new Function('isLocalRepo', 'siblingCloneName', 'siblingProvisionFailures', 'siblingCloneStatus',
      `${routing}; return siblingCloneDir;`)(() => false, () => 'frontierui', failures, status);
    expect(route('frontierui')).toBeNull(); // Even a valid .git/origin cannot override quarantine.
    expect(status).not.toHaveBeenCalled();
    failures.length = 0;
    expect(route('frontierui')).toBe('valid-clone');
    status.mockReturnValue([{ name: 'frontierui', present: false, reason: 'origin mismatch' }]);
    expect(route('frontierui')).toBeNull();
  });
});
