const { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, renameSync, unlinkSync } = require('node:fs');
const { join, dirname } = require('node:path');
const { tmpdir } = require('node:os');
const { createHash } = require('node:crypto');
const { serialize, deserialize } = require('node:v8');

const sha1 = (value) => createHash('sha1').update(value).digest('hex');
const fingerprint = (backlogDir, name) => {
  try {
    const { mtimeMs, size, ino } = statSync(join(backlogDir, name));
    return `${name}|${mtimeMs}|${size}|${ino}`;
  } catch { return null; }
};

// One load owns one disk snapshot. Values are serialized BEFORE callers can add graph fields.
// readCard may return null for malformed cards or call skipCache for external dependencies.
function createBacklogIndex({ backlogDir, indexDir = process.env.WE_BACKLOG_INDEX_DIR, loaderVersion, readCard }) {
  const enabled = process.env.WE_BACKLOG_INDEX !== '0' && (!process.env.VITEST || Boolean(indexDir));
  const file = join(indexDir || join(tmpdir(), `we-backlog-index-${process.getuid?.() ?? 'unknown'}`),
    `${sha1(backlogDir)}.bin`);
  const stats = { hits: 0, misses: 0 };
  return {
    stats,
    load(names) {
      stats.hits = stats.misses = 0;
      let entries = new Map();
      let changed = false;
      if (enabled) {
        try {
          const saved = deserialize(readFileSync(file));
          if (saved.version === loaderVersion && saved.entries instanceof Map) entries = saved.entries;
        } catch { /* absent or corrupt index: parse normally */ }
        // A scoped load must retain other existing cards, while removing deleted ones.
        try {
          const present = new Set(readdirSync(backlogDir));
          for (const name of entries.keys()) {
            if (!present.has(name)) { entries.delete(name); changed = true; }
          }
        } catch { entries = new Map(); }
      }
      const values = names.map((name) => {
        const key = enabled ? fingerprint(backlogDir, name) : null;
        const entry = entries.get(name);
        if (key !== null && entry?.key === key && Buffer.isBuffer(entry.value)) {
          try {
            const value = deserialize(entry.value);
            if (value && typeof value === 'object') { stats.hits++; return value; }
          } catch { /* bad entry: re-parse */ }
        }
        if (entries.delete(name)) changed = true;
        stats.misses++;
        let cacheable = true;
        const value = readCard(name, { skipCache() { cacheable = false; } });
        if (enabled && key !== null && cacheable && value != null && fingerprint(backlogDir, name) === key) {
          try {
            entries.set(name, { key, value: serialize(value) });
            changed = true;
          } catch { /* unsupported value: return the original, never cache it */ }
        }
        return value;
      });
      if (enabled && changed) {
        let temp;
        try {
          mkdirSync(dirname(file), { recursive: true });
          temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
          writeFileSync(temp, serialize({ version: loaderVersion, entries }));
          renameSync(temp, file);
        } catch { /* best-effort cache */ }
        finally { if (temp) { try { unlinkSync(temp); } catch { /* renamed or unavailable */ } } }
      }
      return values;
    },
  };
}

module.exports = { createBacklogIndex };
