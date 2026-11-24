// @vitest-environment node
// @repo-scanning-test scope=files
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanScope, scanRoot, scopedScanFiles } from '../lib/repo-scan-tests.mjs';
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
  it('only lints tracked non-test script sources', () => {
    expect(isLintedScript('scripts/conveyor/x.mjs')).toBe(true);
    expect(isLintedScript('scripts/__tests__/x.test.mjs')).toBe(false);
    expect(isLintedScript('scripts/conveyor/__tests__/x.mjs')).toBe(false);
    expect(isLintedScript('scripts/lib/authorized-push.mjs')).toBe(false);
    expect(isLintedScript('src/x.mjs')).toBe(false);
  });
});

// The fixture and live inventory must pass exactly the same admission checks.
function admit(sources, entries) {
  const found = {};
  for (const [file, source] of Object.entries(sources)) {
    const sites = findRawPushes(source, file); // Parse errors must never become allowlisted sites.
    if (sites.length) found[file] = sites.length;
  }
  for (const file of new Set([...Object.keys(sources), ...Object.keys(entries)])) {
    const count = found[file] || 0, entry = entries[file];
    if (!count && !entry) continue;
    if (!entry || entry.status !== 'pending-migration' || String(entry.reason || '').length <= 5
      || !Number.isInteger(entry.sites) || entry.sites < 1 || count !== entry.sites) {
      throw new Error(`${file}: raw push count ${count}, pinned ${entry?.sites ?? 'none'}; review sites and allowlist`);
    }
  }
}

const fixtureFile = 'scripts/new-fixture.mjs';
const pinned = { [fixtureFile]: { status: 'pending-migration', reason: 'fixture migration', sites: 1 } };
it('refuses a new raw push parsed from fixture source through real admission', () => {
  expect(() => admit({ [fixtureFile]: "spawn('git', ['push']);" }, {})).toThrow(/pinned none/);
});
it('refuses extra or removed sites in an allowlisted file', () => {
  for (const source of ["git('push'); git('push');", "git('status');"]) {
    expect(() => admit({ [fixtureFile]: source }, pinned)).toThrow(/raw push count/);
  }
  expect(() => admit({ [fixtureFile]: "git('push');" }, pinned)).not.toThrow();
});
it('refuses an allowlisted file with invalid syntax instead of counting a site', () => {
  expect(() => admit({ [fixtureFile]: 'execSync(' }, pinned)).toThrow(/parse error/);
});

describe('push-gate boundary over the real tree', () => {
  it('admits only reviewed site counts, with no stale entries or parse errors', () => {
    const allow = JSON.parse(readFileSync(new URL('../push-gate-allowlist.json', import.meta.url), 'utf8'));
    // Enumerate all scripts; the shared predicate includes .mts/.cts and excludes only test filenames/directories.
    const files = execFileSync('git', ['ls-files', '-z', 'scripts'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 })
      .split('\0').filter(isLintedScript);
    const sources = Object.fromEntries(scopedScanFiles(files).map(file => [file, readFileSync(join(scanRoot(root), file), 'utf8')]));
    const scope = scanScope();
    const entries = Object.fromEntries(Object.entries(allow.entries).filter(([file]) => !scope || scope.has(file)));
    admit(sources, entries);
  });
});
