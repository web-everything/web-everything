/**
 * Operator 2026-10-19 hotfix: best-effort persistent commit lists ONLY for collectOpenPrContext.
 * No gh/git dependencies. Filesystem and clock are injectable; one file per repo/PR is replaced atomically.
 */
import * as nodeFs from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { cascadePolicy } from './policy-cascade.mjs';
import { readDeclaredSettings } from './settings-files.mjs';
import { prSnapshotDir, prSnapshotEnabled, snapshotKey } from './pr-snapshot-store.mjs';
import { writeJsonAtomic } from './atomic-json-file.mjs';

export function resolveDrainContextCacheSettings({ env = process.env, readSettings = readDeclaredSettings, tool, platform } = {}) {
  let block = tool;
  if (block === undefined) {
    try { block = readSettings().settings?.drain; } catch { block = undefined; }
  }
  const bool = String(env.WE_DRAIN_CONTEXT_CACHE ?? '').trim().toLowerCase();
  const age = String(env.WE_DRAIN_CONTEXT_CACHE_MAX_AGE_SEC ?? '').trim();
  const c = cascadePolicy('drain', block, {
    env, standard: { contextCache: true, contextCacheMaxAgeSec: 900 },
    envValues: {
      contextCache: bool ? ({ true: true, false: false, on: true, off: false, 1: true, 0: false }[bool] ?? bool) : undefined,
      contextCacheMaxAgeSec: age ? (/^\d+$/.test(age) ? Number(age) : age) : undefined,
    },
    valid: { contextCache: v => typeof v === 'boolean', contextCacheMaxAgeSec: v => Number.isSafeInteger(v) && v > 0 },
    ...(platform !== undefined ? { platform } : {}), log: () => {},
  });
  const { contextCache, contextCacheMaxAgeSec } = c.value;
  const line = `contextCache=${contextCache} (${c.sources.contextCache}), maxAgeSec=${contextCacheMaxAgeSec} (${c.sources.contextCacheMaxAgeSec})`;
  return { contextCache, contextCacheMaxAgeSec, sources: c.sources, line,
    invalid: c.invalid };
}

/**
 * key = { repo, num, headRefOid, updatedAt, identity, readCommits }.
 * identity is prReadCacheIdentity(p); readCommits gates all reads, writes, and accounting.
 * Undefined means miss. Missing listing freshness/identity bypasses both reads and writes.
 */
export function createDrainContextCache({ env = process.env, dir = null, enabled = true, maxAgeSec = 900,
  fs = nodeFs, now = Date.now } = {}) {
  const active = enabled && (!!dir || prSnapshotEnabled(env));
  const root = join(dir || prSnapshotDir(env), 'drain-context-cache');
  const stats = { hits: 0, misses: 0, savedMs: 0 };
  const keyFields = ['repo', 'num', 'headRefOid', 'updatedAt', 'identity'];
  const entryFields = ['v', ...keyFields, 'savedAt', 'readMs', 'commits'];
  const plainObject = value => value !== null && typeof value === 'object'
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  const validCommits = commits => Array.isArray(commits) && commits.every(plainObject);
  const locate = key => {
    const repo = snapshotKey(key?.repo);
    if (!repo || typeof key.repo !== 'string' || !Number.isSafeInteger(key.num) || key.num <= 0
      || typeof key.headRefOid !== 'string' || !key.headRefOid
      || typeof key.updatedAt !== 'string' || !key.updatedAt || typeof key.identity !== 'string' || !key.identity) return null;
    // Persist only a digest of the body identity, never the manifest-bearing PR body.
    const fields = Object.fromEntries(keyFields.map(field => [field, key[field]]));
    fields.identity = createHash('sha256').update(key.identity).digest('hex');
    return { path: join(root, `${repo}-${key.num}.json`), fields };
  };
  return {
    stats,
    get(key) {
      if (key?.readCommits !== true) return undefined;
      try {
        const location = active && locate(key);
        if (location) {
          const entry = JSON.parse(fs.readFileSync(location.path, 'utf8'));
          if (plainObject(entry) && Object.keys(entry).length === entryFields.length
            && entryFields.every(field => Object.hasOwn(entry, field))
            && entry.v === 2 && keyFields.every(field => entry[field] === location.fields[field])
            && Number.isFinite(entry.savedAt) && Number.isFinite(entry.readMs) && entry.readMs >= 0
            && validCommits(entry.commits)) {
            const age = now() - entry.savedAt;
            if (age >= 0 && age <= maxAgeSec * 1000) {
              stats.hits++;
              stats.savedMs += entry.readMs;
              return entry.commits;
            }
          }
        }
      } catch { /* corrupt/unreadable is a miss */ }
      stats.misses++;
      return undefined;
    },
    set(key, commits, readMs = 0) {
      try {
        const location = active && locate(key);
        const savedAt = now();
        if (key?.readCommits !== true || !location || !validCommits(commits)
          || !Number.isFinite(savedAt) || !Number.isFinite(readMs) || readMs < 0) return false;
        fs.mkdirSync(root, { recursive: true });
        const entry = { v: 2, ...location.fields,
          savedAt, readMs, commits };
        writeJsonAtomic(location.path, entry, {
          writeFileSyncFn: fs.writeFileSync, renameSyncFn: fs.renameSync, readFileSyncFn: fs.readFileSync,
          unlinkSyncFn: fs.unlinkSync, realpathSyncFn: fs.realpathSync,
        });
        return true;
      } catch { return false; }
    },
  };
}
