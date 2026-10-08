/** @file scripts/lib/__tests__/daemon-version-migrate.test.mjs — S6 migrate/unmigrate fixture round trip. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, unmigrate, versionedPlistText, rewritePlist } from '../daemon-version-migrate.mjs';
import { cloneKey } from '../daemon-overlays.mjs';
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
    const file = join(fixture, 'a.plist'); fs.writeFileSync(file, text);
    const r = rewritePlist({ file, name: 'daemon', backupDir: join(fixture, 'bk') });
    expect(fs.readFileSync(r.backup, 'utf8')).toBe(text);
    rewritePlist({ file, revertFrom: r.backup });
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
  });
});
