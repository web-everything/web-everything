/**
 * The execution boundary for Claude/Codex sessions and management commands (R1003).
 * Normalise command evidence once; only validated argv may reach the injected primitive.
 * Inject the existing primitive so synchronous returns, promises and child handles stay intact.
 */
import { spawn } from 'node:child_process';
import { spawnToCompletion } from './spawn-to-completion.mjs';

/** Closed inventory of existing behaviours. Adding a launch requires choosing a mode explicitly. */
export const AGENT_LAUNCH_MODES = Object.freeze([
  'claude-dispatch-bg', 'claude-dispatch-to-completion', 'claude-wrapper-run',
  'claude-review', 'claude-print', 'claude-agents-list', 'claude-stop', 'claude-rm',
  'claude-auth-status', 'claude-resume', 'claude-judge', 'claude-scheduled-sweep',
  'claude-operator', 'claude-explore', 'claude-maintenance', 'claude-converge',
  'codex-exec', 'codex-exec-resume', 'codex-self-review', 'codex-delivery', 'codex-judge',
  'agent-version', 'judge-measurement', 'worker-result-probe', 'review-recheck',
]);
const modes = new Set(AGENT_LAUNCH_MODES);

export class AgentLaunchRefusedError extends TypeError {
  constructor(reason, { mode, cause } = {}) {
    super(`agent-launch refused: ${reason}`, cause === undefined ? undefined : { cause });
    this.name = 'AgentLaunchRefusedError';
    this.code = 'EAGENTLAUNCHREFUSED';
    this.mode = mode;
    this.reason = reason;
  }
}

function refuse(reason, descriptor, log, cause) {
  const error = new AgentLaunchRefusedError(reason, { mode: descriptor?.mode, cause });
  // A broken optional sink must never suppress the refusal or its diagnostic.
  try { log(`${error.message}\n`); } catch { process.stderr.write(`${error.message}\n`); }
  throw error;
}

/** The native id already present in argv, never a reporting slug or a newly minted id. */
export function agentResumeId(argv = []) {
  // This helper also accepts argv without a binary: `exec` identifies the Codex grammar there.
  const commands = typeof argv === 'string' ? normaliseScript(argv, 0, true)
    : [normaliseOptions(argv, argv.includes('exec') ? 'codex' : 'claude')];
  return commands.flatMap(command => command.resumeIds)[0] ?? null;
}

// A `--` right after an option that consumes the next word is that option's VALUE, not the delimiter.
// Only explicitly known value options consume the next word. Every other long option is a boolean
// (including Codex's --ignore-rules), so it cannot swallow the `resume` subcommand or session id.
const VALUE_OPTIONS = new Set([
  '--model', '--permission-mode', '--append-system-prompt', '--system-prompt', '--mcp-config',
  '--resume', '--session-id', '--output-format', '--input-format', '--json-schema', '--max-turns',
  '--max-budget-usd', '--tools', '--allowedTools', '--disallowedTools', '--agent', '--agents',
  '--settings', '--setting-sources', '--fallback-model', '--effort', '--add-dir',
  '--config', '--profile', '--sandbox', '--ask-for-approval', '--cd', '--image',
  '--output-schema', '--output-last-message', '--color', '--enable', '--disable',
]);
const SHORT_VALUE_OPTIONS = new Set(['-n', '-m', '-s', '-C']);
const CODEX_SHORT_VALUE_OPTIONS = new Set(['-a', '-c', '-i', '-p', '-o']);
const RESUME_OPTIONS = new Set(['--resume', '--session-id', '-r']);
const isOption = word => word.length > 1 && word.startsWith('-');
const agentExecutable = /(?:^|[/\\])(claude|codex)$/;
const shellExecutable = /(?:^|[/\\])(?:ba|z|da|k)?sh$/;
const separator = Symbol('shell command separator');
const MAX_WRAPPERS = 32;

/** A canonical option stream: values never become options, delimiters, or subcommands. */
function normaliseOptions(argv, executable) {
  if (!Array.isArray(argv) || argv.some(word => typeof word !== 'string')) throw new SyntaxError('nonliteral argv');
  const entries = [], resumeIds = [];
  let ended = false;
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i];
    if (ended) { entries.push({ kind: 'prompt', word }); continue; }
    if (word === '--') { ended = true; entries.push({ kind: 'delimiter', word }); continue; }
    const inlineResume = /^(?:--resume=|--session-id=|-r=?)([\s\S]*)/.exec(word);
    if (RESUME_OPTIONS.has(word)) {
      const value = argv[i + 1] === '--' ? '' : (argv[++i] ?? '');
      entries.push({ kind: 'resume', word, value }); resumeIds.push(value);
    } else if (inlineResume) {
      entries.push({ kind: 'resume', word, value: inlineResume[1] }); resumeIds.push(inlineResume[1]);
    } else if (isOption(word)) {
      const option = word.split('=', 1)[0];
      const takesValue = VALUE_OPTIONS.has(option) || SHORT_VALUE_OPTIONS.has(option)
        || (executable === 'codex' && CODEX_SHORT_VALUE_OPTIONS.has(option));
      // Codex accepts attached short values, e.g. -pexec and -cmodel=x.
      const attached = executable === 'codex' && word.length > 2
        && (SHORT_VALUE_OPTIONS.has(word.slice(0, 2)) || CODEX_SHORT_VALUE_OPTIONS.has(word.slice(0, 2)));
      if (takesValue && !word.includes('=') && !attached) {
        if (i + 1 === argv.length) throw new SyntaxError('missing option value');
        entries.push({ kind: 'option', word, value: argv[++i] });
      } else entries.push({ kind: 'option', word });
    } else entries.push({ kind: 'positional', word });
  }
  const positionals = entries.filter(entry => entry.kind === 'positional');
  // Only the first two positional words can be exec/resume. Global option VALUES cannot hide them.
  if (positionals[0]?.word === 'exec' && positionals[1]?.word === 'resume') {
    resumeIds.push(positionals[2]?.word ?? '');
  }
  return { executable, entries, resumeIds };
}

// Parse quoting only. Unsupported shell grammar refuses with the literal-argv fallback; never evaluate it.
function shellWords(text) {
  const words = []; let word = '', quote = '', started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote !== "'" && /[$`]/.test(c)) throw new SyntaxError('unresolved shell expansion');
    if (!quote && /[~*?\[\]{}]/.test(c)) throw new SyntaxError('unresolved shell expansion');
    if (c === '\\' && quote !== "'") {
      if (i + 1 === text.length) throw new SyntaxError('incomplete shell escape');
      if (text[i + 1] === '\n') { i++; continue; }
      // In double quotes only these characters are escaped by the shell.
      if (quote === '"' && !/[\\$`"\n]/.test(text[i + 1])) word += c;
      else { word += text[++i]; started = true; }
    } else if (quote) { if (c === quote) quote = ''; else word += c; }
    else if (c === "'" || c === '"') { quote = c; started = true; }
    else if (/[()<>]/.test(c)) throw new SyntaxError('unsupported shell grammar');
    else if (/\s|[;|&]/.test(c)) {
      if (started) words.push(word);
      word = ''; started = false;
      if (/[;|&\n]/.test(c)) words.push(separator);
    } else { word += c; started = true; }
  }
  if (quote) throw new SyntaxError('unterminated shell quote');
  if (started) words.push(word);
  return words;
}

function normaliseScript(text, depth, optionsOnly = false) {
  if (typeof text !== 'string') throw new SyntaxError('missing shell -c script');
  const commands = [], words = shellWords(text);
  let start = 0;
  for (let i = 0; i <= words.length; i++) {
    if (i !== words.length && words[i] !== separator) continue;
    const segment = words.slice(start, i); start = i + 1;
    if (!segment.length) continue;
    if (optionsOnly && (isOption(segment[0]) || segment[0] === 'exec')) {
      commands.push(normaliseOptions(segment, segment.includes('exec') ? 'codex' : 'claude'));
    }
    else commands.push(...normaliseCommand(segment, depth, true));
  }
  return commands;
}

function normaliseCommand(words, depth = 0, shell = false) {
  if (depth > MAX_WRAPPERS) throw new SyntaxError('too many wrappers; use direct literal argv');
  if (words.some(word => typeof word !== 'string')) throw new SyntaxError('nonliteral command');
  if (shell) while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? '')) words = words.slice(1);
  if (!words.length) return [];
  const [command, ...argv] = words;
  if (!command || /[$`~*?\[\]{}()<>\n\r]/.test(command)) throw new SyntaxError('unresolved executable word');
  const executable = agentExecutable.exec(command)?.[1];
  if (executable) return [normaliseOptions(argv, executable)];
  if (shellExecutable.test(command)) {
    let i = 0;
    for (; i < argv.length; i++) {
      if (/^-[eilnruvxf]*c[eilnruvxf]*$/.test(argv[i])) return normaliseScript(argv[i + 1], depth + 1);
      if (!/^-[eilnruvxf]+$/.test(argv[i]) && !['--login', '--noprofile', '--norc'].includes(argv[i])) break;
    }
    throw new SyntaxError('shell without a literal -c script');
  }
  const wrapper = command.split(/[/\\]/).at(-1);
  let i = 0;
  if (wrapper === 'env') {
    while (i < argv.length) {
      const word = argv[i];
      if (word === '--') { i++; break; }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || ['-i', '--ignore-environment'].includes(word)) { i++; continue; }
      if (['-u', '--unset', '-C', '--chdir'].includes(word)) {
        if (i + 1 === argv.length) throw new SyntaxError('missing env option value');
        i += 2; continue;
      }
      if (/^--(?:unset|chdir)=/.test(word)) { i++; continue; }
      if (word.startsWith('-')) throw new SyntaxError('unsupported env option');
      break;
    }
  } else if (['nohup', 'command', 'exec', 'npx'].includes(wrapper)) {
    while (['--', '--yes', '-y', '--no-install'].includes(argv[i])) i++;
  } else throw new SyntaxError('unknown executable; use a literal claude/codex path');
  if (i === argv.length) throw new SyntaxError('missing wrapped executable');
  return normaliseCommand(argv.slice(i), depth + 1, shell);
}

/** One entry point for array argv, command strings, and nested literal shell/env wrappers. */
function normaliseInvocation(args) {
  if (!args.length) return []; // Primitive-only injection is supported by existing callers/tests.
  const [command, argv] = args;
  // A shell joining array argv destroys word boundaries. Require an explicit, literal -c script instead.
  if (Array.isArray(argv) && args[2]?.shell) throw new SyntaxError('shell execution of array argv is ambiguous');
  if (typeof command !== 'string') throw new SyntaxError('nonliteral executable');
  if (!agentExecutable.test(command) && /\s|[;|&'" ($`]/.test(command)) {
    if (Array.isArray(argv) && argv.length) throw new SyntaxError('ambiguous command string and argv');
    return normaliseScript(command, 0);
  }
  if (typeof argv === 'string') {
    const words = shellWords(argv);
    if (words.includes(separator)) throw new SyntaxError('ambiguous argv script');
    return normaliseCommand([command, ...words]);
  }
  return normaliseCommand([command, ...(Array.isArray(argv) ? argv : [])]);
}

// A throwing `then` getter must read as thenable (fail closed), not escape as an unrelated error.
function isThenable(value) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
  try { return typeof value.then === 'function'; } catch { return true; }
}

/**
 * Execute exactly one primitive with its original arguments and return value.
 * `resumeId` is an explicit key even for management commands/fresh launches (null/undefined).
 * The guard is synchronous: a promise is refused rather than accidentally launching before it resolves.
 */
export function launchAgent(descriptor, primitive, ...args) {
  const log = typeof descriptor?.log === 'function' ? descriptor.log : (s) => process.stderr.write(s);
  if (!descriptor || typeof descriptor !== 'object') refuse('descriptor is required', descriptor, log);
  if (!descriptor.mode) refuse('mode is required', descriptor, log);
  if (!modes.has(descriptor.mode)) refuse(`unknown mode ${String(descriptor.mode)}`, descriptor, log);
  if (!Object.hasOwn(descriptor, 'resumeId')) refuse('resumeId key is required', descriptor, log);
  let normalised;
  try { normalised = normaliseInvocation(args); }
  catch (cause) {
    refuse('cannot parse native resume id; use literal argv and a plain resume id', descriptor, log, cause);
  }
  const nativeIds = normalised.flatMap(command => command.resumeIds);
  // Snapshot the validated words before the guard can mutate a captured argv reference.
  const validatedArgv = Array.isArray(args[1]) ? [...args[1]] : args[1];
  const validatedShell = args[2]?.shell;
  // A resume flag with no value reads as an empty native id: that is a MISSING id, never one an empty/blank
  // descriptor resumeId can "equal". Require plain literal ids: never shell expansions or metacharacters.
  if ((descriptor.mode === 'codex-exec-resume' && nativeIds.length === 0)
    || nativeIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]*(?![\s\S])/.test(id) || descriptor.resumeId !== id)) {
    refuse('resumeId must equal the native resume id in argv', descriptor, log);
  }
  if ('launchGuard' in descriptor) {
    if (typeof descriptor.launchGuard !== 'function') refuse('launchGuard must be a function', descriptor, log);
    let allowed;
    try { allowed = descriptor.launchGuard(Object.freeze({
      command: args[0], argv: Array.isArray(validatedArgv) ? Object.freeze([...validatedArgv]) : validatedArgv,
    })); } catch (cause) {
      refuse(`launchGuard threw: ${String(cause?.message ?? cause)}`, descriptor, log, cause);
    }
    if (allowed === false) refuse('launchGuard returned false', descriptor, log);
    if (isThenable(allowed)) {
      // The refusal is the caller's to handle; the abandoned guard promise's own rejection must not crash Node.
      try { allowed.then(undefined, () => {}); } catch { /* a throwing then() is still refused below */ }
      refuse('launchGuard must be synchronous', descriptor, log);
    }
    if (allowed !== true && allowed !== undefined) refuse('launchGuard must return true or undefined', descriptor, log);
  }
  if (args[2]?.shell !== validatedShell || (Array.isArray(validatedArgv) && (args[1].length !== validatedArgv.length
    || validatedArgv.some((word, i) => word !== args[1][i])))) {
    refuse('launchGuard changed validated argv; use literal argv and a plain resume id', descriptor, log);
  }
  if (typeof primitive !== 'function') refuse('execution primitive is required', descriptor, log);
  // Guarded calls forward the validated snapshot, even if the guard retained the caller's array.
  const forwarded = [...args];
  if ('launchGuard' in descriptor && Array.isArray(validatedArgv)) forwarded[1] = validatedArgv;
  return primitive(...forwarded);
}

/** Preserve spawnToCompletion's options/result and the injected spawnFn seam at the OS boundary. */
export function launchAgentToCompletion(descriptor, command, argv, options, io = {}) {
  return spawnToCompletion(command, argv, options, {
    ...io, spawnFn: (...args) => launchAgent(descriptor, io.spawnFn ?? spawn, ...args),
  });
}
