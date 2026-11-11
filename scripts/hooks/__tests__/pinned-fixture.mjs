import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export function removeFixture(path) {
  rmSync(path, { recursive: true, force: true, maxRetries: 3 });
}

/** Operated primary/worktree plus an independent trusted guard clone. */
export function pinnedFixture({ launcherOnly = false } = {}) {
  const temp = realpathSync(mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'hook-root-')));
  const primary = join(temp, 'web-everything');
  const env = { ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'WE_HOOK_ROOT', 'LANE_GUARD_OFF']) delete env[key];
  const git = (cwd, ...args) => {
    const result = spawnSync('git', ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], { cwd, env, encoding: 'utf8', maxBuffer: 1024 * 1024 });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  mkdirSync(primary);
  if (launcherOnly) {
    mkdirSync(join(primary, 'scripts/hooks'), { recursive: true });
    cpSync(join(source, 'scripts/hooks/run-pinned-guard.mjs'), join(primary, 'scripts/hooks/run-pinned-guard.mjs'));
  } else {
    cpSync(join(source, 'scripts'), join(primary, 'scripts'), {
      recursive: true, filter: path => !path.split('/').includes('__tests__') && !/\.(?:test|spec)\.[^/]+$/.test(path),
    });
  }
  writeFileSync(join(primary, 'package.json'), '{"type":"module","name":"web-everything"}');
  git(primary, 'init', '-b', 'main');
  git(primary, 'config', 'user.email', 'fixture@example.test');
  git(primary, 'config', 'user.name', 'Fixture');
  git(primary, 'config', 'core.hooksPath', '/dev/null');
  git(primary, 'add', '.');
  git(primary, 'commit', '-qm', 'trusted guards');
  symlinkSync(join(source, 'node_modules'), join(primary, 'node_modules'), 'dir');
  const lane = join(temp, '.lanes/web-everything/lane-1');
  mkdirSync(dirname(lane), { recursive: true });
  git(primary, 'worktree', 'add', '-b', 'lane', lane);
  env.HOME = join(temp, 'home with spaces');
  mkdirSync(join(env.HOME, 'workspace'), { recursive: true });
  const clone = join(env.HOME, 'workspace/.guard-main');
  git(temp, 'clone', '--single-branch', '--branch', 'main', primary, clone);
  // Dependencies resolve from the clone's parent: the launcher refuses any untracked or
  // ignored file inside the clone, so none may be planted there.
  symlinkSync(join(source, 'node_modules'), join(dirname(clone), 'node_modules'), 'dir');
  writeFileSync(join(clone, '.git/FETCH_HEAD'), '');
  delete env.WE_GUARD_CLONE;
  return { primary, lane, clone, temp, env, git,
    run(cwd, script, event, args = []) {
      return spawnSync(process.execPath, [join(clone, 'scripts/hooks/run-pinned-guard.mjs'), script, ...args], {
        cwd, env, encoding: 'utf8', input: JSON.stringify(event), maxBuffer: 1024 * 1024,
      });
    },
    command(cwd, command, event) {
      return spawnSync('sh', ['-c', command], {
        cwd, env, encoding: 'utf8', input: JSON.stringify(event), maxBuffer: 1024 * 1024,
      });
    },
    cleanup() { removeFixture(temp); },
  };
}
