/**
 * Run a security guard from a trusted origin/main snapshot, never the cwd tree.
 * Usage: node run-pinned-guard.mjs scripts/<guard>.mjs [args...]
 * The settings wrapper uses Git's common dir for linked worktrees. For clone
 * lanes under <workspace>/.lanes/, it selects <workspace>/web-everything (legacy:
 * webeverything), outside the lane, and denies if that primary is unavailable.
 * Keep that primary bootstrap trusted. No fetch is performed: updating the
 * local origin/main ref refreshes the snapshot on the next invocation.
 * PostToolUse and Session* hooks remain local: they perform lifecycle/bookkeeping
 * work rather than admission decisions, and need the checkout's current tooling.
 * Operator escape: revert the relevant settings.json command to
 * `node scripts/<x>.mjs` to deliberately use the working-tree guard again.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

const root = resolve(process.env.WE_PINNED_HOOKS_DIR || join(homedir(), '.claude/pinned-hooks'));
const shaPattern = /^[a-f0-9]{40,64}$/;
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

try {
  const [script, ...args] = process.argv.slice(2);
  if (!script || !/^scripts\/.+\.mjs$/.test(script) || script.split('/').includes('..')) throw new Error('expected a scripts/<guard>.mjs relative path');
  const hookRoot = realpathSync(git(process.cwd(), ['rev-parse', '--show-toplevel']));
  let primary, sha;
  try {
    primary = dirname(git(process.cwd(), ['rev-parse', '--path-format=absolute', '--git-common-dir']));
    const laneIndex = primary.indexOf(`${sep}.lanes${sep}`);
    if (laneIndex >= 0) {
      const workspace = primary.slice(0, laneIndex);
      primary = join(workspace, 'web-everything');
      if (!existsSync(primary)) primary = join(workspace, 'webeverything');
      primary = realpathSync(primary);
      if (primary.includes(`${sep}.lanes${sep}`)) throw new Error('refusing a lane primary');
    }
    sha = git(primary, ['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}']);
    if (!shaPattern.test(sha)) throw new Error('invalid origin/main SHA');
  } catch {
    sha = readlinkSync(join(root, 'latest'));
    if (!shaPattern.test(sha)) throw new Error('invalid latest snapshot pointer');
    process.stderr.write(`Pinned guard: origin/main unavailable; using latest snapshot ${sha}\n`);
  }
  mkdirSync(root, { recursive: true });
  const pinned = join(root, sha);
  if (!existsSync(pinned)) {
    if (!primary) throw new Error('latest snapshot is unavailable');
    const temp = mkdtempSync(join(root, '.snapshot-'));
    try {
      const archive = join(temp, 'snapshot.tar');
      git(primary, ['archive', '--format=tar', `--output=${archive}`, sha, 'scripts', 'package.json']);
      execFileSync('tar', ['-xf', archive, '-C', temp], { timeout: 30_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      rmSync(archive);
      if (existsSync(join(primary, 'node_modules'))) symlinkSync(join(primary, 'node_modules'), join(temp, 'node_modules'), 'dir');
      try { renameSync(temp, pinned); } catch (error) {
        if (!existsSync(pinned)) throw error; // Another invocation published the same SHA.
      }
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }
  const target = realpathSync(join(pinned, script));
  if (!target.startsWith(realpathSync(pinned) + sep) || !statSync(target).isFile()) throw new Error(`missing or unsafe guard: ${script}`);
  const pointer = join(root, `.latest-${randomUUID()}`);
  try {
    symlinkSync(sha, pointer);
    renameSync(pointer, join(root, 'latest'));
  } finally { rmSync(pointer, { force: true }); }
  const older = readdirSync(root).filter(name => shaPattern.test(name) && name !== sha)
    .sort((a, b) => statSync(join(root, b)).mtimeMs - statSync(join(root, a)).mtimeMs);
  for (const name of older.slice(2)) rmSync(join(root, name), { recursive: true, force: true });
  const child = spawnSync(process.execPath, [target, ...args], { stdio: 'inherit', cwd: process.cwd(), env: { ...process.env, WE_HOOK_ROOT: hookRoot } });
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 2;
} catch (error) {
  process.stderr.write(`Pinned guard: cannot load trusted guard; denying (exit 2): ${error.message}\n`);
  process.exitCode = 2;
}
