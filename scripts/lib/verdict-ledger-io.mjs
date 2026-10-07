/**
 * @file scripts/lib/verdict-ledger-io.mjs
 * @description THE GIT IO-SHELL OF THE VERDICT LEDGER (ledger plan slice C1 = #3255 part 1; plan section 3.2).
 *   Fetch, append, bounded retry, on the `ops/review-requests` git transport. NO CALLERS YET: nothing in the
 *   repo imports this until C2 (dual-write) lands.
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
  readFromTransportBranch,
  stageOnTransportBranch,
} from './git-transport-branch.mjs';
import { parseVerdictLog, serializeVerdictRecord } from './verdict-ledger.mjs';

export const LEDGER_TRANSPORT_BRANCH = 'ops/review-requests';
export const LEDGER_DIR = 'verdict-ledger';
export const DEFAULT_APPEND_ATTEMPTS = 5;

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
 * @returns {{status: 'appended', attempts: number, rows: number} }
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
  const lines = records.map((r) => {
    const s = serializeVerdictRecord(r);
    if (!s.ok) throw new TypeError(`verdict-ledger-io: invalid record refused, nothing written: ${s.errors.join('; ')}`);
    return s.line;
  });
  const path = ledgerGitPath(repo);
  const errors = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      stageOnTransportBranch({
        board,
        branch,
        message,
        files: [{
          path,
          content: ({ existing }) => {
            const base = existing ?? '';
            return `${base}${base && !base.endsWith('\n') ? '\n' : ''}${lines.join('\n')}\n`;
          },
        }],
        ...seams,
      });
      return { status: 'appended', attempts: attempt, rows: lines.length };
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

function defaultSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
