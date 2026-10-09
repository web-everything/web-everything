#!/usr/bin/env node
/**
 * @file scripts/review-ledger-check.mjs
 * @description THE #3007 PHASE-1 CHECKER — report every disagreement between the append-only verdict ledger
 *   and the GitHub review labels. This is the POINT of Phase 1: it produces the evidence that decides whether
 *   Phase 2 (the drain merging on the ledger alone) is safe to ship.
 *
 * It DECIDES NOTHING and CHANGES NOTHING. No label is written, no PR is touched, no merge is influenced. It
 * makes exactly one `gh` read per repo.
 *
 * WHERE IT RUNS, AND WHY NOT THE OTHER TWO PLACES:
 *   • NOT in `npm run check:standards`. That gate is the repo's offline health check — it must be
 *     deterministic and network-free, and it is run constantly. Putting a live `gh pr list` in it buys a
 *     flaky, rate-limited gate. What DOES run there is the whole comparison LOGIC: `compareLedgerToLabels`,
 *     `labelVerdictOf` and `summarizeAgreement` are pure and covered by
 *     `we:scripts/lib/__tests__/verdict-ledger.test.mjs`, so the reasoning is gated even though the sweep is
 *     not.
 *   • NOT in the drain pass. Phase 1's whole rule is that the drain does not change. A per-pass `gh` sweep
 *     would also add an API cost and a new failure mode to the one process that must stay boring.
 *   • SO: a standalone command the operator runs during the ~1-week observation window #3007 asks for. That
 *     window is a human decision procedure, and this is its instrument.
 *
 * EXIT CODE, chosen so this can later be wired into a gate unchanged:
 *   0 — no dangerous disagreement (agreement, or only the benign directions, or nothing to compare).
 *   1 — at least one `ledger-holds-label-clears`: the ledger records a HOLD while the label says the drain
 *       may merge. Under today's label authority that is a live "hold that didn't hold" (#2750/#2820/#2745/
 *       #2416) caught in the act, which is the one thing this checker must never report quietly.
 *   2 — usage / `gh` failure / unreadable ledger store.
 *
 * Usage:
 *   node scripts/review-ledger-check.mjs [--repo=<owner/name>] [--json] [--all] [--limit=<n>] [--store=<name>]
 *   node scripts/review-ledger-check.mjs --history [--json] [--days=<n>] [--repos=<a,b>]
 *   `--all` includes PRs that agree; the default output lists only what needs attention plus the summary.
 *   With no `--repo`, every constellation repo is checked, one run record each (#3930). With `--repo`, only that one.
 *
 * RUN HISTORY (#3930): `--history` reads the run records back and answers "how many consecutive clean days per
 * label family?" (we:scripts/lib/review-ledger-history.mjs). It makes no `gh` call. Exit 0 when every family has
 * 7 clean days across all constellation repos, 1 when any family is short, 2 on a usage error.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  AGREEMENT, DISAGREE_DIRECTION, compareLedgerToLabels, foldVerdictLedger, readLedgerEventsFromStore, labelVerdictOf, parseLedgerEvents,
  summarizeAgreement, verdictLedgerPath,
} from './lib/verdict-ledger.mjs';
import { derivePrState } from './lib/pr-state.mjs';
import { readPrFacts } from './lib/pr-state-io.mjs';
import { LIFECYCLE_STATES } from './conveyor/pr-lifecycle.mjs';
import { newRunRecord } from './operations/run-record.mjs';
import { newRunId, writeRun } from './operations/run-store.mjs';
import { writeAllSync } from './lib/write-all-sync.mjs';
import { DEFAULT_REPOS, REQUIRED_CLEAN_DAYS, cleanDaysPerFamily, readCheckRuns, renderCleanDays } from './lib/review-ledger-history.mjs';

const MAX_HISTORY_DAYS = 366; // bounds the window loop: `--days=30000000` would spin for minutes

export const DEFAULT_REPO = 'web-everything/web-everything';
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/**
 * Read the OPEN PRs and their labels. One `gh` call. Injectable `exec` so the assembly is testable without
 * the network (the pure comparison is tested directly; this shell is tested for its argv and its parse).
 * @param {{repo: string, limit?: number, exec?: Function}} o
 * @returns {Array<{number: number, labels: Array}>}
 */
export function readOpenPrs({ repo, limit = 200, exec = execFileSync } = {}) {
  const out = exec('gh', [
    'pr', 'list', '--repo', repo, '--state', 'open', '--limit', String(limit), '--json', 'number,labels,title',
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  // Empty or non-array output is a failed read, never "no open PRs": runCheck turns the throw into exit 2 and no record.
  const parsed = JSON.parse(String(out));
  if (!Array.isArray(parsed)) throw new Error('gh pr list returned a non-array payload');
  return parsed;
}

/**
 * Build the per-PR comparison rows for one repo. PURE given the two inputs, so the CLI's only impure act is
 * fetching them.
 *
 * THE PR SET IS THE UNION of "open PRs carrying a review label" and "open PRs with a ledger record" — never
 * just one side. Sweeping only the labelled PRs would make an orphan ledger row (a verdict whose label swap
 * failed) invisible, and that row is precisely the failure Phase 1 needs to be able to see. A ledger record
 * for a PR that is no longer open is skipped: the PR is decided, and nothing merges twice.
 *
 * "A LEDGER RECORD" MEANS A **BEARING** ONE (#3329), which is why the admission test is `current != null` and
 * not `folded.has(n)`. `observed` records that a review happened and bears on nothing; it mirrors no label BY
 * CONSTRUCTION (`verdictLabel` returns `null`), so it is not drift and must not be scored as any. Admitting a
 * PR on the strength of an `observed` row alone would add a row whose ledger side is empty and whose label
 * side is empty — counted `agree`, inflating `total` with PRs that were never a comparison, or counted
 * against the drift lines the moment the PR also carries a label. Either way the number this checker exists
 * to produce gets noise in it and a real orphan row is that much harder to see. `folded.current` is already
 * the fold's own answer to "is there a live verdict here", so this reuses it rather than re-deriving
 * bearingness — one definition, not two that can disagree.
 *
 * A PR with a review label AND an `observed` row is still admitted (the label admits it) and still scored
 * `unledgered`, which is correct: the label genuinely has no verdict row behind it.
 *
 * @param {{prs: Array<{number: number, labels: Array}>, folded: Map<number, object>}} o
 * @returns {Array} comparison rows, PR-ascending.
 */
export function buildRows({ prs = [], folded = new Map() } = {}) {
  const byNumber = new Map();
  for (const p of prs) {
    if (!p || !Number.isInteger(p.number)) continue;
    byNumber.set(p.number, Array.isArray(p.labels) ? p.labels : []);
  }
  return [...byNumber.keys()]
    .filter((n) => (folded.get(n)?.current ?? null) != null || labelVerdictOf(byNumber.get(n)) != null)
    .sort((a, b) => a - b)
    .map((pr) => compareLedgerToLabels({ pr, labels: byNumber.get(pr) || [], folded: folded.get(pr) || null }));
}

/** One PR's line, in the shape a human scans: what each side says, and what to do about it. Pure. */
export function renderRow(row) {
  const mark = row.status === AGREEMENT.DISAGREE
    ? (row.direction === DISAGREE_DIRECTION.LEDGER_HOLDS_LABEL_CLEARS ? '  BLOCKER' : '  differs')
    : row.status === AGREEMENT.UNLABELED ? ' orphaned'
      : row.status === AGREEMENT.UNLEDGERED ? '   no-row'
        : '        ✓';
  const when = row.at ? row.at.replace('T', ' ').replace(/\..*Z$/, 'Z').replace(/Z$/, '') : '—';
  return `${mark}  #${String(row.pr).padEnd(6)} ledger=${String(row.ledgerVerdict ?? '—').padEnd(12)}`
    + ` label=${String(row.labelVerdict ?? '—').padEnd(9)} ${when.padEnd(17)} ${row.detail}`;
}

/** The whole human-readable report. Pure — the CLI only prints what this returns. */
export function renderReport({ repo, rows, summary, path, store, showAll = false }) {
  const lines = [];
  lines.push(`#3007 Phase 1 — verdict ledger vs review labels · ${repo}`);
  if (store) lines.push(`ledger store: ${store.name} (${store.shared ? 'shared' : 'NOT shared - rows written on other machines are invisible here'})`);
  if (path) lines.push(`ledger: ${path}`);
  lines.push('');
  const shown = showAll ? rows : rows.filter((r) => r.status !== AGREEMENT.AGREE);
  if (!shown.length) {
    lines.push(rows.length ? `all ${rows.length} compared PR(s) agree.` : 'nothing to compare — no open PR carries a review label and the ledger has no open-PR record.');
  } else {
    for (const r of shown) lines.push(renderRow(r));
  }
  lines.push('');
  lines.push(`compared ${summary.total} · agree ${summary.counts.agree} · disagree ${summary.counts.disagree}`
    + ` · unledgered ${summary.counts.unledgered} · unlabeled ${summary.counts.unlabeled}`);
  if (summary.counts.disagree) {
    lines.push(`  directions: ledger-holds/label-clears ${summary.directions['ledger-holds-label-clears']}`
      + ` · ledger-clears/label-holds ${summary.directions['ledger-clears-label-holds']}`
      + ` · same-side ${summary.directions['same-side']}`);
  }
  lines.push('');
  // THE ACTIONABLE TAIL. A checker that only prints counts makes the reader do the reasoning; the whole
  // reason this exists is to hand a decision to a person, so it states what each number means for Phase 2.
  if (summary.dangerous.length) {
    lines.push(`ACT NOW — ${summary.dangerous.length} PR(s) carry a merge-clearing LABEL while the ledger records a HOLD.`);
    lines.push('  Today the drain merges on the label, so each of these is a live escaped hold. Re-apply the hold');
    lines.push(`  label (or re-verdict) on: ${summary.dangerous.map((r) => `#${r.pr}`).join(', ')}`);
  } else if (summary.counts.disagree) {
    lines.push('No escaped hold. The disagreements are in the safe direction (today\'s drain refuses these merges),');
    lines.push('  but each one is a Phase-2 hazard: read why the two sides diverged before flipping the authority.');
  }
  if (summary.counts.unledgered) {
    lines.push(`OWED BEFORE PHASE 2 — ${summary.counts.unledgered} PR(s) carry a review label with no ledger row.`);
    lines.push('  Expected in Phase 1: the writer sits at review-set-label.mjs, so holds the DRAIN applies itself');
    lines.push('  (merge-ai-prs.mjs `applyLabel`) are unledgered. A ledger that cannot express a drain-applied hold');
    lines.push('  cannot be the merge authority — wiring that writer is a Phase-2 precondition, not a Phase-1 gap.');
  }
  if (summary.counts.unlabeled) {
    lines.push(`INVESTIGATE — ${summary.counts.unlabeled} PR(s) have a ledger row and no review label: the mirror to`);
    lines.push('  the label did not land, or something erased it. The second case is the #3007 headline bug, visible.');
  }
  lines.push(summary.phase2Safe
    ? 'PHASE 2 READINESS: this run is clean (no disagreement, no unledgered label). Phase 2 needs a RUN OF such days, not one.'
    : 'PHASE 2 READINESS: not yet — see the lines above.');
  return lines.join('\n');
}


// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// SLICE F (#3930) — CHECKER V2: DERIVED LABELS vs LIVE LABELS, ALL MIRRORED FAMILIES. REPORT-ONLY.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// `derivePrState(...).labels` is what the label mirror WILL write once the ledger is the authority. This compares
// that to the labels that are live today, one family at a time, and appends ONE run record per run so a week of
// runs is the evidence slice L waits for. It writes no label and touches no PR.

/** The label families the mirror writes, in report order. A label belongs to the first family whose test it passes. */
export const LABEL_FAMILIES = Object.freeze([
  // Only the four labels the mirror renders; other `review:` labels (`review:awaiting-advisory`) are not the mirror's to remove.
  { family: 'review', owns: (l) => ['review:pending', 'review:changes', 'review:human', 'review:accepted'].includes(l) },
  { family: 'ruling-needed', owns: (l) => l === 'advisory:ruling-needed' },
  { family: 'ready-to-merge', owns: (l) => l === 'ready-to-merge' },
  { family: 'ci-failed', owns: (l) => l === 'ci:failed' },
]);

/** Every label some lifecycle state renders must land in a family, or a new mirrored label would go unchecked. */
export function unfamilied(states = LIFECYCLE_STATES) {
  const all = new Set(states.flatMap((row) => row.renderLabels ?? []));
  return [...all].filter((l) => !LABEL_FAMILIES.some((f) => f.owns(l))).sort();
}

const names = (labels) => (Array.isArray(labels) ? labels : [])
  .map((l) => (typeof l === 'string' ? l : l?.name)).filter((n) => typeof n === 'string');

/** Split label names into the mirrored families. Labels outside every family (`ci:passing`, `bug`) are not ours. Pure. */
export function labelsByFamily(labels) {
  const out = Object.fromEntries(LABEL_FAMILIES.map((f) => [f.family, []]));
  for (const n of new Set(names(labels))) {
    const fam = LABEL_FAMILIES.find((f) => f.owns(n));
    if (fam) out[fam.family].push(n);
  }
  for (const k of Object.keys(out)) out[k].sort();
  return out;
}

/**
 * Compare derived to live, per family. `missing` = derived but not live (the mirror would ADD it); `extra` = live
 * but not derived (the mirror would REMOVE it). Pure.
 * @returns {Array<{family: string, derived: string[], live: string[], missing: string[], extra: string[], agree: boolean}>}
 */
export function compareDerivedLabels({ derived = [], live = [] } = {}) {
  const d = labelsByFamily(derived);
  const l = labelsByFamily(live);
  return LABEL_FAMILIES.map(({ family }) => {
    const missing = d[family].filter((n) => !l[family].includes(n));
    const extra = l[family].filter((n) => !d[family].includes(n));
    return { family, derived: d[family], live: l[family], missing, extra, agree: !missing.length && !extra.length };
  });
}

/**
 * One PR's derived-vs-live row. `events` is this PR's ledger rows, or `null` when the ledger (or the facts) could
 * not be read: that is `unreadable`, which is NEVER scored as agreement or as drift (we do not know).
 * @returns {{pr: number, status: 'agree'|'mismatch'|'unreadable', lifecycleState: string|null, families: Array, reason?: string}}
 */
export function deriveRow({ pr, repo, events, facts, liveLabels, settings = {} }) {
  if (events == null) return { pr, status: 'unreadable', lifecycleState: null, families: [], reason: 'the verdict ledger could not be read' };
  if (!facts || (facts.probeErrors ?? []).some((e) => /^GitHub PR/.test(e))) {
    return { pr, status: 'unreadable', lifecycleState: null, families: [], reason: 'the GitHub facts for this PR could not be read' };
  }
  const mine = events.filter((e) => e.pr === pr && String(e.repo).toLowerCase() === repo.toLowerCase());
  const derived = derivePrState(mine, { ...facts, repo, pr }, settings);
  const families = compareDerivedLabels({ derived: derived.labels, live: liveLabels });
  return { pr, status: families.every((f) => f.agree) ? 'agree' : 'mismatch', lifecycleState: derived.lifecycleState, families };
}

/** Roll the per-PR rows up per family. `unreadable` PRs are counted apart, never inside a family. Pure. */
export function summarizeDerived(rows = []) {
  const perFamily = Object.fromEntries(LABEL_FAMILIES.map((f) => [f.family, { compared: 0, agree: 0, disagree: 0 }]));
  const mismatches = [];
  let unreadable = 0;
  for (const r of rows) {
    if (r.status === 'unreadable') { unreadable += 1; continue; }
    for (const f of r.families) {
      perFamily[f.family].compared += 1;
      perFamily[f.family][f.agree ? 'agree' : 'disagree'] += 1;
      if (!f.agree) mismatches.push({ pr: r.pr, family: f.family, lifecycleState: r.lifecycleState, live: f.live, derived: f.derived, missing: f.missing, extra: f.extra });
    }
  }
  return { total: rows.length, agree: rows.filter((r) => r.status === 'agree').length,
    mismatch: rows.filter((r) => r.status === 'mismatch').length, unreadable, perFamily, mismatches };
}

/** The human lines for the derived comparison. Pure. */
export function renderDerived(summary) {
  const lines = ['', 'DERIVED vs LIVE LABELS (report only; nothing is changed)'];
  for (const [family, c] of Object.entries(summary.perFamily)) {
    lines.push(`  ${family.padEnd(15)} compared ${c.compared} · agree ${c.agree} · disagree ${c.disagree}`);
  }
  for (const m of summary.mismatches) {
    lines.push(`  mismatch #${m.pr} ${m.family} (${m.lifecycleState}): live=[${m.live.join(',')}] derived=[${m.derived.join(',')}]`);
  }
  if (summary.unreadable) lines.push(`  unreadable: ${summary.unreadable} PR(s) (not scored as agree or disagree)`);
  return lines.join('\n');
}

/** This PR set's HOME-FILE-ONLY ledger events. Absent file = no rows; any other read failure = `null` (unreadable, never empty). */
export function readRepoEvents(repo, { read = readFileSync, pathOf = verdictLedgerPath } = {}) {
  try {
    return parseLedgerEvents(read(pathOf(repo), 'utf8'));
  } catch (e) {
    return e?.code === 'ENOENT' ? [] : null;
  }
}

/** Configured-store convenience reader: unreadable is null, never an empty event array. */
export async function readRepoEventsFromStore(repo, opts = {}) {
  const result = await readLedgerEventsFromStore(repo, opts);
  return result.status === 'ok' ? result.rows : null;
}

/**
 * The ONE run record a check appends. It reuses the operations run record shape, so it lands in the shared runs
 * folder (`OPERATION_RUNS_DIR` wins) next to every other run. Pure given `id` and `at`.
 */
export function buildCheckRunRecord({ id, repo, at, summary, phase1, scan }) {
  const rec = newRunRecord({ id, op: 'review-ledger-check', input: { repo, at } });
  rec.findings = { derived: { total: summary.total, agree: summary.agree, mismatch: summary.mismatch, unreadable: summary.unreadable,
    perFamily: summary.perFamily, mismatches: summary.mismatches }, phase1 };
  // Completeness evidence for the history query: a record with no `scan` can never score a clean day.
  if (scan) rec.findings.scan = { limit: scan.limit, listed: scan.listed, truncated: scan.truncated !== false }; // anything but an explicit `false` is recorded truncated
  rec.verdict = summary.mismatch || summary.unreadable ? 'drift' : 'clean';
  return rec;
}

/** Append the run record. Never throws: a failed record write is reported, not fatal to a report-only checker. */
export function appendCheckRun({ repo, summary, phase1, scan, at = new Date().toISOString(), write = writeRun, mintId = newRunId }) {
  try {
    const record = buildCheckRunRecord({ id: mintId('review-ledger-check'), repo, at, summary, phase1, scan });
    return { ok: true, id: record.id, path: write(record) };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/** Build the derived rows for the open PRs. `readFacts` is injectable; CLI default is the live reader. */
export function buildDerivedRows({ repo, prs, events, readFacts = readPrFacts, settings = {} }) {
  return prs.filter((p) => Number.isInteger(p?.number)).sort((a, b) => a.number - b.number).map((p) => {
    let facts = null;
    try { facts = readFacts(p.number); } catch { facts = null; }
    return deriveRow({ pr: p.number, repo, events, facts, liveLabels: names(p.labels), settings });
  });
}

function parseFlags(argv) {
  const flags = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq === -1) flags[a.slice(2)] = true;
    else flags[a.slice(2, eq)] = a.slice(eq + 1);
  }
  return flags;
}

/** One store snapshot supplies both comparisons. An unreadable ledger produces no score or run record. */
export async function runCheck({
  repo = DEFAULT_REPO, store, limit = 200, json = false, showAll = false, noRecord = false,
  readEvents = readLedgerEventsFromStore, listPrs = readOpenPrs,
  readFacts = repo === DEFAULT_REPO ? undefined : () => null, appendRun = appendCheckRun,
  stdout = (text) => writeAllSync(1, text), stderr = (text) => process.stderr.write(text),
} = {}) {
  const ledger = await readEvents(repo, { store });
  if (ledger.status !== 'ok') {
    const report = { repo, store: ledger.store, status: 'unreadable', reason: ledger.reason, error: ledger.error };
    stderr(`review-ledger-check: ledger store ${ledger.store.name} unreadable (${ledger.reason}): ${ledger.error} - nothing scored\n`);
    if (json) stdout(`${JSON.stringify(report, null, 2)}\n`);
    return { ...report, exitCode: 2 };
  }
  let prs;
  try {
    prs = await listPrs({ repo, limit });
  } catch (e) {
    stderr(`review-ledger-check: gh pr list failed — ${String((e && (e.stderr || e.message)) || e).split('\n').filter(Boolean).pop()}\n`);
    return { exitCode: 2 };
  }
  const events = ledger.rows;
  const verdicts = events.filter((r) => r.type === 'verdict').map(({ type: _type, ...record }) => record);
  const rows = buildRows({ prs, folded: foldVerdictLedger(verdicts) });
  const summary = summarizeAgreement(rows);
  const derivedRows = buildDerivedRows({ repo, prs, events, readFacts });
  const derived = summarizeDerived(derivedRows);
  // A list as long as the limit may have been cut off, so it is recorded as truncated (never trusted as complete).
  const scan = { limit, listed: prs.length, truncated: prs.length >= limit };
  const run = noRecord ? { ok: false, skipped: true } : await appendRun({ repo, summary: derived, scan, phase1: { total: summary.total, counts: summary.counts, phase2Safe: summary.phase2Safe } });
  const report = { repo, store: ledger.store, ledgerRows: events.length, rows, summary, derived: { ...derived, rows: derivedRows }, run };
  if (json) {
    stdout(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    stdout(`${renderReport({ repo, rows, summary, store: ledger.store, showAll })}${renderDerived(derived)}\n`);
    if (!run.ok && !run.skipped) stderr(`review-ledger-check: run record not written — ${run.error}\n`);
  }
  return { ...report, exitCode: summary.dangerous.length ? 1 : 0 };
}

/**
 * Check every repo in turn (#3930: the constellation, not just WE). Each repo is its own `runCheck`, so each
 * appends its own run record. Exit code is the worst of the runs. With `json`, the per-repo reports are printed
 * as ONE document `{ repos: [...] }`, never as concatenated JSON.
 */
export async function runAllRepos({ repos = DEFAULT_REPOS, json = false, stdout = (text) => writeAllSync(1, text), run = runCheck, ...rest } = {}) {
  const reports = [];
  let exitCode = 0;
  for (const repo of repos) {
    let captured = '';
    const result = await run({ ...rest, repo, json, stdout: json ? (t) => { captured += t; } : stdout });
    if (!json) stdout('\n');
    reports.push(json ? (captured.trim() ? JSON.parse(captured) : { repo, exitCode: result.exitCode }) : { repo, exitCode: result.exitCode });
    exitCode = Math.max(exitCode, result.exitCode ?? 2);
  }
  if (json) stdout(`${JSON.stringify({ repos: reports }, null, 2)}\n`);
  return { repos: reports, exitCode };
}

/**
 * THE #3930 QUERY: read the run history and report clean days per label family. No `gh` call. Exit 0 only when
 * every family that has ever been checked is `ready`; no history at all is not ready.
 */
export function runHistory({ repos = DEFAULT_REPOS, days = REQUIRED_CLEAN_DAYS, json = false, now = new Date(), read = readCheckRuns,
  stdout = (text) => writeAllSync(1, text) } = {}) {
  const { runs, corrupt } = read();
  // The family set is pinned, so a family absent from the records is unknown (streak 0), never silently omitted.
  const query = cleanDaysPerFamily(runs, { repos, now, windowDays: days, families: LABEL_FAMILIES.map((f) => f.family) });
  const fams = Object.values(query.families);
  // "Ready" means across ALL constellation repos: a narrowed --repos answers the question for a subset only.
  const have = new Set(repos.map((r) => r.toLowerCase()));
  const partialScope = !DEFAULT_REPOS.every((r) => have.has(r.toLowerCase()));
  const ready = !partialScope && fams.length > 0 && fams.every((f) => f.ready);
  if (partialScope) { // a subset's per-family READY is not the global answer either: keep it as `subsetReady` only
    for (const f of fams) { f.subsetReady = f.ready; f.ready = false; }
  }
  const verdictLine = ready ? 'ALL FAMILIES READY' : partialScope ? 'NOT READY — partial scope: --repos omits constellation repos, so this is not the readiness answer' : 'NOT READY';
  if (json) stdout(`${JSON.stringify({ ...query, runCount: runs.length, corrupt, partialScope, ready }, null, 2)}\n`);
  else stdout(`${renderCleanDays(query, { corrupt, runCount: runs.length })}\n${verdictLine}\n`);
  return { ...query, runCount: runs.length, corrupt, partialScope, ready, exitCode: ready ? 0 : 1 };
}

async function main(argv) {
  const flags = parseFlags(argv);
  const json = !!flags.json;
  const listFlag = (v) => String(v).split(',').map((x) => x.trim()).filter(Boolean);
  if (flags.history) {
    const repos = typeof flags.repos === 'string' ? listFlag(flags.repos) : DEFAULT_REPOS;
    if (!repos.length || !repos.every((r) => REPO_RE.test(r))) {
      process.stderr.write('review-ledger-check: --repos must be a comma list of <owner/name>\n');
      return 2;
    }
    const days = Number.isInteger(Number(flags.days)) && Number(flags.days) > 0 ? Math.min(Number(flags.days), MAX_HISTORY_DAYS) : REQUIRED_CLEAN_DAYS;
    return runHistory({ repos, days, json }).exitCode;
  }
  const limit = Number.isInteger(Number(flags.limit)) && Number(flags.limit) > 0 ? Number(flags.limit) : 200;
  const common = { store: flags.store, limit, json, showAll: flags.all === true, noRecord: flags['no-record'] === true };
  if (typeof flags.repo !== 'string' || !flags.repo) return (await runAllRepos({ ...common })).exitCode;
  const repo = flags.repo;
  if (!REPO_RE.test(repo)) {
    process.stderr.write('review-ledger-check: --repo must be <owner/name>\n');
    return 2;
  }
  const result = await runCheck({ repo, ...common });
  return result.exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.exitCode = await main(process.argv.slice(2));
}
