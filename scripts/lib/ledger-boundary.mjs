/**
 * @file The judgment boundary (`seen`) a writer stamps on a head-bound row (#5492 rebuild slice 2, design v2 W2).
 *
 * `seen` = `"<n>:<key>"`: n is the 1-based raw position of the LAST row of this PR in the git-store snapshot handed to
 * the judge when the judgment STARTED, and key is that row's identity (`rowIdentity`, the binding fold's own key).
 * `"empty"` when that snapshot had no rows. It is captured once, at judgment start, and carried unchanged to the row:
 * a writer never recomputes it at write time (C3), so an answer can only answer questions its judge was shown.
 * Unreadable ledger → `null`: the row is then written WITHOUT `seen` (legacy), which answers nothing — fail closed.
 */
import { parseLedgerEvents, resolveLedgerBoard } from './verdict-ledger.mjs';
import { readLedgerFromGit } from './verdict-ledger-io.mjs';
import { rowIdentity } from './ledger-binding.mjs';

/** PURE. The boundary of a snapshot: this PR's rows in git append order (as `parseLedgerEvents` returns them). */
export function ledgerBoundary(prRows) {
  if (!Array.isArray(prRows)) return null;
  return prRows.length ? `${prRows.length}:${rowIdentity(prRows.at(-1))}` : 'empty';
}

/** This PR's rows of a parsed repo ledger, in append order: the exact sequence `ledgerAt` folds. */
export const prRowsOf = (rows, pr) => rows.filter((r) => r?.pr === Number(pr));

/**
 * Read the git store NOW and return this PR's boundary, or null when the ledger cannot be read. Sync, so it can sit in
 * the review read step that starts the judgment. `readGit` is a seam for tests.
 */
export function readLedgerBoundary({ repo, pr, readGit = readLedgerFromGit, board } = {}) {
  try {
    const where = board ?? resolveLedgerBoard(repo);
    if (!where) return null;
    const res = readGit({ board: where, repo });
    if (res?.status !== 'ok' || typeof res.text !== 'string') return null;
    return ledgerBoundary(prRowsOf(parseLedgerEvents(res.text), pr));
  } catch {
    return null;
  }
}
