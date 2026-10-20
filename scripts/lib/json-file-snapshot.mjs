/**
 * Card xwu9oxh slice S2a: parse a large JSON file (the 45 MB scorecard store) once per process while it is
 * unchanged and still in use, instead of once per reader.
 *
 * Every call opens the file and checks the open file's identity key (device, inode, size, mtime and ctime in
 * ns). A cached parse is reused only when that key still matches the key recorded when it was read, so the
 * answer equals a fresh read at this moment. Any stat error, or a file that changed while it was being read,
 * means no reuse: the file is read fresh and that read is returned. A file changed less than
 * SNAPSHOT_SETTLE_MS before the read is never cached (git's racy-clean rule), so a same-tick rewrite cannot
 * hide behind an unchanged key. One parse per path is kept (replaced when the file changes).
 *
 * The shared value is DEEP-FROZEN: a reader that tries to change it throws instead of silently changing what
 * the next reader sees. Readers that need to change rows must keep using their own fresh parse.
 *
 * Errors match a plain `JSON.parse(readFileSync(path, 'utf8'))`: an open or read error is thrown as is (same `code`),
 * and a parse error is returned as `{ parseError }` (the original SyntaxError) so each caller keeps its own
 * handling. Errors are never cached.
 */
import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const cache = new Map();

/** Identity of the OPEN file: the key is bound to the very inode this call reads (or would have read). */
const keyOfFd = (fd) => {
  try {
    const s = fstatSync(fd, { bigint: true });
    return {
      key: `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`,
      changedMs: Math.max(Number(s.mtimeMs), Number(s.ctimeMs)),
    };
  } catch {
    return null;
  }
};

/** Like git's racy-clean rule: a file whose content OR metadata (mtime or ctime) changed within this window could
 *  change again inside the same clock tick (coarse timestamps) with the same size and a reused inode, so it is
 *  never cached. ctime cannot be set back by a writer, so a later rewrite always moves the key. */
export const SNAPSHOT_SETTLE_MS = 2000;

/** Iterative, so a deeply nested value can never overflow the stack (a recursive freeze could, and a caller
 *  that degrades on any error would then silently see an empty store). */
function deepFreeze(root) {
  const stack = [root];
  while (stack.length) {
    const value = stack.pop();
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) continue;
    Object.freeze(value);
    for (const key of Object.keys(value)) stack.push(value[key]);
  }
  return root;
}

/** Turn sharing off (`WE_JSON_SNAPSHOT_SHARED=off|false|0`): every call then reads and parses fresh and the value
 *  is not frozen, exactly today's `JSON.parse(readFileSync(path, 'utf8'))`. */
const sharingOff = (env) => /^(off|false|0)$/i.test(String(env.WE_JSON_SNAPSHOT_SHARED ?? ''));

/**
 * The file is always OPENED first, exactly as `readFileSync(path)` opens it, so every open error (ENOENT,
 * EACCES, ...) is thrown as is even when a parse is cached. Only then is the open file's identity compared.
 * @param {string} path
 * @param {{env?: object}} [o]
 * @returns {{value: any} | {parseError: Error}} `value` is deep-frozen unless sharing is off.
 */
export function readJsonSnapshot(path, { env = process.env } = {}) {
  const full = resolve(path);
  if (sharingOff(env)) {
    const text = readFileSync(path, 'utf8');
    try { return { value: JSON.parse(text) }; } catch (parseError) { return { parseError }; }
  }
  const fd = openSync(path, 'r'); // the caller's own path string, so an open error reads exactly as before
  try {
    const before = keyOfFd(fd);
    const hit = cache.get(full);
    if (before && hit?.key === before.key) return { value: hit.value };
    cache.delete(full);
    const readStartedAt = Date.now();
    const text = readFileSync(fd, 'utf8');
    let value;
    try { value = JSON.parse(text); } catch (parseError) { return { parseError }; }
    deepFreeze(value);
    // Cache only a file that was already settled before this read began and did not change during it.
    if (before && value !== null && typeof value === 'object' && readStartedAt - before.changedMs > SNAPSHOT_SETTLE_MS
      && keyOfFd(fd)?.key === before.key) {
      cache.set(full, { key: before.key, value });
    }
    return { value };
  } finally {
    closeSync(fd);
  }
}

/** Test seam: forget every cached parse. */
export function clearJsonSnapshots() {
  cache.clear();
}
