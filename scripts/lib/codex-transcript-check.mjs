/** Best-effort post-run diagnostics over one Codex rollout; never execute transcript text. */
import { readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeRecord } from '../../skills-src/inspect-codex-transcript/codex-transcript.mjs';
import { cascadePolicy, platformPreference, formatCascadeSourcesLine } from './policy-cascade.mjs';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';

const SETTINGS = join(dirname(fileURLToPath(import.meta.url)), '../settings/codex-transcript-check.json');

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

export function checkTranscriptText(jsonlText, { tokenCap = 3000000 } = {}) {
  const flags = [], commands = [], seen = new Set();
  let totalTokens = 0;
  const flag = (kind, excerpt) => {
    const detail = String(excerpt).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
    const key = JSON.stringify([kind, detail]);
    if (!seen.has(key) && flags.length < 20) { seen.add(key); flags.push({ kind, detail }); }
  };
  const lines = String(jsonlText).split('\n').filter(line => line.trim());
  if (!lines.length) throw new Error('Empty rollout transcript');
  for (const line of lines) {
    const record = summarizeRecord(line, 200000);
    if (record.kind === 'unparseable') throw new Error('Malformed rollout JSONL');
    if (record.kind === 'tokens' && Number.isFinite(record.totalTokens)) totalTokens = Math.max(totalTokens, record.totalTokens);
    if (record.kind !== 'tool_call') continue;
    for (const command of toolCommands(record)) {
      commands.push(command);
      const loops = command.match(/\b(?:while|for|until)\b[^]*?\bdo\b[^]*?\bdone\b|\b(?:while|for)\s*\([^]*?\)\s*\{[^]*?\}/g) ?? [];
      if (loops.some(loop => /\bsleep\b/.test(loop) || /(?:\bdo\b|\{)[^]*(?:heavy-admission|\bvitest\b)/.test(loop))) flag('loop', command);
      const tmp = `(?:["']?)/tmp/`;
      if (new RegExp(`(?:>{1,2}\\s*|\\btee\\s+(?:-[^\\s]+\\s+)*|(?:^|\\s)-o\\s*)${tmp}`).test(command)
        || /\b(?:cp|mv)\b[^\n;&|]*\s["']?\/tmp\/[^\s"']*["']?\s*(?:$|[;&|\n])/.test(command)
        || /\bmkdir\b[^\n;&|]*\s["']?\/tmp\//.test(command)
        || /\bmktemp\b/.test(command) && !/TMPDIR|\/private\/tmp\/claude-|\bmktemp\b[^\n;&|]*\s-p(?:\s|$)/.test(command)
        || /(?:\*\*\* (?:Add|Update|Delete) File:|(?:path|file_path|target)["']?\s*[:=])\s*["']?\/tmp\//.test(command)) flag('tmp-write', command);
      // Quoted search patterns are data. Restrict network detection to command words, with wrappers
      // such as env/npx allowed; a preceding rg/grep on the same shell segment suppresses it.
      for (const segment of command.split(/[;\n|]|&&/)) {
        const words = segment.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, ' STRING ').trim();
        if (!/\b(?:rg|grep)\b/.test(words) && /(?:^|\||\bdo\b)\s*(?:(?:env|sudo|command|exec)\s+|[A-Za-z_][\w]*=\S+\s+)*(?:(?:gh|curl)(?:\s|$)|git\s+(?:-C\s+\S+\s+)?(?:fetch|push)(?:\s|$))/.test(words)) flag('network', command);
      }
    }
  }
  if (totalTokens > tokenCap) flag('token-cap', `${totalTokens} tokens exceeds cap ${tokenCap}`);
  return { flags, totalTokens, commands };
}

function appendTranscriptLog(path, line) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, line, 'utf8');
}

export function runTranscriptCheck({ rolloutFile, policy, threadId, readFile = readFileSync, appendLog = appendTranscriptLog, now = () => new Date() }) {
  if (!rolloutFile) throw new Error('Run rollout transcript not found');
  const { totalTokens, flags } = checkTranscriptText(readFile(rolloutFile, 'utf8'), policy);
  const verdict = flags.length ? (policy.mode === 'fail' ? 'fail' : 'warn') : 'clean';
  const result = { mode: policy.mode, rolloutFile, totalTokens, flags, verdict };
  appendLog(join(resolveCoordinationRoot(), 'codex-transcript-check.jsonl'), `${JSON.stringify({ ts: now().toISOString(), threadId, rolloutFile, verdict, totalTokens, flags })}\n`);
  return result;
}

/** Keep lookup, policy, read and log failures inside the runner's best-effort boundary. */
export function checkRunTranscript({ codexHome, threadId, findRolloutFile, env, emit }) {
  try {
    const policy = resolveTranscriptCheckPolicy({ env });
    emit(formatCascadeSourcesLine('transcriptCheck', { value: policy, sources: policy.sources }));
    const result = runTranscriptCheck({ rolloutFile: findRolloutFile({ codexHome, threadId }), policy, threadId });
    emit(`codex-transcript-check · verdict=${result.verdict} flags=${[...new Set(result.flags.map(flag => flag.kind))].join(',')}`);
    return result;
  } catch (error) { return { error: String(error?.message ?? error) }; }
}
