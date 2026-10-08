/** @file scripts/lib/__tests__/daemon-version-migrate.test.mjs — S6 migrate/unmigrate fixture round trip. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, unmigrate, versionedPlistText, rewritePlist } from '../daemon-version-migrate.mjs';
import { addOverlay, cloneKey } from '../daemon-overlays.mjs';
import { resolveVersionedContext, versionedRebuild } from '../daemon-version-runtime.mjs';

const snapshot = (dir, rel = '') => {
  const out = {};
  for (const name of fs.readdirSync(join(dir, rel)).sort()) {
    const path = join(rel, name);
    const s = fs.lstatSync(join(dir, path));
    if (s.isSymbolicLink()) out[path] = `-> ${fs.readlinkSync(join(dir, path))}`;
    else if (s.isDirectory()) { out[path] = 'dir'; Object.assign(out, snapshot(dir, path)); }
    else out[path] = fs.readFileSync(join(dir, path), 'utf8');
  }
  return out;
};

describe('daemon version migrate / unmigrate', () => {
  let fixture, ws, clone, home, deps, settings;
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  beforeEach(() => {
    fixture = fs.mkdtempSync(join(tmpdir(), 'daemon-migrate-'));
    ws = join(fixture, 'ws'); clone = join(ws, 'daemon'); home = join(ws, '.daemon-clones');
    const origin = join(fixture, 'origin.git');
    fs.mkdirSync(clone, { recursive: true });
    execFileSync('git', ['init', '--quiet', '--bare', origin]);
    git(clone, 'init', '--quiet', '-b', 'main');
    git(clone, 'config', 'user.name', 'F'); git(clone, 'config', 'user.email', 'f@example.test');
    fs.writeFileSync(join(clone, 'package.json'), '{"name":"f"}');
    fs.writeFileSync(join(clone, 'package-lock.json'), '{"lockfileVersion":3}');
    fs.writeFileSync(join(clone, '.gitignore'), 'node_modules/\n.conveyor/\n.operations/\n');
    git(clone, 'add', '.'); git(clone, 'commit', '--quiet', '-m', 'one');
    git(clone, 'remote', 'add', 'origin', origin);
    git(clone, 'push', '--quiet', 'origin', 'main');
    fs.mkdirSync(join(clone, '.conveyor', 'sub'), { recursive: true });
    fs.writeFileSync(join(clone, '.conveyor', 'daemon.log'), 'log line\n');
    fs.writeFileSync(join(clone, '.conveyor', 'sub', 'q.json'), '{}');
    fs.mkdirSync(join(clone, '.operations'));
    fs.writeFileSync(join(clone, '.operations', 'run.json'), '1');
    settings = { statePaths: ['.conveyor', '.operations'], carryPaths: [] };
    deps = {
      requireHostEnable: false,
      env: { ...process.env, WE_DAEMON_OVERLAY_DIR: join(fixture, 'overlays') },
      now: () => Date.parse('2026-10-08T12:00:00Z'),
      buildDeps: {
        env: process.env,
        installer: vi.fn(into => { fs.mkdirSync(join(into, 'node_modules')); }),
        runSmoke: vi.fn(async () => ({ verdict: 'pass', attempts: 1 })),
      },
    };
  });
  afterEach(() => fs.rmSync(fixture, { recursive: true, force: true }));

  it('round trip restores tree, state and clone key', async () => {
    const before = snapshot(clone);
    const keyBefore = cloneKey(clone);
    const result = await migrate({ clone, home, settings, deps });
    expect(result.status).toBe('migrated');
    // compat symlink -> current, state is shared, writes through the old path land in state
    expect(fs.lstatSync(clone).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(clone)).toBe('../.daemon-clones/daemon/current'.replace('../', ''));
    fs.appendFileSync(join(clone, '.conveyor', 'daemon.log'), 'after\n');
    expect(fs.readFileSync(join(home, 'daemon', 'state', '.conveyor', 'daemon.log'), 'utf8')).toBe('log line\nafter\n');
    expect(cloneKey(clone)).toBe(keyBefore);
    expect(resolveVersionedContext({ root: clone, env: {} })).toMatchObject({ name: 'daemon' });
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(git(join(home, 'daemon', 'legacy-20261008T120000Z'), 'rev-parse', 'HEAD'));

    expect((await unmigrate({ clone, home, settings, deps })).status).toBe('unmigrated');
    fs.writeFileSync(join(clone, '.conveyor', 'daemon.log'), 'log line\n'); // undo our own append
    expect(snapshot(clone)).toEqual(before);
    expect(cloneKey(clone)).toBe(keyBefore);
    expect(resolveVersionedContext({ root: clone, env: {} })).toBeNull();
    // a second migrate works again (repo.git and versions are reused)
    expect((await migrate({ clone, home, settings, deps })).status).toBe('migrated');
  });

  it('a migrated clone fetches into repo.git and switches to a new main', async () => {
    await migrate({ clone, home, settings, deps });
    const other = join(fixture, 'other');
    execFileSync('git', ['clone', '--quiet', '--branch', 'main', join(fixture, 'origin.git'), other]);
    git(other, 'config', 'user.name', 'F'); git(other, 'config', 'user.email', 'f@example.test');
    fs.writeFileSync(join(other, 'two.txt'), '2'); git(other, 'add', '.'); git(other, 'commit', '--quiet', '-m', 'two');
    git(other, 'push', '--quiet', 'origin', 'HEAD:main');
    const ctx = resolveVersionedContext({ root: clone, env: {}, settings: { enabled: { daemon: true }, statePaths: ['.conveyor', '.operations'], carryPaths: [], carryUntracked: false, keep: 3, retainMinAgeMs: 0, probationMs: 0, autoRollback: false } });
    const out = await versionedRebuild({ ctx: { ...ctx, home }, log: { error() {} }, deps: { buildDeps: deps.buildDeps } });
    expect(out).toMatchObject({ moved: true, reason: 'adopted', head: git(other, 'rev-parse', 'HEAD') });
    expect(fs.existsSync(join(clone, 'two.txt'))).toBe(true);
    expect(fs.readFileSync(join(clone, '.conveyor', 'daemon.log'), 'utf8')).toBe('log line\n');
  });

  it('refuses overlays, tracked dirt, a second migrate and an unmigrated unmigrate', async () => {
    fs.writeFileSync(join(clone, 'package.json'), '{"name":"changed"}');
    expect(await migrate({ clone, home, settings, deps })).toMatchObject({ status: 'refused', reason: 'tracked-dirt' });
    git(clone, 'checkout', '--', 'package.json');
    expect((await migrate({ clone, home, settings, deps })).status).toBe('migrated');
    expect(await migrate({ clone, home, settings, deps })).toMatchObject({ status: 'refused' });
    await unmigrate({ clone, home, settings, deps });
    expect(await unmigrate({ clone, home, settings, deps })).toMatchObject({ status: 'refused', reason: 'not-migrated' });
  });

  it('refuses a clone whose HEAD cannot read the host-local enable file', async () => {
    deps.requireHostEnable = true;
    expect(await migrate({ clone, home, settings, deps })).toMatchObject({ status: 'refused', reason: 'clone-lacks-host-enable' });
    expect(fs.lstatSync(clone).isDirectory()).toBe(true);
  });

  it('refuses a failed smoke and changes nothing', async () => {
    deps.buildDeps.runSmoke = async () => ({ verdict: 'code', attempts: 1 });
    const before = snapshot(clone);
    expect(await migrate({ clone, home, settings, deps })).toMatchObject({ status: 'refused', reason: 'smoke-failed' });
    expect(snapshot(clone)).toEqual(before);
  });

  const files = (dir, found = []) => {
    if (!fs.existsSync(dir)) return found;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) files(join(dir, entry.name), found);
      else found.push(readFileSync(join(dir, entry.name)));
    }
    return found;
  };
  const readFileSync = path => fs.readFileSync(path, 'utf8');
  const throwOnRename = match => ({
    ...fs,
    renameSync: (from, to) => {
      if (match.test(to)) throw Object.assign(new Error('EXDEV: cross-device link'), { code: 'EXDEV' });
      return fs.renameSync(from, to);
    },
  });
  const nothingMigrated = () => {
    for (const name of ['current', 'previous', 'state.json', 'migration.json', 'settings.local.json']) {
      expect(fs.existsSync(join(home, 'daemon', name))).toBe(false);
    }
  };

  it('refuses active overlays without changing the clone', async () => {
    addOverlay(clone, { ref: 'fix/overlay-x' }, { env: deps.env });
    const before = snapshot(clone);
    expect(await migrate({ clone, home, settings, deps })).toMatchObject({ status: 'refused', reason: 'overlays', overlays: ['fix/overlay-x'] });
    expect(fs.lstatSync(clone).isDirectory()).toBe(true);
    expect(snapshot(clone)).toEqual(before);
    nothingMigrated();
  });

  it('refuses a missing clone, a symlinked clone and an already-migrated home with their exact reasons', async () => {
    expect(await migrate({ clone: join(ws, 'nope'), home, settings, deps })).toMatchObject({ status: 'refused', reason: 'clone-missing' });
    fs.mkdirSync(join(home, 'daemon', 'current'), { recursive: true });
    expect(await migrate({ clone, home, settings, deps })).toMatchObject({ status: 'refused', reason: 'already-migrated' });
    fs.rmSync(join(home, 'daemon'), { recursive: true, force: true });
    expect((await migrate({ clone, home, settings, deps })).status).toBe('migrated');
    expect(await migrate({ clone, home, settings, deps })).toMatchObject({ status: 'refused', reason: 'already-a-symlink' });
  });

  it('refuses a clone whose HEAD cannot read the host-local enable file with the production default', async () => {
    delete deps.requireHostEnable;
    expect(await migrate({ clone, home, settings, deps })).toMatchObject({ status: 'refused', reason: 'clone-lacks-host-enable' });
    expect(fs.lstatSync(clone).isDirectory()).toBe(true);
    nothingMigrated();
  });

  it('migrates a dirty tracked tree only with --force', async () => {
    fs.writeFileSync(join(clone, 'package.json'), '{"name":"changed"}');
    expect(await migrate({ clone, home, settings, deps })).toMatchObject({ status: 'refused', reason: 'tracked-dirt' });
    expect((await migrate({ clone, home, settings, deps, force: true })).status).toBe('migrated');
  });

  it('refuses a pre-populated state destination and never deletes a conflicting source entry', async () => {
    fs.mkdirSync(join(home, 'daemon', 'state', '.conveyor'), { recursive: true });
    fs.writeFileSync(join(home, 'daemon', 'state', '.conveyor', 'daemon.log'), 'stale');
    fs.writeFileSync(join(home, 'daemon', 'state', '.operations'), 'a file where the source has a directory');
    const before = snapshot(clone);
    expect(await migrate({ clone, home, settings, deps })).toMatchObject({ status: 'refused', reason: 'state-exists', existing: ['.conveyor', '.operations'] });
    expect(snapshot(clone)).toEqual(before);
    expect(readFileSync(join(home, 'daemon', 'state', '.conveyor', 'daemon.log'))).toBe('stale');

    expect((await migrate({ clone, home, settings, deps, force: true })).status).toBe('migrated');
    // the clone's entries are the live ones; what was in the way is parked, never merged over or deleted
    const parked = files(join(home, 'daemon', 'conflicts'));
    expect(parked).toContain('stale');
    expect(parked).toContain('a file where the source has a directory');
    expect(readFileSync(join(home, 'daemon', 'state', '.conveyor', 'daemon.log'))).toBe('log line\n');
    expect(readFileSync(join(home, 'daemon', 'state', '.operations', 'run.json'))).toBe('1');
  });

  it('a forced migrate that fails puts the clone back exactly as it was', async () => {
    fs.mkdirSync(join(home, 'daemon', 'state', '.conveyor'), { recursive: true });
    fs.writeFileSync(join(home, 'daemon', 'state', '.conveyor', 'daemon.log'), 'stale');
    const before = snapshot(clone);
    deps.buildVersion = async () => { throw new Error('ENOSPC'); };
    await expect(migrate({ clone, home, settings, deps, force: true })).rejects.toThrow('ENOSPC');
    expect(snapshot(clone)).toEqual(before);
    expect(files(join(home, 'daemon', 'conflicts'))).toContain('stale');
  });

  it('a failed migrate leaves home files that existed before it alone', async () => {
    fs.mkdirSync(join(home, 'daemon'), { recursive: true });
    fs.writeFileSync(join(home, 'daemon', 'settings.local.json'), '{"enabled":true,"note":"mine"}');
    fs.writeFileSync(join(home, 'daemon', 'state.json'), '{"keep":1}');
    deps.buildVersion = async () => { throw new Error('boom'); };
    await expect(migrate({ clone, home, settings, deps })).rejects.toThrow('boom');
    expect(readFileSync(join(home, 'daemon', 'settings.local.json'))).toContain('mine');
    expect(readFileSync(join(home, 'daemon', 'state.json'))).toBe('{"keep":1}');
  });

  it('a late rollback restores the contents of home files that existed before, not just their presence', async () => {
    fs.mkdirSync(join(home, 'daemon'), { recursive: true });
    fs.writeFileSync(join(home, 'daemon', 'settings.local.json'), '{"enabled":false,"note":"mine"}');
    fs.writeFileSync(join(home, 'daemon', 'state.json'), '{"keep":1}');
    fs.writeFileSync(join(home, 'daemon', 'migration.json'), 'older record');
    fs.mkdirSync(join(home, 'daemon', 'versions', 'old'), { recursive: true });
    fs.symlinkSync('versions/old', join(home, 'daemon', 'previous'));
    const before = snapshot(join(home, 'daemon'));
    // The swap is the last step: current, previous, state.json, the marker and the record were all rewritten by then.
    await expect(migrate({ clone, home, settings, deps: { ...deps, fs: throwOnRename(/legacy-/) } })).rejects.toThrow('EXDEV');
    const after = snapshot(join(home, 'daemon'));
    for (const f of ['settings.local.json', 'state.json', 'migration.json', 'previous']) expect(after[f]).toBe(before[f]);
    expect(fs.existsSync(join(home, 'daemon', 'current'))).toBe(false);
  });

  it('refuses a home the runtime would not look in, and honours a configured clonesRoot', async () => {
    const elsewhere = join(fixture, 'elsewhere');
    const before = snapshot(clone);
    expect(await migrate({ clone, home: elsewhere, settings, deps })).toMatchObject({ status: 'refused', reason: 'home-not-discoverable', runtimeHome: home });
    expect(fs.existsSync(elsewhere)).toBe(false);
    expect(snapshot(clone)).toEqual(before);
    // the daemon (launchd) cannot be shown to share an env override, nor a relative path's cwd: both are refused
    const withEnv = { ...deps, env: { ...deps.env, WE_DAEMON_VERSIONS_CLONES_ROOT: elsewhere } };
    expect(await migrate({ clone, settings, deps: withEnv })).toMatchObject({ status: 'refused', reason: 'clones-root-env' });
    expect(await migrate({ clone, settings: { ...settings, clonesRoot: 'relative/root' }, deps })).toMatchObject({ status: 'refused', reason: 'clones-root-relative' });
    expect(fs.existsSync(join(ws, '.daemon-clones'))).toBe(false); // refusals leave no empty home behind
    // a configured clonesRoot is the default home, and the runtime resolves the same folder
    const configured = { ...settings, clonesRoot: elsewhere };
    expect((await migrate({ clone, settings: configured, deps })).status).toBe('migrated');
    expect(fs.existsSync(join(elsewhere, 'daemon', 'current'))).toBe(true);
    expect(resolveVersionedContext({ root: clone, settings: { ...configured, enabled: { daemon: true } } }).home).toBe(elsewhere);
    expect((await unmigrate({ clone, settings: configured, deps })).status).toBe('unmigrated');
  });

  const writeIntentFile = intent => {
    fs.mkdirSync(join(home, 'daemon'), { recursive: true });
    fs.writeFileSync(join(home, 'daemon', 'migrate-intent.json'), JSON.stringify(intent));
  };

  it('a migrate killed between a state rename and its link is undone from its intent, then redone, and still unmigrates', async () => {
    const dest = join(home, 'daemon', 'state', '.conveyor');
    fs.mkdirSync(join(home, 'daemon', 'state'), { recursive: true });
    fs.renameSync(join(clone, '.conveyor'), dest); // killed here: gone from the clone, no link yet, no catch ran
    writeIntentFile({ paths: ['.conveyor', '.operations'], exclude: ['/.conveyor', '/.operations'], home: {} });
    const result = await migrate({ clone, home, settings, deps });
    expect(result.status).toBe('migrated');
    expect(result.moved).toEqual(['.conveyor', '.operations']);
    expect(JSON.parse(readFileSync(join(home, 'daemon', 'migration.json'))).moved).toEqual(['.conveyor', '.operations']);
    expect(fs.lstatSync(join(home, 'daemon', 'legacy-20261008T120000Z', '.conveyor')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(join(home, 'daemon', 'migrate-intent.json'))).toBe(false);
    expect((await unmigrate({ clone, home, settings, deps })).restored).toEqual(['.conveyor', '.operations']);
    expect(readFileSync(join(clone, '.conveyor', 'daemon.log'))).toBe('log line\n');
  });

  it('a migrate killed after current and the marker were written, before the swap, can be re-run', async () => {
    await migrate({ clone, home, settings, deps });
    // put the world back as a kill after the pointer writes would leave it: clone is a real dir, no record
    fs.rmSync(clone); fs.renameSync(join(home, 'daemon', 'legacy-20261008T120000Z'), clone);
    fs.rmSync(join(home, 'daemon', 'migration.json'));
    writeIntentFile({ paths: ['.conveyor', '.operations'], exclude: ['/.conveyor', '/.operations'], home: {} });
    expect(await migrate({ clone, home, settings, deps })).toMatchObject({ status: 'migrated', moved: ['.conveyor', '.operations'] });
    expect((await unmigrate({ clone, home, settings, deps })).status).toBe('unmigrated');
    expect(readFileSync(join(clone, '.operations', 'run.json'))).toBe('1');
    expect(readFileSync(join(clone, '.git', 'info', 'exclude')).split('\n')).not.toContain('/.conveyor');
  });

  it('a state/ entry with no clone side and no intent is stale, not an interrupted move', async () => {
    fs.rmSync(join(clone, '.operations'), { recursive: true });
    fs.mkdirSync(join(home, 'daemon', 'state'), { recursive: true });
    fs.writeFileSync(join(home, 'daemon', 'state', '.operations'), 'stale');
    const result = await migrate({ clone, home, settings, deps });
    expect(result.moved).toEqual(['.conveyor']);
    expect(fs.lstatSync(join(home, 'daemon', 'legacy-20261008T120000Z')).isDirectory()).toBe(true);
    expect(fs.existsSync(join(home, 'daemon', 'legacy-20261008T120000Z', '.operations'))).toBe(false);
  });

  it('a rolled-back migrate keeps an exclude line the user wrote themselves', async () => {
    fs.appendFileSync(join(clone, '.git', 'info', 'exclude'), '/.operations\n');
    deps.buildVersion = async () => { throw new Error('boom'); };
    await expect(migrate({ clone, home, settings, deps })).rejects.toThrow('boom');
    const lines = readFileSync(join(clone, '.git', 'info', 'exclude')).split('\n');
    expect(lines).toContain('/.operations');
    expect(lines).not.toContain('/.conveyor');
  });

  it('one migrate at a time: a live owner holds the lock, a dead owner\'s lock is taken over', async () => {
    fs.mkdirSync(join(home, 'daemon'), { recursive: true });
    fs.writeFileSync(join(home, 'daemon', 'migrate.lock'), String(process.ppid)); // the test runner's parent is alive
    expect(await migrate({ clone, home, settings, deps })).toMatchObject({ status: 'refused', reason: 'migrate-in-progress', pid: process.ppid });
    expect(await unmigrate({ clone, home, settings, deps })).toMatchObject({ status: 'refused', reason: 'migrate-in-progress' });
    fs.writeFileSync(join(home, 'daemon', 'migrate.lock'), '2147483646'); // no such process
    expect((await migrate({ clone, home, settings, deps })).status).toBe('migrated');
    expect(fs.existsSync(join(home, 'daemon', 'migrate.lock'))).toBe(false);
  });

  it('when the swap fails and the way back fails too, the real clone is not replaced by an empty directory', async () => {
    const failing = { ...deps, fs: { ...fs, renameSync: (from, to) => {
      if (to === clone) throw Object.assign(new Error('EIO'), { code: 'EIO' }); // the link in, and the way back
      return fs.renameSync(from, to);
    } } };
    const error = await migrate({ clone, home, settings, deps: failing }).catch(e => e);
    expect(error.message).toContain('EIO');
    expect(error.cloneAtLegacy).toBe(join(home, 'daemon', 'legacy-20261008T120000Z'));
    expect(fs.existsSync(clone)).toBe(false); // not recreated as an empty directory
    expect(fs.existsSync(join(error.cloneAtLegacy, 'package.json'))).toBe(true);
  });

  it('a migrate re-run after a crash adopts its own state links and unmigrate restores them', async () => {
    const dest = join(home, 'daemon', 'state', '.conveyor');
    fs.mkdirSync(join(home, 'daemon', 'state'), { recursive: true });
    fs.renameSync(join(clone, '.conveyor'), dest); // the earlier run died right after this
    fs.symlinkSync(dest, join(clone, '.conveyor'));
    const result = await migrate({ clone, home, settings, deps });
    expect(result.moved).toEqual(['.conveyor', '.operations']);
    expect((await unmigrate({ clone, home, settings, deps })).restored).toEqual(['.conveyor', '.operations']);
    expect(fs.lstatSync(join(clone, '.conveyor')).isDirectory()).toBe(true);
    expect(readFileSync(join(clone, '.conveyor', 'daemon.log'))).toBe('log line\n');
  });

  it('unmigrate that dies after restoring the clone is finished by running it again', async () => {
    await migrate({ clone, home, settings, deps });
    let once = true;
    const failing = { ...deps, fs: { ...fs, renameSync: (from, to) => {
      if (once && from.includes(join('daemon', 'state'))) { once = false; throw new Error('EIO'); }
      return fs.renameSync(from, to);
    } } };
    await expect(unmigrate({ clone, home, deps: failing })).rejects.toThrow('EIO');
    expect(fs.lstatSync(clone).isDirectory()).toBe(true);
    expect(await unmigrate({ clone, home, deps })).toMatchObject({ status: 'unmigrated', restored: ['.conveyor', '.operations'] });
    expect(fs.lstatSync(join(clone, '.conveyor')).isDirectory()).toBe(true);
    expect(fs.existsSync(join(home, 'daemon', 'migration.json'))).toBe(false);
  });

  it('rolls everything back when the build throws after the state moved', async () => {
    const before = snapshot(clone);
    deps.buildVersion = async () => { throw new Error('ENOSPC: no space left on device'); };
    await expect(migrate({ clone, home, settings, deps })).rejects.toThrow('ENOSPC');
    expect(snapshot(clone)).toEqual(before);
    expect(fs.lstatSync(clone).isDirectory()).toBe(true);
    nothingMigrated();
    deps.buildVersion = undefined;
    expect((await migrate({ clone, home, settings, deps })).status).toBe('migrated'); // a retry is clean, no merge branch
  });

  it('rolls everything back when the final swap fails after current and the marker were written', async () => {
    const before = snapshot(clone);
    const failing = { ...deps, fs: throwOnRename(/legacy-/) };
    await expect(migrate({ clone, home, settings, deps: failing })).rejects.toThrow('EXDEV');
    expect(snapshot(clone)).toEqual(before);
    expect(fs.lstatSync(clone).isDirectory()).toBe(true);
    expect(fs.existsSync(join(ws, 'daemon.tmp-link'))).toBe(false);
    nothingMigrated();
  });

  it('--dry-run leaves migrate, unmigrate and plist targets unchanged', async () => {
    const preview = await migrate({ clone, home, settings, deps, dryRun: true });
    expect(preview).toMatchObject({ status: 'dry-run', wouldMove: ['.conveyor', '.operations'] });
    expect(fs.existsSync(home)).toBe(false);
    await migrate({ clone, home, settings, deps });
    const migrated = snapshot(ws);
    expect(await unmigrate({ clone, home, settings, deps, dryRun: true })).toMatchObject({ status: 'dry-run', wouldRestore: ['.conveyor', '.operations'] });
    expect(snapshot(ws)).toEqual(migrated);

    const text = '<plist><dict><key>WorkingDirectory</key><string>/w/daemon</string></dict></plist>';
    const file = join(fixture, 'a.plist'); fs.writeFileSync(file, text);
    expect(rewritePlist({ file, name: 'daemon', backupDir: join(fixture, 'bk'), dryRun: true })).toMatchObject({ status: 'dry-run', wouldRewrite: true });
    expect(readFileSync(file)).toBe(text);
    expect(fs.existsSync(join(fixture, 'bk'))).toBe(false);
    const other = join(fixture, 'other.plist'); fs.writeFileSync(other, 'backup');
    expect(rewritePlist({ file, revertFrom: other, dryRun: true })).toMatchObject({ status: 'dry-run' });
    expect(readFileSync(file)).toBe(text);
  });

  it('the CLI passes --dry-run to unmigrate and plist', () => {
    const cli = join(process.cwd(), 'scripts', 'lib', 'daemon-version.mjs');
    const text = '<plist><dict><key>WorkingDirectory</key><string>/w/daemon</string></dict></plist>';
    const file = join(fixture, 'cli.plist'); fs.writeFileSync(file, text);
    const run = (...args) => JSON.parse(spawnSync('node', [cli, ...args], { encoding: 'utf8', env: { ...process.env, ...deps.env } }).stdout);
    expect(run('plist', `--clone=${clone}`, `--file=${file}`, `--backup-dir=${join(fixture, 'bk')}`, '--dry-run')).toMatchObject({ status: 'dry-run' });
    expect(readFileSync(file)).toBe(text);
    expect(fs.existsSync(join(fixture, 'bk'))).toBe(false);
    expect(run('unmigrate', `--clone=${clone}`, `--home=${home}`, '--dry-run')).toMatchObject({ status: 'refused', reason: 'not-migrated' });
  });

  it('unmigrate restores the recorded state paths after the settings changed', async () => {
    await migrate({ clone, home, settings, deps });
    fs.appendFileSync(join(clone, '.operations', 'run.json'), '2');
    const changed = { statePaths: ['.conveyor'], carryPaths: [] };
    expect(await unmigrate({ clone, home, settings: changed, deps })).toMatchObject({ status: 'unmigrated', restored: ['.conveyor', '.operations'] });
    for (const path of ['.conveyor', '.operations']) expect(fs.lstatSync(join(clone, path)).isDirectory()).toBe(true);
    expect(readFileSync(join(clone, '.operations', 'run.json'))).toBe('12');
  });

  it('unmigrate refuses a migration record whose paths escape the clone or home', async () => {
    await migrate({ clone, home, settings, deps });
    const record = join(home, 'daemon', 'migration.json');
    const good = JSON.parse(readFileSync(record));
    for (const bad of [{ moved: ['../escape'] }, { moved: ['/etc'] }, { moved: ['.git'] }, { moved: ['a\u0000b'] }, { legacy: join(fixture, 'elsewhere') }, { excluded: ['/ok\nbad'] }]) {
      fs.writeFileSync(record, JSON.stringify({ ...good, ...bad }));
      expect(await unmigrate({ clone, home, settings, deps })).toMatchObject({ status: 'refused', reason: 'bad-migration-record' });
      expect(fs.lstatSync(clone).isSymbolicLink()).toBe(true);
    }
  });

  it('never records or prints credentials from the origin url, and survives a url that looks like an option', async () => {
    git(clone, 'remote', 'set-url', 'origin', 'https://user:TOPSECRET@example.test/r.git');
    const preview = await migrate({ clone, home, settings, deps, dryRun: true });
    expect(JSON.stringify(preview)).not.toContain('TOPSECRET');
    expect(preview.originUrl).toBe('https://***@example.test/r.git');
    // an '@' inside the password, and a token in the query string
    git(clone, 'remote', 'set-url', 'origin', 'https://user:p@ss:w0rd@example.test/r.git?token=QTOKEN#frag');
    const second = JSON.stringify(await migrate({ clone, home, settings, deps, dryRun: true }));
    for (const secret of ['ss:w0rd', 'QTOKEN', 'frag']) expect(second).not.toContain(secret);
    git(clone, 'remote', 'set-url', 'origin', 'https://user:TOPSECRET@example.test/r.git');
    await migrate({ clone, home, settings, deps });
    const record = join(home, 'daemon', 'migration.json');
    expect(readFileSync(record)).not.toContain('TOPSECRET');
    expect(fs.statSync(record).mode & 0o077).toBe(0);
    await unmigrate({ clone, home, settings, deps });
    git(clone, 'remote', 'set-url', '--', 'origin', '-dash/r.git');
    fs.rmSync(join(home, 'daemon'), { recursive: true, force: true }); // a fresh repo.git, which is where the url is set
    expect((await migrate({ clone, home, settings, deps })).status).toBe('migrated');
    expect(git(join(home, 'daemon', 'repo.git'), 'config', '--get', 'remote.origin.url')).toBe('-dash/r.git');
  });

  it('rewrites only ProgramArguments and WorkingDirectory, with a backup, and reverts', () => {
    const text = `<plist><dict><key>EnvironmentVariables</key><dict><key>X</key><string>/w/daemon/keep</string></dict>
<key>ProgramArguments</key><array><string>/bin/node</string><string>/w/daemon/a.mjs</string></array>
<key>StandardOutPath</key><string>/w/daemon/.conveyor/x.log</string>
<key>WorkingDirectory</key><string>/w/daemon</string></dict></plist>`;
    const next = versionedPlistText(text, { name: 'daemon' });
    expect(next).toContain('<string>/w/.daemon-clones/daemon/current/a.mjs</string>');
    expect(next).toContain('<key>WorkingDirectory</key><string>/w/.daemon-clones/daemon/current</string>');
    expect(next).toContain('/w/daemon/keep');
    expect(next).toContain('/w/daemon/.conveyor/x.log');
    expect(versionedPlistText(next, { name: 'daemon' })).toBe(next);
    // the name is literal text, and only the clone's own directory is rewritten, not a later one with the same name
    expect(versionedPlistText('<key>WorkingDirectory</key><string>/w/dXemon</string>', { name: 'd.emon' })).toContain('/w/dXemon<');
    expect(versionedPlistText('<key>WorkingDirectory</key><string>/w/daemon/scripts/daemon</string>', { name: 'daemon' }))
      .toContain('<string>/w/.daemon-clones/daemon/current/scripts/daemon</string>');
    const file = join(fixture, 'a.plist'); fs.writeFileSync(file, text);
    const r = rewritePlist({ file, name: 'daemon', backupDir: join(fixture, 'bk') });
    expect(fs.readFileSync(r.backup, 'utf8')).toBe(text);
    rewritePlist({ file, revertFrom: r.backup });
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
  });
});
