import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { daemonStateDir } from './daemon-last-good.mjs';

function readEntries(env) {
  try {
    const entries = JSON.parse(readFileSync(join(daemonStateDir(env), 'overlay-conflict-wake.json'), 'utf8'));
    return entries && typeof entries === 'object' && !Array.isArray(entries) ? entries : {};
  } catch { return {}; }
}

export function readOverlayConflictWakes(env = process.env, { nowMs = Date.now(), maxAgeMs = 6 * 3600_000 } = {}) {
  return new Map(Object.values(readEntries(env))
    .filter((entry) => Number.isInteger(entry?.pr) && entry.pr > 0 && typeof entry.at === 'string'
      && Number.isFinite(Date.parse(entry.at)) && nowMs - Date.parse(entry.at) <= maxAgeMs)
    .map((entry) => [entry.pr, entry]));
}

function updateEntries(env, update) {
  let tmp;
  try {
    const dir = daemonStateDir(env);
    const entries = readEntries(env);
    update(entries);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'overlay-conflict-wake.json');
    tmp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(entries)}\n`, 'utf8');
    renameSync(tmp, file);
  } catch { /* best-effort wake */ }
  finally { if (tmp) { try { rmSync(tmp, { force: true }); } catch { /* best-effort cleanup */ } } }
}

export function markOverlayConflictWake(env, entry) {
  // Keep the FIRST `at` while the same overlay stays unresolved, so the 6h urgency window is a real bound and a
  // stuck PR cannot pre-empt the scope-overlap queue forever by being re-marked every tick.
  updateEntries(env, (entries) => {
    const prev = entries[entry.pr];
    entries[entry.pr] = prev?.ref === entry.ref && typeof prev.at === 'string' ? { ...entry, at: prev.at } : entry;
  });
}

export function clearOverlayConflictWake(env, pr) {
  updateEntries(env, (entries) => { delete entries[pr]; });
}
