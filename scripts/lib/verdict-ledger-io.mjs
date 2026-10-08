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
 * Reuses `we:scripts/lib/git-transport-branch.mjs` (worktree dance, explicit refspec); does not duplicate it.
 */
import {
  assertPushRef,
  readFromTransportBranch,
  stageOnTransportBranch,
} from './git-transport-branch.mjs';
import { parseVerdictLog, parseLedgerEvents, ledgerEventId, checkLedgerAppendRows } from './verdict-ledger.mjs';
import { registerLedgerStore } from './verdict-ledger-store.mjs';

export const LEDGER_TRANSPORT_BRANCH = 'ops/review-requests';
export const LEDGER_DIR = 'verdict-ledger';
export const DEFAULT_APPEND_ATTEMPTS = 5;
/** The ONLY ref the ledger push path may write (operator decision 2026-10-08): never main, never a lane, never a force. */
export const LEDGER_PUSH_REF = `refs/heads/${LEDGER_TRANSPORT_BRANCH}`;

/** Repo-relative path of one repo's ledger on the transport branch. Same slug rule as `verdictLedgerPath`. */
export function ledgerGitPath(repo) {
  const slug = String(repo ?? '').trim().replace(/[/\\\s\x00-\x1f]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';
  return `${LEDGER_DIR}/${slug}.jsonl`;
}

export class LedgerAppendExhaustedError extends Error {
  constructor({ repo, attempts, errors }) {
    super(`verdict-ledger-io: append to ${repo} FAILED after ${attempts} attempts; last error: ${errors.at(-1)?.message ?? 'unknown'}`);
    this.name = 'LedgerAppendExhaustedError';
    this.repo = repo;
    this.attempts = attempts;
    this.errors = errors;
  }
}

/**
 * Read one repo's ledger from the git transport.
 * NEVER THROWS. `unreadable` means "we do not know"; callers must hold, never treat it as empty.
 *
 * @returns {{status: 'ok', records: object[], text: string} | {status: 'unreadable', reason: string, error: string}}
 */
export function readLedgerFromGit({ board, repo, branch = LEDGER_TRANSPORT_BRANCH, run } = {}) {
  const path = ledgerGitPath(repo);
  let files;
  try {
    files = readFromTransportBranch({ board, branch, paths: [path], ...(run ? { run } : {}) });
  } catch (e) {
    return { status: 'unreadable', reason: 'transport-read-failed', error: String(e?.message ?? e) };
  }
  const text = files[path] ?? '';
  return { status: 'ok', records: parseVerdictLog(text), text };
}

/**
 * Append records to one repo's ledger on the git transport, retrying on a lost push race.
 * Validates every record first; an invalid one refuses the whole call and writes nothing.
 *
 * @returns {{status: 'appended', attempts: number, rows: number, duplicates: number} }
 * @throws {LedgerAppendExhaustedError} when every attempt failed (LOUD by design).
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
  const errors = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      let written = 0;
      let duplicates = 0;
      stageOnTransportBranch({
        board,
        branch,
        message,
        files: [{
          path,
          content: ({ existing }) => {
            const base = existing ?? '';
            const seen = new Set(parseLedgerEvents(base).map(ledgerEventId));
            const fresh = lines.filter((line, i) => {
              if (seen.has(ids[i])) return false;
              seen.add(ids[i]);
              return true;
            });
            written = fresh.length;
            duplicates = lines.length - written;
            if (!written) return base; // identical bytes: transport skips commit and push
            return `${base}${base && !base.endsWith('\n') ? '\n' : ''}${fresh.join('\n')}\n`;
          },
        }],
        ...seams,
        allowRef: LEDGER_PUSH_REF, // after the seams: a caller cannot loosen it
      });
      return { status: 'appended', attempts: attempt, rows: written, duplicates };
    } catch (e) {
      errors.push(e);
      if (attempt < attempts) {
        if (onRetry) onRetry({ attempt, error: e });
        sleep(Math.min(100 * 2 ** (attempt - 1), 1600) + Math.floor(Math.random() * 50));
      }
    }
  }
  throw new LedgerAppendExhaustedError({ repo, attempts, errors });
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
