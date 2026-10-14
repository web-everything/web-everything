/** Host-local, append-only accounting. Observations may include concurrent Codex runs;
 * quota deltas are bucket percentage points, not exact per-run billing. */
import { appendFileSync, mkdirSync, readdirSync, statSync, lstatSync, realpathSync, openSync, readSync, closeSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { daemonConveyorStateRoot } from './daemon-last-good.mjs';
import { readGit } from './proc-read.mjs';
import { laneGitHardeningEnv, hardenLaneGitArgs, laneFilterDrivers, LANE_CONFIG_LIST_ARGS } from './lane-git-hardening.mjs';
import { ghRepoSlug, canonicalizeSlug } from './constellation-repos.mjs';

/** Persist an identity, never a remote's credentials, query string, or fragment. */
function usageRepoSlug(value) {
  if (typeof value !== 'string') return null;
  let path = value.trim();
  if (path.includes('://')) {
    try {
      const url = new URL(path);
      if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) return null;
      path = url.pathname.replace(/^\//, '');
    } catch { return null; }
  } else if (path.includes(':')) {
    const match = /^(?:[^/@:\s]+@)?[\w.-]+:([^\s]+)$/.exec(path);
    if (!match) return null;
    path = match[1];
  }
  path = path.replace(/\.git$/i, '');
  if (!path.includes('/')) {
    try { return ghRepoSlug(path); } catch { return null; }
  }
  return /^[A-Za-z0-9_-][A-Za-z0-9._-]*\/[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(path) ? canonicalizeSlug(path) : null;
}

export function codexUsageLedgerPath(env = process.env) {
  return env.WE_CODEX_USAGE_LEDGER || join(daemonConveyorStateRoot(env), 'codex-usage.jsonl');
}

/** Only the newest persisted rollout with a Codex bucket is used; never invoke Codex to probe quota. */
export function readCodexQuota(env = process.env) {
  try {
    const files = [];
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, e.name);
        if (e.isDirectory()) walk(path);
        else if (e.isFile() && e.name.endsWith('.jsonl')) files.push({ path, mtime: statSync(path).mtimeMs });
      }
    };
    walk(join(env.CODEX_HOME || join(homedir(), '.codex'), 'sessions'));
    files.sort((a, b) => b.mtime - a.mtime);
    for (const { path } of files.slice(0, 8)) {
      let fd;
      let text;
      try {
        fd = openSync(path, 'r');
        const size = statSync(path).size;
        const buf = Buffer.alloc(Math.min(size, 256 * 1024));
        const bytes = readSync(fd, buf, 0, buf.length, size - buf.length);
        text = buf.subarray(0, bytes).toString('utf8');
      } finally { if (fd !== undefined) closeSync(fd); }
      for (const line of text.split('\n').reverse()) {
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        const limits = e?.type === 'event_msg' && e.payload?.type === 'token_count' ? e.payload.rate_limits : null;
        if (limits?.limit_id === 'codex' && Number.isFinite(limits.primary?.used_percent)) {
          return { used_percent: limits.primary.used_percent, resets_at: limits.primary.resets_at ?? null };
        }
      }
    }
  } catch { /* absent/unreadable quota is unknown */ }
  return null;
}

export function codexRunTokens(stdout = '') {
  const totals = { input: null, cached: null, output: null, reasoning: null };
  for (const line of String(stdout).split('\n')) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!['turn.completed', 'turn.failed'].includes(e?.type) || !e.usage) continue;
    for (const [key, field] of Object.entries({ input: 'input_tokens', cached: 'cached_input_tokens', output: 'output_tokens', reasoning: 'reasoning_output_tokens' })) {
      const value = e.usage[field] ?? (key === 'reasoning' ? e.usage.output_tokens_details?.reasoning_tokens : undefined);
      if (Number.isFinite(value)) totals[key] = (totals[key] ?? 0) + value;
    }
  }
  return totals;
}

export function appendCodexUsage(record, { env = process.env, append = appendFileSync, mkdir = mkdirSync } = {}) {
  try {
    const path = codexUsageLedgerPath(env);
    const before = record.quotaBefore?.used_percent ?? null;
    const after = record.quotaAfter?.used_percent ?? null;
    const sameWindow = record.quotaBefore?.resets_at === record.quotaAfter?.resets_at;
    const row = {
      at: record.at ?? new Date().toISOString(), model: record.model ?? null, effort: record.effort ?? null,
      taskKind: record.taskKind ?? 'unknown', caller: record.caller ?? 'unknown', repo: usageRepoSlug(record.repo),
      ...(record.pr != null ? { pr: record.pr } : {}), ...(record.card ? { card: record.card } : {}),
      tokens: record.tokens ?? codexRunTokens(record.stdout),
      quota: { before_used_percent: before, after_used_percent: after,
        delta: Number.isFinite(before) && Number.isFinite(after) && sameWindow && after >= before ? after - before : null },
      durationMs: record.durationMs ?? null,
      outcome: { changedFiles: record.changedFiles ?? null, exit: record.exit ?? null, timedOut: Boolean(record.timedOut) },
    };
    mkdir(dirname(path), { recursive: true });
    append(path, `${JSON.stringify(row)}\n`, { encoding: 'utf8', mode: 0o600 });
    return row;
  } catch { return null; }
}

const SNAPSHOT_OUTPUT_BYTES = 8 * 1024 * 1024;
const SNAPSHOT_MAX_FILES = 4096;
const SNAPSHOT_MAX_TRACKED = 65536;

/** Metadata only: no content reads or executable Git conversions across a mutable worktree. */
function hashFileMetadata(hash, root, path) {
  const parts = path.split('/');
  if (isAbsolute(path) || parts.some(p => !p || p === '.' || p === '..')) throw Error('unsafe untracked path');
  hash.update(JSON.stringify(path));
  let file = root;
  for (const part of parts.slice(0, -1)) {
    file = join(file, part);
    let parent;
    try { parent = lstatSync(file); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      hash.update('missing');
      return;
    }
    if (!parent.isDirectory()) throw Error('snapshot parent is not a directory');
  }
  file = join(file, parts.at(-1));
  let stat;
  try {
    stat = lstatSync(file, { bigint: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    hash.update('missing');
    return;
  }
  if (!stat.isFile() && !stat.isSymbolicLink()) throw Error('unsupported snapshot file');
  hash.update(JSON.stringify([stat.mode, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String)));
}

function repositorySnapshot(cwd) {
  try {
    const root = realpathSync(cwd);
    const deadline = Date.now() + 5000;
    // Do not inherit Git directory/config overrides from the launching process.
    const env = laneGitHardeningEnv(Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))));
    Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' });
    const checkTime = () => { if (Date.now() >= deadline) throw Error('snapshot timeout'); };
    const git = (args) => {
      checkTime();
      return readGit(['-C', root, `--work-tree=${root}`, ...hardenLaneGitArgs(args)], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: Math.max(1, deadline - Date.now()), maxBuffer: SNAPSHOT_OUTPUT_BYTES });
    };
    // Refuse configured filters, but never rely on this check to secure a later diff:
    // ls-files/rev-parse/config do not execute clean/smudge/textconv drivers even if config changes.
    if (laneFilterDrivers(git(LANE_CONFIG_LIST_ARGS)).length) return null;
    // HEAD captures commits, stage entries capture index edits, and nanosecond metadata captures
    // worktree changes. Touches can count as changes; accounting never reads file contents.
    const tracked = git(['ls-files', '--stage', '--sparse', '-z']);
    const hash = createHash('sha256').update(JSON.stringify([git(['rev-parse', 'HEAD']), tracked]));
    const trackedPaths = tracked.split('\0').filter(Boolean).map(entry => {
      const tab = entry.indexOf('\t');
      if (tab < 0) throw Error('invalid index entry');
      return entry.slice(tab + 1);
    });
    if (trackedPaths.length > SNAPSHOT_MAX_TRACKED) return null;
    const paths = git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
    if (paths.length > SNAPSHOT_MAX_FILES) return null;
    for (const path of [...new Set(trackedPaths), ...paths]) {
      checkTime();
      hashFileMetadata(hash, root, path);
    }
    let repo = null;
    try { repo = usageRepoSlug(git(['config', '--get', 'remote.origin.url'])); } catch { /* no remote */ }
    return { hash: hash.digest('hex'), repo };
  } catch { return null; }
}

/** Wrap exactly one launch. Accounting cannot change its return value or error. */
export async function withCodexUsage(metadata, launch, { env = process.env, quota = readCodexQuota, snapshot = repositorySnapshot, now = Date.now, append = appendCodexUsage } = {}) {
  const safe = (fn, ...args) => { try { return fn(...args); } catch { return null; } };
  const before = safe(quota, env);
  const filesBefore = metadata.cwd ? safe(snapshot, metadata.cwd) : null;
  const start = safe(now);
  let result;
  let error;
  try { result = await launch(); return result; }
  catch (e) { error = e; throw e; }
  finally {
    const end = safe(now);
    const filesAfter = metadata.cwd ? safe(snapshot, metadata.cwd) : null;
    safe(append, { ...metadata, repo: usageRepoSlug(metadata.repo ?? filesBefore?.repo), stdout: result?.stdout ?? error?.stdout,
      quotaBefore: before, quotaAfter: safe(quota, env), durationMs: Number.isFinite(start) && Number.isFinite(end) ? end - start : null,
      changedFiles: metadata.changedFiles ?? (filesBefore && filesAfter ? filesBefore.hash !== filesAfter.hash : null),
      exit: error ? (Number.isInteger(error.status) ? error.status : Number.isInteger(error.code) ? error.code : null) : Number.isInteger(result?.code) ? result.code : null,
      timedOut: result?.timedOut ?? error?.timedOut,
    }, { env });
  }
}
