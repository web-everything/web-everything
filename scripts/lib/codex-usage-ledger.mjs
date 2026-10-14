/** Host-local, append-only accounting. Observations may include concurrent Codex runs;
 * quota deltas are bucket percentage points, not exact per-run billing. */
import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { daemonConveyorStateRoot } from './daemon-last-good.mjs';

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
      taskKind: record.taskKind ?? 'unknown', caller: record.caller ?? 'unknown', repo: record.repo ?? null,
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

function repositorySnapshot(cwd) {
  try {
    const git = (args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    // Include untracked contents as well as tracked edits and commits, without modifying the index.
    const hash = createHash('sha256').update(git(['rev-parse', 'HEAD'])).update(git(['diff', 'HEAD', '--binary']));
    for (const path of git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)) hash.update(path).update(readFileSync(join(cwd, path)));
    let repo = null;
    try { repo = git(['config', '--get', 'remote.origin.url']).trim(); } catch { /* no remote */ }
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
    safe(append, { ...metadata, repo: metadata.repo ?? filesBefore?.repo, stdout: result?.stdout ?? error?.stdout,
      quotaBefore: before, quotaAfter: safe(quota, env), durationMs: Number.isFinite(start) && Number.isFinite(end) ? end - start : null,
      changedFiles: metadata.changedFiles ?? (filesBefore && filesAfter ? filesBefore.hash !== filesAfter.hash : null),
      exit: error ? (typeof error.status === 'number' ? error.status : typeof error.code === 'number' ? error.code : 1) : result?.code ?? 0,
      timedOut: result?.timedOut ?? error?.timedOut,
    }, { env });
  }
}
