import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as gates from '../lib/verify-lane-gate.mjs';

const options = (files = ['src/a.ts']) => ({
  base: 'upstream/release', scripts: ['test', 'check:standards'], env: { WE_VERIFY_SELECTION: 'pr', WE_VERIFY_TEST_TIMEOUT_FACTOR: '1' }, fileConfig: null,
  fileExists: () => false, readRepoFile: () => '',
  runGit: vi.fn(args => {
    if (args[0] === 'merge-base') return 'base-sha';
    if (args[0] === 'diff') return args.includes('--diff-filter=D') ? '' : files.join('\n');
    if (args[0] === 'ls-files') return '';
    throw new Error('no matches');
  }),
});

// Run the real CLI in a child; replace child_process before its named ESM imports bind.
// No Git/network/gate process may escape this fixture. A release branch avoids backlog numbering.
function runPushCli({ upToDate = false, fetchFails = false, flags = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'push-if-green-cli-'));
  try {
    const log = join(dir, 'calls.jsonl');
    const preload = join(dir, 'stub-process.mjs');
    const preferences = join(dir, 'preferences.json');
    writeFileSync(log, '');
    writeFileSync(preferences, '{}');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    writeFileSync(preload, `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync } from 'node:fs';
const record = entry => appendFileSync(${JSON.stringify(log)}, JSON.stringify(entry) + '\\n');
const local = 'a'.repeat(40);
const remote = ${upToDate} ? local : 'b'.repeat(40);
childProcess.execFileSync = (command, args) => {
  record({ kind: 'execFile', command, args });
  if (command !== 'git') throw new Error('unexpected executable: ' + command);
  if (args[0] === 'fetch') {
    if (${fetchFails}) throw new Error('fixture fetch failed');
    return '';
  }
  if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'release';
  if (args[0] === 'rev-parse' && args[1] === 'release') return local;
  if (args[0] === 'rev-parse' && args[1] === 'origin/release') return remote;
  if (args[0] === 'merge-base') return args.includes('--is-ancestor') ? '' : remote;
  if (args[0] === 'diff') return args.includes('--diff-filter=D') ? '' : 'src/a.ts';
  if (args[0] === 'ls-files' || args[0] === 'push') return '';
  throw new Error('unexpected git call: ' + args.join(' '));
};
childProcess.execSync = command => { record({ kind: 'gate', command }); return ''; };
syncBuiltinESMExports();
`);
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href,
      join(process.cwd(), 'scripts', 'push-if-green.mjs'), '--branch=release', '--json', ...flags], {
      cwd: dir, encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, NODE_OPTIONS: '', WE_PLATFORM_PREFERENCES_FILE: preferences, WE_VERIFY_SELECTION: 'pr' },
    });
    expect(result.error).toBeUndefined();
    const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    return { ...result, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('R913 push-if-green CLI publication guards', () => {
  it.each([
    { mode: 'default gate', flags: [] },
    { mode: 'explicit gate', flags: ['--gate=fixture-explicit-gate'] },
  ])('an up-to-date branch skips verification and push with $mode', ({ flags }) => {
    const result = runPushCli({ upToDate: true, flags });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ pushed: false, gate: 'skipped', reason: 'up-to-date' });
    expect(result.calls).toContainEqual({ kind: 'execFile', command: 'git', args: ['fetch', 'origin', 'release', '--quiet'] });
    expect(result.calls.filter(call => call.kind === 'gate')).toEqual([]);
    expect(result.calls.filter(call => call.args?.[0] === 'push')).toEqual([]);
  });
  it('a failed fetch refuses default publication with exit 2, no verification and no push', () => {
    const result = runPushCli({ fetchFails: true });
    expect(result.status, result.stderr).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ pushed: false, gate: 'red', reason: 'gate-red' });
    expect(JSON.parse(result.stdout).detail).toContain('could not fetch origin/release');
    expect(result.calls).toContainEqual({ kind: 'execFile', command: 'git', args: ['fetch', 'origin', 'release', '--quiet'] });
    expect(result.calls.filter(call => call.kind === 'gate')).toEqual([]);
    expect(result.calls.filter(call => call.args?.[0] === 'push')).toEqual([]);
  });
});

describe('R913 push-if-green default gate', () => {
  it('selects related tests against the requested remote branch, never the whole suite', () => {
    const opts = options();
    const gate = gates.resolvePushDefaultGate(opts);
    expect(gate.exitCode).toBe(0);
    expect(gate.command).toContain("npx vitest related 'src/a.ts' --run --passWithNoTests");
    expect(gate.command).not.toMatch(/npm (test|run test:unit)/);
    expect(opts.runGit).toHaveBeenCalledWith(['merge-base', 'upstream/release', 'HEAD']);
  });
  it.each([{ files: ['package.json'] }, { files: [] }])('blocked selection $files fails closed with exit 2 and an operator fallback', ({ files }) => {
    const gate = gates.resolvePushDefaultGate(options(files));
    expect(gate.exitCode).toBe(2);
    expect(gate.command).toBeNull();
    expect(gate.detail).toMatch(/blocked/i);
    expect(gate.detail).toContain('--gate');
  });
  it('an unreadable diff fails closed', () => {
    const gate = gates.resolvePushDefaultGate({ ...options(), runGit: () => { throw new Error('unreadable'); } });
    expect(gate.exitCode).toBe(2);
    expect(gate.command).toBeNull();
  });
  it.each([
    { name: 'card-only skip', result: { decision: { mode: 'card-only-skip' }, command: 'true' } },
    { name: 'no-script echo', result: { decision: { mode: 'shrink' }, command: "echo 'verify-lane: no test:unit/test/check:standards npm script in this checkout — nothing to run'" } },
  ])('never publishes on a no-op gate: $name', ({ result }) => {
    const gate = gates.resolvePushDefaultGate(options(), () => result);
    expect(gate.exitCode).toBe(2);
    expect(gate.command).toBeNull();
  });
  it('a decision without a command fails closed', () => {
    const gate = gates.resolvePushDefaultGate(options(), () => ({ decision: { mode: 'shrink' }, command: '' }));
    expect(gate.exitCode).toBe(2);
    expect(gate.command).toBeNull();
    expect(gate.detail).toContain('--gate');
  });
  it.each([
    { name: 'blocked mode with a runnable command', result: { decision: { mode: 'blocked', reasons: ['unsafe selection'] }, command: 'npx vitest related src/a.ts --run' } },
    { name: 'absent decision with a runnable command', result: { command: 'npx vitest related src/a.ts --run' } },
    { name: 'absent resolver result', result: undefined },
    { name: 'empty command with a valid decision', result: { decision: { mode: 'shrink' }, command: '' } },
    { name: 'whitespace command with a valid decision', result: { decision: { mode: 'shrink' }, command: '   ' } },
  ])('$name refuses publication with exit 2 and no command', ({ result }) => {
    const gate = gates.resolvePushDefaultGate(options(), () => result);
    expect(gate.exitCode).toBe(2);
    expect(gate.command).toBeNull();
    expect(gate.detail).toContain('--gate');
  });
  it('a resolver exception refuses publication with exit 2 and no command', () => {
    const gate = gates.resolvePushDefaultGate(options(), () => { throw new Error('selection evidence unreadable'); });
    expect(gate.exitCode).toBe(2);
    expect(gate.command).toBeNull();
    expect(gate.detail).toContain('selection evidence unreadable');
    expect(gate.detail).toContain('--gate');
  });
  // PR #6769 send-back (judge sweep): the test-half check read the WHOLE command, so a changed path such as
  // docs/shard-run.md inside the standards half's --files= list passed it while no test half existed at all.
  it('standards-only default gate with a path containing shard-run refuses publication', () => {
    for (const file of ['docs/shard-run.md', 'src/shard-run.ts', 'docs/a && vitest b.md', 'docs/a&&npx vitest run b.md']) {
      const composed = gates.composeGate({ vitestCmd: "npx vitest related 'src/a.ts' --run --passWithNoTests",
        checkStandardsCmd: `npm run check:standards -- --local --files=${gates.shellQuote(file)}`, scripts: ['check:standards'] });
      expect(composed.testCommand).toBeNull();
      const gate = gates.resolvePushDefaultGate(options(), () => ({ ...composed, decision: { mode: 'shrink', reasons: [] } }));
      expect(gate.exitCode, file).toBe(2);
      expect(gate.command, file).toBeNull();
    }
  });
  it('a skipped test half (no remaining vitest target) refuses even when a changed path names shard-run or vitest', () => {
    const composed = gates.composeGate({ vitestCmd: "echo 'verify-lane: no remaining changed file for vitest to relate — vitest half skipped'",
      checkStandardsCmd: `npm run check:standards -- --local --files=${gates.shellQuote('scripts/shard-run && vitest x.mjs')}`, scripts: ['test:unit', 'check:standards'] });
    const gate = gates.resolvePushDefaultGate(options(), () => ({ ...composed, decision: { mode: 'shrink', reasons: [] } }));
    expect(gate.exitCode).toBe(2);
    expect(gate.command).toBeNull();
  });
  it('a test half that is not the command\'s own first step refuses', () => {
    const gate = gates.resolvePushDefaultGate(options(), () => ({ decision: { mode: 'shrink' },
      testCommand: 'npx vitest related src/a.ts --run', command: 'npm run check:standards' }));
    expect(gate.exitCode).toBe(2);
    expect(gate.command).toBeNull();
  });
  it('accepts a related or sharded test half as the command\'s own first token', () => {
    const shard = `node ${gates.shellQuote(join(process.cwd(), 'scripts', 'lib', 'verify-shard-run.mjs'))} --shards=2 --parallel=2 --budget-ms=1000 -- npx vitest run 'a.test.mjs' 'b.test.mjs' --passWithNoTests`;
    for (const testCommand of ["npx vitest related 'src/a.ts' --run --passWithNoTests", "npx vitest run 'a.test.mjs' --passWithNoTests", shard]) {
      const composed = gates.composeGate({ vitestCmd: testCommand, checkStandardsCmd: 'npm run check:standards', scripts: ['test', 'check:standards'] });
      const gate = gates.resolvePushDefaultGate(options(), () => ({ ...composed, decision: { mode: 'shrink', reasons: [] } }));
      expect(gate.exitCode, testCommand).toBe(0);
      expect(gate.command).toBe(`${testCommand} && npm run check:standards`);
    }
  });
  it('a valid selection succeeds and preserves the selected command and decision', () => {
    const opts = options();
    const selected = { command: 'npx vitest related src/a.ts --run --passWithNoTests', testCommand: 'npx vitest related src/a.ts --run --passWithNoTests', decision: { mode: 'shrink' } };
    const resolver = vi.fn(() => selected);
    const gate = gates.resolvePushDefaultGate(opts, resolver);
    expect(resolver).toHaveBeenCalledWith(opts);
    expect(gate.exitCode).toBe(0);
    expect(gate.command).toBe(selected.command);
    expect(gate.decision).toBe(selected.decision);
  });
  it('oversized input fails closed with an explicit affected-test fallback', () => {
    const gate = gates.resolvePushDefaultGate(options(Array.from({ length: 301 }, (_, i) => `src/a${i}.ts`)));
    expect(gate.exitCode).toBe(2);
    expect(gate.detail).toContain('--gate');
  });
  it('wires the CLI to the helper after fetch and the nothing-to-push exit, refusing its exit code', () => {
    const src = readFileSync(join(process.cwd(), 'scripts', 'push-if-green.mjs'), 'utf8');
    const resolveAt = src.indexOf('resolvePushDefaultGate({');
    expect(resolveAt).toBeGreaterThan(src.indexOf("['fetch', REMOTE, BRANCH"));
    expect(resolveAt).toBeGreaterThan(src.indexOf("reason: 'up-to-date'"));
    expect(src).toContain('base: `${REMOTE}/${BRANCH}`');
    expect(src).toContain('runGit: git');
    expect(src).toMatch(/if \(resolved.exitCode\)[\s\S]*?emit\([\s\S]*?resolved.exitCode/);
    expect(src).not.toContain("flags.gate : 'npm run test:unit");
  });
});
