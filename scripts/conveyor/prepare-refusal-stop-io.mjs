import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { activePrepareRefusals, appendPrepareRefusal } from './prepare-refusal-stop.mjs';

export const prepareRefusalPath = () => join(resolveCoordinationRoot(), 'prepare-refusals.json');
const failed = error => new Error(`prepare refusal history unavailable; restore prepare-refusals.json or remove it after operator review: ${error.message}`);

export function readPrepareRefusals({ path = prepareRefusalPath(), ...options } = {}) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw failed(error); }
  try {
    const rows = JSON.parse(raw);
    if (!Array.isArray(rows) || rows.some(r => !r || typeof r.num !== 'string' || !r.num
      || typeof r.reason !== 'string' || !r.reason || typeof r.at !== 'string' || !Number.isFinite(Date.parse(r.at)))) {
      throw new Error('invalid refusal records');
    }
    return activePrepareRefusals(rows, options);
  } catch (error) { throw failed(error); }
}

export function recordPrepareRefusal(refusal, { path = prepareRefusalPath(), ...options } = {}) {
  const rows = appendPrepareRefusal(readPrepareRefusals({ path, ...options }), refusal, options);
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(rows) + '\n', { mode: 0o600 });
    renameSync(temp, path);
  } catch (error) { throw failed(error); }
}
