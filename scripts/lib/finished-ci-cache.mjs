/**
 * Card 309 — host-shared finished CI reads. Job ids are per attempt: once completed, their logs are final
 * and cached forever. Run job lists and SHA check-runs can change on rerun, so they revalidate (run jobs 10 min, check-runs 5 min: red-main recovery reads check-runs).
 * Policy finishedCiCache: enabled=true, maxBytes=2 GiB, runJobsRevalidateMs=600000, checkRunsRevalidateMs=300000
 * (0 means never). Env overrides: WE_FINISHED_CI_CACHE=0 is the off switch; WE_FINISHED_CI_CACHE_MAX_BYTES,
 * WE_FINISHED_CI_CACHE_RUN_JOBS_REVALIDATE_MS, WE_FINISHED_CI_CACHE_CHECK_RUNS_REVALIDATE_MS.
 * WE_FINISHED_CI_CACHE_DIR overrides ~/.claude/conveyor/finished-ci-cache (leading ~ expands).
 * All cache IO is best effort and injectable via options.fs; no cache failure reaches a gh caller.
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
export function finishedCiStorable(cls, stdoutText) {
  try {
    if (!cls || cls.kind === 'job-log') return false;
    const data = JSON.parse(String(stdoutText));
    const projected = JSON.parse(cls.key).length > 2;
    const rows = projected ? data : data?.[cls.kind === 'run-jobs' ? 'jobs' : 'check_runs'];
    return Array.isArray(rows) && rows.length > 0 && rows.every(row => row?.status === 'completed');
  } catch { return false; }
}
function context(o) {
  const env = o.env || process.env;
  return { settings: o.settings || resolveFinishedCiCacheSettings(env), dir: o.dir || finishedCiCacheDir(env),
    fs: o.fs || nodeFs, nowMs: o.nowMs ?? Date.now() };
}
function filename(cls) {
  return `${cls.kind}-${cls.id}-${createHash('sha256').update(cls.key).digest('hex').slice(0, 16)}.json.gz`;
}
export function lookupFinishedCi(cls, o = {}) {
  try {
    const { settings, dir, fs, nowMs } = context(o);
    if (!settings.enabled || !cls) return null;
    const path = join(dir, filename(cls));
    const entry = JSON.parse(gunzipSync(fs.readFileSync(path)).toString('utf8'));
    if (entry.key !== cls.key || !Number.isFinite(entry.storedAtMs) || typeof entry.stdout !== 'string') return null;
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
  fs.writeFileSync(marker, ''); fs.utimesSync(marker, new Date(nowMs), new Date(nowMs));
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
    if (!c.settings.enabled || !cls) return;
    fs.mkdirSync(c.dir, { recursive: true });
    const path = join(c.dir, filename(cls)); tmp = `${path}.${randomUUID()}.tmp`;
    const data = gzipSync(Buffer.from(JSON.stringify({ key: cls.key, storedAtMs: c.nowMs, stdout: Buffer.from(stdoutBuffer).toString('base64') })));
    fs.writeFileSync(tmp, data); fs.renameSync(tmp, path); fs.utimesSync(path, new Date(c.nowMs), new Date(c.nowMs));
    evict(c);
  } catch { /* Miss/skip only. */ }
  finally { if (tmp) try { fs.unlinkSync(tmp); } catch { /* Renamed or absent. */ } }
}
export function invalidateForWrite(args, o = {}) {
  try {
    const { settings, dir, fs } = context(o);
    if (!settings.enabled || !Array.isArray(args)) return;
    let id;
    if (args[0] === 'run' && args[1] === 'rerun' && /^\d+$/.test(args[2])) id = args[2];
    if (args[0] === 'api') {
      const post = args.some((a, i) => ((a === '--method' || a === '-X') && args[i + 1] === 'POST') || a === '--method=POST' || a === '-XPOST');
      if (post) id = /^\/?repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/(\d+)\/rerun[^\s?]*(?:\?[^\s]*)?$/.exec(args[1])?.[1];
    }
    if (!id) return; // Job ids are immutable; a job rerun has nothing to invalidate.
    for (const name of fs.readdirSync(dir)) if (name.startsWith(`run-jobs-${id}-`) && name.endsWith('.json.gz')) fs.unlinkSync(join(dir, name));
  } catch { /* Best effort. */ }
}
