// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { boundedGitCommand, BOUNDED_GIT_GRACE_MS } from '../lib/git-bounded.mjs';
import { NETWORK_GIT_TIMEOUT_MS } from '../lib/bounded-child.mjs';
import { findRawPushes } from '../lib/push-gate-lint.mjs';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';
import { resolveSiblingRepoName, siblingCloneStatus, provisionMissingSiblingClones } from '../lib/sibling-clone-provision.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
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


describe('sibling clone audit boundaries', () => {
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
