/**
 * @file scripts/lib/drain-ledger-shadow.mjs
 * @description #5444 (verdict-ledger plan slice I2, ruling D4) — the DRAIN LEDGER SHADOW.
 *
 * Every drain pass runs the pure ledger gate (`decideLedgerGate`, pr-merge-gate.mjs, slice I1) beside today's label
 * gate for every PR the pass considered, and journals the comparison as ONE run record (`op: 'drain-ledger-shadow'`)
 * in the shared runs folder. `review-ledger-check --history` counts those records per ET day.
 *
 * SHADOW ONLY. Nothing here feeds back into the drain: the label answer is read off the verdict the drain already
 * computed, the ledger answer is computed beside it, and the result is only written down. `mergeGate.reviewAuthority`
 * stays `labels`; the flip to `both` is a later operator step (D4: shared-store readers, 7 clean days per label
 * family, async store contract).
 *
 * THE COMPARISON, per PR:
 *   • label verdict  — `clear` when the drain's final decision is `merge`, else `hold`.
 *   • ledger verdict — `decideLedgerGate({ authority: 'ledger' })`: `clear` | `hold` | `unreadable`.
 *   • status         — `agree` | `disagree` | `unreadable`. An unreadable ledger read is NEVER agreement (A4).
 *   • direction      — for a disagreement: `ledger-holds-label-clears` (flipping to `both` would block this merge)
 *                      or `ledger-clears-label-holds` (the ledger alone would merge what the labels hold).
 *
 * The ledger facts are the minimum the hold rules read (`pr`, `repo`, `head.sha`, `now`): the shadow makes NO
 * per-PR `gh` call. One ledger store read per repo per pass, time-boxed; a failed or late read is unreadable.
 *
 * Edge cases (card): PR bodies/comments are never read here (untrusted text); a cut-off read is unreadable, never
 * empty; the run record is written atomically through the run store (single writer per id); events are scoped per
 * repo and PR head; records are append-only (a fresh id per pass, never rewritten); every record names its writer.
 */

import { decideLedgerGate, DEFAULT_REVIEW_AUTHORITY } from './pr-merge-gate.mjs';
import { foldVerdictLedger, readLedgerEventsFromStore } from './verdict-ledger.mjs';
import { derivePrState } from './pr-state.mjs';
import { newRunRecord } from '../operations/run-record.mjs';
import { newRunId, writeRun } from '../operations/run-store.mjs';

export const SHADOW_OP = 'drain-ledger-shadow';
export const SHADOW_WRITER = 'merge-ai-prs (drain ledger shadow, #5444)';
export const LEDGER_READ_TIMEOUT_MS = 20_000;
/** Bound on rows kept in one record, so a runaway pass cannot write an unbounded file. Counts stay exact. */
export const MAX_ROWS = 300;

const slug = (r) => String(r ?? '').trim().toLowerCase();

/**
 * One PR's label-vs-ledger row. Pure; never throws.
 * @param {{verdict: object, repo: string, events: (object[]|null), now?: string}} o
 *   `events` is the repo's ledger rows, or `null` when the store read failed (unreadable, never empty).
 */
export function shadowRow({ verdict, repo, events, now = new Date().toISOString() }) {
  const pr = Number(verdict?.num);
  const head = verdict?.listedHeadSha || verdict?.headSha || null;
  const labelsClear = verdict?.decision === 'merge';
  const live = decideLedgerGate({ labelsClear, authority: DEFAULT_REVIEW_AUTHORITY });
  const base = { pr, repo, head, labelVerdict: labelsClear ? 'clear' : 'hold', liveClear: live.clear };
  let folded = null;
  let derived = null;
  if (Array.isArray(events)) {
    try {
      const mine = events.filter((e) => e && e.pr === pr && slug(e.repo) === slug(repo));
      const verdictRows = mine.filter((e) => e.type === 'verdict' || e.type === undefined).map(({ type: _t, ...r }) => r);
      // A readable ledger with no row for this PR is a HOLD (nothing clears it), never unreadable.
      folded = foldVerdictLedger(verdictRows).get(pr) ?? { pr, repo, current: null, clears: false, history: [], outstandingHolds: [] };
      // Only `head.sha` and `now` are read by the hold rules; the empty lists keep the phase core from crashing on absent facts.
      derived = derivePrState(events, { pr, repo, head: { sha: head }, now, state: 'OPEN', requiredChecks: [], sessions: [], handoffs: [], refusals: [] });
    } catch { folded = null; derived = null; }
  }
  const ledger = decideLedgerGate({ folded, derived, head, labelsClear, authority: 'ledger' });
  if (ledger.defer) return { ...base, ledgerVerdict: 'unreadable', status: 'unreadable', direction: null, reason: ledger.reason };
  const ledgerVerdict = ledger.clear ? 'clear' : 'hold';
  const noRow = folded && !folded.history?.length;
  const reason = noRow && !ledger.clear ? 'no ledger row for this PR' : ledger.reason;
  if (ledger.clear === labelsClear) return { ...base, ledgerVerdict, status: 'agree', direction: null, reason };
  return { ...base, ledgerVerdict, status: 'disagree',
    direction: labelsClear ? 'ledger-holds-label-clears' : 'ledger-clears-label-holds', reason };
}

/** Roll the rows up. Pure. */
export function summarizeShadow(rows = []) {
  const s = { compared: rows.length, agree: 0, disagree: 0, unreadable: 0,
    directions: { 'ledger-holds-label-clears': 0, 'ledger-clears-label-holds': 0 }, liveUnchanged: true };
  for (const r of rows) {
    s[r.status] += 1;
    if (r.direction) s.directions[r.direction] += 1;
    // Shadow invariant: under `labels` authority the live gate answer IS the label answer.
    if (r.liveClear !== (r.labelVerdict === 'clear')) s.liveUnchanged = false;
  }
  return s;
}

/** The ONE run record a pass appends. Pure given `id` and `at`. */
export function buildShadowRunRecord({ id, at, repos = [], rows = [], summary, stores = {} }) {
  const rec = newRunRecord({ id, op: SHADOW_OP, input: { at, repos, authority: DEFAULT_REVIEW_AUTHORITY, writer: SHADOW_WRITER } });
  // Disagreements and unreadables first, so the bound never drops the rows that matter.
  const rank = { disagree: 0, unreadable: 1, agree: 2 };
  const kept = [...rows].sort((a, b) => rank[a.status] - rank[b.status] || a.pr - b.pr).slice(0, MAX_ROWS);
  rec.findings = { summary, stores, rows: kept, rowsTruncated: rows.length > kept.length };
  rec.verdict = summary.disagree || summary.unreadable ? 'drift' : 'clean';
  return rec;
}

function withTimeout(promise, ms) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve({ status: 'unreadable', reason: 'timeout', error: `ledger read exceeded ${ms}ms` }), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/**
 * Run the shadow for one drain pass. NEVER throws and never changes a verdict: every failure is reported in the
 * return value (and an unreadable store marks its PRs unreadable).
 * @param {{verdicts: object[], localSlug?: string|null, dryRun?: boolean, readEvents?: Function, write?: Function,
 *   mintId?: Function, now?: Function, timeoutMs?: number}} o
 */
export async function runLedgerShadow({ verdicts = [], localSlug = null, dryRun = false, readEvents = readLedgerEventsFromStore,
  write = writeRun, mintId = newRunId, now = () => new Date().toISOString(), timeoutMs = LEDGER_READ_TIMEOUT_MS } = {}) {
  try {
    const at = now();
    const byRepo = new Map();
    for (const v of verdicts) {
      if (!v || !Number.isInteger(Number(v.num))) continue;
      const repo = v.repo || localSlug;
      if (!repo) continue;
      if (!byRepo.has(repo)) byRepo.set(repo, []);
      byRepo.get(repo).push(v);
    }
    const rows = [];
    const stores = {};
    for (const [repo, vs] of byRepo) {
      let read;
      try { read = await withTimeout(Promise.resolve(readEvents(repo)), timeoutMs); } catch (e) { read = { status: 'unreadable', reason: 'store-read-failed', error: String(e?.message ?? e) }; }
      const events = read?.status === 'ok' && Array.isArray(read.rows) ? read.rows : null;
      stores[repo] = events ? { status: 'ok', name: read.store?.name ?? null, shared: read.store?.shared === true, rows: events.length }
        : { status: 'unreadable', name: read?.store?.name ?? null, reason: read?.reason ?? 'unknown', error: String(read?.error ?? '').slice(0, 200) };
      for (const v of vs) rows.push(shadowRow({ verdict: v, repo, events, now: at }));
    }
    const summary = summarizeShadow(rows);
    if (dryRun || !rows.length) return { ok: true, written: false, summary, rows, stores };
    const record = buildShadowRunRecord({ id: mintId(SHADOW_OP), at, repos: [...byRepo.keys()], rows, summary, stores });
    const path = write(record);
    return { ok: true, written: true, id: record.id, path, summary, rows, stores };
  } catch (e) {
    return { ok: false, written: false, error: String(e?.message ?? e).split('\n')[0].slice(0, 200) };
  }
}

/** The one stderr line a pass prints. Pure. */
export function formatShadowLine(res) {
  if (!res?.ok) return `merge-ai-prs · ledger shadow: FAILED (${res?.error ?? 'unknown'}) — merge behaviour unaffected`;
  const s = res.summary;
  const dis = (res.rows || []).filter((r) => r.status === 'disagree').slice(0, 10).map((r) => `#${r.pr}(${r.labelVerdict}/${r.ledgerVerdict})`).join(' ');
  return `merge-ai-prs · ledger shadow: compared ${s.compared} · agree ${s.agree} · disagree ${s.disagree} · unreadable ${s.unreadable}`
    + (dis ? ` · ${dis}` : '') + (res.written ? ` · record ${res.id}` : ' · not recorded');
}
