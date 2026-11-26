/** Explicit read-only diagnostic. Contract: docs/operations/audit-nonconvergence.md. */
import * as fs from 'node:fs';
import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findingKey } from '../lib/audit-finding-key.mjs';
import { FINDING_CLASSES } from './audit-verdict.mjs';

const MAX_BYTES = 1_048_576;
const MAX_STRING_BYTES = 4096;
const controls = /[\x00-\x1f\x7f-\x9f]/;
const hash = n => new RegExp(`^[a-f0-9]{${n}}(?![\\s\\S])`);
const HASH40 = hash(40), HASH64 = hash(64);
const envelope = () => ({ schemaVersion: 1, kind: 'audit-nonconvergence-diagnostic', enforcement: false });
const failure = reason => ({ exitCode: 2, result: { ...envelope(), status: 'INCOMPLETE', reason,
  action: 'Human review of full audit history required' } });
function reject(code = 'INVALID_MANIFEST') { throw Object.assign(new Error(code), { diagnosticReason: code }); }
function requireThat(condition) { if (!condition) reject(); }
function object(value, keys) {
  requireThat(value !== null && typeof value === 'object' && !Array.isArray(value));
  requireThat(Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k)));
}
function string(value) {
  requireThat(typeof value === 'string');
  if (Buffer.byteLength(value, 'utf8') > MAX_STRING_BYTES) reject('LIMIT_EXCEEDED');
  requireThat(value.trim().length > 0);
}
const positive = value => Number.isSafeInteger(value) && value > 0;
function strings(value, keys) { for (const key of keys) string(value[key]); }
function branch(ref) {
  return ref.startsWith('refs/heads/') && ref.length > 11 && !controls.test(ref)
    && !/[\s~^:?*\[\\]/.test(ref) && !ref.includes('..') && !ref.includes('@{')
    && !ref.endsWith('.') && ref.split('/').every(p => p && !p.startsWith('.') && !p.endsWith('.lock'));
}
function validate(m) {
  object(m, ['schemaVersion', 'kind', 'synthetic', 'repo', 'pr', 'ref', 'questionHash', 'completeFromStart', 'provenance', 'rounds']);
  strings(m, ['kind', 'repo', 'ref', 'questionHash']);
  requireThat(m.schemaVersion === 1 && m.kind === 'audit-nonconvergence-input'
    && typeof m.synthetic === 'boolean' && m.completeFromStart === true && positive(m.pr));
  requireThat(/^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?\/[a-z0-9][a-z0-9._-]*(?![\s\S])/.test(m.repo)
    && branch(m.ref) && HASH64.test(m.questionHash));
  requireThat(Array.isArray(m.rounds) && m.rounds.length > 0);
  if (m.rounds.length > 100) reject('LIMIT_EXCEEDED');
  object(m.provenance, ['source', 'sourceSha256', 'selection', 'verifiedBy']);
  strings(m.provenance, ['source', 'sourceSha256', 'verifiedBy']);
  requireThat(HASH64.test(m.provenance.sourceSha256));
  const selection = m.provenance.selection;
  requireThat(Array.isArray(selection) && selection.length === m.rounds.length);
  const heads = new Set(), indices = new Set();
  for (const [i, r] of m.rounds.entries()) {
    object(r, ['sequence', 'repo', 'pr', 'ref', 'questionHash', 'head', 'base', 'verdict', 'findings']);
    strings(r, ['repo', 'ref', 'questionHash', 'head', 'base', 'verdict']);
    requireThat(r.sequence === i + 1 && ['repo', 'pr', 'ref', 'questionHash'].every(k => r[k] === m[k]));
    requireThat(HASH40.test(r.head) && HASH40.test(r.base) && !heads.has(r.head));
    heads.add(r.head);
    const s = selection[i];
    object(s, ['sequence', 'recordIndex', 'recordSha256']); string(s.recordSha256);
    requireThat(s.sequence === r.sequence && positive(s.recordIndex) && !indices.has(s.recordIndex) && HASH64.test(s.recordSha256));
    indices.add(s.recordIndex);
    requireThat(Array.isArray(r.findings));
    if (r.findings.length > 100) reject('LIMIT_EXCEEDED');
    requireThat((r.verdict === 'WEAKENED' && r.findings.length > 0)
      || (r.verdict === 'NOT WEAKENED' && r.findings.length === 0));
    const ids = new Set();
    for (const f of r.findings) {
      object(f, ['id', 'text', 'file', 'line', 'class']); strings(f, ['id', 'text', 'file', 'class']);
      requireThat(!ids.has(f.id) && positive(f.line) && FINDING_CLASSES.includes(f.class));
      ids.add(f.id);
      requireThat(!controls.test(f.file) && posix.normalize(f.file) === f.file);
      // Validate with the shared contract, but never count identity keys as novelty.
      findingKey(f);
    }
  }
}

/** Validate every row before computing any recommendation. Does not mutate input. */
export function diagnose(manifest) {
  try { validate(manifest); }
  catch (error) { return failure(error.diagnosticReason ?? 'INVALID_MANIFEST'); }
  const seen = new Set(); let streak = 0, recommendationAt = null;
  const rounds = manifest.rounds.map(r => {
    const classes = new Set(r.findings.map(f => f.class));
    const newClasses = [...classes].filter(c => !seen.has(c)).sort();
    classes.forEach(c => seen.add(c));
    streak = r.verdict === 'WEAKENED' && newClasses.length > 0 ? streak + 1 : 0;
    if (streak === 2 && recommendationAt === null) recommendationAt = r.sequence;
    return { ...r, findings: r.findings.map(f => ({ ...f })), newClasses, streak };
  });
  const { synthetic, repo, pr, ref, questionHash, provenance } = manifest;
  return { exitCode: recommendationAt === null ? 0 : 10, result: {
    ...envelope(), synthetic, repo, pr, ref, questionHash, evidenceBasis: 'operator-attested; not authenticated',
    status: recommendationAt === null ? 'NO_RECOMMENDATION' : 'RECOMMEND_DESIGN',
    recommendationAt, streak, rounds, provenance: { ...provenance, selection: provenance.selection.map(s => ({ ...s })) },
  } };
}

/** Read at most the cap plus ONE overflow byte, including with short reads. IO is synchronous and read-only. */
export function readManifest(path, io = fs) {
  let fd;
  let bytes;
  try {
    fd = io.openSync(path, 'r');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const length = Math.min(65536, buffer.length - total);
      const n = io.readSync(fd, buffer, total, length, null);
      if (!Number.isSafeInteger(n) || n < 0 || n > length) reject('READ_FAILED');
      if (n === 0) break;
      total += n;
      if (total > MAX_BYTES) reject('LIMIT_EXCEEDED');
    }
    bytes = buffer.subarray(0, total);
  } catch (error) {
    if (error.diagnosticReason) throw error;
    reject('READ_FAILED');
  } finally {
    if (fd !== undefined) {
      try { io.closeSync(fd); } catch { reject('READ_FAILED'); }
    }
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { reject('INVALID_JSON'); }
}

// JSON preserves original evidence; C1/DEL also need escaping for terminal-safe output.
const serialize = value => JSON.stringify(value).replace(/[\x7f-\x9f]/g,
  c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`) + '\n';
function writeOutput(stream, text) {
  return new Promise(resolveWrite => {
    const failed = () => resolveWrite(false);
    try {
      stream.once('error', failed);
      stream.write(text, error => {
        // On callback error, leave the listener for the ensuing stream error event.
        if (error) resolveWrite(false);
        else { stream.removeListener('error', failed); resolveWrite(true); }
      });
    } catch { resolveWrite(false); }
  });
}

/** Adapter with injectable read IO and output streams; never executes commands or writes files. */
export async function runCli(argv, { io = fs, stdout = process.stdout, stderr = process.stderr } = {}) {
  let out;
  if (argv.length !== 2 || argv[0] !== '--manifest' || typeof argv[1] !== 'string'
    || !argv[1].trim() || argv[1].startsWith('--') || controls.test(argv[1]) || Buffer.byteLength(argv[1]) > MAX_STRING_BYTES) {
    out = failure('INVALID_ARGUMENTS');
  } else {
    try { out = diagnose(readManifest(argv[1], io)); }
    catch (error) { out = failure(error.diagnosticReason ?? 'READ_FAILED'); }
  }
  if (await writeOutput(stdout, serialize(out.result))) return out.exitCode;
  try {
    stderr.once?.('error', () => {});
    // Fixed text avoids reflecting untrusted error messages or terminal controls.
    stderr.write('OUTPUT_WRITE_FAILED: Human review of full audit history required');
  } catch { /* Delivery failure remains exit 2 even when stderr is unavailable. */ }
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
