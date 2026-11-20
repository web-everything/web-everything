import { createHash } from 'node:crypto';
import { extname, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import * as filesystem from 'node:fs/promises';
import { pathParts, splitPaths } from './forge-exec-run.mjs';

export const FORGE_MANIFEST_FILE_CAP = 1048576;
// HEAD measured 146,012,107 blob bytes when S1 landed; 512 MiB leaves room for growth.
export const FORGE_MANIFEST_TOTAL_CAP = 512 * 1024 * 1024;
// Largest HEAD blob was 829,088 bytes: no remote test input needs an exception.
export const FORGE_MANIFEST_SIZE_EXCEPTIONS = Object.freeze([]);
// Fatal UTF-8 decoding of all HEAD blobs found only these binary asset types.
export const FORGE_MANIFEST_BINARY_EXTENSIONS = Object.freeze(['.webp']);
const TREE_LIMIT = 4 * 1024 * 1024;
const oidPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const utf8 = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);

export async function trackedTree({ cwd, exec, head, refuse, onHead, trackedOnly = false }) {
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
  // Sibling inventories select only their existing scoped index paths. Bind those
  // shipped files to HEAD without imposing the main checkout's untracked-file rule.
  if (trackedOnly) return { entries, head, algorithm };
  const untracked = await exec({ file: 'git', args: ['ls-files', '-o', '--exclude-standard', '-z'], cwd });
  if (untracked.code !== 0 || !Buffer.isBuffer(untracked.stdout) || untracked.stdout.length > TREE_LIMIT
    || (untracked.stdout.length && untracked.stdout.at(-1) !== 0)) throw refuse('untracked', '.');
  for (const path of splitPaths(untracked.stdout)) if (!path.equals(Buffer.from('coverage/coverage-final.json'))
    && !entries.has(path.toString('base64'))) throw refuse('untracked', path);
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
