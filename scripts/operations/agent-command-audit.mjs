/**
 * Audit Claude and Codex tool transcripts for queued and bypassed heavy commands.
 * Read only; no commands from transcripts are executed.
 * Usage: node scripts/operations/agent-command-audit.mjs --date=YYYY-MM-DD [--home=<dir>] [--json]
 * Dates are calendar days in America/New_York, including daylight saving transitions.
 */
import { readdirSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { canonicalCommand, commandSubstitutionBodies, parseSegments, shellTokens, ungatedHeavyRunKind } from '../guard-bash.mjs';

const etDay = value => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(value));

// Option names that carry a credential (`--token`, `--api-key`, `--client-secret`, `--password`, `--pass`,
// `--pat`/`--gitlab-pat` personal access tokens, …). `pat` is a whole name part, so `--path`/`--compat` stay data.
const CREDENTIAL_OPTION = /token|secret|passw(?:or)?d|^pass$|^pw$|(?:^|[-_])pat$|credential|auth(?!or)|cookie|key$/i;
// One whole shell word: concatenated quoted runs, `$'…'`, `$( … )`, backticks, escapes and plain characters.
const SHELL_WORD = String.raw`(?:"(?:\\.|[^"\\])*"|'[^']*'|\$'(?:\\.|[^'\\])*'|\$\([^)]*\)|` + '`[^`]*`'
  + String.raw`|\\.|[^\s"'` + '`' + String.raw`;|&\\])+`;
const EMPTY_WORD = /^(?:""|'')+$/;
// Header names (`Authorization:`, `PRIVATE-TOKEN:`, `x-api-key:`, `token:`) and assignment names
// (`API_KEY=`, `MY_PASS=`, `GITLAB_AUTH=`) whose value is a credential. Tested on one captured name.
const CREDENTIAL_HEADER = /authorization|token|secret|password|cookie|(?:api|access|private|secret|auth)[-_]?key/i;
const CREDENTIAL_ASSIGNMENT = /key|token|secret|passw(?:or)?d|pass(?:[_-]|$)|(?:^|[_-])pat(?:[_-]|$)|credential|auth(?!or)|cookie/i;
// Commands longer than this are cut before redaction so every rule stays linear-time; the cut is marked.
export const REDACT_MAX_CHARS = 16384;

/** Redact a credential option together with its value, attached (`--token=x`) or separate (`--token x`).
 *  Option names are compared with shell quotes removed (`--"token"`, `"--token"`, `--to''ken`); an empty
 *  quoted value (`--token "" v`) takes the next word too. */
function redactCredentialOptions(text) {
  const name = /(?<![^\s"'])["']?-{1,2}([^\s=]+)(=?)/g;
  let out = '', last = 0;
  for (let m; (m = name.exec(text));) {
    if (!CREDENTIAL_OPTION.test(m[1].replace(/["']/g, ''))) continue;
    let end = name.lastIndex;
    for (let words = 0; words < 2; words += 1) {
      const value = new RegExp((m[2] && !words ? '' : String.raw`\s+`) + SHELL_WORD, 'y');
      value.lastIndex = end;
      const hit = value.exec(text);
      if (!hit) break;
      end = value.lastIndex;
      if (!EMPTY_WORD.test(hit[0].trim())) break;
    }
    out += text.slice(last, m.index) + '[REDACTED]';
    last = name.lastIndex = end;
  }
  return out + text.slice(last);
}

export function redact(text) {
  let clean = stripVTControlCharacters(String(text)).replace(/[\x00-\x1f\x7f]/g, ' ');
  if (clean.length > REDACT_MAX_CHARS) clean = clean.slice(0, REDACT_MAX_CHARS) + ' …[truncated]';
  // Value-carrying forms run before the generic name rule below, which would otherwise redact only the name.
  // Every rule that starts with a repeated class is anchored to a word start, so none of them is quadratic.
  return redactCredentialOptions(clean
    .replace(/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@"']+@/gi, '$1[REDACTED]@')
    // HTTP-style credential headers and `token: v`, with or without an auth scheme word.
    .replace(/(?<![\w-])([\w-]+)\s*:\s*(?:(?:Bearer|Basic|Digest|Negotiate|token)\s+)?[^\s"';]+/gi,
      (all, name) => (CREDENTIAL_HEADER.test(name) ? '[REDACTED]' : all))
    // curl/git-style `user:password` pairs.
    .replace(/(?<!\S)(?:--user(?:=|\s+)|-u\s*)[^\s:]*:\S+/g, '[REDACTED]'))
    .replace(/\b(?:gh[pousr]_|github_pat_|glpat-|sk-|xox[a-z]-)[A-Za-z0-9_-]+|\bnpm_[A-Za-z0-9]{20,}|\bAKIA[0-9A-Z]{16}\b/gi, '[REDACTED]')
    .replace(/\bBearer\s+(?:"[^"]*"|'[^']*'|[^\s"'`;,]+)/gi, '[REDACTED]')
    .replace(/(?<![\w-])([\w-]+)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s;,]+)/g, (all, name) => (CREDENTIAL_ASSIGNMENT.test(name) ? '[REDACTED]' : all))
    .replace(/\b(?:token|secret|key|bearer)\S*/gi, '[REDACTED]')
    .replace(/\b[a-f0-9]{32,}\b/gi, '[REDACTED]')
    .replace(/(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{40,}={0,2}(?![A-Za-z0-9+/_-])/g, '[REDACTED]');
}

function repoWideSearch(words) {
  if (words[0] === 'find') return /^(?:\.?\/?|~|\/.*)$/.test(words[1] || '');
  if (words[0] !== 'rg' && words[0] !== 'grep') return false;
  if (words[0] === 'grep' && !words.some(w => /^--(?:recursive|dereference-recursive)$|^-[^-]*[rR]/.test(w))) return false;
  const operands = [];
  let patternGiven = false, listing = false;
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if (word === '--files') { listing = true; continue; }
    if (/^(?:-e|--regexp|-f|--file)$/.test(word)) { patternGiven = true; i++; continue; }
    if (/^(?:-g|--glob|--iglob|-t|--type|--type-not|-m|--max-count|--max-depth|--threads)$/.test(word)) { i++; continue; }
    if (word.startsWith('-')) continue;
    operands.push(word);
  }
  const paths = listing || patternGiven ? operands : operands.slice(1);
  return !paths.length || paths.some(path => /^(?:\.|\.\/|~|\/.*)$/.test(path));
}

const HEAVY_KIND_CATEGORY = { vitest: 'vitest', 'node-test': 'node --test', standards: 'check:standards', test: 'npm test/check' };

// Bounds on command-substitution extraction. Past either one the command is reported unparsed, never dropped.
export const SUBSTITUTION_MAX_CHARS = 16384;
export const SUBSTITUTION_MAX_BODIES = 64;

/** Every substitution body of `cmd`, or null when it is too long, too nested or unreadable (fail closed). */
export function boundedSubstitutionBodies(cmd) {
  const text = String(cmd ?? '');
  if (text.length > SUBSTITUTION_MAX_CHARS) return null;
  // Openers bound the body count from above; checking them first keeps a deep nest off the quadratic extractor.
  if ((text.match(/\$\(|`/g) || []).length > SUBSTITUTION_MAX_BODIES * 4) return null;
  try {
    const bodies = commandSubstitutionBodies(text);
    return bodies.length > SUBSTITUTION_MAX_BODIES ? null : bodies;
  } catch { return null; } // a pathological nest overflows the extractor's stack
}

/** One entry per heavy category/status/segment; admission never leaks across a separator.
 *  `withSubstitutions` is false for a substitution body: the extractor already returned its nested bodies,
 *  so re-extracting them would count each one again and grow combinatorially with nesting. */
export function classifyCommand(cmd, depth = 0, withSubstitutions = true) {
  const out = [];
  if (depth > 8) return [{ category: 'unparsed (nesting too deep)', queued: false, command: redact(String(cmd)) }];
  // A shell runs `$( … )` / backtick bodies too; they are never admitted by the outer command's queue.
  if (withSubstitutions) {
    const bodies = boundedSubstitutionBodies(cmd);
    if (!bodies) return [{ category: 'unparsed (substitutions too long or too nested)', queued: false, command: redact(String(cmd)) }];
    for (const body of bodies) out.push(...classifyCommand(body, depth + 1, false));
  }
  for (const segment of parseSegments(String(cmd)).segments) {
    let head = canonicalCommand(segment), queued = false;
    const admitted = /^node\s+\S*heavy-admission\.mjs\s+run\b[\s\S]*?\s--\s+([\s\S]+)$/.exec(head);
    if (admitted) { queued = true; head = canonicalCommand(admitted[1]); }
    const words = shellTokens(head).filter(word => !word.op).map(word => word.text);
    if (/^(?:ba|da|z|k)?sh$/.test(words[0] || '')) {
      const at = words.findIndex((word, index) => index > 0 && /^-[a-z]*c[a-z]*$/.test(word));
      if (at >= 0 && words[at + 1]) {
        for (const hit of classifyCommand(words[at + 1], depth + 1)) out.push({ ...hit, queued: queued || hit.queued });
        continue;
      }
    }
    if (/^(?:npm|pnpm|yarn|bun)\s+run\s+(?:test:unit|check:standards)(?:\s|$)/.test(head)) queued = true;
    let category;
    if (/^(?:vitest(?:@\S*)?\b|(?:pnpm|yarn|bun)\s+(?:exec\s+)?vitest\b|node\s+.*\b(?:vitest\.mjs|vitest\/dist\/cli\.js|\.bin\/vitest)\b)/.test(head)
      && !/\s(?:--version|-v|--help|-h)(?:\s|$)/.test(head)) category = 'vitest';
    else if (/^(?:(?:pnpm|yarn|bun)\s+(?:exec\s+)?|npm\s+(?:exec|x)\s+(?:--\s+)?)?playwright(?:@\S*)?\s+test\b/.test(head)) category = 'playwright';
    else if (/^node\s+.*?--test(?:=\S*)?(?:\s|$)/.test(head)
      && !/^node\s+(?:(?:--\S+|-\w)\s+)*(?:--check|-c|--eval|-e|--print|-p|--version|-v|--help|-h)(?:\s|$)/.test(head)) category = 'node --test';
    else if (/^node\s+.*\bcheck-standards\.mjs\b/.test(head) || /^(?:npm|pnpm)\s+run\s+check:standards(?:\s|$)/.test(head)) category = 'check:standards';
    else if (/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test\b|t\b|tst\b|check:(?:visual|render)\b)/.test(head)) category = 'npm test/check';
    // The Bash guard's classifier catches spellings the patterns above miss (`npm --prefix . test`, `npm -s test`).
    else if (HEAVY_KIND_CATEGORY[ungatedHeavyRunKind(head)]) category = HEAVY_KIND_CATEGORY[ungatedHeavyRunKind(head)];
    else if (/^(?:npm|pnpm|yarn|bun)\s+(?:install|i|ci)\b/.test(head)) category = 'install/ci';
    else if (/^git\s+(?:-C\s+\S+\s+)?(?:fetch|clone|worktree\s+add|gc|repack)\b/.test(head)) category = 'git fetch/clone/wt/gc';
    else if (repoWideSearch(words)) category = 'repo-wide find/grep';
    if (category) out.push({ category, queued, command: redact(segment.trim()) });
  }
  return out;
}

function toolCommands(record) {
  const commands = [];
  for (const block of Array.isArray(record.message?.content) ? record.message.content : []) {
    if (block.type === 'tool_use' && block.name === 'Bash' && typeof block.input?.command === 'string') commands.push(block.input.command);
  }
  const p = record.payload;
  if (!p || !['function_call', 'custom_tool_call'].includes(p.type)) return commands;
  const name = String(p.name || '').split('.').pop();
  const raw = p.arguments ?? p.input;
  let args = raw;
  if (typeof raw === 'string') { try { args = JSON.parse(raw); } catch { /* functions.exec is JavaScript, parsed as data below */ } }
  if (['exec_command', 'shell_command', 'shell', 'local_shell'].includes(name) && args && typeof args === 'object') {
    const command = args.cmd ?? args.command;
    if (typeof command === 'string') commands.push(command);
    else if (Array.isArray(command) && command.every(x => typeof x === 'string')) commands.push(command.join(' '));
  }
  if (name === 'exec' && typeof raw === 'string') {
    // Extract literal cmd properties only. Never eval transcript JavaScript.
    for (const match of raw.matchAll(/\bcmd\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`)/g)) {
      const literal = match[1];
      if (literal[0] === '"') { try { commands.push(JSON.parse(literal)); } catch { /* malformed literal */ } }
      else if (!literal.includes('${')) commands.push(literal.slice(1, -1).replace(/\\(['\\])/g, '$1').replace(/\\n/g, '\n'));
    }
  }
  return commands;
}

/** Pure JSONL reducer. Invalid records are counted and reported rather than silently cleared. */
export function auditLines(lines, { date, source = 'unknown' } = {}) {
  // utc-day-slice-ok: UTC-anchored round-trip of a user-supplied YYYY-MM-DD string (Date.parse reads it as UTC), not a wall-clock "today" read
  if (date !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)) throw new Error('Invalid --date; expected YYYY-MM-DD');
  const result = { rows: [], byCategory: {}, bySource: {}, invalidLines: 0 };
  for (const line of typeof lines === 'string' ? lines.split(/\r?\n/) : lines) {
    if (!String(line).trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { result.invalidLines++; continue; }
    if (!record || typeof record !== 'object') { result.invalidLines++; continue; }
    const commands = toolCommands(record);
    if (!commands.length) continue;
    if (!Number.isFinite(Date.parse(record.timestamp))) { result.invalidLines++; continue; }
    if (date && etDay(record.timestamp) !== date) continue;
    const kind = record.message ? 'claude' : 'codex';
    const classify = command => {
      try { return classifyCommand(command); }
      catch { return [{ category: 'unparsed (classifier error)', queued: false, command: redact(String(command)) }]; }
    };
    for (const command of commands) for (const hit of classify(command)) {
      const row = { ...hit, source: redact(source === 'unknown' ? kind : source), timestamp: record.timestamp };
      result.rows.push(row);
      for (const [table, key] of [[result.byCategory, row.category], [result.bySource, row.source]]) {
        const counts = table[key] ??= { queued: 0, bypassed: 0 };
        counts[row.queued ? 'queued' : 'bypassed']++;
      }
    }
  }
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const flags = {};
  for (const arg of argv) {
    const m = /^--(date|home)=(.+)$/.exec(arg);
    if (m) flags[m[1]] = m[2];
    else if (arg === '--json') flags.json = true;
    else throw new Error('Usage: agent-command-audit.mjs --date=YYYY-MM-DD [--home=<dir>] [--json]');
  }
  const date = flags.date || etDay(Date.now()), home = resolve(flags.home || homedir());
  auditLines([], { date }); // Validate even when no transcripts exist.
  const total = { date, files: 0, rows: [], byCategory: {}, bySource: {}, invalidLines: 0, errors: [] };
  async function scan(dir, kind) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch (error) { total.errors.push(`${kind}: ${error.code || 'read error'}; inspect transcript coverage manually`); return; }
    for (const e of entries) {
      const path = join(dir, e.name);
      if (e.isDirectory()) {
        // Session directories reflect creation dates; resumed sessions append
        // newer records there. Only record timestamps bound the audit window.
        await scan(path, kind);
        continue;
      }
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      total.files++;
      try {
        const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
        for await (const line of lines) {
          const part = auditLines([line], { date, source: `${kind}:${relative(home, path)}` });
          total.rows.push(...part.rows); total.invalidLines += part.invalidLines;
          for (const field of ['byCategory', 'bySource']) for (const [key, counts] of Object.entries(part[field])) {
            const sum = total[field][key] ??= { queued: 0, bypassed: 0 };
            sum.queued += counts.queued; sum.bypassed += counts.bypassed;
          }
        }
      } catch (error) { total.errors.push(`${kind}: ${error.code || 'read error'}; inspect transcript coverage manually`); }
    }
  }
  await scan(join(home, '.claude/projects'), 'claude');
  await scan(join(home, '.codex/sessions'), 'codex');
  if (flags.json) console.log(JSON.stringify(total, null, 2));
  else {
    console.log(`${date} ET — ${total.files} transcript files`);
    console.table(total.byCategory); console.table(total.bySource);
    if (total.invalidLines || total.errors.length) console.error(`Incomplete audit: ${total.invalidLines} invalid records; ${total.errors.join('; ')}. Inspect input manually.`);
  }
  if (total.invalidLines || total.errors.length) process.exitCode = 2;
  return total;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(redact(error.message)); process.exitCode = 2; });
}
