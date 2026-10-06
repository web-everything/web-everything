/**
 * Await records for we:backlog/5137-harness-owns-the-verify-wait-not-the-model.md: fixers currently wait nine minutes for a verify gate whose
 * median is 13.6 minutes (p90 25), burning model turns on repeated timeouts. The target flow
 * requests verification, records the wait, and ends the turn; the harness resumes the SAME session.
 * This slice only supplies the record and liveness exemptions; no fixer writes it automatically yet.
 */
import { statSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';

/** Lane-local await record filename. */
export const AWAIT_VERIFY_FILE = '.fix-await-verify';
/** Equals DEFAULT_ADMISSION_CEILING_MS (120 min, we:scripts/readiness/heavy-admission.mjs) + 30 min.
 * Defined locally to keep reaper and claim-sweep imports light. */
export const DEFAULT_AWAIT_VERIFY_TTL_MS = 150 * 60 * 1000;
/** Tolerated clock skew for a request timestamp. */
export const AWAIT_VERIFY_FUTURE_SKEW_MS = 5 * 60 * 1000;

/** Resolve the env override, with a one-minute floor and fallback for invalid values. */
export function resolveAwaitVerifyTtlMs(env = process.env) {
  const raw = env?.WE_AWAIT_VERIFY_TTL_MINUTES;
  const n = Number(raw);
  if (raw === undefined || raw === '' || !Number.isFinite(n) || n <= 0) return DEFAULT_AWAIT_VERIFY_TTL_MS;
  return Math.max(1, n) * 60 * 1000;
}

/** Resolve a directory or worktree gitdir without spawning git; unreadable means unknown. */
export function resolveAwaitVerifyPath(cwd, { statFn = statSync, readFileSyncFn = readFileSync } = {}) {
  try {
    if (typeof cwd !== 'string' || !cwd) return null;
    const git = resolve(cwd, '.git');
    const stat = statFn(git);
    if (stat.isDirectory()) return resolve(git, AWAIT_VERIFY_FILE);
    if (!stat.isFile()) return null;
    const match = /^gitdir:\s*([^\r\n]+)\s*$/.exec(readFileSyncFn(git, 'utf8'));
    return match?.[1]?.trim() ? resolve(cwd, match[1].trim(), AWAIT_VERIFY_FILE) : null;
  } catch { return null; }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;
const validRecord = (record) => isObject(record) && record.v === 1
  && typeof record.requestedAt === 'string' && Number.isFinite(Date.parse(record.requestedAt))
  && Number.isInteger(record.pr) && record.pr > 0;

/** Read JSON objects only; missing, unreadable and malformed files are unknown. */
export function readAwaitVerifyRecord(cwd, io = {}) {
  try {
    const path = resolveAwaitVerifyPath(cwd, io);
    if (!path) return null;
    const record = JSON.parse((io.readFileSyncFn ?? readFileSync)(path, 'utf8'));
    return isObject(record) ? record : null;
  } catch { return null; }
}

/** Pure session binding and bounded liveness verdict for one await record. */
export function classifyAwaitVerify({ record, session, nowMs, ttlMs, pr = null }) {
  const verdict = (reason, ageMs = null) => ({ awaiting: reason === 'awaiting-verify', reason, ageMs });
  if (!Number.isFinite(nowMs) || !Number.isFinite(ttlMs) || ttlMs <= 0) return verdict('no-signal');
  if (record == null) return verdict('no-record');
  if (!validRecord(record)) return verdict('malformed');
  // A record only ever speaks for the session that wrote it: the session id when both sides carry one, else
  // the session name (`who`). A record WITH an id never binds an id-less row on the id alone.
  if (nonEmpty(record.sessionId) && nonEmpty(session?.sessionId)) {
    if (record.sessionId !== session.sessionId) return verdict('foreign-session');
  } else {
    if (!nonEmpty(record.who) || !nonEmpty(session?.name)) return verdict('unbound');
    if (record.who !== session.name) return verdict('foreign-session');
  }
  if (pr !== null && record.pr !== pr) return verdict('other-pr');
  const ageMs = nowMs - Date.parse(record.requestedAt);
  if (ageMs < -AWAIT_VERIFY_FUTURE_SKEW_MS) return verdict('future-skew', ageMs);
  if (ageMs > ttlMs) return verdict('expired', ageMs);
  return verdict('awaiting-verify', ageMs);
}

/** Build an injectable reader/clock resolver; failures never claim liveness. */
export function makeAwaitingVerifyResolver({ ttlMs = resolveAwaitVerifyTtlMs(), now = Date.now, read = readAwaitVerifyRecordForSession } = {}) {
  return (session, options = {}) => {
    try {
      if (typeof session?.cwd !== 'string') return null;
      return classifyAwaitVerify({ record: read(session.cwd, session), session, nowMs: now(), ttlMs, pr: options?.pr });
    } catch { return null; }
  };
}

/** Validate before IO and atomically publish through a temporary file in the same git directory. */
export function writeAwaitVerifyRecord({ cwd, record, writeFileSyncFn = writeFileSync, renameSyncFn = renameSync,
  statFn = statSync, readFileSyncFn = readFileSync, unlinkSyncFn = unlinkSync, uniqueId = randomUUID }) {
  if (!validRecord(record) || (!nonEmpty(record.sessionId) && !nonEmpty(record.who))) return { ok: false, reason: 'malformed' };
  const path = resolveAwaitVerifyPath(cwd, { statFn, readFileSyncFn });
  if (!path) return { ok: false, reason: 'no-git-dir' };
  let tmp;
  try {
    tmp = `${path}.${uniqueId()}.tmp`;
    writeFileSyncFn(tmp, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'wx' });
    renameSyncFn(tmp, path);
    return { ok: true, path };
  } catch {
    if (tmp) { try { unlinkSyncFn(tmp); } catch { /* best-effort temporary cleanup */ } }
    return { ok: false, reason: 'write-failed' };
  }
}

/** Remove the record, with missing or unreadable paths reported as not cleared. */
export function clearAwaitVerifyRecord(cwd, { unlinkSyncFn = unlinkSync, ...io } = {}) {
  try {
    const path = resolveAwaitVerifyPath(cwd, io);
    if (!path) return { cleared: false };
    unlinkSyncFn(path);
    return { cleared: true };
  } catch { return { cleared: false }; }
}

// ── Slice 2/3: the shared store the fix daemon's verdict pass reads ──────────────────────────────────────────
// A dispatched fixer's session cwd is a per-dispatch scratch directory (dispatch-lane-io.mjs#dispatchSessionCwd),
// never its lane, so a lane-local record is invisible to anything that starts from a `claude agents` row. Every
// mark therefore also lands in one host-wide store keyed by the session id (or `who` when there is none); the
// row's own `sessionId`/`name` finds it without knowing the lane.

/** Env override for the store directory (tests, other hosts). */
export const AWAIT_VERIFY_STORE_ENV = 'WE_AWAIT_VERIFY_STORE';
/** Where await records live: `<coordination root>/await-verify` unless overridden. */
export function awaitVerifyStoreDir(env = process.env) {
  const override = String(env?.[AWAIT_VERIFY_STORE_ENV] ?? '').trim();
  return override ? resolve(override) : join(resolveCoordinationRoot({ env }), 'await-verify');
}
const STORE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** The store filename for a record or session: session id first, else `who`/name. Null when neither is safe. */
export function awaitVerifyStoreKey({ sessionId = null, who = null } = {}) {
  for (const key of [sessionId, who]) if (nonEmpty(key) && STORE_KEY_RE.test(key)) return key;
  return null;
}
/** Read one store record by key; missing or malformed is null. */
export function readStoredAwaitVerify(key, { dir = awaitVerifyStoreDir(), readFileSyncFn = readFileSync } = {}) {
  try {
    if (!nonEmpty(key) || !STORE_KEY_RE.test(key)) return null;
    const record = JSON.parse(readFileSyncFn(join(dir, `${key}.json`), 'utf8'));
    return isObject(record) ? record : null;
  } catch { return null; }
}
/** A session row's record: lane-local at its cwd (slice 1 shape), else the store by session id, then name. */
export function readAwaitVerifyRecordForSession(cwd, session, { dir = awaitVerifyStoreDir(), ...io } = {}) {
  return readAwaitVerifyRecord(cwd, io)
    ?? readStoredAwaitVerify(session?.sessionId, { dir, ...io })
    ?? readStoredAwaitVerify(session?.name, { dir, ...io });
}
/** Every parseable store record with its key; unreadable entries are skipped. */
export function listStoredAwaitVerify({ dir = awaitVerifyStoreDir(), readdirSyncFn = readdirSync, readFileSyncFn = readFileSync } = {}) {
  let names = [];
  try { names = readdirSyncFn(dir); } catch { return []; }
  return names.filter((n) => n.endsWith('.json')).sort().map((n) => n.slice(0, -5))
    .map((key) => ({ key, record: readStoredAwaitVerify(key, { dir, readFileSyncFn }) }))
    .filter((e) => e.record);
}
/** Atomically write (or replace) one store record. */
export function writeStoredAwaitVerify(record, { dir = awaitVerifyStoreDir(), writeFileSyncFn = writeFileSync,
  renameSyncFn = renameSync, unlinkSyncFn = unlinkSync, mkdirSyncFn = mkdirSync, uniqueId = randomUUID } = {}) {
  if (!validRecord(record)) return { ok: false, reason: 'malformed' };
  const key = awaitVerifyStoreKey(record);
  if (!key) return { ok: false, reason: 'malformed' };
  const path = join(dir, `${key}.json`);
  let tmp;
  try {
    mkdirSyncFn(dir, { recursive: true });
    tmp = `${path}.${uniqueId()}.tmp`;
    writeFileSyncFn(tmp, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'wx' });
    renameSyncFn(tmp, path);
    return { ok: true, path, key };
  } catch {
    if (tmp) { try { unlinkSyncFn(tmp); } catch { /* best-effort temporary cleanup */ } }
    return { ok: false, reason: 'write-failed' };
  }
}
/** Remove one store record by key. */
export function clearStoredAwaitVerify(key, { dir = awaitVerifyStoreDir(), unlinkSyncFn = unlinkSync } = {}) {
  try {
    if (!nonEmpty(key) || !STORE_KEY_RE.test(key)) return { cleared: false };
    unlinkSyncFn(join(dir, `${key}.json`));
    return { cleared: true };
  } catch { return { cleared: false }; }
}

/** Lane refs a record may name for the daemon's push: `lane/*` only, never `main` or a flag-shaped string. */
export const AWAIT_VERIFY_REF_RE = /^lane\/[A-Za-z0-9._/-]+$/;
/** Session kinds whose briefs know how to be resumed by the verdict pass. */
export const AWAIT_VERIFY_KINDS = Object.freeze(['fix', 'ci-heal']);

/**
 * Thin CLI shell; filesystem, subprocess, environment, clock and output ports are injectable.
 * `mark` refuses a dirty working tree: the harness pushes the committed sha, so the verified tree must BE that
 * commit (we:scripts/conveyor/await-verify-pass.mjs re-checks this before any push). It writes the lane-local
 * record (slice 1) and the shared store record the fix daemon's verdict pass reads.
 */
export function main(argv = process.argv.slice(2), {
  env = process.env, exec = execFileSync, now = Date.now, write = writeAwaitVerifyRecord,
  read = readAwaitVerifyRecord, clear = clearAwaitVerifyRecord, out = console.log, err = console.error,
  writeStore = writeStoredAwaitVerify, readStore = readStoredAwaitVerify, clearStore = clearStoredAwaitVerify,
} = {}) {
  const [command, ...args] = argv;
  const flags = Object.fromEntries(args.filter((arg) => arg.startsWith('--')).map((arg) => {
    const eq = arg.indexOf('=');
    return eq < 0 ? [arg.slice(2), true] : [arg.slice(2, eq), arg.slice(eq + 1)];
  }));
  const cwd = flags.cwd ?? '.';
  const git = (gitArgs) => String(exec('git', ['-C', cwd, ...gitArgs], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const storeKey = () => awaitVerifyStoreKey({ sessionId: flags['session-id'] ?? env.CLAUDE_CODE_SESSION_ID ?? null, who: flags.who ?? null });
  try {
    if (command === 'show') { out(JSON.stringify(read(cwd) ?? readStore(storeKey()))); return 0; }
    if (command === 'clear') {
      const lane = clear(cwd);
      const store = clearStore(storeKey());
      out(JSON.stringify({ cleared: lane.cleared || store.cleared }));
      return 0;
    }
    if (command !== 'mark') { err('expected mark, show or clear'); return 2; }
    const record = {
      v: 1, sessionId: flags['session-id'] ?? env.CLAUDE_CODE_SESSION_ID ?? null,
      who: flags.who, repo: flags.repo, pr: Number(flags.pr),
      sha: flags.sha ?? git(['rev-parse', 'HEAD']).trim(),
      requestedAt: new Date(now()).toISOString(), attempt: Number(flags.attempt ?? 1),
    };
    if (!nonEmpty(record.who) || !/^[^/\s]+\/[^/\s]+$/.test(record.repo ?? '')
      || !/^[a-f\d]{40}$/i.test(record.sha) || !Number.isInteger(record.attempt) || record.attempt < 1) {
      err('malformed'); return 2;
    }
    // The harness-owned fields (slice 2/3). Optional so a slice-1 style mark (no --ref) still records the wait;
    // the verdict pass refuses to push for a record without a valid ref and resumes the session instead.
    if (flags.ref !== undefined) {
      if (!AWAIT_VERIFY_REF_RE.test(String(flags.ref)) || String(flags.ref).includes('..')) { err('malformed --ref (must be lane/*)'); return 2; }
      const kind = flags.kind ?? 'fix';
      if (!AWAIT_VERIFY_KINDS.includes(kind)) { err(`malformed --kind (one of ${AWAIT_VERIFY_KINDS.join(', ')})`); return 2; }
      if (git(['status', '--porcelain', '--untracked-files=all']).trim()) {
        err('dirty working tree: commit the repair first — the harness pushes the committed sha, so the verified tree must be exactly that commit');
        return 2;
      }
      const head = git(['rev-parse', 'HEAD']).trim();
      if (head.toLowerCase() !== record.sha.toLowerCase()) { err(`--sha ${record.sha} is not HEAD (${head})`); return 2; }
      Object.assign(record, { lane: resolve(git(['rev-parse', '--show-toplevel']).trim()), ref: String(flags.ref), kind });
    }
    const result = write({ cwd, record });
    if (!result.ok) { err(result.reason); return 2; }
    if (record.lane) {
      const stored = writeStore(record);
      if (!stored.ok) { clear(cwd); err(`store ${stored.reason}`); return 2; }
    }
    out(JSON.stringify(record));
    return 0;
  } catch (error) { err(String(error?.message ?? error)); return 2; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { writeLineSync } = await import('../lib/write-all-sync.mjs');
  process.exitCode = main(undefined, { out: (line) => writeLineSync(1, line), err: (line) => writeLineSync(2, line) });
}
