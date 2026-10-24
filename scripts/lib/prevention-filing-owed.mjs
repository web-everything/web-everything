/** Durable paused filing obligations. Completed records remain as idempotency tombstones. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, linkSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireLease, atomicRecord, cardBatchStateDir, tokenOf } from '../operations/card-batch-io.mjs';

const directory = stateDir => join(stateDir, 'owed-prevention');
// Session/transport flags are not the obligation. Both spawn and CLI use the same card input.
const identity = input => JSON.stringify(Object.entries({
  repo: input.retractTo?.repo ?? input.retract?.repo ?? input.source?.repo ?? '',
  pr: String(input.retractTo?.pr ?? input.retract?.pr ?? input.source?.pr ?? ''),
  ...Object.fromEntries(['title', 'kind', 'size', 'digest', 'scope', 'parent', 'queue']
    .map(key => [key, String(input[key] ?? '')])),
}));
export const preventionFilingKey = input => /^[a-f0-9]{64}$/.test(input.owedKey ?? '') ? input.owedKey : createHash('sha256').update(identity(input)).digest('hex');
const pathOf = (input, stateDir) => join(directory(stateDir), `${preventionFilingKey(input)}.json`);
const read = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };

export function owePreventionFiling(input, { stateDir = cardBatchStateDir() } = {}) {
  const path = pathOf(input, stateDir);
  if (read(path)) return { key: preventionFilingKey(input), path };
  mkdirSync(directory(stateDir), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ key: preventionFilingKey(input), input, status: 'owed', requestedAt: Date.now() }), { flag: 'wx' });
    try { linkSync(temporary, path); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  } finally { rmSync(temporary, { force: true }); }
  return { key: preventionFilingKey(input), path };
}

/** Serialize the existing filer, retaining owed on failure and done on success. */
export async function fileOwedPrevention(input, file, { stateDir = cardBatchStateDir() } = {}) {
  const path = pathOf(input, stateDir);
  if (!read(path)) return file(input);
  const lock = `${path}.lock`;
  const lease = acquireLease(lock, `prevention:${process.pid}:${randomUUID()}`, Date.now(), 3 * 60 * 60_000);
  if (!lease) return { ok: false, step: 'owed', reason: 'filing already in progress' };
  try {
    const record = read(path);
    if (record.key !== preventionFilingKey(input)) throw Error('owed filing identity mismatch');
    if (record.status === 'done') return record.result;
    const result = await file({ ...record.input, owedKey: record.key,
      ...(record.input.retractTo ? { retract: record.input.retractTo } : {}),
      session: record.input.session || `owed-prevention-${record.key.slice(0, 16)}` });
    if (result.ok && !result.skipped) {
      if (tokenOf(lock) !== lease.token || Date.now() >= lease.expiresAt) throw Error('owed filing lease expired');
      atomicRecord(path, { ...record, status: 'done', completedAt: Date.now(), result });
    }
    return result;
  } finally { if (tokenOf(lock) === lease.token) rmSync(lock, { force: true }); }
}

export async function reconcileOwedPrevention({ stateDir = cardBatchStateDir(), file } = {}) {
  let names;
  try { names = readdirSync(directory(stateDir)); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const results = [];
  for (const name of names.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
    const record = read(join(directory(stateDir), name));
    if (record.status === 'done') continue;
    if (`${preventionFilingKey(record.input)}.json` !== name) throw Error('owed filing identity mismatch');
    try { results.push(await fileOwedPrevention(record.input, file, { stateDir })); }
    catch (e) { results.push({ ok: false, step: 'owed', reason: e.message }); }
  }
  return results;
}

export function owedPreventionRecord(input, { stateDir = cardBatchStateDir() } = {}) { return read(pathOf(input, stateDir)); }
