/**
 * Salvage store for a GREEN-verified sha the harness could not push because GitHub kept failing (5xx, timeouts).
 *
 * Live 2026-10-07: the verified fix for PR #4244 (23142af5) was dropped after one GitHub 500 because the verdict
 * record was cleared once the fixer was resumed, and the fixer then released its claim. The commit survived only in
 * an agent-writable lane's reflog. Now, when the in-call backoff and the per-tick retries are all spent, the pass
 * (1) copies the commit into a daemon-owned bare repo (it no longer depends on the lane surviving) and (2) writes a
 * salvage record. Every later daemon tick re-tries that push (never force, same PR/ref checks) with bounded
 * attempts and a TTL, and records a clear outcome: pushed, already-there, moved-by-someone-else, PR-closed,
 * expired or exhausted.
 *
 * The gate is not weakened: a record only exists because the verdict was green for exactly this sha, and the push
 * names that sha. Pure helpers here; the filesystem/git shell is injectable like the rest of the pass.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, unlinkSync, rmSync, existsSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';

export const SALVAGE_STORE_ENV = 'WE_AWAIT_VERIFY_SALVAGE_STORE';
export const SALVAGE_TTL_ENV = 'WE_AWAIT_VERIFY_SALVAGE_TTL_MINUTES';
export const SALVAGE_MAX_ATTEMPTS_ENV = 'WE_AWAIT_VERIFY_SALVAGE_MAX_ATTEMPTS';
export const SALVAGE_RETRY_MINUTES_ENV = 'WE_AWAIT_VERIFY_SALVAGE_RETRY_MINUTES';

export function salvageStoreDir(env = process.env) {
  const override = String(env?.[SALVAGE_STORE_ENV] ?? '').trim();
  return override ? resolve(override) : join(resolveCoordinationRoot({ env }), 'await-verify-salvage');
}

/** Knobs: TTL (default 12h), attempts (default 12), minutes between tries, multiplied by attempts so far (default 2). */
export function resolveSalvageTuning(env = process.env) {
  const num = (key, dflt) => { const n = Number(env?.[key]); return env?.[key] === undefined || env?.[key] === '' || !Number.isFinite(n) || n <= 0 ? dflt : n; };
  return {
    ttlMs: num(SALVAGE_TTL_ENV, 12 * 60) * 60_000,
    maxAttempts: Math.floor(num(SALVAGE_MAX_ATTEMPTS_ENV, 12)),
    retryMs: num(SALVAGE_RETRY_MINUTES_ENV, 2) * 60_000,
  };
}

const SHA_RE = /^[a-f\d]{40}$/i;
export const salvageKey = ({ pr, sha }) => `${pr}-${String(sha).slice(0, 12)}`;
export function isSalvageRecord(r) {
  return !!r && r.v === 1 && Number.isInteger(r.pr) && r.pr > 0 && SHA_RE.test(String(r.sha ?? ''))
    && typeof r.repo === 'string' && /^lane\/[A-Za-z0-9._/-]+$/.test(String(r.ref ?? '')) && !String(r.ref).includes('..')
    && Number.isFinite(Date.parse(r.savedAt));
}

export function listSalvage({ dir = salvageStoreDir() } = {}) {
  let names = [];
  try { names = readdirSync(dir); } catch { return []; }
  return names.filter((n) => n.endsWith('.json')).sort().flatMap((n) => {
    try { const record = JSON.parse(readFileSync(join(dir, n), 'utf8')); return isSalvageRecord(record) ? [{ key: n.slice(0, -5), record }] : []; } catch { return []; }
  });
}
export function writeSalvage(record, { dir = salvageStoreDir() } = {}) {
  if (!isSalvageRecord(record)) return { ok: false, reason: 'malformed' };
  const path = join(dir, `${salvageKey(record)}.json`);
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'wx' });
    renameSync(tmp, path);
    return { ok: true, path };
  } catch {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    return { ok: false, reason: 'write-failed' };
  }
}
export function clearSalvage(key, { dir = salvageStoreDir() } = {}) {
  let cleared = false;
  try { unlinkSync(join(dir, `${key}.json`)); cleared = true; } catch { /* already gone */ }
  try { rmSync(join(dir, `${key}.git`), { recursive: true, force: true }); } catch { /* best effort */ }
  return { cleared };
}

/** What the next tick does with a record. Pure. -> {action:'drop'|'wait'|'push', reason} */
export function planSalvage(record, { nowMs, tuning = resolveSalvageTuning() }) {
  const age = nowMs - Date.parse(record.savedAt);
  if (age > tuning.ttlMs) return { action: 'drop', reason: 'expired' };
  if ((record.attempts ?? 0) >= tuning.maxAttempts) return { action: 'drop', reason: 'attempts-exhausted' };
  const next = Date.parse(record.nextAttemptAt ?? record.savedAt);
  if (Number.isFinite(next) && nowMs < next) return { action: 'wait', reason: 'cooling-off' };
  return { action: 'push', reason: 'retry' };
}

/**
 * Copy `sha` and its history into a daemon-owned bare repo at `<dir>/<key>.git`, reading the lane's objects via
 * alternates only (the lane config is never consulted). Returns `{ok, gitDir}`; `exec` is injectable.
 */
export function stashCommit({ exec, laneGitDir, sha, key, dir = salvageStoreDir(), env = process.env }) {
  const gitDir = join(dir, `${key}.git`);
  const base = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 };
  const clean = { ...env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY']) delete clean[k];
  const run = (args, withAlt) => String(exec('git', ['--git-dir', gitDir, '-c', 'core.hooksPath=/dev/null', ...args],
    { ...base, env: { ...clean, GIT_TERMINAL_PROMPT: '0', ...(withAlt ? { GIT_ALTERNATE_OBJECT_DIRECTORIES: join(laneGitDir, 'objects') } : {}) } }));
  try {
    mkdirSync(dir, { recursive: true });
    exec('git', ['init', '--bare', '--quiet', gitDir], { ...base, env: clean });
    // A shallow lane: its boundary must travel with the objects, or the copy would look like it is missing parents.
    const shallow = join(laneGitDir, 'shallow');
    if (existsSync(shallow)) copyFileSync(shallow, join(gitDir, 'shallow'));
    run(['update-ref', `refs/salvage/${key}`, sha], true);
    run(['repack', '-a', '-d', '-q'], true); // without -l: objects borrowed from the lane are copied into our own pack
    run(['cat-file', '-e', `${sha}^{commit}`], false); // proves the copy stands on its own, with no lane
    return { ok: true, gitDir };
  } catch {
    try { rmSync(gitDir, { recursive: true, force: true }); } catch { /* best effort */ }
    return { ok: false };
  }
}
