import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { AGENT_LAUNCH_MODES, AgentLaunchRefusedError, agentResumeId, launchAgent, launchAgentToCompletion } from '../lib/agent-launch.mjs';
import { spawnToCompletion } from '../lib/spawn-to-completion.mjs';

const SID = '12345678-1234-4234-8234-123456789abc';
const root = resolve(import.meta.dirname, '../..');
const oldCalls = JSON.parse(readFileSync(resolve(root, 'scripts/__tests__/fixtures/agent-launch/pre-refactor-calls.json'), 'utf8'));

function boundaryCalls(file, text) {
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const program = ts.createProgram([file], { allowJs: true, noResolve: true, noLib: true }, {
    ...ts.createCompilerHost({}), getSourceFile: name => resolve(name) === resolve(file) ? ast : undefined,
  });
  const checker = program.getTypeChecker();
  const calls = [];
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && checker.getSymbolAtLocation(node.expression)?.declarations?.some(declaration =>
        ts.isImportSpecifier(declaration)
        && ['launchAgent', 'launchAgentToCompletion'].includes((declaration.propertyName ?? declaration.name).text)
        && declaration.parent.parent.parent.moduleSpecifier.text.endsWith('/agent-launch.mjs'))) {
      calls.push(node.getText(ast));
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return calls;
}

describe('launch refusal', () => {
  it.each([
    [undefined, 'descriptor is required'], [null, 'descriptor is required'],
    [{ resumeId: null }, 'mode is required'], [{ mode: 'invented', resumeId: null }, 'unknown mode'],
    [{ mode: 'claude-print' }, 'resumeId key is required'],
    [{ mode: 'claude-print', resumeId: null, launchGuard: false }, 'launchGuard must be a function'],
    [{ mode: 'claude-print', resumeId: null, launchGuard: () => false }, 'launchGuard returned false'],
    [{ mode: 'claude-print', resumeId: null, launchGuard: () => { throw Error('held by admission'); } }, 'held by admission'],
    [{ mode: 'claude-print', resumeId: null, launchGuard: () => Promise.resolve(true) }, 'must be synchronous'],
  ])('refuses incomplete/unknown evidence and guard failures (%j)', (descriptor, reason) => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const primitive = vi.fn();
    try {
      expect(() => launchAgent(descriptor, primitive, 'claude', ['-p', 'hi'])).toThrow(AgentLaunchRefusedError);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining(reason));
      expect(primitive).not.toHaveBeenCalled();
    } finally { stderr.mockRestore(); }
  });
  it('logs a native-id mismatch to the supplied sink and never executes', () => {
    const log = vi.fn(), primitive = vi.fn();
    expect(() => launchAgent({ mode: 'claude-resume', resumeId: 'report-slug', log }, primitive, 'claude', ['--resume', SID, 'hi']))
      .toThrow('resumeId must equal the native resume id');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('native resume id'));
    expect(primitive).not.toHaveBeenCalled();
  });
  it('calls the guard before executing and preserves its thrown cause', () => {
    const order = [], cause = Error('gate closed'), primitive = vi.fn();
    expect(launchAgent({ mode: 'claude-print', resumeId: undefined, launchGuard: () => order.push('guard') },
      (...args) => { order.push('exec'); return args; }, 'claude', ['-p', 'p'])).toEqual(['claude', ['-p', 'p']]);
    expect(order).toEqual(['guard', 'exec']);
    try { launchAgent({ mode: 'claude-print', resumeId: null, launchGuard: () => { throw cause; }, log() {} }, primitive); }
    catch (e) { expect(e).toMatchObject({ cause, code: 'EAGENTLAUNCHREFUSED' }); }
    expect(primitive).not.toHaveBeenCalled();
  });
  it('falls back to stderr if a log sink throws', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(() => launchAgent({ mode: 'unknown', resumeId: null, log() { throw Error('sink down'); } }, vi.fn())).toThrow(AgentLaunchRefusedError);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('unknown mode'));
    } finally { stderr.mockRestore(); }
  });
});

describe('transparent execution', () => {
  it.each(AGENT_LAUNCH_MODES)('preserves argv, env, cwd, options, return identity for %s', mode => {
    const argv = ['literal $() `text`', '\n'], env = { PATH: 'fixture-bin', TOKEN: 'fixture-token' };
    const options = { cwd: 'fixture-lane', env, stdio: ['ignore', 'pipe', 7], timeout: 12, maxBuffer: 48, detached: true };
    const result = {}, primitive = vi.fn(() => result);
    expect(launchAgent({ mode, resumeId: null }, primitive, mode.startsWith('codex') ? 'codex' : 'claude', argv, options)).toBe(result);
    expect(primitive.mock.calls).toEqual([[mode.startsWith('codex') ? 'codex' : 'claude', argv, options]]);
    expect(primitive.mock.calls[0][1]).toBe(argv);
    expect(primitive.mock.calls[0][2]).toBe(options);
    expect(options.env).toBe(env);
  });
  it('preserves errors and promises from injected primitives', () => {
    const error = Error('original'), promise = Promise.resolve('original');
    expect(() => launchAgent({ mode: 'claude-print', resumeId: null }, () => { throw error; })).toThrow(error);
    expect(launchAgent({ mode: 'claude-print', resumeId: null }, () => promise)).toBe(promise);
  });
  it.each([
    ['--bg', '--resume', SID, 'prompt'], ['--restricted', '--resume', SID, 'prompt'],
    ['exec', 'resume', SID, '--json', 'prompt'], ['exec', '--json', '-s', 'workspace-write', 'resume', SID, '-'],
  ])('uses exactly the existing native resume id (%j)', (...argv) => {
    expect(agentResumeId(argv)).toBe(SID);
    const primitive = vi.fn();
    launchAgent({ mode: 'codex-exec-resume', resumeId: SID }, primitive, 'codex', argv);
    expect(primitive.mock.calls[0][1]).toBe(argv);
  });
});

// These are the actual pre-refactor launch expressions, pinned before editing, evaluated with hermetic IO.
// Comparing to each CURRENT call catches changed spreads, argv order, env, cwd, stdio, timeouts and extra IO args.
describe('pre-refactor call-site parity', () => {
  const current = new Map();
  for (const file of new Set(oldCalls.map(c => c.file))) {
    const text = readFileSync(resolve(root, file), 'utf8');
    current.set(file, boundaryCalls(file, text));
  }
  it('resolves imported launcher aliases without counting a shadowing local function', () => {
    expect(boundaryCalls('fixture.mjs', `
      import { launchAgent as launch } from './lib/agent-launch.mjs';
      function local() { const launch = request => request; launch(request); }
      launch(descriptor, exec, 'claude', argv);
    `)).toEqual(["launch(descriptor, exec, 'claude', argv)"]);
  });
  it('accounts for every imported boundary call in the fixture files', () => {
    for (const [file, calls] of current) {
      expect(calls, file).toHaveLength(oldCalls.filter(c => c.file === file).length);
    }
  });
  const indices = new Map();
  const cases = oldCalls.map(c => { const index = indices.get(c.file) ?? 0; indices.set(c.file, index + 1); return { ...c, expression: current.get(c.file)[index] }; });
  it.each(cases)('$file:$line ($mode) preserves the original primitive invocation', async c => {
    const calls = [], returned = { original: true };
    const record = (...args) => { calls.push(args); return returned; };
    const spawnRecorder = (...args) => {
      calls.push(args);
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
      queueMicrotask(() => { child.stdout.emit('data', Buffer.from('output')); child.emit('close', 0, null); });
      return child;
    };
    const env = { PATH: 'fixture-bin', HOME: 'fixture-home' };
    const argv = ['--bg', '--resume', SID, 'prompt'];
    const context = {
      launchAgent, launchAgentToCompletion, agentResumeId, spawnToCompletion,
      exec: record, execFileSync: record, spawn: record, spawnFn: record, spawnSync: record,
      run: record, runFn: record, listing: record, spawnAgent: record, spawnToCompletionFn: record,
      argv, args: ['--model', 'sonnet', 'probe'], execOpts: { env, cwd: 'fixture-lane', encoding: 'utf8', timeout: 60000 },
      opts: { env, cwd: 'fixture-lane', timeout: 12345 }, options: { env }, io: { spawnFn: spawnRecorder },
      process: { env }, env, all: true, childEnv: env, cli: c.file.includes('codex') ? 'codex' : 'claude',
      cmd: 'claude', command: 'claude', CODEX_CLI: 'codex', CLI_BIN: { codex: 'codex' }, provider: 'codex',
      spec: { command: 'claude', launcher: 'claude-p', cwd: 'fixture-lane', env },
      spawnWithPid: record, clock: () => 100, deadlineMs: 1100, spawnCwd: 'fixture-lane',
      dir: 'fixture-lane', cwd: 'fixture-lane', lane: 'fixture-lane', lanePath: 'fixture-lane', sessionCwd: 'fixture-lane',
      quiet: { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      home: 'fixture-home', homedir: () => 'fixture-home', cwdPath: 'fixture-lane',
      review: false, resumeThreadId: SID, tempRoot: 'fixture-temp', id: SID, tid: SID, sid: SID,
      prompt: 'prompt', disallowedTools: ['Write'], logFd: 7, alias: 'sonnet', timeoutMs: 120000,
      SPAWN_TIMEOUT_MS: 60000, LIST_TIMEOUT_MS: 30000, STOP_EXEC_OPTS: { timeout: 30000 },
      REPO_ROOT: 'fixture-repo', MIN: 60000, briefPath: 'fixture-brief',
      readFileSync: () => 'brief', markWorkerEnv: e => ({ ...e, WORKER: '1' }), sanitizeSpawnEnv: e => ({ ...e, SANITIZED: '1' }),
      codexShimPath: () => 'fixture-shim:fixture-bin', listTimeoutMs: () => 30000,
      policy: { prompt: 'maintain', model: 'sonnet', timeoutSeconds: 45 }, dispatchKind: 'converge',
      PROMPT: 'probe', PROMPT2: 'probe again', base: ['-p', '--budget', '1'], common: ['--json'],
      out1: 'out1', out2: 'out2', out3: 'out3', bad: 'schema.json',
    };
    const before = await runInNewContext(c.old, context); const expected = calls.splice(0);
    expect(c.expression, 'current launch missing from inventory').toBeTypeOf('string');
    const after = await runInNewContext(c.expression, context);
    expect(calls).toEqual(expected);
    expect(after).toEqual(before);
  });
});
