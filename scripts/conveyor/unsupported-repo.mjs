/** Durable owed work that a constellation dispatcher cannot run. */
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withLedgerAppendLock } from '../lib/ledger-append-lock.mjs';
import { randomUUID } from 'node:crypto';

export const UNSUPPORTED_REPO_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../../.conveyor/unsupported-repo.json');

export function readUnsupported({ path = UNSUPPORTED_REPO_FILE } = {}) {
  try {
    const rows = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(rows) && rows.every((row) => row && typeof row === 'object') ? rows : [];
  } catch { return []; }
}

/** Replace a repo's rows (or only the named actions) under one lock. Empty rows clear that scope. */
export function recordUnsupported({ repo, rows, actions = null, path = UNSUPPORTED_REPO_FILE, now = () => new Date().toISOString() }) {
  return withLedgerAppendLock(`unsupported-repo:${resolve(path)}`, () => {
    let previous;
    try { previous = JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; previous = []; }
    if (!Array.isArray(previous) || previous.some(row => !row || typeof row !== 'object')) throw new Error('unsupported records unreadable; refusing replacement');
    if (actions !== null && (!Array.isArray(actions) || !actions.length || actions.some(action => typeof action !== 'string')
      || rows.some(row => !actions.includes(row.action)))) throw new Error('unsupported action scope incomplete; refusing replacement');
    const next = previous.filter((row) => row.repo !== repo || (actions !== null && !actions.includes(row.action)));
    next.push(...rows.map((row) => ({ ...row, repo, at: row.at ?? now() })));
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { flag: 'wx' });
      renameSync(temp, path);
    } finally {
      try { unlinkSync(temp); } catch { /* renamed or never created */ }
    }
    return next;
  });
}
