/**
 * Card 309 — host-shared finished CI reads. Job ids are per attempt: once completed, their logs are final
 * and cached for at most 24 hours, with completion proved BEFORE fetching the log. Full run job lists require a completed
 * parent run and revalidate after 10 min. Check-runs and jq projections stay live: they cannot prove closure
 * and completeness (later workflows can add checks to even an old commit).
 * Policy finishedCiCache: enabled=true, maxBytes=2 GiB, runJobsRevalidateMs=600000
 * (0 skips revalidation within the 24-hour retention limit). Env overrides: WE_FINISHED_CI_CACHE=0,
 * WE_FINISHED_CI_CACHE_MAX_BYTES, WE_FINISHED_CI_CACHE_RUN_JOBS_REVALIDATE_MS.
 * Unsuccessful proofs retry after 10 min; payloads remain live. Entries over 16 MiB are not cached.
 * Every write accounts for payloads and temporary files (at most 4096 files); expired files are removed on lookup/maintenance.
 * Cleanup is opportunistic, not a background eraser when no process uses the cache.
 * WE_FINISHED_CI_CACHE_DIR overrides ~/.claude/conveyor/finished-ci-cache (leading ~ expands).
 * All cache IO is best effort and injectable via options.fs; no cache failure reaches a gh caller.
 * Entries are scoped to a hash of the host and explicit credentials; stored-login and dynamically routed auth stay live.
 */
import * as nodeFs from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { cascadePolicy, platformPreference } from './policy-cascade.mjs';
import { isUnderTest } from './under-test.mjs';

const STANDARD = Object.freeze({ enabled: true, maxBytes: 2 * 1024 ** 3, runJobsRevalidateMs: 600000 });
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PROOF_RETRY_MS = 600000;
const MAX_ENTRY_BYTES = 16 * 1024 ** 2;
const MAX_ENCODED_BYTES = Math.ceil(MAX_ENTRY_BYTES * 4 / 3) + 65536;
const MAX_FILES = 4096;
export function resolveFinishedCiCacheSettings(env = process.env) {
  const int = k => { const v = env[k]; const n = Number(v); return v != null && v !== '' && Number.isSafeInteger(n) && n >= 0 ? n : undefined; };
  let settings = { ...STANDARD, source: {} };
  try {
    const preference = platformPreference('finishedCiCache', { env });
    const platform = Object.fromEntries(Object.keys(STANDARD).filter(k => preference?.[k] !== undefined).map(k => [k, preference[k]]));
    const r = cascadePolicy('finishedCiCache', undefined, { env, standard: STANDARD,
      platform,
      envValues: { enabled: env.WE_FINISHED_CI_CACHE === '0' ? false : env.WE_FINISHED_CI_CACHE === '1' ? true : undefined,
        maxBytes: int('WE_FINISHED_CI_CACHE_MAX_BYTES'), runJobsRevalidateMs: int('WE_FINISHED_CI_CACHE_RUN_JOBS_REVALIDATE_MS') },
      valid: { enabled: v => typeof v === 'boolean', maxBytes: n => Number.isSafeInteger(n) && n >= 0,
        runJobsRevalidateMs: n => Number.isSafeInteger(n) && n >= 0 } });
    settings = { ...STANDARD, ...r.value, source: r.sources || {} };
  } catch { /* Standard fallback. */ }
  if ((isUnderTest(env) || env.FAKE_GH_FIXTURE) && !env.WE_FINISHED_CI_CACHE_DIR) {
    settings.enabled = false; settings.source.enabled = 'test';
  }
  return settings;
}
export function finishedCiCacheDir(env = process.env) {
  const home = env.HOME || homedir();
  const raw = String(env.WE_FINISHED_CI_CACHE_DIR || '').trim();
  return raw ? resolve(raw.startsWith('~') ? join(home, raw.slice(1)) : raw) : join(home, '.claude', 'conveyor', 'finished-ci-cache');
}
/** An irrelevant token must not vouch for a stored login on a different host. Never persist credentials. */
export function finishedCiAuthScope(env = process.env) {
  const host = String(env.GH_HOST || 'github.com').toLowerCase();
  const keys = host === 'github.com' || host.endsWith('.ghe.com')
    ? ['GH_TOKEN', 'GITHUB_TOKEN'] : ['GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];
  const token = env[keys[0]] || env[keys[1]];
  return token ? createHash('sha256').update(JSON.stringify([host, String(token)])).digest('hex') : null;
}
export function classifyFinishedCiRead(args) {
  if (!Array.isArray(args) || args[0] !== 'api' || typeof args[1] !== 'string') return null;
  const m = /^\/?repos\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(?:actions\/jobs\/(\d+)\/logs|actions\/runs\/(\d+)\/jobs(?:\?[^\s]*)?|commits\/([a-fA-F0-9]{40})\/check-runs(?:\?[^\s]*)?)$/.exec(args[1]);
  if (!m) return null;
  const kind = m[2] ? 'job-log' : m[3] ? 'run-jobs' : 'check-runs';
  const jq = kind === 'run-jobs' ? '.jobs' : kind === 'check-runs' ? '.check_runs' : null;
  if (args.length !== 2 && !(jq && ((args.length === 4 && args[2] === '--jq' && args[3] === jq)
    || (args.length === 3 && args[2] === `--jq=${jq}`)))) return null;
  return { kind, repo: m[1], id: m[2] || m[3] || m[4], key: JSON.stringify(args) };
}
export function finishedCiStorable(cls, stdoutText, { runCompleted = false } = {}) {
  try {
    if (!cls || cls.kind !== 'run-jobs' || !runCompleted) return false;
    const data = JSON.parse(String(stdoutText));
    const rows = data?.jobs;
    return JSON.parse(cls.key).length === 2 && Array.isArray(rows) && rows.length > 0
      && data.total_count === rows.length && rows.every(row => row?.status === 'completed');
  } catch { return false; }
}
export function finishedCiCacheable(cls) {
  return cls?.kind === 'job-log' || (cls?.kind === 'run-jobs' && JSON.parse(cls.key).length === 2);
}
/** A collection needs a closed parent, and every immutability proof must precede its payload. */
export function finishedCiProofArgs(cls, o = {}) {
  if (!finishedCiCacheable(cls)) return null;
  try {
    const c = context(o);
    const age = c.nowMs - c.fs.statSync(join(c.dir, filename(cls, c.authScope) + '.retry')).mtimeMs;
    if (age >= 0 && age < PROOF_RETRY_MS) return null;
  } catch { /* No recent unsuccessful proof. */ }
  if (cls?.kind === 'job-log') return ['api', `repos/${cls.repo}/actions/jobs/${cls.id}`];
  if (cls?.kind === 'run-jobs' && JSON.parse(cls.key).length === 2)
    return ['api', `repos/${cls.repo}/actions/runs/${cls.id}`];
  return null;
}
/** Only suppress redundant proofs, never serve unfinished payloads or reuse a positive proof. */
export function recordFinishedCiProof(cls, completed, o = {}) {
  try {
    const c = context(o);
    if (!c.settings.enabled || !c.authScope || !finishedCiCacheable(cls) || c.settings.maxBytes === 0) return;
    const path = join(c.dir, filename(cls, c.authScope) + '.retry');
    if (completed) { remove(c.fs, path); return; }
    c.fs.mkdirSync(c.dir, { recursive: true, mode: 0o700 }); c.fs.chmodSync(c.dir, 0o700);
    c.fs.writeFileSync(path, '', { mode: 0o600 }); c.fs.chmodSync(path, 0o600);
    c.fs.utimesSync(path, new Date(c.nowMs), new Date(c.nowMs));
    evict(c);
  } catch { /* An unavailable retry hint only costs another proof. */ }
}
function context(o) {
  const env = o.env || process.env;
  return { settings: o.settings || resolveFinishedCiCacheSettings(env), dir: o.dir || finishedCiCacheDir(env),
    authScope: o.authScope === undefined ? finishedCiAuthScope(env) : o.authScope,
    fs: o.fs || nodeFs, nowMs: o.nowMs ?? Date.now() };
}
function filename(cls, authScope) {
  return `${cls.kind}-${cls.id}-${createHash('sha256').update(authScope + '\0' + cls.key).digest('hex').slice(0, 16)}.json.gz`;
}
/** Capture before the proof/payload reads. A rerun changes this even if an older reader stores later. */
export function finishedCiCacheGeneration(o = {}) {
  try {
    const { settings, dir, fs } = context(o);
    if (!settings.enabled) return null;
    try { return fs.readFileSync(join(dir, '.run-generation'), 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') return 'initial'; throw e; }
  } catch { return null; }
}
export function lookupFinishedCi(cls, o = {}) {
  try {
    const { settings, dir, fs, nowMs, authScope } = context(o);
    if (!settings.enabled || !authScope || !finishedCiCacheable(cls)) return null;
    fs.chmodSync(dir, 0o700);
    const path = join(dir, filename(cls, authScope));
    fs.chmodSync(path, 0o600);
    if (fs.statSync(path).size > Math.min(settings.maxBytes, MAX_ENCODED_BYTES)) { remove(fs, path); return null; }
    let entry;
    try { entry = JSON.parse(gunzipSync(fs.readFileSync(path), { maxOutputLength: MAX_ENCODED_BYTES }).toString('utf8')); }
    catch { remove(fs, path); return null; }
    // Old entries may contain logs captured before completion, or collections without closure proof.
    if (entry.version !== 3 || entry.authScope !== authScope || entry.key !== cls.key || !Number.isFinite(entry.storedAtMs) || typeof entry.stdout !== 'string') { remove(fs, path); return null; }
    const ttl = cls.kind === 'run-jobs' && settings.runJobsRevalidateMs > 0 ? Math.min(settings.runJobsRevalidateMs, MAX_AGE_MS) : MAX_AGE_MS;
    if (nowMs < entry.storedAtMs || nowMs - entry.storedAtMs >= ttl) { remove(fs, path); return null; }
    if (cls.kind === 'run-jobs' && (entry.runGeneration == null || entry.runGeneration !== finishedCiCacheGeneration(o))) { remove(fs, path); return null; }
    const bytes = Buffer.from(entry.stdout, 'base64');
    if (bytes.length > MAX_ENTRY_BYTES || bytes.toString('base64') !== entry.stdout) { remove(fs, path); return null; }
    fs.utimesSync(path, new Date(nowMs), new Date(nowMs));
    return bytes;
  } catch { return null; }
}
function remove(fs, path) {
  try { fs.unlinkSync(path); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
function evict({ settings, dir, fs, nowMs }, incomingBytes = 0, incomingFiles = 0) {
  const files = [];
  for (const name of fs.readdirSync(dir)) {
    if (!/^(?:(?:job-log|run-jobs|check-runs)-.*\.json\.gz(?:\.[^.]+\.tmp|\.retry)?|\.run-generation(?:\.[^.]+\.tmp)?)$/.test(name)) continue;
    const path = join(dir, name);
    let stat;
    try { stat = fs.statSync(path); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    if (!stat.isFile()) continue;
    const ttl = name.endsWith('.retry') ? PROOF_RETRY_MS : MAX_AGE_MS;
    if (name !== '.run-generation' && nowMs - stat.mtimeMs >= ttl) { remove(fs, path); continue; }
    files.push({ path, size: stat.size, mtime: stat.mtimeMs, generation: name.startsWith('.run-generation') });
  }
  let size = files.reduce((n, f) => n + f.size, 0);
  let count = files.length;
  if (size + incomingBytes <= settings.maxBytes && count + incomingFiles <= MAX_FILES) return;
  for (const f of files.sort((a, b) => a.mtime - b.mtime)) {
    if (f.generation) continue; // Preserve the fence and any invalidator currently publishing its replacement.
    remove(fs, f.path); size -= f.size; count--;
    if (size + incomingBytes <= settings.maxBytes * 0.8 && count + incomingFiles <= MAX_FILES * 0.8) break;
  }
  if (size + incomingBytes > settings.maxBytes) throw new Error('Cache budget exhausted');
}
export function storeFinishedCi(cls, stdoutBuffer, o = {}) {
  let tmp; let fs;
  try {
    const c = context(o); fs = c.fs;
    if (!c.settings.enabled || !c.authScope || !finishedCiCacheable(cls)) return;
    const length = Buffer.isBuffer(stdoutBuffer) ? stdoutBuffer.length : Buffer.byteLength(stdoutBuffer);
    if (length > Math.min(MAX_ENTRY_BYTES, c.settings.maxBytes) || c.settings.maxBytes === 0) return;
    const runGeneration = cls.kind === 'run-jobs'
      ? o.runGeneration === undefined ? finishedCiCacheGeneration(o) : o.runGeneration : null;
    if (cls.kind === 'run-jobs' && (runGeneration == null || runGeneration !== finishedCiCacheGeneration(o))) return;
    fs.mkdirSync(c.dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(c.dir, 0o700);
    const path = join(c.dir, filename(cls, c.authScope)); tmp = `${path}.${randomUUID()}.tmp`;
    const data = gzipSync(Buffer.from(JSON.stringify({ version: 3, authScope: c.authScope, runGeneration, key: cls.key, storedAtMs: c.nowMs, stdout: Buffer.from(stdoutBuffer).toString('base64') })));
    if (data.length > c.settings.maxBytes || data.length > MAX_ENCODED_BYTES) return;
    evict(c, data.length, 1);
    fs.writeFileSync(tmp, data, { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, path); fs.utimesSync(path, new Date(c.nowMs), new Date(c.nowMs));
    evict(c);
    return true;
  } catch { /* Miss/skip only. */ }
  finally { if (tmp) try { fs.unlinkSync(tmp); } catch { /* Renamed or absent. */ } }
}
export function invalidateForWrite(args, o = {}) {
  let tmp; let fs;
  try {
    const c = context(o); const { settings, dir } = c; fs = c.fs;
    if (!settings.enabled || !Array.isArray(args)) return;
    // Called only after success. Match conservatively in argv: gh supports global options,
    // clustered flags, implicit POST via fields/input, and interactive reruns without an id.
    // Every rerun invalidates the directory-wide generation, so no run-id parsing is needed.
    const rerun = (args.includes('run') && args.includes('rerun'))
      || (args.includes('api') && args.some(arg => /^(?:https?:\/\/[^/\s]+\/(?:api\/v3\/)?)?\/?repos\/[^/\s?]+\/[^/\s?]+\/actions\/(?:runs|jobs)\/\d+\/rerun[^\s?]*(?:\?[^\s]*)?$/.test(arg)));
    if (!rerun) return;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700);
    const generationPath = join(dir, '.run-generation'); tmp = `${generationPath}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, randomUUID(), { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, generationPath);
    // Job reruns do not carry their parent run id. Purge all collections, matching generation scope.
    for (const name of fs.readdirSync(dir)) {
      if ((name.startsWith('check-runs-') || name.startsWith('run-jobs-')) && name.endsWith('.json.gz')) {
        try { fs.unlinkSync(join(dir, name)); } catch { /* A concurrent invalidator may have removed it. */ }
      }
    }
    evict(c);
  } catch { /* Best effort. */ }
  finally { if (tmp) try { fs.unlinkSync(tmp); } catch { /* Renamed or absent. */ } }
}
