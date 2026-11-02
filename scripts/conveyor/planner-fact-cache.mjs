/** Fresh-driven planner facts. No decisions or live session state belong here. */
import { createHash, randomUUID } from 'node:crypto';
import { readFile as fsReadFile, writeFile as fsWriteFile, rename, mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

export function prFactKey(row) {
  const labels = [...new Set((row.labels ?? []).map(l => typeof l === 'string' ? l : l?.name))].sort();
  const checks = (row.statusCheckRollup ?? []).map(c => JSON.stringify([
    c.name ?? c.context, c.status ?? c.state, c.conclusion, c.completedAt ?? c.completed_at,
  ])).sort();
  const checkHash = createHash('sha256').update(JSON.stringify(checks)).digest('hex');
  return JSON.stringify(['pr-fact-row', row.repo, row.number, row.headRefOid, row.baseSha ?? row.baseRefName, labels, checkHash]);
}

export function mainFactKey({ repo, mainSha }) {
  return JSON.stringify(['main', repo, mainSha]);
}

async function atomicWrite(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fsWriteFile(temp, data, { encoding: 'utf8', mode: 0o600 });
    await rename(temp, path);
  } finally { await unlink(temp).catch(() => {}); }
}
const plain = row => row !== null && typeof row === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(row));
const acceptable = row => plain(row) && !row.discoveryIncomplete && !row.deferred
  && !row.readFailed && !row['read-failed'] && !['deferred-low-budget', 'read-failed'].includes(row.outcome)
  && (!Object.hasOwn(row, 'commits') || Array.isArray(row.commits))
  && (!Object.hasOwn(row, 'comments') || Array.isArray(row.comments))
  && !['plan', 'dispatch'].some(k => Object.hasOwn(row, k));
const scopeOf = key => {
  try { const [type, repo, number] = JSON.parse(key); return type === 'pr-fact-row' ? JSON.stringify([repo, number]) : null; }
  catch { return null; }
};

export function createPlannerFactCache({ now = Date.now, ttlMs = 600_000, mode = 'shadow',
  snapshotPath = null, readFile = fsReadFile, writeFile = atomicWrite } = {}) {
  const rows = new Map();
  const scopes = new Map();
  let counters, diffCount = 0;
  let evidence = { firstShadowAt: null, passes: 0, diffs: 0 };
  const resetStats = () => { counters = { hits: 0, misses: 0, stores: 0, refused: 0, evictions: 0 }; diffCount = 0; };
  resetStats();
  const remove = key => {
    rows.delete(key);
    const scope = scopeOf(key);
    if (scopes.get(scope) === key) scopes.delete(scope);
  };
  const fresh = entry => Number.isFinite(entry?.storedAt) && entry.storedAt <= now() && now() - entry.storedAt < ttlMs;
  const cache = {
    mode,
    get diffCount() { return diffCount; },
    stats: () => ({ ...counters }), resetStats,
    lookup(key) {
      const entry = rows.get(key);
      if (!fresh(entry)) { remove(key); counters.misses++; return null; }
      counters.hits++;
      return structuredClone(entry.row);
    },
    store(key, row, { complete } = {}) {
      if (complete !== true || !acceptable(row)) { counters.refused++; return false; }
      const copy = structuredClone(row);
      const scope = scopeOf(key), previous = scopes.get(scope);
      if (scope && previous && previous !== key) { remove(previous); counters.evictions++; }
      rows.set(key, { row: copy, storedAt: now() });
      if (scope) scopes.set(scope, key);
      counters.stores++;
      return true;
    },
    compareShadow(cached, freshRow) {
      const diffs = [];
      const walk = (a, b, path) => {
        if (Object.is(a, b)) return;
        if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
          for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
            const next = path ? `${path}.${key}` : key;
            if (Object.hasOwn(a, key) !== Object.hasOwn(b, key)) diffs.push({ path: next, cached: a[key], fresh: b[key] });
            else walk(a[key], b[key], next);
          }
        } else diffs.push({ path, cached: a, fresh: b });
      };
      walk(cached, freshRow, '');
      diffCount += diffs.length;
      return { same: diffs.length === 0, diffs };
    },
    recordPass({ diffCount: count = 0, compared = 0 } = {}) {
      if (evidence.firstShadowAt === null) evidence.firstShadowAt = now();
      evidence.passes++;
      if (Number.isSafeInteger(compared) && compared > 0) evidence.comparedPasses = (evidence.comparedPasses ?? 0) + 1;
      evidence.diffs += Number.isSafeInteger(count) && count >= 0 ? count : 1;
    },
    shadowEndRule({ now: at = now() } = {}) {
      const hours = evidence.firstShadowAt === null ? 0 : Math.max(0, at - evidence.firstShadowAt) / 3_600_000;
      const { passes, diffs } = evidence;
      const comparedPasses = evidence.comparedPasses ?? 0;
      // Passes with zero cache-vs-fresh comparisons prove nothing: promotion needs 100 passes that really compared rows.
      const met = hours >= 48 && passes >= 100 && comparedPasses >= 100 && diffs === 0;
      return { met, hours, passes, comparedPasses, diffs, reason: diffs ? 'shadow differences observed; do not promote' : met ? 'shadow evidence meets promotion rule' : 'awaiting 48 hours and 100 passes with cache comparisons' };
    },
    async saveSnapshot() {
      if (!snapshotPath) return;
      for (const [key, entry] of rows) if (!fresh(entry)) remove(key);
      await writeFile(snapshotPath, JSON.stringify({ version: 1, entries: [...rows], evidence }));
    },
    async loadSnapshot() {
      rows.clear(); scopes.clear();
      evidence = { firstShadowAt: null, passes: 0, diffs: 0 };
      if (!snapshotPath) return;
      try {
        const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
        const e = snapshot.evidence;
        if (snapshot.version !== 1 || !Array.isArray(snapshot.entries) || !plain(e)
          || !(e.firstShadowAt === null || (Number.isFinite(e.firstShadowAt) && e.firstShadowAt <= now()))
          || !Number.isSafeInteger(e.passes) || e.passes < 0 || !Number.isSafeInteger(e.diffs) || e.diffs < 0
          || (e.passes > 0 && e.firstShadowAt === null)) return;
        evidence = { ...e };
        for (const item of snapshot.entries) {
          if (!Array.isArray(item) || item.length !== 2) continue;
          const [key, entry] = item;
          if (typeof key !== 'string' || !fresh(entry) || !acceptable(entry.row)) continue;
          const scope = scopeOf(key);
          if (scope && scopes.has(scope)) remove(scopes.get(scope));
          rows.set(key, entry);
          if (scope) scopes.set(scope, key);
        }
      } catch { rows.clear(); scopes.clear(); evidence = { firstShadowAt: null, passes: 0, diffs: 0 }; }
    },
  };
  return cache;
}

/** Preserve synchronous readers; asynchronous fresh readers remain supported. */
export function readThroughShadow({ cache, key, readFresh, complete }) {
  const cached = cache.lookup(key);
  const finish = row => {
    const shadow = cached === null ? { hit: false, same: true, diffs: [] }
      : { hit: true, ...cache.compareShadow(cached, row) };
    cache.store(key, row, { complete: typeof complete === 'function' ? complete(row) : complete });
    return { row, shadow };
  };
  const row = readFresh();
  return row && typeof row.then === 'function' ? row.then(finish) : finish(row);
}
