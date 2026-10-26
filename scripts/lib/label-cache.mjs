/** Shared label provisioning cache. This never caches PR state or merge/review decisions. */
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cascadePolicy, platformPreference } from './policy-cascade.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const readJson = file => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const validTtl = v => Number.isSafeInteger(v) && v >= 0;

/** labels.cache.ttlMs: standard < platform < repo (scripts/settings/labels.json) < env. */
export function resolveLabelCachePolicy({ env = process.env, tool = readJson(join(ROOT, 'scripts/settings/labels.json'))?.labels,
  platform, log } = {}) {
  const raw = env.WE_LABELS_CACHE_TTL_MS;
  return cascadePolicy('labels.cache', { ttlMs: tool?.cache?.ttlMs }, {
    standard: { ttlMs: 3600000 },
    platform: (platform === undefined ? platformPreference('labels', { env }) : platform)?.cache ?? {},
    env, log, valid: validTtl,
    envValues: { ttlMs: raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : undefined },
  });
}

const localRepos = new Map();
/** Execute a provisioning argv via its existing runner. Cache IO failure falls back to provisioning.
 * Atomic replacement makes concurrent readers safe; a lost concurrent addition causes only an extra refresh.
 */
export function ensureLabelCached(args, { exec, cwd = process.cwd(), dir = join(ROOT, '.conveyor/label-cache'),
  now = Date.now, policy = resolveLabelCachePolicy() } = {}) {
  const createArgs = args.filter(arg => arg !== '--force');
  const name = args[2];
  const ttlMs = policy.value.ttlMs;
  const repoArgs = args.flatMap((arg, i) => arg === '--repo' ? [arg, args[i + 1]] : arg.startsWith('--repo=') ? [arg] : []);
  const provision = () => {
    try { return exec(createArgs); }
    catch (error) {
      // Keep uncached/fallback provisioning idempotent without overwriting label metadata.
      try {
        const labels = JSON.parse(String(exec(['label', 'list', ...repoArgs, '--limit', '1000', '--json', 'name'])));
        if (Array.isArray(labels) && labels.some(label => label?.name === name)) return '';
      } catch { /* preserve the creation failure */ }
      throw error;
    }
  };
  if (ttlMs === 0) return provision();
  let repo = args.find(arg => arg.startsWith('--repo='))?.slice(7);
  const index = args.indexOf('--repo');
  if (index >= 0) repo = args[index + 1];
  try {
    if (!repo) {
      const key = `${process.env.GH_HOST || 'github.com'}:${resolve(cwd)}`;
      repo = localRepos.get(key);
      if (!repo) {
        repo = String(exec(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'])).trim();
        if (!repo) throw new Error('repository unavailable');
        localRepos.set(key, repo);
      }
    }
  } catch { return provision(); }
  const file = join(dir, `${createHash('sha256').update(`${process.env.GH_HOST || 'github.com'}:${repo.toLowerCase()}`).digest('hex')}.json`);
  const read = () => {
    const row = readJson(file);
    return row?.repo === repo.toLowerCase() && Number.isFinite(row.refreshedAt)
      && Array.isArray(row.names) && row.names.every(n => typeof n === 'string') ? row : null;
  };
  const save = row => {
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(temp, JSON.stringify(row), { mode: 0o600 });
      renameSync(temp, file);
    } catch { /* cache persistence must never prevent label provisioning */ }
    finally { try { unlinkSync(temp); } catch { /* renamed or never written */ } }
  };
  const refresh = () => {
    const labels = JSON.parse(String(exec(['label', 'list', '--repo', repo, '--limit', '1000', '--json', 'name'])));
    if (!Array.isArray(labels) || labels.some(l => typeof l?.name !== 'string')) throw new Error('invalid label list');
    const row = { repo: repo.toLowerCase(), refreshedAt: now(), names: labels.map(l => l.name) };
    save(row);
    return row;
  };
  let row = read();
  try {
    let refreshed = false;
    if (!row || now() - row.refreshedAt >= ttlMs || now() < row.refreshedAt) { row = refresh(); refreshed = true; }
    if (row.names.includes(name)) return '';
    // A fresh list already establishes absence; otherwise refresh the cached miss once.
    if (!refreshed) row = refresh();
    if (row.names.includes(name)) return '';
  } catch { return provision(); }
  let result;
  try { result = exec(createArgs); }
  catch (error) {
    // Another process may have minted it after our list. Only confirmed existence excuses failure.
    try { if (refresh().names.includes(name)) return ''; } catch { /* preserve original failure */ }
    throw error;
  }
  const latest = read();
  if (latest && latest.refreshedAt >= row.refreshedAt) row = latest;
  row.names = [...new Set([...row.names, name])];
  save(row); // Preserve the list's age: adding a label must not extend other entries' TTL.
  return result;
}
