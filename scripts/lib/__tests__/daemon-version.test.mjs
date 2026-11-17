/** @file scripts/lib/__tests__/daemon-version.test.mjs — S3 offline version-builder contracts. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildVersion } from '../daemon-version.mjs';
import { lockfileKey } from '../daemon-job-snapshots.mjs';

describe('buildVersion', () => {
  let fixture, clone, home, settings, deps;
  const git = (...args) => execFileSync('git', ['-C', clone, ...args], { encoding: 'utf8' }).trim();
  const commit = () => { git('add', '.'); git('commit', '--quiet', '-m', 'fixture'); return git('rev-parse', 'HEAD'); };
  const build = extra => buildVersion({ clone, home, settings, deps, ...extra });
  const versions = () => readdirSync(join(home, 'daemon', 'versions'));
  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), 'daemon-version-'));
    clone = join(fixture, 'daemon');
    home = join(fixture, '.daemon-clones');
    mkdirSync(clone);
    git('init', '--quiet');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.test');
    writeFileSync(join(clone, 'package.json'), '{"name":"fixture","version":"1.0.0"}');
    writeFileSync(join(clone, 'package-lock.json'), '{"lockfileVersion":3}');
    writeFileSync(join(clone, '.gitignore'), 'node_modules/\n.conveyor/\nartifacts/\n');
    commit();
    settings = { enabled: { daemon: true }, statePaths: ['.conveyor'], carryPaths: ['artifacts'] };
    deps = {
      now: () => new Date('2026-10-06T14:15:16Z'),
      installer: vi.fn(into => { mkdirSync(join(into, 'node_modules')); writeFileSync(join(into, 'node_modules', 'fixture'), 'installed'); }),
      runSmoke: vi.fn(async () => ({ verdict: 'pass', attempts: 1 })),
    };
  });
  afterEach(() => rmSync(fixture, { recursive: true, force: true }));

  it('reuses a finished SHA despite a new timestamp and ignores stale staging records', async () => {
    const first = await build();
    const stale = join(home, 'daemon', 'versions', '.building-dead-999999');
    mkdirSync(stale);
    writeFileSync(join(stale, '.version.json'), JSON.stringify(first));
    deps.now = () => new Date('2026-10-07T14:15:16Z');
    expect(await build()).toEqual({ status: 'reused', id: first.id, dir: first.dir });
    expect(versions().filter(name => !name.startsWith('.'))).toEqual([first.id]);
    expect(first.id).toBe(`20261006T141516Z-${git('rev-parse', 'HEAD').slice(0, 12)}`);
    expect(deps.installer).toHaveBeenCalledTimes(1);
    expect(deps.runSmoke).toHaveBeenCalledTimes(1);
  });

  it.each(['installer', 'runSmoke'])('cleans staging and publishes nothing when %s throws', async dependency => {
    deps[dependency] = () => { throw new Error('interrupted'); };
    await expect(build()).rejects.toThrow('interrupted');
    expect(versions()).toEqual([]);
  });

  it.each(['pass', 'code'])('records the %s smoke verdict and publishes only after smoke', async verdict => {
    deps.runSmoke = vi.fn(async ({ root, env }) => {
      expect(root).toContain('/.building-');
      expect(env.WE_SMOKE_LIVE_CLONE).toBe(clone);
      expect(versions().every(name => name.startsWith('.building-'))).toBe(true);
      expect(existsSync(join(root, '.version.json'))).toBe(false);
      return { verdict, attempts: 2, smoke: { results: [] } };
    });
    const result = await build();
    const record = JSON.parse(readFileSync(join(result.dir, '.version.json'), 'utf8'));
    expect(record).toMatchObject({
      sha: git('rev-parse', 'HEAD'), status: verdict === 'pass' ? 'built' : 'smoke-failed',
      smoke: { verdict, attempts: 2, smoke: { results: [] } },
      lockKey: lockfileKey(readFileSync(join(clone, 'package-lock.json'), 'utf8')),
    });
    expect(versions()).toEqual([result.id]);
    expect(existsSync(join(home, 'daemon', 'current'))).toBe(false);
    expect(readdirSync(join(home, 'daemon'))).not.toContain('current');
  });

  it('builds a store only for a new lock hash across different commits', async () => {
    settings.nodeModulesStore = join(fixture, 'custom-store');
    const first = await build();
    writeFileSync(join(clone, 'code.txt'), 'new code');
    commit();
    const second = await build();
    expect(deps.installer).toHaveBeenCalledTimes(1);
    expect(readlinkSync(join(second.dir, 'node_modules'))).toBe(readlinkSync(join(first.dir, 'node_modules')));
    expect(readlinkSync(join(first.dir, 'node_modules'))).toContain(settings.nodeModulesStore);
    writeFileSync(join(clone, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}');
    commit();
    const third = await build();
    expect(deps.installer).toHaveBeenCalledTimes(2);
    expect(third.lockKey).not.toBe(first.lockKey);
  });

  it('defaults to disabled without probing Git or touching the filesystem; force opts in', async () => {
    const before = readdirSync(fixture);
    expect(await buildVersion({ clone: join(fixture, 'missing'), home, deps: { run: () => { throw new Error('Git touched'); } } })).toEqual({ status: 'disabled' });
    expect(readdirSync(fixture)).toEqual(before);
    expect(existsSync(home)).toBe(false);
    expect((await build({ settings: undefined, force: true })).status).toBe('built');
  });

  it('preserves source HEAD, refs and dirt while carrying state, artifacts and sidecars', async () => {
    mkdirSync(join(clone, '.conveyor'));
    writeFileSync(join(clone, '.conveyor', 'state.json'), '{}');
    mkdirSync(join(clone, 'artifacts'));
    writeFileSync(join(clone, 'artifacts', 'binary'), 'artifact');
    mkdirSync(join(clone, 'backlog'));
    writeFileSync(join(clone, 'backlog', 'xabc123-draft.md'), 'sidecar');
    writeFileSync(join(clone, 'package.json'), '{"dirty":true}');
    const before = { head: git('rev-parse', 'HEAD'), status: git('status', '--porcelain'), refs: git('show-ref') };
    const result = await build();
    expect({ head: git('rev-parse', 'HEAD'), status: git('status', '--porcelain'), refs: git('show-ref') }).toEqual(before);
    expect(readFileSync(join(result.dir, 'backlog', 'xabc123-draft.md'), 'utf8')).toBe('sidecar');
    expect(readFileSync(join(result.dir, 'artifacts', 'binary'), 'utf8')).toBe('artifact');
    expect(readlinkSync(join(result.dir, '.conveyor'))).toBe(join(home, 'daemon', 'state', '.conveyor'));
    expect(execFileSync('git', ['-C', result.dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(before.head);
    expect(existsSync(join(clone, '.git', 'worktrees'))).toBe(false);
  });

  it('CLI reports disabled as JSON without creating a home', () => {
    const output = execFileSync(process.execPath, [resolve('scripts/lib/daemon-version.mjs'), 'build', `--clone=${clone}`, `--home=${home}`, '--json'], { encoding: 'utf8' });
    expect(JSON.parse(output)).toEqual({ status: 'disabled' });
    expect(existsSync(home)).toBe(false);
  });
});
