/**
 * @file scripts/conveyor/review-stack-base.mjs — stack-aware review (held item 177).
 *
 * Live 2026-10-09: #4631 (lane/accept-carry-forward) is stacked on #4624 (lane/red-main-contain). Both target main,
 * so #4631's diff against main carries #4624's 13 files, and the review daemon refused it as `scope-bloat` 55 times
 * while it waited for #4624 to land. The fix daemon already knows stacks (`pr-stack.mjs`, #4655). This module makes
 * the REVIEW side stack-aware with the same pure detector:
 *
 *   (a) for a top PR, its own change is the diff from a SYNTHETIC BASE — the tree git would get by merging the part
 *       of the bottom PR the top contains into the top's merge-base with main (`git merge-tree --write-tree`). That is
 *       exactly "what the top adds on top of the bottom", with main's own changes left out. Scope-bloat and the
 *       juror's diff both read it.
 *   (b) the juror is told the base is the bottom PR's head, not main.
 *   (c) an ACCEPT on a stacked top is never turned into `review:accepted` while the bottom is open: it is recorded as a
 *       `reviewed-stack` marker (the reviewed base sha and the fingerprint of the reviewed diff). While the bottom is
 *       open and the top's own diff is unchanged, no new review is dispatched ("held"). Once the stack collapses (the
 *       bottom landed, the top was restacked) and the top's net diff against main is byte-identical to the reviewed
 *       one, the accept is carried forward through the single home (`review-set-label.mjs`) instead of re-reviewing.
 *
 * MERGE GATES ARE NEVER WEAKENED. The top gets no accept label while it still carries the bottom's commits, so the
 * drain cannot land it first. The carry applies only on a byte-identical fingerprint of the net diff vs main, which
 * `review-set-label.mjs` then re-derives and stamps itself.
 *
 * Detection reuses `pr-stack.mjs#detectStacks` with a widened containment predicate: a bottom counts as "below" a top
 * when the top contains the bottom's head OR an older commit of the bottom's own first-parent line that is not on
 * main (the bottom moved after the top merged it — the live #4631/#4624 shape, where #4631 holds 704c02f and #4624 is
 * at dea2666). Trust boundary as in `pr-stack.mjs`: only non-fork PRs whose head is the tip of the origin `lane/*`
 * branch GitHub names for them take part.
 *
 * SETTING `stackAwareReview` (`on` | `off`), policy cascade: built-in default `on` → platform preference
 * (`we:scripts/settings/stack-aware-review.json`) → tool override (env `WE_STACK_AWARE_REVIEW`).
 *
 * Pure policy first; the io shell below FAILS OPEN to today's behaviour (no stack → main basis, as before).
 */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectStacks, readOriginLaneTips, readOpenPrRefs } from './pr-stack.mjs';
import { readSettings } from '../lib/settings-files.mjs';
import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';
import { normalizeDiffFingerprint } from '../lib/review-escalation.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const STACK_AWARE_REVIEW_DEFAULT = 'on';
export const STACK_AWARE_REVIEW_ENV = 'WE_STACK_AWARE_REVIEW';
export const STACK_MARKER = 'reviewed-stack';

const SHA = /^[0-9a-f]{40}$/;
const LANE_REF = /^lane\/[A-Za-z0-9._/-]{1,200}$/;
const onOff = (v) => {
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  const s = String(v ?? '').trim().toLowerCase();
  return /^(on|true|1|yes)$/.test(s) ? 'on' : /^(off|false|0|no)$/.test(s) ? 'off' : null;
};

/** The setting in force: env → settings file → built-in `on`. Never throws. */
export function resolveStackAwareReview(env = process.env, { read = readSettings } = {}) {
  const fromEnv = onOff(env?.[STACK_AWARE_REVIEW_ENV]);
  if (fromEnv) return fromEnv === 'on';
  let file = null;
  try { file = onOff(read()?.stackAwareReview?.mode); } catch { /* default */ }
  return (file ?? STACK_AWARE_REVIEW_DEFAULT) === 'on';
}

/**
 * The off-main commit sets the detector reads, one entry per PR head. PURE shape:
 *   `reach` — every commit reachable from the head and not on main; `first` — the head's own first-parent line off
 *   main, newest first. Two git reads per PR instead of a merge-base per PR pair (an N-squared walk measured ~20 s
 *   per call across the open PRs).
 * @typedef {Map<string, {reach:Set<string>, first:string[]}>} OffMainSets
 */

/**
 * The bottom commit a top holds, or null. PURE over {@link OffMainSets}.
 *   - the bottom's head itself, when the top contains it (a top cut from, or restacked onto, the bottom);
 *   - else the newest commit of the bottom's own first-parent line that the top has MERGED IN (it is reachable from
 *     the top but not on the top's first-parent line) — the bottom moved after the top merged it (live: #4631 held
 *     704c02f while #4624 was at dea2666).
 * ASYMMETRY: a commit on BOTH first-parent lines is a shared stray ancestor (live: #4655 and #4686 were both cut from
 * 7fd6bba). By graph alone that says nothing about which PR is below, so it is not a stack.
 * `undefined` when a head's sets are unknown (a failed read owes nothing).
 */
export function containedCommit(sets, bottomHead, topHead) {
  const top = sets.get(topHead);
  const bottom = sets.get(bottomHead);
  if (!top || !bottom) return undefined;
  if (!bottom.first.length) return null; // the bottom is already on main
  if (top.reach.has(bottomHead)) return bottomHead;
  const topFirst = new Set(top.first);
  return bottom.first.find((c) => top.reach.has(c) && !topFirst.has(c)) ?? null;
}

/** The `isAncestor` / `onMain` pair `pr-stack.mjs#detectStacks` takes, widened to "holds part of the bottom". PURE. */
export function stackAnswers(sets) {
  return {
    isAncestor: (bottomHead, topHead) => {
      const c = containedCommit(sets, bottomHead, topHead);
      return c === undefined ? null : Boolean(c);
    },
    onMain: (sha) => { const s = sets.get(sha); return Boolean(s) && s.first.length === 0; },
  };
}

/**
 * Every stacked top among the open PRs, with its base. PURE: reuses `pr-stack.mjs#detectStacks` (the fix daemon's
 * detector) with the widened containment answers.
 * @param {Array<{pr:number, headRefName:string|null, headRefOid:string|null, untrusted?:boolean}>} prs open PRs
 * @param {OffMainSets} sets
 * @returns {Map<number, {pr:number, ref:string, head:string, contained:string}>} top PR → its stack base
 */
export function findStackBases(prs, sets) {
  const { isAncestor, onMain } = stackAnswers(sets);
  const stacks = detectStacks(prs, { isAncestor, onMain, remembered: [] });
  const out = new Map();
  for (const pair of stacks.pairs) {
    if (!pair.bottomOpen || !pair.bottomHead || !LANE_REF.test(String(pair.bottomRef ?? ''))) continue;
    const top = prs.find((p) => p.pr === pair.top);
    const contained = top?.headRefOid ? containedCommit(sets, pair.bottomHead, top.headRefOid) : null;
    if (contained && SHA.test(contained)) out.set(pair.top, { pr: pair.bottom, ref: pair.bottomRef, head: pair.bottomHead, contained });
  }
  return out;
}

// ── markers ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** The durable record of an accept made against a stack base. One HTML comment line, JSON payload. */
export function renderStackMarker({ top, topHead, bottom, bottomRef, bottomHead, contained, fingerprint }) {
  const payload = { v: 1, verdict: 'accept', top, topHead, bottom, bottomRef, bottomHead, contained, fingerprint };
  return `<!-- ${STACK_MARKER}: ${JSON.stringify(payload)} -->`;
}

const MARKER_RE = new RegExp(`<!-- ${STACK_MARKER}: (\\{[^\\n]*?\\}) -->`, 'g');

/** Every well-formed `reviewed-stack` marker on TRUSTED comments, oldest first. PURE. */
export function parseStackMarkers(comments) {
  const out = [];
  for (const c of (Array.isArray(comments) ? comments : []).filter(isTrustedMarkerAuthor)) {
    for (const m of String(c?.body ?? '').matchAll(MARKER_RE)) {
      try {
        const p = JSON.parse(m[1]);
        if (p?.v === 1 && p.verdict === 'accept' && Number.isInteger(p.top) && Number.isInteger(p.bottom)
          && SHA.test(String(p.topHead)) && /^[0-9a-f]{64}$/.test(String(p.fingerprint))) out.push(p);
      } catch { /* malformed: ignored */ }
    }
  }
  return out;
}

/**
 * What the review dispatcher owes this PR. PURE.
 *   - `held`   the PR is still a stacked top and its own diff (vs the stack base) matches an accepted marker:
 *              nothing to review until the bottom lands.
 *   - `carry`  the PR is no longer stacked and its net diff vs main is byte-identical to an accepted marker's: carry
 *              the accept forward through the single home instead of re-reviewing.
 *   - `review` anything else (no marker, a changed diff, an unreadable fingerprint): review as usual.
 * @param {{pr:number, stack:object|null, comments:Array, stackFingerprint?:string|null, mainFingerprint?:string|null}} o
 */
export function decideStackDispatch({ pr, stack, comments, stackFingerprint = null, mainFingerprint = null }) {
  const markers = parseStackMarkers(comments).filter((m) => m.top === Number(pr));
  const latest = markers.at(-1);
  if (!latest) return { action: 'review' };
  if (stack) {
    if (stackFingerprint && stackFingerprint === latest.fingerprint) {
      return { action: 'held', marker: latest,
        why: `stacked-accept-held: accepted against #${latest.bottom} (${latest.bottomRef}@${String(latest.contained).slice(0, 9)}); `
          + `the merge waits for #${stack.pr} to land, then the accept carries forward on an identical net diff` };
    }
    return { action: 'review', marker: latest };
  }
  if (mainFingerprint && mainFingerprint === latest.fingerprint) {
    return { action: 'carry', marker: latest,
      why: `stack-accept-carried: #${latest.bottom} is no longer below #${pr} and its net diff vs main is byte-identical to the diff accepted against ${latest.bottomRef}@${String(latest.contained).slice(0, 9)}` };
  }
  return { action: 'review', marker: latest };
}

// ── io shell ─────────────────────────────────────────────────────────────────────────────────────────────────────

const gitRun = (root) => (args, opts = {}) => String(execFileSync('git', ['-C', root, ...args], {
  encoding: 'utf8', timeout: 60e3, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...opts,
}));

/** Read {@link OffMainSets} for the given heads. A head whose read fails is left out (its answers become unknown). */
export function readOffMainSets(heads, { root = ROOT, run = gitRun(root), base = 'origin/main' } = {}) {
  const sets = new Map();
  for (const head of new Set(heads)) {
    if (!SHA.test(String(head ?? ''))) continue;
    try {
      const reach = run(['rev-list', '--end-of-options', head, `^${base}`]).split('\n').filter(Boolean);
      const first = run(['rev-list', '--first-parent', '--end-of-options', head, `^${base}`]).split('\n').filter(Boolean);
      sets.set(head, { reach: new Set(reach), first });
    } catch { /* unknown */ }
  }
  return sets;
}

/**
 * The synthetic base tree for a stacked top: merge the bottom commit it contains into its merge-base with main.
 * `null` on a conflict or any failure (fail open: the caller keeps the main basis).
 */
export function stackBaseTree({ contained, topHead, root = ROOT, run = gitRun(root), base = 'origin/main' }) {
  try {
    const mainBase = run(['merge-base', '--end-of-options', base, topHead]).split('\n')[0].trim();
    if (!SHA.test(mainBase)) return null;
    const tree = run(['merge-tree', '--write-tree', '--end-of-options', contained, mainBase]).split('\n')[0].trim();
    return SHA.test(tree) ? tree : null;
  } catch { return null; }
}

/** The top's own changed paths against the stack base tree. Throws on a failed read (the caller fails open). */
export function stackNetFiles({ tree, topHead, root = ROOT, run = gitRun(root) }) {
  return run(['diff', '--name-only', '--no-renames', '--end-of-options', tree, topHead]).split('\n').filter(Boolean);
}

/**
 * The top's own diff TEXT against the stack base tree, with the exact argv `computeNetDiffText` uses for the main
 * basis, so the fingerprint of a stacked review and of the same change after restack onto main are comparable.
 */
export function stackNetDiffText({ tree, topHead, root = ROOT, run = gitRun(root) }) {
  return run(['diff', '--no-ext-diff', '--end-of-options', tree, topHead]);
}

/** The diff fingerprint `review-set-label.mjs` stamps (`normalizeDiffFingerprint`), or null. */
export const fingerprintOf = (text) => normalizeDiffFingerprint(String(text ?? ''));

/**
 * Resolve every stacked top among the open PRs, end to end. Fails open to an empty Map.
 * @param {{root?:string, env?:object, prs?:Array<{number:number, headRefName:string, headRefOid:string, isCrossRepository?:boolean}>,
 *   readRefs?:Function, readLanes?:Function, run?:Function, settingOn?:boolean}} o
 *   `prs` — the open-PR list when the caller already has it (the reconcile pass does); otherwise it is read.
 * @returns {Map<number, {pr:number, ref:string, head:string, contained:string, tree:string, topHead:string}>}
 */
export function readStackBases({ root = ROOT, env = process.env, prs = null, readRefs = readOpenPrRefs,
  readLanes = readOriginLaneTips, run = gitRun(root), settingOn = resolveStackAwareReview(env) } = {}) {
  const out = new Map();
  try {
    if (!settingOn) return out;
    const tips = readLanes(root);
    if (!tips) return out;
    const rows = Array.isArray(prs)
      ? prs.map((p) => ({ pr: Number(p.number), headRefName: p.headRefName ?? null, headRefOid: p.headRefOid ?? null,
        fork: p.isCrossRepository === true }))
      : [...readRefs(root).entries()].map(([n, r]) => ({ pr: n, headRefName: r.headRefName, headRefOid: r.headRefOid,
        fork: r.isCrossRepository !== false }));
    // Trust boundary (as `pr-stack.mjs#readStacksForPass`): a non-fork PR whose head is the origin lane branch's tip.
    const trusted = rows.filter((r) => Number.isInteger(r.pr) && !r.fork && r.headRefOid && r.headRefName
      && LANE_REF.test(r.headRefName) && tips.get(r.headRefName) === r.headRefOid);
    const missing = trusted.filter((r) => { try { run(['cat-file', '-e', `${r.headRefOid}^{commit}`]); return false; } catch { return true; } });
    if (missing.length) {
      try { run(['fetch', '-q', '--end-of-options', 'origin', ...missing.map((r) => r.headRefName)]); } catch { /* left unknown */ }
    }
    const sets = readOffMainSets(trusted.map((r) => r.headRefOid), { root, run });
    for (const [top, base] of findStackBases(trusted, sets)) {
      const topHead = trusted.find((r) => r.pr === top).headRefOid;
      const tree = stackBaseTree({ contained: base.contained, topHead, root, run });
      if (tree) out.set(top, { ...base, tree, topHead });
    }
  } catch { /* fail open */ }
  return out;
}

/** The stack base for one open PR, or null. Fails open. */
export function readStackBase({ pr, ...opts } = {}) {
  return readStackBases(opts).get(Number(pr)) ?? null;
}
