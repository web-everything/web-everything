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
import { canonicalCommand, commandSubstitutionBodies, heredocScan, parseSegments, shellCString, shellTokens, ungatedHeavyRunKind } from '../guard-bash.mjs';

const etDay = value => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(value));

// Option names that carry a credential (`--token`, `--api-key`, `--client-secret`, `--password`, `--pass`,
// `--pat`/`--gitlab-pat` personal access tokens, …). `pat` is a whole name part, so `--path`/`--compat` stay data.
// Session keys (`bw unlock --session v`), signatures, one-time passwords and PINs carry a credential too.
const CREDENTIAL_OPTION = /token|secret|passw(?:or)?d|passphrase|^pass$|^pw$|^pwd$|jwt|(?:^|[-_])pat$|credential|auth(?!or)|cookie|key(?:[-_]?id)?$|session(?:[-_]?id)?$|^sig(?:nature)?$|^otp$|^pin$/i;
const EMPTY_WORD = /^(?:""|'')+$/;
// Header names (`Authorization:`, `PRIVATE-TOKEN:`, `x-api-key:`, `X-Auth:`, `token:`) and assignment names
// (`API_KEY=`, `MY_PASS=`, `GITLAB_AUTH=`, `MYSQL_PWD=`) whose value is a credential. Tested on one captured name.
const CREDENTIAL_HEADER = /authorization|token|secret|password|cookie|jwt|(?:^|[-_])auth$|(?:api|access|private|secret|auth)[-_]?key/i;
const CREDENTIAL_ASSIGNMENT = /key|token|secret|passw(?:or)?d|passphrase|pass(?:[_-]|$)|(?:^|[_-])pwd$|jwt|(?:^|[_-])pat(?:[_-]|$)|credential|auth(?!or)|cookie/i;
// Programs whose own short options carry a password or secret, attached (`mysql -pv`, `7z a -pv`) or separate
// (`docker login -p v`, `redis-cli -a v`, `zip -P v f`, `ssh-keygen -N v`, `gh secret set X -b v`, `curl -b c=v`).
const SECRET_SHORT_OPTIONS = [
  [/(?:(?:docker|podman|nerdctl|buildah|skopeo|helm\s+registry)\s+login|sshpass|mysql\w*|mariadb\w*|mongo(?:sh|dump|restore|import|export)?|7z[ar]?)/, 'p'],
  [/redis-cli/, 'a'],
  [/(?:un)?zip|zipcloak/, 'P'],
  [/ssh-keygen/, 'NP'],
  [/gh\s+secret\s+set/, 'b'],
  [/smbclient/, 'U'],
  [/curl/, 'b'],
];
const SECRET_SHORT_PROGRAMS = new RegExp(String.raw`(?<![\w./-])(?:${SECRET_SHORT_OPTIONS.map(([re]) => re.source).join('|')})(?![\w-])`, 'g');
// Long options that carry a secret only for one program (`gh secret set X --body v`).
const SECRET_LONG_OPTIONS = /(?<![\w./-])gh\s+secret\s+set\b[^;|&\n]*?\s(--body)(?![\w-])(=?)/g;
// `config set <key> <value>` style commands (`npm config set //r/:_authToken v`, `yarn config set npmAuthToken v`,
// `aws configure set aws_secret_access_key v`, `git config --global github.token v`): group 1 is the key.
const CONFIG_KEY = /(?<![\w-])config(?:ure)?\s+(?:(?:set|add)\s+)?(?:--?[\w-]+(?:=\S*)?\s+)*([^\s=-][^\s=]*)()(?=\s)/g;
const configKeyIsCredential = key => CREDENTIAL_ASSIGNMENT.test(key.split(/[/:.]/).filter(Boolean).pop() || '');
// JSON / object-literal members whose name is a credential (`{"password":"v"}`, `{\"api_key\": \"v\"}`, `pin: 1234`).
// The name may be unquoted (`{password: "v"}`, `{ pin: 1234 }`); a name start is anchored, so it stays linear.
const JSON_MEMBER = /(?<![\w.$-])(\\?["']|)([\w.$-]+)\1\s*:\s*(\\?"(?:[^"\\]|\\.)*?\\?"|\\?'[^']*?\\?'|[^\s,}'"]+)/g;
// Commands longer than this are cut before redaction so every rule stays linear-time; the cut is marked.
export const REDACT_MAX_CHARS = 16384;

/** End index of the one shell word that starts at `start`: concatenated quoted runs, `$'…'`, `$( … )` /
 *  `<( … )` / `${ … }` at any nesting depth (with quotes inside), backticks and escapes. One linear pass. An
 *  unterminated construct runs to the end of the text, so a value that cannot be bounded is redacted whole. */
function shellWordEnd(text, start) {
  const stack = [];
  let i = start;
  while (i < text.length) {
    const c = text[i], top = stack.at(-1);
    if (top === "'") { i += 1; if (c === "'") stack.pop(); continue; }
    if (c === '\\') { i += 2; continue; }
    if (top === "$'") { i += 1; if (c === "'") stack.pop(); continue; }
    if (top === '`') { i += 1; if (c === '`') stack.pop(); continue; }
    if ((c === '$' || c === '<' || c === '>') && text[i + 1] === '(') { stack.push(')'); i += 2; continue; }
    if (c === '$' && text[i + 1] === '{') { stack.push('}'); i += 2; continue; }
    if (c === '`') { stack.push('`'); i += 1; continue; }
    if (top === '"') { i += 1; if (c === '"') stack.pop(); continue; }
    if (c === '"') { stack.push('"'); i += 1; continue; }
    if (c === "'") { stack.push(text[i - 1] === '$' ? "$'" : "'"); i += 1; continue; }
    if (top === ')' || top === '}') {
      if (c === top) stack.pop();
      else if (c === '(' && top === ')') stack.push(')');
      i += 1;
      continue;
    }
    if (/[\s;|&()<>]/.test(c)) break;
    i += 1;
  }
  return Math.min(i, text.length);
}

/** Redact `--name v` / `--name=v` style values: `named` is a global regex whose match ends where the value
 *  starts (group 1 the option name; group 2 defined and non-false-y per `attached` when the value is glued on);
 *  `isCredential` tests the name. An empty quoted value (`--token "" v`) takes the next word too. */
function redactOptionValues(text, named, isCredential, { attached = m => !!m[2], replacement = '[REDACTED]' } = {}) {
  let out = '', last = 0;
  for (let m; (m = named.exec(text));) {
    if (!isCredential(m[1].replace(/["']/g, ''))) continue;
    let end = named.lastIndex;
    for (let words = 0; words < 2; words += 1) {
      let at = end;
      if (!attached(m, end) || words) { while (/\s/.test(text[at] || '')) at += 1; if (at === end) break; }
      const wordEnd = shellWordEnd(text, at);
      if (wordEnd === at) break;
      end = wordEnd;
      if (!EMPTY_WORD.test(text.slice(at, wordEnd))) break;
    }
    out += text.slice(last, m.index) + (typeof replacement === 'function' ? replacement(m) : replacement);
    last = named.lastIndex = Math.max(end, named.lastIndex);
  }
  return out + text.slice(last);
}

/** Redact a credential option together with its value, attached (`--token=x`) or separate (`--token x`).
 *  Option names are compared with shell quotes removed (`--"token"`, `"--token"`, `--to''ken`). */
function redactCredentialOptions(text) {
  return redactOptionValues(text, /(?<![^\s"'])["']?-{1,2}([^\s=]+)(=?)/g, name => CREDENTIAL_OPTION.test(name));
}

/** Redact `NAME=value` credential assignments, anywhere a name starts: env prefixes (`GH_TOKEN="a b"x cmd`),
 *  query strings (`?page=1&private_token=v`) and nested option values (`--env=GITHUB_TOKEN=v`). A harmless name
 *  is skipped past its `=` only, so the name after it is still examined; the value is one whole shell word. */
function redactAssignments(text) {
  return redactOptionValues(text, /(?<![\w-])([\w-]+)\s*(=)\s*/g, name => CREDENTIAL_ASSIGNMENT.test(name));
}

/** Secret short-option values of the programs in SECRET_SHORT_OPTIONS, attached (`-pv`) or separate (`-p v`),
 *  up to the end of that program's segment; `htpasswd -b f user v` takes its password as the last operand. */
function redactShortPasswords(text) {
  let out = '', last = 0;
  for (let m; (m = SECRET_SHORT_PROGRAMS.exec(text));) {
    const from = SECRET_SHORT_PROGRAMS.lastIndex;
    const segmentEnd = text.slice(from).search(/[;|&\n]/);
    const end = segmentEnd < 0 ? text.length : from + segmentEnd;
    const segment = text.slice(from, end);
    const letters = SECRET_SHORT_OPTIONS.filter(([re]) => new RegExp(`^(?:${re.source})$`).test(m[0])).map(([, l]) => l).join('');
    // The value is glued on when a non-space follows the letter (`-pv`, `-p=v`).
    out += text.slice(last, from) + redactOptionValues(segment, new RegExp(`(?<!\\S)-([${letters}])(=?)`, 'g'), () => true,
      { attached: (o, at) => !/^\s?$/.test(segment[at] ?? ''), replacement: o => `-${o[1]} [REDACTED]` });
    last = SECRET_SHORT_PROGRAMS.lastIndex = end;
  }
  return redactHtpasswd(out + text.slice(last));
}

/** `htpasswd -b[…] file user password` (or `-nb user password`): the password is the segment's last word. */
function redactHtpasswd(text) {
  // `[^\sb]*b` has one way to match a flag cluster, so a long `-bbbb…` cannot backtrack quadratically.
  return text.replace(/(?<![\w./-])htpasswd\s+-[^\sb]*b\S*\s[^;|&\n]*/g, segment => {
    const lastWord = segment.trimEnd().search(/\S+$/);
    return lastWord < 0 ? segment : segment.slice(0, lastWord) + '[REDACTED]';
  });
}

/** Values of `config set <credential key> <value>`, of `gh secret set X --body v`, and `pass:v` (openssl). */
function redactPositionalSecrets(text) {
  const configured = redactOptionValues(text, CONFIG_KEY, configKeyIsCredential,
    { replacement: m => m[0] + ' [REDACTED]' });
  return redactOptionValues(configured, SECRET_LONG_OPTIONS, () => true, {
    replacement: m => m[0].slice(0, m[0].length - m[2].length) + ' [REDACTED]',
  }).replace(/(?<![\w-])pass:(?:"[^"]*"|'[^']*'|[^\s"';|&]+)/g, 'pass:[REDACTED]');
}

/** Credential members of JSON or object-literal text (`{"password":"v"}`), quoted or escaped. */
function redactJsonMembers(text) {
  return text.replace(JSON_MEMBER, (all, quote, name) => (CREDENTIAL_ASSIGNMENT.test(name) || /^pin$|^otp$/i.test(name)
    ? `${quote}${name}${quote}:[REDACTED]` : all));
}

// An unescaped `\`+newline (a line continuation); an escaped backslash before a newline (`x\\⏎`) is none.
const CONTINUATION = /(?<!\\)((?:\\\\)*)\\\r?\n/g;
// Past this many words redacted only in the spaced reading, the whole command is withheld (fail closed).
const CONTINUATION_MAX_WORDS = 256;

export function redact(text) {
  const raw = stripVTControlCharacters(String(text));
  CONTINUATION.lastIndex = 0;
  if (!CONTINUATION.test(raw)) return redactLine(raw);
  // Bash deletes a continuation, joining the words around it (`--tok\⏎en v` is `--token v`). A malformed or
  // multi-line command can also be read with the continuation as a word break (`--pass\⏎v`, `line\⏎--password
  // v`). Both readings are redacted: the joined one is the output, and every word the spaced reading redacted
  // is redacted from it too. Deleting the backslash means it can never pose as an escaped-space value.
  const joined = redactLine(raw.replace(CONTINUATION, '$1'));
  const spacedText = raw.replace(CONTINUATION, '$1 ');
  const kept = new Set(redactLine(spacedText).split(/\s+/));
  const removed = [...new Set(spacedText.slice(0, REDACT_MAX_CHARS).split(/(?:[\s\x00-\x1f\x7f\x85]|\p{Zl}|\p{Zp})+/u))]
    .filter(word => word.length >= 3 && !kept.has(word)); // a 1–2 character word would mangle the whole text
  if (removed.length > CONTINUATION_MAX_WORDS) return '[REDACTED: command with line continuations]';
  return removed.sort((a, b) => b.length - a.length).reduce((out, word) => out.split(word).join('[REDACTED]'), joined);
}

function redactLine(text) {
  let clean = String(text).replace(/[\x00-\x1f\x7f\x85]|\p{Zl}|\p{Zp}/gu, ' ');
  if (clean.length > REDACT_MAX_CHARS) clean = clean.slice(0, REDACT_MAX_CHARS) + ' …[truncated]';
  // Value-carrying forms run before the generic name rule below, which would otherwise redact only the name.
  // Every rule that starts with a repeated class is anchored to a word start, so none of them is quadratic.
  return redactAssignments(redactJsonMembers(redactPositionalSecrets(redactShortPasswords(redactCredentialOptions(clean
    .replace(/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@"']+@/gi, '$1[REDACTED]@')
    // HTTP-style credential headers and `token: v`, with or without an auth scheme word.
    // A value opening with an escaped quote (`password: \"v\"`) is a quoted member, left to redactJsonMembers.
    .replace(/(?<![\w-])([\w-]+)\s*:\s*(?:(?:Bearer|Basic|Digest|Negotiate|token)\s+)?[^\s"';\\][^\s"';]*/gi,
      (all, name) => (CREDENTIAL_HEADER.test(name) ? '[REDACTED]' : all))
    // curl/git-style `user:password` pairs.
    .replace(/(?<!\S)(?:--user(?:=|\s+)|-u\s*)[^\s:]*:\S+/g, '[REDACTED]'))))))
    .replace(/\b(?:gh[pousr]_|github_pat_|glpat-|sk-|xox[a-z]-)[A-Za-z0-9_-]+|\bnpm_[A-Za-z0-9]{20,}|\bAKIA[0-9A-Z]{16}\b/gi, '[REDACTED]')
    .replace(/\bBearer\s+(?:"[^"]*"|'[^']*'|[^\s"'`;,]+)/gi, '[REDACTED]')
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
  // Openers bound the body count from above; with none there is nothing to extract, so a long plain command
  // (a big heredoc write, a long commit message) is classified normally instead of reported unparsed.
  const openers = (text.match(/\$\(|`/g) || []).length;
  if (!openers) return [];
  if (text.length > SUBSTITUTION_MAX_CHARS) return null;
  // Checking the opener count first keeps a deep nest off the quadratic extractor.
  if (openers > SUBSTITUTION_MAX_BODIES * 4) return null;
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
  // Heredoc bodies are data for `cat <<EOF`, but a shell reading its script from one runs them (`bash <<EOF`).
  // An unterminated scan keeps the raw text (fail closed). Substitutions in a body were already extracted above.
  const heredocs = heredocScan(String(cmd));
  if (!heredocs.unterminated) {
    for (const doc of heredocs.heredocs) {
      // The heredoc feeds the head's last segment (`cd x && bash <<EOF`, `set -e; bash -s <<'EOF'`).
      const feeds = canonicalCommand(parseSegments(doc.head).segments.at(-1) ?? doc.head);
      if (/^(?:\S*\/)?(?:ba|da|z|k)?sh\b/.test(feeds)) out.push(...classifyCommand(doc.body, depth + 1, false));
    }
  }
  for (const segment of parseSegments(heredocs.unterminated ? String(cmd) : heredocs.text).segments) {
    let head = canonicalCommand(segment), queued = false;
    const admitted = /^node\s+\S*heavy-admission\.mjs\s+run\b[\s\S]*?\s--\s+([\s\S]+)$/.exec(head);
    if (admitted) { queued = true; head = canonicalCommand(admitted[1]); }
    const words = shellTokens(head).filter(word => !word.op).map(word => word.text);
    // `sh -c "…"` as the inner shell receives it. Substitutions the outer shell already ran (an unquoted or
    // double-quoted word) were counted by the outer extraction above, so only a single-quoted body re-extracts.
    const shellC = shellCString(head);
    if (shellC) {
      for (const hit of classifyCommand(shellC.text, depth + 1, shellC.innerSubstitutions)) out.push({ ...hit, queued: queued || hit.queued });
      continue;
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
