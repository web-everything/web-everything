import { chmodSync, lstatSync, readdirSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Unlock only real directories, never dependency symlinks, for fixture cleanup. */
export function removeFixture(path) {
  function unlock(dir) {
    if (!lstatSync(dir).isDirectory()) return;
    chmodSync(dir, 0o700);
    for (const name of readdirSync(dir)) unlock(join(dir, name));
  }
  unlock(path);
  rmSync(path, { recursive: true, force: true });
}

/** Real Git snapshot containing the current guards, isolated from operator refs/cache. */
export function pinnedFixture() {
  const temp = realpathSync(mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'hook-root-')));
  const primary = join(temp, 'web-everything');
  const env = { ...process.env, WE_PINNED_HOOKS_DIR: join(temp, 'cache'),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'WE_HOOK_ROOT', 'LANE_GUARD_OFF']) delete env[key];
  const git = (cwd, ...args) => {
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8', maxBuffer: 1024 * 1024 });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  mkdirSync(primary);
  cpSync(join(source, 'scripts'), join(primary, 'scripts'), {
    recursive: true, filter: path => !path.split('/').includes('__tests__') && !/\.(?:test|spec)\.[^/]+$/.test(path),
  });
  writeFileSync(join(primary, 'package.json'), '{"type":"module","name":"web-everything"}');
  git(primary, 'init', '-b', 'main');
  git(primary, 'config', 'user.email', 'fixture@example.test');
  git(primary, 'config', 'user.name', 'Fixture');
  git(primary, 'config', 'core.hooksPath', '/dev/null');
  git(primary, 'add', '.');
  git(primary, 'commit', '-qm', 'trusted guards');
  git(primary, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  symlinkSync(join(source, 'node_modules'), join(primary, 'node_modules'), 'dir');
  const lane = join(temp, '.lanes/web-everything/lane-1');
  mkdirSync(dirname(lane), { recursive: true });
  git(primary, 'worktree', 'add', '-b', 'lane', lane);
  return { primary, lane, temp, env,
    run(cwd, script, event) {
      return spawnSync(process.execPath, [join(source, 'scripts/hooks/run-pinned-guard.mjs'), script], {
        cwd, env, encoding: 'utf8', input: JSON.stringify(event), maxBuffer: 1024 * 1024,
      });
    },
    cleanup() { removeFixture(temp); },
  };
}
