// Allowlisted files are exempt per path+rule, reviewed by a human via the base-branch allowlist.
// Text rules match line by line (raw and decoded): credentials split across multiple lines may escape
// text matching. The shared Forge structural detector also scans each file's concatenated added lines.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keyStructureFinding } from '../readiness/forge-key-structure.mjs';
import { secretText } from '../readiness/forge-exec-manifest.mjs';

// Re-export the very same array used by the Forge bundle scanner.
export { secretText };
const structuralRules = ['private-key-structure', 'private-key-scan-budget-exhausted-use-local', 'unscannable-binary'];
const LIMIT = 32 * 1024 * 1024;
const incomplete = () => new Error('secret-scan: incomplete input; review the full diff manually and rerun with valid input (32 MiB maximum)');

function loadAllowlist(path) {
  // The shipped file is `{ "entries": [...] }`: a bare array would be refused by the Forge non-object-json rule.
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const entries = Array.isArray(parsed) ? parsed : parsed?.entries;
  if (!Array.isArray(entries) || entries.some(entry => !entry
    || typeof entry.path !== 'string' || !entry.path || /[*?\[\]\\\x00-\x1f]/.test(entry.path)
    || entry.path.startsWith('/') || entry.path.split('/').some(part => !part || part === '.' || part === '..')
    || (!secretText.some(([, rule]) => entry.rule === rule) && !structuralRules.includes(entry.rule))
    || typeof entry.reason !== 'string' || !entry.reason.trim()
    || Object.keys(entry).some(key => !['path', 'rule', 'reason'].includes(key)))) {
    throw new Error('secret-scan: invalid allowlist; require exact path, known rule and non-empty reason');
  }
  return entries;
}

function diffPath(raw, prefix = 'b/') {
  // Git quotes control characters and encodes non-ASCII bytes as octal escapes.
  if (raw.startsWith('"')) {
    if (!raw.endsWith('"')) throw incomplete();
    raw = raw.slice(1, -1).replace(/\\([0-7]{3}|[abtnvfr"\\])/g, (_, code) =>
      /^[0-7]{3}$/.test(code) ? String.fromCharCode(parseInt(code, 8))
        : ({ a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', '"': '"', '\\': '\\' })[code]);
    raw = Buffer.from(raw, 'latin1').toString('utf8');
  } else raw = raw.replace(/\t$/, ''); // Git's delimiter for unquoted paths with spaces.
  if (raw === '/dev/null') return null;
  if (!raw.startsWith(prefix)) throw incomplete();
  return raw.slice(2);
}

function decodedLine(text) {
  return text.replace(/\\u([\da-f]{4})|\\x([\da-f]{2})|%([0-7][\da-f])/gi,
    (_, unicode, hex, percent) => String.fromCharCode(parseInt(unicode ?? hex ?? percent, 16)));
}

function safePath(path) {
  if (secretText.some(([pattern]) => { pattern.lastIndex = 0; return pattern.test(path) || pattern.test(decodedLine(path)); })
    || keyStructureFinding(Buffer.from(path))) return '[redacted-path]';
  return /[\x00-\x1f\x7f-\x9f]/.test(path) ? JSON.stringify(path) : path;
}

export function scanDiff(diff, allowlist = []) {
  if (!Buffer.isBuffer(diff)) diff = Buffer.from(diff, 'utf8');
  if (diff.length > LIMIT) throw incomplete();
  const hits = [];
  let path = null, line = 0, oldLeft = 0, newLeft = 0, added = [], firstAdded = 0, displayPath, previousPrefix;
  const report = (rule, at) => {
    if (!path) throw incomplete();
    if (!allowlist.some(entry => entry.path === path && entry.rule === rule)) {
      displayPath ??= safePath(path);
      hits.push(`${displayPath}:${at} ${rule}`);
    }
  };
  const finishFile = () => {
    if (added.length) {
      const rule = keyStructureFinding(Buffer.concat(added));
      if (rule) report(rule, firstAdded);
    }
    added = [];
    firstAdded = 0;
    displayPath = undefined;
  };
  // Split only on LF bytes. Decode metadata/text rules separately; DER must never
  // pass through a UTF-8 round trip (including CR bytes and the final LF).
  for (let offset = 0; offset < diff.length;) {
    const newline = diff.indexOf(10, offset);
    const bytes = diff.subarray(offset, newline === -1 ? diff.length : newline);
    offset = newline === -1 ? diff.length : newline + 1;
    const text = bytes.toString('utf8');
    if (text === '\\ No newline at end of file') {
      if (previousPrefix === '+') added[added.length - 1] = added.at(-1).subarray(0, -1);
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
      if (prefix === '+') {
        if (!path) throw incomplete();
        if (!added.length) firstAdded = line;
        const raw = text.slice(1), decoded = decodedLine(raw);
        added.push(Buffer.concat([bytes.subarray(1), Buffer.from('\n')]));
        for (const [pattern, rule] of secretText) {
          pattern.lastIndex = 0;
          if (pattern.test(raw) || pattern.test(decoded)) report(rule, line);
        }
      }
      previousPrefix = prefix;
      if (prefix !== '-') line++;
    } else if (text.startsWith('diff --git ')) {
      finishFile();
      path = null;
    } else if (text.startsWith('+++ ')) {
      finishFile();
      path = diffPath(text.slice(4));
    } else if (text.startsWith('Binary files ')) {
      const notice = /^Binary files (.+) and (.+) differ$/.exec(text);
      if (!notice) throw incomplete();
      finishFile();
      path = diffPath(notice[2]) ?? diffPath(notice[1], 'a/');
      report('unscannable-binary', 0);
    } else if (text.startsWith('@@')) {
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(text);
      if (!hunk) throw incomplete();
      oldLeft = Number(hunk[2] ?? 1);
      line = Number(hunk[3]);
      newLeft = Number(hunk[4] ?? 1);
      if (![oldLeft, line, newLeft].every(Number.isSafeInteger) || (newLeft && !path)) throw incomplete();
    } else if (text && !/^(?:--- |index |new file mode |deleted file mode |old mode |new mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to |\\ No newline at end of file)/.test(text)) {
      throw incomplete();
    }
  }
  if (oldLeft || newLeft) throw incomplete();
  finishFile();
  return hits;
}

export async function main(args = process.argv.slice(2)) {
  try {
    const options = { repo: '.', base: 'origin/main', head: 'HEAD', allowlist: new URL('./secret-scan-allowlist.json', import.meta.url) };
    let stdin = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--stdin') stdin = true;
      else if (['--base', '--head', '--allowlist', '--repo'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('-')) {
        options[args[i].slice(2)] = args[++i];
      } else throw new Error('secret-scan: invalid arguments');
    }
    const allowlist = loadAllowlist(options.allowlist);
    let diff;
    if (stdin) {
      const chunks = [];
      let size = 0;
      for await (const chunk of process.stdin) {
        size += chunk.length;
        if (size > LIMIT) throw incomplete();
        chunks.push(chunk);
      }
      diff = Buffer.concat(chunks);
    } else {
      try {
        diff = execFileSync('git', ['-C', options.repo, '-c', 'core.quotePath=true', 'diff', '--text', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=0', `${options.base}...${options.head}`, '--'], {
          maxBuffer: LIMIT, timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch { throw incomplete(); }
    }
    const hits = scanDiff(diff, allowlist);
    if (hits.length) process.stdout.write(hits.join('\n') + '\n');
    return hits.length ? 1 : 0;
  } catch (error) {
    // JSON, filesystem and subprocess errors may contain source text: never echo them.
    process.stderr.write((error.message.startsWith('secret-scan:') ? error.message : 'secret-scan: cannot read configuration or diff; review inputs and rerun') + '\n');
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
