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
const sourceExtension = /\.(?:mjs|js|ts|tsx|jsx|css|md|html)$/;
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

// Pure policy and leaf construction are shared by inventory, warm export and delta.
export function classifyManifestPath(path) {
  const parts=pathParts(path),names=parts.map(normalizedComponent);
  const excluded=names.some((name,i)=>excludedComponent(name,i===names.length-1));
  const credentialSource=excluded && sourceExtension.test(names.at(-1))
    && !names.some((name,i)=>excludedComponent(name,i===names.length-1,true));
  return {parts,names,excluded,credentialSource};
}
export function manifestEntry(path,content,executable,tracked) {
  pathParts(path);
  if(typeof tracked!=='boolean')throw new Error('Missing manifest tracking evidence');
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
export function parseGitTree(bytes) {
  if(!Buffer.isBuffer(bytes)||bytes.length>LIMIT||(bytes.length&&bytes.at(-1)!==0))throw new Error('Invalid git tree');
  const entries=[];let start=0;
  for(let i=0;i<bytes.length;i++)if(bytes[i]===0){
    const record=bytes.subarray(start,i),tab=record.indexOf(9),header=record.subarray(0,tab).toString('ascii');
    if(tab<0||!/^\d{6} (?:blob|tree|commit) [a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(header))throw new Error('Unsupported git tree mode');
    const path=record.subarray(tab+1),policy=classifyManifestPath(path);
    const excluded=(policy.excluded&&!policy.credentialSource)||policy.names.includes('node_modules');
    if(!excluded&&!/^100(?:644|755) blob /.test(header))throw new Error('Unsupported git tree mode');
    const [mode,,oid]=header.split(' ');entries.push({path,oid,executable:mode==='100755'});start=i+1;
  }
  return entries;
}
