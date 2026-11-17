// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import * as remote from '../remote-exec.mjs';
import { allowedCommand } from '../forge-exec-run.mjs';
import { isolatedRetryArgv } from '../../lib/gate-timeout-retry.mjs';
import { baseRerunArgv } from '../../lib/verify-base-rerun.mjs';
import { shardRunArgv } from '../../lib/verify-shard-run.mjs';
import { resolveDefaultGate, scaledTimeoutFlags } from '../../lib/verify-lane-gate.mjs';

const files = ['scripts/example.test.mjs', 'scripts/other.test.mjs'];
const timeouts = scaledTimeoutFlags(3).trim().split(' ');

function mainGateArgv() {
  const gate = resolveDefaultGate({ fileConfig: null,
    env: { WE_VERIFY_SELECTION: 'pr', WE_VERIFY_RELATED: 'import-only', WE_VERIFY_TEST_TIMEOUT_FACTOR: '3' },
    runGit(args) {
      if (args[0] === 'merge-base') return 'deadbeef';
      if (args[0] === 'diff') return args.includes('--diff-filter=D') ? '' : files.join('\n');
      if (args[0] === 'ls-files') return '';
      throw Error(`unexpected git invocation: ${args.join(' ')}`);
    },
  });
  // Tokenize the real gate command; sample paths contain no quotes or spaces.
  expect(gate.testCommand).toMatch(/^npx vitest related /);
  return gate.testCommand.match(/'[^']*'|\S+/g).map(word => word.replace(/^'|'$/g, ''));
}

describe('client argv compatibility with the unchanged Forge allowlist', () => {
  it.each([
    ['verify-lane main gate', mainGateArgv],
    ['verify-shard-run after heavy-admission run --', () => shardRunArgv(files.map(f => `./${f}`), timeouts)],
  ])('accepts the real %s argv after normalization', (_name, build) => {
    const argv = build(), original = [...argv];
    const normalized = remote.normalizeRemoteArgv(argv);
    expect(allowedCommand(normalized)).toBe(true);
    expect(argv).toEqual(original);
    expect(normalized).toContain(files[0]);
    if (argv.some(arg => arg.startsWith('--testTimeout='))) {
      expect(normalized).toEqual(expect.arrayContaining(timeouts));
    }
  });

  it.each(['--maxWorkers=1', '--minWorkers=1', '--no-file-parallelism'])('preserves local-only worker control %s', flag => {
    const argv = ['npx', 'vitest', 'run', files[0], flag];
    expect(allowedCommand(argv)).toBe(false);
    expect(remote.normalizeRemoteArgv(argv)).toEqual(argv);
  });

  it.each([
    ['npx', 'vitest', 'run', './scripts/example.test.mjs', '--bail'],
    ['rm', './scripts/example.test.mjs'],
    ['npx', 'vitest', 'run', './../scripts/example.test.mjs'],
    ['npx', 'vitest', 'run', files[0], '--maxWorkers', '1'],
  ])('still refuses disallowed argv %j', (...argv) => {
    expect(allowedCommand(remote.normalizeRemoteArgv(argv))).toBe(false);
  });

  it('leaves npm and other command classes untouched', () => {
    const argv = ['npm', 'run', 'test:unit', '--', `./${files[0]}`, '--maxWorkers=1'];
    expect(remote.normalizeRemoteArgv(argv)).toEqual(argv);
    expect(allowedCommand(remote.normalizeRemoteArgv(argv))).toBe(false);
  });

  it.each(['run', 'related'].flatMap(mode =>
    ['./--passWithNoTests', './--coverage', './-h', './--testTimeout=100'].map(file => [mode, file])
  ))('preserves option-looking positional %s argument %s and refuses remote dispatch', async (mode, file) => {
    const argv = ['npx', 'vitest', mode, files[0], file];
    const exec = vi.fn(), stage = vi.fn();
    expect(remote.normalizeRemoteArgv(argv)).toEqual(argv);
    expect(allowedCommand(remote.normalizeRemoteArgv(argv))).toBe(false);
    expect(await remote.runRemote({ argv, exec, fs: { mkdtemp: stage } }))
      .toMatchObject({ reason: 'command-not-allowed' });
    expect(exec).not.toHaveBeenCalled();
    expect(stage).not.toHaveBeenCalled();
  });

  it('preserves option values rather than treating them as file arguments', () => {
    const argv = ['npx', 'vitest', 'run', `./${files[0]}`, '-t', './name', '--config', './vitest.soak.config.ts'];
    expect(remote.normalizeRemoteArgv(argv)).toEqual([
      'npx', 'vitest', 'run', files[0], '-t', './name', '--config', './vitest.soak.config.ts',
    ]);
    expect(allowedCommand(remote.normalizeRemoteArgv(argv))).toBe(false);
  });

  it.each([
    ['verify-lane isolated retry', () => isolatedRetryArgv(files, timeouts)],
    ['verify-base-rerun', () => baseRerunArgv(files)],
  ])('%s is local-only by design', async (_name, build) => {
    const argv = build(), exec = vi.fn(), stage = vi.fn();
    expect(remote.normalizeRemoteArgv(argv)).toEqual(argv.map(arg => arg.startsWith('./') ? arg.slice(2) : arg));
    expect(argv).toEqual(expect.arrayContaining(['--maxWorkers=1', '--minWorkers=1', '--no-file-parallelism']));
    expect(allowedCommand(remote.normalizeRemoteArgv(argv))).toBe(false);
    expect(await remote.runRemote({ argv, exec, fs: { mkdtemp: stage } }))
      .toMatchObject({ reason: 'command-not-allowed' });
    expect(exec).not.toHaveBeenCalled();
    expect(stage).not.toHaveBeenCalled();
  });
});

describe('equivalent test spellings route to Forge; everything else stays refused', () => {
  const ok = argv => allowedCommand(remote.normalizeRemoteArgv(argv));
  it('accepts bare vitest run/related', () => {
    expect(ok(['vitest', 'run', 'scripts/a.test.mjs'])).toBe(true);
    expect(ok(['vitest', 'related', '--run', 'scripts/a.mjs'])).toBe(true);
  });
  it('accepts node scripts/check-standards.mjs with only allowed flags', () => {
    expect(ok(['node', 'scripts/check-standards.mjs', '--local', '--files=a.mjs'])).toBe(true);
  });
  it('still refuses non-test commands', () => {
    for (const argv of [['claude', '-p', 'x'], ['codex', 'exec', 'x'], ['gh', 'pr', 'list'],
      ['node', '-e', 'x'], ['node', 'scripts/check-standards.mjs', '--scope=x'],
      ['node', 'scripts/check-standards.mjs', '--help'], ['node', 'scripts/other.mjs', '--local'],
      ['vitest', 'run', 'a.test.mjs', '--config', 'evil.ts']]) expect(ok(argv)).toBe(false);
  });
});
