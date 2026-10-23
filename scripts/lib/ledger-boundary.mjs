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
import { rowIdentity, ledgerAt } from './ledger-binding.mjs';

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

/** The most question rows one review stamps in `seenKeys` (the ledger schema's bound); more → render, stamp nothing. */
export const MAX_SEEN_KEYS = 200;
const oneLine = (v, max = 200) => String(v ?? '').replace(/\s+/g, ' ').replace(/[`<>]/g, "'").trim().slice(0, max);
/** A juror-readable line for one question row. Ledger text is our writers' own, still clipped and defused. */
const describe = (row) => {
  const t = row.type ?? 'verdict';
  const what = t === 'verdict' ? `verdict \`${oneLine(row.verdict, 40)}\`${row.reason ? `: ${oneLine(row.reason)}` : ''}`
    : t === 'label-input' ? `label \`${oneLine(row.label, 60)}\` added by ${oneLine(row.sender, 60)}`
    : t === 'send-back' ? `send-back (${oneLine(row.cause, 40)})`
    : t === 'referral' ? `referral of ${(row.findingKeys ?? []).length} finding(s) at ${oneLine(row.headSha, 12)}`
    : t === 'review-run' ? `review run raising ${(row.raised ?? []).length} finding(s)`
    : t === 'hold' ? `hold ${oneLine(row.holdSource, 60)}: ${oneLine(row.reasonCode, 100)}` : oneLine(t, 40);
  return `${what} (${oneLine(row.source, 40)}, ${oneLine(row.at, 30)})`;
};

/**
 * Slice 4 (fork D1, as designed): the PR's OPEN ledger questions at `head` — every hold the binding fold lists as
 * unanswered that traces to a question row — for review-pr to show its jurors, and the exact row keys it may then
 * stamp as `seenKeys`. Read failure → `{status: 'unknown'}`: the jurors are told so and nothing is stamped (the
 * review's rows stay unbounded, which answers nothing). Sync (it sits in the read step). Never throws.
 * @returns {{status:'ok', items:{code:string,key:string,text:string}[], keys:string[]|null} | {status:'unknown', why:string}}
 */
export function readOpenQuestions({ repo, pr, head, now = new Date().toISOString(), readGit = readLedgerFromGit, board } = {}) {
  try {
    if (!/^[0-9a-f]{40}$/.test(head ?? '')) return { status: 'unknown', why: 'the reviewed head is not pinned' };
    const where = board ?? resolveLedgerBoard(repo);
    if (!where) return { status: 'unknown', why: 'no ledger board' };
    const res = readGit({ board: where, repo });
    if (res?.status !== 'ok' || typeof res.text !== 'string') return { status: 'unknown', why: `ledger unreadable (${res?.reason ?? 'unknown'})` };
    const rows = prRowsOf(parseLedgerEvents(res.text), pr);
    const byKey = new Map(rows.map((r) => [rowIdentity(r), r]));
    const items = [];
    for (const h of ledgerAt(rows, head, { now }).holds) {
      const row = h.key && byKey.get(h.key);
      if (row && !items.some((i) => i.key === h.key && i.code === h.code)) items.push({ code: h.code, key: h.key, text: describe(row) });
    }
    const keys = [...new Set(items.map((i) => i.key))].sort();
    return { status: 'ok', items, keys: keys.length > MAX_SEEN_KEYS ? null : keys };
  } catch (e) {
    return { status: 'unknown', why: String(e?.message ?? e).slice(0, 120) };
  }
}
