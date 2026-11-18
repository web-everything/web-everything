import { describe, expect, it } from 'vitest';
import { relative, resolve } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  AGENT_LAUNCH_ALLOWLIST, AGENT_LAUNCH_CAPABILITY_BASELINE, findAgentLaunches,
  findCapabilityImporters, findNewCapabilityFiles, readAgentLaunchTree,
} from '../lib/agent-launch-structure.mjs';

const root = resolve(import.meta.dirname, '../..');
const relativePath = file => relative(root, file).replaceAll('\\', '/');
const inventory = sources => findAgentLaunches(sources).map(({ file, function: fn, kind, fingerprint, moduleFingerprint }) => ({
  file: relativePath(file), function: fn, kind, fingerprint, ...(moduleFingerprint ? { moduleFingerprint } : {}),
}));
const source = command => `import {spawn} from 'node:child_process'; export function launch(){spawn(${command},[])}`;

describe('agent launcher tripwire and separate capability snapshot', () => {
  it.each(['mjs', 'cjs', 'js', 'mts', 'cts', 'ts'])('detects command-position agent launches in .%s', extension => {
    expect(findAgentLaunches({ [`scripts/new.${extension}`]: source("'codex'") })).toHaveLength(1);
  });
  it.each([
    "import {spawn as start} from 'node:child_process'; start('claude',[])",
    "import start from 'cross-spawn'; start('codex',[])",
    "const start=require('cross-spawn'); start('claude',[])",
    "import * as tools from 'execa'; tools.execa('codex',[])",
    "import * as cp from 'node:child_process'; cp.spawn('codex',[])",
    "const {execFile:start}=require('node:child_process'); start('claude',[])",
    "const {spawn}=await import('node:child_process'); const start=spawn; start('codex',[])",
    "import {spawn} from 'node:child_process'; const CLI='claude'; spawn(CLI,[])",
    "import {spawn} from 'node:child_process'; function f({cli='codex'}={}){spawn(cli,[])}",
    "import {execFile} from 'node:child_process'; execFile('/usr/bin/codex',[])",
    "import {spawn} from 'node:child_process'; spawn('sh',['-c','echo ready; codex e resume unchecked-id'])",
    "import {exec} from 'node:child_process'; exec('echo ready && claude -p hello')",
    "import {spawn} from 'node:child_process'; spawn('npx',['codex','exec'])",
    "import {spawn} from 'node:child_process'; const commands=['codex','exec']; spawn(commands[0],[])",
    "import {spawn} from 'node:child_process'; const bins={main:'claude'}; spawn(bins.main,[])",
  ])('detects agent command evidence: %s', text => {
    expect(findAgentLaunches({ 'scripts/new.mjs': text }).length).toBeGreaterThan(0);
  });
  it.each([
    "import {spawn} from 'node:child_process'; spawn('git',['claude'])",
    "import {spawn} from 'node:child_process'; spawn('echo',['codex exec'])",
    "import {spawn} from 'node:child_process'; spawn('env',['git','claude'])",
    "import {spawn} from 'node:child_process'; spawn('claude-tools',['mycodex'])",
    "import {spawn} from 'node:child_process'; spawn(['git','codex'],[])",
    "import {exec} from 'node:child_process'; exec('echo codex')",
    "console.log('claude'); const docs='codex exec'; // spawn('claude',[])",
    "import {basename} from 'node:path'; basename('claude')",
    "const reason = executor => ({executor}); reason('codex')",
  ])('does not approve ordinary argv or agent mentions as launchers: %s', text => {
    expect(findAgentLaunches({ 'scripts/ordinary.mjs': text })).toEqual([]);
  });
  it('follows imported helpers, aliases and re-exports, pinning the helper implementation', () => {
    const sources = {
      'scripts/helper.mjs': "import {spawn as primitive} from 'node:child_process'; export function start(...args){return primitive(...args)}",
      'scripts/bridge.mjs': "export {start as run} from './helper.mjs'",
      'scripts/caller.mjs': "import {run as begin} from './bridge.mjs'; begin('claude',[])",
    };
    const findings = findAgentLaunches(sources);
    expect(findings.map(row => relativePath(row.file))).toEqual(['scripts/caller.mjs', 'scripts/helper.mjs']);
    expect(findings.find(row => row.function === 'start')?.reason).toContain('launcher helper');
  });
  it('does not inventory an unused generic process helper or its ordinary-command caller', () => {
    expect(findAgentLaunches({
      'scripts/helper.mjs': "import {spawn} from 'node:child_process'; export function start(...args){return spawn(...args)}",
      'scripts/caller.mjs': "import {start} from './helper.mjs'; start('git',[])",
    })).toEqual([]);
  });
  it('pins the complete outer function and captured module definitions', () => {
    const before = "import {spawn} from 'node:child_process'; const CLI='codex'; function launch(){const argv=['exec']; return ()=>spawn(CLI,argv)}";
    const original = inventory({ 'scripts/new.mjs': before });
    expect(original[0].function).toBe('launch');
    expect(inventory({ 'scripts/new.mjs': before.replace("['exec']", "['e','resume','unchecked']") })).not.toEqual(original);
    expect(inventory({ 'scripts/new.mjs': before.replace("CLI='codex'", "CLI='claude'") })).not.toEqual(original);
    expect(inventory({ 'scripts/new.mjs': '// a comment\n' + before })).toEqual(original);
  });
  it.each(['sh', 'bash'])('scans .%s launches only in shell command position', extension => {
    const file = `scripts/launch.${extension}`;
    for (const text of ["co'dex' e resume unchecked-id", 'echo ready; claude -p hello', 'env FLAG=yes /bin/codex exec', 'bash -c "codex e resume unchecked-id"']) {
      expect(findAgentLaunches({ [file]: text })).toHaveLength(1);
    }
    for (const text of ['# codex exec\necho ready', 'echo codex exec', 'printf "%s" "claude --resume id"']) {
      expect(findAgentLaunches({ [file]: text })).toEqual([]);
    }
  });
  it.each(['child_process', 'node:child_process', 'execa', 'node:worker_threads', 'node:vm', 'node:module', 'node:process'])('records capability import %s without granting launch approval', name => {
    const sources = { 'scripts/ordinary.mjs': `import * as api from '${name}';` };
    expect(findCapabilityImporters(sources)).toEqual(['scripts/ordinary.mjs']);
    expect(findAgentLaunches(sources)).toEqual([]);
    expect(findNewCapabilityFiles(sources, [], [])).toMatchObject([{ reason: expect.stringContaining('add it to the capability baseline in review') }]);
    expect(findNewCapabilityFiles(sources, ['scripts/ordinary.mjs'], [])).toEqual([]);
  });
  it.each([
    "export {spawn} from 'node:child_process'",
    "const cp=require('child_process')",
    "import('node:child_process')",
    'import cp = require("child_process")',
  ])('records loader and re-export capability imports: %s', text => {
    expect(findCapabilityImporters({ 'scripts/new.ts': text })).toEqual(['scripts/new.ts']);
  });
  it('baseline membership never exempts an existing importer that starts launching agents', () => {
    const path = 'scripts/existing.mjs';
    const baseline = [path];
    const before = { [path]: source("'git'") };
    const after = { [path]: source("'codex'") };
    expect(findNewCapabilityFiles(before, baseline, [])).toEqual([]);
    expect(findAgentLaunches(before)).toEqual([]);
    expect(findNewCapabilityFiles(after, baseline, [])).toEqual([]);
    const findings = findAgentLaunches(after);
    expect(findings.map(row => relativePath(row.file))).toEqual([path]);
    expect(AGENT_LAUNCH_ALLOWLIST).not.toContain(path);
  });
  it('a reviewed new launcher satisfies new-file admission but still requires fingerprints', () => {
    const path = 'scripts/new.mjs', sources = { [path]: source("'claude'") };
    expect(findNewCapabilityFiles(sources, [], [])).toHaveLength(1);
    expect(findNewCapabilityFiles(sources, [], [path])).toEqual([]);
    expect(findAgentLaunches(sources)[0].fingerprint).toMatch(/^module-sha256-v2:/);
  });
  it.each(['__tests__/launch.mjs', 'tests/launch.ts', 'fixtures/launch.sh', '__fixtures__/launch.bash', 'test-fixtures/launch.mts', 'launch.test.mjs', 'launch.spec.cts', 'node_modules/launch.js', '.git/launch.js'])('never inventories tests, fixtures or dependencies: %s', suffix => {
    const sources = { [`scripts/${suffix}`]: suffix.endsWith('.sh') || suffix.endsWith('.bash') ? 'codex exec' : source("'codex'") };
    expect(findCapabilityImporters(sources)).toEqual([]);
    expect(findAgentLaunches(sources)).toEqual([]);
  });
  it('reads only the three owned roots and scoped extensions, including symlinked skills', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'r115-tree-'));
    const files = ['scripts/source.mts', 'scripts/launch.sh', 'skills-src/example/run.cts'];
    try {
      for (const file of [...files, 'other/launch.js', 'scripts/tests/launch.mjs', 'scripts/fixtures/launch.sh', 'scripts/node_modules/launch.js', 'scripts/file.py']) {
        mkdirSync(resolve(dir, file, '..'), { recursive: true }); writeFileSync(resolve(dir, file), 'codex exec');
      }
      mkdirSync(resolve(dir, '.claude'), { recursive: true });
      symlinkSync('../skills-src', resolve(dir, '.claude/skills'));
      expect(Object.keys(readAgentLaunchTree(dir)).map(path => relative(dir, path)).sort())
        .toEqual([...files, '.claude/skills/example/run.cts'].sort());
      symlinkSync('missing.mjs', resolve(dir, 'scripts/broken.mjs'));
      expect(() => readAgentLaunchTree(dir)).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('fails closed on cyclic source directories', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'r115-cycle-'));
    try {
      mkdirSync(resolve(dir, 'scripts')); symlinkSync('.', resolve(dir, 'scripts/cycle'));
      expect(() => readAgentLaunchTree(dir)).toThrow(/cyclic source/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each(['mjs', 'mts'])('fails closed on incomplete .%s evidence with an operator fallback', extension => {
    const sources = { [`scripts/broken.${extension}`]: 'export function broken( {' };
    expect(() => findAgentLaunches(sources)).toThrow(/repair source or request scanner support/);
    expect(() => findCapabilityImporters(sources)).toThrow(/repair source or request scanner support/);
  });
  it('keeps the reviewed launchers small and independent of the existing-importer snapshot', () => {
    const baseline = JSON.parse(readFileSync(resolve(root, 'scripts/lib/agent-launch-capability-baseline.json'), 'utf8'));
    expect(baseline.description).toContain('NOT approval of agent launching');
    expect(AGENT_LAUNCH_ALLOWLIST.length).toBeLessThan(100);
    for (const paths of [AGENT_LAUNCH_ALLOWLIST, AGENT_LAUNCH_CAPABILITY_BASELINE]) {
      expect(paths).toEqual([...new Set(paths)].sort());
      expect(paths.every(path => !/(?:__tests__|fixtures|\.test\.|\.spec\.)/.test(path))).toBe(true);
    }
    expect(AGENT_LAUNCH_CAPABILITY_BASELINE.length).toBeGreaterThan(500);
  });
  it('admits exactly the reviewed production launchers with whole-function fingerprints and no new capability files', () => {
    const sources = readAgentLaunchTree(root);
    expect(findNewCapabilityFiles(sources)).toEqual([]);
    const rows = inventory(sources);
    expect([...new Set(rows.map(row => row.file))].sort()).toEqual(AGENT_LAUNCH_ALLOWLIST);
    expect(rows).toMatchSnapshot();
  }, 60_000);
});
