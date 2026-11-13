import {createHash} from 'node:crypto';
const LIMIT=4*1024*1024;
const sha=value=>createHash('sha256').update(value).digest('hex');
// Paths remain bytes throughout inventory, transport, hashing and verification.
export function pathParts(path) {
  if (!Buffer.isBuffer(path) || !path.length || path[0] === 47 || path.some(b => b === 0 || b === 10 || b === 13))
    throw new Error('Unsafe manifest path');
  const parts = [];
  let start = 0;
  for (let i = 0; i <= path.length; i++) if (i === path.length || path[i] === 47) {
    const part = path.subarray(start, i);
    if (!part.length || part.equals(Buffer.from('.')) || part.equals(Buffer.from('..'))) throw new Error('Unsafe manifest path component');
    parts.push(part); start = i + 1;
  }
  return parts;
}
export const bytePath = (root, path) => Buffer.concat([Buffer.from(root), Buffer.from('/'), path]);
// latin1 preserves bytes while matching ASCII suffixes and directory names.
export function isTestFile(path) {
  const parts = path.toString('latin1').split('/');
  const basename = parts.pop();
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(basename)
    || (/\.(?:js|mjs|cjs|ts|mts|cts|jsx|tsx)$/.test(basename)
      && parts.some(part => /^(?:__tests__|__test__|test|tests|spec|specs|e2e)$/.test(part)));
}

// Test discovery consumes Unicode strings. Refuse names it could merge or lose;
// non-test assets retain the byte-path transport contract.
export function validateTestNames(paths) {
  const normalized = new Set(), folded = new Set();
  for (const path of paths.filter(isTestFile)) {
    let name;
    try { name = new TextDecoder('utf-8', {fatal:true, ignoreBOM:true}).decode(path); }
    catch { throw new Error('Input digest mismatch: undecodable test name; use local fallback'); }
    if (!Buffer.from(name).equals(path)) throw new Error('Input digest mismatch: undecodable test name; use local fallback');
    const nfc = name.normalize('NFC');
    // Upper then lower also detects expanding case pairs such as ß / SS.
    const fold = nfc.toUpperCase().toLowerCase().normalize('NFC');
    if (normalized.has(nfc) || folded.has(fold)) throw new Error('Input digest mismatch: test name collision; use local fallback');
    normalized.add(nfc); folded.add(fold);
  }
}
export function splitPaths(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > LIMIT || (bytes.length && bytes.at(-1) !== 0)) throw new Error('Invalid manifest inventory framing');
  const paths = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0) {
    const path = bytes.subarray(start, i); pathParts(path); paths.push(path); start = i + 1;
  }
  return paths;
}
export const nulPaths = paths => Buffer.concat(paths.flatMap(path => [path, Buffer.from([0])]));
export const manifestWire = ({entries, excluded, siblings}) => ({
  v:2,
  paths:nulPaths(entries.map(entry => entry.path)).toString('base64'),
  hashes:entries.map(entry => entry.sha256),
  executable:entries.map(entry => entry.executable),
  tracked:entries.map(entry => entry.tracked ?? false),
  excluded:nulPaths(excluded).toString('base64'),
  ...(siblings ? {siblings:{frontierui:{sha:siblings.frontierui.sha,...manifestWire(siblings.frontierui)}}} : {}),
});
export const digestManifest = manifest => sha(JSON.stringify(manifest));

// This exclusion policy is part of the manifest, never an independent rsync
// filter. Test-shaped names under excluded components refuse remote admission.
const safeDotDirectory = /^(?:\.github|\.githooks|\.husky|\.vscode|\.storybook|\.changeset)$/;
const safeDotFile = /^(?:\.gitignore|\.gitattributes|\.editorconfig|\.nvmrc|\.node-version|\.prettierrc.*|\.eslintrc.*|\.gitkeep|\.nycrc.*)$/;
const keyComponent = /(?:_rsa|\.(?:pem|key|p12|pfx|jks|keystore)$)/;
const credentialComponent = /token|secret|creds|credential|passwd|password|oauth|api[-_ .]?key|^id_/;
export const sourceExtension = /\.(?:mjs|js|ts|tsx|jsx|css|md|html)$/;
function normalizedComponent(part) {
  const utf8 = part.toString('utf8');
  // Non-test opaque byte names retain their existing byte-path contract. Only
  // the policy view is decoded; transport and hashing always use original bytes.
  const text = Buffer.from(utf8).equals(part) ? utf8 : part.toString('latin1');
  return text.normalize('NFKC').normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/\p{Cf}/gu, '').replace(/[. ]+$/u, '').toLowerCase();
}
// The caller supplies the normalized policy view of one path component.
export const secretFileName = component => credentialDirectory(component) || /^\.(?:env.*|netrc|npmrc)$/.test(component) || keyComponent.test(component) || credentialComponent.test(component);
export const unsafeComponentName = name => /\p{Cc}/u.test(name) || [...name].some(char => char.charCodeAt(0) > 127
  && !/^(?:[a-z]\p{M}+|\p{Z})$/u.test(char.normalize('NFD')));
// Credential stores: BLOCK in a bundle, never warn (R857 correction).
export const credentialDirectory = component => /^\.(?:ssh|gnupg|aws|docker|kube)$/.test(component);
// A dot-FILE leaf the manifest excludes (.pgpass, .pypirc, .dockercfg, ...): credential stores block in a bundle,
// as every excluded path did before R857. Only dot DIRECTORIES of ordinary files may downgrade to a warning.
export const excludedDotFile = component => component.startsWith('.') && !safeDotDirectory.test(component) && !safeDotFile.test(component);
function excludedComponent(name, leaf, allowCredential = false) {
  // Admit ordinary accented Latin names (e.g. é) but fail closed on remaining
  // non-ASCII forms: no incomplete hand-maintained confusable substitution map.
  return unsafeComponentName(name) || !name || /^\.(?:netrc|npmrc|env.*)$/.test(name)
    || (name.startsWith('.') && !safeDotDirectory.test(name) && !(leaf && safeDotFile.test(name)))
    || keyComponent.test(name) || (!allowCredential && credentialComponent.test(name));
}

// Ruling R321 (replaces the per-folder exceptions of R312/R316). A file whose
// NAME alone trips credentialComponent ships to Forge only when ALL hold:
//   1. it is git-tracked;
//   2. it is a regular source whose bytes equal origin/main (remote-exec compares
//      index/public blobs and hashes worktree bytes). Only the established
//      .claude/agent-memory -> agent-memory-src bridge may project that verified
//      source; credential-named aliases through other links are refused;
//   3. it passes the content secret scan below.
// Why this leaks nothing: a tracked file identical to origin/main is already
// public, so shipping it to our own Forge reveals nothing new. Anything
// untracked, modified versus main, or local-only stays excluded. Names that are
// unsafe for other reasons (key files, dotfiles, .env, non-ASCII) never qualify.
const secretField=/key|secret|token|passw(?:or)?d|credential|creds|oauth|^id_/i;
// A "private key" label: private/priv, up to two short words (ssh, ed25519, signing, RSA), then "key".
// Every run is bounded so the label cannot backtrack badly. Zero-width characters, Markdown emphasis
// and HTML tags or entities are removed by labelNoise before this label is matched (see textFinding).
const ci=word=>word.replace(/[a-z]/g,c=>`[${c}${c.toUpperCase()}]`);
// Type words are a closed list: any short word would make "private cache key <sha>" or "private foreign key <sha>" a hit.
const keyKinds=['ssh','rsa','dsa','ecdsa','ec','ed25519','x25519','secp256k1','signing','wallet','raw','hex','base64','api',
  'account','eth','ethereum','bitcoin','master','root','deploy','host','tls','ssl','pgp','gpg','jwt','jwk','pem','der','pkcs8','openssh','age'];
const keyLabel=`${ci('priv')}(?:${ci('ate')})?(?:[ \\t_.-]{1,6}(?:${keyKinds.map(ci).join('|')})){0,2}[ \\t_.-]{0,6}${ci('key')}`;
// The gap from the label to the material: up to 96 characters of anything on the label's line (wrappers, types,
// punctuation). It may continue onto a later line (YAML or Markdown value, openssl text dump) only when the
// line it leaves ends in a separator (: = | > ) [ ] { } quote backtick hyphen) or a trailing # or // comment, up
// to three times, with blank lines allowed. A line that ends in a word ("the private key file is unreadable") never carries on, so prose that
// merely precedes a commit id stays a non-hit. Every run is bounded, so the label stays linear.
const labelGap='(?:[^\\r\\n]{0,96}?(?:[:=|>)\\[\\]{}"\'`-][ \\t]{0,8}|(?:#|//)[^\\r\\n]{0,60})\\r?\\n(?:[ \\t]*\\r?\\n){0,2}){0,3}[^\\r\\n]{0,96}?';
export const secretText=[
  [/-----BEGIN/,'pem-header'],
  [/PRIVATE KEY/,'private-key'],
  // Any case: a "private key" label, then the gap above, then a 32+ hex run, a list of 32+ decimal bytes, or a
  // 40+ token mixing digits, lower and upper case (so words and paths do not hit). Hex cut into byte pairs by
  // spaces, colons, commas or hyphens is joined first (see foldHex).
  [new RegExp(`${keyLabel}${labelGap}(?:0x)?[0-9a-fA-F]{32,}`),'private-key'],
  [new RegExp(`${keyLabel}${labelGap}[\\[{(](?:\\s{0,8}-?\\d{1,3}\\s{0,8},){31,}`),'private-key'],
  [new RegExp(`${keyLabel}${labelGap}(?<![A-Za-z0-9+/_-])(?=[A-Za-z0-9+/_-]*\\d)(?=[A-Za-z0-9+/_-]*[a-z])(?=[A-Za-z0-9+/_-]*[A-Z])[A-Za-z0-9+/_-]{40,}`),'private-key'],
  [/gh[opsur]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{22,}/,'github-token'],
  [/(?:AKIA|ASIA)[0-9A-Z]{16}/,'aws-access-key'],
  [/\bsk-[A-Za-z0-9_-]{16,}/,'sk-token'],
  [/xox[abprs]-[A-Za-z0-9-]{8,}/,'slack-token'],
  [/AIza[0-9A-Za-z_-]{35}/,'google-api-key'],
  [/npm_[A-Za-z0-9]{36}/,'npm-token'],
];
export const credentialTextFinding=text=>textFinding(text);
// The label rules start with keyLabel, which needs "priv" in some case; a view without it cannot match them,
// so skip them (most files) instead of running the bounded-but-costly label scan on every byte.
const labelPatterns=new Set(secretText.map(([pattern])=>pattern).filter(pattern=>pattern.source.startsWith(keyLabel)));
const hasPriv=/priv/i;
const findSecretText=text=>{
  // Specific token shapes are tried before the label rules, so a token on the line after a label is named for
  // what it is (github-token), not for the label that happened to precede it.
  const specific=secretText.find(([pattern])=>!labelPatterns.has(pattern)&&pattern.test(text));
  if(specific)return specific[1];
  if(!hasPriv.test(text))return null;
  return secretText.find(([pattern])=>labelPatterns.has(pattern)&&pattern.test(text))?.[1]??null;
};
// Scan the text as written, then with label noise removed: zero-width characters, Markdown emphasis,
// HTML tags and non-breaking-space entities can sit inside "private key" without changing what it says.
// Numeric entities decode to their character; Unicode spaces (U+00A0, U+2003, ...) fold to a plain space.
// Emphasis marks are removed only when they do not join two word characters, so a glob such as private*key stays as is.
const decodeEntity=(match,hex,dec)=>{
  const code=hex?parseInt(hex,16):Number(dec);
  return code>=0&&code<=0x10ffff?String.fromCodePoint(code):match;
};
const labelNoise=text=>text.replace(/<\/?[A-Za-z][^<>\r\n]{0,40}>/g,'')
  .replace(/&#(?:x([0-9a-f]{1,6})|(\d{1,7}));/gi,decodeEntity)
  .replace(/&(?:nbsp|ensp|emsp|thinsp|quot);/gi,' ').replace(/&shy;/gi,'')
  .replace(/\p{Cf}/gu,'').replace(/[^\S\r\n]/g,' ')
  .replace(/(?<![A-Za-z0-9])[*~]+|[*~]+(?![A-Za-z0-9])/g,'');
// A key dumped as byte pairs (`ab 12 ab`, `ab:12:ab`, openssl -text with a line break after a colon) has no 32+
// hex run to match. Inside the FOLD_SPAN characters after each label, separators between two hex pairs are
// removed so the pairs join into one run. Only the span after a label is touched, so ordinary text is not.
const FOLD_SPAN=320;
const labelGlobal=new RegExp(keyLabel,'g');
// Only a token of exactly two hex digits is a byte: 4-digit numbers, dates and UUID groups are not joined. A per-byte
// prefix (0x, \x, %) is dropped first, so `0xab, 0x12` and `\xab\x12` fold like `ab 12`.
const bytePrefix=/(?<![0-9A-Za-z])0[xX](?=[0-9a-fA-F]{2}(?![0-9a-fA-F]))|(?:\\x|%)(?=[0-9a-fA-F]{2}(?![0-9a-fA-F]))/g;
const hexPairGap=/(?<![0-9a-fA-F])([0-9a-fA-F]{2})(?![0-9a-fA-F])(?:[ \t:,-]+(?:\r?\n[ \t:,-]*)?|\r?\n[ \t:,-]*)(?=[0-9a-fA-F]{2}(?![0-9a-fA-F]))/g;
const foldHex=text=>{
  let out='',copied=0;
  for(const match of text.matchAll(labelGlobal)) {
    const from=Math.max(match.index+match[0].length,copied),to=Math.min(match.index+match[0].length+FOLD_SPAN,text.length);
    if(from>=to)continue;
    out+=text.slice(copied,from)+text.slice(from,to).replace(bytePrefix,'').replace(hexPairGap,'$1');
    copied=to;
  }
  return copied?out+text.slice(copied):text;
};
const textFinding=text=>{
  const found=findSecretText(text);
  if(found)return found;
  const plain=labelNoise(text);
  const noise=plain===text?null:findSecretText(plain);
  if(noise)return noise;
  const folded=hasPriv.test(plain)?foldHex(plain):plain;
  return folded===plain?null:findSecretText(folded);
};
// R824/R825: in test files only, a name:value whose value is a code expression
// (arrow, leading paren, identifier call) is not a bare secret literal. Quoted
// strings are stripped first, so a literal that merely contains `(` still hits.
// Known token patterns run before this on the whole text and always hit.
// The skip never covers a value that carries a high-entropy token of its own (card x5b2hyl): a quoted literal
// beside a call (`f('<random>')`) and an unquoted token beside a call or arrow (`<random>(x)`) both keep the
// scan. Only short fixture words and identifiers (`'ghp_acceptance_fixture'`, `createHash`) are skipped.
function codeExpression(raw) {
  // Zero-width and other format characters split a token without changing how it reads; fold them away first.
  const value=raw.replace(/\p{Cf}/gu,'');
  let code='';
  const pieces=[];
  for(let i=0;i<value.length;i++) {
    const char=value[i];
    // Comments can contain misleading quotes or calls. Without a full parser,
    // refuse the exemption rather than interpreting their contents as code.
    if(char==='/'&&/[/*]/.test(value[i+1]??''))return false;
    if(!/["'`]/.test(char)) {code+=char;continue;}
    const quote=char;
    let closed=false,inner='';
    for(i++;i<value.length;i++) {
      if(value[i]===quote) {closed=true;break;}
      // Escapes, interpolation and partial multiline strings need a parser to
      // prove safe. Keep the original entropy rejection for these forms.
      if(value[i]==='\\'||(quote==='`'&&value[i]==='$'&&value[i+1]==='{'))return false;
      inner+=value[i];
    }
    if(!closed)return false;
    // A quoted literal that is opaque once whitespace is removed is a secret, whatever it sits beside.
    if(opaqueCode(inner.replace(/\s/g,''),inner))return false;
    pieces.push(inner);
    code+='\u0001';
  }
  // An unquoted opaque token (split at punctuation, so a chained secret piece still counts) keeps the scan.
  if(code.split(/[^\w$+/=-]+/).some(token=>opaqueCode(token)))return false;
  // A secret can be cut into short pieces (`'Xk9m...'+'R4tW...'`, `f(a.b)`, `f(x, y)`). The base scan reads the
  // value whole, so read the arguments whole too: drop call names and keywords, put every quoted literal back
  // in place, join what is left and test that. Fails closed: long argument lists with several digits also keep
  // the scan.
  let next=0;
  const args=code.replace(nonCallKeyword,' ').replace(/[A-Za-z_$][\w$]*(?=\s*\()/g,' ')
    .replace(/\u0001/g,()=>pieces[next++]);
  const joined=args.replace(/[^\w$+/=-]+/g,'');
  // `args` keeps the separators (as spaces) so the word-shape rule reads each piece as its own word: unquoted
  // pieces cut at `.` or `,` (`f(zgujkzpaen.sjbhrujdsb)`) join into one token the base scan flags.
  if(opaqueCode(joined,args.replace(/[^\w$+/=-]+/g,' ')))return false;
  // Quoted pieces joined without the surrounding code (identifiers around them would blur the word shape).
  if(pieces.length>1&&opaqueCode(pieces.join('').replace(/\s/g,''),pieces.join(' ')))return false;
  // Only an arrow or a call to a real identifier is a code expression. A bare paren, or a keyword before a
  // paren (`return (`, `typeof (`), only groups a literal, so it never proves the value is not a secret.
  return /=>|[A-Za-z_$][\w$]*\s*\(/.test(code.replace(nonCallKeyword,' '));
}
// A token inside a test-file code expression counts as a secret when it is long and either digit-bearing or
// very high entropy. Word-like fixtures and long camelCase identifiers (digit-free, entropy under ~4.1) pass.
const opaqueLiteral=token=>{
  if(token.length<20)return false;
  const bits=entropy(token);
  return bits>=3.5&&(bits>=4.3||(token.match(/\d/g)??[]).length>=3);
};
// The digit/entropy floor above lets a random 20+ char token with few digits (lowercase, mixed-case or hex-like,
// entropy 3.5-4.3) through, which the base scan flags. So inside a test-file code expression a long token also
// counts as a secret unless it reads as words: two or more letters-only segments (split at whitespace, `_`, `.`,
// `-` and camelCase humps), none over 14 letters, none with a 4-consonant run, and at most one without a vowel
// (`ghp` in `ghp_acceptance_fixture`). Random strings fail this almost always; a rare lowercase-and-separator
// token that happens to read as words still passes (residual, tracked in the card).
const wordLike=text=>{
  const segments=text.split(/[\s_.:-]+|(?<=[a-z])(?=[A-Z])/).filter(Boolean);
  if(segments.length<2)return false;
  let vowelless=0;
  for(const segment of segments) {
    if(!/^(?:[A-Za-z]{1,14}\d{0,3}|\d{1,3})$/.test(segment)||/[^aeiou\d]{4}/i.test(segment))return false;
    if(segment.length>1&&!/[aeiou]/i.test(segment)&&++vowelless>1)return false;
  }
  return true;
};
// A hex run is judged by length: 20+ hex chars with digits sit just under the 3.5-bit floor on their own.
const opaqueCode=(token,words=token)=>opaqueLiteral(token)||/^(?=(?:[a-f]*\d){3})[0-9a-f]{20,}$/i.test(token)
  ||(token.length>=20&&entropy(token)>=3.5&&!wordLike(words.replace(/[+/=$]+/g,' ')));
const nonCallKeyword=/(?<![\w$.])(?:return|typeof|await|void|yield|delete|throw|case|in|of|instanceof|if|while|for|switch|catch|with|else|do|new|async|function|class|import|super|this|default|let|const|var|extends|as|satisfies|static|get|set)(?![\w$])/g;
const opaqueToken=token=>token.length>=20&&entropy(token)>=3.5;
const maxExpressionValue=1024;
// Scan each supported byte view, including BOM-less UTF-16 in either byte order.
export function credentialBufferFinding(content) {
  for(const encoding of ['latin1','utf8','utf16le']) {
    const finding=textFinding(content.toString(encoding));
    if(finding)return finding;
  }
  // swap16 requires whole code units; a trailing byte cannot encode a token character.
  const swapped=Buffer.from(content.subarray(0,content.length-content.length%2)).swap16();
  return textFinding(swapped.toString('utf16le'));
}

function entropy(text) {
  // Count code points on both sides: UTF-16 length would dilute astral characters.
  const chars=[...text],counts=new Map();for(const char of chars)counts.set(char,(counts.get(char)??0)+1);
  return [...counts.values()].reduce((bits,n)=>bits-(n/chars.length)*Math.log2(n/chars.length),0);
}
// YAML parsers (libyaml/Psych) break lines at CR, LF, NEL, LS and PS. The separators are built
// from char codes: a literal U+2028/U+2029 in a regex literal is a JS syntax error.
const lineBreaks=`\r\n${String.fromCharCode(0x85,0x2028,0x2029)}`;
const assignmentLine=new RegExp(`(?:^|[${lineBreaks}])([\\t ]*)(?:-[\\t ]+)?["']?([A-Za-z_][A-Za-z0-9_.-]*)["']?[\\t ]*[:=][\\t ]*([^${lineBreaks}]*)`,'g');
const physicalTail=/[^\r\n]*/y;
const continuationRe=new RegExp(`[${lineBreaks}]([\\t ]*)([^${lineBreaks}]*)`,'y');
const maxContinuationLines=256;
// Escapes spell a credential the raw bytes never contain: YAML/JSON (\xNN, \uNNNN, \UNNNNNNNN, an escaped line
// break), JS (\u{...}, octal \NNN) and Markdown/shell (`ghp\_...`: a backslash that only quotes the next character).
// Decoding every backslash sequence over-approximates a parser: it can only add findings.
const escapeSequence=new RegExp(`\\\\(?:x([0-9A-Fa-f]{2})|u([0-9A-Fa-f]{4})|U([0-9A-Fa-f]{8})|u\\{([0-9A-Fa-f]{1,6})\\}|([0-7]{1,3})|(?:\\r\\n|[${lineBreaks}])[\\t ]*|([^]))`,'g');
const escapeChars={a:'\x07',b:'\b',t:'\t',n:'\n',v:'\v',f:'\f',r:'\r',e:'\x1b',N:'\x85',_:'\xa0',L:' ',P:' '};
const decodeEscapes=text=>text.replace(escapeSequence,(all,x,u,U,braced,octal,char)=>{
  const hex=x??u??U??braced;
  const point=hex?parseInt(hex,16):octal?parseInt(octal,8):null;
  if(point!==null)return point<=0x10ffff?String.fromCodePoint(point):all;
  return char===undefined?'':escapeChars[char]??char;
});
// Linear: three views of the same text (raw, decoded, backslashes dropped).
const decodedFinding=text=>textFinding(text)??textFinding(decodeEscapes(text))??textFinding(text.replace(/\\/g,''));
// Trimmed non-blank lines after `from` that are indented deeper than `indent`, up to the first
// line that is not. Returns null when more than maxContinuationLines remain (caller blocks).
function continuationLines(text,from,indent) {
  const lines=[];
  continuationRe.lastIndex=from;
  for(let m;(m=continuationRe.exec(text));) {
    if(m[2].trim()==='')continue;
    // `end` is where the block stops: the break before the first line that is not more indented.
    if(m[1].length<=indent)return Object.assign(lines,{end:m.index});
    if(lines.push(m[2].trim())>maxContinuationLines)return null;
  }
  return Object.assign(lines,{end:text.length});
}
// Credential formats and unreadable evidence block. Readable generic evidence is advisory.
export function credentialContentFinding(path,content) {
  // Unreadable bytes must never hide a credential in another decoded view.
  const raw=credentialBufferFinding(content);
  if(raw)return raw;
  let text;
  try {text=new TextDecoder('utf-8',{fatal:true}).decode(content);} catch {return 'unsupported-text-encoding';}
  if(text.includes('\0'))return 'unsupported-text-encoding';
  const escaped=decodedFinding(text);
  if(escaped)return escaped;
  const leaf=classifyManifestPath(path).names.at(-1);
  if(/\.json$/.test(leaf))return designTokenSecretFinding(content);
  // Block-only mode returns an unbounded continuation or a credential format split across scalar lines.
  return assignmentFinding(text,true,path);
}
// Field names are diagnostic data too; never echo a credential-bearing or unbounded name.
const findingField=field=>textFinding(field)||field.length>80?`field-sha256-${sha(field).slice(0,12)}`:field;
export function credentialContentWarning(path,content) {
  const leaf=classifyManifestPath(path).names.at(-1);
  if(/\.json$/.test(leaf))return designTokenSecretFinding(content,{warnings:true});
  let text;
  try {text=new TextDecoder('utf-8',{fatal:true}).decode(content);} catch {return null;}
  if(text.includes('\0'))return null;
  const finding=assignmentFinding(text,false,path);
  return /^(?:high-entropy|secret-assignment)-/.test(finding??'')?finding:null;
}
// blockOnly: report only blocking evidence (unbounded continuation); generic findings never mask it.
// `path` selects the test-file and source/prose exemptions (R824/R825); without it none applies.
function assignmentFinding(text,blockOnly=false,path='') {
  const leaf=path?classifyManifestPath(path).names.at(-1):'';
  const testSource=path?isTestFile(path):false;
  // YAML/INI/plain-text assignments, including quoted fields and YAML lists.
  // This advisory heuristic is not a parser for arbitrary formats.
  let joinedUntil=0;
  for(const match of text.matchAll(assignmentLine)) {
    const [,indent,field]=match;
    // `value` is the whole physical (CR/LF-bounded) value, including any text after a NEL/LS/PS
    // break; the match itself stops at that break so a second key on the same line is still seen.
    physicalTail.lastIndex=match.index+match[0].length;
    const tail=physicalTail.exec(text)[0],value=match[3]+tail;
    const trimmed=value.trim(),literal=/^(["'])(.*)\1$/.exec(trimmed)?.[2]??trimmed;
    // Only dotted context references (optionally joined by ||) prove that the
    // expression contains no literal credential. Unknown expression forms warn.
    // Raw token patterns above still apply, including inside the reference.
    const reference=/^\$\{\{\s*[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)+(?:\s*\|\|\s*[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)+)*\s*\}\}$/.test(literal);
    const credentialNamed=secretField.test(field);
    let continuation=[];
    if(reference||credentialNamed) {
      // More-indented following lines extend a YAML scalar (plain, quoted or block). Scan every
      // one, singly and joined (a folded scalar can split a secret across short lines).
      continuation=continuationLines(text,match.index+match[0].length+tail.length,indent.length);
      if(!continuation)return `unbounded-continuation-${findingField(field)}`;
      // A folded, plain or quoted multi-line scalar can split a credential format across lines.
      // A key nested inside an already-joined block is a substring of that join: scan each block once (linear).
      if(blockOnly&&continuation.length&&match.index>=joinedUntil) {
        const joined=decodedFinding(literal+continuation.join(''));
        if(joined)return joined;
        joinedUntil=continuation.end;
      }
      if(credentialNamed) {
        if(!blockOnly)for(const line of [...continuation,continuation.join('')]) {
          if(line.length>=20&&entropy(line)>=3.5&&!(testSource&&codeExpression(line)))return `high-entropy-${findingField(field)}`;
        }
      }
    }
    // A whole-value reference with no continuation line cannot hide a literal.
    if(reference&&!continuation.length)continue;
    // An unquoted value with internal whitespace is a code expression or a sentence, never one opaque secret
    // (`keys: [index], at: r.at });`). Contiguous and quoted values, and continuation lines above, keep the full rule.
    // Only source and prose files qualify (never YAML/INI, where `${{ 'literal' }}` is a real leak shape), and a quote
    // anywhere in the value keeps it scanned (apostrophes and, as code spans, backticks are allowed in .md prose only;
    // in source a backtick opens a template literal). A value that carries any single opaque token
    // (`<secret> # prod`, `<secret> (rotated)`, a backticked secret in prose) is a secret with a tail, not prose.
    // Quoted/backticked spans also keep the scan when their content is opaque after removing whitespace;
    // word boundaries apply to the apostrophe only (they stop prose contractions from forming spans); a backtick
    // span is valid Markdown glued to word characters (x`secret`y), so it takes no boundary. The two span kinds are
    // matched in separate passes so one kind cannot consume the other's delimiter (`'a `b' <secret>` `), and a backtick
    // span closes on a run of the same length (``a`b``), so a literal backtick inside cannot split it into short halves.
    // Boundaries pinned in forge-scan-code-expression.test.mjs (whitespace-exemption boundaries).
    // Span content uses [^] (not `.`) so U+2028/U+2029 inside a span cannot end it. The span passes are lazy and
    // quadratic on unclosed quotes, so a value over maxExpressionValue keeps the full scan (fail closed). The
    // concatenation of all span contents is also tested, so a credential split across spans (`a` `b`) cannot hide in
    // pieces under the length floor. A stray backtick that pairs away the real opener leaves a bare spaced value,
    // which the exemption already accepts by design.
    const spans=trimmed.length>maxExpressionValue?null:[
      ...[...trimmed.matchAll(/(?<!\w)'([^]+?)'(?!\w)/g)].map(m=>m[1]),
      ...[...trimmed.matchAll(/(?<!`)(`+)(?!`)([^]+?)(?<!`)\1(?!`)/g)].map(m=>m[2])].map(span=>span.replace(/\s/g,''));
    const expression=spans!==null&&/\.(?:mjs|cjs|js|mts|ts|md)$/.test(leaf)&&!trimmed.includes('${{')&&/\s/.test(trimmed)
      &&!(leaf.endsWith('.md')?/["]/:/["'`]/).test(trimmed)&&!trimmed.split(/\s+/).some(opaqueToken)
      &&![...spans,spans.join('')].some(opaqueToken);
    if(blockOnly)continue;
    if(credentialNamed&&!expression&&value.length>=20&&entropy(value)>=3.5&&!(testSource&&codeExpression(value)))return `high-entropy-${findingField(field)}`;
    if(/password|passwd|secret|token|api[_-]?key/i.test(field)) {
      // Only whole, explicit placeholders qualify; mixed expressions do not.
      if(!/^(?:example|<placeholder>|<redacted>|\[REDACTED\])?$/i.test(literal))return `secret-assignment-${findingField(field)}`;
    }
  }
  return null;
}
// Scan decoded JSON literals as well as raw text; duplicate keys remain visible.
export function designTokenSecretFinding(content,{warnings=false}={}) {
  let text;
  try {text=new TextDecoder('utf-8',{fatal:true}).decode(content);} catch {return warnings?null:credentialBufferFinding(content)??'unsupported-text-encoding';}
  if(!warnings) {
    const raw=textFinding(text);
    if(raw)return raw;
    // Inspect decoded literals too, including duplicate fields and malformed documents.
    for(const [literal] of text.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
      let value;try {value=JSON.parse(literal);} catch {continue;}
      const decoded=textFinding(value);if(decoded)return decoded;
    }
  }
  if(text.includes('\0'))return warnings?null:'unsupported-text-encoding';
  let json;
  try {json=JSON.parse(text);} catch {return warnings?null:'unparseable-json';}
  if(!json||typeof json!=='object'||Array.isArray(json))return warnings?null:'non-object-json';
  if(!warnings)return null;
  // Scan every string literal in the raw bytes, decoded, in order. JSON.parse
  // keeps only the last duplicate property, so its object view is never used.
  // A secret-named field taints every string nested under it (arrays, objects).
  const stack=[false];let field;
  for(const [token,literal,colon] of text.matchAll(/("(?:[^"\\]|\\.)*")(\s*:)?|[{}[\],]/g)) {
    if(!literal) {
      if(token==='{'||token==='[')stack.push(stack.at(-1)||(field!==undefined&&secretField.test(field)));
      else if(token!==',')stack.pop();
      field=undefined;continue;
    }
    const value=JSON.parse(literal);
    // Under a tainted container, property names are secret candidates too.
    if(colon&&stack.at(-1)&&value.length>=20&&entropy(value)>=3.5)return 'high-entropy-nested-key';
    if(colon) {field=value;continue;}
    const name=field!==undefined&&secretField.test(field)?field:stack.at(-1)?'nested':null;
    if(name&&value.length>=20&&entropy(value)>=3.5)return `high-entropy-${findingField(name)}`;
    field=undefined;
  }
  return null;
}

// Pure policy and leaf construction are shared by inventory, warm export and delta.
export function classifyManifestPath(path) {
  const parts=pathParts(path),names=parts.map(normalizedComponent);
  const excluded=names.some((name,i)=>excludedComponent(name,i===names.length-1));
  // Excluded ONLY because of a credential-looking name (see R321 above).
  const credentialSource=excluded && !names.some((name,i)=>excludedComponent(name,i===names.length-1,true));
  return {parts,names,excluded,credentialSource};
}
// Warnings are bounded, scrubbed diagnostics and must never affect dispatch.
export function warnCredential(onWarning,path,finding) {
  if(!onWarning||!finding)return;
  let detail=`${path}: ${finding}`;
  for(const [pattern] of secretText)detail=detail.replace(new RegExp(pattern.source,'g'),value=>`[sha256:${sha(value).slice(0,12)}]`);
  detail=detail.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g,'?').slice(0,4096);
  try {onWarning('credential-warn',detail);} catch { /* advisory only */ }
}
export function manifestEntry(path,content,executable,tracked,onWarning) {
  pathParts(path);
  if(typeof tracked!=='boolean')throw new Error('Missing manifest tracking evidence');
  if(classifyManifestPath(path).credentialSource) {
    const finding=tracked?credentialContentFinding(path,content):'untracked';
    if(finding)throw Object.assign(new Error(`Excluded credential-named file (${finding}): use local fallback`),{code:'excluded-source-file'});
    warnCredential(onWarning,path.toString('utf8'),credentialContentWarning(path,content));
  }
  return {path,sha256:sha(content),executable,tracked};
}
export function decodeManifest(manifest) {
  if(!manifest || manifest.v!==2 || Object.keys(manifest).sort().join(',')!=='excluded,executable,hashes,paths,tracked,v'
    || Buffer.byteLength(JSON.stringify(manifest))>LIMIT)throw new Error('Invalid base manifest; use full ship');
  const decode=value=>{
    if(typeof value!=='string')throw new Error('Invalid base manifest paths');
    const bytes=Buffer.from(value,'base64');if(bytes.toString('base64')!==value)throw new Error('Invalid base manifest encoding');
    const paths=splitPaths(bytes);
    for(let i=1;i<paths.length;i++)if(Buffer.compare(paths[i-1],paths[i])>=0)throw new Error('Invalid base manifest order');
    return paths;
  };
  const paths=decode(manifest.paths),excluded=decode(manifest.excluded);
  if(!Array.isArray(manifest.hashes)||!Array.isArray(manifest.executable)||!Array.isArray(manifest.tracked)
    ||paths.length!==manifest.hashes.length||paths.length!==manifest.executable.length||paths.length!==manifest.tracked.length
    ||!manifest.hashes.every(h=>typeof h==='string'&&/^[a-f0-9]{64}$/.test(h))||!manifest.executable.every(v=>typeof v==='boolean')
    ||!manifest.tracked.every(v=>typeof v==='boolean'))throw new Error('Invalid base manifest entries');
  validateTestNames(paths);
  const keys=new Set(paths.map(p=>p.toString('hex')));
  if(excluded.some(p=>keys.has(p.toString('hex'))||isTestFile(p)))throw new Error('Invalid base exclusions');
  return {entries:paths.map((path,i)=>({path,sha256:manifest.hashes[i],executable:manifest.executable[i],tracked:manifest.tracked[i]})),excluded};
}
// Decode Git's byte-safe tree protocol. Only policy-excluded paths may have
// non-regular modes; retain them so callers record the same exclusions as full ship.
// The delta reader may retain links as inventory evidence, never reusable blobs.
// Warm export keeps the default refusal for non-excluded links.
export function parseGitTree(bytes, {sizes = false, links = false} = {}) {
  if(!Buffer.isBuffer(bytes)||bytes.length>LIMIT||(bytes.length&&bytes.at(-1)!==0))throw new Error('Invalid git tree');
  const entries=[];let start=0;
  for(let i=0;i<bytes.length;i++)if(bytes[i]===0){
    const record=bytes.subarray(start,i),tab=record.indexOf(9),header=record.subarray(0,tab).toString('ascii');
    const pattern=sizes ? /^\d{6} (?:blob|tree|commit) [a-f0-9]{40}(?:[a-f0-9]{24})? +(?:[0-9]+|-)$/ : /^\d{6} (?:blob|tree|commit) [a-f0-9]{40}(?:[a-f0-9]{24})?$/;
    if(tab<0||!pattern.test(header))throw new Error('Unsupported git tree mode');
    const path=record.subarray(tab+1),policy=classifyManifestPath(path);
    const excluded=(policy.excluded&&!policy.credentialSource)||policy.names.includes('node_modules');
    const symlink=/^120000 blob /.test(header);
    if(!excluded&&!/^100(?:644|755) blob /.test(header)&&!(links&&symlink))throw new Error('Unsupported git tree mode');
    const [mode,,oid,size]=header.split(/ +/);
    if(sizes && size!=='-' && !Number.isSafeInteger(Number(size)))throw new Error('Invalid git blob size');
    entries.push({path,oid,executable:mode==='100755',...(links&&symlink?{symlink:true}:{}),...(sizes?{size:size==='-'?null:Number(size)}:{})});start=i+1;
  }
  return entries;
}

// Porcelain -z emits destination first, then source for rename/copy records.
// Keep both byte paths: either side may have existed in the warm snapshot.
export function parseGitStatus(bytes) {
  const fields=splitPaths(bytes),paths=[];
  for(let i=0;i<fields.length;i++) {
    const record=fields[i],status=record.subarray(0,2).toString('latin1');
    if(record.length<4 || record[2]!==32 || !/^(?:[ MADRCUT?!]{2})$/.test(status) || status==='  ')
      throw new Error('Invalid git status');
    const path=record.subarray(3);pathParts(path);paths.push(path);
    if(/[RC]/.test(status)) {
      if(!fields[++i])throw new Error('Truncated git rename/copy');
      paths.push(fields[i]);
    }
  }
  return paths;
}
