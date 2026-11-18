#!/usr/bin/env node
/**
 * Machine-local Claude dispatch telemetry. Streams entire transcripts; never executes their commands.
 * Task and command attribution retain capped metadata, never raw prompts or content-bearing flag values.
 * See docs/agent/testing.md#claude-subagent-usage for schema, usage and inference limits.
 */
import { createReadStream, appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PROJECTS_DIR, idFromAny, resolveTranscript, flattenToolResultText, stripControlSequences } from '../../skills-src/inspect-agent-health/agent-health.mjs';
import { CODEX_MODEL } from '../codex-direct-task.mjs';

export const AGENT_USAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const MAX_TASK_CHARS = 200;
export const MAX_COMMAND_CHARS = 300;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const PROVIDERS = ['codex', 'gemini', 'none'];
const asArray = (value) => value == null ? [] : Array.isArray(value) ? value : [value];
const compact = (values) => values.length === 1 ? values[0] : values.length ? values : null;
export const blocks = (entry) => Array.isArray(entry?.message?.content) ? entry.message.content.filter(Boolean) : [];

/** Bound classification labels, including the visible truncation marker; malformed labels are absent. */
export function capText(value, maxChars) {
  if (typeof value !== 'string') return null;
  return value.length > maxChars ? `${value.slice(0, maxChars - 1)}…` : value;
}

/** Pure metadata projection of parsed argv. Redact whole values BEFORE applying the length cap. */
export function summarizeCommand(argv) {
  const redacted = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const equals = arg.indexOf('=');
    const name = equals < 0 ? arg : arg.slice(0, equals);
    if (/^(--)?(task|task-file|prompt|message|description|body|text)$/i.test(name)) {
      if (equals >= 0) redacted.push(`${name}=[redacted]`);
      else {
        redacted.push(name);
        if (i + 1 < argv.length) { redacted.push('[redacted]'); i++; }
      }
    } else redacted.push(arg);
  }
  return capText(redacted.join(' '), MAX_COMMAND_CHARS);
}

/** Stream even very large transcripts. Malformed rows are observable, not fatal. */
export async function* entries(file, diagnostics) {
  const input = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber++;
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('not an object');
      } catch { diagnostics.corrupt++; continue; }
      yield { entry, lineNumber };
    }
  } finally { lines.close(); input.destroy(); }
}

/**
 * Conservative shell lexer: quotes, escapes, comments, command separators and heredoc bodies.
 * No expansion/eval. Dynamic scripts, substitutions and executable code inside node -e are not inferred.
 * Tokens retain operators separately so quoted prose containing '; node ...' cannot become a command.
 */
function shellCommands(source) {
  const commands = [];
  let words = [], word = '', started = false, quote = null, heredocs = [], delimiter = false;
  const flushWord = () => {
    if (!started) return;
    if (delimiter) { heredocs.push(word); delimiter = false; }
    else words.push(word);
    word = ''; started = false;
  };
  const flushCommand = () => { flushWord(); if (words.length) commands.push(words); words = []; };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '\\' && quote !== "'") {
      if (source[i + 1] === '\n') { i++; continue; }
      word += source[++i] ?? ''; started = true; continue;
    }
    if (quote) {
      if (c === quote) quote = null;
      else word += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; started = true; continue; }
    if (c === '#' && !started) { while (i < source.length && source[i] !== '\n') i++; i--; continue; }
    if (c === '<' && source.slice(i, i + 2) === '<<' && source[i + 2] !== '<') {
      flushWord(); delimiter = true; i++; if (source[i + 1] === '-') i++; continue;
    }
    if (c === '\n') {
      flushCommand();
      for (const end of heredocs) {
        let found = false;
        while (i < source.length) {
          const next = source.indexOf('\n', i + 1);
          const stop = next < 0 ? source.length : next;
          const body = source.slice(i + 1, stop).replace(/^\t+/, '');
          i = stop;
          if (body === end) { found = true; break; }
        }
        if (!found) break;
      }
      heredocs = []; continue;
    }
    if (';&|()'.includes(c)) { flushCommand(); continue; }
    if (c === '<' || c === '>') {
      // Redirections end argv; their targets are never command positions.
      flushWord(); words.push('__redirect__'); continue;
    }
    if (/\s/.test(c)) { flushWord(); continue; }
    word += c; started = true;
  }
  if (!quote) flushCommand(); // Incomplete quoted commands are not evidence of execution.
  return commands;
}

/** Actual script in executable position, not a grep/ls/echo argument or a node --check/-e operand. */
export function delegationsFromCommand(command) {
  if (typeof command !== 'string') return [];
  const found = [];
  for (let argv of shellCommands(command)) {
    while (/^[A-Za-z_][\w]*=/.test(argv[0] ?? '')) argv = argv.slice(1);
    while (['env', 'command', 'exec', 'nohup'].includes(basename(argv[0] ?? ''))) {
      argv = argv.slice(1);
      while (/^[A-Za-z_][\w]*=/.test(argv[0] ?? '') || argv[0] === '--') argv = argv.slice(1);
    }
    if (['bash', 'sh', 'zsh'].includes(basename(argv[0] ?? '')) && /^-[a-z]*c[a-z]*$/.test(argv[1] ?? '')) {
      // Keep the nested invocation's sanitized metadata; the wrapper contains the raw command body.
      found.push(...delegationsFromCommand(argv[2]));
      continue;
    }
    const invocation = argv;
    if (/^node(?:js)?$/.test(basename(argv[0] ?? ''))) {
      argv = argv.slice(1);
      while (['--no-warnings', '--enable-source-maps', '--'].includes(argv[0])) argv = argv.slice(1);
    }
    const match = /^(codex|gemini)-direct-task\.mjs$/.exec(basename(argv[0] ?? ''));
    if (!match) continue;
    const provider = match[1];
    // Gemini's builder deliberately has NO default model: it defers to agy's configuration.
    let model = provider === 'codex' ? CODEX_MODEL : null;
    let modelSource = provider === 'codex' ? 'script-default' : 'unspecified';
    for (let i = 1; i < argv.length && argv[i] !== '--'; i++) {
      if (argv[i] === '__redirect__') { i++; continue; }
      const flag = /^(?:--model|-m)=(.*)$/.exec(argv[i]);
      if (flag) { model = flag[1] || null; modelSource = 'explicit'; }
      else if (['--model', '-m'].includes(argv[i])) { model = argv[++i] ?? null; modelSource = 'explicit'; }
    }
    found.push({ provider, command: summarizeCommand(invocation), model, modelSource });
  }
  return found;
}

function collectOutcomes(text, outcomes) {
  // pr-land emits a JSON object: `merged: false` means queued/open, never a merged signal.
  try {
    const result = JSON.parse(text);
    if (Number.isSafeInteger(result?.pr) && result.pr > 0 && typeof result.reason === 'string'
        && (typeof result.repo === 'string' || typeof result.ref === 'string')) {
      const status = result.merged === true ? 'merged'
        : ['opened', 'created', 'rejected', 'closed'].includes(result.reason) ? result.reason : null;
      if (status || !outcomes.has(result.pr)) outcomes.set(result.pr, {
        pr: result.pr, status, evidence: JSON.stringify({ pr: result.pr, merged: result.merged, reason: result.reason }),
      });
      return;
    }
  } catch { /* ordinary prose/tool output, scanned below */ }
  for (const line of text.split('\n')) {
    for (const match of line.matchAll(/\bPR\s*#(\d+)\b|https?:\/\/[^\s]+\/pull\/(\d+)\b/gi)) {
      const nearby = line.slice(Math.max(0, match.index - 90), match.index + match[0].length + 90);
      if (/pr-land \[[^\]]+\].*\b(enqueued|labelled|parked)\b/.test(line)) {
        const pr = Number(match[1] ?? match[2]);
        if (!outcomes.has(pr)) outcomes.set(pr, { pr, status: null, evidence: nearby.trim() });
        continue;
      }
      const status = /\b(merged|rejected|closed|created|opened)\b/i.exec(nearby)?.[1]?.toLowerCase() ?? null;
      // A quoted reference or future/negative status is not a produced PR.
      if (/\b(not|never|will|should|would|if|cannot|can't|don't)\b/i.test(nearby)) continue;
      if (!status && !/^https?:\/\/\S+\/pull\/\d+\s*$/.test(line.trim())) continue;
      const pr = Number(match[1] ?? match[2]);
      if (status || !outcomes.has(pr)) outcomes.set(pr, { pr, status, evidence: nearby.trim() });
    }
  }
}

/** Extract a child, optionally supplied the parent Agent tool_use for sidecar-free task attribution. */
export async function extractAgentUsage(target, { dispatch, session, project } = {}) {
  const located = resolveTranscript({ target: typeof target === 'string' && existsSync(target) ? resolve(target) : target, session, project });
  if (!located.file) throw new Error(located.error);
  const file = located.file;
  let meta = null;
  try { meta = JSON.parse(readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')); } catch { /* optional */ }
  const diagnostics = { corrupt: 0 }, models = new Set(), delegations = [], outcomes = new Map();
  let timestamp = null;
  for await (const { entry, lineNumber } of entries(file, diagnostics)) {
    if (lineNumber === 1 && typeof entry.timestamp === 'string' && Number.isFinite(Date.parse(entry.timestamp))) timestamp = entry.timestamp;
    if ((entry.type === 'assistant' || entry.message?.role === 'assistant') && typeof entry.message?.model === 'string') models.add(entry.message.model);
    for (const block of blocks(entry)) {
      if (entry.type === 'assistant' && block.type === 'tool_use' && block.name === 'Bash') delegations.push(...delegationsFromCommand(block.input?.command));
      if (block.type === 'tool_result') collectOutcomes(flattenToolResultText(block.content), outcomes);
      if (entry.type === 'assistant' && block.type === 'text') collectOutcomes(block.text ?? '', outcomes);
    }
    if (entry.type === 'assistant' && typeof entry.message?.content === 'string') collectOutcomes(entry.message.content, outcomes);
  }
  return {
    // Prompts are content, not classification metadata — never use even a truncated prefix here.
    task: capText(meta?.description ?? dispatch?.input?.description ?? null, MAX_TASK_CHARS),
    modelTier: compact([...models]),
    delegatedProvider: compact([...new Set(delegations.map((d) => d.provider))]) ?? 'none',
    delegatedModel: compact(delegations.map(({ command, model }) => ({ command, model }))),
    delegations,
    outcome: outcomes.size ? { pullRequests: [...outcomes.values()] } : null,
    timestamp: timestamp ?? statSync(file).mtime.toISOString(),
    timestampSource: timestamp ? 'transcript' : 'mtime',
    agentId: idFromAny(file),
    sessionId: basename(dirname(dirname(file))),
    transcript: file,
    corruptTranscriptLines: diagnostics.corrupt,
  };
}

export function resolveSessionTranscript({ transcript, session = process.env.CLAUDE_CODE_SESSION_ID, cwd = process.cwd() } = {}) {
  if (transcript) return resolve(transcript);
  if (!session || basename(session) !== session) throw new Error('Provide --transcript=<path>, --session=<id>, or CLAUDE_CODE_SESSION_ID.');
  const preferred = join(PROJECTS_DIR, cwd.replaceAll('/', '-'), `${session}.jsonl`);
  if (existsSync(preferred)) return preferred;
  const hits = existsSync(PROJECTS_DIR) ? readdirSync(PROJECTS_DIR).map((p) => join(PROJECTS_DIR, p, `${session}.jsonl`)).filter(existsSync) : [];
  if (hits.length === 1) return hits[0];
  throw new Error(hits.length ? 'Session appears in multiple projects; supply --transcript.' : `No orchestrating transcript found for session ${session}.`);
}

/** Enumerate parent dispatches, linking sidecars or tool results by tool_use_id (never prose similarity). */
export async function scanSession(options = {}) {
  const transcript = resolveSessionTranscript(options);
  const sessionId = basename(transcript, '.jsonl'), project = basename(dirname(transcript));
  const childDir = join(dirname(transcript), sessionId, 'subagents');
  const children = new Map(), dispatches = new Map(), results = new Map(), diagnostics = { corrupt: 0 };
  if (existsSync(childDir)) for (const name of readdirSync(childDir).filter((f) => f.endsWith('.meta.json'))) {
    try {
      const meta = JSON.parse(readFileSync(join(childDir, name), 'utf8'));
      if (meta.toolUseId) children.set(meta.toolUseId, join(childDir, name.replace(/\.meta\.json$/, '.jsonl')));
    } catch { diagnostics.corrupt++; }
  }
  for await (const { entry } of entries(transcript, diagnostics)) {
    for (const block of blocks(entry)) {
      if (entry.type === 'assistant' && block.type === 'tool_use' && block.name === 'Agent') dispatches.set(block.id, block);
      if (block.type === 'tool_result') {
        const text = flattenToolResultText(block.content);
        const structured = entry.toolUseResult;
        const agentId = structured?.agentId ?? /\bagentId:\s*([\w-]+)/.exec(text)?.[1];
        const outputFile = structured?.outputFile ?? /\boutput_file:\s*(\S+)/.exec(text)?.[1];
        if (agentId || outputFile) results.set(block.tool_use_id, { agentId, outputFile });
      }
    }
  }
  const records = [], skipped = [];
  for (const [toolUseId, dispatch] of dispatches) {
    const result = results.get(toolUseId);
    const target = children.get(toolUseId) ?? (result?.agentId && join(childDir, `agent-${idFromAny(result.agentId)}.jsonl`)) ?? result?.outputFile;
    if (!target) { skipped.push({ toolUseId, reason: 'No child id in matching tool result or sidecar' }); continue; }
    try {
      const record = await extractAgentUsage(target, { dispatch, session: sessionId, project });
      records.push({ ...record, toolUseId, orchestratingTranscript: transcript });
    } catch (error) { skipped.push({ toolUseId, reason: error.message }); }
  }
  return { transcript, dispatches: dispatches.size, records, skipped, corrupt: diagnostics.corrupt + records.reduce((n, r) => n + r.corruptTranscriptLines, 0) };
}

export function agentUsageDir(root = AGENT_USAGE_ROOT) { return join(root, '.operations', 'agent-usage'); }
export function resolveAgentUsageDir() { return process.env.OPERATION_AGENT_USAGE_DIR?.trim() ? resolve(process.env.OPERATION_AGENT_USAGE_DIR.trim()) : agentUsageDir(); }
export function dayKey(timestamp) {
  const key = String(timestamp ?? '').slice(0, 10);
  if (!DAY_RE.test(key)) throw new TypeError(`Invalid agent-usage timestamp: ${timestamp}`);
  return key;
}
export function agentUsageLogPath(day, dir = resolveAgentUsageDir()) {
  if (!DAY_RE.test(day)) throw new TypeError(`Invalid agent-usage day: ${day}`);
  return join(dir, `${day}.jsonl`);
}
function validRecord(record) {
  return record && typeof record.agentId === 'string' && record.agentId.length > 0
    && typeof record.timestamp === 'string' && DAY_RE.test(record.timestamp.slice(0, 10)) && Number.isFinite(Date.parse(record.timestamp))
    && (record.modelTier === null || asArray(record.modelTier).length > 0 && asArray(record.modelTier).every((m) => typeof m === 'string' && m.length > 0))
    && asArray(record.delegatedProvider).length > 0 && asArray(record.delegatedProvider).every((p) => PROVIDERS.includes(p));
}
export function readAgentUsageLog(day, dir = resolveAgentUsageDir()) {
  const file = agentUsageLogPath(day, dir), lines = [];
  let corrupt = 0;
  if (!existsSync(file)) return { lines, corrupt };
  for (const row of readFileSync(file, 'utf8').split('\n')) {
    if (!row.trim()) continue;
    try {
      const record = JSON.parse(row);
      if (!validRecord(record)) throw new Error('Invalid record');
      lines.push(record);
    } catch { corrupt++; }
  }
  return { lines, corrupt };
}
export function listAgentUsageDays(dir = resolveAgentUsageDir()) {
  return existsSync(dir) ? readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).map((f) => f.slice(0, -6)).sort() : [];
}
/** Serial append, agentId deduped within its timestamp day. Callers must serialize ingestion jobs. */
export function appendAgentUsageLogLine(record, dir = resolveAgentUsageDir()) {
  if (!validRecord(record)) throw new TypeError('Invalid agent-usage record');
  const day = dayKey(record.timestamp);
  const { lines, corrupt } = readAgentUsageLog(day, dir);
  if (lines.some((r) => r.agentId === record.agentId)) return { appended: false, corrupt };
  mkdirSync(dir, { recursive: true });
  const file = agentUsageLogPath(day, dir);
  // Isolate a truncated final row before appending, so one torn write cannot swallow a good record.
  const prefix = existsSync(file) && statSync(file).size > 0 && !readFileSync(file, 'utf8').endsWith('\n') ? '\n' : '';
  appendFileSync(file, `${prefix}${JSON.stringify(record)}\n`);
  return { appended: true, corrupt };
}
export async function scanAndAppend(options = {}) {
  const scan = await scanSession(options);
  let appended = 0, alreadyPresent = 0;
  const corruptDays = new Map();
  for (const record of scan.records) {
    const result = appendAgentUsageLogLine(record, options.dir);
    if (result.appended) appended++; else alreadyPresent++;
    corruptDays.set(dayKey(record.timestamp), result.corrupt);
  }
  return { transcript: scan.transcript, dispatches: scan.dispatches, appended, alreadyPresent, skipped: scan.skipped, corrupt: scan.corrupt, corruptStoreLines: [...corruptDays.values()].reduce((a, b) => a + b, 0) };
}

export function reportAgentUsage({ dir = resolveAgentUsageDir(), since, days, now = new Date() } = {}) {
  // utc-day-slice-ok: validate an explicitly supplied UTC shard key, not an operator's wall-clock date.
  if (since && (!DAY_RE.test(since) || !Number.isFinite(Date.parse(since)) || new Date(since).toISOString().slice(0, 10) !== since)) throw new TypeError('--since must be YYYY-MM-DD');
  if (days !== undefined && (!Number.isSafeInteger(Number(days)) || Number(days) < 1)) throw new TypeError('--days must be a positive integer');
  // utc-day-slice-ok: --days selects timestamp-keyed UTC telemetry shards, matching the store's rotation.
  const cutoff = days === undefined ? null : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - (Number(days) - 1) * 86400000).toISOString().slice(0, 10);
  const report = { total: 0, byModelTier: {}, byDelegatedProvider: { codex: 0, gemini: 0, none: 0 }, byDay: {}, corrupt: 0 };
  const increment = (table, key) => Object.defineProperty(table, key, { value: (Object.hasOwn(table, key) ? table[key] : 0) + 1, enumerable: true, configurable: true });
  for (const day of listAgentUsageDays(dir).filter((d) => (!since || d >= since) && (!cutoff || d >= cutoff))) {
    const { lines, corrupt } = readAgentUsageLog(day, dir);
    report.corrupt += corrupt;
    for (const record of lines) {
      report.total++;
      for (const tier of new Set(asArray(record.modelTier ?? 'unknown'))) increment(report.byModelTier, tier);
      for (const provider of new Set(asArray(record.delegatedProvider))) increment(report.byDelegatedProvider, provider);
      increment(report.byDay, dayKey(record.timestamp));
    }
  }
  return report;
}
export function formatAgentUsageReport(report) {
  const output = [`Dispatches: ${report.total}`];
  for (const [title, counts] of [['Model tier', report.byModelTier], ['Delegated provider', report.byDelegatedProvider], ['Day', report.byDay]]) {
    output.push('', `${title.padEnd(36)} Dispatches`);
    for (const [key, count] of Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))) output.push(`${stripControlSequences(key).padEnd(36)} ${count}`);
  }
  output.push('', 'Multi-model/provider dispatches count once in each observed category.', `Corrupt/skipped store lines: ${report.corrupt}`);
  return output.join('\n');
}
export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: {
    report: { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean' },
    session: { type: 'string' }, transcript: { type: 'string' }, since: { type: 'string' }, days: { type: 'string' },
  } });
  if (values.help) {
    console.log('Usage: node scripts/operations/agent-usage-report.mjs [--session=ID | --transcript=PATH] [--json]\n       node scripts/operations/agent-usage-report.mjs --report [--since=YYYY-MM-DD | --days=N] [--json]');
    return;
  }
  if (values.report) {
    const report = reportAgentUsage(values);
    console.log(values.json ? JSON.stringify(report, null, 2) : formatAgentUsageReport(report));
  } else {
    if (values.days || values.since) throw new Error('--since/--days require --report');
    const result = await scanAndAppend(values);
    console.log(values.json ? JSON.stringify(result, null, 2) : [
      `Dispatches: ${result.dispatches}; appended: ${result.appended}; already present: ${result.alreadyPresent}; skipped: ${result.skipped.length}`,
      `Corrupt/skipped transcript/sidecar lines: ${result.corrupt}; store lines: ${result.corruptStoreLines}`,
      ...result.skipped.map((s) => `  ${s.toolUseId}: ${stripControlSequences(s.reason)}`),
    ].join('\n'));
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
