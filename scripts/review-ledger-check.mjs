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
 *   2 — usage / `gh` failure.
 *
 * Usage:
 *   node scripts/review-ledger-check.mjs [--repo=<owner/name>] [--json] [--all] [--limit=<n>]
 *   `--all` includes PRs that agree; the default output lists only what needs attention plus the summary.
 */

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
  AGREEMENT, DISAGREE_DIRECTION, compareLedgerToLabels, foldRepo, labelVerdictOf, summarizeAgreement,
  verdictLedgerPath,
} from './lib/verdict-ledger.mjs';
import { writeAllSync } from './lib/write-all-sync.mjs';

const DEFAULT_REPO = 'web-everything/web-everything';
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
  const parsed = JSON.parse(String(out || '[]'));
  return Array.isArray(parsed) ? parsed : [];
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
export function renderReport({ repo, rows, summary, path, showAll = false }) {
  const lines = [];
  lines.push(`#3007 Phase 1 — verdict ledger vs review labels · ${repo}`);
  lines.push(`ledger: ${path}`);
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

function main(argv) {
  const flags = parseFlags(argv);
  const repo = typeof flags.repo === 'string' && flags.repo ? flags.repo : DEFAULT_REPO;
  if (!REPO_RE.test(repo)) {
    process.stderr.write('review-ledger-check: --repo must be <owner/name>\n');
    process.exit(2);
  }
  const limit = Number.isInteger(Number(flags.limit)) && Number(flags.limit) > 0 ? Number(flags.limit) : 200;

  let prs;
  try {
    prs = readOpenPrs({ repo, limit });
  } catch (e) {
    process.stderr.write(`review-ledger-check: gh pr list failed — ${String((e && (e.stderr || e.message)) || e).split('\n').filter(Boolean).pop()}\n`);
    process.exit(2);
  }

  const folded = foldRepo(repo);
  const rows = buildRows({ prs, folded });
  const summary = summarizeAgreement(rows);
  const path = verdictLedgerPath(repo);

  if (flags.json) {
    writeAllSync(1, `${JSON.stringify({ repo, path, rows, summary }, null, 2)}\n`);
  } else {
    writeAllSync(1, `${renderReport({ repo, rows, summary, path, showAll: flags.all === true })}\n`);
  }
  process.exit(summary.dangerous.length ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2));
}
