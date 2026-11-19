/**
 * The execution boundary for Claude/Codex sessions and management commands (R1003).
 * Normalise command evidence once; only validated argv may reach the injected primitive.
 * Inject the existing primitive so synchronous returns, promises and child handles stay intact.
 */
import { spawn, spawnSync, exec, execFile, execSync, execFileSync } from 'node:child_process';
import { snapshotInput } from './plain-data-snapshot.mjs';
import { spawnToCompletion } from './spawn-to-completion.mjs';
import { isAgentLaunchTestPrimitive } from './agent-launch.test-seam.mjs';

// Identity, never name/source text: closures, bound functions and proxies can discard argv.
const approvedPrimitives = new Set([spawn, spawnSync, exec, execFile, execSync, execFileSync]);

// Share one policy across Node options, env wrappers and shell assignment words.
const executionEnvironment = /^(?:NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|LD_.*|DYLD_.*|BASH_ENV|ENV|PATH|SHELLOPTS|BASHOPTS|PS4|PROMPT_COMMAND|IFS|CDPATH|GLOBIGNORE|BASH_FUNC_.*|HOME|ZDOTDIR|XDG_CONFIG_HOME|XDG_CONFIG_DIRS|GIT_CONFIG.*|GIT_EXEC_PATH|GIT_SSH_COMMAND)$/i;
const environmentName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const startupLocation = /^(?:HOME|ZDOTDIR|XDG_CONFIG_HOME|XDG_CONFIG_DIRS)$/i;
function rejectExecutionEnvironment(key, value) {
  if (executionEnvironment.test(key)
    && !(startupLocation.test(key) && (value === process.env[key] || String(value) === process.env[key]))) {
    throw new SyntaxError('execution redirection environment is unsupported; remove loader, lookup and shell startup overrides');
  }
}

function validateAssignment(word) {
  const equals = word.indexOf('=');
  if (equals < 0) throw new SyntaxError('unsupported environment assignment; use literal argv');
  const key = word.slice(0, equals);
  rejectExecutionEnvironment(key, word.slice(equals + 1));
  if (!environmentName.test(key)) throw new SyntaxError('unsupported environment name; use literal argv');
}

// No caller needs Node's fork: its JavaScript module/execArgv grammar is not agent argv.
// Keep execution-redirection options closed for every remaining primitive, too.
function snapshotInvocation(args, primitive) {
  const forwarded = [...args];
  const stringCommand = primitive === exec || primitive === execSync;
  let hasOptions = false;
  // Node supports options in either position, including spawn(file, undefined, options).
  for (let index = 1; index < args.length; index++) {
    const options = args[index];
    if (!options || typeof options !== 'object') continue;
    if (Array.isArray(options)) {
      if (index === 1 && !stringCommand) continue;
      throw new SyntaxError('execution options must be an object, never an argv array; use literal argv with spawn or execFile');
    }
    hasOptions = true;
    const snapshot = { ...options };
    if ('execPath' in options || 'execArgv' in options || (snapshot.shell !== undefined && snapshot.shell !== false)) {
      throw new SyntaxError('execution redirection options are unsupported; omit execPath, execArgv and shell');
    }
    if (snapshot.env != null) {
      if (typeof snapshot.env !== 'object' || Array.isArray(snapshot.env)) {
        throw new SyntaxError('environment must be plain data; use literal environment values');
      }
      for (const key of Reflect.ownKeys(snapshot.env)) {
        if (typeof key !== 'string') throw new SyntaxError('environment names must be strings');
        if (!['string', 'number', 'boolean', 'undefined'].includes(typeof snapshot.env[key]) && snapshot.env[key] !== null) {
          throw new SyntaxError('environment values must be literal data');
        }
        rejectExecutionEnvironment(key, snapshot.env[key]);
      }
    } else {
      snapshot.env = inheritedEnvironment();
    }
    forwarded[index] = Object.freeze(snapshot);
  }
  if (!hasOptions && args.length) {
    const index = stringCommand || !(Array.isArray(args[1]) || typeof args[1] === 'string') ? 1 : 2;
    // Preserve callbacks and Node's omitted-argv overload while supplying explicit options.
    if (typeof forwarded[index] === 'function') forwarded.splice(index, 0, Object.freeze({ env: inheritedEnvironment() }));
    else forwarded[index] = Object.freeze({ env: inheritedEnvironment() });
  }
  return Object.freeze(forwarded);
}

function inheritedEnvironment() {
  const env = { ...process.env };
  // Keep the parent's real home and executable lookup path; refuse explicit redirection.
  for (const key of Object.keys(env)) if (!['PATH', 'HOME'].includes(key.toUpperCase()) && executionEnvironment.test(key)) delete env[key];
  return Object.freeze(env);
}

// Codex CLI help aliases: exec (e), review, resume, fork. Canonicalise before grammar checks.
const CODEX_SUBCOMMANDS = new Map([
  ['exec', 'exec'], ['e', 'exec'], ['review', 'review'], ['resume', 'resume'], ['fork', 'fork'],
]);
const codexSubcommand = word => CODEX_SUBCOMMANDS.get(word);

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
  argv = snapshotInput(argv);
  // This helper also accepts argv without a binary: Codex's subcommands identify its grammar.
  const commands = typeof argv === 'string' ? normaliseScript(argv, 0, true)
    : [normaliseOptions(argv, argv.some(word => CODEX_SUBCOMMANDS.has(word)) ? 'codex' : 'claude')];
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
const shellExecutable = /(?:^|[/\\])(?:(?:ba|z|da|k)?sh|fish)$/;
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
    // These select an implicit session, which a descriptor id cannot prove. Keep continuation
    // closed until a mode explicitly supports it; callers can use --resume with a literal id.
    if (executable === 'claude' && /^(?:--continue(?:=|$)|-c(?:=|$)|--fork-session(?:=|$))/.test(word)) {
      throw new SyntaxError('implicit continuation is unsupported; use --resume with an explicit native session id');
    }
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
  // Global option VALUES cannot hide a subcommand. Interactive resume/fork have no `exec` prefix.
  const interactiveResume = executable === 'codex' && ['resume', 'fork'].includes(codexSubcommand(positionals[0]?.word));
  const execResume = executable === 'codex' && codexSubcommand(positionals[0]?.word) === 'exec'
    && codexSubcommand(positionals[1]?.word) === 'resume';
  if (interactiveResume || execResume) {
    const subcommand = positionals[interactiveResume ? 0 : 1];
    const tail = entries.slice(entries.indexOf(subcommand) + 1);
    // --last selects a session independently of any supplied id. A picker/--all without an id
    // is equally unverifiable. After the subcommand, `--` can introduce a literal session id.
    const selectedByLast = entries.some(entry => entry.kind === 'option' && /^--last(?:=|$)/.test(entry.word));
    resumeIds.push(selectedByLast ? '' : tail.find(entry => ['positional', 'prompt'].includes(entry.kind))?.word ?? '');
  }
  return { executable, entries, resumeIds, interactiveResume };
}

/** Shared conservative shell evidence for the runtime normaliser and structural gate. Never evaluate it. */
export function agentShellEvidence(text) {
  const unquoted = text.replace(/['"`\\]/g, '');
  let quote = '', started = false, closedQuote = false;
  let ambiguous = /[$`\\~*?\[\]{}]/.test(text);
  for (const c of text) {
    if (quote) {
      if (c === quote) { quote = ''; closedQuote = true; }
    } else if (/\s|[;|&]/.test(c)) {
      started = false; closedQuote = false;
    } else if (c === "'" || c === '"') {
      if (started) ambiguous = true;
      quote = c; started = true;
    } else {
      if (closedQuote) ambiguous = true;
      started = true;
    }
  }
  return { unquoted, ambiguous: ambiguous || Boolean(quote) };
}

// Parse quoting only. Unsupported shell grammar refuses with the literal-argv fallback; never evaluate it.
function shellWords(text) {
  if (agentShellEvidence(text).ambiguous) throw new SyntaxError('unresolved shell quoting, escape or expansion; use literal argv');
  const words = []; let word = '', quote = '', started = false, needsCommand = false;
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
      if (/[;|&\n]/.test(c)) {
        // Keep operator pairs together and reject incomplete/empty command segments.
        let operator = c;
        if (/[|&]/.test(c) && text[i + 1] === c) operator += text[++i];
        if (!words.length || words.at(-1) === separator) {
          if (c === '\n') continue;
          throw new SyntaxError('missing shell command; use literal argv');
        }
        words.push(separator);
        needsCommand = ['|', '&&', '||'].includes(operator);
      }
    } else { word += c; started = true; }
  }
  if (quote) throw new SyntaxError('unterminated shell quote');
  if (started) words.push(word);
  if (needsCommand && words.at(-1) === separator) throw new SyntaxError('incomplete shell command; use literal argv');
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
    if (optionsOnly && (isOption(segment[0]) || CODEX_SUBCOMMANDS.has(segment[0]))) {
      commands.push(normaliseOptions(segment, segment.some(word => CODEX_SUBCOMMANDS.has(word)) ? 'codex' : 'claude'));
    }
    else commands.push(...normaliseCommand(segment, depth, true));
  }
  return commands;
}

function normaliseCommand(words, depth = 0, shell = false) {
  if (depth > MAX_WRAPPERS) throw new SyntaxError('too many wrappers; use direct literal argv');
  if (words.some(word => typeof word !== 'string')) throw new SyntaxError('nonliteral command');
  if (shell) while (/^[^=]+=/.test(words[0] ?? '')) {
    validateAssignment(words[0]);
    words = words.slice(1);
  }
  if (!words.length) return [];
  const [command, ...argv] = words;
  if (!command || /[\s;|&'"$`~*?\[\]{}()<>]/.test(command)) throw new SyntaxError('unresolved executable word');
  const executable = agentExecutable.exec(command)?.[1];
  if (executable) return [normaliseOptions(argv, executable)];
  if (shell && ['export', 'declare'].includes(command)) {
    let i = 0;
    if (command === 'declare') {
      if (argv[i++] !== '-x') throw new SyntaxError('unsupported shell declaration; use literal argv');
    }
    if (argv[i] === '--') i++;
    if (i === argv.length) throw new SyntaxError('missing shell assignments; use literal argv');
    for (; i < argv.length; i++) validateAssignment(argv[i]);
    return [];
  }
  if (shellExecutable.test(command)) {
    // Only these exact noninteractive forms have a reviewed startup policy. Unknown
    // flags, combined clusters, login/interactive modes and script/stdin modes refuse.
    if (!/(?:^|[/\\])(?:sh|bash|zsh)$/.test(command) || argv[0] !== '-c') {
      throw new SyntaxError('shell startup files are unsupported; use literal argv or plain sh/bash/zsh -c');
    }
    return normaliseScript(argv[1], depth + 1);
  }
  const wrapper = command.split(/[/\\]/).at(-1);
  let i = 0;
  if (wrapper === 'env') {
    while (i < argv.length && argv[i].startsWith('-')) {
      const word = argv[i];
      if (word === '--') { i++; break; }
      if (['-i', '--ignore-environment'].includes(word)) { i++; continue; }
      if (['-u', '--unset'].includes(word)) {
        if (!environmentName.test(argv[i + 1] ?? '')) throw new SyntaxError('missing or unsupported env unset name; use literal argv');
        i += 2; continue;
      }
      if (word.startsWith('--unset=') && environmentName.test(word.slice('--unset='.length))) { i++; continue; }
      // Split-string and chdir can change the invocation being validated. Never interpret them.
      throw new SyntaxError('unsupported env option; use literal argv without split-string or chdir');
    }
    while (i < argv.length && argv[i].includes('=')) {
      validateAssignment(argv[i++]);
    }
  } else if (['nohup', 'command', 'exec', 'npx'].includes(wrapper)) {
    while (['--', '--yes', '-y', '--no-install'].includes(argv[i])) i++;
  } else throw new SyntaxError('unknown executable; use a literal claude/codex path');
  if (i === argv.length) throw new SyntaxError('missing wrapped executable');
  return normaliseCommand(argv.slice(i), depth + 1, shell);
}

/** One entry point for array argv, command strings, and nested literal shell/env wrappers. */
function normaliseInvocation(args) {
  if (!args.length) throw new SyntaxError('missing invocation evidence; use explicit literal argv');
  const [command, argv] = args;
  // A shell joining array argv destroys word boundaries. Require an explicit, literal -c script instead.
  if (Array.isArray(argv) && args[2]?.shell) throw new SyntaxError('shell execution of array argv is ambiguous');
  if (typeof command !== 'string') throw new SyntaxError('nonliteral executable');
  // Match executables only after shell text has been split into individual command words.
  if (/[\s;|&'"($`]/.test(command)) {
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

function snapshotLaunchInputs(inputs, primitive) {
  try {
    // The rest array is ours; Array.isArray never invokes caller Proxy traps.
    if ((primitive === exec || primitive === execSync) && Array.isArray(inputs[2][1])) {
      throw new SyntaxError('execution options must be an object, never an argv array; use literal argv with spawn or execFile');
    }
    return snapshotInput(inputs);
  } catch (cause) {
    // No field of the original descriptor is safe to read on snapshot failure.
    refuse(`cannot snapshot launch inputs; use literal argv and plain data; ${cause.message}`,
      undefined, s => process.stderr.write(s), cause);
  }
}

/**
 * Execute exactly one primitive with its original arguments and return value.
 * `resumeId` is an explicit key even for management commands/fresh launches (null/undefined).
 * The guard is synchronous: a promise is refused rather than accidentally launching before it resolves.
 */
export function launchAgent(descriptor, primitive, ...args) {
  [descriptor, primitive, args] = snapshotLaunchInputs([descriptor, primitive, args], primitive);
  const log = typeof descriptor?.log === 'function' ? descriptor.log : s => process.stderr.write(s);
  if (!descriptor || typeof descriptor !== 'object') refuse('descriptor is required', descriptor, log);
  if (!descriptor.mode) refuse('mode is required', descriptor, log);
  if (!modes.has(descriptor.mode)) refuse(`unknown mode ${String(descriptor.mode)}`, descriptor, log);
  if (!Object.hasOwn(descriptor, 'resumeId')) refuse('resumeId key is required', descriptor, log);
  if (typeof primitive !== 'function') refuse('execution primitive is required', descriptor, log);
  if (!approvedPrimitives.has(primitive) && !isAgentLaunchTestPrimitive(primitive)) {
    refuse('unapproved primitive identity; use an approved unbound primitive and literal argv', descriptor, log);
  }
  let normalised;
  try { args = snapshotInvocation(args, primitive); normalised = normaliseInvocation(args); }
  catch (cause) {
    refuse('cannot parse native resume id; use literal argv and a plain resume id with an unbound primitive'
      + `; ${cause.message}`, descriptor, log, cause);
  }
  if (!normalised.length) refuse('missing invocation evidence; use explicit literal argv', descriptor, log);
  const nativeIds = normalised.flatMap(command => command.resumeIds);
  if (normalised.some(command => command.interactiveResume) && descriptor.mode !== 'codex-exec-resume') {
    refuse('interactive resume/fork requires codex-exec-resume mode and a matching native resume id', descriptor, log);
  }
  // A resume flag with no value reads as an empty native id: that is a MISSING id, never one an empty/blank
  // descriptor resumeId can "equal". Require plain literal ids: never shell expansions or metacharacters.
  if (((descriptor.resumeId != null || descriptor.mode.endsWith('-resume')) && nativeIds.length === 0)
    || nativeIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]*(?![\s\S])/.test(id) || descriptor.resumeId !== id)) {
    refuse('resumeId must equal the native resume id in argv', descriptor, log);
  }
  if ('launchGuard' in descriptor) {
    if (typeof descriptor.launchGuard !== 'function') refuse('launchGuard must be a function', descriptor, log);
    let allowed;
    try { allowed = descriptor.launchGuard(Object.freeze({
      command: args[0], argv: args[1],
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
  return primitive(...args);
}

/** Preserve spawnToCompletion's options/result and the injected spawnFn seam at the OS boundary. */
export function launchAgentToCompletion(descriptor, command, argv, options, io = {}) {
  [descriptor, command, argv, options, io] = snapshotLaunchInputs([descriptor, command, argv, options, io]);
  return spawnToCompletion(command, argv, options, {
    ...io, spawnFn: (...args) => launchAgent(descriptor, io.spawnFn ?? spawn, ...args),
  });
}
