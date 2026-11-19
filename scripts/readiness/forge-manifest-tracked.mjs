import { createHash } from 'node:crypto';
import { extname, isAbsolute, relative, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import * as filesystem from 'node:fs/promises';
import { pathParts, splitPaths } from './forge-exec-run.mjs';

export const FORGE_MANIFEST_FILE_CAP = 1048576;
// HEAD measured 146,012,107 blob bytes when S1 landed; 512 MiB leaves room for growth.
export const FORGE_MANIFEST_TOTAL_CAP = 512 * 1024 * 1024;
export const FORGE_MANIFEST_COVERAGE_CAP = 64 * 1024 * 1024;
// Largest HEAD blob was 829,088 bytes: no remote test input needs an exception.
export const FORGE_MANIFEST_SIZE_EXCEPTIONS = Object.freeze([]);
// Fatal UTF-8 decoding of all HEAD blobs found only these binary asset types.
export const FORGE_MANIFEST_BINARY_EXTENSIONS = Object.freeze(['.webp']);
const TREE_LIMIT = 4 * 1024 * 1024;
const oidPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const utf8 = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);

export async function trackedTree({ cwd, exec, head, refuse, onHead }) {
  if (head === undefined) {
    const result = await exec({ file: 'git', args: ['rev-parse', 'HEAD'], cwd });
    if (result.code !== 0 || !Buffer.isBuffer(result.stdout)) throw refuse('mode', '.');
    head = result.stdout.toString('ascii').trim();
  }
  if (!oidPattern.test(head)) throw refuse('mode', '.');
  onHead?.(head);
  const format = await exec({ file: 'git', args: ['rev-parse', '--show-object-format'], cwd });
  const algorithm = Buffer.isBuffer(format.stdout) ? format.stdout.toString('ascii').trim() : '';
  if (format.code !== 0 || !['sha1', 'sha256'].includes(algorithm)) throw refuse('mode', '.');
  const result = await exec({ file: 'git', args: ['ls-tree', '-r', '-z', '--full-tree', head], cwd });
  if (result.code !== 0 || !Buffer.isBuffer(result.stdout) || result.stdout.length > TREE_LIMIT
    || (result.stdout.length && result.stdout.at(-1) !== 0)) throw refuse('mode', '.');
  const entries = new Map();
  for (const record of splitPaths(result.stdout)) {
    const tab = record.indexOf(9), header = record.subarray(0, tab).toString('latin1');
    const match = header.match(/^([0-7]{6}) (blob|commit) ([a-f0-9]+)$/);
    const path = record.subarray(tab + 1);
    if (tab < 0 || !match || !oidPattern.test(match[3]) || match[3].length !== (algorithm === 'sha1' ? 40 : 64)) throw refuse('mode', '.');
    try { pathParts(path); } catch { throw refuse('mode', path); }
    const [, mode, type, oid] = match, key = path.toString('base64');
    if (entries.has(key)) throw refuse('mode', path);
    if (mode === '160000' && type === 'commit') throw refuse('gitlink-unsupported', path);
    if (!['100644', '100755', '120000'].includes(mode) || type !== 'blob') throw refuse('mode', path);
    entries.set(key, { path, mode, oid });
  }
  const untracked = await exec({ file: 'git', args: ['ls-files', '-o', '--exclude-standard', '-z'], cwd });
  if (untracked.code !== 0 || !Buffer.isBuffer(untracked.stdout) || untracked.stdout.length > TREE_LIMIT
    || (untracked.stdout.length && untracked.stdout.at(-1) !== 0)) throw refuse('untracked', '.');
  for (const path of splitPaths(untracked.stdout)) if (!entries.has(path.toString('base64'))) throw refuse('untracked', path);
  return { entries, head, algorithm };
}

export function validateManifestFileBounds({ path, content, oid, refuse, sizeExceptions = FORGE_MANIFEST_SIZE_EXCEPTIONS }) {
  if (content.length > FORGE_MANIFEST_FILE_CAP && !sizeExceptions.some(exception =>
    Buffer.from(exception.path).equals(path) && exception.oid === oid)) throw refuse('oversize', path);
  try { utf8(content); } catch {
    if (!FORGE_MANIFEST_BINARY_EXTENSIONS.includes(extname(path.toString('utf8')).toLowerCase())) throw refuse('binary-type', path);
  }
}

export function validateTrackedFile({ path, content, st, tree, refuse, sizeExceptions = FORGE_MANIFEST_SIZE_EXCEPTIONS }) {
  const entry = tree.entries.get(path.toString('base64'));
  if (!entry) throw refuse('untracked', path);
  validateManifestFileBounds({ path, content, oid: entry.oid, refuse, sizeExceptions });
  const oid = createHash(tree.algorithm).update(`blob ${content.length}\0`).update(content).digest('hex');
  if (oid !== entry.oid || !!(st.mode & 0o111) !== (entry.mode === '100755')) throw refuse('dirty', path);
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const shape = (value, required, optional = []) => object(value)
  && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const integer = value => Number.isSafeInteger(value) && value >= 0;
const count = integer;
const position = value => shape(value, ['line', 'column']) && integer(value.line) && integer(value.column);
const location = value => shape(value, ['start', 'end']) && position(value.start) && position(value.end);
const map = (value, valid) => object(value) && Object.entries(value).every(([key, entry]) => /^\d+$/.test(key) && valid(entry));
// Free text is the exfiltration channel: names must also bind to HEAD source
// below; branch types are a closed set and hashes are hex digests.
const label = value => typeof value === 'string' && (/^[A-Za-z_$][\w$]{0,99}$/.test(value) || /^\(anonymous_\d{1,6}\)$/.test(value));
const BRANCH_TYPES = new Set(['if', 'binary-expr', 'cond-expr', 'switch', 'default-arg', 'logical-assignment']);
const digest = value => typeof value === 'string' && /^[a-f0-9]{1,64}$/.test(value);
const fn = value => shape(value, ['name', 'decl', 'loc'], ['line']) && label(value.name)
  && location(value.decl) && location(value.loc) && (!Object.hasOwn(value, 'line') || integer(value.line));
const branch = value => shape(value, ['type', 'loc', 'locations'], ['line']) && BRANCH_TYPES.has(value.type)
  && location(value.loc) && Array.isArray(value.locations) && value.locations.every(location)
  && (!Object.hasOwn(value, 'line') || integer(value.line));

export async function validateCoverage({ content, cwd, tree, refuse, path, exec }) {
  if (content.length > FORGE_MANIFEST_COVERAGE_CAP) throw refuse('oversize', path);
  const invalid = () => refuse('coverage-invalid', path);
  let coverage;
  try { coverage = JSON.parse(utf8(content)); } catch { throw invalid(); }
  if (!object(coverage)) throw invalid();
  for (const [key, value] of Object.entries(coverage)) {
    const repoPath = isAbsolute(key) ? relative(cwd, key) : key;
    // Reject normalization tricks, paths outside cwd and paths not in the pinned tree.
    try { pathParts(Buffer.from(repoPath)); } catch { throw invalid(); }
    const blob = tree.entries.get(Buffer.from(repoPath).toString('base64'));
    if (!blob || !['100644', '100755'].includes(blob.mode)
      || !shape(value, ['path', 'statementMap', 'fnMap', 'branchMap', 's', 'f', 'b'], ['_coverageSchema', 'hash'])
      || value.path !== key || !map(value.statementMap, location) || !map(value.fnMap, fn) || !map(value.branchMap, branch)
      || !map(value.s, count) || !map(value.f, count) || !map(value.b, hits => Array.isArray(hits) && hits.every(count))
      || ['_coverageSchema', 'hash'].some(field => Object.hasOwn(value, field) && !digest(value[field]))) throw invalid();
    const sameKeys = (hits, locations) => Object.keys(hits).length === Object.keys(locations).length
      && Object.keys(locations).every(key => Object.hasOwn(hits, key));
    if (!sameKeys(value.s, value.statementMap) || !sameKeys(value.f, value.fnMap) || !sameKeys(value.b, value.branchMap)
      || Object.entries(value.b).some(([key, hits]) => hits.length !== value.branchMap[key].locations.length)) throw invalid();
    let source;
    try {
      const result = await exec({ file: 'git', args: ['cat-file', 'blob', blob.oid], cwd });
      if (result.code !== 0 || !Buffer.isBuffer(result.stdout)
        || createHash(tree.algorithm).update(`blob ${result.stdout.length}\0`).update(result.stdout).digest('hex') !== blob.oid) throw invalid();
      source = utf8(result.stdout);
    } catch { throw invalid(); }
    const lines = source.split(/\r\n|[\n\r\u2028\u2029]/);
    const line = n => Number.isSafeInteger(n) && n >= 1 && n <= lines.length;
    const boundedPosition = p => line(p.line) && p.column <= lines[p.line - 1].length + 1;
    const boundedLocation = loc => boundedPosition(loc.start) && boundedPosition(loc.end);
    // Token boundaries include Unicode identifier continuations so an ASCII
    // substring inside a larger JS identifier cannot authorize an arbitrary name.
    const identifiers = new Set(source.match(/(?<![$\u200c\u200d\p{ID_Continue}])[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*/gu) ?? []);
    if (!Object.values(value.statementMap).every(boundedLocation)
      || !Object.values(value.fnMap).every(fn => boundedLocation(fn.decl) && boundedLocation(fn.loc)
        && (!Object.hasOwn(fn, 'line') || line(fn.line))
        && (/^\(anonymous_\d{1,6}\)$/.test(fn.name) || identifiers.has(fn.name)))
      || !Object.values(value.branchMap).every(branch => boundedLocation(branch.loc) && branch.locations.every(boundedLocation)
        && (!Object.hasOwn(branch, 'line') || line(branch.line)))) throw invalid();
  }
}

export async function logManifestVerdict({ env, mode, error, head }) {
  try {
    const file = env.FORGE_MANIFEST_REFUSALS_LOG ?? process.env.FORGE_MANIFEST_REFUSALS_LOG ?? join(homedir(), '.plateau', 'forge-manifest-refusals.jsonl');
    const bytes = error?.manifestPath ?? Buffer.from(error?.detail ?? '.');
    let path;
    try { path = utf8(bytes); } catch { path = { base64: bytes.toString('base64') }; }
    await filesystem.mkdir(dirname(file), { recursive: true });
    await filesystem.appendFile(file, JSON.stringify({ ts: new Date().toISOString(), mode, shadow: mode === 'legacy',
      reason: error ? error.code ?? 'mode' : null, path: error ? path : null, head: head ?? null }) + '\n');
  } catch { /* Telemetry must never affect manifest admission. */ }
}
