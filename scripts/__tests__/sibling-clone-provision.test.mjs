// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { boundedGitCommand, BOUNDED_GIT_GRACE_MS } from '../lib/git-bounded.mjs';
import { NETWORK_GIT_TIMEOUT_MS } from '../lib/bounded-child.mjs';
import { findRawPushes } from '../lib/push-gate-lint.mjs';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';
import { gitRun } from '../lib/git-run.mjs';
import { resolveSiblingRepoName, siblingCloneStatus, provisionMissingSiblingClones } from '../lib/sibling-clone-provision.mjs';
import { runInProcess, childProcessMock } from './fixtures/merge-ai-prs-cli-harness.mjs';
import { createPrestageWorld } from './fixtures/merge-ai-prs-prestage-world.mjs';
import { prestagePorts } from './fixtures/merge-ai-prs-fake-ports.mjs';

vi.mock('../lib/git-run.mjs', () => ({ gitRun: vi.fn() }));

// The lifecycle cases import the real drain CLI and may run it twice. Match the
// pre-stage CLI suite's bound so fresh imports and label-lag repolls can finish
// before Vitest tears down the in-process harness's ambient IO mocks.
vi.setConfig({ testTimeout: 120_000 });

const roots = [];
afterEach(() => {
  vi.mocked(gitRun).mockReset();
  vi.doUnmock('node:child_process');
  vi.doUnmock('../lib/sibling-clone-provision.mjs');
  vi.doUnmock('../readiness/drain-lock.mjs');
  vi.restoreAllMocks();
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


describe('sibling clone audit boundaries', () => {
  it.each([0, 1])('validates default origin reads through gitRun with exit status %s', status => {
    const options = fixture();
    const dir = resolve(options.cwd, '..', 'frontierui');
    mkdirSync(join(dir, '.git'), { recursive: true });
    vi.mocked(gitRun).mockReturnValue({ status, stdout: 'https://github.com/frontier-ui/frontierui.git\n', stderr: '' });
    expect(siblingCloneStatus({ ...options, read: undefined })[0].present).toBe(status === 0);
    expect(gitRun).toHaveBeenCalledTimes(1);
    expect(gitRun).toHaveBeenCalledWith('git', ['remote', 'get-url', 'origin'], {
      cwd: dir, timeoutMs: 5_000, maxBuffer: 1024 * 1024,
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
      cwd: primary, timeoutMs: 5_000, maxBuffer: 1024 * 1024,
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
