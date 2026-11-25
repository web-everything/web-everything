/**
 * PR tripwire: shared text rules inspect added lines (raw and decoded); structure
 * rules inspect whole new blobs, preserving bytes. Exact path+rule+sha256 exemptions
 * require a reviewed reason in the trusted scanner's allowlist.
 * Non-claims: secrets split across lines; token formats absent from secretText;
 * base64/UTF-16 wrapped tokens; keys inside archives or in untouched files;
 * secrets added then removed across commits (only the net PR diff is scanned).
 * Bootstrap non-claim: when the base has no scanner (first merge), the job runs
 * the PR copy. After this merges, the base copy runs, so a PR cannot swap the scanner.
 * The workflow covers pull_request, not push or merge_group. This script cannot
 * establish whether secret-scan is a required ruleset check; operators must verify.
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { keyStructureFinding as sharedKeyStructureFinding } from '../readiness/forge-key-structure.mjs';
import { secretText } from '../readiness/forge-exec-manifest.mjs';

export { secretText };
const structuralRules = ['private-key-structure', 'unscanned-oversize'];
const LIMIT = 32 * 1024 * 1024;
const FILE_LIMIT = 2 * 1024 * 1024;
const incomplete = () => new Error('secret-scan: incomplete input; review the full diff manually and rerun with valid input (500 files, 32 MiB per git output maximum)');

function keyStructureFinding(bytes) {
  const finding = sharedKeyStructureFinding(bytes);
  if (finding) return finding;
  const text = bytes.toString('utf8');
  if (!text.includes('`')) return null;
  // The shared parser accepts quoted literals. Give it an additional quoted
  // view of templates too, without executing source. Skip quoted strings/comments;
  // quotes, braces and comment markers inside a template remain string content.
  const quoteTemplate = token => {
    if (token[0] !== '`') return token;
    const body = token.slice(1, -1);
    // An interpolation is opaque: conservatively allow for an oct key type and
    // nonempty private material rather than evaluating arbitrary JavaScript.
    if (/(?:^|[^\\])(?:\\\\)*\$\{/.test(body)) return '"oct"';
    return '"' + body.replace(/\\[\s\S]|"/g, piece => piece === '"' ? '\\"' : piece) + '"';
  };
  const normalize = pieces => {
    const parts = [], displaced = [], stack = [{ kind: '', value: null }];
    let end = 0;
    for (const match of text.matchAll(pieces)) {
      const token = match[0], frame = stack.at(-1);
      parts.push(text.slice(end, match.index));
      end = match.index + token.length;
      if (token[0] === '`') {
        // A tag is an expression, not necessarily an identifier (String.raw,
        // computed access, calls, parentheses, etc.). Project its entire member
        // value to an opaque string; never execute it or infer its return value.
        const owner = stack.findLast(item => item.value !== null);
        if (owner && /\S/.test(text.slice(owner.value.source, match.index))) {
          // Keep nested objects from the displaced expression available to the
          // structure scan, even if a later template replaces their parent value.
          displaced.push(parts.splice(owner.value.part).join(''));
          parts.push('"oct"');
        } else parts.push(quoteTemplate(token));
      } else {
        parts.push(token);
        if ('{[('.includes(token)) {
          if (stack.length >= 64) return null;
          stack.push({ kind: token, value: null });
        } else if ('}])'.includes(token)) {
          if (stack.length > 1) stack.pop();
        } else if (frame.kind === '{' || frame.kind === '') {
          if (token === ':' && frame.value === null) frame.value = { part: parts.length, source: end };
          if (token === ',' || token === ';') frame.value = null;
        }
      }
    }
    parts.push(text.slice(end));
    return [parts.join(''), ...displaced].join('\n');
  };
  const normalized = normalize(/"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\/\/[^\r\n\u2028\u2029]*|\/\*[\s\S]*?(?:\*\/|$)|`(?:\\[\s\S]|[^`\\])*`|[{}[\]():,;]/g);
  if (normalized === null) return 'private-key-scan-budget-exhausted-use-local';
  const normalizedFinding = normalized === text ? null : sharedKeyStructureFinding(Buffer.from(normalized));
  if (normalizedFinding) return normalizedFinding;
  // Regex literals and prose can contain stray quotes. As in the shared parser's
  // independent object pass, also visit templates without global quote pairing.
  const independent = normalize(/`(?:\\[\s\S]|[^`\\])*`|[{}[\]():,;]/g);
  if (independent === null) return 'private-key-scan-budget-exhausted-use-local';
  return independent === text || independent === normalized ? null : sharedKeyStructureFinding(Buffer.from(independent));
}

function loadAllowlist(path) {
  // The shipped file is `{ "entries": [...] }`: a bare array would be refused by the Forge non-object-json rule.
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const entries = Array.isArray(parsed) ? parsed : parsed?.entries;
  if (!Array.isArray(entries) || entries.some(entry => !entry
    || typeof entry.path !== 'string' || !entry.path || /[*?\[\]\\\x00-\x1f]/.test(entry.path)
    || entry.path.startsWith('/') || entry.path.split('/').some(part => !part || part === '.' || part === '..')
    || (!secretText.some(([, rule]) => entry.rule === rule) && !structuralRules.includes(entry.rule))
    || typeof entry.sha256 !== 'string' || !/^[a-f\d]{64}$/i.test(entry.sha256)
    || typeof entry.reason !== 'string' || !entry.reason.trim()
    || Object.keys(entry).some(key => !['path', 'rule', 'sha256', 'reason'].includes(key)))) {
    throw new Error('secret-scan: invalid allowlist; require exact path, known rule, 64-hex sha256 and non-empty reason');
  }
  return entries;
}

function decodedLine(text) {
  return text.replace(/\\u\{([\da-f]{1,6})\}|\\u([\da-f]{4})|\\x([\da-f]{2})|%([0-7][\da-f])/gi,
    (whole, point, unicode, hex, percent) => {
      const code = parseInt(point ?? unicode ?? hex ?? percent, 16);
      return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    });
}

function safePath(path) {
  if (secretText.some(([pattern]) => {
    pattern.lastIndex = 0;
    return pattern.test(path) || pattern.test(decodedLine(path));
  }) || keyStructureFinding(Buffer.from(path))) return '[redacted-path]';
  return /[\x00-\x1f\x7f-\x9f]/.test(path) ? JSON.stringify(path) : path;
}

// --raw -z emits one metadata field and one literal path per record, with no
// quoting or line delimiters. --no-renames makes every record single-path.
export function parseRawDiff(bytes) {
  const files = [];
  let offset = 0;
  const field = () => {
    const end = bytes.indexOf(0, offset);
    if (end < 0) throw incomplete();
    const value = bytes.subarray(offset, end);
    offset = end + 1;
    return value;
  };
  while (offset < bytes.length) {
    const metadata = field().toString('ascii');
    const match = /^:(100644|100755|120000|160000|000000) (100644|100755|120000|160000|000000) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) ([ADMT])$/.exec(metadata);
    if (!match || !Buffer.from(metadata, 'ascii').equals(bytes.subarray(offset - metadata.length - 1, offset - 1))) throw incomplete();
    const pathBytes = field(), path = pathBytes.toString('utf8');
    if (!path || !Buffer.from(path).equals(pathBytes) || path.startsWith('/')
      || path.split('/').some(part => !part || part === '.' || part === '..')) throw incomplete();
    const [, oldMode, mode, oldSha, sha, status] = match;
    if (oldSha.length !== sha.length || (oldMode === '000000') !== /^0+$/.test(oldSha)
      || (mode === '000000') !== /^0+$/.test(sha)
      || (status === 'A') !== (oldMode === '000000')
      || (status === 'D') !== (mode === '000000')) throw incomplete();
    files.push({ path, mode, sha, status });
    if (files.length > 500) throw incomplete();
  }
  return files;
}

// Metadata is irrelevant: the raw record supplies the path. Once a hunk starts,
// every line must consume exactly its declared old/new counts.
export function addedLines(diff) {
  const result = [];
  let oldLeft = 0, newLeft = 0, line = 0, started = false, previousPrefix;
  for (let offset = 0; offset < diff.length;) {
    const newline = diff.indexOf(10, offset);
    if (newline < 0) throw incomplete();
    const text = diff.subarray(offset, newline).toString('utf8');
    offset = newline + 1;
    if (text === '\\ No newline at end of file') {
      if (!previousPrefix) throw incomplete();
      previousPrefix = undefined;
      continue;
    }
    previousPrefix = undefined;
    if (oldLeft || newLeft) {
      const prefix = text[0];
      if (!['+', '-', ' '].includes(prefix)) throw incomplete();
      if (prefix !== '+') oldLeft--;
      if (prefix !== '-') newLeft--;
      if (oldLeft < 0 || newLeft < 0) throw incomplete();
      if (prefix === '+') result.push({ line, text: text.slice(1) });
      previousPrefix = prefix;
      if (prefix !== '-') line++;
    } else if (text.startsWith('@@')) {
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(text);
      if (!hunk) throw incomplete();
      const oldLine = Number(hunk[1]);
      oldLeft = Number(hunk[2] ?? 1);
      line = Number(hunk[3]);
      newLeft = Number(hunk[4] ?? 1);
      if (![oldLine, oldLeft, line, newLeft].every(Number.isSafeInteger)
        || (!oldLeft && !newLeft) || (oldLeft && !oldLine) || (newLeft && !line)) throw incomplete();
      started = true;
    } else if (started || text.startsWith('+') && !text.startsWith('+++ ')) throw incomplete();
  }
  if (oldLeft || newLeft) throw incomplete();
  return result;
}

async function scan(options, allowlist) {
  const git = args => {
    try {
      return execFileSync('git', ['--literal-pathspecs', '-C', options.repo, ...args], {
        maxBuffer: LIMIT, timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch { throw incomplete(); }
  };
  const range = `${options.base}...${options.head}`;
  const flags = ['--no-ext-diff', '--no-textconv', '--no-color', '--no-renames'];
  const files = parseRawDiff(git(['diff', '--raw', '-z', '--no-abbrev', ...flags, range, '--']));
  const hits = [];
  for (const { path, mode, sha, status } of files) {
    if (status === 'D' || mode === '160000') continue;
    const size = git(['cat-file', '-s', sha]).toString('ascii');
    if (!/^(0|[1-9]\d*)\n$/.test(size) || !Number.isSafeInteger(Number(size))) throw incomplete();
    const oversize = Number(size) > FILE_LIMIT;
    const bytes = oversize ? null : git(['cat-file', 'blob', sha]);
    if (bytes && bytes.length !== Number(size)) throw incomplete();
    let digest;
    if (bytes) digest = createHash('sha256').update(bytes).digest('hex');
    else if (allowlist.some(entry => entry.path === path)) {
      // Hash oversized blobs as a stream; never buffer them or pass them to the structure scan.
      const child = spawn('git', ['--literal-pathspecs', '-C', options.repo, 'cat-file', 'blob', sha], {
        timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'],
      });
      const done = new Promise(resolve => {
        child.on('error', () => resolve(false));
        child.on('close', code => resolve(code === 0));
      });
      const hash = createHash('sha256');
      let length = 0;
      try {
        for await (const chunk of child.stdout) {
          length += chunk.length;
          if (length > Number(size)) { child.kill(); throw incomplete(); }
          hash.update(chunk);
        }
      } catch { child.kill(); throw incomplete(); }
      if (!await done || length !== Number(size)) throw incomplete();
      digest = hash.digest('hex');
    }
    const report = (rule, line = 0) => {
      if (rule === 'private-key-scan-budget-exhausted-use-local'
        || !allowlist.some(entry => entry.path === path && entry.rule === rule && entry.sha256.toLowerCase() === digest)) {
        hits.push(`${safePath(path)}:${line} ${rule}`);
      }
    };
    for (const [pattern, textRule] of secretText) {
      pattern.lastIndex = 0;
      if (pattern.test(path)) report(textRule);
    }
    if (oversize) report('unscanned-oversize');
    else {
      const rule = keyStructureFinding(bytes);
      if (rule) report(rule);
    }
    // --text also exposes binary additions: NUL bytes must not hide credentials.
    const diff = git(['diff', '-U0', '--text', ...flags, range, '--', path]);
    for (const { line, text } of addedLines(diff)) {
      const decoded = decodedLine(text);
      for (const [pattern, textRule] of secretText) {
        pattern.lastIndex = 0;
        if (pattern.test(text) || pattern.test(decoded)) report(textRule, line);
      }
    }
  }
  return hits;
}

export async function main(args = process.argv.slice(2)) {
  try {
    const options = { repo: '.', base: 'origin/main', head: 'HEAD', allowlist: new URL('./secret-scan-allowlist.json', import.meta.url) };
    for (let i = 0; i < args.length; i++) {
      if (['--base', '--head', '--allowlist', '--repo'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('-')) {
        options[args[i].slice(2)] = args[++i];
      } else throw new Error('secret-scan: invalid arguments');
    }
    const hits = await scan(options, loadAllowlist(options.allowlist));
    if (hits.length) process.stdout.write(hits.join('\n') + '\n');
    if (hits.some(hit => hit.endsWith(' unscanned-oversize'))) {
      process.stderr.write('secret-scan: review oversize files manually; exempt only with an exact path+rule+sha256 allowlist entry and a reason\n');
    }
    return hits.length ? 1 : 0;
  } catch (error) {
    // JSON, filesystem and subprocess errors may contain source text: never echo them.
    process.stderr.write((error.message.startsWith('secret-scan:') ? error.message : 'secret-scan: cannot read configuration or diff; review inputs and rerun') + '\n');
    return 1;
  }
}

// Canonicalize both paths so file and parent-directory symlinks still run the CLI.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await main();
