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
 * plumbing commit in `we:scripts/lib/verdict-ledger-plumbing.mjs` (the host-local outbox in front of it lands next).
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
} from './git-transport-branch.mjs';
import { parseVerdictLog, parseLedgerEvents, ledgerEventId, checkLedgerAppendRows } from './verdict-ledger.mjs';
import { registerLedgerStore } from './verdict-ledger-store.mjs';
import { LEDGER_DIR, ledgerGitPath } from './verdict-ledger-path.mjs';
import { appendDirect } from './verdict-ledger-plumbing.mjs';
import { resolveOutboxSettings } from './verdict-ledger-outbox-spool.mjs';
import { OutboxFlushError } from './verdict-ledger-git.mjs';

export const LEDGER_TRANSPORT_BRANCH = 'ops/review-requests';
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
 * @returns {{status: 'ok', records: object[], text: string} | {status: 'unreadable', reason: string, error: string}}
 */
export function readLedgerFromGit({
  board, repo, branch = LEDGER_TRANSPORT_BRANCH, run, exec, env = process.env, settings, log = defaultLog,
} = {}) {
  const path = ledgerGitPath(repo);
  let files;
  try {
    // An injected `run` keeps full control (unit seams). The default sizes the blob read to the blob (see header).
    if (!run) {
      const cap = resolveLedgerReadSettings({ repo: settings ?? readSettings(), env });
      const line = formatLedgerReadSettings(cap);
      if (!loggedCaps.has(line)) { loggedCaps.add(line); log(line); }
      run = sizedLedgerRun({ maxBytes: cap.maxBytes, source: cap.sources.maxBytes, ...(exec ? { exec } : {}) });
    }
    files = readFromTransportBranch({ board, branch, paths: [path], run });
  } catch (e) {
    const reason = e?.code === READ_CAP_CODE ? 'ledger-exceeds-read-cap' : 'transport-read-failed';
    return { status: 'unreadable', reason, error: String(e?.message ?? e) };
  }
  const text = files[path] ?? '';
  return { status: 'ok', records: parseVerdictLog(text), text };
}

/**
 * Append records to one repo's ledger on the git transport, retrying on a lost push race.
 * Validates every record first; an invalid one refuses the whole call and writes nothing.
 *
 * @returns {{status: 'appended', attempts: number, rows: number, duplicates: number} }
 * @throws {LedgerAppendExhaustedError} when every attempt failed (LOUD by design)
 */
export function appendLedgerRows({
  board,
  repo,
  records,
  branch = LEDGER_TRANSPORT_BRANCH,
  attempts = DEFAULT_APPEND_ATTEMPTS,
  message = `verdict-ledger: append ${repo}`,
  sleep = defaultSleep,
  onRetry = null,
  ...seams // run / mkdir / write / read / rm / now, passed through to the transport
} = {}) {
  if (!Array.isArray(records) || !records.length) throw new TypeError('verdict-ledger-io: `records` must be a non-empty array');
  assertPushRef(branch, LEDGER_PUSH_REF); // before any record is serialized or any git call: a wrong ref writes nothing
  const check = checkLedgerAppendRows(records, repo);
  if (!check.ok) throw new TypeError(`verdict-ledger-io: ${check.error}`);
  const { lines, ids } = check;
  const path = ledgerGitPath(repo);

  // The outbox seams (`outbox`, `outboxDir`, `gitRun`, `removeEntry`) are accepted and ignored until the outbox lands;
  // the time budget already comes from its settings cascade (standard → repo `verdictLedger.*` → env).
  const { outbox, outboxDir, gitRun, log, env = process.env, settings, removeEntry, random, ...transport } = seams;
  const cascade = resolveOutboxSettings({ repo: settings ?? readSettings(), env });

  // THE DIRECT PATH: the same plumbing commit and push site as the flusher (one ledger push shape), for this
  // call's rows only. Still computed against the tip it races, still never forced, still loud on exhaustion.
  try {
    return appendDirect({
      board, branch, repo, path, lines, ids, message, attempts, allowRef: LEDGER_PUSH_REF, settings: cascade,
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
