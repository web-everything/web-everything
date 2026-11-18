/**
 * The execution boundary for Claude/Codex sessions and management commands (R1003).
 * Callers own argv/options; this module forwards them without copying or normalising.
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
  return resumeIds(typeof argv === 'string' ? shellWords(argv) : argv)[0] ?? null;
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
// Codex's own short value options (-c config, -i image, -p profile, -o output file) are only consulted while
// walking `codex exec [resume]` options, so they never change where the `--` delimiter is found.
const CODEX_SHORT_VALUE_OPTIONS = new Set(['-c', '-i', '-p', '-o']);
const takesValue = (word) => SHORT_VALUE_OPTIONS.has(word) || VALUE_OPTIONS.has(word);
const codexTakesValue = (word) => CODEX_SHORT_VALUE_OPTIONS.has(word) || takesValue(word);
const isOption = (word) => typeof word === 'string' && word.length > 1 && word.startsWith('-');

/** Index of the first positional word at or after `from`, stepping over options and the values they consume. */
function firstPositional(argv, from) {
  let j = from;
  while (j < argv.length && isOption(argv[j])) j += codexTakesValue(argv[j]) ? 2 : 1;
  return j;
}

/**
 * Codex `exec resume [OPTIONS] [SESSION_ID] [PROMPT]`: the session id is the first POSITIONAL after `resume`,
 * never an option. No positional reads as '' (refused, like a resume flag with no value).
 */
function codexResumeId(argv, execAt) {
  const sub = firstPositional(argv, execAt + 1);
  if (argv[sub] !== 'resume') return [];
  const id = firstPositional(argv, sub + 1);
  return [typeof argv[id] === 'string' ? argv[id] : ''];
}

function resumeIds(allWords) {
  // `--` ends the launched claude/codex's option parsing: everything after it is prompt text, never a
  // resume flag. A resume flag directly before it therefore has no value (reads as '' and is refused).
  // Only a `--` AFTER the claude/codex binary word counts (a wrapper's own `--` — `npx -- claude -r X` —
  // must not hide the real command), and a `--` that is an option's value never counts.
  const binary = allWords.findIndex(w => typeof w === 'string' && /(?:^|[/\\])(?:claude|codex)$/.test(w));
  const delimiter = allWords.findIndex((w, i) => w === '--' && i > binary && !takesValue(allWords[i - 1]));
  const argv = delimiter < 0 ? allWords : allWords.slice(0, delimiter);
  let sawExec = false;
  return argv.flatMap((word, i) => {
    // Only the first `exec` that is not an option's value starts a codex exec; later words are its options/prompt.
    if (word === 'exec' && !sawExec && !takesValue(argv[i - 1])) { sawExec = true; return codexResumeId(argv, i); }
    if (word === '--resume' || word === '-r' || word === '--session-id') return [argv[i + 1] ?? ''];
    return typeof word === 'string' && /^(?:--resume=|--session-id=|-r=?)/.test(word) ? [word.replace(/^(?:--resume=|--session-id=|-r=?)/, '')] : [];
  });
}

// Read shell quoting without evaluating expansions or executing any part of the command.
function shellWords(text) {
  const words = []; let word = '', quote = '', started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && quote !== "'") {
      if (i + 1 === text.length) throw new SyntaxError('incomplete shell escape');
      word += text[++i]; started = true;
    }
    else if (quote) { if (c === quote) quote = ''; else word += c; }
    else if (c === "'" || c === '"') { quote = c; started = true; }
    else if (/\s|[;|&()]/.test(c)) {
      if (started) words.push(word);
      word = ''; started = false;
      if (/[;|&()\n]/.test(c)) words.push(';');
    } else { word += c; started = true; }
  }
  if (quote) throw new SyntaxError('unterminated shell quote');
  if (started) words.push(word);
  return words;
}

function shellResumeIds(text) {
  return shellWordResumeIds(shellWords(text));
}

function shellWordResumeIds(words, includeAgents = true) {
  const ids = [];
  for (let i = 0; i < words.length; i++) {
    const end = words.indexOf(';', i + 1), tail = words.slice(i + 1, end < 0 ? undefined : end);
    if (includeAgents && /(?:^|[/\\])(?:claude|codex)$/.test(words[i])) ids.push(...resumeIds(tail));
    if (/(?:^|\/)(?:ba|z|da|k)?sh$/.test(words[i])) {
      const flag = tail.findIndex(w => /^-[a-z]*c[a-z]*$/.test(w));
      if (flag >= 0) {
        if (typeof tail[flag + 1] !== 'string') throw new SyntaxError('missing shell -c script');
        ids.push(...shellResumeIds(tail[flag + 1]));
      }
    }
  }
  return ids;
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
  let nativeIds;
  try {
    const argv = Array.isArray(args[1]) ? args[1] : typeof args[1] === 'string' ? shellWords(args[1]) : [];
    nativeIds = [...resumeIds(argv), ...shellResumeIds(String(args[0] ?? '')),
      ...shellWordResumeIds([args[0], ...argv], false)];
  } catch (cause) {
    refuse('cannot parse native resume id; use literal argv and a plain resume id', descriptor, log, cause);
  }
  // A resume flag with no value reads as an empty native id: that is a MISSING id, never one an empty/blank
  // descriptor resumeId can "equal". Require plain literal ids: never shell expansions or metacharacters.
  if ((descriptor.mode === 'codex-exec-resume' && nativeIds.length === 0)
    || nativeIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]*(?![\s\S])/.test(id) || descriptor.resumeId !== id)) {
    refuse('resumeId must equal the native resume id in argv', descriptor, log);
  }
  if ('launchGuard' in descriptor) {
    if (typeof descriptor.launchGuard !== 'function') refuse('launchGuard must be a function', descriptor, log);
    let allowed;
    try { allowed = descriptor.launchGuard(); } catch (cause) {
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
  if (typeof primitive !== 'function') refuse('execution primitive is required', descriptor, log);
  return primitive(...args);
}

/** Preserve spawnToCompletion's options/result and the injected spawnFn seam at the OS boundary. */
export function launchAgentToCompletion(descriptor, command, argv, options, io = {}) {
  return spawnToCompletion(command, argv, options, {
    ...io, spawnFn: (...args) => launchAgent(descriptor, io.spawnFn ?? spawn, ...args),
  });
}
