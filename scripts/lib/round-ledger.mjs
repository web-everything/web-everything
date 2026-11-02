/** Append-only structured round evidence; no comment or file-list inference. */
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { validRoundRecord } from './break-class-stop.mjs';

export const ROUND_LEDGER_SCHEMA = 1;

/** Resolve only a deliberately named directory override. */
export function ledgerDir(env = process.env) {
  const override = env?.WE_ROUND_LEDGER_DIR?.trim();
  return override && basename(resolve(override)) === 'round-ledger'
    ? resolve(override) : join(homedir(), 'workspace', '.operations', 'round-ledger');
}

/** Read all heads for one PR, counting every invalid line. IO is injectable. */
export function readSlice(dir, pr, io = fs) {
  let text;
  try { text = io.readFileSync(join(dir, 'round-ledger.jsonl'), 'utf8'); }
  catch (error) {
    return { records: [], malformed: 0, complete: error?.code === 'ENOENT' };
  }
  const records = [];
  let malformed = 0, complete = true;
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const line of lines) {
    try {
      const record = JSON.parse(line);
      if (!validRoundRecord(record)) { malformed++; complete = false; continue; }
      if (record.pr === pr) records.push(record);
    } catch (error) { malformed++; complete = false; }
  }
  records.sort((a, b) => a.round - b.round);
  return { records, malformed, complete };
}

/** Validate before writing; duplicate result identities never append twice. */
export function appendRound(dir, rec, io = fs) {
  const slice = readSlice(dir, rec?.pr, io);
  if (!slice.complete || slice.malformed) throw new Error('round ledger is unreadable or malformed');
  const record = { ...rec, round: rec?.round ?? slice.records.reduce((max, r) => Math.max(max, r.round), 0) + 1 };
  if (!validRoundRecord(record)) throw new TypeError('invalid round record');
  const line = `${JSON.stringify(record)}\n`;
  const same = slice.records.find(r => r.head === record.head && r.resultId === record.resultId);
  if (same) {
    const { round: _a, ...a } = same, { round: _b, ...b } = record;
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error('conflicting duplicate round record');
    return { appended: false };
  }
  io.mkdirSync(dir, { recursive: true });
  io.appendFileSync(join(dir, 'round-ledger.jsonl'), line);
  return { appended: true };
}
