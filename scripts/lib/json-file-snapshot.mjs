/**
 * Card xwu9oxh slice S2a: parse a large JSON file (the 45 MB scorecard store) once per process while it is
 * unchanged and still in use, instead of once per reader.
 *
 * Every call stats the file first. A cached parse is reused only when the file's identity key (device, inode,
 * size, mtime and ctime in ns) still matches the key recorded when it was read, so the answer equals a fresh read at
 * this moment. Any stat error, or a file that changed while it was being read, means no reuse: the file is
 * read fresh and that read is returned. A file changed less than SNAPSHOT_SETTLE_MS before the read is never
 * cached (git's racy-clean rule), so a same-tick rewrite cannot hide behind an unchanged key. The cache holds the parse only weakly (WeakRef), so it never keeps
 * memory alive that today's code would have freed.
 *
 * The shared value is DEEP-FROZEN: a reader that tries to change it throws instead of silently changing what
 * the next reader sees. Readers that need to change rows must keep using their own fresh parse.
 *
 * Errors match a plain `JSON.parse(readFileSync(path, 'utf8'))`: a read error is thrown as is (same `code`),
 * and a parse error is returned as `{ parseError }` (the original SyntaxError) so each caller keeps its own
 * handling. Errors are never cached.
 */
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const cache = new Map();

const keyOf = (path) => {
  try {
    const s = statSync(path, { bigint: true });
    return { key: `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`, mtimeMs: Number(s.mtimeMs) };
  } catch {
    return null;
  }
};

/** Like git's racy-clean rule: a file changed within this window could change again inside the same clock tick
 *  (coarse filesystem timestamps) with the same size and a reused inode, so it is never cached. */
export const SNAPSHOT_SETTLE_MS = 2000;

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return value;
}

/** Turn sharing off (`WE_JSON_SNAPSHOT_SHARED=off|false|0`): every call then reads and parses fresh and the value
 *  is not frozen, exactly today's `JSON.parse(readFileSync(path, 'utf8'))`. */
const sharingOff = (env) => /^(off|false|0)$/i.test(String(env.WE_JSON_SNAPSHOT_SHARED ?? ''));

/**
 * @param {string} path
 * @param {{env?: object}} [o]
 * @returns {{value: any} | {parseError: Error}} `value` is deep-frozen unless sharing is off.
 */
export function readJsonSnapshot(path, { env = process.env } = {}) {
  const full = resolve(path);
  const off = sharingOff(env);
  const before = off ? null : keyOf(full);
  if (before) {
    const hit = cache.get(full);
    const value = hit?.key === before.key ? hit.ref.deref() : undefined;
    if (value !== undefined) return { value };
  }
  cache.delete(full);
  const readStartedAt = Date.now();
  const text = readFileSync(full, 'utf8');
  let value;
  try { value = JSON.parse(text); } catch (parseError) { return { parseError }; }
  if (off) return { value };
  deepFreeze(value);
  // Cache only a file that was already settled before this read began and did not change during it.
  if (before && value !== null && typeof value === 'object' && readStartedAt - before.mtimeMs > SNAPSHOT_SETTLE_MS
    && keyOf(full)?.key === before.key) {
    cache.set(full, { key: before.key, ref: new WeakRef(value) });
  }
  return { value };
}

/** Test seam: forget every cached parse. */
export function clearJsonSnapshots() {
  cache.clear();
}
