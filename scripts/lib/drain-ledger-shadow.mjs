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
 *   • status         — `agree` | `disagree` | `transient` | `unreadable`. An unreadable ledger read is NEVER agreement (A4).
 *   • direction      — for a disagreement: `ledger-holds-label-clears` (flipping to `both` would block this merge)
 *                      or `ledger-clears-label-holds` (the ledger alone would merge what the labels hold).
 *
 * Mechanical facts already on the drain verdict add holds to the comparison; stale mechanical events may be
 * reported transient but retain a held ledger verdict. The ledger facts are the minimum the hold rules read (`pr`, `repo`, `head.sha`, `now`): the shadow makes NO
 * per-PR `gh` call. One ledger store read per repo per pass, time-boxed; a failed or late read is unreadable.
 *
 * Edge cases (card): PR bodies/comments are never read here (untrusted text); a cut-off read is unreadable, never
 * empty; the run record is written atomically through the run store (single writer per id); events are scoped per
 * repo and PR head; records are append-only (a fresh id per pass, never rewritten); every record names its writer.
 */

import { decideLedgerGate, DEFAULT_REVIEW_AUTHORITY } from './pr-merge-gate.mjs';
import { foldVerdictLedger, readLedgerEventsFromStore } from './verdict-ledger.mjs';
import { derivePrState } from './pr-state.mjs';
import { readLedgerBindingSettings } from './ledger-binding-settings.mjs';
import { newRunRecord } from '../operations/run-record.mjs';
import { newRunId, writeRun } from '../operations/run-store.mjs';
import { readShadowRuns, measureReadiness, resolvePromotionSettings, formatReadinessLine } from './ledger-promotion-readiness.mjs';
import { readSettings } from './settings-files.mjs';

export const SHADOW_OP = 'drain-ledger-shadow';
export const SHADOW_WRITER = 'merge-ai-prs (drain ledger shadow, #5444)';
export const LEDGER_READ_TIMEOUT_MS = 20_000;
/** #5492 rebuild slice 3 — the wall-clock budget all of one pass's binding folds share (each is also size-capped). */
export const BINDING_PASS_BUDGET_MS = 2000;
/** Bound on rows kept in one record, so a runaway pass cannot write an unbounded file. Counts stay exact. */
export const MAX_ROWS = 300;

const slug = (r) => String(r ?? '').trim().toLowerCase();

const FACT_FIELDS = ['requiredCheckReadError', 'certifyLabel', 'aiGenerated', 'humanCleared', 'offDefaultBase',
  'testGreen', 'codeqlBlocked', 'mergeable', 'state', 'queueBlockedRelief', 'redMainHold'];
const landable = (v) => ['CLEAN', 'UNSTABLE'].includes(v?.state) || v?.queueBlockedRelief === true;

/** Pure, additive mechanical evidence. Missing fields supply no evidence of failure. Never throws. */
export function liveFactHolds(verdict) {
  try {
    const v = verdict ?? {};
    const holds = [];
    const add = (fails, code, reason) => { if (fails) holds.push({ code: `fact:${code}`, reason }); };
    add(v.requiredCheckReadError, 'required-check-unreadable', 'required checks could not be read');
    add(['certifyLabel', 'aiGenerated', 'humanCleared'].every(k => v[k] === false), 'not-certified', 'PR is not certified');
    add(v.offDefaultBase === true, 'off-default-base', 'base is not the default branch');
    add(v.testGreen === false, 'required-check-not-green', 'required check is not green');
    add(v.codeqlBlocked === true, 'codeql-failed', 'CodeQL blocked');
    add(v.mergeable !== undefined && v.mergeable !== 'MERGEABLE', 'not-mergeable', 'PR is not mergeable');
    add(v.state !== undefined && !landable(v), 'merge-state-unlandable', 'merge state is unlandable');
    add(v.redMainHold === true, 'red-main-hold', 'red-main-hold');
    return holds;
  } catch { return []; }
}

/**
 * True only for a nonempty list consisting entirely of stale mechanical drain holds.
 * Without facts, classify mechanical codes only (legacy label-clear replay).
 * With facts, require explicit contradictory evidence; red-main absence is allowed by the label-clear caller.
 */
export function classifyHoldCodes(codes, facts) {
  if (!Array.isArray(codes) || !codes.length) return false;
  return codes.every(code => {
    if (typeof code !== 'string' || !code.startsWith('hold:drain:')) return false;
    const reason = code.slice('hold:drain:'.length);
    const rules = [
      ['required check', v => v.testGreen === true],
      ['not mergeable', v => v.mergeable === 'MERGEABLE'],
      ['merge state', landable],
      ['base is not', v => v.offDefaultBase === false],
      ['red-main-hold', v => v.redMainHold !== true],
      ['codeql', v => v.codeqlBlocked === false],
    ];
    const rule = rules.find(([prefix]) => reason.startsWith(prefix));
    return Boolean(rule && (facts === undefined || rule[1](facts ?? {})));
  });
}

/**
 * One PR's label-vs-ledger row. Pure; never throws.
 * @param {{verdict: object, repo: string, events: (object[]|null), now?: string}} o
 *   `events` is the repo's ledger rows, or `null` when the store read failed (unreadable, never empty).
 */
export function shadowRow({ verdict, repo, events, now = new Date().toISOString(), binding = true, bindingCaps }) {
  const pr = Number(verdict?.num);
  const head = verdict?.listedHeadSha || verdict?.headSha || null;
  const labelsClear = verdict?.decision === 'merge';
  const live = decideLedgerGate({ labelsClear, authority: DEFAULT_REVIEW_AUTHORITY });
  const facts = Object.fromEntries(FACT_FIELDS.filter(k => verdict?.[k] !== undefined).map(k => [k, verdict[k]]));
  const factHolds = liveFactHolds(verdict).map(h => h.code);
  const base = { pr, repo, head, labelVerdict: labelsClear ? 'clear' : 'hold', liveClear: live.clear,
    labelReason: String(verdict?.reason ?? '').trim().slice(0, 200), facts };
  let folded = null;
  let derived = null;
  if (Array.isArray(events)) {
    try {
      const mine = events.filter((e) => e && e.pr === pr && slug(e.repo) === slug(repo));
      const verdictRows = mine.filter((e) => e.type === 'verdict' || e.type === undefined).map(({ type: _t, ...r }) => r);
      // A readable ledger with no row for this PR is a HOLD (nothing clears it), never unreadable.
      folded = foldVerdictLedger(verdictRows).get(pr) ?? { pr, repo, current: null, clears: false, history: [], outstandingHolds: [] };
      // Only `head.sha` and `now` are read by the hold rules; the empty lists keep the phase core from crashing on absent facts.
      derived = derivePrState(events, { pr, repo, head: { sha: head }, now, state: 'OPEN', requiredChecks: [], sessions: [], handoffs: [], refusals: [] },
        { bindingShadow: binding, bindingCaps }); // #5492 rebuild slice 3: the binding answer beside today's (journaled, never decided on)
    } catch { folded = null; derived = null; }
  }
  const ledger = decideLedgerGate({ folded, derived, head, labelsClear, authority: 'ledger' });
  const noRow = folded && !folded.history?.length && derived?.reviewExempt !== true;
  const ledgerHolds = [...(noRow ? ['no-ledger-row'] : (derived?.holds ?? []).map(h => h?.code ?? 'unknown')), ...factHolds];
  // The legacy count comes from the raw rows, so it is exact whatever the derive did (held outright, skipped, budget).
  let legacy = null;
  try { legacy = Array.isArray(events) ? events.filter((e) => e?.pr === pr && slug(e.repo) === slug(repo) && e.type === 'approval' && e.seen === undefined).length : null; }
  catch { legacy = null; } // a malformed row never turns a shadow row into a thrown pass
  const compared = !Array.isArray(events) ? null : !binding ? { status: 'skipped', skipped: 'pass-budget' }
    : bindingCompare(derived) ?? { status: 'skipped', skipped: 'no-binding-answer' };
  const result = { ...base, ledgerHolds, binding: compared && { ...compared, legacyApprovals: legacy } };
  if (ledger.defer) return { ...result, ledgerVerdict: 'unreadable', status: 'unreadable', direction: null, reason: ledger.reason };
  const clears = ledger.clear && !factHolds.length;
  const ledgerVerdict = clears ? 'clear' : 'hold';
  const reason = noRow && !clears ? 'no ledger row for this PR'
    : ledger.clear && factHolds.length ? `ledger holds (live facts): ${factHolds.join(', ')}` : ledger.reason;
  if (clears === labelsClear) return { ...result, ledgerVerdict, status: 'agree', direction: null, reason };
  const covered = folded?.current?.coverage?.headSha;
  if (labelsClear && folded?.clears === true && (!covered || covered === head)
    && classifyHoldCodes(ledgerHolds, facts)) {
    return { ...result, ledgerVerdict, status: 'transient', direction: null, transient: 'stale-drain-mechanical-hold', reason };
  }
  return { ...result, ledgerVerdict, status: 'disagree',
    direction: labelsClear ? 'ledger-holds-label-clears' : 'ledger-clears-label-holds', reason };
}

/**
 * #5492 rebuild slice 3 — today's ledger answer (`derived.clears`) beside the head-binding fold's (`derived.binding`),
 * like for like: both ledger-only, same rows, same live head. `null` when the ledger was unreadable. Pure.
 */
export function bindingCompare(derived) {
  const b = derived?.binding;
  if (!derived || !b) return null;
  if (b.skipped) return { status: 'skipped', skipped: b.skipped, legacyApprovals: b.legacyApprovals };
  const old = derived.clears === true;
  return { status: b.clears === old ? 'agree' : 'disagree', direction: b.clears === old ? null : (old ? 'binding-holds-old-clears' : 'binding-clears-old-holds'),
    oldClears: old, oldHolds: (derived.holds ?? []).map((h) => h?.code ?? 'unknown'), clears: b.clears, holds: b.holds, base: b.base,
    legacyApprovals: b.legacyApprovals };
}

/** The binding shadow's roll-up: counts, directions, the holds behind each disagreement, and legacy approvals. Pure. */
export function summarizeBinding(rows = []) {
  const s = { compared: 0, agree: 0, disagree: 0, skipped: 0, directions: { 'binding-holds-old-clears': 0, 'binding-clears-old-holds': 0 }, holdCodes: {}, legacyApprovals: 0 };
  for (const r of rows) {
    const b = r?.binding;
    if (!b) continue;
    if (b.status !== 'skipped') s.compared += 1;
    s[b.status] += 1;
    s.legacyApprovals += Number.isInteger(b.legacyApprovals) ? b.legacyApprovals : 0;
    if (b.direction) s.directions[b.direction] += 1;
    if (b.status === 'disagree') for (const c of new Set([...(b.clears ? b.oldHolds : b.holds)])) s.holdCodes[c] = (s.holdCodes[c] ?? 0) + 1;
  }
  return s;
}

/** Roll the rows up. Pure. */
export function summarizeShadow(rows = []) {
  const s = { compared: rows.length, agree: 0, disagree: 0, unreadable: 0, transient: 0, transientBy: {},
    directions: { 'ledger-holds-label-clears': 0, 'ledger-clears-label-holds': 0 }, liveUnchanged: true };
  for (const r of rows) {
    s[r.status] += 1;
    if (r.status === 'transient') s.transientBy[r.transient] = (s.transientBy[r.transient] ?? 0) + 1;
    if (r.direction) s.directions[r.direction] += 1;
    // Shadow invariant: under `labels` authority the live gate answer IS the label answer.
    if (r.liveClear !== (r.labelVerdict === 'clear')) s.liveUnchanged = false;
  }
  return s;
}

/** The ONE run record a pass appends. Pure given `id` and `at`. */
export function buildShadowRunRecord({ id, at, repos = [], rows = [], summary, stores = {} }) {
  const rec = newRunRecord({ id, op: SHADOW_OP, input: { schema: 2, at, repos, authority: DEFAULT_REVIEW_AUTHORITY, writer: SHADOW_WRITER } });
  // Disagreements and unreadables first, so the bound never drops the rows that matter.
  const rank = { disagree: 0, unreadable: 1, transient: 2, agree: 3 };
  const kept = [...rows].sort((a, b) => rank[a.status] - rank[b.status] || a.pr - b.pr).slice(0, MAX_ROWS);
  rec.findings = { summary, stores, rows: kept, rowsTruncated: rows.length > kept.length,
    // Slice 3: EVERY binding disagreement (one per PR the pass compared, so bounded by the pass), plus its roll-up.
    binding: { summary: summarizeBinding(rows), disagreements: rows.filter((r) => r.binding?.status === 'disagree')
      .map((r) => ({ pr: r.pr, repo: r.repo, head: r.head, labelVerdict: r.labelVerdict, ...r.binding })) } };
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
 *   mintId?: Function, now?: Function, timeoutMs?: number, readiness?: Function}} o
 */
export async function runLedgerShadow({ verdicts = [], localSlug = null, dryRun = false, readEvents = readLedgerEventsFromStore,
  write = writeRun, mintId = newRunId, now = () => new Date().toISOString(), timeoutMs = LEDGER_READ_TIMEOUT_MS, readiness = defaultReadiness,
  bindingBudgetMs, bindingSettings = readLedgerBindingSettings } = {}) {
  try {
    const at = now();
    // The budget covers the FOLDS only: its clock starts at the first fold, after the store read (a 17k-row git read
    // alone outlasted a 2 s budget started here, so every pass skipped every PR — live drain, 2026-10-21).
    // Budget and caps are `ledgerBinding` settings (cascade, value + source logged); an explicit argument wins (tests).
    const policy = bindingSettings().value;
    const budgetMs = Number.isFinite(bindingBudgetMs) ? bindingBudgetMs : policy.shadowPassBudgetMs ?? BINDING_PASS_BUDGET_MS;
    const bindingCaps = { maxRows: policy.shadowMaxRows, maxBytes: policy.shadowMaxBytes, maxCarries: policy.shadowMaxCarries };
    let bindingDeadline = null;
    const foldAllowed = () => Date.now() < (bindingDeadline ??= Date.now() + budgetMs);
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
      // Slice 3: the binding folds share ONE wall-clock budget per pass; PRs past it are journaled `skipped`, never folded.
      for (const v of vs) rows.push(shadowRow({ verdict: v, repo, events, now: at, binding: foldAllowed(), bindingCaps }));
    }
    const summary = summarizeShadow(rows);
    if (dryRun) return { ok: true, written: false, summary, rows, stores };
    const result = { ok: true, written: false, summary, rows, stores };
    if (rows.length) {
      const record = buildShadowRunRecord({ id: mintId(SHADOW_OP), at, repos: [...byRepo.keys()], rows, summary, stores });
      Object.assign(result, { written: true, id: record.id, path: write(record) });
    }
    let promotion;
    try {
      promotion = await withTimeout(Promise.resolve().then(() => readiness({ now: at })), timeoutMs);
      if (promotion?.status === 'unreadable') promotion = { ok: false, error: promotion.error };
    } catch (e) { promotion = { ok: false, error: String(e?.message ?? e).split('\n')[0].slice(0, 200) }; }
    return { ...result, readiness: promotion };
  } catch (e) {
    return { ok: false, written: false, error: String(e?.message ?? e).split('\n')[0].slice(0, 200) };
  }
}

async function defaultReadiness({ now }) {
  const settingsResult = resolvePromotionSettings({ repo: readSettings(), env: process.env });
  const { runs } = readShadowRuns();
  return { ok: true, measure: measureReadiness(runs, { now, settings: settingsResult.settings }), settingsResult };
}

/** The stderr lines a pass prints. Pure. */
export function formatShadowLine(res) {
  if (!res?.ok) return `merge-ai-prs · ledger shadow: FAILED (${res?.error ?? 'unknown'}) — merge behaviour unaffected`;
  const s = res.summary;
  const dis = (res.rows || []).filter((r) => r.status === 'disagree').slice(0, 10).map((r) => `#${r.pr}(drain:${r.labelVerdict}/ledger:${r.ledgerVerdict})`).join(' ');
  const b = summarizeBinding(res.rows || []);
  const line = `merge-ai-prs · ledger shadow: compared ${s.compared} · agree ${s.agree} · disagree ${s.disagree} · unreadable ${s.unreadable} · transient ${s.transient ?? 0}`
    + (dis ? ` · ${dis}` : '') + (res.written ? ` · record ${res.id}` : ' · not recorded')
    + ` · binding shadow: agree ${b.agree} · disagree ${b.disagree} · skipped ${b.skipped} · legacy approvals ${b.legacyApprovals}`;
  if (!res.readiness) return line;
  const r = res.readiness;
  return line + '\n' + (r.ok === false ? `merge-ai-prs · ledger readiness: FAILED (${r.error ?? 'unknown'})`
    : formatReadinessLine(r.measure, r.settingsResult));
}
