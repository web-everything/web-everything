import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
  const run = vi.fn((_command, args) => mkdirSync(join(args.at(-1), '.git'), { recursive: true }));
  return { cwd, home, run };
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
      expect(options.run.mock.calls[i].slice(0, 2)).toEqual(['git', ['clone', '--quiet', '-c', 'gc.auto=0', `https://github.com/${CONSTELLATION_REPOS[name].slug}.git`, resolve(options.cwd, '..', name)]]);
    }
  });

  it('uses a primary reference only when its .git exists', () => {
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
    mkdirSync(resolve(options.cwd, '..', 'plateau-app', '.git'), { recursive: true });
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
