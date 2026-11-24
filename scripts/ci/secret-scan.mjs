// Allowlisted files are exempt per path+rule, reviewed by a human via the base-branch allowlist.
// Text rules match line by line (raw and decoded): credentials split across multiple lines may escape
// text matching. The shared Forge structural detector also scans each file's concatenated added lines,
// including member fragments whose unchanged JWK type/enclosing object is absent from the diff.
// Gaps also get a separate lexical view: unchanged syntax cannot be inferred from added lines.
// Bare quoted values can also have an omitted private member name; reject these
// ambiguous fragments conservatively, without inventing members in complete objects.
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
    || addedStructureFinding(Buffer.from(path))) return '[redacted-path]';
  return /[\x00-\x1f\x7f-\x9f]/.test(path) ? JSON.stringify(path) : path;
}

function addedStructureFinding(bytes, gaps = []) {
  // Keep the original byte view first: DER must not make a UTF-8 round trip.
  const finding = keyStructureFinding(bytes);
  if (finding) return finding;
  // A zero-context diff may contain only new private members of an existing public
  // JWK. Supply a conservative type witness to the SAME detector around fragments
  // and unclosed objects only. Complete added objects must supply their own key
  // evidence: injecting a type into {p:"Paragraph"} would invent private material.
  // `oct` covers asymmetric and symmetric private members; missing-context member
  // fragments remain ambiguous and are intentionally rejected conservatively.
  // Skip literals/comments so braces inside them cannot corrupt the member view.
  const witness = '"kty":"oct",';
  const text = bytes.toString('utf8');
  const pieces = /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\/\/[^\r\n\u2028\u2029]*|\/\*[\s\S]*?(?:\*\/|$)|[{}\[\]]/g;
  const stack = [], closed = new Set();
  let gapIndex = 0, lastGap = -1;
  for (const match of text.matchAll(pieces)) {
    while (gapIndex < gaps.length && gaps[gapIndex] <= match.index) lastGap = gaps[gapIndex++];
    const token = match[0];
    if (token === '{' || token === '[') stack.push({ token, at: match.index });
    else if (token === '}' || token === ']') {
      const open = stack.pop();
      // A matching brace across omitted lines is not evidence of a complete object:
      // those lines may contain the real key type. Only contiguous objects are known.
      if (open?.token === (token === '}' ? '{' : '[') && lastGap <= open.at) closed.add(open.at);
    }
  }
  let size = Buffer.byteLength(text) + witness.length + 4, depth = 1;
  if (size > LIMIT) throw incomplete();
  const trivia = /(?:\s+|\/\*[\s\S]*?\*\/|\/\/[^\r\n\u2028\u2029]*)*/y;
  const fragments = text.replace(pieces, (token, offset) => {
    let extra = '';
    if (token === '{' || token === '[') {
      depth++;
      trivia.lastIndex = offset + 1;
      trivia.exec(text);
      // A type witness must not turn empty `oth: {}` into private material.
      if (token === '{' && !closed.has(offset) && text[trivia.lastIndex] !== '}') extra = witness;
    } else if (token === '}' || token === ']') {
      if (--depth === 0) {
        // An addition can first close an unchanged container, then add members
        // in its parent. Start another witness instead of losing that suffix.
        depth = 1;
        extra = `\n{${witness}\n`;
      }
    }
    size += extra.length;
    if (size > LIMIT) throw incomplete();
    return token + extra;
  });
  // The unchanged remainder may close added containers. Complete the synthetic
  // view so an unclosed last container cannot hide earlier private members.
  if (size + depth - 1 > LIMIT) throw incomplete();
  return keyStructureFinding(Buffer.from(`{${witness}\n${fragments}\n${'}'.repeat(depth)}`));
}

function fileStructureFinding(added, starts) {
  const runs = starts.map((start, index) => Buffer.concat(added.slice(start, starts[index + 1])));
  const trivia = /^(?:\s+|\/\*[\s\S]*?\*\/|\/\/[^\r\n\u2028\u2029]*)*/;
  for (const run of runs) {
    const text = run.toString('utf8');
    // A replacement can supply only the value of an unchanged `d`, `k`, etc.
    // Examine each contiguous run separately: concatenating another addition can
    // disguise that leading value as a member name or an earlier member's value.
    // Skip trivia, then distinguish a quoted value from an ordinary quoted name.
    const leading = trivia.exec(text)[0].length;
    const literal = /^(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*')/.exec(text.slice(leading));
    if (!literal) continue;
    const rest = text.slice(leading + literal[0].length);
    if (rest[trivia.exec(rest)[0].length] === ':') continue;
    const witness = '{"kty":"oct","d":\n';
    if (Buffer.byteLength(text) + witness.length + 2 > LIMIT) throw incomplete();
    const finding = keyStructureFinding(Buffer.from(`${witness}${text}\n}`));
    if (finding) return finding;
  }
  if (runs.length === 1) return addedStructureFinding(runs[0]);
  const scanRuns = chunks => {
    let offset = 0;
    const gaps = chunks.slice(0, -1).map(chunk => (offset += chunk.toString('utf8').length));
    return addedStructureFinding(Buffer.concat(chunks), gaps);
  };
  const finding = scanRuns(runs);
  if (finding) return finding;
  // Each run contains consecutive added postimage lines. An unfinished literal or
  // block comment at a gap may close on omitted lines. Drop only that unfinished
  // token in this alternate view; retain the original byte view above for DER and
  // structures genuinely spanning runs. Do not reset between consecutive additions.
  // Match unfinished tokens in the same pass as closed tokens, so repeated openers
  // without a terminator cannot cause repeated searches through the remaining run.
  const pieces = /"(?:\\[\s\S]|[^"\\])*("|\\?$)|'(?:\\[\s\S]|[^'\\])*('|\\?$)|\/\/[^\r\n\u2028\u2029]*|\/\*[\s\S]*?(\*\/|$)/g;
  return scanRuns(runs.map(run => Buffer.from(run.toString('utf8')
    .replace(pieces, (token, doubleEnd, singleEnd, commentEnd) =>
      (doubleEnd !== undefined && doubleEnd !== '"')
      || (singleEnd !== undefined && singleEnd !== "'") || commentEnd === '' ? '\n' : token))));
}

export function scanDiff(diff, allowlist = []) {
  if (!Buffer.isBuffer(diff)) diff = Buffer.from(diff, 'utf8');
  if (diff.length > LIMIT) throw incomplete();
  const hits = [];
  let path = null, line = 0, oldLeft = 0, newLeft = 0, added = [], firstAdded = 0, displayPath, previousPrefix;
  let starts = [], lastAdded = 0;
  const report = (rule, at) => {
    if (!path) throw incomplete();
    if (!allowlist.some(entry => entry.path === path && entry.rule === rule)) {
      displayPath ??= safePath(path);
      hits.push(`${displayPath}:${at} ${rule}`);
    }
  };
  const finishFile = () => {
    if (added.length) {
      const rule = fileStructureFinding(added, starts);
      if (rule) report(rule, firstAdded);
    }
    added = [];
    starts = [];
    lastAdded = 0;
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
        if (!added.length || line !== lastAdded + 1) starts.push(added.length);
        lastAdded = line;
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
