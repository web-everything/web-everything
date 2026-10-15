/**
 * Card 309 — host-shared finished CI reads. Job ids are per attempt: once completed, their logs are final
 * and cached forever, with completion proved BEFORE fetching the log. Full run job lists require a completed
 * parent run and revalidate after 10 min. Check-runs and jq projections stay live: they cannot prove closure
 * and completeness (later workflows can add checks to even an old commit).
 * Policy finishedCiCache: enabled=true, maxBytes=2 GiB, runJobsRevalidateMs=600000, checkRunsRevalidateMs=300000
 * (0 means never). Env overrides: WE_FINISHED_CI_CACHE=0 is the off switch; WE_FINISHED_CI_CACHE_MAX_BYTES,
 * WE_FINISHED_CI_CACHE_RUN_JOBS_REVALIDATE_MS, WE_FINISHED_CI_CACHE_CHECK_RUNS_REVALIDATE_MS.
 * WE_FINISHED_CI_CACHE_DIR overrides ~/.claude/conveyor/finished-ci-cache (leading ~ expands).
 * All cache IO is best effort and injectable via options.fs; no cache failure reaches a gh caller.
 * Entries are scoped to a hash of the host and explicit credentials; stored-login and dynamically routed auth stay live.
 */
import * as nodeFs from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { cascadePolicy } from './policy-cascade.mjs';
import { isUnderTest } from './under-test.mjs';

const STANDARD = Object.freeze({ enabled: true, maxBytes: 2 * 1024 ** 3, runJobsRevalidateMs: 600000, checkRunsRevalidateMs: 300000 });
const EVICT_MS = 600000;
const lastEvictions = new Map();
export function resolveFinishedCiCacheSettings(env = process.env) {
  const int = k => { const v = env[k]; const n = Number(v); return v != null && v !== '' && Number.isSafeInteger(n) && n >= 0 ? n : undefined; };
  let settings = { ...STANDARD, source: {} };
  try {
    const r = cascadePolicy('finishedCiCache', undefined, { env, standard: STANDARD,
      envValues: { enabled: env.WE_FINISHED_CI_CACHE === '0' ? false : env.WE_FINISHED_CI_CACHE === '1' ? true : undefined,
        maxBytes: int('WE_FINISHED_CI_CACHE_MAX_BYTES'), runJobsRevalidateMs: int('WE_FINISHED_CI_CACHE_RUN_JOBS_REVALIDATE_MS'),
        checkRunsRevalidateMs: int('WE_FINISHED_CI_CACHE_CHECK_RUNS_REVALIDATE_MS') },
      valid: { enabled: v => typeof v === 'boolean', maxBytes: n => Number.isSafeInteger(n) && n >= 0,
        runJobsRevalidateMs: n => Number.isSafeInteger(n) && n >= 0, checkRunsRevalidateMs: n => Number.isSafeInteger(n) && n >= 0 } });
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
/** A collection needs a closed parent, and every immutability proof must precede its payload. */
export function finishedCiProofArgs(cls) {
  if (cls?.kind === 'job-log') return ['api', `repos/${cls.repo}/actions/jobs/${cls.id}`];
  if (cls?.kind === 'run-jobs' && JSON.parse(cls.key).length === 2)
    return ['api', `repos/${cls.repo}/actions/runs/${cls.id}`];
  return null;
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
    if (!settings.enabled || !authScope || !cls || cls.kind === 'check-runs') return null;
    fs.chmodSync(dir, 0o700);
    const path = join(dir, filename(cls, authScope));
    fs.chmodSync(path, 0o600);
    const entry = JSON.parse(gunzipSync(fs.readFileSync(path)).toString('utf8'));
    // Old entries may contain logs captured before completion, or collections without closure proof.
    if (entry.version !== 3 || entry.authScope !== authScope || entry.key !== cls.key || !Number.isFinite(entry.storedAtMs) || typeof entry.stdout !== 'string') return null;
    if (cls.kind === 'run-jobs' && (entry.runGeneration == null || entry.runGeneration !== finishedCiCacheGeneration(o))) return null;
    const ttl = cls.kind === 'run-jobs' ? settings.runJobsRevalidateMs : cls.kind === 'check-runs' ? settings.checkRunsRevalidateMs : 0;
    if (ttl > 0 && nowMs - entry.storedAtMs >= ttl) return null;
    const bytes = Buffer.from(entry.stdout, 'base64');
    if (bytes.toString('base64') !== entry.stdout) return null;
    fs.utimesSync(path, new Date(nowMs), new Date(nowMs));
    return bytes;
  } catch { return null; }
}
function evict({ settings, dir, fs, nowMs }) {
  if (lastEvictions.has(dir) && nowMs - lastEvictions.get(dir) < EVICT_MS) return;
  const marker = join(dir, '.last-evict');
  try { if (nowMs - fs.statSync(marker).mtimeMs < EVICT_MS) return; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  fs.writeFileSync(marker, '', { mode: 0o600 }); fs.chmodSync(marker, 0o600);
  fs.utimesSync(marker, new Date(nowMs), new Date(nowMs));
  lastEvictions.set(dir, nowMs);
  const files = fs.readdirSync(dir).filter(n => /^(job-log|run-jobs|check-runs)-.*\.json\.gz$/.test(n)).map(name => {
    const path = join(dir, name); const stat = fs.statSync(path); return { path, size: stat.size, mtime: stat.mtimeMs };
  });
  let size = files.reduce((n, f) => n + f.size, 0);
  if (size <= settings.maxBytes) return;
  for (const f of files.sort((a, b) => a.mtime - b.mtime)) {
    fs.unlinkSync(f.path); size -= f.size;
    if (size <= settings.maxBytes * 0.8) break;
  }
}
export function storeFinishedCi(cls, stdoutBuffer, o = {}) {
  let tmp; let fs;
  try {
    const c = context(o); fs = c.fs;
    if (!c.settings.enabled || !c.authScope || !cls) return;
    const runGeneration = cls.kind === 'run-jobs'
      ? o.runGeneration === undefined ? finishedCiCacheGeneration(o) : o.runGeneration : null;
    if (cls.kind === 'run-jobs' && (runGeneration == null || runGeneration !== finishedCiCacheGeneration(o))) return;
    fs.mkdirSync(c.dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(c.dir, 0o700);
    const path = join(c.dir, filename(cls, c.authScope)); tmp = `${path}.${randomUUID()}.tmp`;
    const data = gzipSync(Buffer.from(JSON.stringify({ version: 3, authScope: c.authScope, runGeneration, key: cls.key, storedAtMs: c.nowMs, stdout: Buffer.from(stdoutBuffer).toString('base64') })));
    fs.writeFileSync(tmp, data, { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, path); fs.utimesSync(path, new Date(c.nowMs), new Date(c.nowMs));
    evict(c);
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
  } catch { /* Best effort. */ }
  finally { if (tmp) try { fs.unlinkSync(tmp); } catch { /* Renamed or absent. */ } }
}
