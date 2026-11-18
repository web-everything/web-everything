import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { AGENT_LAUNCH_MODES, AgentLaunchRefusedError, agentResumeId, launchAgent, launchAgentToCompletion } from '../lib/agent-launch.mjs';

const SID = '12345678-1234-4234-8234-123456789abc';

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
  it('refuses a missing execution primitive with a logged reason', () => {
    const log = vi.fn();
    expect(() => launchAgent({ mode: 'claude-print', resumeId: null, log }, undefined))
      .toThrow('execution primitive is required');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('execution primitive is required'));
  });
  it.each([undefined, null, false, 0, '', 1, 'guard', {}])('refuses a present non-function guard (%j) with a logged reason', launchGuard => {
    const primitive = vi.fn(), log = vi.fn();
    expect(() => launchAgent({ mode: 'claude-print', resumeId: null, launchGuard, log }, primitive, 'claude', []))
      .toThrow('launchGuard must be a function');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('launchGuard must be a function'));
    expect(primitive).not.toHaveBeenCalled();
  });
  it.each([null, 0, '', 1, 'true', {}])('refuses a guard returning evidence other than true or undefined (%j)', result => {
    const primitive = vi.fn(), log = vi.fn();
    expect(() => launchAgent({ mode: 'claude-print', resumeId: null, launchGuard: () => result, log }, primitive))
      .toThrow('launchGuard must return true or undefined');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('launchGuard must return true or undefined'));
    expect(primitive).not.toHaveBeenCalled();
  });
  it.each([true, undefined])('allows a guard returning %j', result => {
    const primitive = vi.fn();
    launchAgent({ mode: 'claude-print', resumeId: null, launchGuard: () => result }, primitive);
    expect(primitive).toHaveBeenCalledTimes(1);
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
    expect(launchAgent({ mode: 'claude-print', resumeId: undefined, launchGuard: () => { order.push('guard'); } },
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
  it.each(AGENT_LAUNCH_MODES.flatMap(mode => ['spawn', 'exec'].map(kind => [mode, kind])))
  ('preserves argv, env, cwd, options, return identity for %s via %s', (mode, kind) => {
    const argv = ['literal $() `text`', '\n'], env = { PATH: 'fixture-bin', TOKEN: 'fixture-token' };
    const options = { cwd: 'fixture-lane', env, stdio: ['ignore', 'pipe', 7], timeout: 12, maxBuffer: 48, detached: true };
    const result = {}, io = { [kind]: vi.fn(() => result) }, primitive = io[kind];
    expect(launchAgent({ mode, resumeId: null }, primitive, mode.startsWith('codex') ? 'codex' : 'claude', argv, options)).toBe(result);
    expect(primitive.mock.calls).toEqual([[mode.startsWith('codex') ? 'codex' : 'claude', argv, options]]);
    expect(primitive.mock.calls[0][1]).toBe(argv);
    expect(primitive.mock.calls[0][2]).toBe(options);
    expect(options.env).toBe(env);
  });
  it('returns no resume id for fresh launches and preserves a single native id unchanged', () => {
    expect(agentResumeId()).toBeNull();
    expect(agentResumeId(['exec', '--json', '-'])).toBeNull();
    const argv = ['exec', 'resume', SID, '--json', '-'], primitive = vi.fn();
    launchAgent({ mode: 'codex-exec-resume', resumeId: SID }, primitive, 'codex', argv);
    expect(primitive).toHaveBeenCalledTimes(1);
    expect(primitive).toHaveBeenCalledWith('codex', argv);
    expect(primitive.mock.calls[0][1].filter(value => value === SID)).toHaveLength(1);
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

describe('resume validation across execution forms', () => {
  const launches = [
    ['claude', ['-r', SID]],
    ['codex', ['--sandbox', 'workspace-write', 'exec', 'resume', SID]],
    ['codex', ['--profile=fixture', 'exec', '--json', '-s', 'workspace-write', 'resume', SID]],
    ['codex', `--sandbox workspace-write exec --json resume '${SID}'`],
    [`codex --profile fixture exec resume ${SID}`],
    ['sh', ['-c', `codex --profile fixture exec --json resume ${SID}`]],
    ['claude', ['--verbose', '--session-id', SID, '-p', 'hello']],
    ['claude', ['-p', 'hello', `--session-id=${SID}`]],
    ['claude', ['-p', 'hello', '--resume', SID]],
    ['claude', ['-p', 'hello', '-r', SID]],
    [`claude --verbose --session-id '${SID}' -p hello`],
    ['claude', `--resume ${SID}`],
    ['claude', `-r '${SID}'`],
    ['codex', `exec resume "${SID}"`],
    [`claude --resume ${SID}`],
    [`codex exec resume ${SID}`],
    [`/tools/claude -r '${SID}'`],
    [`claude --resume=${SID}`],
    [`claude -r${SID}`],
    [`env FOO=bar claude -r ${SID} && codex exec resume ${SID}`],
    ['sh', ['-c', `claude --resume ${SID}`]],
    ['/bin/bash', ['-lc', `codex exec resume '${SID}'`]],
    [`sh -c 'claude --resume ${SID}'`],
    ['sh', `-c 'claude -r ${SID}'`],
  ];
  it.each(launches.map(args => [JSON.stringify(args), args]))('refuses mismatched or absent resume evidence for %s', (_label, args) => {
    for (const resumeId of [null, undefined, 'report-slug']) {
      const primitive = vi.fn(), log = vi.fn();
      expect(() => launchAgent({ mode: 'claude-resume', resumeId, log }, primitive, ...args)).toThrow('native resume id');
      expect(log).toHaveBeenCalledWith(expect.stringContaining('native resume id'));
      expect(primitive).not.toHaveBeenCalled();
    }
  });
  it.each(launches.map(args => [JSON.stringify(args), args]))('forwards a matching resume launch unchanged for %s', (_label, args) => {
    const result = {}, primitive = vi.fn(() => result);
    expect(launchAgent({ mode: 'claude-resume', resumeId: SID }, primitive, ...args)).toBe(result);
    expect(primitive).toHaveBeenCalledWith(...args);
    if (args.length > 1) expect(primitive.mock.calls[0][1]).toBe(args[1]);
  });
  it.each([
    ['claude', ['--resume', SID, '-r', 'other-id']],
    ['claude', ['--resume', SID, '--session-id', 'other-id']],
    ['codex', ['--profile', 'fixture', 'exec', 'resume', 'other-id']],
    [`claude --resume ${SID}; codex exec resume other-id`],
    ['sh', ['-c', `claude -r ${SID} | codex exec resume other-id`]],
  ])('checks every resume id rather than just the first (%j)', (...args) => {
    const primitive = vi.fn(), log = vi.fn();
    expect(() => launchAgent({ mode: 'claude-resume', resumeId: SID, log }, primitive, ...args)).toThrow('native resume id');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('native resume id'));
    expect(primitive).not.toHaveBeenCalled();
  });
  it('extracts short and string resume forms without inventing ids for fresh launches', () => {
    expect(agentResumeId(['-r', SID])).toBe(SID);
    expect(agentResumeId(`exec resume '${SID}'`)).toBe(SID);
    expect(agentResumeId('--print hello')).toBeNull();
  });
  // Everything after the `--` end-of-options delimiter is prompt text, never a resume flag.
  const afterDelimiter = [
    ['claude', ['-p', '--', '--resume']],
    ['claude', ['-p', '--', '--resume', SID]],
    ['claude', ['-p', '--', '-r', SID]],
    ['claude', ['-p', '--', '--session-id', SID]],
    ['claude', ['-p', '--', `--resume=${SID}`]],
    ['claude', ['-p', '--', `--session-id=${SID}`]],
    ['codex', ['exec', '--', 'resume', SID]],
    ['claude', '-p -- --resume'],
    ['claude', `-p -- --resume ${SID}`],
    ['claude -p -- --resume'],
    ['sh', ['-c', 'claude -p -- --resume']],
    [`claude -p -- -r ${SID} ; codex exec -- resume ${SID}`],
  ];
  it.each(afterDelimiter.map(args => [JSON.stringify(args), args]))('treats text after -- as prompt, not a resume flag, for %s', (_label, args) => {
    const result = {}, primitive = vi.fn(() => result);
    expect(launchAgent({ mode: 'claude-print', resumeId: null }, primitive, ...args)).toBe(result);
    expect(primitive).toHaveBeenCalledTimes(1);
  });
  it('agentResumeId ignores resume-looking words after the delimiter but keeps ones before it', () => {
    expect(agentResumeId(['-p', '--', '--resume'])).toBeNull();
    expect(agentResumeId('-p -- --resume')).toBeNull();
    expect(agentResumeId(['--resume', SID, '--', '--resume', 'other'])).toBe(SID);
    expect(agentResumeId(['--', '--resume', SID])).toBeNull();
  });
  it('still checks resume flags that precede the delimiter, and a resume flag whose value would be the delimiter', () => {
    const primitive = vi.fn(), log = vi.fn();
    expect(() => launchAgent({ mode: 'claude-resume', resumeId: SID, log }, primitive, 'claude', ['--resume', SID, '--', '-r', 'other'])).not.toThrow();
    expect(() => launchAgent({ mode: 'claude-resume', resumeId: SID, log }, primitive, 'claude', ['-r', 'other', '--', '--resume', SID])).toThrow('native resume id');
    expect(() => launchAgent({ mode: 'claude-resume', resumeId: null, log }, primitive, 'claude', ['--resume', '--', 'prompt'])).toThrow('native resume id');
  });
  it.each([['--resume'], ['-r'], ['--session-id'], ['--session-id='], ['--profile', 'fixture', 'exec', 'resume']])
  ('refuses missing native resume ids before execution (%j)', (...argv) => {
    const primitive = vi.fn(), log = vi.fn();
    expect(() => launchAgent({ mode: 'claude-resume', resumeId: null, log }, primitive, 'claude', argv)).toThrow('native resume id');
    expect(primitive).not.toHaveBeenCalled();
  });
});

describe('completion wrapper', () => {
  it('records argv, env and cwd through injected spawn and collects both output streams', async () => {
    const argv = ['--resume', SID, '-p', 'literal $() `text`'];
    const env = { PATH: 'fixture-bin' }, child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = vi.fn();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('answer'));
        child.stderr.emit('data', Buffer.from('diagnostic'));
        child.emit('close', 0, null);
      });
      return child;
    });
    await expect(launchAgentToCompletion({ mode: 'claude-dispatch-to-completion', resumeId: SID }, 'claude', argv,
      { cwd: 'fixture-lane', env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 1000, maxBuffer: 1024 }, { spawnFn }))
      .resolves.toEqual({ stdout: 'answer', stderr: 'diagnostic', resourceUsage: null });
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(spawnFn).toHaveBeenCalledWith('claude', argv,
      { cwd: 'fixture-lane', env, stdio: ['ignore', 'pipe', 'pipe'] });
    expect(spawnFn.mock.calls[0][1]).toBe(argv);
    expect(spawnFn.mock.calls[0][2].env).toBe(env);
    expect(child.kill).not.toHaveBeenCalled();
  });
  it('refuses a denied guard with its logged reason before injected spawn', async () => {
    const spawnFn = vi.fn(), log = vi.fn();
    await expect(launchAgentToCompletion({ mode: 'claude-dispatch-to-completion', resumeId: null,
      launchGuard: () => false, log }, 'claude', ['-p', 'hello'], {}, { spawnFn }))
      .rejects.toThrow('launchGuard returned false');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('launchGuard returned false'));
    expect(spawnFn).not.toHaveBeenCalled();
  });
  it('preserves an injected spawn failure', async () => {
    const error = Error('spawn failed');
    await expect(launchAgentToCompletion({ mode: 'codex-exec', resumeId: null }, 'codex', ['exec', '-'], {},
      { spawnFn: () => { throw error; } })).rejects.toBe(error);
  });
});
