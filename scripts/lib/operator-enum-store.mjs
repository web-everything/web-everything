/** Enum-valued host overrides (on/off style settings) live in their OWN file, never in the numeric capacity store:
 *  older strict capacity readers treat any non-numeric row as an invalid store and would switch every override off. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ENUM_LEAVES, isEnumLeaf, validEnumValue, operatorOverridesPath } from './operator-override-reader.mjs';

export const ENUM_STORE_FILE = 'operator-enum-overrides.json';
const MAX_BYTES = 16 * 1024;
const refused = reason => ({ ok: false, reason });
/** The enum store sits beside the numeric one (`file` is the numeric store's path, or the host default). */
export const enumOverridesPath = (file = operatorOverridesPath()) => join(dirname(file), ENUM_STORE_FILE);

/** Validate the whole raw text: a flat object of declared enum keys with allowed values and no duplicate keys. */
export function validateEnumStoreText(raw) {
  try {
    if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES) return refused('too-large');
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return refused('invalid-json'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return refused('invalid-store');
    const keys = (raw.match(/"(?:[^"\\]|\\.)*"(?=\s*:)/g) ?? []).map(token => JSON.parse(token));
    if (keys.length !== new Set(keys).size || keys.length !== Object.keys(parsed).length) return refused('duplicate key');
    if (Object.entries(parsed).some(([k, v]) => !isEnumLeaf(k) || !validEnumValue(k, v))) return refused('invalid-key-or-value');
    return { ok: true, values: parsed };
  } catch { return refused('error'); }
}

/** Read the enum store: bounded, regular file only, no symlinks. `absent` means no file; anything else wrong is a refusal. */
export function readEnumStore({ file } = {}) {
  let fd;
  try {
    const path = enumOverridesPath(file);
    let stat;
    try { stat = lstatSync(path); } catch (error) { return refused(error?.code === 'ENOENT' ? 'absent' : 'unreadable'); }
    if (!stat.isFile()) return refused('not-regular-file');
    if (stat.size > MAX_BYTES) return refused('too-large');
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) return refused('not-regular-file');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, size);
      if (count === 0) break;
      size += count;
    }
    return size > MAX_BYTES ? refused('too-large') : validateEnumStoreText(buffer.toString('utf8', 0, size));
  } catch { return refused('unreadable'); }
  finally { if (fd !== undefined) try { closeSync(fd); } catch { /* already closed */ } }
}

/** One enum override: `{ok:true,value}`, or `{ok:false,reason}` where `absent`/`not-set` mean nothing was ever set. */
export function readEnumOverride(key, options = {}) {
  try {
    if (!isEnumLeaf(key)) return refused('not-enum-key');
    const store = readEnumStore(options);
    if (!store.ok) return store;
    return Object.hasOwn(store.values, key) ? { ok: true, value: store.values[key] } : refused('not-set');
  } catch { return refused('error'); }
}
export { ENUM_LEAVES };
