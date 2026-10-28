/**
 * Post-run diagnostics over one Codex rollout; never execute transcript text.
 * Detection uses best-effort heuristics: wrapped shells like `bash -c`, absolute
 * command paths and other tools are not covered. Fail mode rejects flagged runs,
 * check errors and checks skipped for ephemeral runs or a missing threadId.
 */
import { readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeRecord } from '../../skills-src/inspect-codex-transcript/codex-transcript.mjs';
import { cascadePolicy, platformPreference, formatCascadeSourcesLine } from './policy-cascade.mjs';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';

const SETTINGS = join(dirname(fileURLToPath(import.meta.url)), '../settings/codex-transcript-check.json');
const INSPECTION_CAP = 200000;

export function resolveTranscriptCheckPolicy({ env = process.env, tool, platform, readFile = readFileSync } = {}) {
  if (tool === undefined) {
    try { tool = JSON.parse(readFile(SETTINGS, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const text = value => value == null || !String(value).trim() ? undefined : String(value).trim();
  const cap = text(env.WE_CODEX_TRANSCRIPT_TOKEN_CAP);
  platform ??= platformPreference('transcriptCheck', { env, readFile });
  const resolved = cascadePolicy('transcriptCheck', tool?.transcriptCheck, {
    standard: { mode: 'warn', tokenCap: 3000000 }, platform, env,
    envValues: { mode: text(env.WE_CODEX_TRANSCRIPT_CHECK_MODE), tokenCap: cap !== undefined && /^\d+$/.test(cap) ? Number(cap) : cap },
    valid: { mode: value => ['warn', 'fail'].includes(value), tokenCap: value => Number.isSafeInteger(value) && value >= 0 },
  });
  return { ...resolved.value, sources: resolved.sources };
}

// Decode structured tool arguments before inspecting commands. Custom exec tools embed those same
// arguments in JS; extract cmd/command string literals without evaluating the snippet.
function toolCommands(record) {
  const input = String(record.input ?? '');
  try {
    const value = JSON.parse(input);
    const command = value.cmd ?? value.command;
    if (typeof command === 'string') return [command];
    if (Array.isArray(command)) return [command.join(' ')];
    if (/patch|edit/i.test(record.name)) return [input];
    return [];
  } catch { /* custom tool input is text or JavaScript */ }
  const commands = [];
  for (const match of input.matchAll(/\b(?:cmd|command)\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`)/g)) {
    try { commands.push(JSON.parse(match[1])); }
    catch { commands.push(match[1].slice(1, -1).replace(/\\n/g, '\n').replace(/\\(['\\])/g, '$1')); }
  }
  return commands.length ? commands : [input];
}

// Tokenize quoted strings atomically and recognize loop keywords only at command
// boundaries. Each token is visited once; no search retries across loop delimiters.
function hasRiskyLoop(command) {
  const loops = [];
  let commandStart = true, parens = 0, braces = 0, previous = '';
  const tokens = /"(?:\\[\s\S]|[^"\\])*(?:"|$)|'[^']*(?:'|$)|\\[\s\S]|[^\s;|&(){}"'\\]+|[;|&(){}\n]/g;
  for (const [word] of command.matchAll(tokens)) {
    const loop = loops[loops.length - 1];
    if (/^["'\\]/.test(word)) {
      commandStart = false;
    } else if (word === '(') {
      parens++;
      if (loop && !loop.body && ['while', 'for'].includes(previous)) loop.headerDepth = parens;
      // A shell group starts a command; a JS loop header remains an expression.
      commandStart = !(loop && !loop.body && loop.headerDepth);
    } else if (word === ')') {
      if (loop?.headerDepth === parens) loop.headerClosed = true;
      parens = Math.max(0, parens - 1);
      commandStart = false;
    } else if (word === '{') {
      braces++;
      if (loop?.headerClosed && !loop.body) {
        loop.body = true;
        loop.braceDepth = braces;
      }
      commandStart = true;
    } else if (word === '}') {
      if (loop?.braceDepth === braces) {
        loops.pop();
        if (loop.risky) return true;
      }
      braces = Math.max(0, braces - 1);
      commandStart = true;
    } else if (/^[;|&\n]$/.test(word)) {
      commandStart = !(loop && !loop.body && loop.headerDepth);
    } else if (commandStart && ['if', 'then', 'else', 'elif', '!'].includes(word)) {
      // These reserved words introduce a condition or branch command, not arguments.
      commandStart = true;
    } else if (commandStart && ['while', 'for', 'until'].includes(word)) {
      loops.push({ body: false, risky: false });
      commandStart = word !== 'for';
    } else if (commandStart && word === 'do' && loop && !loop.body && !loop.headerDepth) {
      loop.body = true;
      commandStart = true;
    } else if (commandStart && word === 'done' && loop?.body && !loop.braceDepth) {
      loops.pop();
      if (loop.risky) return true;
      commandStart = false;
    } else {
      if (loop && (/(?:^|\/)sleep$/.test(word) || loop.body && /\bheavy-admission\b|\bvitest\b/.test(word))) loop.risky = true;
      commandStart = false;
    }
    previous = word;
  }
  return false;
}

// Mask quoted/escaped syntax before recognizing separators. Keep decoded words
// alongside the mask for path checks, including quoted and concatenated paths.
// Each character is visited once; all input is already bounded by INSPECTION_CAP.
function* shellSegments(command) {
  let words = [], word = '', started = false, masked = '', quote = '';
  const finishWord = () => {
    if (started) words.push(word);
    word = ''; started = false;
  };
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (char === '\\' && quote !== "'" && i + 1 < command.length) {
      const next = command[++i];
      if (next === '\n') continue;
      word += next; started = true; masked += 'xx';
    } else if (quote) {
      masked += 'x';
      if (char === quote) quote = '';
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char; started = true; masked += 'x';
    } else if (';&|\n'.includes(char)) {
      finishWord();
      yield { words, masked };
      words = []; masked = '';
    } else if (/\s/.test(char)) {
      finishWord(); masked += char;
    } else {
      word += char; started = true; masked += char;
    }
  }
  finishWord();
  yield { words, masked };
}

function hasTmpWrite(words) {
  let start = 0;
  while (start < words.length && (['env', 'sudo', 'command', 'exec', 'do'].includes(words[start])
    || /^[A-Za-z_]\w*=/.test(words[start]))) start++;
  const executable = words[start];
  const tmpPath = word => /^\/tmp(?:\/|$)/.test(word);
  if (executable === 'cp' || executable === 'mv') {
    if (tmpPath(words[words.length - 1])) return true;
    for (let i = start + 1; i < words.length; i++) {
      if (['-t', '--target-directory'].includes(words[i]) && tmpPath(words[i + 1])) return true;
      if (words[i].startsWith('-t') && tmpPath(words[i].slice(2))) return true;
      if (words[i].startsWith('--target-directory=') && tmpPath(words[i].slice('--target-directory='.length))) return true;
    }
  } else if (executable === 'mkdir' || executable === 'mktemp') {
    for (let i = start + 1; i < words.length; i++) {
      if (tmpPath(words[i]) || words[i].startsWith('--tmpdir=') && tmpPath(words[i].slice('--tmpdir='.length))) return true;
      if (executable === 'mktemp' && words[i].startsWith('-p') && tmpPath(words[i].slice(2))) return true;
    }
  }
  return false;
}

export function checkTranscriptText(jsonlText, { tokenCap = 3000000 } = {}) {
  const flags = [], seen = new Set();
  let totalTokens = 0, recognized = false;
  const flag = (kind, excerpt) => {
    // Raw evidence stays local to inspection and deduplication. Only numeric lengths
    // cross the return/log boundary; arbitrary argument forms cannot leak through redaction.
    const key = JSON.stringify([kind, excerpt]);
    if (!seen.has(key) && flags.length < 20) { seen.add(key); flags.push({ kind, length: excerpt.length }); }
  };
  const lines = String(jsonlText).split('\n').filter(line => line.trim());
  if (!lines.length) throw new Error('Empty rollout transcript');
  for (const line of lines) {
    const record = summarizeRecord(line, INSPECTION_CAP);
    if (record.kind === 'unparseable') throw new Error('Malformed rollout JSONL');
    const raw = JSON.parse(line);
    if (['function_call', 'custom_tool_call', 'function_call_output', 'custom_tool_call_output',
      'message', 'reasoning', 'task_started', 'task_complete', 'token_count'].includes(raw?.payload?.type)
      || raw?.type === 'turn_context') recognized = true;
    if (record.kind === 'tokens' && Number.isFinite(record.totalTokens)) totalTokens = Math.max(totalTokens, record.totalTokens);
    if (record.kind !== 'tool_call') continue;
    // Check the raw field before the summarizer's printable sanitization. Incomplete
    // tool input cannot prove a clean run: fail mode rejects it.
    const payload = raw.payload;
    const input = payload.input ?? payload.arguments ?? '';
    const rawInput = typeof input === 'string' ? input : JSON.stringify(input);
    if (rawInput.length > INSPECTION_CAP) {
      flag('truncated', rawInput);
      continue;
    }
    for (const command of toolCommands(record)) {
      if (hasRiskyLoop(command)) flag('loop', command);
      const tmp = `(?:["']?)/tmp/`;
      if (new RegExp(`(?:>{1,2}\\s*|\\btee\\s+(?:-[^\\s]+\\s+)*|(?:^|\\s)-o\\s*)${tmp}`).test(command)
        || /(?:\*\*\* (?:Add|Update|Delete) File:|(?:path|file_path|target)["']?\s*[:=])\s*["']?\/tmp\//.test(command)) flag('tmp-write', command);
      // Quoted search patterns are data. Restrict network detection to command words, with wrappers
      // env/sudo/command/exec and VAR=val allowed. Suppress only search command words after wrappers.
      for (const segment of shellSegments(command)) {
        if (hasTmpWrite(segment.words)) flag('tmp-write', command);
        const words = segment.masked.trim();
        if (/^\s*(?:(?:env|sudo|command|exec)\s+|[A-Za-z_][\w]*=\S+\s+)*(?:rg|grep)(?:\s|$)/.test(words)) continue;
        if (/(?:^|\||\bdo\b)\s*(?:(?:env|sudo|command|exec)\s+|[A-Za-z_][\w]*=\S+\s+)*(?:(?:gh|curl)(?:\s|$)|git\s+(?:-C\s+\S+\s+)?(?:fetch|push)(?:\s|$))/.test(words)) flag('network', command);
      }
    }
  }
  if (!recognized) flag('unrecognized', String(jsonlText));
  if (totalTokens > tokenCap) flag('token-cap', `${totalTokens} tokens exceeds cap ${tokenCap}`);
  return { flags, totalTokens };
}

function appendTranscriptLog(path, line) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, line, 'utf8');
}

export function runTranscriptCheck({ rolloutFile, policy, threadId, env = process.env, readFile = readFileSync, appendLog = appendTranscriptLog, now = () => new Date() }) {
  if (!rolloutFile) throw new Error('Run rollout transcript not found');
  const { totalTokens, flags } = checkTranscriptText(readFile(rolloutFile, 'utf8'), policy);
  const verdict = flags.length ? (policy.mode === 'fail' ? 'fail' : 'warn') : 'clean';
  const result = { mode: policy.mode, rolloutFile, totalTokens, flags, verdict };
  appendLog(join(resolveCoordinationRoot({ env }), 'codex-transcript-check.jsonl'), `${JSON.stringify({ ts: now().toISOString(), threadId, rolloutFile, verdict, totalTokens, flags })}\n`);
  return result;
}

/** Preserve the effective mode on lookup, policy, read and log failures for exit enforcement. */
export function checkRunTranscript({ codexHome, threadId, ephemeral = false, findRolloutFile, env = process.env, emit,
  resolvePolicy = resolveTranscriptCheckPolicy, runCheck = runTranscriptCheck }) {
  let policy;
  try {
    policy = resolvePolicy({ env });
    emit(formatCascadeSourcesLine('transcriptCheck', { value: policy, sources: policy.sources }));
    if (ephemeral) throw new Error('Transcript check skipped: ephemeral run has no persisted rollout');
    if (!threadId) throw new Error('Transcript check skipped: no threadId');
    const result = runCheck({ rolloutFile: findRolloutFile({ codexHome, threadId }), policy, threadId, env });
    emit(`codex-transcript-check · verdict=${result.verdict} flags=${[...new Set(result.flags.map(flag => flag.kind))].join(',')}`);
    if (result.flags.some(flag => flag.kind === 'truncated')) emit('codex-transcript-check · truncated input: inspect the full rollout manually; retry with smaller commands');
    return result;
  } catch (error) {
    const mode = policy?.mode ?? (env.WE_CODEX_TRANSCRIPT_CHECK_MODE?.trim() === 'fail' ? 'fail' : 'warn');
    const message = String(error?.message ?? error);
    try { emit(`codex-transcript-check · warning: ${message.replace(/[\x00-\x1f\x7f]/g, ' ')}`); }
    catch { /* A failed output sink must not replace the original failure or mode. */ }
    return { mode, error: message };
  }
}
