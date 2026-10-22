/**
 * @file scripts/lib/verdict-ledger-io.mjs
 * @description THE GIT IO-SHELL OF THE VERDICT LEDGER (ledger plan slice C1 = #3255 part 1; plan section 3.2).
 *   Fetch, idempotent append, bounded retry, on the `ops/review-requests` git transport.
 *   Sync primitives serve existing writers; the registered store exposes the async contract.
 *
 * THREE PROMISES, each pinned by a test:
 *   1. A READ THAT FAILS IS `unreadable`, NEVER "empty". `readVerdictLedger` (the home-dir reader) turns any read
 *      error into an empty ledger; on a shared store that would read as "no verdict, no hold" and let a PR
 *      through. Here an unreachable remote or absent branch yields `{status: 'unreadable'}` and every gate must
 *      treat that as a hold. Only a tip we really read that has no ledger file is `{status: 'ok', records: []}`.
 *   2. AN APPEND IS COMPUTED AGAINST THE TIP IT RACES. Each attempt re-fetches, appends to the fetched file, and
 *      pushes (never forced). A rejected push means another writer got there first, so the whole attempt is
 *      redone on the new tip; no row is ever lost to a last-writer-wins overwrite.
 *   3. EXHAUSTION IS LOUD. After the bounded retries, `appendLedgerRows` THROWS `LedgerAppendExhaustedError`
 *      carrying every attempt's error. It never returns a quiet failure value a caller could ignore.
 *
 * Reads through `we:scripts/lib/git-transport-branch.mjs`. WRITES no longer use its worktree stager (live 2026-10-21:
 * a full-branch checkout per append made same-host writers lose 9-second push races); every ledger push is the
 * plumbing commit in `we:scripts/lib/verdict-ledger-outbox.mjs`, via the outbox or, in CI/unit seams, directly.
 *
 * THE READ BUFFER IS SIZED TO THE BLOB (live 2026-10-10: the web-everything ledger passed 1 MiB, every `git show` hit
 * the default `maxBuffer` with `spawnSync git ENOBUFS`, and the drain's ledger shadow read 491 of 493 PRs as
 * unreadable). The default read now resolves the ledger file to its blob id, asks git for the blob's exact size,
 * and reads that immutable blob with a buffer of size + headroom. A blob larger than the read cap is refused before
 * it is read and reported `unreadable` (`ledger-exceeds-read-cap`), naming the cap and the layer that set it.
 * The cap is a setting (cascade: standard default -> repo settings `verdictLedger.readMaxBytes` -> env
 * `WE_VERDICT_LEDGER_READ_MAX_BYTES`); the effective value and its source are logged once per process.
 */
import { execFileSync } from 'node:child_process';
import { readSettings } from './settings-files.mjs';
import {
  assertPushRef,
  readFromTransportBranch,
  trackingRefspec,
} from './git-transport-branch.mjs';
import { parseVerdictLog, parseLedgerEvents, ledgerEventId, checkLedgerAppendRows } from './verdict-ledger.mjs';
import { registerLedgerStore } from './verdict-ledger-store.mjs';
import { LEDGER_DIR, ledgerGitPath } from './verdict-ledger-path.mjs';
import { appendDirect, appendViaOutbox, outboxDirFor, resolveOutboxSettings, formatOutboxSettings, OutboxFlushError } from './verdict-ledger-outbox.mjs';
import {
  LEGACY_LEDGER_BRANCH, resolveLedgerRefSettings, formatLedgerRefSettings, ledgerReadPlan, ledgerWritePlan, ledgerPushRefFor,
  unionLedgerTexts,
} from './verdict-ledger-ref.mjs';

/** The LEGACY ledger ref (and still the default for reads and writes: see `we:scripts/lib/verdict-ledger-ref.mjs`). */
export const LEDGER_TRANSPORT_BRANCH = LEGACY_LEDGER_BRANCH;
export { LEDGER_DIR, ledgerGitPath };
export const DEFAULT_APPEND_ATTEMPTS = 5;
/** The ONLY ref the ledger push path may write (operator decision 2026-10-08): never main, never a lane, never a force. */
export const LEDGER_PUSH_REF = `refs/heads/${LEDGER_TRANSPORT_BRANCH}`;

/** Standard read cap: far above today's ledger (1.47 MB on 2026-10-10), low enough that a runaway file is refused. */
export const DEFAULT_LEDGER_READ_MAX_BYTES = 64 * 1024 * 1024;
export const LEDGER_READ_MAX_BYTES_ENV = 'WE_VERDICT_LEDGER_READ_MAX_BYTES';
/** Extra buffer beyond the blob's exact size (git's own output is the blob bytes only; this is slack, not a guess). */
export const LEDGER_READ_HEADROOM_BYTES = 64 * 1024;
const READ_CAP_CODE = 'LEDGER_READ_CAP';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const validCap = (v) => Number.isSafeInteger(v) && v > 0;

/**
 * PURE cascade for the ledger read cap. The highest layer that sets it VALIDLY wins; an invalid layer is ignored
 * and listed in `invalid` (the layer below answers).
 * @returns {{maxBytes: number, sources: {maxBytes: 'standard'|'repo'|'env'}, invalid: string[]}}
 */
export function resolveLedgerReadSettings({ repo, env } = {}) {
  let maxBytes = DEFAULT_LEDGER_READ_MAX_BYTES;
  let source = 'standard';
  const invalid = [];
  const repoLayer = isPlainObject(repo?.verdictLedger) ? repo.verdictLedger : null;
  if (repoLayer && Object.hasOwn(repoLayer, 'readMaxBytes')) {
    if (validCap(repoLayer.readMaxBytes)) { maxBytes = repoLayer.readMaxBytes; source = 'repo'; } else invalid.push('repo.verdictLedger.readMaxBytes');
  }
  const raw = isPlainObject(env) ? env[LEDGER_READ_MAX_BYTES_ENV] : undefined;
  if (raw !== undefined && raw !== '') {
    const n = /^\d+$/.test(String(raw).trim()) ? Number(String(raw).trim()) : NaN;
    if (validCap(n)) { maxBytes = n; source = 'env'; } else invalid.push(`env.${LEDGER_READ_MAX_BYTES_ENV}`);
  }
  return { maxBytes, sources: { maxBytes: source }, invalid };
}

/** One log line naming the effective cap and the layer that set it. */
export function formatLedgerReadSettings(s) {
  const tail = s.invalid?.length ? `, ignored invalid: ${s.invalid.join(', ')}` : '';
  return `verdict-ledger-io: read cap verdictLedger.readMaxBytes=${s.maxBytes} (${s.sources?.maxBytes ?? 'standard'})${tail}`;
}

function defaultExec(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024, ...opts });
}

/**
 * A `run` for `readFromTransportBranch` whose `show <rev>:<path>` reads the blob with a buffer sized to it.
 * Resolves the path to an immutable blob id first, so the size and the bytes always describe the same object
 * (a concurrent fetch moving the ref between the two calls cannot make the read overflow).
 * THROWS (code `LEDGER_READ_CAP`) when the blob is larger than `maxBytes`; the reader reports that as unreadable.
 * Every other git call passes straight through.
 */
export function sizedLedgerRun({ maxBytes = DEFAULT_LEDGER_READ_MAX_BYTES, source = 'standard', exec = defaultExec } = {}) {
  return (args, opts = {}) => {
    if (args[0] !== 'show' || args.length !== 2) return exec(args, opts);
    const oid = String(exec(['rev-parse', '--verify', '--quiet', args[1]], opts)).trim();
    if (!/^[0-9a-f]{4,64}$/i.test(oid)) throw new Error(`verdict-ledger-io: could not resolve ${args[1]} to a blob id`);
    const sizeText = String(exec(['cat-file', '-s', oid], opts)).trim();
    const size = /^\d+$/.test(sizeText) ? Number(sizeText) : NaN;
    if (!Number.isSafeInteger(size)) throw new Error(`verdict-ledger-io: unreadable blob size ${JSON.stringify(sizeText.slice(0, 40))} for ${args[1]}`);
    if (size > maxBytes) {
      const e = new Error(`verdict-ledger-io: ledger blob ${args[1]} is ${size} bytes, which exceeds the read cap verdictLedger.readMaxBytes=${maxBytes} (${source})`);
      e.code = READ_CAP_CODE;
      throw e;
    }
    return exec(['cat-file', 'blob', oid], { ...opts, maxBuffer: size + LEDGER_READ_HEADROOM_BYTES });
  };
}

const loggedCaps = new Set();
const defaultLog = (line) => { try { process.stderr.write(`${line}\n`); } catch { /* logging never fails a read */ } };


export class LedgerAppendExhaustedError extends Error {
  /** `indeterminate`: a push got no answer, so the rows MAY be on the remote (event ids make a retry safe). */
  constructor({ repo, attempts, errors, indeterminate = false, detail = null }) {
    super(`verdict-ledger-io: append to ${repo} FAILED after ${attempts} attempts${indeterminate ? ' (outcome UNKNOWN: the rows may be on the remote)' : ''}; last error: ${detail ?? errors.at(-1)?.message ?? 'unknown'}`);
    this.name = 'LedgerAppendExhaustedError';
    this.repo = repo;
    this.attempts = attempts;
    this.errors = errors;
    this.indeterminate = indeterminate;
  }
}

/**
 * Read one repo's ledger from the git transport.
 * NEVER THROWS. `unreadable` means "we do not know"; callers must hold, never treat it as empty.
 *
 * WHICH REF: an explicit `branch` reads exactly that ref (unit seams, tools). Otherwise the ledger-ref cascade decides
 * (`we:scripts/lib/verdict-ledger-ref.mjs`): by default the old ref only, exactly as before; with `dualRead` the UNION
 * of the ledger-only ref and the old ref, where an absent ref adds nothing and an existing-but-unreadable one makes the
 * whole read `unreadable`.
 *
 * @returns {{status: 'ok', records: object[], text: string, refs?: object[]} | {status: 'unreadable', reason: string, error: string}}
 */
export function readLedgerFromGit({
  board, repo, branch, run, exec, env = process.env, settings, log = defaultLog,
} = {}) {
  const path = ledgerGitPath(repo);
  let repoSettings;
  try { repoSettings = settings ?? readSettings(); } catch { repoSettings = {}; }
  let plan = { branches: [branch], union: false };
  if (branch === undefined) {
    const refs = resolveLedgerRefSettings({ repo: repoSettings, env });
    logOnce(formatLedgerRefSettings(refs), log);
    plan = ledgerReadPlan(refs);
  }
  try {
    // An injected `run` keeps full control (unit seams). The default sizes the blob read to the blob (see header).
    if (!run) {
      const cap = resolveLedgerReadSettings({ repo: repoSettings, env });
      logOnce(formatLedgerReadSettings(cap), log);
      run = sizedLedgerRun({ maxBytes: cap.maxBytes, source: cap.sources.maxBytes, ...(exec ? { exec } : {}) });
    }
  } catch (e) {
    return { status: 'unreadable', reason: 'transport-read-failed', error: String(e?.message ?? e) };
  }
  if (!plan.union) {
    let files;
    try {
      files = readFromTransportBranch({ board, branch: plan.branches[0], paths: [path], run });
    } catch (e) {
      return { status: 'unreadable', reason: readFailureReason(e), error: String(e?.message ?? e) };
    }
    // THE FENCE (cutover on, old ref retired by pin): the old ref's ledger tree must still be the pinned one. A writer
    // that never switched would otherwise append rows no reader sees. Tree id only: no blob is read.
    if (plan.fence) {
      try {
        run(['fetch', '--quiet', 'origin', trackingRefspec(plan.fence.branch)], { cwd: board });
        const tree = String(run(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${plan.fence.branch}:${LEDGER_DIR}`], { cwd: board })).trim();
        if (tree !== plan.fence.tree) {
          return { status: 'unreadable', reason: 'retired-ref-moved', error: `${plan.fence.branch}:${LEDGER_DIR} is ${tree || '(missing)'}, not the retired ${plan.fence.tree}: a writer still writes the old ref` };
        }
      } catch (e) {
        return { status: 'unreadable', reason: 'retired-ref-moved', error: `fence check of ${plan.fence.branch} failed: ${String(e?.message ?? e)}` };
      }
    }
    const text = files[path] ?? '';
    return { status: 'ok', records: parseVerdictLog(text), text };
  }
  // DUAL READ. Each ref is probed first: a definitive empty `ls-remote` is ABSENT (skipped); anything else is read,
  // and a read that fails fails the whole union. Never a partial answer.
  const got = [];
  for (const b of plan.branches) {
    let present;
    try {
      present = Boolean(String(run(['ls-remote', '--heads', 'origin', `refs/heads/${b}`], { cwd: board })).trim());
    } catch (e) {
      return { status: 'unreadable', reason: 'transport-read-failed', error: `ls-remote ${b}: ${String(e?.message ?? e)}` };
    }
    if (!present) {
      if (plan.required?.includes(b)) {
        return { status: 'unreadable', reason: 'required-ledger-ref-absent', error: `${b} is the ledger write ref (cutover on) but does not exist on origin` };
      }
      got.push({ branch: b, status: 'absent' });
      continue;
    }
    try {
      const files = readFromTransportBranch({ board, branch: b, paths: [path], run });
      got.push({ branch: b, status: 'read', text: files[path] ?? '' });
    } catch (e) {
      return { status: 'unreadable', reason: readFailureReason(e), error: `${b}: ${String(e?.message ?? e)}` };
    }
  }
  const read = got.filter((g) => g.status === 'read');
  if (!read.length) {
    return { status: 'unreadable', reason: 'no-ledger-ref', error: `none of ${plan.branches.join(', ')} exists on origin` };
  }
  const [newRef, oldRef] = got; // plan order: [ledger-only ref, old ref]
  const merged = unionLedgerTexts(oldRef.text ?? '', newRef.text ?? '', { idOf: ledgerEventId });
  if (!merged.ok) return { status: 'unreadable', reason: `union-${merged.reason}`, error: merged.error };
  return {
    status: 'ok', records: parseVerdictLog(merged.text), text: merged.text,
    refs: got.map(({ branch: b, status }) => ({ branch: b, status })),
  };
}

function readFailureReason(e) { return e?.code === READ_CAP_CODE ? 'ledger-exceeds-read-cap' : 'transport-read-failed'; }
function logOnce(line, log) {
  if (loggedCaps.has(line)) return;
  loggedCaps.add(line);
  try { log(line); } catch { /* a log sink never decides an outcome */ }
}

/**
 * Append records to one repo's ledger on the git transport, retrying on a lost push race.
 * Validates every record first; an invalid one refuses the whole call and writes nothing.
 *
 * @returns {{status: 'appended', attempts: number, rows: number, duplicates: number, queued?: boolean, outboxDir?: string} }
 *   `queued: true` (outbox path) = durably queued on this host; the current flusher pushes it.
 * @throws {LedgerAppendExhaustedError} when every attempt failed (LOUD by design) — on the outbox path: the flush
 *   this call ran failed (its own entry withdrawn, so thrown still means not recorded), or the outbox is stale.
 */
export function appendLedgerRows({
  board,
  repo,
  records,
  branch,
  attempts = DEFAULT_APPEND_ATTEMPTS,
  message = `verdict-ledger: append ${repo}`,
  sleep = defaultSleep,
  onRetry = null,
  ...seams // run / mkdir / write / read / rm / now, passed through to the transport
} = {}) {
  if (!Array.isArray(records) || !records.length) throw new TypeError('verdict-ledger-io: `records` must be a non-empty array');
  // WHICH REF: an explicit `branch` wins; otherwise the ledger-ref cascade (cutover off = the old ref, as before).
  // Either way it must be an allow-listed ledger ref, checked before any record is serialized or any git call.
  const { settings: refSettingsLayer, env: refEnv = process.env, log: refLog } = seams;
  let dedupeAlso = null;
  if (branch === undefined) {
    let repoLayer;
    try { repoLayer = refSettingsLayer ?? readSettings(); } catch { repoLayer = {}; }
    const refs = resolveLedgerRefSettings({ repo: repoLayer, env: refEnv });
    logOnce(formatLedgerRefSettings(refs), refLog ?? defaultLog);
    ({ branch, dedupeAlso } = ledgerWritePlan(refs));
  }
  const pushRef = ledgerPushRefFor(branch);
  assertPushRef(branch, pushRef); // a wrong ref writes nothing
  const check = checkLedgerAppendRows(records, repo);
  if (!check.ok) throw new TypeError(`verdict-ledger-io: ${check.error}`);
  const { lines, ids } = check;
  const path = ledgerGitPath(repo);

  // THE OUTBOX PATH (live 2026-10-21, `we:scripts/lib/verdict-ledger-outbox.mjs`): rows are queued host-locally and
  // ONE flusher pushes them as one plumbing commit. Chosen by the settings cascade (off in CI); an explicit
  // `outbox` wins; injected TRANSPORT seams (`run`/`mkdir`/`write`/`read`/`rm`) mean a unit test of the direct
  // path below, which stays exactly as it was for CI and for those seams.
  const { outbox, outboxDir, gitRun, log, env = process.env, settings, removeEntry, random, ...transport } = seams;
  const directSeam = ['run', 'mkdir', 'write', 'read', 'rm'].some((k) => transport[k] !== undefined);
  const cascade = resolveOutboxSettings({ repo: settings ?? readSettings(), env });
  const settingsLine = formatOutboxSettings(cascade);
  if (!loggedCaps.has(settingsLine)) { loggedCaps.add(settingsLine); try { (log ?? defaultLog)(settingsLine); } catch { /* a log sink never decides an outcome */ } }
  if (outbox ?? (cascade.enabled && !directSeam)) {
    try {
      const dir = outboxDir ?? outboxDirFor({ board, env, ...(gitRun ? { run: gitRun } : {}) });
      return appendViaOutbox({
        board, branch, dir, repo, path, lines, ids, message, settings: cascade, allowRef: pushRef, dedupeAlso,
        run: gitRun ?? transport.run, now: transport.now, sleep, random, log, onRetry, removeEntry,
      });
    } catch (e) {
      if (e instanceof OutboxFlushError) throw new LedgerAppendExhaustedError({ repo, attempts: e.attempts, errors: e.errors, indeterminate: e.kind === 'ambiguous', detail: e.message });
      throw e;
    }
  }

  // THE DIRECT PATH: the same plumbing commit and push site as the flusher (one ledger push shape), for this
  // call's rows only. Still computed against the tip it races, still never forced, still loud on exhaustion.
  try {
    return appendDirect({
      board, branch, repo, path, lines, ids, message, attempts, allowRef: pushRef, settings: cascade, dedupeAlso,
      run: transport.run ?? gitRun, sleep, random, log, onRetry,
    });
  } catch (e) {
    if (e instanceof OutboxFlushError) throw new LedgerAppendExhaustedError({ repo, attempts: e.attempts, errors: e.errors, indeterminate: e.kind === 'ambiguous', detail: e.message });
    throw e;
  }
}

/**
 * Synchronous bridge for legacy writers. Validates/stamps ids, contains transport failures, and reports
 * the count from the successful retry (including duplicate-only success). The appendRows seam is synchronous.
 */
export function appendGitRowsSync(rows, ctx = {}, { appendRows = appendLedgerRows } = {}) {
  try {
    const check = checkLedgerAppendRows(rows, ctx?.repo);
    if (!check.ok) return { ok: false, appended: 0, error: check.error };
    const { repo: _ctxRepo, ...rest } = ctx ?? {};
    const result = appendRows({ ...rest, repo: check.repo, records: check.records });
    return { ok: true, appended: result.rows ?? rows.length, duplicates: result.duplicates ?? 0 };
  } catch (e) {
    return { ok: false, appended: 0, error: String(e?.message ?? e).split('\n')[0].slice(0, 300) };
  }
}

/**
 * Async git store contract. ctx/range carry board and transport seams; underlying git primitives stay sync.
 * Deduplication lives in appendLedgerRows's content callback so every push retry sees the current tip's ids.
 */
export function createGitLedgerStore({ appendRows = appendLedgerRows, readRows = readLedgerFromGit } = {}) {
  return {
    name: 'git',
    capabilities: { durable: true, shared: true, ordering: 'total', singleWriter: 'push-race-retry' },
    async append(rows, ctx = {}) {
      return appendGitRowsSync(rows, ctx, { appendRows });
    },
    async read(range = {}) {
      try {
        const { repo, from = 0, ...rest } = range;
        const r = await readRows({ ...rest, repo });
        if (r.status !== 'ok') return { status: 'unreadable', reason: r.reason, error: r.error };
        return { status: 'ok', rows: parseLedgerEvents(r.text).filter((x) => x.repo === repo).slice(from) };
      } catch (e) {
        return { status: 'unreadable', reason: 'transport-read-failed', error: String(e?.message ?? e).split('\n')[0].slice(0, 300) };
      }
    },
  };
}

registerLedgerStore(createGitLedgerStore());

function defaultSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
