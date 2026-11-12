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
export const secretText=[
  [/-----BEGIN/,'pem-header'],
  [/PRIVATE KEY/,'private-key'],
  [/gh[opsur]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{22,}/,'github-token'],
  [/(?:AKIA|ASIA)[0-9A-Z]{16}/,'aws-access-key'],
  [/\bsk-[A-Za-z0-9_-]{16,}/,'sk-token'],
  [/xox[abprs]-[A-Za-z0-9-]{8,}/,'slack-token'],
  [/AIza[0-9A-Za-z_-]{35}/,'google-api-key'],
  [/npm_[A-Za-z0-9]{36}/,'npm-token'],
];
export const credentialTextFinding=text=>textFinding(text);
const textFinding=text=>secretText.find(([pattern])=>pattern.test(text))?.[1]??null;
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
  return assignmentFinding(text,true);
}
// Field names are diagnostic data too; never echo a credential-bearing or unbounded name.
const findingField=field=>textFinding(field)||field.length>80?`field-sha256-${sha(field).slice(0,12)}`:field;
export function credentialContentWarning(path,content) {
  const leaf=classifyManifestPath(path).names.at(-1);
  if(/\.json$/.test(leaf))return designTokenSecretFinding(content,{warnings:true});
  let text;
  try {text=new TextDecoder('utf-8',{fatal:true}).decode(content);} catch {return null;}
  if(text.includes('\0'))return null;
  const finding=assignmentFinding(text);
  return /^(?:high-entropy|secret-assignment)-/.test(finding??'')?finding:null;
}
// blockOnly: report only blocking evidence (unbounded continuation); generic findings never mask it.
function assignmentFinding(text,blockOnly=false) {
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
          if(line.length>=20&&entropy(line)>=3.5)return `high-entropy-${findingField(field)}`;
        }
      }
    }
    // A whole-value reference with no continuation line cannot hide a literal.
    if(reference&&!continuation.length)continue;
    if(blockOnly)continue;
    if(credentialNamed&&value.length>=20&&entropy(value)>=3.5)return `high-entropy-${findingField(field)}`;
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
