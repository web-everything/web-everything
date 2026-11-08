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
import { canonicalCommand, commandSubstitutionBodies, envSplitString, heavyRunHeads, heredocFeedsShell, heredocScan, parseSegments, shellCString, shellTokens, stripShellControl, ungatedHeavyRunKind } from '../guard-bash.mjs';

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
// A program or keyword word may be quoted whole or in part (`'docker' login`, `"/usr/bin/gh" secret set`,
// `my"sql"`, `htpass'wd'`, `npm 'config' set`): the shell reads the same word, so each name is matched through
// `quotedWord`, which allows up to 3 quote or escape characters between its letters (review #6461 r6).
const QUOTES = String.raw`["'\\]{0,3}`;
const quotedWord = (...names) => `(?:${names.map(name => [...name].map(c => c.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')).join(QUOTES)).join('|')})`;
// The space between two words of one program (`docker login`); an escaped space would join them into one word.
const NEXT_WORD = String.raw`["']{0,3}\s+${QUOTES}`;
// A program name starts its word: no word character, `.` or `-` before it, even behind quotes (`x'htpasswd'`,
// `my-'mysql'` are other words). It ends its word, past any closing quotes, so the match ends where the operands start.
const WORD_START = String.raw`(?<![\w.-]${QUOTES})`;
const WORD_END = String.raw`["']{0,3}(?=\s|$)`;
const GH_SECRET_SET = `${quotedWord('gh')}${NEXT_WORD}${quotedWord('secret')}${NEXT_WORD}${quotedWord('set')}`;
const SECRET_SHORT_OPTIONS = [
  [`(?:${quotedWord('docker', 'podman', 'nerdctl', 'buildah', 'skopeo')}|${quotedWord('helm')}${NEXT_WORD}${quotedWord('registry')})${NEXT_WORD}${quotedWord('login')}`
    + `|${quotedWord('sshpass')}|${quotedWord('mysql', 'mariadb')}(?:${QUOTES}\\w)*`
    + `|${quotedWord('mongo')}(?:${QUOTES}${quotedWord('sh', 'dump', 'restore', 'import', 'export')})?|${quotedWord('7z')}(?:${QUOTES}[ar])?`, 'p'],
  [quotedWord('redis-cli'), 'a'],
  [`(?:${quotedWord('un')}${QUOTES})?${quotedWord('zip')}|${quotedWord('zipcloak')}`, 'P'],
  [quotedWord('ssh-keygen'), 'NP'],
  [GH_SECRET_SET, 'b'],
  [quotedWord('smbclient'), 'U'],
  [quotedWord('curl'), 'b'],
].map(([source, letters]) => [new RegExp(source), letters]);
// A `/` may precede the program: a path-qualified program (`/usr/bin/mysql -pv`, `./mysql -pv`) runs the same one
// (review #6461 r5), as htpasswd's own match already allows.
// The name ends its shell word (a space, a closing quote or the end), so a folder that shares a program's name
// (`-v /data/mysql:/var/lib/mysql -p 3306:3306`) is not read as that program.
const SECRET_SHORT_PROGRAMS = new RegExp(`${WORD_START}(?:${SECRET_SHORT_OPTIONS.map(([re]) => re.source).join('|')})${WORD_END}`, 'g');
// The program whose `--body` long option carries a secret (`gh secret set X --body v`, `/usr/bin/gh secret set …`,
// `'gh' secret set …`, `g'h' secret set …`); its segment end is found quote-aware by redactPositionalSecrets.
const SECRET_LONG_OPTIONS = new RegExp(`${WORD_START}${GH_SECRET_SET}${WORD_END}`, 'g');
// htpasswd, path-qualified (`/usr/bin/htpasswd`) or quoted (`'/usr/bin/htpasswd'`, `"htpasswd"`, `htpass'wd'`).
const HTPASSWD_PROGRAM = new RegExp(`${WORD_START}${quotedWord('htpasswd')}${WORD_END}`, 'g');
// `config set <key> <value>` style commands (`npm config set //r/:_authToken v`, `yarn config set npmAuthToken v`,
// `aws configure set aws_secret_access_key v`, `git config --global github.token v`): group 1 is the key. The
// keywords and options may be quoted (`npm 'config' set`, `aws configure 'set'`, `'--location=user'`).
const CONFIG_KEY = new RegExp(String.raw`(?<![\w-]${QUOTES})${quotedWord('config')}(?:${QUOTES}${quotedWord('ure')})?${NEXT_WORD}`
  + String.raw`(?:${quotedWord('set', 'add')}${NEXT_WORD})?(?:-[\w-]+(?:=\S*?)?["']{0,3}\s+["']{0,3})*([^\s=-][^\s=]*)()(?=\s)`, 'g');
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

/** End of the shell segment that starts at `from`: the first `;`, `|`, `&` or newline OUTSIDE a word, so a
 *  quoted or nested separator (`'p;w'`, `$(a; b)`) stays inside its word. One linear pass. */
function shellSegmentEnd(text, from) {
  let i = from;
  while (i < text.length) {
    const c = text[i];
    if (/[;|&\n\r\x85]|\p{Zl}|\p{Zp}/u.test(c)) return i;
    if (/\s/.test(c)) { i += 1; continue; }
    i = Math.max(shellWordEnd(text, i), i + 1); // a lone `(`, `)`, `<`, `>` is one character
  }
  return text.length;
}

/** The [start, end) spans of the shell words in text[from, to), stopping at a redirection (its target is not an
 *  operand of the command), at an unquoted `(`/`)` (the command ends inside `$( … )` or a subshell) and at a
 *  `#` comment. */
function shellWordSpans(text, from, to) {
  const spans = [];
  for (let i = from; i < to;) {
    if (/\s/.test(text[i])) { i += 1; continue; }
    if (/[<>()#]/.test(text[i]) || /^\d+[<>]/.test(text.slice(i, i + 12))) break;
    const end = Math.min(Math.max(shellWordEnd(text, i), i + 1), to);
    spans.push([i, end]);
    i = end;
  }
  return spans;
}

/** Replace, for each match of the global `re`, the match plus the whole shell word starting where it ends with
 *  `replacement(match, word)` (a string, or null to keep it). Quotes and concatenation stay in that one word. */
function redactMatchedWords(text, re, replacement) {
  let out = '', last = 0;
  for (let m; (m = re.exec(text));) {
    const end = Math.max(shellWordEnd(text, re.lastIndex), re.lastIndex);
    const value = replacement(m, text.slice(re.lastIndex, end));
    // A kept word is skipped whole: any match inside it lies in a word the replacement already declined (for
    // `-u`, a word with no `:` holds no `user:pass`), and rescanning it would be quadratic on unterminated text.
    if (value === null) { re.lastIndex = Math.max(end, re.lastIndex + (m[0].length ? 0 : 1)); continue; }
    out += text.slice(last, m.index) + value;
    last = re.lastIndex = end;
  }
  return out + text.slice(last);
}

/** The userinfo of `scheme://user:pass@host` URLs, including quoted or concatenated parts (`u:"p w"@h`). */
function redactUrlUserinfo(text) {
  const scheme = /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]{0,31}:\/\//gi;
  let out = '', last = 0;
  for (let m; (m = scheme.exec(text));) {
    let at = -1, quote = null, i = scheme.lastIndex;
    for (; i < text.length; i += 1) {
      const c = text[i];
      if (quote) { if (c === quote) quote = null; else if (c === '@') at = i; continue; }
      // A quote followed by a word end closes the quoted URL (`"https://x.com" && …`); one followed by more
      // URL text opens a quoted part of the userinfo (`u:"p w"@h`).
      if (c === '"' || c === "'") { if (/^(?:[\s;|&<>()]|$)/.test(text[i + 1] ?? '')) break; quote = c; continue; }
      if (/[\s;|&<>()/?#]/.test(c)) break;
      if (c === '@') at = i;
    }
    if (at < 0) { scheme.lastIndex = Math.max(i, scheme.lastIndex); continue; }
    out += text.slice(last, scheme.lastIndex) + '[REDACTED]';
    last = at;
    scheme.lastIndex = Math.max(i, at + 1);
  }
  return out + text.slice(last);
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
    const end = shellSegmentEnd(text, from); // a quoted `;` (`-p'a;b'`) stays inside the value
    const segment = text.slice(from, end);
    // The program is read without its quotes and escapes (`my"sql"'` is mysql), as each name pattern allows.
    const program = m[0].replace(/["'\\]/g, '');
    const letters = SECRET_SHORT_OPTIONS.filter(([re]) => new RegExp(`^(?:${re.source})$`).test(program)).map(([, l]) => l).join('');
    // The value is glued on when a non-space follows the letter (`-pv`, `-p=v`).
    out += text.slice(last, from) + redactOptionValues(segment, new RegExp(`(?<!\\S)-([${letters}])(=?)`, 'g'), () => true,
      { attached: (o, at) => !/^\s?$/.test(segment[at] ?? ''), replacement: o => `-${o[1]} [REDACTED]` });
    last = SECRET_SHORT_PROGRAMS.lastIndex = end;
  }
  return out + text.slice(last);
}

/** `htpasswd -b[…] file user password` (or `-nb user password`, `-B -b …`): with `b` in any option cluster, the
 *  password is the last operand. Words are whole shell words, so a quoted or concatenated password
 *  (`'first second'`, `"a b"'c d'`, `'p;w'`) is redacted entirely; a redirection after it is not an operand. */
function redactHtpasswd(text) {
  const program = HTPASSWD_PROGRAM; // path-qualified (`/usr/bin/htpasswd`) or quoted (`'/usr/bin/htpasswd'`) too
  program.lastIndex = 0;
  let out = '', last = 0;
  for (let m; (m = program.exec(text));) {
    const from = program.lastIndex, end = shellSegmentEnd(text, from);
    const spans = shellWordSpans(text, from, end);
    let batch = false, operands = 0;
    for (; operands < spans.length; operands += 1) {
      const word = text.slice(...spans[operands]).replace(/["']/g, '');
      if (word === '--') { operands += 1; break; }
      if (!/^-./.test(word)) break;
      if (word.includes('b')) batch = true;
    }
    const password = spans.at(-1);
    if (batch && password && spans.length > operands) {
      out += text.slice(last, password[0]) + '[REDACTED]';
      last = password[1];
    }
    program.lastIndex = Math.max(end, from);
  }
  return out + text.slice(last);
}

/** Values of `config set <credential key> <value>`, of `gh secret set X --body v`, and `pass:v` (openssl). */
function redactPositionalSecrets(text) {
  const configured = redactOptionValues(text, CONFIG_KEY, configKeyIsCredential,
    { replacement: m => m[0] + ' [REDACTED]' });
  let body = '', last = 0;
  // `gh secret set X … --body v` up to the end of its segment, found quote-aware (`--repo 'a;b' --body v`).
  for (let m; (m = SECRET_LONG_OPTIONS.exec(configured));) {
    const from = SECRET_LONG_OPTIONS.lastIndex, end = shellSegmentEnd(configured, from);
    body += configured.slice(last, from) + redactOptionValues(configured.slice(from, end), /(?<!\S)(--body)(?![\w-])(=?)/g,
      () => true, { replacement: o => '--body [REDACTED]' });
    last = SECRET_LONG_OPTIONS.lastIndex = Math.max(end, from);
  }
  body += configured.slice(last);
  // `pass:v` (openssl) as one whole shell word, quoted or concatenated (`pass:'a b'c`, `"pass:a b"`).
  // The word starts at the match (at its opening quote when there is one), so it is bounded as one shell word.
  const passWord = /(?<![\w-])["']?pass:(?=[^\s"'])/g; // `pass: all tests green` is prose, not a password
  let out = '';
  last = 0;
  for (let m; (m = passWord.exec(body));) {
    out += body.slice(last, m.index) + 'pass:[REDACTED]';
    last = passWord.lastIndex = Math.max(shellWordEnd(body, m.index), passWord.lastIndex);
  }
  return out + body.slice(last);
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
  // htpasswd's password is its LAST operand, so it is found before line breaks become spaces (a break ends the
  // command: `htpasswd -nb u pw⏎echo done` must redact `pw`, not `done`), and before the length cut.
  let clean = redactHtpasswd(String(text)).replace(/[\x00-\x1f\x7f\x85]|\p{Zl}|\p{Zp}/gu, ' ');
  // The cut mark is added after redaction: appended first, it would become the "last word" a rule such as
  // htpasswd's redacts instead of a cut password (an unterminated quote then runs to the end and is redacted whole).
  const cut = clean.length > REDACT_MAX_CHARS;
  if (cut) clean = clean.slice(0, REDACT_MAX_CHARS);
  return redactLineRules(clean) + (cut ? ' …[truncated]' : '');
}

function redactLineRules(clean) {
  // Value-carrying forms run before the generic name rule below, which would otherwise redact only the name.
  // Every rule that starts with a repeated class is anchored to a word start, so none of them is quadratic.
  // URL userinfo and curl/git-style `user:password` pairs are bounded as whole shell words (quoted parts included).
  const headers = redactUrlUserinfo(clean)
    // HTTP-style credential headers and `token: v`, with or without an auth scheme word.
    // A value opening with an escaped quote (`password: \"v\"`) is a quoted member, left to redactJsonMembers.
    .replace(/(?<![\w-])([\w-]+)\s*:\s*(?:(?:Bearer|Basic|Digest|Negotiate|token)\s+)?[^\s"';\\][^\s"';]*/gi,
      (all, name) => (CREDENTIAL_HEADER.test(name) ? '[REDACTED]' : all));
  // `--user`/`--proxy-user` and a `-u`/`-U` in any short-option cluster (`-su user:pw`, `-u= user:pw`).
  const pairs = redactMatchedWords(headers, /(?<!\S)(?:--(?:proxy-)?user(?:=|\s+)|-[A-Za-z]*[uU]=?\s*)/g,
    (m, word) => (word.replace(/["']/g, '').includes(':') ? '[REDACTED]' : null));
  return redactAssignments(redactJsonMembers(redactPositionalSecrets(redactShortPasswords(redactCredentialOptions(pairs)))))
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
      if (heredocFeedsShell(doc.head)) out.push(...classifyCommand(doc.body, depth + 1, false));
    }
  }
  for (const segment of parseSegments(heredocs.unterminated ? String(cmd) : heredocs.text).segments) {
    // Compound-command syntax (brace groups, case arms, function heads) is not the program that runs.
    let head = canonicalCommand(stripShellControl(segment)), queued = false;
    // Node options may precede the wrapper script (`node --no-warnings …/heavy-admission.mjs run -- …`).
    const admitted = /^node\s+(?:-[^\s-]\S*\s+|--[^\s=-]\S*\s+)*\S*heavy-admission\.mjs\s+run\b[\s\S]*?\s--\s+([\s\S]+)$/.exec(head);
    if (admitted) { queued = true; head = canonicalCommand(admitted[1]); }
    // `env -S '<cmd>'` runs its string as the command (the outer shell already expanded any substitution in it).
    const split = envSplitString(admitted ? admitted[1] : segment);
    if (split !== null) {
      for (const hit of classifyCommand(split, depth + 1, false)) out.push({ ...hit, queued: queued || hit.queued });
      continue;
    }
    // `sh -c "…"` as the inner shell receives it. Substitutions the outer shell already ran (an unquoted or
    // double-quoted word) were counted by the outer extraction above, so only a single-quoted body re-extracts.
    const shellC = shellCString(head);
    if (shellC) {
      for (const hit of classifyCommand(shellC.text, depth + 1, shellC.innerSubstitutions)) out.push({ ...hit, queued: queued || hit.queued });
      continue;
    }
    // The command a launcher runs (`nohup …`, `setsid -f …`, `eval '…'`), unwrapped by the Bash guard's shared walker,
    // goes through this whole classifier again: its own segments, `sh -c` bodies, `env -S`, the admission wrapper and
    // heredocs, not only the head patterns (review #6461 r5). The depth bound reports a too-deep nest unparsed.
    // It is unwrapped BEFORE the head is classified: the head classifier reads through the launcher too, so a
    // launched string that starts with a classified run (`eval 'npx vitest run a; npx playwright test b'`) would be
    // reported by its first command only (review #6461 r6).
    const launched = heavyRunHeads(head)?.[1]?.raw;
    if (launched) {
      const hits = classifyCommand(launched, depth + 1, false);
      for (const hit of hits) out.push({ ...hit, queued: queued || hit.queued });
      if (hits.length) continue;
    }
    // A launcher whose string classified nothing still gets the head reading, and past the guard's unwrap bound
    // (heavyRunHeads null) the head classifier fails closed to a test run.
    const category = headCategory(head);
    if (category) out.push({ category, queued: queued || QUEUED_SCRIPT.test(head), command: redact(segment.trim()) });
  }
  return out;
}

const QUEUED_SCRIPT = /^(?:npm|pnpm|yarn|bun)\s+run\s+(?:test:unit|check:standards)(?:\s|$)/;

/** The audit category one canonical command head starts, or undefined. */
function headCategory(head) {
  // A `node` head is classified only by the Bash guard's executable-position parser below: `--test` or a vitest /
  // check-standards path after the script operand is that script's own argument (`node light.mjs --test`).
  if (/^(?:vitest(?:@\S*)?\b|(?:pnpm|yarn|bun)\s+(?:exec\s+)?vitest\b)/.test(head)
    && !/\s(?:--version|-v|--help|-h)(?:\s|$)/.test(head)) return 'vitest';
  if (/^(?:(?:pnpm|yarn|bun)\s+(?:exec\s+)?|npm\s+(?:exec|x)\s+(?:--\s+)?)?playwright(?:@\S*)?\s+test\b/.test(head)) return 'playwright';
  if (/^(?:npm|pnpm)\s+run\s+check:standards(?:\s|$)/.test(head)) return 'check:standards';
  if (/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test\b|t\b|tst\b|check:(?:visual|render)\b)/.test(head)) return 'npm test/check';
  // The Bash guard's classifier catches spellings the patterns above miss (`npm --prefix . test`, `npm -s test`).
  const kind = HEAVY_KIND_CATEGORY[ungatedHeavyRunKind(head)];
  if (kind) return kind;
  if (/^(?:npm|pnpm|yarn|bun)\s+(?:install|i|ci)\b/.test(head)) return 'install/ci';
  if (/^git\s+(?:-C\s+\S+\s+)?(?:fetch|clone|worktree\s+add|gc|repack)\b/.test(head)) return 'git fetch/clone/wt/gc';
  if (repoWideSearch(shellTokens(head).filter(word => !word.op).map(word => word.text))) return 'repo-wide find/grep';
  return undefined;
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

/** A transcript source label safe for a terminal table: control characters and line separators become `?`. */
const sourceLabel = value => stripVTControlCharacters(String(value)).replace(/[\x00-\x1f\x7f\x85]|\p{Zl}|\p{Zp}/gu, '?');

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
      // The source is the transcript's own path (built by the caller), not command text: credential redaction would
      // turn every uuid-named session file into the same `[REDACTED]` key. Only terminal control text is removed.
      const row = { ...hit, source: sourceLabel(source === 'unknown' ? kind : source), timestamp: record.timestamp };
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
