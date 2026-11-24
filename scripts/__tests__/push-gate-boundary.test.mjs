// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findRawPushes, isLintedScript } from '../lib/push-gate-lint.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const cp = "import { execFileSync, spawnSync, execSync } from 'node:child_process';\n";

describe('push-gate lint (negative test 14)', () => {
  it.each([
    "execFileSync('git', ['push']);",
    "execFileSync('git', ['push', '--force-with-lease', 'origin', 'x']);",
    "spawnSync('git', ['-C', dir, 'push', 'origin', 'HEAD']);",
    "execSync('git push origin HEAD');",
    "execFileSync('sh', ['-c', 'git push origin HEAD']);",
    "spawnSync('bash', ['-c', `cd ${dir} && git -C x push`]);",
    "git(['push', 'origin', 'x']);",
    "run('git', ['push']);",
    "git('push', 'origin');",
  ])('flags a raw push: %s', call => {
    expect(findRawPushes(cp + call)).toHaveLength(1);
  });
  it.each([
    "execFileSync('git', ['status']);",
    "execFileSync('git', ['fetch', 'origin']);",
    "execSync('echo pushing');",
    "list.push('push');",
    "const x = ['push'];",
    "spawnSync('git', ['log', '--grep', 'push']);",
  ])('ignores a non-push: %s', call => {
    expect(findRawPushes(cp + call)).toEqual([]);
  });
  it('only lints tracked non-test scripts mjs files', () => {
    expect(isLintedScript('scripts/conveyor/x.mjs')).toBe(true);
    expect(isLintedScript('scripts/__tests__/x.test.mjs')).toBe(false);
    expect(isLintedScript('scripts/conveyor/__tests__/x.mjs')).toBe(false);
    expect(isLintedScript('scripts/lib/authorized-push.mjs')).toBe(false);
    expect(isLintedScript('src/x.mjs')).toBe(false);
  });
});

describe('push-gate boundary over the real tree', () => {
  const allow = JSON.parse(readFileSync(new URL('../push-gate-allowlist.json', import.meta.url), 'utf8'));
  const files = execFileSync('git', ['ls-files', 'scripts'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 })
    .split('\n').filter(isLintedScript);
  const found = {};
  for (const file of files) {
    const sites = findRawPushes(readFileSync(root + file, 'utf8'), file);
    if (sites.length) found[file] = sites.length;
  }
  it('every raw push site is allowlisted with a reason', () => {
    const unlisted = Object.keys(found).filter(file => !allow.entries?.[file]);
    expect(unlisted).toEqual([]);
  });
  it('every allowlist entry is pending-migration, has a reason, and is not stale', () => {
    for (const [file, entry] of Object.entries(allow.entries || {})) {
      expect(entry.status, file).toBe('pending-migration');
      expect(String(entry.reason || '').length, file).toBeGreaterThan(5);
    }
    const stale = Object.keys(allow.entries || {}).filter(file => !found[file]);
    expect(stale).toEqual([]);
  });
  it('fails on a fixture adding a new raw push', () => {
    const fixture = { ...found, 'scripts/conveyor/new-fixture.mjs': 1 };
    expect(Object.keys(fixture).filter(file => !allow.entries?.[file])).toEqual(['scripts/conveyor/new-fixture.mjs']);
  });
});
