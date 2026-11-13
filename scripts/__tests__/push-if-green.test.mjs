import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
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
  it('a decision without a command fails closed', () => {
    const gate = gates.resolvePushDefaultGate(options(), () => ({ decision: { mode: 'shrink' }, command: '' }));
    expect(gate.exitCode).toBe(2);
    expect(gate.detail).toContain('--gate');
  });
  it('oversized input fails closed with an explicit affected-test fallback', () => {
    const gate = gates.resolvePushDefaultGate(options(Array.from({ length: 301 }, (_, i) => `src/a${i}.ts`)));
    expect(gate.exitCode).toBe(2);
    expect(gate.detail).toContain('--gate');
  });
  it('wires the CLI to the helper after fetch and the nothing-to-push exit, refusing its exit code', () => {
    const src = readFileSync(new URL('../push-if-green.mjs', import.meta.url), 'utf8');
    const resolveAt = src.indexOf('resolvePushDefaultGate({');
    expect(resolveAt).toBeGreaterThan(src.indexOf("['fetch', REMOTE, BRANCH"));
    expect(resolveAt).toBeGreaterThan(src.indexOf("reason: 'up-to-date'"));
    expect(src).toContain('base: `${REMOTE}/${BRANCH}`');
    expect(src).toContain('runGit: git');
    expect(src).toMatch(/if \(resolved.exitCode\)[\s\S]*?emit\([\s\S]*?resolved.exitCode/);
    expect(src).not.toContain("flags.gate : 'npm run test:unit");
  });
});
