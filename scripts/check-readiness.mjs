#!/usr/bin/env node
/**
 * check-readiness.mjs — the deterministic backlog-readiness CLI (backlog #250).
 *
 * Mirrors the conformance auto-fix CLI (#095) one domain over, but with a strictly DETERMINISTIC
 * core: it never authors content. It reports the dependency-graph cascade (which open items just
 * became agent-ready because their `blockedBy` prerequisites are all resolved) and pure structural
 * normalization findings — and, only with `--apply`, performs the one mechanical, reversible edit:
 * dropping stale (already-resolved) `blockedBy` edges via a frontmatter splice. Bodies are never
 * touched, and Tier C (`decision`) items are left alone.
 *
 * The cascade + readiness derivations come straight from the shared loader (`src/_data/backlog.js`,
 * via #248/#249) — we reuse its `tier`/`blockers`, we do not recompute the rubric.
 *
 * Usage:
 *   node scripts/check-readiness.mjs            # dry-run (default): print cascade + normalization, write nothing
 *   node scripts/check-readiness.mjs --apply    # also drop stale blockedBy edges (frontmatter splice)
 *   node scripts/check-readiness.mjs --json     # machine-readable report on stdout
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { computeReadiness, computeSelection, projectSelectionItem, computeBatchPack, buildReadinessReport, spliceStaleEdges } from './readiness/engine.mjs';
import { parseReservations, emptyState, foreignHolds, deprioritizeReserved } from './readiness/reservations.mjs';
import { parseHolds, emptyHoldState, heldNums } from './readiness/prepare-hold-state.mjs';
import { LOCI } from './check-standards-rules.mjs';
import { checkMainStaleness } from './lib/main-staleness.mjs';
import { openPrsByItem } from './lib/open-pr-items.mjs';
import { slugFromName } from './backlog/id.mjs';
import { writeLineSync } from './lib/write-all-sync.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const loadBacklog = require(join(ROOT, 'src/_data/backlog.js')); // the SINGLE loader (#248/#249 derivations)

// Calibrated session capacity for points-budgeted batches (.claude/skills/batch-backlog-items/
// capacity.json, kept current by `backlog.mjs calibrate` at close-out). Since #1505 the budget is the
// affine model's `budgetPoints` (the largest points-load that fits under a context ceiling minus a
// data-driven margin), computed at calibrate time and stored. Back-compat: an older file with only
// `capacityPoints × targetFraction` is read that way; missing/unreadable → a conservative built-in
// default so the CLI still runs.
const CAPACITY_PATH = join(ROOT, '.claude/skills/batch-backlog-items/capacity.json');
function loadCapacity() {
  try {
    const c = JSON.parse(readFileSync(CAPACITY_PATH, 'utf8'));
    if (Number.isFinite(c.budgetPoints)) return { budget: c.budgetPoints, capacityPoints: c.capacityPoints ?? null };
    const capacityPoints = c.capacityPoints ?? 100, targetFraction = c.targetFraction ?? 0.5;
    return { budget: Math.round(capacityPoints * targetFraction), capacityPoints };
  } catch { return { budget: 50, capacityPoints: 100 }; }
}

// Cross-session batch reservations (#083 selection-tier soft hint). A batch soft-holds the items it
// PLANS (backlog.mjs reserve); here we DEPRIORITIZE — never exclude — items held by ANOTHER session so
// a second concurrent batch packs around them. Pass `--session=<my-slug>` so a batch's OWN top-up
// `--select` doesn't deprioritize its own chain. Time-dependent (TTL) + session-aware, so it lives at
// this CLI boundary, NEVER inside the byte-deterministic `computeSelection` core.
const RESERVATIONS_PATH = join(ROOT, '.claude/skills/batch-backlog-items/reservations.json');
function loadReservations() {
  try { return parseReservations(readFileSync(RESERVATIONS_PATH, 'utf8')); }
  catch { return emptyState(); }
}

// Prepare-hold HARD exclusion (#2219 (b) flow / #2264). Unlike a soft reservation (deprioritize), a prepare-
// held item is being prepared in a lane and is EXCLUDED from every selection surface — it must not be offered
// or packed while its hold is live. Lease/time-dependent, so — like reservations — it lives at this CLI
// boundary, never inside the byte-deterministic `computeSelection` core. Read the local token offline (#105).
const PREPARE_HOLD_PATH = join(ROOT, '.claude/skills/batch-backlog-items/prepare-hold.json');
function loadHolds() {
  try { return parseHolds(readFileSync(PREPARE_HOLD_PATH, 'utf8')); }
  catch { return emptyHoldState(); }
}
const MY_SESSION = (() => {
  const m = process.argv.find((a) => a.startsWith('--session='));
  return m ? m.slice('--session='.length) : undefined;
})();

const APPLY = process.argv.includes('--apply');
const JSON_MODE = process.argv.includes('--json');
const SELECT = process.argv.includes('--select');
// --budget=<P> overrides the calibrated budget. Two uses: `/batch <P>` (a one-off budget), and the
// mid-batch SEAM top-up — pass the REMAINING budget (full budget − cost already resolved) so the
// re-pack fills only what's left, absorbing any items the just-resolved work cascade-freed to Tier A.
const BUDGET_OVERRIDE = (() => {
  const m = process.argv.find((a) => a.startsWith('--budget='));
  const n = m ? Number(m.slice('--budget='.length)) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
})();

const RED = '\x1b[31m', YEL = '\x1b[33m', GRN = '\x1b[32m', DIM = '\x1b[2m', CYA = '\x1b[36m', BLD = '\x1b[1m', RST = '\x1b[0m';

// #2204 — fetch-first staleness guard: the ranker picks/orders against local backlog files, so a local `main`
// behind `origin/main` ranks against WRONG item state (missing/resolved-looking/clobbered-looking ids). Fetch
// first and autostash-fast-forward any non-diverged tree (dirty or clean, so the load below reads fresh) or
// warn loudly. Fail-soft: offline → silent skip; a diverged tree (or a failed ff) is warned about, never
// touched. `--no-fetch` opts out (CI/tests).
//
// A residual warning means the tree is still STALE (diverged, or the autostash-ff failed). For a passive read
// view that is only a warning, but `--select`/`--json` are *decision surfaces* a batch packs from — ranking a
// stale tree is exactly the mis-pick this guard exists to stop — so there we HARD-STOP (non-zero) unless the
// caller explicitly opted out of the fetch. `--allow-stale` forces past it (escape hatch for a known-offline
// or deliberately-diverged run).
if (!process.argv.includes('--no-fetch')) {
  const st = checkMainStaleness({ autoFf: true });
  if (st.warning) {
    console.error(`${YEL}${BLD}⚠ ${st.warning}${RST}`);
    if ((SELECT || JSON_MODE) && !process.argv.includes('--allow-stale')) {
      console.error(`${RED}${BLD}✗ refusing to rank/select against a stale tree — sync then retry, or pass --allow-stale to override.${RST}`);
      process.exit(3);
    }
  } else if (st.synced) console.error(`${DIM}· fetched — local main fast-forwarded ${st.behind} commit(s) to origin/main before ranking${RST}`);
}

const items = typeof loadBacklog === 'function' ? loadBacklog() : loadBacklog;
const report = computeReadiness(items);
const selection = computeSelection(items); // the deterministic ranked view (same source as the Prioritisation tab)

// HAS-PREDICTED-SCOPE readiness lens (#2618) — the OPEN, unblocked, agent-ready (Tier-A) BUILD items that
// carry NO predicted `scope:` (loader `unshapedNoScope`). This mirrors the conveyor dispatcher's exact
// `unshaped-no-scope` / needs-probe hold (scripts/readiness/dispatch-plan.mjs): such an item reads as
// dev-ready but is NOT fully shaped, so the conveyor NEVER launches it blind — it auto-prepares its `scope:`
// upstream before it can build. Surfaced as a note (not a hard gate): the item stays agent-ready, it just
// isn't dispatchable-in-parallel until its touch-set is authored.
const unshaped = items.filter((it) => it.unshapedNoScope);
// Shared printer for the unshaped-scope note, reused by both the --select view and the default human report.
function printUnshapedScopeNote() {
  if (!unshaped.length) return;
  console.log(`\n${YEL}${BLD}Unshaped — agent-ready but missing predicted \`scope:\` (#2618): reads as dev-ready but isn't fully shaped; the conveyor auto-prepares its scope before it can build (never dispatched blind)${RST}`);
  unshaped.forEach((it) => console.log(`  ${YEL}▽${RST} #${it.num} ${slugFromName(it.id)} ${DIM}— no predicted scope; add a \`scope:\` touch-set to parallelize it${RST}`));
}

// Apply the prepare-hold HARD exclusion: drop every live-held item from the selection surfaces so a held item
// is neither offered (--select) nor packed (batch). Excluded, not deprioritized — the strengthened #2219 (b)
// replacement for the soft `reserve`. `computeSelection` stays the pure projection; only this CLI view removes.
const heldSet = new Set(heldNums(loadHolds(), Date.now()));
const dropHeld = (list) => (list || []).filter((it) => !heldSet.has(String(it.num).padStart(3, '0')));
if (heldSet.size) {
  selection.tierA = dropHeld(selection.tierA);
  selection.batchable = dropHeld(selection.batchable);
  selection.sliceable = dropHeld(selection.sliceable);
  selection.tierB = dropHeld(selection.tierB);
  selection.filler = dropHeld(selection.filler);
}

// Active-PR HARD exclusion: an item with an OPEN pull request is producer-complete (its lane resolved it and
// is waiting on the drain to land) — offering it re-hands a batch work that is already done, often already
// merged+closed by the time a human looks (this session's mis-pack). So drop every open-PR item from the
// selection surfaces, exactly like `dropHeld`. Fail-soft + boundary-only (needs `gh` + network, so it lives
// here, never in the byte-deterministic `computeSelection`): no gh/offline → skip silently. `--no-pr-scan`
// opts out (CI/tests / a deliberately PR-blind run); skipped under `--no-fetch` (that flag = "no network").
// IN-REVIEW decisions (the Decision Docket): the open-PR exclusion below drops a decision whose ratification /
// preparation PR is open from `selection.tierB`, and a BLOCKED decision (tier C) was never in it — but those are
// exactly the decisions the operator wants LISTED, marked as in review, not silently absent. The scan already holds
// each PR's identity, so the same `gh` read also fills `inReview` (every open decision, tier B or C, with an open PR,
// carrying its PRs) — the docket adds no second network call. `WE_OPEN_PRS_FILE=<path>` (a `gh pr list --json
// headRefName,title,number,url` array) stands in for `gh` so a test/fixture run is offline, like `WE_BACKLOG_DIR`.
const inReview = [];
const prScanFile = process.env.WE_OPEN_PRS_FILE;
if (!process.argv.includes('--no-pr-scan') && (prScanFile || !process.argv.includes('--no-fetch'))) {
  const pr = openPrsByItem(prScanFile
    ? { run: () => ({ status: 0, stdout: readFileSync(prScanFile, 'utf8'), stderr: '' }), repos: ['web-everything/web-everything'] }
    : undefined);
  const prSet = new Set(pr.nums);
  if (prSet.size) {
    const dropPr = (list) => (list || []).filter((it) => !prSet.has(String(it.num).padStart(3, '0')));
    selection.tierA = dropPr(selection.tierA);
    selection.batchable = dropPr(selection.batchable);
    selection.sliceable = dropPr(selection.sliceable);
    selection.tierB = dropPr(selection.tierB);
    selection.filler = dropPr(selection.filler);
    console.error(`${DIM}· excluded ${prSet.size} item(s) with an open PR from selection: ${[...prSet].map((n) => '#' + n).join(', ')}${RST}`);
    for (const it of items) {
      const prs = pr.byItem[String(it.num).padStart(3, '0')];
      if (it.status !== 'open' || it.kind !== 'decision' || !prs) continue;
      inReview.push({
        ...projectSelectionItem(it),
        blockedBy: (it.blockers || []).filter((b) => b.status !== 'resolved').map((b) => String(b.num)),
        prs,
      });
    }
    inReview.sort((a, b) => Number(a.num) - Number(b.num));
  } else if (pr.unavailable) {
    console.error(`${DIM}· open-PR exclusion skipped (${pr.reason}) — pass --no-pr-scan to silence${RST}`);
  }
}

const capacity = loadCapacity();
const budget = BUDGET_OVERRIDE ?? capacity.budget;

// Apply the soft-reservation penalty AFTER the deterministic ranking: foreign-held items sink to the
// back so the pack fills with un-held items first (deprioritize, not exclude). `selection.*` stays the
// pure projection; only the pack + displayed order reflect reservations.
const reservations = loadReservations();
const foreign = foreignHolds(reservations, Date.now(), MY_SESSION);
const tierAforPack = deprioritizeReserved(selection.tierA, foreign);
const batchableForView = deprioritizeReserved(selection.batchable, foreign);
const batchPack = computeBatchPack(tierAforPack, budget); // the suggested points-budgeted batch (reservation-aware, locus-agnostic — each item gated in its own locus)

// ── --apply: the only mechanical edit — drop stale (resolved) blockedBy edges ────
const applied = [];
const gaveUp = [];
if (APPLY) {
  for (const f of report.normalization.filter((n) => n.kind === 'stale-edge')) {
    const abs = join(ROOT, f.file);
    const before = readFileSync(abs, 'utf8');
    const after = spliceStaleEdges(before, f.staleBlockers);
    if (after === null || after === before) {
      gaveUp.push({ ...f, reason: 'could not safely splice (no flow-style blockedBy line / nothing to drop)' });
      continue;
    }
    writeFileSync(abs, after);
    applied.push(f);
  }
}

if (JSON_MODE) {
  const reservationsOut = {
    ttlMinutes: reservations.ttlMinutes,
    mySession: MY_SESSION ?? null,
    foreign: [...foreign.entries()].map(([num, session]) => ({ num, session })),
  };
  writeLineSync(1, JSON.stringify({ ...report, selection, inReview, batch: { capacity, budget, ...batchPack }, report: buildReadinessReport(selection, batchPack, budget), unshaped: unshaped.map((it) => ({ num: it.num, id: it.id })), reservations: reservationsOut, applied: APPLY ? applied : undefined, gaveUp: APPLY ? gaveUp : undefined }, null, 2));
  process.exit(0);
}

// ── --select: the deterministic selection view (skills' step 1; instant, zero desync with the tab) ──
if (SELECT) {
  const eff = (it) => `${it.kind}${typeof it.size === 'number' ? '·' + it.size : ''}`;
  const lev = (it) => (it.leverageScore ? `${DIM}frees ${it.unblocksToReady}·gates ${it.transitiveUnblocks}${RST}` : '');
  // A foreign-held item carries `reservedBy` (deprioritize, not exclude — #083): tag it so the human
  // sees it was sunk because another session planned it, not skipped.
  const resv = (it) => (it.reservedBy ? ` ${YEL}⊘ held by ${it.reservedBy}${RST}` : '');
  const line = (it, mark) => console.log(`  ${mark} #${it.num} ${slugFromName(it.id)} ${DIM}—${RST} ${eff(it)} ${lev(it)}${resv(it)}`);

  console.log(`${DIM}check:readiness --select — deterministic ranking (same source as /backlog/ Prioritisation tab)${RST}`);
  const c = selection.counts;
  console.log(`${BLD}${c.open} open${RST} · ${GRN}${c.agentReady} agent-ready${RST} (${CYA}${c.batchable} batchable${RST})${c.sliceable ? ` · ${CYA}${c.sliceable} epics${RST}${DIM} (${c.epicActionable} need action)${RST}` : ''} · ${YEL}${c.tierB} Tier B (decisions${c.tierBPrepared ? `, ${GRN}${c.tierBPrepared} prepared${YEL}` : ''})${RST} · ${DIM}${c.tierC} Tier C${RST}${c.inFlight ? ` · ${DIM}${c.inFlight} in flight${RST}` : ''}\n`);

  if (foreign.size) console.log(`${DIM}${foreign.size} item(s) soft-held by another session${MY_SESSION ? ` (yours: ${MY_SESSION}, not penalized)` : ''} — deprioritized below, not excluded (#083).${RST}`);
  if (heldSet.size) console.log(`${DIM}${heldSet.size} item(s) prepare-held (#2219 (b)) — HARD-excluded from the pool below (a session is preparing them in a lane); the drain-free hold clears on \`backlog.mjs prepare-release\`.${RST}`);
  // Legible-stop (#083): when the pool is thin/empty but items are in flight elsewhere, say so — a
  // batch's "no eligible Tier-A left" stop then reads as "drained by a concurrent session, re-run
  // shortly," not "backlog empty." Derived live from `status: active`, so it's never a stale signal.
  if (selection.inFlight.length) console.log(`${DIM}${selection.inFlight.length} batch-shaped item(s) in flight (${YEL}status: active${RST}${DIM} — likely another session); if the pool below is thin, that pool is drained, not empty — re-run after they resolve (#083).${RST}`);

  // Stop-the-world guard (#466/#487): an open item tagged `stop-the-world` bulk-rewrites every
  // backlog/*.md and must run on a QUIESCENT backlog — claiming it while another session holds a
  // status:active claim or a live reservation risks a file-level collision between its bulk rewrite and
  // a concurrent claim/resolve splice. Warn (never block) so nobody picks it up mid-collision; the
  // backlog is quiescent only when no foreign claim is in flight AND no reservation is held.
  const stopTheWorld = items.filter((it) => it.status === 'open' && Array.isArray(it.tags) && it.tags.includes('stop-the-world'));
  if (stopTheWorld.length) {
    const quiescent = selection.inFlight.length === 0 && foreign.size === 0;
    const names = stopTheWorld.map((it) => `#${it.num}`).join(', ');
    if (quiescent) console.log(`${GRN}✓ backlog quiescent — stop-the-world item(s) ${names} are safe to claim (no active claims, no reservations).${RST}`);
    else console.log(`${YEL}${BLD}⚠ stop-the-world item(s) ${names} present but the backlog is NOT quiescent${RST}${YEL} — ${selection.inFlight.length} active claim(s) + ${foreign.size} reservation(s) in flight. Don't claim a stop-the-world migration now; wait for the backlog to drain (its own run-precondition).${RST}`);
  }
  console.log(`${CYA}${BLD}Batchable — Tier-A task or story·≤8 (the batch pool) — pre-flight each body for a buried fork before chaining${RST}`);
  if (batchableForView.length) batchableForView.forEach((it) => line(it, it.reservedBy ? `${YEL}⊘${RST}` : `${CYA}◆${RST}`));
  else console.log(`${DIM}  none.${RST}`);

  // The suggested points-budgeted batch — "take as many points as possible up to the calibrated budget,"
  // not a fixed item count. Budget = the affine model's budgetPoints (calibrated at close-out, #1505);
  // cost sums each item's batchCost (size; a task = 2), so a size·8 joins when it fits the remaining points.
  const budgetSrc = BUDGET_OVERRIDE !== undefined ? `override; remaining at a seam` : `affine budget; capacity ≈ ${capacity.capacityPoints ?? '?'}`;
  console.log(`\n${CYA}${BLD}Suggested batch — points budget ${budget}${RST} ${DIM}(${budgetSrc}; cost = size, task = 2)${RST}`);
  if (batchPack.picked.length) {
    let run = 0;
    const lociInPack = new Set();
    batchPack.picked.forEach((it) => {
      run += it.batchCost;
      const lc = it.locus ?? 'webeverything';
      if (lc !== 'webeverything') lociInPack.add(lc);
      // Repo-LOCUS (#498/#500): the pack is locus-agnostic; flag each cross-repo item with its gate home so
      // close-out runs THAT locus's gate (LOCI registry), never this repo's by default. WE items stay unmarked.
      const locusTag = lc !== 'webeverything' ? ` · ${YEL}⌂ ${lc}${RST}${DIM}` : '';
      console.log(`  ${CYA}＋${RST} #${it.num} ${slugFromName(it.id)} ${DIM}— ${eff(it)} · cost ${it.batchCost} · running ${run}/${budget}${locusTag}${RST}`);
    });
    console.log(`  ${DIM}= ${batchPack.spent}/${budget} pts packed across ${batchPack.picked.length} item(s). Pre-flight each body for a buried fork; the count is whatever fills the budget.${RST}`);
    // Per-locus gate legend — for each cross-repo locus in the pack, show the gate the loop must run to
    // honestly close its items (and where), so a cross-locus batch is self-documenting at the seam.
    if (lociInPack.size) {
      console.log(`  ${DIM}Cross-locus pack — close each ⌂ item with its own gate:${RST}`);
      [...lociInPack].sort().forEach((lc) => {
        const reg = LOCI[lc];
        console.log(`    ${YEL}⌂ ${lc}${RST} ${DIM}→ \`${reg.gateCommand}\` in ${reg.repoPath}${reg.closeoutDiscipline ? ` · ${reg.closeoutDiscipline}` : ''} (commit → ${reg.commitTarget})${RST}`);
      });
    }
  } else console.log(`${DIM}  none eligible — no Tier-A item fits the budget${selection.inFlight.length ? `; ${selection.inFlight.length} batch-shaped item(s) are in flight (status: active) — pool likely drained by a concurrent session, re-run shortly (#083)` : ''}.${RST}`);

  // Tier-A non-batchable splits two ways: buildable-but-large (story·≥13 / unsized story) an agent can
  // still implement, versus epics — unblocked but only ready to SLICE (work lives in child slices, not
  // the epic). Keep them in separate sections so an epic never reads as a buildable to-do (#double-count).
  const restA = tierAforPack.filter((it) => !it.batchable && it.kind !== 'epic');
  const sliceA = tierAforPack.filter((it) => it.kind === 'epic');
  console.log(`\n${GRN}${BLD}Other Tier-A — agent-ready, single-item (story·≥13 / unsized)${RST}`);
  if (restA.length) restA.forEach((it) => line(it, it.reservedBy ? `${YEL}⊘${RST}` : `${GRN}▲${RST}`));
  else console.log(`${DIM}  none.${RST}`);

  // Epics split by what they actually need: unsliced (→ /slice) and all-children-done (→ resolve) are
  // ACTIONABLE; the rest just track open children (no epic-level action — their work is those children,
  // already in the pool above). Listing them apart stops a passive rollup reading as a buildable to-do.
  const epicAction = sliceA.filter((it) => it.epicState === 'unsliced' || it.epicState === 'done');
  // No epic-level action: 'tracking' (open children) or 'parked' (a childlessReason gates decomposition —
  // blocked / undecided / untriaged / program). Listed compactly so a parked/tracking epic never reads
  // as a slice to-do; a parked one shows its recorded reason (that reason IS its blocker).
  const epicNoAction = sliceA.filter((it) => it.epicState === 'tracking' || it.epicState === 'parked');
  const epicTag = (it) => it.epicState === 'unsliced' ? `${CYA}slice${RST}` : `${GRN}resolve${RST}`;
  console.log(`\n${CYA}${BLD}Epics needing action — /slice the unsliced (no reason yet), resolve those whose children are all done${RST}`);
  if (epicAction.length) epicAction.forEach((it) => line(it, it.reservedBy ? `${YEL}⊘${RST}` : `${CYA}▣ ${epicTag(it)}`));
  else console.log(`${DIM}  none.${RST}`);
  if (epicNoAction.length) console.log(`${DIM}  + ${epicNoAction.length} epic(s) no action — ${epicNoAction.map((it) => '#' + it.num + (it.epicState === 'parked' ? `(parked: ${it.childlessReason || 'no reason'})` : '')).join(', ')}${RST}`);

  // In flight — only shown when non-empty (keeps the common single-session run unchanged). These are
  // batch-shaped items a sibling session has `claim`ed (status:active); they're excluded from the pool
  // above but listed here so a drained pool is legibly "in flight elsewhere," not "nothing to do."
  if (selection.inFlight.length) {
    console.log(`\n${DIM}${BLD}In flight — batch-shaped items being worked elsewhere (status: active)${RST}`);
    selection.inFlight.forEach((it) => console.log(`  ${YEL}▶${RST} #${it.num} ${slugFromName(it.id)} ${DIM}— ${eff(it)}${RST}`));
  }

  console.log(`\n${YEL}${BLD}Tier B — decisions (prepared-first, then by leverage; discuss, don't auto-build)${RST}`);
  if (selection.tierB.length) selection.tierB.forEach((it) => {
    const tag = it.prepared ? `${GRN}✓ ready to ratify${RST}` : `${DIM}○ needs prep${RST}`;
    console.log(`  ${YEL}◐${RST} #${it.num} ${slugFromName(it.id)} ${DIM}—${RST} ${eff(it)} ${tag} ${lev(it)}`);
  });
  else console.log(`${DIM}  none.${RST}`);

  // FILLER (#1620) — `priority: low` items: settled & valid Tier-A work demoted OUT of the auto-selected
  // ready set (so it stops false-surfacing as agent-ready) but kept visible + hand-pickable here for when
  // nothing better exists. Demote-not-hide: it's "not now," never "rejected" and never a park.
  if (selection.filler && selection.filler.length) {
    console.log(`\n${DIM}${BLD}Filler — \`priority: low\` (not in the auto-pack; pick up when nothing better is open)${RST}`);
    selection.filler.forEach((it) => console.log(`  ${DIM}·${RST} #${it.num} ${slugFromName(it.id)} ${DIM}— ${eff(it)}${RST}`));
  }

  // D3-READINESS (#608) — open builds the loader DEMOTED out of Tier A because their `relatedProject` is
  // a `concept` project with no shipped surface yet (the standard must exist first). Surfaced so the human
  // sees WHY they're held — it's not a `blockedBy` edge, so they'd otherwise look mysteriously absent.
  const pending = items.filter((it) => it.projectPending);
  if (pending.length) {
    console.log(`\n${YEL}${BLD}Held — project pending (D3-readiness): the relatedProject is \`concept\` with no shipped surface; the standard must exist first${RST}`);
    pending.forEach((it) => console.log(`  ${YEL}⊗${RST} #${it.num} ${slugFromName(it.id)} ${DIM}— relatedProject \`${it.relatedProject}\` (${it.relatedProjectStatus}); demoted to Tier C until the project ships${RST}`));
  }

  // HUMAN GATE (#1137) — open items demoted out of Tier A because their only residual is a human-only
  // action (credentialed deploy, agent-training feedback, account setup, a sign-off). Like project-pending
  // it's NOT a `blockedBy` edge — nothing in the backlog resolves it, a person acts — so it's surfaced here
  // rather than looking mysteriously absent. A human clears the gate (does the action, removes `humanGate`).
  const gated = items.filter((it) => it.status === 'open' && it.humanGate);
  if (gated.length) {
    console.log(`\n${YEL}${BLD}Held — awaiting a human action (not a \`blockedBy\` edge; an agent can't clear it): do the action, then remove \`humanGate\`${RST}`);
    gated.forEach((it) => {
      const g = it.humanGate || {};
      const kind = `${g.kind || '?'}${(g.kind && !it.humanGateKnownKind) ? ' (unknown kind)' : ''}`;
      console.log(`  ${YEL}⊗${RST} #${it.num} ${slugFromName(it.id)} ${DIM}— human-gate \`${kind}\`: ${g.what || 'no action recorded'}${RST}`);
    });
  }

  printUnshapedScopeNote();

  console.log(`\n${DIM}Ranking is a pure projection of loader fields (tier/batchable/leverage) — instant, identical to the tab, no rubric re-derived. Body-fork pre-flight (skill) is the only per-item judgment left.${RST}`);
  process.exit(0);
}

// ── Human report ─────────────────────────────────────────────────────────────
console.log(`${DIM}check:readiness — Web Everything (deterministic; ${APPLY ? 'apply' : 'dry-run'})${RST}`);

console.log(`\n${BLD}Cascade — agent-readiness${RST}`);
if (report.cascade.nowReady.length) {
  console.log(`${GRN}  ▲ now Tier A (all prerequisites resolved):${RST}`);
  for (const r of report.cascade.nowReady)
    console.log(`    ${r.id} ${DIM}— cleared #${r.clearedBlockers.join(', #')}${RST}`);
} else {
  console.log(`${DIM}  no items newly unblocked (no open item has a freshly-cleared prerequisite chain).${RST}`);
}
if (report.cascade.stillBlocked.length) {
  console.log(`${YEL}  ◌ still blocked:${RST}`);
  for (const r of report.cascade.stillBlocked)
    console.log(`    ${r.id} ${DIM}— waiting on ${r.openBlockers.map((b) => `#${b.num} (${b.status})`).join(', ')}${RST}`);
}

console.log(`\n${BLD}Structural normalization${RST}`);
if (!report.normalization.length) {
  console.log(`${GRN}  ✓ no structural hygiene findings.${RST}`);
} else {
  for (const n of report.normalization) {
    const tag = n.applicable ? `${CYA}[auto]${RST}` : `${DIM}[flag]${RST}`;
    const mark = APPLY && n.kind === 'stale-edge' && applied.some((a) => a.id === n.id)
      ? `${GRN}fixed${RST} ` : '';
    console.log(`  ${tag} ${mark}${n.id} ${DIM}— ${n.detail}${RST}`);
  }
}

printUnshapedScopeNote();

if (APPLY) {
  console.log(
    `\n${applied.length ? GRN : DIM}${applied.length} stale edge(s) dropped${RST}` +
    `${gaveUp.length ? `, ${YEL}${gaveUp.length} skipped${RST}` : ''}.`,
  );
  for (const g of gaveUp) console.log(`  ${YEL}skipped${RST} #${g.num} ${g.id} ${DIM}— ${g.reason}${RST}`);
} else {
  const autoCount = report.normalization.filter((n) => n.applicable).length;
  if (autoCount) console.log(`\n${DIM}Re-run with ${RST}--apply${DIM} to drop ${autoCount} stale edge(s). Flag-only findings need a human value.${RST}`);
}

process.exit(0);
