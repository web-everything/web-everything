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
function excludedComponent(name, leaf, allowCredential = false) {
  // Admit ordinary accented Latin names (e.g. é) but fail closed on remaining
  // non-ASCII forms: no incomplete hand-maintained confusable substitution map.
  const unsafe = /\p{Cc}/u.test(name) || [...name].some(char => char.charCodeAt(0) > 127
    && !/^(?:[a-z]\p{M}+|\p{Z})$/u.test(char.normalize('NFD')));
  return unsafe || !name || /^\.(?:netrc|npmrc|env.*)$/.test(name)
    || (name.startsWith('.') && !safeDotDirectory.test(name) && !(leaf && safeDotFile.test(name)))
    || keyComponent.test(name) || (!allowCredential && credentialComponent.test(name));
}

// Ruling R321 (replaces the per-folder exceptions of R312/R316). A file whose
// NAME alone trips credentialComponent ships to Forge only when ALL hold:
//   1. it is git-tracked;
//   2. its bytes equal origin/main and it is not a symlink nor reached through
//      one (remote-exec compares the index blob to the origin/main blob, and
//      the symlink/alias checks refuse the rest);
//   3. it passes the content secret scan below.
// Why this leaks nothing: a tracked file identical to origin/main is already
// public, so shipping it to our own Forge reveals nothing new. Anything
// untracked, modified versus main, or local-only stays excluded. Names that are
// unsafe for other reasons (key files, dotfiles, .env, non-ASCII) never qualify.
const secretField=/key|secret|token|passw(?:or)?d|credential|creds|oauth|^id_/i;
const secretText=[
  [/-----BEGIN/,'pem-header'],[/PRIVATE KEY/i,'private-key'],[/AKIA[0-9A-Z]{16}/,'aws-access-key'],
  [/gh[opsur]_[A-Za-z0-9]{20,}/,'github-token'],[/sk-[A-Za-z0-9_-]{16,}/,'sk-token'],
  [/xox[bp]-[A-Za-z0-9-]{8,}/,'slack-token'],
];
const textFinding=text=>secretText.find(([pattern])=>pattern.test(text))?.[1]??null;
function entropy(text) {
  // Count code points on both sides: UTF-16 length would dilute astral characters.
  const chars=[...text],counts=new Map();for(const char of chars)counts.set(char,(counts.get(char)??0)+1);
  return [...counts.values()].reduce((bits,n)=>bits-(n/chars.length)*Math.log2(n/chars.length),0);
}
// Content scan for a name-flagged file. JSON gets the full structural scan. Source
// and docs files (sourceExtension) are public code that legitimately spells out
// secret patterns (scrubbers, PEM docs): they are unscanned, exactly as before
// R321. Every other type gets the raw token patterns, minus the PEM markers that
// ordinary prose and code mention. Returns the first finding or null when clean.
export function credentialContentFinding(path,content) {
  const leaf=pathParts(path).at(-1).toString('latin1');
  if(/\.json$/i.test(leaf))return designTokenSecretFinding(content);
  if(sourceExtension.test(leaf.toLowerCase()))return null;
  const text=Buffer.from(content).toString('utf8');
  return secretText.filter(([,name])=>name!=='pem-header'&&name!=='private-key').find(([pattern])=>pattern.test(text))?.[1]??null;
}
// Returns the first secret-like finding, or null when the content is clean.
export function designTokenSecretFinding(content) {
  const text=Buffer.from(content).toString('utf8');
  const raw=textFinding(text);
  if(raw)return raw;
  let json;
  try {json=JSON.parse(text);} catch {return 'unparseable-json';}
  if(!json||typeof json!=='object'||Array.isArray(json))return 'non-object-json';
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
    const value=JSON.parse(literal),decoded=textFinding(value);
    if(decoded)return decoded;
    // Under a tainted container, property names are secret candidates too.
    if(colon&&stack.at(-1)&&value.length>=20&&entropy(value)>=3.5)return 'high-entropy-nested-key';
    if(colon) {field=value;continue;}
    const name=field!==undefined&&secretField.test(field)?field:stack.at(-1)?'nested':null;
    if(name&&value.length>=20&&entropy(value)>=3.5)return `high-entropy-${name}`;
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
export function manifestEntry(path,content,executable,tracked) {
  pathParts(path);
  if(typeof tracked!=='boolean')throw new Error('Missing manifest tracking evidence');
  if(classifyManifestPath(path).credentialSource) {
    const finding=tracked?credentialContentFinding(path,content):'untracked';
    if(finding)throw Object.assign(new Error(`Excluded credential-named file ${path.toString('latin1')} (${finding}): use local fallback`),{code:'excluded-source-file'});
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
