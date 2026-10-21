#!/usr/bin/env node
/**
 * @file scripts/conveyor/review-hold-reconcile.mjs
 * @description THE REVIEW-HOLD RECONCILE SWEEP (#x01u7az) — a one-time-and-ongoing cleanup pass for two
 *   contradictory/stray label states `we:scripts/review-set-label.mjs#decideSetLabel` now refuses to produce
 *   GOING FORWARD, but which already exist on open PRs from BEFORE the fix landed. A forward fix alone never
 *   touches a label that is already wrong; per the operator's own standing rule ("we always take failure as an
 *   opportunity to improve our product, never as a problem that needs manual intervention"), the cleanup is a
 *   mechanical pass, not a hand-run `gh pr edit`.
 *
 * TWO INDEPENDENT INVARIANTS, ONE SWEEP (they were both live on web-everything/web-everything on 2026-09-24, and both
 * are "a review:* label describing a state that no longer holds"):
 *
 *   1. AT MOST ONE review:* HOLD LABEL. `review:human` is itself a hold — a gate-self PR needs no `review:pending`
 *      on top of it to say "an independent review is owed"; the human hold already says that. Before this sweep's
 *      companion fix (`decideSetLabel`'s `rearm` branch), a mechanical re-arm of a `review:human` bounce added
 *      `review:pending` unconditionally, live on PR #2549 (`review:pending` added 2026-09-24T14:05:09Z by
 *      `we:scripts/conveyor/rearm-review.mjs`, on top of `review:human` set 01:32:17Z and never cleared — still
 *      both live on that PR as of this sweep's authoring). `planReviewHoldCleanup` drops the stray `review:pending`.
 *   2. `advisory:*` ONLY MEANS SOMETHING ON A `review:human` PR (`we:scripts/lib/advisory-labels.mjs`'s own
 *      header). Before this sweep's companion fix (`decideSetLabel`'s `clear-human` branch), clearing the human
 *      gate left a stamped `advisory:accepted`/`advisory:changes` behind with no `review:human` left for it to
 *      describe — live on PR #2578 (`advisory:accepted` stamped 13:29:54Z while `review:human`, `review:human`
 *      cleared 13:38:11Z, the advisory label never removed). `planReviewHoldCleanup` drops it.
 *
 * Pending+accepted also heals when the trusted accept names an older head; pending stays.
 *
 * A THIRD, HEALED — NOT MERELY DROPPED (#2766/#2767, 2026-09-26). `review:accepted` + `review:human` co-present
 * is not a stray LEFTOVER a blind label removal can safely clean up — `decideParkToHuman`'s own write-time fix
 * (`we:scripts/lib/review-escalation.mjs`) stops FUTURE occurrences, but an already-contradictory PR needs its
 * COMMENT HISTORY read first: #x9xqexm forbids an automated pass from ever deleting a GENUINE, currently-valid
 * human clearance, and a label-only read cannot tell one from a bare, superseded agent accept. So this sweep
 * re-reads metadata and complete comments for every cleanup candidate, and:
 *   - a genuine clearance of the LIVE head (`parseLatestHumanClearedSha` matches) → FLAG only, same as before;
 *   - no such clearance (the confirmed #2766/#2767 shape) → HEAL: `review:accepted` comes off, `review:human`
 *     stays, a durable comment explains why (`decideContradictoryVerdictHeal`/`buildContradictoryVerdictHealComment`).
 *   - a live read fails → SKIP with a diagnostic (never delete on unproven data).
 *
 * NOT A DUPLICATE of `we:scripts/conveyor/advisory-label-sweep.mjs` — that sweep drops an advisory label whose
 * REVIEWED HEAD has gone stale (the PR moved past what the advisory looked at); this one drops an advisory label
 * whose REVIEW:HUMAN GATE has gone stale (the PR is no longer gate-self at all, so no head comparison is even
 * meaningful). Both are real, disjoint conditions the SAME `advisory:*` pair can go stale under, and a PR could in
 * principle need either — running both mechanical passes on every tick (as `we:skills-src/conveyor/runner.mjs`
 * already does for the sibling sweep) is what makes them agree without a shared special case in either file.
 *
 * PURE-CORE / IO-SHELL, mirroring `advisory-label-sweep.mjs`'s own split: {@link planReviewHoldCleanup} takes
 * only a PR's `labels` and is fully unit-testable with no `gh`; {@link sweepReviewHoldLabels} is the IO shell,
 * with the PR list and the label provider injectable so the whole pass is testable without a real `gh` call too.
 *
 * The one label-add exception: a numbering-only head move proven by scripts/lib/numbering-carry.mjs carries
 * the existing acceptance, adding review:accepted and removing review:pending before the stale-accept heal.
 * The one comment edit: a numbering re-stamp record written over a hold before it is edited into an inert withdrawal
 * notice (on any PR, whatever its labels), so no acceptance reader honours it.
 * WHAT IT NEVER DOES: add any other label, or touch anything but the removals named above.
 * It never removes `review:human` itself (that is `clear-human`'s job, a deliberate
 * human/independent-agent act, never a sweep's), and it never adds `review:pending`/`review:changes` — a stray
 * label is dropped, never replaced with a guess at what it should have said instead.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  NUMBERING_RESTAMP_MARKER, listedNumberingRecords, numberingRestampSettled, numberingWithdrawalOwed, restampAfterNumbering,
  strandedNumberingRecords,
} from '../lib/numbering-carry.mjs';
import { readNetDiffAtHead } from '../merge-ai-prs.mjs';
import { computeClearanceCoverage, latestOperatorClearanceRecord } from '../lib/approval-binding.mjs';
import { assertMandatoryReferralsCleared } from '../review-set-label.mjs';
import { latestAcceptRecord, resolveAcceptCarryForward } from '../lib/accept-carry-forward.mjs';
import { createGhProvider } from '../lib/review-label-provider.mjs';
import {
  REVIEW_LABELS, hasReviewLabel, findContradictoryReviewVerdicts, decideContradictoryVerdictHeal,
  parseLatestHumanClearedSha,
} from '../lib/review-escalation.mjs';
import { ADVISORY_LABELS } from '../lib/advisory-labels.mjs';
import { writeAllSync, writeLineSync } from '../lib/write-all-sync.mjs';
import { LIST_COMMENTS_CAP, defaultListPrs, defaultReadPr } from './advisory-label-sweep.mjs';
import { readCompletePrComments } from './pr-comments-complete.mjs';
import { sweepAutoBlock } from './referral-auto-block.mjs';
import { readPrsFromFile } from './open-pr-fetch.mjs';
import { sweepAcceptCarry, defaultCloneDirFor } from './accept-carry-sweep.mjs';

/** Plain label names off a `gh --json labels` array (`[{name}]`) or a bare-string array. Pure. */
function labelNames(labels) {
  return (Array.isArray(labels) ? labels : [])
    .map((l) => (typeof l === 'string' ? l : l?.name))
    .filter((n) => typeof n === 'string' && n !== '');
}

/**
 * THE PURE DECISION: given a PR's OBSERVED `labels`, which labels are stray and must come off?
 * Both checks are independent and additive — a PR can trip either, both, or neither.
 * @param {{currentLabels?: Array<string|{name?: string}>}} o
 * @returns {{remove: string[]}}
 */
export function planReviewHoldCleanup({ currentLabels = [] } = {}) {
  const names = new Set(labelNames(currentLabels));
  const remove = [];
  // (1) at most one review:* hold — review:human already IS the hold; a live review:pending beside it is the
  // #2549 stray this sweep exists for.
  if (names.has(REVIEW_LABELS.human) && names.has(REVIEW_LABELS.pending)) {
    remove.push(REVIEW_LABELS.pending);
  }
  // (2) advisory:* only means something on a review:human PR — with review:human gone, drop whichever advisory
  // label (there is at most one live at a time by construction) is still riding along.
  if (!names.has(REVIEW_LABELS.human)) {
    if (names.has(ADVISORY_LABELS.ACCEPTED)) remove.push(ADVISORY_LABELS.ACCEPTED);
    if (names.has(ADVISORY_LABELS.CHANGES)) remove.push(ADVISORY_LABELS.CHANGES);
  }
  // (3) FLAG (never auto-remove) a co-present review:accepted + review:human — the #2766/#2767 mutual-
  // exclusivity bug this sweep predates. `decideParkToHuman` (`we:scripts/lib/review-escalation.mjs`) now
  // prevents this pair going FORWARD at write time, but a PR already carrying it needs its comment history read
  // (was the `accepted` a GENUINE, currently-valid human clearance? #x9xqexm forbids an automated pass from
  // ever deleting one of those) before either label can be safely dropped — data this label-only sweep does
  // not have (`planReviewHoldCleanup` takes only `labels`, by design — see the file header). So this reports
  // the contradiction for a human/operator to resolve (e.g. via `review-set-label.mjs --to=clear-human` or
  // `--to=changes`), rather than guessing. Never included in `remove`.
  //
  // Checked on the label set AFTER point (1)'s own removal (never the raw observed set) — the `human` +
  // `pending` pair point (1) already resolves is NOT this bug (it is the #2549 stray a sanctioned `rearm` could
  // produce), and re-flagging it here would be this same sweep contradicting its own point (1) fix one line up.
  // #3657 preserves review:changes under a live human hold: exclude that designed send-back from the flag
  // input only. Accepted+human still needs the same history check; no additional label is removed.
  const afterHoldCleanup = [...names].filter((n) => !remove.includes(n));
  const flagInput = names.has(REVIEW_LABELS.human)
    ? afterHoldCleanup.filter((n) => n !== REVIEW_LABELS.changes) : afterHoldCleanup;
  const flagged = findContradictoryReviewVerdicts(flagInput);
  return flagged.length ? { remove, flagged } : { remove };
}

/** True when the PR carries a label combination {@link planReviewHoldCleanup} would act on OR flag — the only
 *  PRs this pass has any business fetching/looking at closely (a cheap pre-filter before the pure plan). */
export function needsReviewHoldCleanup(pr) {
  const plan = planReviewHoldCleanup({ currentLabels: pr?.labels });
  return plan.remove.length > 0 || !!plan.flagged?.length;
}

/**
 * Drop every stray review-hold / gate-scoped-advisory label off every open PR that carries one, and — for a
 * PR carrying the contradictory `review:accepted` + `review:human` pair (#2766/#2767) — either HEAL it
 * (`review:accepted` off, a comment explaining why, `review:human` untouched) or FLAG it, depending on what
 * that PR's own comment history proves. Snapshot labels only nominate candidates; fresh metadata
 * and a complete thread decide every removal, in dry-run as well as real execution.
 * @param {{repo?: string|null, listPrs?: Function, provider?: object, dryRun?: boolean}} [o]
 * @returns {Array<{num: number, remove?: string[], healed?: string[], commentPosted?: boolean,
 *   flagged?: string[], flagReason?: string, error?: string, skipped?: string}>} one entry per PR that
 *   needed (or would need) a change, was healed, or carries a contradiction this sweep could not resolve.
 */
/**
 * Listing views whose live read found no stranded numbering re-stamp record, each with the time it may be read again
 * (bounds the live reads). The bound is a time, not "forever": the listing shows neither the formal reviews nor a
 * capped thread's later pages, and either can change (an approval, a dismissal, a record posted past the first page)
 * with nothing the listing shows changing — so a clean check expires, and an unreadable one backs off briefly.
 */
const strandedChecked = new Map();
export const STRANDED_RECHECK_MS = 30 * 60_000;
export const STRANDED_BACKOFF_MS = 5 * 60_000;
export function _resetStrandedCheckMemo() { strandedChecked.clear(); }

/**
 * IO (read-only git): the approval-binding coverage for the heal, from this checkout when it is the PR's repo, else the
 * repo's sibling clone; no checkout → no proof → not covered (the sha rule stands). Never throws.
 */
export function healClearanceCoverage({ slug, comments, headSha, exec = execFileSync, cloneDirFor = defaultCloneDirFor, reviews = undefined } = {}) {
  try {
    const clearance = latestOperatorClearanceRecord(comments);
    const head = String(headSha ?? '').toLowerCase();
    if (!clearance || clearance.sha === head) return computeClearanceCoverage({ comments, liveHead: head });
    let origin = '';
    try { origin = String(exec('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' })).trim(); } catch { /* other checkout */ }
    const originSlug = origin.replace(/^.*github\.com[:/]/i, '').replace(/\.git$/i, '').replace(/\/$/, '');
    const cwd = originSlug.toLowerCase() === String(slug ?? '').toLowerCase() ? undefined : cloneDirFor(slug);
    if (cwd === null) return computeClearanceCoverage({ comments, liveHead: head });
    const run = (c, a, o) => exec(c, a, { ...o, ...(cwd ? { cwd } : {}) });
    return computeClearanceCoverage({ comments, liveHead: head, exec: run, reviews,
      readNetDiff: (sha) => readNetDiffAtHead({ exec: run, headSha: sha, headRef: sha }) });
  } catch (e) {
    return { covers: false, liveHead: String(headSha ?? '').toLowerCase(), reason: `clearance coverage unreadable: ${String(e?.message ?? e).split('\n')[0]}` };
  }
}

export function sweepReviewHoldLabels({
  repo = null, listPrs = defaultListPrs, provider = createGhProvider(), dryRun = false, settings, runRuling, acceptCarry,
  readComments = readCompletePrComments, readPr = defaultReadPr,
  numberingRestamp = restampAfterNumbering, exec = execFileSync, now = Date.now, log = (line) => writeLineSync(2, line),
} = {}) {
  // The ONE source of the accept-carry setting (WE_ACCEPT_CARRY_FORWARD > settings/accept-carry-forward.json >
  // default), read once per sweep and logged with its source. No timing setting (review.skipDrainMechanical) governs it.
  const carrySetting = resolveAcceptCarryForward();
  let carryLogged = false;
  const prs = listPrs({ repo });
  const startedAt = now();
  for (const [k, until] of strandedChecked) if (until <= startedAt) strandedChecked.delete(k);
  const results = [];
  let resolvedRepo = repo;
  const repoOf = () => {
    if (resolvedRepo == null) resolvedRepo = provider.currentRepo();
    if (typeof resolvedRepo !== 'string' || !resolvedRepo.trim()) throw new Error('missing repository');
    return resolvedRepo;
  };
  const restamped = new Set();
  for (const pr of Array.isArray(prs) ? prs : []) {
    const names = labelNames(pr.labels);
    const carryLabels = names.includes(REVIEW_LABELS.pending)
      && ![REVIEW_LABELS.human, REVIEW_LABELS.changes, REVIEW_LABELS.heldMechanical].some((l) => names.includes(l));
    // A re-stamp record written over a hold before it is withdrawn whatever the labels or the settled memo say (the
    // live read below re-checks it, with the formal reviews). A capped listing may hide one past its first page, so it
    // is read live. The listing carries no formal reviews either, so a listed record the thread alone validates is
    // read live too. Each listing view (head and listed records) is then left until its check expires
    // (`strandedChecked`), or at once after a pass on it writes or fails.
    // An unreadable listing is thrown by `listedState` below, where each path already handles it.
    let listed = null;
    let listingError = null;
    let records = [];
    try {
      listed = Array.isArray(pr.comments) ? pr.comments : null;
      records = listedNumberingRecords(listed);
    } catch (e) { listingError = e; }
    const checkKey = `${repo ?? ''}#${pr.number}@${String(pr.headRefOid || '').toLowerCase()}`
      + (records.length ? `|${records.map((c) => String(c?.id ?? `${c?.createdAt ?? c?.created_at ?? ''}#${listed.indexOf(c)}`)).join(',')}` : '');
    const listedState = () => {
      if (listingError) throw listingError;
      const complete = Boolean(listed) && (pr.commentsComplete === true || listed.length < LIST_COMMENTS_CAP);
      // A withdrawal an earlier pass started and could not finish (a hold the thread cannot show) is owed whatever the
      // listing says.
      const owed = numberingWithdrawalOwed(repo ?? resolvedRepo, pr.number);
      const shown = complete && strandedNumberingRecords(listed).length > 0;
      const unchecked = !strandedChecked.has(checkKey);
      // Off the carry path a PR listed with no comment field at all says nothing either way and is left alone.
      return { listed, complete, shown,
        stranded: shown || owed || (records.length > 0 && unchecked)
          || (!complete && (carryLabels || Boolean(listed)) && unchecked) };
    };
    let view;
    if (carryLabels) view = listedState();
    else {
      // Off the carry path, only a possible stranded record earns the live read; an unreadable listing is left to the
      // later legs, as before.
      try { view = listedState(); } catch { continue; }
      if (!view.stranded) continue;
    }
    const { complete, stranded } = view;
    // Cheap pre-filter on the listing so the live re-read is spent only on a possible numbering carry: a complete listed
    // thread with no accept on another head (or an accept already bound here by something other than a numbering
    // re-stamp) cannot be one. A capped (possibly truncated) listing is re-read live.
    if (complete && !stranded) {
      const rec = latestAcceptRecord(listed);
      const head = String(pr.headRefOid || '').toLowerCase();
      if (!rec || (rec.sha === head && !String(listed[rec.index]?.body || '').includes(`<!-- ${NUMBERING_RESTAMP_MARKER}:`))) continue;
    }
    try {
      const slug = repoOf();
      if (!stranded && numberingRestampSettled(slug, pr.number, pr.headRefOid)) continue;
      // One validated live read, used for the plan and again right before each write (a hold can arrive mid-proof).
      const readLiveState = () => {
        const metadata = provider.readPrState(slug, pr.number);
        const live = { ...metadata, comments: readComments(pr.number, { repo: slug }) };
        if (live.state !== 'OPEN') throw new Error('PR is not open');
        if (!Array.isArray(live.labels) || live.labels.some((l) =>
          typeof (l?.name ?? l) !== 'string' || !(l?.name ?? l).trim())) throw new Error('unusable labels');
        if (typeof live.headRefOid !== 'string' || !live.headRefOid.trim()) throw new Error('missing head');
        if (!Array.isArray(live.comments)) throw new Error('comments read returned no array');
        if (live.number != null && live.number !== pr.number) throw new Error('PR number mismatch');
        let liveReviews;
        try { liveReviews = provider.readPrReviews(slug, pr.number); } catch { liveReviews = null; }
        return { state: live, reviews: liveReviews };
      };
      const { state, reviews } = readLiveState();
      let origin = '';
      try { origin = String(exec('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' })).trim(); } catch { /* other checkout */ }
      const originSlug = origin.replace(/^.*github\.com[:/]/i, '').replace(/\.git$/i, '').replace(/\/$/, '');
      const cwd = originSlug.toLowerCase() === slug.toLowerCase() ? undefined : defaultCloneDirFor(slug);
      // No checkout: no proof can run, but a withdrawal needs none, so the pass still runs with a proof that retries.
      const noCheckout = cwd === null;
      const readNetDiff = (sha) => readNetDiffAtHead({
        exec: (c, a, o) => execFileSync(c, a, { ...o, ...(cwd ? { cwd } : {}) }), headSha: sha, headRef: sha,
      });
      // Logged once per sweep, the first time the numbering carry is consulted: the setting and where it came from.
      if (!carryLogged) {
        carryLogged = true;
        log(`  numbering carry: accept carry-forward ${carrySetting.value} (source: ${carrySetting.source})`);
      }
      const r = numberingRestamp({ repo: slug, pr: pr.number, state, reviews, provider, dryRun, cwd: noCheckout ? undefined : cwd,
        readNetDiff, readLiveState, exec, guardReferrals: assertMandatoryReferralsCleared,
        acceptCarry: carrySetting.value,
        ...(noCheckout ? { prove: () => ({ ok: false, retryable: true, reason: 'no checkout for repository' }) } : {}) });
      // A pass that withdrew, posted or failed is read again next pass. A clean one settles the check until it expires —
      // briefly when the formal reviews were unreadable, since without them a record they strand looks like any other.
      if (r && (r.commentPosted || ['error', 'retry', 'withdrawn', 'would-withdraw'].includes(r.action))) strandedChecked.delete(checkKey);
      else strandedChecked.set(checkKey, now() + (Array.isArray(reviews) ? STRANDED_RECHECK_MS : STRANDED_BACKOFF_MS));
      if (r) {
        results.push({ num: pr.number, numberingRestamp: r.action, detail: r.reason, ...(r.error ? { error: r.error } : {}) });
        if (r.action === 'restamped' || (dryRun && r.action === 'would-restamp')) restamped.add(pr.number);
      }
    } catch (e) {
      // A failed live read backs off briefly instead of costing a full re-read every pass.
      strandedChecked.set(checkKey, now() + STRANDED_BACKOFF_MS);
      results.push({ num: pr.number, numberingRestamp: 'error', detail: String(e?.message ?? e).split('\n')[0] });
    }
  }
  for (const pr of Array.isArray(prs) ? prs : []) {
    if (restamped.has(pr.number) || !needsReviewHoldCleanup(pr)) continue;
    let state;
    try {
      const metadata = provider.readPrState(repoOf(), pr.number);
      state = { ...metadata, comments: readComments(pr.number, { repo: repoOf() }) };
      if (state.state !== 'OPEN') throw new Error('PR is not open');
      if (!Array.isArray(state.labels) || state.labels.some((label) =>
        typeof (label?.name ?? label) !== 'string' || !(label?.name ?? label).trim())) throw new Error('unusable labels');
      if (typeof state.headRefOid !== 'string' || !state.headRefOid.trim()) throw new Error('missing head');
      if (!Array.isArray(state.comments)) throw new Error('comments read returned no array');
      if (state.number != null && state.number !== pr.number) throw new Error('PR number mismatch');
    } catch (e) {
      results.push({ num: pr.number, skipped: `live re-read failed: ${String(e?.message ?? e).split('\n')[0]}` });
      continue;
    }
    const plan = planReviewHoldCleanup({ currentLabels: state.labels });
    if (plan.remove.length === 0 && !plan.flagged?.length) continue;
    const entry = { num: pr.number, ...(plan.remove.length ? { remove: plan.remove } : {}) };
    let cleanupApplied = dryRun;
    if (!dryRun && plan.remove.length) {
      try {
        provider.setLabels(repoOf(), pr.number, { remove: plan.remove });
        cleanupApplied = true;
      } catch (e) {
        entry.error = String((e && e.message) || e).split('\n')[0];
      }
    }
    if (plan.flagged?.length) {
      const heal = decideContradictoryVerdictHeal({
        currentLabels: state.labels,
        humanClearedSha: parseLatestHumanClearedSha(state.comments),
        acceptedSha: latestAcceptRecord(state.comments)?.sha ?? null,
        headSha: state.headRefOid,
        fetchOk: true,
        // approval-binding (2026-10-21): the operator's clearance covers this head by sha or by a trusted git proof of
        // the same net change — then neither the mutual-exclusivity heal nor the stale-accept heal may drop it.
        clearanceCoverage: healClearanceCoverage({ slug: repoOf(), comments: state.comments, headSha: state.headRefOid, exec,
          reviews: () => provider.readPrReviews(repoOf(), pr.number) }),
      });
      if (heal.heal) {
        // Account for this pass's own successful cleanup; GitHub rejects removing an absent label.
        const toRemove = heal.decision.removeLabels.filter((l) => hasReviewLabel(state.labels, l)
          && !(cleanupApplied && plan.remove.includes(l)));
        entry.healed = toRemove;
        if (!dryRun) {
          // COMMENT FIRST (mirrors `review-set-label.mjs`'s own #2964 ordering, applied here in the SAFER
          // direction for a REMOVAL rather than an accept: an orphan explanatory comment with no label change
          // yet is at worst confusing for one tick; a silent label removal with no explanation behind it is
          // strictly worse — an auditor sees the PR change shape with no record of why).
          try {
            provider.postComment(repoOf(), pr.number, heal.comment);
            entry.commentPosted = true;
          } catch (e) {
            entry.error = String((e && e.message) || e).split('\n')[0];
          }
          if (toRemove.length) {
            try {
              provider.setLabels(repoOf(), pr.number, { remove: toRemove });
            } catch (e) {
              entry.error = entry.error ? `${entry.error}; ${String((e && e.message) || e).split('\n')[0]}` : String((e && e.message) || e).split('\n')[0];
            }
          }
        }
      } else {
        entry.flagged = plan.flagged;
        entry.flagReason = heal.reason;
      }
    }
    results.push(entry);
  }
  // card xu7kxtt (#5472) — an operator clearance a mechanical pass re-held after the head moved (merge queue / rebase)
  // is carried by the sanctioned re-stamp when the net diff is byte-identical. Same listing, own entry shape (`carry`).
  try {
    for (const r of sweepAcceptCarry({ prs, repo, dryRun, setting: carrySetting.value, ...(acceptCarry ? { runRestamp: acceptCarry } : {}) })) {
      results.push({ num: r.num, carry: r.carry, detail: r.detail });
    }
  } catch (e) {
    results.push({ num: 0, carry: 'sweep-failed', error: String((e && e.message) || e).split('\n')[0] });
  }
  // Each composed writer gets its own live read. In particular, the ruling-label pass
  // must see any new rulings or label changes after auto-block, never reuse its decision record.
  try {
    for (const r of sweepAutoBlock({ repo, resolveRepo: () => repoOf(), readPr, listPrs: () => prs, dryRun, ...(settings ? { settings } : {}), ...(runRuling ? { runRuling } : {}) })) {
      results.push({ num: r.num, autoBlock: r.action, findings: r.findings, operatorKept: r.operatorKept, ...(r.error ? { error: r.error } : {}) });
    }
  } catch (e) {
    results.push({ num: 0, autoBlock: 'sweep-failed', error: String((e && e.message) || e).split('\n')[0] });
  }
  // advisory:ruling-needed is reconciled only by pr-label-mirror --apply (G2).
  return results;
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) {
  const argv = process.argv.slice(2);
  const flag = (name) => (argv.find((a) => a.startsWith(`--${name}=`)) || '').slice(name.length + 3) || undefined;
  const verb = argv.find((a) => !a.startsWith('--')) || 'sweep';
  const repo = flag('repo') || null;
  const dryRun = argv.includes('--dry-run');
  const prsFile = flag('prs-file');
  if (verb !== 'sweep') {
    writeLineSync(2, 'usage: review-hold-reconcile.mjs sweep [--repo=<owner/name>] [--dry-run] [--prs-file=<path>]');
    process.exitCode = 2;
  } else {
    try {
      const results = sweepReviewHoldLabels({
        repo, dryRun, ...(prsFile ? { listPrs: () => readPrsFromFile(prsFile) } : {}),
      });
      for (const r of results) {
        if (r.numberingRestamp) {
          writeLineSync(2, `  📌 PR #${r.num}: numbering re-stamp ${r.numberingRestamp} — ${r.detail ?? ''}`);
        }
        if (r.skipped) writeLineSync(2, `  ⚠ PR #${r.num}: ${r.skipped}`);
        if (r.remove?.length) {
          const did = dryRun ? 'would' : r.error ? 'FAILED to' : 'did';
          writeLineSync(2, `  ⚠ PR #${r.num}: ${did} remove ${r.remove.join(',')} (stray review-hold / gate-scoped advisory)${r.error ? ` (${r.error})` : ''}`);
        }
        if (r.healed?.length) {
          const did = dryRun ? 'would heal' : 'healed';
          writeLineSync(2, `  🩹 PR #${r.num}: ${did} — removed ${r.healed.join(',')} (no genuine human clearance found for the live head)${r.commentPosted ? ', comment posted' : ''}${r.error ? ` (${r.error})` : ''}`);
        }
        if (r.autoBlock) writeLineSync(2, `  PR #${r.num}: ${dryRun ? 'would ' : ''}${r.autoBlock} ${r.findings ?? 0} confirmed referral(s) as auto-policy${r.operatorKept ? ` (${r.operatorKept} left for the operator)` : ''}${r.error ? ` (FAILED: ${r.error})` : ''}`);
        if (r.carry) writeLineSync(2, `  PR #${r.num}: accept carry-forward ${r.carry}${r.detail ? ` — ${r.detail}` : ''}${r.error ? ` (${r.error})` : ''}`);
        if (r.ruling) writeLineSync(2, `  PR #${r.num}: ${dryRun ? 'would ' : ''}${r.ruling} advisory:ruling-needed${r.error ? ` (FAILED: ${r.error})` : ''}`);
        if (r.flagged?.length) {
          writeLineSync(2, `  🚩 PR #${r.num}: carries contradictory review:* verdict labels (${r.flagged.join(',')}) — #2766/#2767 shape; not auto-resolved (${r.flagReason || 'unresolved'}${r.fetchError ? `, fetch error: ${r.fetchError}` : ''}). Resolve via review-set-label.mjs --to=clear-human or --to=changes.`);
        }
      }
      writeAllSync(1, `${JSON.stringify({ checked: true, changed: results.length, results })}\n`);
    } catch (e) {
      writeLineSync(2, `error: ${String(e?.message ?? e)}`);
      process.exitCode = 1;
    }
  }
}
