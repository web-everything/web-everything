// R971/R972: keep private host and operator details out of public text.
// No IO here: the standards caller owns changed-file selection and file reads.
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { gunzipSync, inflateSync, inflateRawSync, constants as zlibConstants } from 'node:zlib';

const sha256 = text => createHash('sha256').update(text).digest('hex');
const HASH = /^[a-f0-9]{64}$/;
const ALLOWLIST_FILES = new Set([
  'scripts/lib/privacy-terms.mjs', 'PUBLIC-CONTENT.md', 'scripts/settings/privacy-terms-allowlist.json',
]);
const isExemptionPath = path => ALLOWLIST_FILES.has(path)
  || path.split('/').some(segment => ['__tests__', 'tests', 'test', 'fixtures', '__fixtures__', 'golden-corpus'].includes(segment));
// PR 7008: a zlib header is only a two-byte checksum, so ordinary text can carry one ("x ", "hb", "H,").
// Text holds no C0 control bytes beyond tab, LF, VT, FF, CR and ESC (colour codes, page breaks); compressed
// bytes hold the others within a few dozen bytes. C1 and high bytes are left alone: UTF-8, latin1 and cp1252
// text all use them. A byte test, so the text's encoding never matters.
const BINARY_CONTROL = /[\x00-\x08\x0e-\x1a\x1c-\x1f]/;
const isPlainText = (input) => !BINARY_CONTROL.test(input.toString('latin1'));

// R972: every file is decoded in all six views; no encoding or density heuristic may omit one.
export function decodePrivacyContent(content, { onCompressionError = () => {} } = {}) {
  if (typeof content !== 'string' && !(content instanceof Uint8Array)) {
    throw new TypeError('Privacy scan requires text or file bytes');
  }
  const bytes = Buffer.from(content);
  const buffers = [bytes];
  // R972: inspect every nested layer, sharing one inflated-size budget across the chain.
  let inflatedSize = 0;
  const expand = (input, depth, rawOnly = false) => {
    const gzip = !rawOnly && input[0] === 0x1f && input[1] === 0x8b;
    const zlib = !rawOnly && input.length >= 2 && (input[0] & 15) === 8 && (input[0] >> 4) <= 7
      && ((input[0] << 8) + input[1]) % 31 === 0;
    if ((gzip || zlib) && depth >= 8) { onCompressionError(); return; }
    const remaining = 32 * 1024 * 1024 - inflatedSize;
    const inflate = gzip ? gunzipSync : zlib ? inflateSync : inflateRawSync;
    let inflated;
    try {
      inflated = inflate(input, { maxOutputLength: Math.max(1, remaining) });
    } catch (error) {
      // Raw deflate has no header: failed probes are plain bytes unless they hit the size cap.
      if (!(gzip || zlib) || error.code === 'ERR_BUFFER_TOO_LARGE') {
        if (error.code === 'ERR_BUFFER_TOO_LARGE') onCompressionError();
        return;
      }
      // PR 7008: a truncated or corrupt stream still yields the bytes before the damage; scan them, so a
      // lenient reader cannot see text this scan skipped. Output only grows with a longer prefix and a data
      // error stays an error, so a binary search finds the longest decodable prefix in log2(n) inflations.
      const decodes = (length) => {
        try {
          return inflate(input.subarray(0, length),
            { finishFlush: zlibConstants.Z_SYNC_FLUSH, maxOutputLength: Math.max(1, remaining) });
        } catch (prefixError) {
          if (prefixError.code === 'ERR_BUFFER_TOO_LARGE') throw prefixError;
          return null;
        }
      };
      let recovered = null;
      let truncated = false;
      try {
        let low = 1;
        let high = input.length;
        while (low <= high) {
          const mid = (low + high) >> 1;
          const output = decodes(mid);
          if (output) { recovered = output; truncated = mid === input.length; low = mid + 1; } else high = mid - 1;
        }
      } catch { onCompressionError(); return; }
      // Still uninspectable compression: a damaged gzip stream (its magic is unambiguous), a zlib-header
      // candidate holding binary control bytes, or a stream cut short (every byte parsed, the end missing)
      // behind one of zlib's own default headers (78 9c, 78 da; 78 01 is binary already). Short text such as
      // "hCard" or "x^2" also parses to its end, so a cut-short stream behind any other header counts as text;
      // its decodable prefix was scanned above either way.
      const defaultHeader = zlib && input[0] === 0x78 && (input[1] === 0x9c || input[1] === 0xda);
      if (gzip || !isPlainText(input) || (truncated && defaultHeader)) onCompressionError();
      if (recovered?.length && recovered.length <= remaining) {
        inflatedSize += recovered.length;
        buffers.push(recovered);
        expand(recovered, depth + 1);
      }
      // Raw deflate has no header, so its first two bytes can form a zlib checksum too: probe it as well.
      expand(input, depth, true);
      return;
    }
    if (depth >= 8 || inflated.length > remaining) { onCompressionError(); return; }
    inflatedSize += inflated.length;
    buffers.push(inflated);
    expand(inflated, depth + 1);
  };
  expand(bytes, 0);
  const views = [];
  for (const buffer of buffers) {
    views.push(new TextDecoder('utf-8').decode(buffer), buffer.toString('latin1').replace(/\0/g, ' '));
    for (const encoding of ['utf-16le', 'utf-16be']) {
      for (const alignment of [0, 1]) {
        const aligned = buffer.subarray(alignment);
        try { views.push(new TextDecoder(encoding).decode(aligned)); }
        catch {
          // Older Node decoders can reject malformed input even without fatal mode.
          const complete = Buffer.from(aligned.subarray(0, aligned.length - aligned.length % 2));
          if (encoding === 'utf-16be') complete.swap16();
          views.push((complete.toString('utf16le') + (aligned.length % 2 ? '\ufffd' : ''))
            .replace(/^\ufeff/, '').replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '\ufffd'));
        }
      }
    }
  }
  return views;
}

// R972: only complete, fixed template tokens are exempt; prefixes can be real identities.
const PLACEHOLDERS = new Set(['example', 'test', 'demo', 'sample', 'placeholder', 'user',
  'username', 'runner', 'name', '<name>', '<user>', '<username>', '${user}', '$HOME', '${HOME}', '~',
  'your-name', 'your_name', 'your-user', 'your_user', 'your-username', 'your_username',
  'your-worker', 'your_worker', 'your-service', 'your_service']);
const isPlaceholder = token => PLACEHOLDERS.has(token);
// Generic execution accounts (container root, CI and image defaults) are not private identities, so
// the local account adds no pattern; committed identity digests still apply under them.
const GENERIC_ACCOUNTS = new Set(['root', 'admin', 'administrator', 'nobody', 'daemon', 'www-data', 'node',
  'ubuntu', 'debian', 'centos', 'fedora', 'alpine', 'ec2-user', 'azureuser', 'cloud-user', 'opc', 'bitnami',
  'vscode', 'codespace', 'gitpod', 'coder', 'vagrant', 'pi', 'dev', 'jovyan', 'git', 'postgres',
  'runner', 'runneradmin', 'vssadministrator', 'jenkins', 'circleci', 'buildkite-agent', 'gitlab-runner',
  'travis', 'docker', 'ci', 'build', 'builder', 'app', 'guest', 'default']);
// Case-folded like Windows account names; a bare numeric uid names no person.
const isGenericAccount = name => isPlaceholder(name) || isPlaceholder(name.toLowerCase())
  || GENERIC_ACCOUNTS.has(name.toLowerCase()) || /^\d+$/.test(name);
// R972: Windows separators count too; a backslash that starts a JSON-escaped separator is left to the decoded view.
const BACKSLASH = String.raw`\\(?!/|u00(?:2[fF]|5[cC]))`;
const SEP = `(?:/|${BACKSLASH})+`;
// A home token never starts with "%": %USERNAME% is a variable, and percent-encoded names are decoded in another view.
const HOME_TOKEN = String.raw`(<[^>]+>|\$\{[^}]+\}|[^/\\\s"'\x60<>()\[\]{},;:!?%][^/\\\s"'\x60<>()\[\]{},;:!?]*)`;
// Windows folds case: after a drive, admin share, WSL drive or a backslash, any-case "users" is a home.
// A forward-slash "/users/" without a drive stays case-sensitive so web routes are not home paths.
const USERS_ANY_CASE = '[Uu][Ss][Ee][Rr][Ss]';
const WINDOWS_ROOT = String.raw`(?<=\b[A-Za-z]:|\b[A-Za-z]\$|/mnt/[A-Za-z])`;
// Each alternative starts at most once per separator run (lookbehind or single separator), keeping scans linear.
const HOME_PATH_SOURCE = `(?<![/\\\\])${SEP}(?:Users|home|Documents and Settings)${SEP}${HOME_TOKEN}`
  + `|${WINDOWS_ROOT}${SEP}${USERS_ANY_CASE}${SEP}${HOME_TOKEN}|${BACKSLASH}${USERS_ANY_CASE}${SEP}${HOME_TOKEN}`;
const IPV4_SOURCE = String.raw`(?<!\w|\d\.)(?:\d{1,3}\.){3}\d{1,3}(?!\w|\.\d)`;
// One start per run of token characters (the lookbehind), at least two colons, optional zone.
// Word characters (with `_`) are token characters, so a key like bind_addr: joins the token instead of hiding it.
const IPV6_TOKEN_SOURCE = String.raw`(?<![\w:.%])(?:\w*:){2,}[\w:.]*(?:%[\w.-]+)?`;
const SERVICE_PLACEHOLDERS = new Set(['example.workers.dev', 'your-worker.workers.dev']);
const NETWORK_PLACEHOLDERS = new Set(['example.ts.net']);
export const PATTERNS = Object.freeze([
  { id: 'uninspectable-compressed', source: null, flags: '' },
  { id: 'machine-name', source: String.raw`\b(?:Mac ?Studio|Studio host|MacBook|Mac mini)`, flags: 'gi' },
  { id: 'host-spec', source: String.raw`\b\d+[- ]cores?\b[\s\S]{0,32}?\b\d+(?:\.\d+)?\s*Gi?B\b|\b\d+(?:\.\d+)?\s*Gi?B\b[\s\S]{0,32}?\b\d+[- ]cores?\b|\bM[1-9]\d*(?:\s+(?:Max|Pro|Ultra))?\b[\s\S]{0,24}?\b\d+(?:\.\d+)?\s*Gi?B\b|\b\d+(?:\.\d+)?\s*Gi?B\b[\s\S]{0,24}?\bM[1-9]\d*(?:\s+(?:Max|Pro|Ultra))?\b`, flags: 'gi' },
  { id: 'home-path', source: HOME_PATH_SOURCE, flags: 'g' },
  // Committed identity digests and optional local identity; never store the actual identity here.
  { id: 'operator-username', source: null, flags: 'gi' },
  // PR 7008: a host match never restarts after an inner dot or dash of a run that already began with a
  // letter or digit (the leftmost start covers it), so a long dotted run is linear. A host after a
  // leading `*.`, `.` or `-` still matches, as with the plain word boundary. The look-back is capped at
  // 8 separators so it stays constant-time; past that, a restart finds nothing the leftmost start missed.
  { id: 'private-service-url', source: String.raw`\b(?<![a-z0-9][.-]{0,8})([a-z0-9][a-z0-9.-]*)\.workers\.dev\b`, flags: 'gi' },
  { id: 'network-name', source: String.raw`\b(?<![a-z0-9][.-]{0,8})[a-z0-9][a-z0-9.-]*\.(?:ts\.net|tailscale)\b|\btailscale(?:[- ]host(?:name)?)?\s*[:=]\s*["']?([a-z0-9][a-z0-9.-]*)`, flags: 'gi' },
  // PR 7008: two scans (see scanPrivacyView). IPv4 boundaries reject only a longer dotted number, so
  // sentence punctuation and colon-joined syntax (ssh -L port:host:port, key:value) still match.
  // IPv6 is matched as a whole colon-joined token and resolved by privateIpv6InToken.
  { id: 'private-network-ip', source: `${IPV4_SOURCE}|${IPV6_TOKEN_SOURCE}`, flags: 'gi' },
  { id: 'account-id', source: String.raw`\b(?:[a-z][a-z0-9]*_)*(?:github[ _-]*)?(?:app|installation)[ _-]*id\b["'\x60]*\s*(?:[:=]|\bis\b)?\s*["'\x60]*(\d+)\b|/app/installations/(\d+)\b|\b(?:[a-z][a-z0-9]*_)*installations["']?\s*[:=]\s*(?:Object\.freeze\(\s*)?\{[^{}]*\}`, flags: 'gi' },
]);

function isPrivateIp(value) {
  const address = value.split('%')[0];
  if (isIP(address) === 6) {
    // PR 7008: canonical form (lower case, zeros compressed, mapped IPv4 in hex), so every spelling of a
    // mapped address (::ffff:, 0::ffff:, five zero groups, dotted or hex tail) reads the same.
    const host = new URL(`http://[${address}]/`).hostname.slice(1, -1);
    const mapped = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mapped) {
      const [high, low] = [parseInt(mapped[1], 16), parseInt(mapped[2], 16)];
      return isPrivateIp([high >> 8, high & 255, low >> 8, low & 255].join('.'));
    }
    const first = parseInt(host.split(':')[0] || '0', 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
  }
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
}

/**
 * PR 7008 — the private IPv6 address inside one colon-joined token, or null. A candidate starts at the token
 * start, after a `:` or `.`, or at a `::`, and ends at the token end or just before a `:` or `.`, so a key
 * before (source:, bind_addr:) and a port or word after (.546, :http, a sentence dot or colon) are skipped.
 * The LONGEST valid address wins: a valid public address is never reported for a private-looking part
 * (2001:db8:fc00::1). A hex-only key (db:fd00::5) forms a valid public address itself and is read as one.
 * No valid IPv6 text exceeds 45 characters, so each start tries a bounded number of ends: linear per token.
 */
function privateIpv6InToken(token) {
  const zoneAt = token.indexOf('%');
  const body = zoneAt < 0 ? token : token.slice(0, zoneAt);
  const zone = zoneAt < 0 ? '' : token.slice(zoneAt);
  const ends = [];
  for (let at = 0; at < body.length; at += 1) if (body[at] === ':' || body[at] === '.') ends.push(at);
  ends.push(body.length);
  let best = null;
  let first = 0;
  for (let start = 0; start < body.length; start += 1) {
    const boundary = start === 0 || body[start - 1] === ':' || body[start - 1] === '.'
      || (body[start] === ':' && body[start + 1] === ':');
    if (!boundary) continue;
    while (first < ends.length && ends[first] <= start) first += 1;
    for (let e = first; e < ends.length && ends[e] - start <= 45; e += 1) {
      const end = ends[e];
      if (best && end - start <= best.text.length) continue;
      const candidate = body.slice(start, end);
      if (isIP(candidate) === 6) best = { offset: start, text: candidate, atEnd: end === body.length };
    }
  }
  if (!best || !isPrivateIp(best.text)) return null;
  return { offset: best.offset, text: best.text + (best.atEnd ? zone : '') };
}

/** PR 7008 — private-network-ip hits as `{ match, index }`, IPv6 tokens first so an IPv4 tail inside a reported
 *  IPv6 address (::ffff:10.2.3.4) is not reported twice. */
function privateNetworkHits(text) {
  const hits = [];
  const spans = [];
  for (const match of text.matchAll(new RegExp(IPV6_TOKEN_SOURCE, 'gi'))) {
    const hit = privateIpv6InToken(match[0]);
    if (!hit) continue;
    const index = match.index + hit.offset;
    hits.push({ match: hit.text, index });
    spans.push([index, index + hit.text.length]);
  }
  // Both lists ascend by index, so one moving cursor keeps the overlap check linear.
  let cursor = 0;
  for (const match of text.matchAll(new RegExp(IPV4_SOURCE, 'g'))) {
    while (cursor < spans.length && spans[cursor][1] <= match.index) cursor += 1;
    const inside = cursor < spans.length && spans[cursor][0] <= match.index;
    if (!isPrivateIp(match[0]) || inside) continue;
    hits.push({ match: match[0], index: match.index });
  }
  return hits.sort((a, b) => a.index - b.index);
}

// R972: exact match AND source-line digests, never a file-wide category exemption.
// Excerpts are restricted to synthetic fixtures, detector definitions and explicit policy files.
export function loadAllowlist(text) {
  const policy = JSON.parse(text);
  const { entries, operatorUsernameSha256 } = policy ?? {};
  if (!Array.isArray(entries) || !Array.isArray(operatorUsernameSha256)
    || !operatorUsernameSha256.length || !operatorUsernameSha256.every(hash => typeof hash === 'string' && HASH.test(hash))) {
    throw new Error('Privacy policy requires entries and nonempty SHA-256 operator identity digests');
  }
  for (const entry of entries) {
    if (!entry || typeof entry.path !== 'string' || !entry.path
      || entry.path.startsWith('/') || entry.path.includes('\\')
      || entry.path.split('/').some(p => !p || p === '..' || p === '.')
      || !isExemptionPath(entry.path)
      || !PATTERNS.some(p => p.id === entry.pattern)
      || typeof entry.matchText !== 'string' || !entry.matchText
      || typeof entry.matchSha256 !== 'string' || !HASH.test(entry.matchSha256)
      || sha256(entry.matchText) !== entry.matchSha256
      || typeof entry.lineSha256 !== 'string' || !HASH.test(entry.lineSha256)
      || typeof entry.reason !== 'string' || !entry.reason.trim()) {
      throw new Error('Invalid privacy allowlist entry: require approved fixture/policy path, known pattern, exact text and match/line digests with reason');
    }
  }
  return policy;
}

// R972: scan both representations; normalisation never replaces raw evidence.
export function normalizePrivacyLine(line) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    sol: '/', bsol: '\\', colon: ':', period: '.', Tab: ' ', NewLine: ' ' };
  return line.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name) => {
    if (!name.startsWith('#')) return entities[name] ?? entity;
    const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  }).normalize('NFKC').replace(/[\u200b-\u200f\u2060\ufeff]/g, '')
    .replace(/<\/?[a-z][^>]*>/gi, ' ');
}

// Standard or URL-safe base64 to text, or null when the token is not exact base64 of valid UTF-8.
function decodeBase64Text(token) {
  const canonical = token.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const bytes = Buffer.from(canonical, 'base64');
  if (bytes.toString('base64').replace(/=+$/, '') !== canonical) return null;
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // R984: controls are separators, never a reason to suppress private substrings.
    return decoded.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ');
  } catch { return null; }
}

// PR 7008: base64 is routinely wrapped (MIME 76, PEM 64, any width), so a value split across lines must be
// decoded whole. A run is two or more base64 segments joined by one or more line breaks:
//   - a real break (LF, CRLF, lone CR, VT, FF, U+2028, U+2029) or a JSON-escaped one (\n, \r\n, \r);
//   - optional spaces or tabs around it, blank lines in between;
//   - an optional table pipe or shell continuation backslash before the break;
//   - an optional prefix on the next line: comment or quote marks (#, ;, >, *, %, !, |), or a line number,
//     // or -- followed by a space (a bare // or -- can begin base64 data; data lines never hold a space).
// The look-behind starts a run only at a token start (after "=" too, as in KEY=<base64>), so each character
// begins at most one attempt; every alternative in a separator consumes a break, so the scan stays linear.
const LINE_BREAK = String.raw`(?:\r\n|[\r\n\v\f  ]|\\r\\n|\\[nr])`;
const LINE_SUFFIX = String.raw`(?:\|[ \t]*|\\(?=\r?\n))`;
const LINE_PREFIX = String.raw`(?:[#;>*%!|]+[ \t]*|(?://|--|\d+)[ \t]+)`;
const WRAP_SEPARATOR = String.raw`[ \t]*${LINE_SUFFIX}?(?:${LINE_BREAK}[ \t]*${LINE_PREFIX}?)+`;
const WRAPPED_BASE64 = new RegExp(
  String.raw`(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]+(?:${WRAP_SEPARATOR}[A-Za-z0-9+/_-]+)+={0,2}`, 'g');

/** PR 7008 — one wrapped run with each base64 block in it decoded, or null.
 *  A wrapped block is a stretch of full-width lines (one shared length), plus the line before it (a partial
 *  first line, e.g. after KEY=) and the line after it (the shorter last line). Words next to the block (a PEM
 *  "-----BEGIN …-----" header, labels, an "-----END" line) join the run too.
 *  The run's segments are split into equal-width stretches, largest first (width × lines), so the real block
 *  claims its edge lines before a stray word can. Each stretch tries the four ways of keeping or leaving its
 *  two unclaimed edge lines, longest first: at most four linear decodes per stretch, and the stretches
 *  partition the run. Decoded text sits on the block's first line and the block's LF line breaks are kept
 *  (the scan splits lines on LF), so line numbers still name their source lines. */
function decodeWrappedRun(run) {
  const separators = [...run.matchAll(new RegExp(WRAP_SEPARATOR, 'g'))];
  const starts = [0, ...separators.map(match => match.index + match[0].length)];
  const ends = [...separators.map(match => match.index), run.length];
  const count = starts.length;
  const padding = run.match(/=*$/)[0].length;
  // A trailing "==" is padding, not part of the last line's width.
  const width = index => ends[index] - starts[index] - (index === count - 1 ? padding : 0);
  const stretches = [];
  for (let index = 0; index < count;) {
    let stop = index + 1;
    while (stop < count && width(stop) === width(index)) stop += 1;
    stretches.push({ index, stop, size: width(index) * (stop - index) });
    index = stop;
  }
  stretches.sort((a, b) => b.size - a.size || a.index - b.index);
  const claimed = new Uint8Array(count);
  const blocks = [];
  for (const stretch of stretches) {
    // An earlier block may have claimed this stretch's end lines as its own edge lines: use what is left.
    let index = stretch.index;
    let stop = stretch.stop;
    while (index < stop && claimed[index]) index += 1;
    while (stop > index && claimed[stop - 1]) stop -= 1;
    if (index === stop) continue;
    const free = at => at >= 0 && at < count && !claimed[at];
    for (const [first, last] of [[index - 1, stop], [index, stop], [index - 1, stop - 1], [index, stop - 1]]) {
      if (last - first < 1 || !free(first) || !free(last)) continue;
      const block = run.slice(starts[first], ends[last]);
      const decoded = decodeBase64Text(block.replace(new RegExp(WRAP_SEPARATOR, 'g'), ''));
      if (decoded === null) continue;
      claimed.fill(1, first, last + 1);
      blocks.push({ first, last, text: decoded + '\n'.repeat((block.match(/\n/g) ?? []).length) });
      break;
    }
  }
  if (!blocks.length) return null;
  blocks.sort((a, b) => a.first - b.first);
  let cursor = 0;
  const pieces = [];
  for (const { first, last, text } of blocks) {
    pieces.push(run.slice(cursor, starts[first]), text);
    cursor = ends[last];
  }
  return pieces.join('') + run.slice(cursor);
}

/** PR 7008 — ragged wrapping (no shared line width, e.g. widths 2/3/2/3 or 1..9), decoded as one stream: the
 *  run's segments joined and decoded at each of the four base64 alignments, so data after a stray word of any
 *  length still lines up at one of them. Kept only for a run of three or more lines whose best decode is
 *  mostly printable text (garbage from joined prose words is not). Up to two leading lines (labels) may be
 *  left out when that decodes more cleanly, so the decode sits on the block's first line, as the width view
 *  puts it. On a tie the fewest are left out: dropping a real data line also decodes cleanly, but loses its
 *  text. The run's LF breaks are kept. Twelve linear decodes per run. */
function decodeJoinedRun(run) {
  const separators = [...run.matchAll(new RegExp(WRAP_SEPARATOR, 'g'))];
  if (separators.length < 2) return null;
  const strip = text => text.replace(new RegExp(WRAP_SEPARATOR, 'g'), '').replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
  let best = null;
  for (let skip = 0; skip <= 2 && skip < separators.length; skip += 1) {
    const from = skip ? separators[skip - 1].index + separators[skip - 1][0].length : 0;
    const joined = strip(run.slice(from));
    if (joined.length < 16) continue;
    for (let offset = 0; offset < 4; offset += 1) {
      const aligned = joined.slice(offset, joined.length - ((joined.length - offset) % 4));
      const decoded = new TextDecoder('utf-8').decode(Buffer.from(aligned, 'base64'));
      const printable = decoded.replace(/[\p{Cc}�]/gu, '').length / Math.max(1, decoded.length);
      if (!best || printable > best.printable) best = { from, decoded, printable };
    }
  }
  if (!best || best.printable < 0.75) return null;
  return run.slice(0, best.from) + best.decoded.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
    + '\n'.repeat((run.slice(best.from).match(/\n/g) ?? []).length);
}

/** PR 7008 — the text views with wrapped base64 decoded: one by line width, one as joined streams (ragged
 *  wrapping). A view is left out when no run in it decodes. */
function unwrapBase64(text) {
  return [decodeWrappedRun, decodeJoinedRun].map((decodeRun) => {
    let changed = false;
    const view = text.replace(WRAPPED_BASE64, (run) => {
      const decoded = decodeRun(run);
      if (decoded === null) return run;
      changed = true;
      return decoded;
    });
    return changed ? view : null;
  }).filter(view => view !== null);
}

// R972: entity decoding may expand a single source line into several scan lines.
export function privacyLineViews(line) {
  // R984: single-pass common encodings only; work and decoded output stay linear in input size.
  const decode = line => {
    const percent = line.replace(/(?:%[0-9a-f]{2})+/gi, token => {
      try { return decodeURIComponent(token); } catch { return token; }
    });
    const json = line.replace(/\\u([0-9a-f]{4})|\\([/\\"bfnrt])/gi, (token, hex, escape) =>
      hex ? String.fromCharCode(parseInt(hex, 16)) : ({ '/': '/', '\\': '\\', '"': '"', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }[escape] ?? token));
    const base64 = line.replace(/[a-z0-9+/_-]{8,}={0,2}/gi, token => decodeBase64Text(token) ?? token);
    return [percent, json, base64];
  };
  const normalized = normalizePrivacyLine(line);
  const decodedRaw = decode(line);
  // Keep decoded attributes before tag stripping, and decode characters exposed by normalisation.
  return [...new Set([normalized, ...decodedRaw, ...decode(normalized), ...decodedRaw.map(normalizePrivacyLine)])];
}

function normalizedView(linesWithViews, variant) {
  const sourceLines = [];
  const lines = linesWithViews.map(({ lineText, views }, index) => {
    const normalized = views[variant] ?? views[0];
    for (const _line of normalized.split('\n')) sourceLines.push({ line: index + 1, lineText });
    return normalized;
  });
  return { view: lines.join('\n'), sourceLines };
}

export function scanText(content, options = {}) {
  const hits = [];
  const counts = new Map();
  let compressionFailed = false;
  const views = decodePrivacyContent(content, { onCompressionError: () => { compressionFailed = true; } });
  if (compressionFailed) {
    const match = 'Compressed content cannot be inspected within 32 MiB; repair it or request an exact-context policy exemption.';
    const lineText = Buffer.from(content).toString('latin1').split('\n')[0].replace(/\r$/, '');
    if (!(options.allowlist?.entries ?? []).some(e => e.path === options.path && e.pattern === 'uninspectable-compressed'
      && e.matchText === match && e.matchSha256 === sha256(match) && e.lineSha256 === sha256(lineText))) {
      hits.push({ pattern: 'uninspectable-compressed', line: 1, match });
    }
  }
  for (const { view, sourceLines } of views.flatMap(raw => {
    const rawLines = raw.split('\n');
    const lines = rawLines.map(lineText => ({ lineText, views: privacyLineViews(lineText) }));
    const variants = lines.reduce((max, line) => Math.max(max, line.views.length), 0);
    const scans = [{ view: raw }, ...Array.from({ length: variants }, (_, variant) => normalizedView(lines, variant))];
    // PR 7008: base64 wrapped across lines, decoded whole; lines still map to (and are exempted by) raw lines.
    for (const unwrapped of unwrapBase64(raw)) {
      // The whole unwrapped text is scanned once; per-line decodings are rebuilt only for the lines the unwrap
      // changed (an unchanged line's decodings were scanned above), keeping this view's cost near one scan.
      const unwrappedLines = unwrapped.split('\n').map((text, index) => ({ lineText: rawLines[index],
        views: text === rawLines[index] ? [''] : privacyLineViews(text) }));
      const unwrappedVariants = unwrappedLines.reduce((max, line) => Math.max(max, line.views.length), 0);
      scans.push({ view: unwrapped, sourceLines: rawLines.map((lineText, index) => ({ line: index + 1, lineText })) },
        ...Array.from({ length: unwrappedVariants }, (_, variant) => normalizedView(unwrappedLines, variant)));
    }
    return scans;
  })) {
    const viewCounts = new Map();
    for (const hit of scanPrivacyView(view, { ...options, sourceLines })) {
      const key = JSON.stringify([hit.line, hit.pattern, hit.match]);
      const count = (viewCounts.get(key) ?? 0) + 1;
      viewCounts.set(key, count);
      // Deduplicate representations, preserving the largest occurrence count in any view.
      if (count > (counts.get(key) ?? 0)) { counts.set(key, count); hits.push(hit); }
    }
  }
  return hits.sort((a, b) => a.line - b.line);
}

function scanPrivacyView(text, { path = '', allowlist = { entries: [], operatorUsernameSha256: [] }, operatorUsername = '', sourceLines }) {
  const hits = [];
  const seen = new Set();
  // PR 7008: line starts computed once; a per-hit slice of the whole text made many-hit input quadratic.
  const lineDigests = new Map();
  const lineStarts = [0];
  for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) lineStarts.push(at + 1);
  const lineOf = (index) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (lineStarts[mid] <= index) low = mid; else high = mid - 1;
    }
    return low;
  };
  const add = (pattern, match, index) => {
    const key = `${pattern}:${index}:${match}`;
    if (seen.has(key)) return;
    seen.add(key);
    const lineIndex = lineOf(index);
    const scanLine = lineIndex + 1;
    const source = sourceLines?.[scanLine - 1];
    const line = source?.line ?? scanLine;
    const lineEnd = lineIndex + 1 < lineStarts.length ? lineStarts[lineIndex + 1] - 1 : text.length;
    const lineText = (source ? source.lineText : text.slice(lineStarts[lineIndex], lineEnd)).replace(/\r$/, '');
    // One digest per line (the line text depends only on lineIndex), so many hits on one long line stay linear.
    const lineSha = () => {
      if (!lineDigests.has(lineIndex)) lineDigests.set(lineIndex, sha256(lineText));
      return lineDigests.get(lineIndex);
    };
    if (allowlist.entries.some(e => e.path === path && e.pattern === pattern
      && e.matchText === match && e.matchSha256 === sha256(match) && e.lineSha256 === lineSha())) return;
    const hit = { pattern, line, match };
    // Preserve normalisation provenance for baseline keys without changing diagnostic output.
    if (sourceLines !== undefined) Object.defineProperty(hit, 'rawLineSha256', { value: lineSha() });
    hits.push(hit);
  };
  for (const pattern of PATTERNS) {
    const source = pattern.id === 'operator-username'
      ? (operatorUsername && !isGenericAccount(operatorUsername)
        ? String.raw`(?<![\w-])${operatorUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\w-])` : null)
      : pattern.source;
    if (!source) continue;
    if (pattern.id === 'private-network-ip') {
      for (const { match, index } of privateNetworkHits(text)) add(pattern.id, match, index);
      continue;
    }
    for (const match of text.matchAll(new RegExp(source, pattern.flags))) {
      if (pattern.id === 'home-path' && isPlaceholder(match[1] ?? match[2] ?? match[3])) continue;
      if (pattern.id === 'private-service-url' && SERVICE_PLACEHOLDERS.has(match[0])) continue;
      if (pattern.id === 'network-name' && (NETWORK_PLACEHOLDERS.has(match[0])
        || (match[1] && isPlaceholder(match[1])))) continue;
      if (pattern.id === 'account-id' && !match[1] && !match[2]
        && !/:\s*["']?\d+["']?\s*[,}]/.test(match[0])) continue;
      add(pattern.id, match[0], match.index);
    }
  }
  // R972: portable identity detection on CI and other reviewers' machines. Hash both complete
  // home-directory tokens and identifiers split on non-alphanumerics; normalize case before hashing.
  const identities = new Set(allowlist.operatorUsernameSha256);
  // The same home-path definition as the pattern above, so both scans agree on what a home token is.
  for (const source of [new RegExp(HOME_PATH_SOURCE, 'g'), /[a-z0-9]+(?:[._-][a-z0-9]+)*/gi]) {
    for (const candidate of text.matchAll(source)) {
      const token = candidate[1] ?? candidate[2] ?? candidate[3] ?? candidate[0];
      const index = candidate.index + candidate[0].length - token.length;
      const parts = [...token.matchAll(/[a-z0-9]+/gi)];
      const forms = new Set([token, ...['', '.', '-', '_'].map(separator => parts.map(part => part[0]).join(separator))]);
      if ([...forms].some(form => identities.has(sha256(form.toLowerCase())))) {
        add('operator-username', token, index);
      } else {
        for (const part of parts) {
          if (identities.has(sha256(part[0].toLowerCase()))) add('operator-username', part[0], index + part.index);
        }
      }
    }
  }
  return hits.sort((a, b) => a.line - b.line);
}

// R972: legacy content remains visible in audits, without exemptions hiding it.
// Count matches, so copying an existing value into another occurrence still fails.
export function introducedFindings(current, baseline) {
  const counts = new Map();
  const key = hit => JSON.stringify([hit.pattern, hit.match, hit.rawLineSha256 ?? '']);
  for (const hit of baseline) counts.set(key(hit), (counts.get(key(hit)) ?? 0) + 1);
  return current.filter(hit => {
    if (['machine-name', 'host-spec', 'uninspectable-compressed'].includes(hit.pattern)) return true; // Preserve R971 and fail closed.
    const remaining = counts.get(key(hit)) ?? 0;
    if (!remaining) return true;
    counts.set(key(hit), remaining - 1);
    return false;
  });
}

export function selectChangedFiles(changes, extraFiles = null) {
  if (!changes || !Array.isArray(changes.changedFiles) || !Array.isArray(changes.deletedFiles)) {
    throw new Error('Privacy changed-file evidence unavailable; restore base history and rerun standards');
  }
  // R972: flags can add content to inspect, never subtract a git-derived change.
  return [...new Set([...changes.changedFiles, ...(extraFiles ?? [])])]
    .filter(file => !changes.deletedFiles.includes(file));
}
