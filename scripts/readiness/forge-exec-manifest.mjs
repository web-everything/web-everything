import {createHash} from 'node:crypto';
import {isAscii} from 'node:buffer';
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
export const secretText=[
  [new RegExp('-----'+'BEGIN'),'pem-header'],
  [new RegExp('PRIVATE'+' KEY','i'),'private-key'],
  [/gh[opsur]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{22,}/,'github-token'],
  [/(?:AKIA|ASIA)[0-9A-Z]{16}/,'aws-access-key'],
  [/\bsk-[A-Za-z0-9_-]{16,}/,'sk-token'],
  [/xox[abprs]-[A-Za-z0-9-]{8,}/,'slack-token'],
  [/AIza[0-9A-Za-z_-]{35}/,'google-api-key'],
  [/npm_[A-Za-z0-9]{36}/,'npm-token'],
];
export const credentialTextFinding=text=>textFinding(text);
const textFinding=text=>secretText.find(([pattern])=>pattern.test(text))?.[1]??null;
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
// Forge manifest scan, Layer A: recognise STRUCTURED private-key material by decoding, with no label needed.
// Private bytes must never ship to Forge, so this is additive only and never allowlistable (S1 of
// plan:forge-key-structure). It sits beside, never instead of, the pem-header and private-key rules.
//
// How: build linear "squeezed" views of the text (base64, base64url, hex, decimal byte arrays), decode each to
// bytes at every alignment, then do signature search, bounded DER parsing and a scoped JWK check.
// There is no variable-gap regex, so the cost is linear in the input (inputs are capped upstream at 3 MiB a blob).
//
// The signatures are stored reversed, as hex, and re-assembled at runtime. Stored forward they would be a
// private-key structure themselves and this very file would block its own shipment to Forge.
const KEY_STRUCTURE_FINDING='private-key-structure';
const unreverse=hex=>Buffer.from([...hex].reverse().join(''),'hex');
const SIGNATURES=[
  // PKCS#8: AlgorithmIdentifier followed by OCTET STRING, independent of the version.
  // Other parameters, curves and length forms are recognized by hasPkcs8PrivateKey below.
  '024022400756b230605003','02402240e656b230605003',
  '40701030d3ec8468a280601020d3ec8468a270603103',
  '4022004018b250601020d3ec8468a270600103','4032004018b250601020d3ec8468a270600103',
  // Encrypted PKCS#8 (EncryptedPrivateKeyInfo): PKCS#5 PBE/PBES2 algorithm OID
  '5010d07f688468a29060',
  // SEC1 ECPrivateKey requires version 1 (RFC 5915); optional parameters/publicKey follow
  // the private OCTET STRING and are deliberately absent from these 32/48/66-byte signatures.
  '0240101020','0340101020','2440101020',
  // OpenSSH key-v1 magic (with NUL) precedes optional cipher/KDF fields. PuTTY's header
  // prefix ends before its format version, so neither signature pins optional fields.
  '001367d29756b6d2863737e65607f6','d256c69664d29756b4d227563755d29545455705',
].map(unreverse);
const JWK_TYPE=/^(?:RSA|EC|OKP|oct)$/;
const JWK_MEMBER=/^(?:d|p|q|dp|dq|qi|k)$/;
const mayHaveJwkValue=text=>/[A-Za-z0-9_-]{22}/.test(text.replace(/\s/g,''));
// Escapes can spell every member and value, so raw-text hints cannot reject escaped candidates.
const mayHaveJwkText=text=>text.includes('\\')||text.includes('kty')&&mayHaveJwkValue(text);
// Tokenize strings and comments whole so their braces cannot change object scope. Unclosed block
// comments consume the remaining text, avoiding repeated suffix scans on malformed input.
const JWK_DATA_TOKEN=/"(?:[^"\\]|\\[^])*(?:"|\\?$)|'(?:[^'\\]|\\[^])*(?:'|\\?$)|`(?:[^`\\]|\\[^])*(?:`|\\?$)|[{}[\]:,]|[^\s{}[\]:,"'`\\/]+/g;
const JWK_TOKEN=new RegExp(String.raw`/\*[^]*?(?:\*/|$)|//[^\r\n\u2028\u2029]*|${JWK_DATA_TOKEN.source}`,'g');

// Read one bounded DER element without copying its body. Reject truncated and indefinite lengths.
function derElement(bytes,start,limit) {
  if(start+2>limit)return null;
  const tag=bytes[start++];
  let length=bytes[start++];
  if(length&0x80) {
    const count=length&0x7f;
    if(count===0||count>4||start+count>limit)return null;
    length=0;
    for(let i=0;i<count;i++)length=length*256+bytes[start++];
  }
  return start+length<=limit?{tag,start,end:start+length,length}:null;
}
// DSA/DH AlgorithmIdentifiers are shared by SPKI public keys. Require the PKCS#8
// version, AlgorithmIdentifier and private OCTET STRING instead of a bare OID.
const DSA_DH_OIDS=['104083ec8468a27060','103010d07f688468a29060'].map(unreverse);
function hasDsaDhPrivateKey(bytes) {
  if(!DSA_DH_OIDS.some(oid=>bytes.includes(oid)))return false;
  for(let start=0;start<bytes.length;start++) {
    if(bytes[start]!==0x30)continue;
    const sequence=derElement(bytes,start,bytes.length);
    if(!sequence)continue;
    const version=derElement(bytes,sequence.start,sequence.end);
    if(!version||version.tag!==2||version.length!==1||bytes[version.start]>1)continue;
    const algorithm=derElement(bytes,version.end,sequence.end);
    if(!algorithm||algorithm.tag!==0x30)continue;
    const oid=derElement(bytes,algorithm.start,algorithm.end);
    if(!oid||!DSA_DH_OIDS.some(value=>bytes.subarray(algorithm.start,oid.end).equals(value)))continue;
    const privateKey=derElement(bytes,algorithm.end,sequence.end);
    if(privateKey?.tag===4&&privateKey.length>0)return true;
  }
  return false;
}
const PKCS8_OIDS=new Set(['2b6570','2b656e','2a8648ce3d0201','2a864886f70d010101','2b6571','2b656f']);
// PrivateKeyInfo / OneAsymmetricKey: version, AlgorithmIdentifier, privateKey OCTET STRING.
// Accept versions 0..2 conservatively. Algorithm parameters and trailing attributes/publicKey
// are optional: skip their bodies rather than pinning their presence or a curve-specific size.
// Each candidate reads five bounded DER headers and at most nine OID bytes, never key bodies.
function hasPkcs8PrivateKey(bytes) {
  const first=bytes.indexOf(0x30);
  if(first<0)return false;
  for(let start=first;start<bytes.length;start++) {
    if(bytes[start]!==0x30)continue;
    const length=bytes[start+1];
    if(length<12)continue;
    const headerLength=length<128?2:2+(length&0x7f);
    if(bytes[start+headerLength]!==2)continue;
    const sequence=derElement(bytes,start,bytes.length);
    if(!sequence)continue;
    const version=derElement(bytes,sequence.start,sequence.end);
    if(!version||version.tag!==2||version.length!==1||bytes[version.start]>2)continue;
    const algorithm=derElement(bytes,version.end,sequence.end);
    if(!algorithm||algorithm.tag!==0x30)continue;
    const oid=derElement(bytes,algorithm.start,algorithm.end);
    if(!oid||oid.tag!==6||oid.length>9||!PKCS8_OIDS.has(bytes.toString('hex',oid.start,oid.end)))continue;
    const key=derElement(bytes,algorithm.end,sequence.end);
    if(key?.tag===4)return true;
  }
  return false;
}
// RSA modulus lengths are not an enumeration. Require a complete SEQUENCE containing the version
// and eight positive INTEGERs of RSAPrivateKey (also present in multi-prime version 1). Headers alone
// occur in truncated fixtures; unrelated decimal literals can also resemble INTEGERs without a SEQUENCE.
// Each candidate reads a fixed number of headers of at most six bytes; INTEGER bodies are skipped.
function hasRsaPrivateKey(bytes) {
  // RSA needs both a SEQUENCE and an INTEGER after it. Native searches reject
  // impossible views (including long decimal lists) without a per-byte JS walk.
  const first=bytes.indexOf(0x30);
  if(first<0||!bytes.includes(2,first+2))return false;
  // Dense non-key views (for example hex `30 30 ...`) must not make a native
  // Buffer search and allocate DER headers for every byte. Walk candidates in JS
  // and check for the required INTEGER tag before parsing either header.
  for(let start=first;start<bytes.length;start++) {
    if(bytes[start]!==0x30)continue;
    const length=bytes[start+1];
    // Version plus eight positive integers (a two-byte modulus) need 28 bytes.
    if(length<28)continue;
    const headerLength=length<128?2:2+(length&0x7f);
    if(bytes[start+headerLength]!==2)continue;
    const sequence=derElement(bytes,start,bytes.length);
    if(!sequence)continue;
    const version=derElement(bytes,sequence.start,sequence.end);
    if(!version||version.tag!==2||version.length!==1||bytes[version.start]>1)continue;
    let offset=version.end,integers=0;
    for(;integers<8;integers++) {
      const integer=derElement(bytes,offset,sequence.end);
      if(!integer||integer.tag!==2||integer.length===0||bytes[integer.start]&0x80
        ||integer.length===1&&bytes[integer.start]===0||integers===0&&integer.length<2)break;
      offset=integer.end;
    }
    if(integers===8)return true;
  }
  return false;
}
const hasSignature=bytes=>SIGNATURES.some(signature=>bytes.includes(signature))||hasPkcs8PrivateKey(bytes)||hasRsaPrivateKey(bytes)||hasDsaDhPrivateKey(bytes);
// Require an exact private member and a known kty in the SAME object, in either order. Keep duplicate
// members visible, including in JS-style objects; JSON.parse would discard earlier duplicate members.
function hasJwkSecret(bytes) {
  if(!bytes.includes('kty')&&!bytes.includes('\\'))return false;
  let text;
  try {text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);} catch {text=bytes.toString('latin1');}
  return hasJwkSecretText(text);
}
function hasJwkSecretText(text,recent) {
  // An object needs a literal opening brace, or a quoted token that can decode to one.
  // Check scope before squeezing whitespace for the value hint: object-free decoded
  // escape views can contain millions of short member/type tokens, but no object.
  if(!text.includes('{')&&!text.includes('"')&&!text.includes("'")&&!text.includes('`'))return false;
  if(!text.includes('{')) {
    if(!text.includes('\\'))return false;
    // This view only proves absence; tokenize the original to preserve string/object scope.
    // Remaining backslashes may encode another layer, so they must keep the full parser.
    const decoded=decodeEscapes(text,recent);
    if(!decoded.includes('{')&&!decoded.includes('\\'))return false;
  }
  if(!mayHaveJwkText(text))return false;
  const pending=[{text,comments:true}];
  while(pending.length) {
    const stack=[],candidate=pending.pop();
    for(const [token] of candidate.text.matchAll(candidate.comments?JWK_TOKEN:JWK_DATA_TOKEN)) {
      if(token.startsWith('//')||token.startsWith('/*')) {
        // Parse a comment body as data once. Reinterpreting nested comment markers could repeatedly
        // scan almost the same suffix on inputs such as many slashes followed by an object.
        if(token.includes('{')&&mayHaveJwkText(token))pending.push({text:token.slice(2,token.endsWith('*/')?-2:undefined),comments:false});
        continue;
      }
      if(token==='{'||token==='[') {
        const parent=stack.at(-1);
        if(parent?.computed)parent.invalid=true;
        stack.push({object:token==='{',computed:token==='['&&parent?.object&&!parent.value,
          type:false,secret:false});
        continue;
      }
      if(token==='}'||token===']') {
        const closed=stack.pop(),parent=stack.at(-1);
        // Only a single quoted literal in a property-position bracket supplies an object member.
        // Arrays used as values and nested objects keep their own scope.
        if(token===']'&&closed?.computed&&parent?.object)
          parent.member=closed.invalid?undefined:closed.literal;
        continue;
      }
      const quoted=token[0]==='"'||token[0]==="'"||token[0]==='`';
      // Outside an object, only a complete serialized JWK can contribute a finding. Its private
      // value alone needs 22 characters; decoding shorter strings cannot supply one. Avoid a
      // decoded-string allocation per escaped property name in object-free adversarial text.
      if(!stack.length&&(!quoted||token.length<24))continue;
      // Decode within whole string tokens so escaped quotes/braces cannot alter the enclosing scope.
      const value=quoted?decodeEscapes(token.slice(1,-1)):token;
      // A serialized object is its own scope: never combine its members with the enclosing object.
      if(quoted&&value.includes('{')&&mayHaveJwkText(value))pending.push({text:value,comments:true});
      const frame=stack.at(-1);
      if(frame?.computed) {
        if(!quoted||frame.literal!==undefined)frame.invalid=true;
        else frame.literal=value;
        continue;
      }
      if(!frame?.object)continue;
      if(token===',') {frame.member=undefined;frame.value=false;continue;}
      if(token===':') {frame.value=true;continue;}
      if(!frame.value) {frame.member=value;continue;}
      if(frame.member==='kty'&&JWK_TYPE.test(value))frame.type=true;
      if(JWK_MEMBER.test(frame.member)&&quoted&&/^[A-Za-z0-9_-]{22,}/.test(value.replace(/\s/g,'')))frame.secret=true;
      frame.member=undefined;frame.value=false;
      if(frame.type&&frame.secret)return true;
    }
  }
  return false;
}
const hasKey=bytes=>hasSignature(bytes)||hasJwkSecret(bytes);

// Drop whole-line and trailing comments (a marker followed by whitespace) so a comment inside a wrapped body
// cannot split it. Returns the text unchanged when there is none.
function stripComments(text) {
  return text.replace(/^[ \t]*(?:#|\/\/|;|\*)[ \t].*$/gm,'').replace(/[ \t](?:#|\/\/)[ \t].*$/gm,'');
}
function* decodeAligned(view,encoding,alignments,recent) {
  const previous=recent.get(encoding)??[];
  // Different escape/byte views often squeeze to identical input. Reuse only exact matches,
  // including the encoding and every alignment, within this one public scan.
  if(previous.includes(view))return;
  recent.set(encoding,[view,...previous.slice(0,1)]);
  // Scan one alignment at a time rather than retaining four multi-megabyte buffers.
  for(let skip=0;skip<alignments;skip++)yield Buffer.from(view.slice(skip),encoding);
}
const alphabetTable=()=>{
  const table=new Uint8Array(128);
  for(const [alphabet,mask] of [
    ['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',1],
    ['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-',2],
    ['0123456789abcdefABCDEF',4],
  ])for(const char of alphabet)table[char.charCodeAt(0)]|=mask;
  return table;
};
const encodedAlphabets=alphabetTable();
const decimalWord=code=>code>=48&&code<=57||code>=65&&code<=90||code>=97&&code<=122||code===95;
// Build all alphabet views in one pass. Escape-heavy blobs otherwise repeat this full-input
// character walk for each alphabet in the raw, decoded and backslash-dropped text views.
// Write filtered bytes directly: regex replacements retain millions of small string pieces.
function squeezedViews(text) {
  const b64=Buffer.allocUnsafe(text.length),hex=Buffer.allocUnsafe(text.length);
  const url=/[+/_-]/.test(text)?Buffer.allocUnsafe(text.length):null;
  let b64Length=0,urlLength=0,hexLength=0;
  for(let i=0;i<text.length;i++) {
    const code=text.charCodeAt(i),mask=code<128?encodedAlphabets[code]:0;
    if(mask&1)b64[b64Length++]=code;
    if(url&&(mask&2))url[urlLength++]=code;
    // Only the hex view drops 0x/0X prefixes. The x is outside the hex alphabet;
    // both characters must still reach the base64 views.
    if((mask&4)&&!(code===48&&(text[i+1]==='x'||text[i+1]==='X')))hex[hexLength++]=code;
  }
  const base64=b64.toString('latin1',0,b64Length);
  return {base64,base64url:url?url.toString('latin1',0,urlLength):base64,hex:hex.toString('latin1',0,hexLength)};
}
function* decodedBuffers(text,recent) {
  // Backslashes belong to none of the encoded alphabets. Reuse the filtered views
  // when a later escape view only drops them, rather than filtering megabytes again.
  // Removing a backslash between 0 and x/X creates a hex prefix, so that case must
  // be filtered independently. Exact string equality keeps all other changes visible.
  const previous=recent.get('squeezed')??[];
  const cached=previous.find(entry=>entry.text===text||entry.equivalent===text)??{text};
  cached.views??=squeezedViews(text);
  if(!previous.includes(cached))recent.set('squeezed',[cached,...previous.slice(0,1)]);
  const {base64:b64,base64url:b64url,hex}=cached.views;
  if(b64.length>=16)yield* decodeAligned(b64,'base64',4,recent);
  if(b64url!==b64&&b64url.length>=16)yield* decodeAligned(b64url,'base64url',4,recent);
  if(hex.length>=16)yield* decodeAligned(hex,'hex',2,recent);
  // Most source/escape views have no standalone decimal byte at all (for example x41
  // and u0041). Reject those in native code before allocating another full-sized buffer
  // and walking every character in JS. Range validation remains in the parser below.
  if(!/(?:^|[^\w.+-])-?\d{1,3}(?![\w.])/.test(text))return;
  const bytes=Buffer.allocUnsafe(text.length);let length=0;
  // Match decimal-byte boundaries without allocating a regex match array and
  // substring for each number in a multi-megabyte byte list.
  for(let i=0;i<text.length;i++) {
    const negative=text.charCodeAt(i)===45;
    let end=i+(negative?1:0),code=text.charCodeAt(end);
    if(!(code>=48&&code<=57))continue;
    const before=text.charCodeAt(i-1);
    if(decimalWord(before)||before===46||before===43||before===45)continue;
    let value=0,count=0;
    do {
      value=value*10+code-48;
      code=text.charCodeAt(++end);
    } while(++count<3&&code>=48&&code<=57);
    i=end-1;
    if(decimalWord(code)||code===46)continue;
    if(negative)value=-value;
    if(value>=-128&&value<=255)bytes[length++]=(value+256)%256;
  }
  if(length>=8)yield bytes.subarray(0,length);
}
function scanText(text,recent,onDecoded) {
  // Every supported text representation needs ASCII letters, digits or encoding punctuation.
  // UTF-16 views of ordinary ASCII bytes often contain none; avoid allocating empty filtered views.
  if(text.length<8||!/[A-Za-z0-9+/_-]/.test(text))return false;
  if(hasJwkSecretText(text,recent))return true;
  const stripped=stripComments(text);
  if(stripped!==text&&hasJwkSecretText(stripped,recent))return true;
  // The shortest decoded view needs eight decimal bytes (the hex/base64 views need sixteen
  // alphabet characters). Sparse punctuation cannot produce one: use native searches before
  // allocating and filtering several full-sized views. JWK parsing above is independent.
  const encodedChar=/[A-Za-z0-9+/_-]/g;
  for(let count=0;count<8;count++)if(!encodedChar.test(text))return false;
  for(const variant of stripped===text?[text]:[text,stripped])
    for(const bytes of decodedBuffers(variant,recent)) {
      onDecoded?.(bytes);
      if(hasKey(bytes))return true;
    }
  return false;
}
function textViews(content) {
  const texts=new Set([content.toString('latin1')]);
  // ASCII has identical Latin-1 and UTF-8 views. Avoid allocating the same large string twice.
  if(!isAscii(content))texts.add(content.toString('utf8'));
  // Every signature and credential syntax uses ASCII. UTF-16 can contain an ASCII code unit
  // only when one of its bytes is zero; without one neither byte order can add a finding.
  if(content.includes(0)) {
    texts.add(content.toString('utf16le'));
    const swapped=Buffer.from(content.subarray(0,content.length-content.length%2)).swap16();
    texts.add(swapped.toString('utf16le'));
  }
  return texts;
}
// content: Buffer. True when a structured key hides in the raw bytes or in any decoded text view.
function privateKeyStructureFinding(content,{escapes=false,recent=new Map(),onDecoded}={}) {
  if(!Buffer.isBuffer(content))return null;
  // JWKs are checked by scanText in the lossless Latin-1 and UTF-8 views below.
  if(hasSignature(content))return KEY_STRUCTURE_FINDING;
  for(const text of textViews(content)) {
    if(scanText(text,recent,onDecoded))return KEY_STRUCTURE_FINDING;
    // Ordinary manifest paths use only this detector, so retain escape-decoded views without
    // consulting legacy text/JSON policy. Recursive calls leave escape expansion disabled.
    if(escapes&&text.includes('\\'))
      for(const view of new Set([decodeEscapes(text,recent),withoutBackslashes(text,recent)]))
        if(view!==text&&decodedStructureFinding(view,recent,onDecoded))return KEY_STRUCTURE_FINDING;
  }
  return null;
}
// Escaped byte strings use code units 0..255 (including DER bytes above 127).
// UTF-8 alone changes those bytes. Keep both interpretations as additional inputs;
// recursive scans do not expand escapes again, so work stays bounded per view.
function decodedStructureFinding(text,recent=new Map(),onDecoded) {
  return privateKeyStructureFinding(Buffer.from(text,'latin1'),{recent,onDecoded})
    ??(/[^\x00-\x7f]/.test(text)?privateKeyStructureFinding(Buffer.from(text,'utf8'),{recent,onDecoded}):null);
}
// Scan each supported byte view, including BOM-less UTF-16 in either byte order.
function legacyBufferFinding(content) {
  for(const text of textViews(content)) {
    const finding=textFinding(text);
    if(finding)return finding;
  }
  return null;
}
export function credentialBufferFinding(content) {
  // Additive: structured keys with no label, found by decoding (never allowlistable).
  return legacyBufferFinding(content)??privateKeyStructureFinding(content,{escapes:true});
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
const escapeChars={a:7,b:8,t:9,n:10,v:11,f:12,r:13,e:27,N:0x85,_:0xa0,L:0x2028,P:0x2029};
const hexDigit=code=>code>=48&&code<=57?code-48:code>=65&&code<=70?code-55:code>=97&&code<=102?code-87:-1;
function decodeEscapes(text,recent) {
  if(!text.includes('\\'))return text;
  // Public scanners share this bounded cache only for whole-text views. Token
  // decoding stays uncached so tiny JWK members cannot evict a large escape view.
  const previous=recent?.get('escapes')??[];
  const cached=previous.find(entry=>entry.text===text);
  if(cached)return cached.decoded;
  // Decoding cannot grow the UTF-16 input. Write code units directly, avoiding a match array and
  // several short strings per escape (millions of allocations on an escape-heavy 3 MiB blob).
  const bytes=Buffer.allocUnsafe(text.length*2);let length=0;
  for(let i=0;i<text.length;i++) {
    let point=text.charCodeAt(i);
    if(point===92&&i+1<text.length) {
      const start=i,char=text[++i];
      if(char==='"'||char==="'"||char==='`'||char==='\\') {
        bytes[length++]=text.charCodeAt(i);bytes[length++]=0;
        continue;
      }
      point=escapeChars[char]??text.charCodeAt(i);
      if(char==='x'||char==='u'||char==='U') {
        const braced=char==='u'&&text[i+1]==='{';
        const digits=braced?6:char==='x'?2:char==='u'?4:8;
        let end=i+(braced?2:1),value=0,count=0;
        for(;count<digits&&end<text.length;end++,count++) {
          const digit=hexDigit(text.charCodeAt(end));
          if(digit<0)break;
          value=value*16+digit;
        }
        if(braced?count>0&&text[end]==='}':count===digits) {
          i=braced?end:end-1;
          if(value<=0x10ffff)point=value;
          else {
            // Invalid Unicode scalar escapes were preserved literally by the original decoder.
            for(let j=start;j<=i;j++) {
              const code=text.charCodeAt(j);bytes[length++]=code;bytes[length++]=code>>>8;
            }
            continue;
          }
        }
      } else if(char>='0'&&char<='7') {
        point=char.charCodeAt(0)-48;
        for(let count=1;count<3&&text[i+1]>='0'&&text[i+1]<='7';count++)point=point*8+text.charCodeAt(++i)-48;
      } else if(lineBreaks.includes(char)) {
        if(char==='\r'&&text[i+1]==='\n')i++;
        while(text[i+1]===' '||text[i+1]==='\t')i++;
        continue;
      }
    }
    if(point>0xffff) {
      const high=0xd800+((point-0x10000)>>>10);
      bytes[length++]=high;bytes[length++]=high>>>8;
      point=0xdc00+((point-0x10000)&0x3ff);
    }
    bytes[length++]=point;bytes[length++]=point>>>8;
  }
  const decoded=bytes.toString('utf16le',0,length);
  if(recent)recent.set('escapes',[{text,decoded},...previous.slice(0,1)]);
  return decoded;
}
function withoutBackslashes(text,recent) {
  if(!text.includes('\\'))return text;
  const bytes=Buffer.allocUnsafe(text.length*2);let length=0;
  for(let i=0;i<text.length;i++) {
    const code=text.charCodeAt(i);
    if(code===92)continue;
    bytes[length++]=code;bytes[length++]=code>>>8;
  }
  const result=bytes.toString('utf16le',0,length);
  if(recent&&!/0\\+[xX]/.test(text)) {
    const previous=recent.get('squeezed')??[];
    const cached=previous.find(entry=>entry.text===text||entry.equivalent===text)??{text};
    cached.equivalent=result;
    if(!previous.includes(cached))recent.set('squeezed',[cached,...previous.slice(0,1)]);
  }
  return result;
}
// Linear: three views of the same text (raw, decoded, backslashes dropped).
const decodedFinding=text=>textFinding(text)??textFinding(decodeEscapes(text))??textFinding(withoutBackslashes(text));
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
  const raw=legacyBufferFinding(content);
  if(raw)return raw;
  let text;
  try {text=new TextDecoder('utf-8',{fatal:true}).decode(content);} catch {return privateKeyStructureFinding(content,{escapes:true})??'unsupported-text-encoding';}
  if(text.includes('\0'))return privateKeyStructureFinding(content,{escapes:true})??'unsupported-text-encoding';
  // Decode once, and never rescan an unchanged view. Preserve every byte/encoding view for escaped
  // spellings as well as the raw content; escaped ASCII can itself describe a UTF-16-encoded key.
  const views=new Set(),recent=new Map();
  if(text.includes('\\')) {
    views.add(decodeEscapes(text,recent));views.add(withoutBackslashes(text,recent));
    views.delete(text);
    for(const view of views) {
      const escaped=textFinding(view);
      if(escaped)return escaped;
    }
  }
  // Legacy tokens in every decoded view retain priority over the additive structure scan.
  const structured=privateKeyStructureFinding(content,{recent});
  if(structured)return structured;
  for(const view of views)if(decodedStructureFinding(view,recent))return KEY_STRUCTURE_FINDING;
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
// Every path, not only credential-named ones: a structured key or a PEM private-key block with a body.
// Linear scans only; binary bytes get the structured-signature check, the PEM text check is a bounded regex.
// The label may end in ` BLOCK` (ASCII-armoured PGP). Armour allows `Name: value` header lines before the base64 body.
// Three eight-character groups can share one run or span two/three runs. Spell those
// cases separately: nested repetitions (and adjacent whitespace stars) backtrack on near misses.
const pemBody='(?:[A-Za-z0-9+/=]{24}|[A-Za-z0-9+/=]{16,}\\s+[A-Za-z0-9+/=]{8}|[A-Za-z0-9+/=]{8,}\\s+[A-Za-z0-9+/=]{16}|[A-Za-z0-9+/=]{8,}\\s+[A-Za-z0-9+/=]{8,}\\s+[A-Za-z0-9+/=]{8})';
const pemPrivateBlock=new RegExp('-----'+'BEGIN [A-Z0-9 ]*PRIVATE'+' KEY(?: BLOCK)?-----\\s*(?:Proc-Type:|DEK-Info:|(?:[A-Za-z][A-Za-z-]*: [^\\r\\n]*\\r?\\n\\s*)*'+pemBody+')');
export function ordinaryPathKeyFinding(content) {
  if(!Buffer.isBuffer(content))return null;
  // Inspect the buffers already decoded for structure, including escape-decoded wrappers.
  // Bound the additional PEM text allocation by decoded bytes, not the larger encoded input.
  // Structure scanning retains its existing coverage even beyond the PEM text limit.
  let encodedPem=false;
  const onDecoded=bytes=>{
    if(!encodedPem&&bytes.length<=LIMIT&&pemPrivateBlock.test(bytes.toString('latin1')))encodedPem=true;
  };
  const recent=new Map(),structured=privateKeyStructureFinding(content,{escapes:true,recent,onDecoded});
  if(structured)return structured;
  const views=textViews(content);
  if([...views].some(text=>pemPrivateBlock.test(text)))return 'private-key';
  // Escapes spell structure the raw views never contain (k\u0074y, \x tricks): scan the decoded views of every encoding.
  for(const text of views) {
    if(!text.includes('\\'))continue;
    for(const view of [decodeEscapes(text,recent),withoutBackslashes(text,recent)])
      if(view!==text&&pemPrivateBlock.test(view))return KEY_STRUCTURE_FINDING;
  }
  // Last, so an escaped spelling keeps its escape finding rather than the encoded-view one.
  return encodedPem?'private-key':null;
}
export function manifestEntry(path,content,executable,tracked,onWarning) {
  pathParts(path);
  if(typeof tracked!=='boolean')throw new Error('Missing manifest tracking evidence');
  const {credentialSource}=classifyManifestPath(path);
  const keyFinding=ordinaryPathKeyFinding(content);
  const finding=credentialSource
    ?!tracked?'untracked':credentialContentFinding(path,content)||keyFinding
    :keyFinding;
  // The additive all-path gate blocks structures. Legacy text, JSON and encoding requirements
  // remain credential-name policy; their findings must neither reject ordinary files nor mask keys.
  if(finding)
    throw Object.assign(new Error(`Excluded ${credentialSource?'credential-named':'secret-bearing'} file (${finding}): use local fallback`),{code:'excluded-source-file'});
  if(credentialSource) {
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
  // Ordinary tracked tests may be content-excluded by the all-paths key scan.
  // Path-policy exclusions remain ineligible tests; overlap is always invalid.
  validateTestNames([...paths,...excluded]);
  if(excluded.some(p=>keys.has(p.toString('hex'))||isTestFile(p)&&classifyManifestPath(p).excluded))throw new Error('Invalid base exclusions');
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
