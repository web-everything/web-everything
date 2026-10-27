import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

it('applies both settings to discovered clones or repeated selectors, with a read-only dry run and idempotent writes', () => {
  const root = mkdtempSync(join(tmpdir(), 'lane-maintenance-'));
  const cli = resolve('scripts/lane-pool.mjs');
  const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const init = (rel) => {
    const dir = join(root, rel);
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '--quiet');
    return dir;
  };
  try {
    const cwd = init('primary');
    const lane = init('.lanes/one/lane-1');
    const other = init('.lanes/two/lane-2');
    const daemon = init('wev-review-daemon');
    const explicit = init('extra');
    const clones = [lane, other, daemon];
    git(lane, 'config', '--local', 'gc.auto', '42');
    git(lane, 'config', '--local', 'maintenance.auto', 'true');
    writeFileSync(join(lane, 'untouched'), 'keep this work');
    const config = (dir) => readFileSync(join(dir, '.git', 'config'), 'utf8');
    const before = clones.map(config);
    const run = (...args) => {
      const result = spawnSync(process.execPath, [cli, 'apply-git-maintenance-config', ...args], {
        cwd, encoding: 'utf8', timeout: 30000,
        env: { ...process.env, LANE_POOL_ROOT: join(root, '.lanes'), WE_DAEMON_OVERLAY_DIR: join(root, 'overlays') },
      });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout + result.stderr;
    };
    const preview = run('--dry-run');
    expect(preview).toContain('gc.auto 42 -> 0 (dry-run)');
    expect(preview).toContain('maintenance.auto true -> false (dry-run)');
    expect(clones.map(config)).toEqual(before);
    expect(run()).toContain('maintenance.auto true -> false');
    for (const dir of clones) {
      expect(git(dir, 'config', '--local', '--get', 'gc.auto')).toBe('0');
      expect(git(dir, 'config', '--local', '--get', 'maintenance.auto')).toBe('false');
    }
    const applied = clones.map(config);
    run();
    expect(clones.map(config)).toEqual(applied);
    git(lane, 'config', '--local', 'maintenance.auto', 'true');
    run(`--clone=${explicit}`, `--clone=${lane}`, `--clone=${lane}`);
    expect(git(explicit, 'config', '--local', '--get', 'gc.auto')).toBe('0');
    expect(git(explicit, 'config', '--local', '--get', 'maintenance.auto')).toBe('false');
    expect(git(lane, 'config', '--local', '--get', 'maintenance.auto')).toBe('false');
    expect(readFileSync(join(lane, 'untouched'), 'utf8')).toBe('keep this work');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
