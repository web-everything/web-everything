import { describe, expect, it, vi } from 'vitest';
import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { registerAgentLaunchTestPrimitive, AGENT_LAUNCH_MODES, AgentLaunchRefusedError, agentResumeId, launchAgent, launchAgentToCompletion } from '../lib/agent-launch.mjs';
import { findAgentLaunches } from './fixtures/agent-launch-source.mjs';


const testPrimitive = (...args) => registerAgentLaunchTestPrimitive(vi.fn(...args));

const SID = '12345678-1234-4234-8234-123456789abc';

// Audit probes use the real boundary with an injected primitive, never an actual agent process.
it.each([
  { name: 'R37.23 unchecked closure with fresh evidence refuses', opaque: 'closure', command: 'claude', argv: ['-p', 'hello'], refused: true, reason: 'unapproved primitive identity' },
  { name: 'R37.23 registered primitive with fresh evidence positive control', command: 'claude', argv: ['-p', 'hello'] },
  ...['exec', 'e'].flatMap(alias => ['array', 'string', 'argv-string', 'shell'].flatMap(form => {
    const invocation = id => form === 'array' ? { command: 'codex', argv: [alias, 'resume', id] }
      : form === 'string' ? { command: `codex ${alias} resume ${id}`, argv: [] }
        : form === 'argv-string' ? { command: 'codex', argvText: `${alias} resume ${id}` }
          : { command: 'sh', argv: ['-c', `codex ${alias} resume ${id}`] };
    return [
      { name: `R37.22 ${alias} ${form} unchecked resume refuses`, ...invocation('unchecked-id'), refused: true },
      { name: `R37.22 ${alias} ${form} matching resume positive control`, ...invocation(SID), resumeId: SID },
    ];
  })),
  ...[';', '&', '|', '&&', '||', '\n'].flatMap(operator => [
    { name: `R37.19 shell string validates first segment before path suffix (${JSON.stringify(operator)})`,
      command: `claude --resume unchecked-id${operator} /bin/claude`, argv: [], refused: true },
    { name: `R37.19 shell -c validates every segment (${JSON.stringify(operator)})`, command: 'sh',
      argv: ['-c', `/bin/claude${operator} claude --resume unchecked-id${operator} /bin/claude`], refused: true },
    { name: `R37.19 matching segmented resume positive control (${JSON.stringify(operator)})`,
      command: `claude --resume ${SID}${operator} /bin/claude --resume ${SID}`, argv: [], resumeId: SID },
    { name: `R37.19 matching shell -c positive control (${JSON.stringify(operator)})`, command: 'sh',
      argv: ['-c', `/bin/claude --resume ${SID}${operator} claude --resume ${SID}`], resumeId: SID },
  ]),
  { name: 'R37.19 whitespace-separated string cannot match whole-string executable suffix',
    command: 'claude --resume unchecked-id /bin/claude', argv: [], refused: true },
  ...['$(printf claude)', '`printf claude`', 'claude --resume "unchecked-id; /bin/claude',
    'claude --resume unchecked-id; unknown-command; /bin/claude',
    '; /bin/claude', '/bin/claude &&', '/bin/claude |', '/bin/claude ||',
    '/bin/claude &&& /bin/claude', '/bin/claude ;; /bin/claude'].flatMap(command => [
    { name: `R37.19 unparseable string refuses with literal argv fallback: ${command}`, command,
      argv: [], refused: true, reason: 'use literal argv' },
    { name: `R37.19 unparseable shell -c refuses with literal argv fallback: ${command}`, command: 'sh',
      argv: ['-c', command], refused: true, reason: 'use literal argv' },
  ]),
  { name: 'R37.19 matching whitespace-separated resume positive control',
    command: `claude --resume ${SID} /bin/claude`, argv: [], resumeId: SID },
  { name: 'R37.19 literal executable path positive control', command: '/bin/claude', argv: ['--resume', SID], resumeId: SID },
  { name: 'R37.19 mismatched segment cannot be hidden by matching descriptor',
    command: `claude --resume unchecked-id; /bin/claude --resume ${SID}`, argv: [], resumeId: SID, refused: true },
  { name: 'R37.19 command string cannot hide additional argv',
    command: 'claude --resume unchecked-id; /bin/claude', argv: ['-p', 'hello'], refused: true },
  { name: 'R37.1 reassigned primitive', source: "let start=console.log; start=spawn; start('claude',[])", refused: true },
  { name: 'R37.1 transitive alias', source: "let start=console.log; const go=start; start=spawn; go('claude',[])", refused: true },
  { name: 'R37.1 ever assigned through var', source: "var start; start=spawn; start=console.log; start('claude',[])", refused: true },
  { name: 'R37.1 computed primitive assignment', source: "let start; start=cp['spawn']; start('claude',[])", refused: true },
  ...['bind(null)', 'call', 'apply'].map(method => ({ name: `R37.1 reassigned ${method}`,
    source: `let start=console.log; start=spawn.${method}; start('claude',[])`, refused: true })),
  { name: 'R37.1 logging an agent name after reassignment is not a launch', source: "let start=console.log; start=console.info; start('claude',[])" },
  { name: 'R37.1 safe reassignment control', source: "let start=console.log; start=console.info; start('git',[])" },
  { name: 'R37.1 logging an agent name with a shadow binding is not a launch', source: "let start=console.log; { let start; start=console.warn; } start('claude',[])" },
  { name: 'R37.1 lexical shadow control', source: "let start=console.log; { let start; start=console.warn; } start('git',[])" },
  { name: 'R37.2 short global option hides exec', argv: ['-p', 'exec', 'exec', 'resume', 'other-id'], refused: true },
  { name: 'R37.2 matching short global option control', argv: ['-p', 'exec', 'exec', 'resume', SID], resumeId: SID },
  { name: 'R37.2 attached short option', argv: ['-pexec', 'exec', 'resume', 'other-id'], refused: true },
  ...['-a', '-c', '-i', '-o', '-m', '-s', '-C'].map(option => ({
    name: `R37.2 ${option} global option value`, argv: [option, 'exec', 'exec', 'resume', 'other-id'], refused: true })),
  { name: 'R37.2 option values are not resume flags', argv: ['-p', '--resume', 'exec', '-c', '--session-id', '-'] },
  { name: 'R37.2 short option consumes delimiter value', argv: ['-p', '--', 'exec', 'resume', 'other-id'], refused: true },
  { name: 'R37.2 long global value hides exec', argv: ['--profile', 'exec', 'exec', 'resume', 'other-id'], refused: true },
  { name: 'R37.3 unresolved shell executable', command: 'sh', argv: ['-c', 'tool=claude; "$tool" --resume other-id'], refused: true },
  { name: 'R37.3 unresolved fresh executable', command: 'sh', argv: ['-c', '"$tool" -p hello'], refused: true },
  { name: 'R37.3 unknown literal executable', command: 'sh', argv: ['-c', 'tool --resume other-id'], refused: true },
  { name: 'R37.3 unresolved direct executable', command: '$tool', argv: ['--resume', 'other-id'], refused: true },
  { name: 'R37.3 expanded resume id', command: 'sh', argv: ['-c', 'claude --resume "$SID"'], resumeId: '$SID', refused: true },
  { name: 'R37.3 expanded subcommand', command: 'sh', argv: ['-c', 'codex "$subcommand" resume other-id'], refused: true },
  { name: 'R37.3 glob-expanded option', command: 'sh', argv: ['-c', 'claude --resu?e other-id'], refused: true },
  { name: 'R37.3 shell line continuation', command: 'sh', argv: ['-c', 'claude --resu\\\nme other-id'], refused: true },
  { name: 'R37.3 implicit shell joins argv ambiguously', command: 'claude', argv: ['-p', 'hello'], shell: true, refused: true },
  { name: 'R37.3 literal nested wrapper control', command: 'env',
    argv: ['sh', '-c', `env bash -c 'claude --resume ${SID}'`], resumeId: SID },
  { name: 'R37.3 oversized wrapper chain uses literal argv fallback', command: 'env',
    argv: [...Array(34).fill('env'), 'claude', '-p', 'hello'], refused: true, reason: 'use literal argv' },
  { name: 'R37.4 captured argv mutation', command: 'claude', argv: ['--resume', SID], resumeId: SID, mutate: true, refused: true },
  { name: 'R37.4 frozen guard view mutation', command: 'claude', argv: ['--resume', SID], resumeId: SID, mutateView: true, refused: true },
  { name: 'R37.4 shell option mutation', command: 'claude', argv: ['--resume', SID], resumeId: SID, mutateShell: true, refused: true },
  { name: 'R37.4 observing guard control', command: 'claude', argv: ['--resume', SID], resumeId: SID, guard: true },
  { name: 'R37.5 descriptor id without invocation evidence', resumeId: SID, noArgs: true, refused: true },
  { name: 'R37.5 descriptor id without native resume flag', resumeId: SID, refused: true },
  ...['claude-resume', 'codex-exec-resume'].flatMap(mode => [
    { name: `R37.5 ${mode} without invocation evidence`, mode, noArgs: true, refused: true },
    { name: `R37.5 ${mode} without native resume flag`, mode, refused: true },
  ]),
  ...['preset', 'renamed', 'receiver', 'proxy'].map(opaque => ({
    name: `R37.5 uninspectable ${opaque} primitive refuses with explicit unbound fallback`,
    opaque, command: 'claude', argv: ['--resume', SID], resumeId: SID, refused: true, reason: 'unbound primitive' })),
  { name: 'R37.5 bound primitive with no call-time arguments', opaque: 'preset', noArgs: true, resumeId: SID, refused: true },
  { name: 'R37.5 bound fresh primitive also refuses', opaque: 'preset', refused: true },
  { name: 'R37.5 explicit unbound matching resume control', command: 'claude', argv: ['--resume', SID], resumeId: SID, mode: 'claude-resume' },
  { name: 'R37.5 explicit unbound fresh control', command: 'claude', argv: ['-p', 'hello'] },
  { name: 'R37.9 fresh descriptor without invocation evidence', noArgs: true, refused: true, reason: 'use literal argv' },
  { name: 'R37.9 fresh closure executing unchecked resume without argv', opaque: 'closure', noArgs: true, refused: true },
  { name: 'R37.9 closure passed as invocation evidence', closureArg: true, refused: true },
  { name: 'R37.9 empty command string', command: '', refused: true },
  { name: 'R37.9 whitespace script has no invocation evidence', command: '  ', argv: [], refused: true },
  { name: 'R37.9 empty nested shell script', command: 'sh', argv: ['-c', ''], refused: true },
  { name: 'R37.9 inspectable fresh command control', command: 'claude', argv: ['-p', 'hello'] },
  { name: 'R37.9 inspectable argv-less command control', command: 'claude', argv: [] },
  ...["clau'de'", 'clau"de"', "'clau'de", 'clau\\de', 'cla*de', 'cla?de', 'cla[up]de',
    'clau{d,d}e', '$tool', '${tool}', '$(printf claude)', '`printf claude`'].map(executable => ({
    name: `R37.12 ambiguous shell executable refuses even with matching id: ${executable}`,
    command: 'sh', argv: ['-c', `${executable} --resume ${SID}`], resumeId: SID, refused: true,
    reason: 'use literal argv',
  })),
  { name: 'R37.12 quoted command string concatenation', command: `clau'de' --resume ${SID}`,
    argv: [], resumeId: SID, refused: true, reason: 'use literal argv' },
  { name: 'R37.12 quoted argv-string concatenation', command: 'codex', argvText: `res'ume' ${SID}`,
    resumeId: SID, mode: 'codex-exec-resume', refused: true, reason: 'use literal argv' },
  { name: 'R37.12 wholly quoted executable and id control', command: 'sh',
    argv: ['-c', `"claude" --resume '${SID}'`], resumeId: SID },
  { name: 'R37.12 shell syntax in literal argv is data control', command: 'claude',
    argv: ['-p', 'literal $tool `text` * ? {a,b} \\'] },
  { name: 'R37.13 top-level resume with fresh descriptor', mode: 'codex-exec',
    argv: ['resume', 'unchecked-id'], refused: true },
  ...['resume', 'fork'].flatMap(subcommand => [
    ...[null, undefined].map(resumeId => ({ name: `R37.13 ${subcommand} missing descriptor id ${resumeId}`,
      mode: 'codex-exec-resume', argv: [subcommand, SID], resumeId, refused: true })),
    { name: `R37.13 ${subcommand} mismatched id`, mode: 'codex-exec-resume',
      argv: ['--profile', 'fixture', subcommand, '--model', 'fixture', 'unchecked-id'], resumeId: SID, refused: true },
    { name: `R37.13 ${subcommand} matching id but wrong mode`, mode: 'codex-exec',
      argv: [subcommand, SID], resumeId: SID, refused: true },
    ...[[], ['--last'], ['--all'], ['--last', '--all'], ['--last', SID]].map(tail => ({
      name: `R37.13 ${subcommand} unverifiable session selection ${tail.join(' ')}`,
      mode: 'codex-exec-resume', argv: [subcommand, ...tail], resumeId: SID, refused: true,
    })),
    ...[[subcommand, SID], ['-p', 'resume', subcommand, '--model', 'fork', SID],
      [subcommand, '--all', SID], [subcommand, '--', SID]].map(argv => ({
      name: `R37.13 matching ${subcommand} control ${argv.join(' ')}`, mode: 'codex-exec-resume', argv, resumeId: SID,
    })),
    { name: `R37.13 ${subcommand} shell control`, command: 'sh', argv: ['-c', `codex ${subcommand} ${SID}`],
      mode: 'codex-exec-resume', resumeId: SID },
    { name: `R37.13 ${subcommand} exec-string control`, command: `codex ${subcommand} ${SID}`, argv: [],
      mode: 'codex-exec-resume', resumeId: SID },
    { name: `R37.13 ${subcommand} argv-string control`, argvText: `--profile fixture ${subcommand} ${SID}`,
      mode: 'codex-exec-resume', resumeId: SID },
  ]),
  { name: 'R37.13 resume word as option value control', argv: ['--profile', 'resume', 'exec', '-'] },
  { name: 'R37.13 resume word as delimited prompt control', argv: ['--', 'resume', SID] },
  { name: 'R37.13 Claude prompt word control', command: 'claude', argv: ['resume', 'unchecked-id'] },
  { name: 'R37.13 exec --last cannot be validated by an accompanying id', mode: 'codex-exec-resume',
    argv: ['exec', 'resume', '--last', SID], resumeId: SID, refused: true },
  ...[['--continue'], ['-c'], ['--continue=true'], ['--fork-session'], ['--fork-session', '--continue'],
    ['--fork-session', '-c'], ['--continue', '--resume', SID]].map(argv => ({
    name: `R37.14 implicit Claude continuation refuses: ${argv.join(' ')}`, command: 'claude',
    mode: 'claude-print', argv, refused: true, reason: 'use --resume with an explicit native session id',
  })),
  { name: 'R37.14 resume mode cannot prove implicit continuation selection', command: 'claude',
    mode: 'claude-resume', resumeId: SID, argv: ['-c'], refused: true },
  { name: 'R37.14 shell continuation refuses', command: 'sh',
    argv: ['-c', 'claude --continue'], mode: 'claude-print', refused: true },
  { name: 'R37.14 explicit native resume positive control', command: 'claude',
    mode: 'claude-resume', resumeId: SID, argv: ['--resume', SID] },
  { name: 'R37.14 continuation flags after delimiter are prompt data control', command: 'claude',
    mode: 'claude-print', argv: ['--', '--continue', '-c', '--fork-session'] },
  { name: 'R37.14 continuation flag as option value control', command: 'claude',
    mode: 'claude-print', argv: ['--system-prompt', '--continue', '--model', '-c'] },
  { name: 'R37.14 Codex -c remains a value option control', argv: ['-c', 'model=fixture', 'exec', '-'] },
])('$name', ({ source, command = 'codex', argv = ['exec', '-'], resumeId = null, mode = 'worker-result-probe',
  refused, mutate, mutateView, mutateShell, shell, guard, reason, opaque, noArgs, closureArg, argvText }) => {
  if (argvText !== undefined) argv = argvText;
  const primitive = testPrimitive(), original = Array.isArray(argv) ? [...argv] : argv, findings = source ? findAgentLaunches({ 'scripts/r37-audit.mjs': source }) : [];
  let invoke = primitive;
  if (opaque === 'preset' || opaque === 'renamed') invoke = primitive.bind(null, 'claude', ['--resume', 'other-id']);
  if (opaque === 'renamed') Object.defineProperty(invoke, 'name', { value: 'start' });
  if (opaque === 'receiver') invoke = Function.prototype.call.bind(primitive, null, 'claude', ['--resume', 'other-id']);
  if (opaque === 'closure') invoke = () => primitive('claude', ['--resume', 'unchecked-id']);
  if (opaque === 'proxy') invoke = new Proxy(primitive, { apply(target) { return target('claude', ['--resume', 'other-id']); } });
  const options = shell || mutateShell ? { shell: shell ?? false } : undefined;
  const execute = () => {
    if (findings.length) throw new Error('structural launch gate refused');
    return launchAgent({ mode, resumeId, log() {},
      ...((mutate || mutateView || mutateShell || guard) ? { launchGuard(view) {
        expect(Object.isFrozen(view)).toBe(true);
        expect(Object.isFrozen(view.argv)).toBe(true);
        if (mutate) argv[1] = 'other-id';
        if (mutateView) view.argv[1] = 'other-id';
        if (mutateShell) options.shell = true;
        return true;
      } } : {}),
    }, invoke, ...(noArgs ? [] : closureArg ? [() => primitive('claude', ['--resume', 'unchecked-id'])] : [command, argv, ...(options ? [options] : [])]));
  };
  if (refused) {
    if (source) expect(findings).toMatchObject([{ kind: 'module', reason: expect.stringContaining('outside approved boundary') }]);
    expect(execute).toThrow(reason ?? /refused/);
    expect(primitive).not.toHaveBeenCalled();
  } else {
    expect(findings).toEqual([]);
    execute();
    expect(primitive).toHaveBeenCalledTimes(1);
    expect(primitive).toHaveBeenCalledWith(command, original);
  }
});

it.each(['exec', 'e'])('R37.22 standalone helper canonicalises %s', alias => {
  expect(agentResumeId([alias, 'resume', SID])).toBe(SID);
  expect(agentResumeId(`${alias} resume ${SID}`)).toBe(SID);
  expect(agentResumeId([alias, '--', 'resume', SID])).toBeNull();
});

describe('launch refusal', () => {
  it.each(['spawn', 'spawnSync', 'exec', 'execFile', 'execSync', 'execFileSync', 'fork'])
  ('R37.23 real %s identity reaches the guard positive control', name => {
    const log = vi.fn();
    expect(() => launchAgent({ mode: 'codex-exec', resumeId: null, log, launchGuard: () => false },
      childProcess[name], 'codex', ['exec', '-'])).toThrow('launchGuard returned false');
  });
  it('R37.23 registration is refused outside Vitest, even with NODE_ENV=test', () => {
    const env = { ...process.env, NODE_ENV: 'test' };
    delete env.VITEST;
    const result = childProcess.spawnSync(process.execPath, ['--input-type=module', '-e',
      "import {registerAgentLaunchTestPrimitive} from './scripts/lib/agent-launch.mjs'; registerAgentLaunchTestPrimitive(()=>{});"],
      { cwd: process.cwd(), env, encoding: 'utf8', timeout: 5000, maxBuffer: 4096 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('registration requires Vitest');
  });

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
    const primitive = testPrimitive();
    try {
      expect(() => launchAgent(descriptor, primitive, 'claude', ['-p', 'hi'])).toThrow(AgentLaunchRefusedError);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining(reason));
      expect(primitive).not.toHaveBeenCalled();
    } finally { stderr.mockRestore(); }
  });
  it('refuses a missing execution primitive with a logged reason', () => {
    const log = testPrimitive();
    expect(() => launchAgent({ mode: 'claude-print', resumeId: null, log }, undefined))
      .toThrow('execution primitive is required');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('execution primitive is required'));
  });
  it.each([undefined, null, false, 0, '', 1, 'guard', {}])('refuses a present non-function guard (%j) with a logged reason', launchGuard => {
    const primitive = testPrimitive(), log = testPrimitive();
    expect(() => launchAgent({ mode: 'claude-print', resumeId: null, launchGuard, log }, primitive, 'claude', []))
      .toThrow('launchGuard must be a function');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('launchGuard must be a function'));
    expect(primitive).not.toHaveBeenCalled();
  });
  it.each([null, 0, '', 1, 'true', {}])('refuses a guard returning evidence other than true or undefined (%j)', result => {
    const primitive = testPrimitive(), log = testPrimitive();
    expect(() => launchAgent({ mode: 'claude-print', resumeId: null, launchGuard: () => result, log }, primitive, 'claude', ['-p', 'hi']))
      .toThrow('launchGuard must return true or undefined');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('launchGuard must return true or undefined'));
    expect(primitive).not.toHaveBeenCalled();
  });
  it.each([true, undefined])('allows a guard returning %j', result => {
    const primitive = testPrimitive();
    launchAgent({ mode: 'claude-print', resumeId: null, launchGuard: () => result }, primitive, 'claude', ['-p', 'hi']);
    expect(primitive).toHaveBeenCalledTimes(1);
  });
  it('logs a native-id mismatch to the supplied sink and never executes', () => {
    const log = testPrimitive(), primitive = testPrimitive();
    expect(() => launchAgent({ mode: 'claude-resume', resumeId: 'report-slug', log }, primitive, 'claude', ['--resume', SID, 'hi']))
      .toThrow('resumeId must equal the native resume id');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('native resume id'));
    expect(primitive).not.toHaveBeenCalled();
  });
  it('calls the guard before executing and preserves its thrown cause', () => {
    const order = [], cause = Error('gate closed'), primitive = testPrimitive();
    expect(launchAgent({ mode: 'claude-print', resumeId: undefined, launchGuard: () => { order.push('guard'); } },
      registerAgentLaunchTestPrimitive((...args) => { order.push('exec'); return args; }), 'claude', ['-p', 'p'])).toEqual(['claude', ['-p', 'p']]);
    expect(order).toEqual(['guard', 'exec']);
    try { launchAgent({ mode: 'claude-print', resumeId: null, launchGuard: () => { throw cause; }, log() {} }, primitive, 'claude', ['-p', 'hi']); }
    catch (e) { expect(e).toMatchObject({ cause, code: 'EAGENTLAUNCHREFUSED' }); }
    expect(primitive).not.toHaveBeenCalled();
  });
  it('falls back to stderr if a log sink throws', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(() => launchAgent({ mode: 'unknown', resumeId: null, log() { throw Error('sink down'); } }, testPrimitive())).toThrow(AgentLaunchRefusedError);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('unknown mode'));
    } finally { stderr.mockRestore(); }
  });
});

describe('transparent execution', () => {
  it.each(AGENT_LAUNCH_MODES.flatMap(mode => ['spawn', 'exec'].map(kind => [mode, kind])))
  ('preserves argv, env, cwd, options, return identity for %s via %s', (mode, kind) => {
    const argv = mode === 'codex-exec-resume' ? ['exec', 'resume', SID, 'literal $() `text`', '\n']
      : mode === 'claude-resume' ? ['--resume', SID, 'literal $() `text`', '\n'] : ['literal $() `text`', '\n'];
    const env = { PATH: 'fixture-bin', TOKEN: 'fixture-token' };
    const options = { cwd: 'fixture-lane', env, stdio: ['ignore', 'pipe', 7], timeout: 12, maxBuffer: 48, detached: true };
    const result = {}, io = { [kind]: testPrimitive(() => result) }, primitive = io[kind];
    expect(launchAgent({ mode, resumeId: mode.endsWith('-resume') ? SID : null }, primitive, mode.startsWith('codex') ? 'codex' : 'claude', argv, options)).toBe(result);
    expect(primitive.mock.calls).toEqual([[mode.startsWith('codex') ? 'codex' : 'claude', argv, options]]);
    expect(primitive.mock.calls[0][1]).toBe(argv);
    expect(primitive.mock.calls[0][2]).toBe(options);
    expect(options.env).toBe(env);
  });
  it('returns no resume id for fresh launches and preserves a single native id unchanged', () => {
    expect(agentResumeId()).toBeNull();
    expect(agentResumeId(['exec', '--json', '-'])).toBeNull();
    const argv = ['exec', 'resume', SID, '--json', '-'], primitive = testPrimitive();
    launchAgent({ mode: 'codex-exec-resume', resumeId: SID }, primitive, 'codex', argv);
    expect(primitive).toHaveBeenCalledTimes(1);
    expect(primitive).toHaveBeenCalledWith('codex', argv);
    expect(primitive.mock.calls[0][1].filter(value => value === SID)).toHaveLength(1);
  });
  it('preserves errors and promises from injected primitives', () => {
    const error = Error('original'), promise = Promise.resolve('original');
    expect(() => launchAgent({ mode: 'claude-print', resumeId: null }, registerAgentLaunchTestPrimitive(() => { throw error; }), 'claude', ['-p', 'hi'])).toThrow(error);
    expect(launchAgent({ mode: 'claude-print', resumeId: null }, registerAgentLaunchTestPrimitive(() => promise), 'claude', ['-p', 'hi'])).toBe(promise);
  });
  it.each([
    ['--bg', '--resume', SID, 'prompt'], ['--restricted', '--resume', SID, 'prompt'],
    ['exec', 'resume', SID, '--json', 'prompt'], ['exec', '--json', '-s', 'workspace-write', 'resume', SID, '-'],
  ])('uses exactly the existing native resume id (%j)', (...argv) => {
    expect(agentResumeId(argv)).toBe(SID);
    const primitive = testPrimitive();
    launchAgent({ mode: 'codex-exec-resume', resumeId: SID }, primitive, 'codex', argv);
    expect(primitive.mock.calls[0][1]).toBe(argv);
  });
});

describe('resume validation across execution forms', () => {
  it.each([
    ['env', ['sh', '-c', `claude --resume ${SID}`]],
    ['nohup', ['env', 'SID=fixture', '/bin/bash', '-lc', `codex exec resume ${SID}`]],
    ['env', ['sh', '-c', `env sh -c 'claude --resume ${SID}'`]],
    [`env sh -c 'claude --resume ${SID}'`],
  ])('validates native resume ids through nested shell wrappers (%j)', (...args) => {
    const primitive = testPrimitive(), log = testPrimitive();
    for (const resumeId of [null, 'other-id']) {
      expect(() => launchAgent({ mode: 'claude-resume', resumeId, log }, primitive, ...args)).toThrow('native resume id');
    }
    expect(primitive).not.toHaveBeenCalled();
    expect(launchAgent({ mode: 'claude-resume', resumeId: SID, log }, primitive, ...args)).toBeUndefined();
    expect(primitive).toHaveBeenCalledTimes(1);
    expect(primitive).toHaveBeenCalledWith(...args);
  });
  it.each([
    ['env', ['sh', '-c', 'claude --resume "unterminated']],
    ['env', ['sh', '-c', 'claude --resume trailing\\']],
    ['env', ['sh', '-c']],
    ['env', ['sh', '-c', null]],
  ])('fails closed on unparseable nested shell scripts and names a literal-argv fallback (%j)', (...args) => {
    const primitive = testPrimitive(), log = testPrimitive();
    expect(() => launchAgent({ mode: 'claude-resume', resumeId: null, log }, primitive, ...args))
      .toThrow('use literal argv and a plain resume id');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('cannot parse native resume id'));
    expect(primitive).not.toHaveBeenCalled();
  });
  it.each(['$SID', '${SID}', '$(printf id)', '`printf id`', '~session', 'id*', 'id?', 'id[12]', 'id{1,2}', 'two words', 'id\n'])
  ('refuses nonliteral native resume ids even when the descriptor matches (%j)', resumeId => {
    for (const args of [['claude', ['--resume', resumeId]], ['sh', ['-c', `claude --resume "${resumeId}"`]],
      ['env', ['sh', '-c', `codex exec resume "${resumeId}"`]]]) {
      const primitive = testPrimitive();
      expect(() => launchAgent({ mode: 'claude-resume', resumeId, log() {} }, primitive, ...args)).toThrow('native resume id');
      expect(primitive).not.toHaveBeenCalled();
    }
  });
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
      const primitive = testPrimitive(), log = testPrimitive();
      expect(() => launchAgent({ mode: 'claude-resume', resumeId, log }, primitive, ...args)).toThrow('native resume id');
      expect(log).toHaveBeenCalledWith(expect.stringContaining('native resume id'));
      expect(primitive).not.toHaveBeenCalled();
    }
  });
  it.each(launches.map(args => [JSON.stringify(args), args]))('forwards a matching resume launch unchanged for %s', (_label, args) => {
    const result = {}, primitive = testPrimitive(() => result);
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
    const primitive = testPrimitive(), log = testPrimitive();
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
    ['claude', ['--print', '--', '--resume']],
    ['claude', ['--bg', '--verbose', '--', '--resume', SID]],
    ['claude', ['-p', '--', '--resume', SID]],
    ['claude', ['-p', '--', '-r', SID]],
    ['claude', ['-p', '--', '--session-id', SID]],
    ['claude', ['-p', '--', `--resume=${SID}`]],
    ['claude', ['-p', '--', `--session-id=${SID}`]],
    ['codex', ['exec', '--', 'resume', SID]],
    ['claude', ['--some-future-option', '--', '--resume', SID]],
    ['claude', '-p -- --resume'],
    ['claude', `-p -- --resume ${SID}`],
    ['claude -p -- --resume'],
    ['sh', ['-c', 'claude -p -- --resume']],
    [`claude -p -- -r ${SID} ; codex exec -- resume ${SID}`],
  ];
  it.each(afterDelimiter.map(args => [JSON.stringify(args), args]))('treats text after -- as prompt, not a resume flag, for %s', (_label, args) => {
    const result = {}, primitive = testPrimitive(() => result);
    expect(launchAgent({ mode: 'claude-print', resumeId: null }, primitive, ...args)).toBe(result);
    expect(primitive).toHaveBeenCalledTimes(1);
  });
  // A `--` that is not the launched claude/codex's own end-of-options marker must not hide a real resume.
  it.each([
    ['npx', ['--yes', '--', 'claude', '--resume', 'other-id']],
    ['env', ['--', 'claude', '-r', 'other-id']],
    ['claude', ['--append-system-prompt', '--', '--resume', 'other-id']],
    ['claude', ['--model', '--', '-r', 'other-id']],
    ['claude', ['--mcp-config', '--', '--resume', 'other-id']],
    ['codex', ['--profile', '--', 'exec', 'resume', 'other-id']],
    ['claude', ['--permission-mode', '--', '--resume', 'other-id']],
    ['npx -- claude --resume other-id'],
  ])('still refuses a real resume hidden behind a non-delimiter -- (%j)', (...args) => {
    const primitive = testPrimitive(), log = testPrimitive();
    expect(() => launchAgent({ mode: 'claude-print', resumeId: null, log }, primitive, ...args)).toThrow('native resume id');
    expect(primitive).not.toHaveBeenCalled();
  });
  it('a wrapper -- before the binary does not count, but the binary\'s own -- still does', () => {
    const primitive = testPrimitive();
    launchAgent({ mode: 'claude-print', resumeId: null }, primitive, 'npx', ['--yes', '--', 'claude', '-p', '--', '--resume']);
    expect(primitive).toHaveBeenCalledTimes(1);
  });
  it('agentResumeId ignores resume-looking words after the delimiter but keeps ones before it', () => {
    expect(agentResumeId(['-p', '--', '--resume'])).toBeNull();
    expect(agentResumeId('-p -- --resume')).toBeNull();
    expect(agentResumeId(['--resume', SID, '--', '--resume', 'other'])).toBe(SID);
    expect(agentResumeId(['--', '--resume', SID])).toBeNull();
  });
  it('still checks resume flags that precede the delimiter, and a resume flag whose value would be the delimiter', () => {
    const primitive = testPrimitive(), log = testPrimitive();
    expect(() => launchAgent({ mode: 'claude-resume', resumeId: SID, log }, primitive, 'claude', ['--resume', SID, '--', '-r', 'other'])).not.toThrow();
    expect(() => launchAgent({ mode: 'claude-resume', resumeId: SID, log }, primitive, 'claude', ['-r', 'other', '--', '--resume', SID])).toThrow('native resume id');
    expect(() => launchAgent({ mode: 'claude-resume', resumeId: null, log }, primitive, 'claude', ['--resume', '--', 'prompt'])).toThrow('native resume id');
  });
  it.each([['--resume'], ['-r'], ['--session-id'], ['--session-id='], ['--profile', 'fixture', 'exec', 'resume']])
  ('refuses missing native resume ids before execution (%j)', (...argv) => {
    const primitive = testPrimitive(), log = testPrimitive();
    expect(() => launchAgent({ mode: 'claude-resume', resumeId: null, log }, primitive, 'claude', argv)).toThrow('native resume id');
    expect(primitive).not.toHaveBeenCalled();
  });
});

describe('completion wrapper', () => {
  it('records argv, env and cwd through injected spawn and collects both output streams', async () => {
    const argv = ['--resume', SID, '-p', 'literal $() `text`'];
    const env = { PATH: 'fixture-bin' }, child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = testPrimitive();
    const spawnFn = testPrimitive(() => {
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
    const spawnFn = testPrimitive(), log = testPrimitive();
    await expect(launchAgentToCompletion({ mode: 'claude-dispatch-to-completion', resumeId: null,
      launchGuard: () => false, log }, 'claude', ['-p', 'hello'], {}, { spawnFn }))
      .rejects.toThrow('launchGuard returned false');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('launchGuard returned false'));
    expect(spawnFn).not.toHaveBeenCalled();
  });
  it('preserves an injected spawn failure', async () => {
    const error = Error('spawn failed');
    await expect(launchAgentToCompletion({ mode: 'codex-exec', resumeId: null }, 'codex', ['exec', '-'], {},
      { spawnFn: registerAgentLaunchTestPrimitive(() => { throw error; }) })).rejects.toBe(error);
  });
});

// Codex `exec resume [OPTIONS] [SESSION_ID] [PROMPT]`: the id is the first POSITIONAL after `resume`.
describe('codex resume id is the positional session id, never an option', () => {
  it.each(['resume', 'fork'])('extracts top-level %s ids through the same normaliser', subcommand => {
    const argv = ['-p', 'fixture', subcommand, '--model', 'fixture', SID];
    expect(agentResumeId(argv)).toBe(SID);
    expect(agentResumeId(argv.join(' '))).toBe(SID);
    expect(agentResumeId(`codex ${argv.join(' ')}`)).toBe(SID);
    expect(agentResumeId([subcommand, '--all', SID])).toBe(SID);
    expect(agentResumeId([subcommand, '--', SID])).toBe(SID);
    for (const tail of [[], ['--all'], ['--last'], ['--last', SID]]) {
      expect(agentResumeId([subcommand, ...tail])).toBe('');
    }
  });
  const ignoreRulesShapes = [
    ['exec', '--ignore-rules', 'resume', SID],
    ['exec', 'resume', '--ignore-rules', SID],
  ];
  it.each(ignoreRulesShapes.map(argv => [JSON.stringify(argv), argv]))('refuses a mismatched id with boolean --ignore-rules in %s', (_label, argv) => {
    const primitive = testPrimitive(), log = testPrimitive();
    expect(() => launchAgent({ mode: 'codex-exec-resume', resumeId: 'other-id', log }, primitive, 'codex', argv))
      .toThrow('native resume id');
    expect(primitive).not.toHaveBeenCalled();
  });
  it.each(ignoreRulesShapes.map(argv => [JSON.stringify(argv), argv]))('launches a matching id with boolean --ignore-rules in %s', (_label, argv) => {
    const result = {}, primitive = testPrimitive(() => result);
    expect(launchAgent({ mode: 'codex-exec-resume', resumeId: SID }, primitive, 'codex', argv)).toBe(result);
    expect(primitive).toHaveBeenCalledTimes(1);
    expect(primitive).toHaveBeenCalledWith('codex', argv);
  });
  it.each([
    [], ['exec'], ['exec', '--model', 'resume', SID], ['exec', '--', 'resume', SID],
    ['exec', 'resume', '--model'], ['exec', 'resume', '--ignore-rules'],
  ])('refuses unparseable codex-exec-resume argv (%j) before executing', (...argv) => {
    const primitive = testPrimitive(), log = testPrimitive();
    expect(() => launchAgent({ mode: 'codex-exec-resume', resumeId: SID, log }, primitive, 'codex', argv))
      .toThrow('native resume id');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('native resume id'));
    expect(primitive).not.toHaveBeenCalled();
  });
  const shapes = [
    ['exec', 'resume', '--json', SID, '-'],
    ['exec', 'resume', '--json', '--skip-git-repo-check', SID, 'prompt'],
    ['exec', 'resume', '-m', 'some-model', SID, '-'],
    ['exec', 'resume', '--model', 'some-model', '-c', 'k=v', SID],
    ['exec', 'resume', '--profile=fixture', SID],
    ['exec', '--profile', 'resume', 'resume', SID],
  ];
  it.each(shapes.map(argv => [JSON.stringify(argv), argv]))('extracts the id from %s', (_label, argv) => {
    expect(agentResumeId(argv)).toBe(SID);
    const primitive = testPrimitive();
    launchAgent({ mode: 'codex-exec-resume', resumeId: SID }, primitive, 'codex', argv);
    expect(primitive).toHaveBeenCalledTimes(1);
  });
  it.each([['--json'], ['-'], ['report-slug'], [null]])('refuses resumeId %j that is not the positional id', resumeId => {
    const primitive = testPrimitive();
    expect(() => launchAgent({ mode: 'codex-exec-resume', resumeId, log() {} }, primitive, 'codex',
      ['exec', 'resume', '--json', SID, '-'])).toThrow('native resume id');
    expect(primitive).not.toHaveBeenCalled();
  });
  it('reads an option-only resume (no positional) as an empty id, which is refused', () => {
    expect(agentResumeId(['exec', 'resume', '--last'])).toBe('');
    const primitive = testPrimitive();
    expect(() => launchAgent({ mode: 'codex-exec-resume', resumeId: null, log() {} }, primitive, 'codex',
      ['exec', 'resume', '--last'])).toThrow('native resume id');
    expect(primitive).not.toHaveBeenCalled();
  });
  it('applies the same extraction to string and shell -c forms', () => {
    expect(agentResumeId(`codex exec resume --json ${SID} -`)).toBe(SID);
    expect(agentResumeId(`exec resume --json '${SID}' -`)).toBe(SID);
    const primitive = testPrimitive();
    launchAgent({ mode: 'codex-exec-resume', resumeId: SID }, primitive, 'sh', ['-c', `codex exec resume --json ${SID} -`]);
    expect(primitive).toHaveBeenCalledTimes(1);
    expect(() => launchAgent({ mode: 'codex-exec-resume', resumeId: '--json', log() {} }, testPrimitive(), 'sh',
      ['-c', `codex exec resume --json ${SID} -`])).toThrow('native resume id');
  });
});

// A resume flag with no value reads as an empty native id. An empty descriptor resumeId must not "match" it.
describe('an empty descriptor resumeId never satisfies a missing native id', () => {
  const missing = [
    ['claude', ['--resume']], ['claude', ['-r']], ['claude', ['--session-id']], ['claude', ['--session-id=']],
    ['claude', ['--resume=']], ['claude', ['-r=']], ['claude', ['--resume', '--', 'prompt']],
    ['claude', ['--resume', '']], ['claude', ['--resume', ' ']], ['claude', ['--resume=  ']],
    ['codex', ['exec', 'resume']], ['codex', ['exec', 'resume', '--last']], ['codex', ['exec', 'resume', '--json']],
    ['claude', '--resume'], ['claude', 'claude -r ""'],
    ['sh', ['-c', 'claude --resume']], ['sh', ['-c', 'codex exec resume --last']], ['bash', ['-lc', 'claude --session-id=']],
    ['sh -c "claude --resume"', []],
  ];
  it.each(missing.map(c => [JSON.stringify(c), c]))('refuses %s with resumeId empty, null, undefined or whitespace', (_label, [command, argv]) => {
    for (const resumeId of ['', ' ', null, undefined]) {
      const primitive = testPrimitive(), log = testPrimitive();
      expect(() => launchAgent({ mode: 'claude-resume', resumeId, log }, primitive, command, argv)).toThrow('native resume id');
      expect(primitive).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('native resume id'));
    }
  });
  it('refuses a fresh launch with a supplied empty id; accepts a real resume id or an absent fresh id', () => {
    const primitive = testPrimitive();
    expect(() => launchAgent({ mode: 'claude-print', resumeId: '', log() {} }, primitive, 'claude', ['-p', 'hello']))
      .toThrow('native resume id');
    expect(primitive).not.toHaveBeenCalled();
    launchAgent({ mode: 'claude-resume', resumeId: SID }, primitive, 'claude', ['--resume', SID]);
    launchAgent({ mode: 'claude-print', resumeId: null }, primitive, 'claude', ['-p', 'hello']);
    expect(primitive).toHaveBeenCalledTimes(2);
  });
});

describe('an async launchGuard is refused without leaking its rejection', () => {
  it('consumes a rejected guard promise so the caller can handle the refusal', async () => {
    const unhandled = testPrimitive();
    process.on('unhandledRejection', unhandled);
    try {
      const primitive = testPrimitive(), log = testPrimitive();
      expect(() => launchAgent({ mode: 'claude-print', resumeId: null, log,
        launchGuard: async () => { throw new Error('admission unavailable'); } }, primitive, 'claude', ['-p', 'hi']))
        .toThrow('launchGuard must be synchronous');
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
      expect(primitive).not.toHaveBeenCalled();
    } finally { process.off('unhandledRejection', unhandled); }
  });
  it('refuses a thenable whose then throws or whose then getter throws', () => {
    const primitive = testPrimitive();
    const throwing = { then() { throw new Error('boom'); } };
    expect(() => launchAgent({ mode: 'claude-print', resumeId: null, log() {}, launchGuard: () => throwing }, primitive, 'claude', ['-p', 'hi']))
      .toThrow('launchGuard must be synchronous');
    const getter = { get then() { throw new Error('getter boom'); } };
    expect(() => launchAgent({ mode: 'claude-print', resumeId: null, log() {}, launchGuard: () => getter }, primitive, 'claude', ['-p', 'hi']))
      .toThrow('launchGuard must be synchronous');
    expect(primitive).not.toHaveBeenCalled();
  });
});
