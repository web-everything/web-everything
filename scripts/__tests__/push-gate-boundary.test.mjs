// @vitest-environment node
// @repo-scanning-test scope=files
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
    const sites = findRawPushes(source, file, entries[file]?.commands); // Parse errors must never become allowlisted sites.
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

describe('command pins', () => {
  let fixtureRoot;
  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'push-gate-pins-'));
    mkdirSync(join(fixtureRoot, 'scripts'));
  });
  afterEach(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  // Parse only temporary fixture files. The source is data: never execute these commands.
  function admitCall(call, commands = [['rev-parse', '--verify']]) {
    const path = join(fixtureRoot, fixtureFile);
    writeFileSync(path, cp + call);
    admit({ [fixtureFile]: readFileSync(path, 'utf8') }, {
      [fixtureFile]: { ...pinned[fixtureFile], commands },
    });
  }

  it('command pins reject a raw git push even when the site count stays unchanged', () => {
    expect(() => admitCall("spawnSync('git', ['-C', dir, 'rev-parse', '--verify', ref]);")).not.toThrow();
    expect(() => admitCall("spawnSync('git', ['push', ref]);")).toThrow(/command/);
  });

  it('command pins treat a spread in a valued global-option slot as an unknown command (fail closed)', () => {
    for (const option of ['-C', '-c', '--git-dir']) {
      expect(() => admitCall(`spawnSync('git', ['${option}', ...p, 'rev-parse', '--verify', ref]);`), option)
        .toThrow(/command/);
    }
  });

  it.each([
    "spawnSync('git', [...prefix, 'rev-parse', '--verify', ref]);",
    "spawnSync('git', ['-C', dir, ...rest, 'rev-parse', '--verify', ref]);",
    "spawnSync('git', [...args]);",
    "spawnSync('git', ['rev-parse', ...flags, ref]);",
    "spawnSync('git', ['rev-parse', '--verify', ...flags]);",
  ])('command pins treat a spread operand as an unknown command (fail closed): %s', call => {
    expect(() => admitCall(call)).toThrow(/command/);
  });

  it.each([
    "spawnSync('git', ['rev-parse', '--verify', ref], {shell:true});",
    "spawnSync('git', ['rev-parse', '--verify', ref], {shell:'/bin/sh'});",
    "spawnSync('git', ['rev-parse', '--verify', ref], options);",
    "spawnSync('git', ['rev-parse', '--verify', ref], {...options});",
    "spawnSync('git', ['rev-parse', '--verify', ref], {shell:enabled});",
    "spawnSync('git', ['rev-parse', '--verify', ref], {get shell() { return true; }});",
    "spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {shell:true});",
    "spawnSync('git', ['rev-parse', '--verify', ref], {...options, shell:false});",
    "spawnSync('git', ['rev-parse', '--verify', ref], {[option]:true});",
  ])('command pins refuse shell execution and unknown spawn options: %s', call => {
    expect(() => admitCall(call)).toThrow(/command/);
  });

  it.each([
    "spawnSync('git', ['-C', 'fixture-path', 'rev-parse', '--verify', ref]);",
    "spawnSync('git', ['-c', config, 'rev-parse', '--verify', ref]);",
    "spawnSync('git', ['--git-dir', dir, 'rev-parse', '--verify', ref]);",
    "spawnSync('git', ['--git-dir=fixture-path', '-Cfixture-path', '--no-pager', 'rev-parse', '--verify', ref]);",
    "spawnSync('git', ['rev-parse', '--verify', ref], {shell:false, cwd:dir});",
  ])('admits a pinned literal command prefix after known global options: %s', call => {
    expect(() => admitCall(call)).not.toThrow();
  });

  it.each([
    "spawnSync('git', ['--unknown-global', 'rev-parse', '--verify', ref]);",
    "spawnSync('git', [globalOption, 'rev-parse', '--verify', ref]);",
    "spawnSync('git', [command, '--verify', ref]);",
    "spawnSync('git', ['rev-parse', ref]);",
    "spawnSync('git', ['rev-parse', '--verify', '--extra', ref]);",
    "execSync('git push');",
    "spawnSync('git', ['rev-parse', '--verify', ref], {__proto__:options});",
  ])('refuses an unknown or different command identity: %s', call => {
    expect(() => admitCall(call)).toThrow(/command/);
  });

  it.each([null, [], [[]], [['']], [[null]], ['rev-parse']].map(commands => [commands]))('refuses malformed command pins: %j', commands => {
    expect(() => admitCall("spawnSync('git', ['rev-parse', '--verify', ref]);", commands)).toThrow(/command/);
  });
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
