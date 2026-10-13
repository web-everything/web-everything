import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { numberPendingHashes } from '../lane-drain.mjs';

it('honours minNext while retaining the default max+1', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'min-next-'));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
  try {
    git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@test'); git('config', 'commit.gpgsign', 'false');
    mkdirSync(join(cwd, 'backlog'));
    writeFileSync(join(cwd, 'backlog/010-old.md'), '---\nstatus: resolved\n---\n');
    writeFileSync(join(cwd, 'backlog/xabc123-foo.md'), '---\nstatus: open\n---\n');
    git('add', '.'); git('commit', '-qm', 'fixture');
    expect(numberPendingHashes(cwd, { dryRun: true }).assigned[0].nnn).toBe('011');
    expect(numberPendingHashes(cwd, { dryRun: true, minNext: 42 }).assigned[0].nnn).toBe('042');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
