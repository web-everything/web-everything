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
 * SETTING `stackAwareReview` (`on` | `off`), policy cascade (we:scripts/lib/policy-cascade.mjs): built-in default
 * `on` → platform preference `stackAwareReview` → tool override (`we:scripts/settings/stack-aware-review.json`) → env
 * `WE_STACK_AWARE_REVIEW`.
 *
 * Pure policy first; the io shell below FAILS OPEN to today's behaviour (no stack → main basis, as before).
 */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectStacks, readOriginLaneTips, readOpenPrRefs, flagUntrustedStackRows, sameStackActor, stackRowFlags } from './pr-stack.mjs';
import { readSettings } from '../lib/settings-files.mjs';
import { cascadePolicy } from '../lib/policy-cascade.mjs';
import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';
import { normalizeDiffFingerprint } from '../lib/review-escalation.mjs';
import { computeNetDiffText } from '../merge-ai-prs.mjs';
import { readCompletePrComments } from './pr-comments-complete.mjs';

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
  let tool;
  try { tool = read()?.stackAwareReview; } catch { /* default */ }
  // Platform preference under the tool block (shared policy cascade; logs each value's source once).
  const c = cascadePolicy('stackAwareReview', tool, { env, standard: { mode: STACK_AWARE_REVIEW_DEFAULT },
    envValues: { mode: fromEnv ?? undefined }, valid: { mode: (v) => onOff(v) !== null } });
  if (fromEnv) return fromEnv === 'on';
  const file = onOff(c.layered?.mode);
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
 * @param {{allowPair?:Function}} [o] `allowPair` — the ownership rule for a pair; by default the SAME one the fix daemon
 *   applies (`pr-stack.mjs#sameStackActor`: both PRs by the same, known actor), so a stack never forms between authors.
 * @returns {Map<number, {pr:number, ref:string, head:string, contained:string}>} top PR → its stack base
 */
export function findStackBases(prs, sets, { allowPair = sameStackActor } = {}) {
  const { isAncestor, onMain } = stackAnswers(sets);
  const stacks = detectStacks(prs, { isAncestor, onMain, remembered: [], allowPair });
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

/** The opening of a stack-hold comment (`review-pr.mjs` writes it; the marker reader requires it). */
export const stackHoldHeading = (bottom) => `**Accept held — stacked on #${bottom}.**`;

const MARKER_LINE_RE = new RegExp(`^<!-- ${STACK_MARKER}: (\\{[^\\n]*\\}) -->$`);

/**
 * Every well-formed `reviewed-stack` marker on TRUSTED stack-hold comments, oldest first. PURE.
 *
 * A marker drives a LABEL (the carry applies `review:accepted`), and the automation's own comments quote juror text, so
 * "a marker appears somewhere in a trusted comment" proves nothing: a juror can be prompted to echo one, and the echo
 * posts under the trusted identity. A marker counts only in the one shape the STACK_HOLD sink writes: the comment OPENS
 * with {@link stackHoldHeading} for the marker's own bottom PR and the marker is its LAST line. The sink composes both
 * ends itself, so juror text can reach neither (it sits between them; the sink also defuses any `<!--` in it).
 * Anything else — a marker mid-comment, in a verdict write-up, on a comment that does not open with the heading — is
 * ignored.
 */
export function parseStackMarkers(comments) {
  const out = [];
  for (const c of (Array.isArray(comments) ? comments : []).filter(isTrustedMarkerAuthor)) {
    const lines = String(c?.body ?? '').replace(/\r\n?/g, '\n').trim().split('\n');
    const m = MARKER_LINE_RE.exec(lines.at(-1) ?? '');
    if (!m || lines.length < 2) continue;
    try {
      const p = JSON.parse(m[1]);
      if (p?.v === 1 && p.verdict === 'accept' && Number.isInteger(p.top) && Number.isInteger(p.bottom)
        && SHA.test(String(p.topHead)) && SHA.test(String(p.bottomHead)) && SHA.test(String(p.contained))
        && LANE_REF.test(String(p.bottomRef)) && /^[0-9a-f]{64}$/.test(String(p.fingerprint))
        && lines[0].startsWith(`${stackHoldHeading(p.bottom)} `)) out.push(p);
    } catch { /* malformed: ignored */ }
  }
  return out;
}

const VERDICT_HEADING_RE = /^(?:✅|🔁)\s+(?:human\s+)?review\b/u;

/**
 * The markers still in force: a `reviewed-stack` marker is CONSUMED by any later trusted verdict comment (`✅ review —
 * accepted`, `🔁 review — changes requested`, including the carry's own comment). Without this, a carried accept that a
 * later `changes` verdict (or re-arm) superseded would be carried again on the same diff, overwriting the newer verdict
 * without a review. Oldest first. PURE.
 */
export function liveStackMarkers(comments) {
  let live = [];
  for (const c of (Array.isArray(comments) ? comments : []).filter(isTrustedMarkerAuthor)) {
    const found = parseStackMarkers([c]);
    if (found.length) live = live.concat(found);
    else if (VERDICT_HEADING_RE.test(String(c?.body ?? '').trimStart())) live = [];
  }
  return live;
}

/**
 * What the review dispatcher owes this PR. PURE.
 *   - `held`   the PR is still a stacked top and its own diff (vs the stack base) matches an accepted marker:
 *              nothing to review until the bottom lands.
 *   - `carry`  the PR is no longer stacked, its net diff vs main is byte-identical to an accepted marker's, AND the
 *              bottom that landed is the content the accept was reviewed against ({@link judgeBottomLanded}): carry
 *              the accept forward through the single home instead of re-reviewing.
 *   - `review` anything else (no marker, a changed diff, an unreadable fingerprint, a bottom that moved or whose landing
 *              could not be verified — an absent `bottomLanded` is unverified, never assumed fine): review as usual.
 *              The top's own diff alone cannot vouch for the COMBINED result: it stays identical when the bottom changes.
 * @param {{pr:number, stack:object|null, comments:Array, stackFingerprint?:string|null, mainFingerprint?:string|null,
 *   bottomLanded?:{ok:boolean, why?:string}|null}} o
 */
export function decideStackDispatch({ pr, stack, comments, stackFingerprint = null, mainFingerprint = null, bottomLanded = null }) {
  const markers = liveStackMarkers(comments).filter((m) => m.top === Number(pr));
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
    if (bottomLanded?.ok !== true) {
      return { action: 'review', marker: latest,
        why: `stack-carry-refused: ${bottomLanded?.why ?? `the landing of #${latest.bottom} was not verified`}` };
    }
    return { action: 'carry', marker: latest,
      why: `stack-accept-carried: #${latest.bottom} is no longer below #${pr} and its net diff vs main is byte-identical to the diff accepted against ${latest.bottomRef}@${String(latest.contained).slice(0, 9)}` };
  }
  return { action: 'review', marker: latest };
}

/**
 * Did the bottom land as the content the top's accept was reviewed against? PURE over git facts the caller supplies.
 *
 * The carry compares only the TOP's own diff, and that stays byte-identical when the bottom changes after the accept
 * (the top's own change is the same text either way). The result the accept vouched for is bottom + top, so before a
 * carry the landed bottom must be that same bottom. FAIL CLOSED: every unknown is "not verified" → a normal review.
 *   1. the bottom PR is MERGED, and its merge commit is on main;
 *   2. that merge commit holds the bottom's final head (a merge commit; a squash/rebase landing is not provable here);
 *   3. the final head is what the accept saw: the same commit, the same tree, or the same OWN patch (the bottom's own
 *      change against main as it stood just before the merge — survives a rebase onto a moved main).
 * A bottom that gained a commit since the accept is NOT carried, even though the accept's `contained` is an ancestor of
 * it: the added commit is exactly what nobody reviewed with the top.
 * @param {{marker:{bottom:number, contained:string}, bottom:{state?:string, headRefOid?:string, mergeOid?:string}|null,
 *   facts:{onMain:Function, isAncestor:Function, sameTree:Function, ownPatch:Function}}} o
 * @returns {{ok:boolean, why?:string}}
 */
export function judgeBottomLanded({ marker, bottom, facts }) {
  const no = (why) => ({ ok: false, why });
  const n = marker?.bottom;
  const ask = (f, ...a) => { try { return facts?.[f]?.(...a); } catch { return null; } };
  if (!bottom || bottom.state !== 'MERGED') return no(`#${n} is not merged (state ${bottom?.state ?? 'unknown'}), so what landed is unknown`);
  const head = String(bottom.headRefOid ?? '');
  const mc = String(bottom.mergeOid ?? '');
  if (!SHA.test(head) || !SHA.test(mc) || !SHA.test(String(marker?.contained ?? ''))) return no(`#${n}'s final head or merge commit is unknown`);
  if (ask('onMain', mc) !== true) return no(`#${n}'s merge commit ${mc.slice(0, 9)} is not on main`);
  if (ask('isAncestor', head, mc) !== true) return no(`#${n} did not land as a merge of its head ${head.slice(0, 9)} (squash/rebase), so the landed content is unproven`);
  // Landed is not the same as STILL there: a revert after the landing leaves the top's own diff (and the merge commit
  // on main) untouched while main no longer holds the bottom. Its paths must still read as the merge left them.
  if (ask('intact', head, mc) !== true) return no(`#${n}'s files differ on main from how its merge ${mc.slice(0, 9)} left them (reverted or changed since landing)`);
  const reviewed = marker.contained;
  if (head !== reviewed && ask('sameTree', head, reviewed) !== true) {
    const landed = ask('ownPatch', head, mc);
    if (!landed || landed !== ask('ownPatch', reviewed, mc)) {
      return no(`#${n} moved after the accept: it landed at ${head.slice(0, 9)}, the accept was reviewed against ${reviewed.slice(0, 9)}`);
    }
  }
  return { ok: true };
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

/**
 * The net diff TEXT vs main of ONE COMMIT of the PR, through the SAME `computeNetDiffText` `review-set-label.mjs`
 * fingerprints, so a carry compares like with like. The diff is taken from the pinned `headRefOid`, never from the
 * branch name (a name moves on every push), and it is `scored` only when the diff really came from that commit: the
 * carry that follows is bound to this exact head (`carryStackAccept` → `review-set-label.mjs --expect-head`).
 * `headRefName` is used only to fetch the commit.
 */
export function mainNetDiffText({ headRefName, headRefOid }, { root = ROOT } = {}) {
  if (!SHA.test(String(headRefOid ?? '')) || !LANE_REF.test(String(headRefName ?? ''))) return { text: '', base: null, rev: null, scored: false };
  const exec = (cmd, args, o = {}) => execFileSync(cmd, args, { cwd: root, timeout: 120e3, maxBuffer: 64 * 1024 * 1024, ...o });
  const net = computeNetDiffText({ exec, rev: headRefOid, fetchExtraRefs: [headRefName] });
  return net?.scored && net.rev === headRefOid ? net : { text: '', base: null, rev: null, scored: false };
}

/**
 * The PR's head ref and its COMPLETE comment thread (the paginated reader: a marker past the first 100 comments must
 * not be missed). Throws on a failed read; the caller fails open to a normal review.
 */
export function readStackThread(n, { repo, root = ROOT, readComments = readCompletePrComments,
  readHead = () => JSON.parse(String(execFileSync('gh', ['pr', 'view', String(n), '--repo', repo, '--json', 'headRefName,headRefOid'],
    { cwd: root, encoding: 'utf8', timeout: 60e3, maxBuffer: 4 * 1024 * 1024 }))) } = {}) {
  const head = readHead();
  return { headRefName: head?.headRefName ?? null, headRefOid: head?.headRefOid ?? null, comments: readComments(Number(n), { repo }) };
}

/** The diff fingerprint `review-set-label.mjs` stamps (`normalizeDiffFingerprint`), or null. */
export const fingerprintOf = (text) => normalizeDiffFingerprint(String(text ?? ''));

/**
 * Read what landed for the marker's bottom PR and judge it ({@link judgeBottomLanded}). FAILS CLOSED: any failed read
 * is `{ok:false}`, which {@link decideStackDispatch} turns into a normal review. The PR number comes from the trusted
 * marker (an integer, checked here again before it reaches a ref name). A merged bottom's branch is usually deleted,
 * so its commits are fetched through GitHub's own `refs/pull/<n>/head`.
 */
export function readBottomLanded({ marker, repo, root = ROOT, run = gitRun(root), base = 'origin/main',
  readBottom = (n) => {
    const j = JSON.parse(String(execFileSync('gh', ['pr', 'view', String(n), '--repo', repo, '--json', 'state,headRefOid,mergeCommit'],
      { cwd: root, encoding: 'utf8', timeout: 60e3, maxBuffer: 4 * 1024 * 1024 })));
    return { state: j?.state, headRefOid: j?.headRefOid, mergeOid: j?.mergeCommit?.oid };
  } } = {}) {
  try {
    const n = marker?.bottom;
    if (!Number.isInteger(n) || n <= 0) return { ok: false, why: 'the marker names no valid bottom PR' };
    const bottom = readBottom(n);
    const have = (sha) => { try { run(['cat-file', '-e', `${sha}^{commit}`]); return true; } catch { return false; } };
    const fetchRef = (ref) => { try { run(['fetch', '-q', '--end-of-options', 'origin', ref]); } catch { /* left unknown */ } };
    if (SHA.test(String(bottom?.mergeOid ?? '')) && !have(bottom.mergeOid)) fetchRef('main');
    if ([bottom?.headRefOid, marker.contained].some((s) => SHA.test(String(s ?? '')) && !have(s))) fetchRef(`refs/pull/${n}/head`);
    const ok = (args) => { try { run(args); return true; } catch { return false; } };
    const out = (args) => { try { return run(args).trim(); } catch { return ''; } };
    const facts = {
      onMain: (sha) => ok(['merge-base', '--is-ancestor', '--end-of-options', sha, base]),
      isAncestor: (a, b) => ok(['merge-base', '--is-ancestor', '--end-of-options', a, b]),
      // `rev-parse` echoes `--end-of-options` back into its output, so these two take no guard: both operands are
      // 40-hex shas (checked in judgeBottomLanded) and `--verify` accepts exactly one revision.
      sameTree: (a, b) => { const ta = out(['rev-parse', '--verify', `${a}^{tree}`]); return SHA.test(ta) && ta === out(['rev-parse', '--verify', `${b}^{tree}`]); },
      // Every path the bottom changed reads on `base` as the merge commit left it (no revert, no later edit).
      intact: (head, mc) => {
        const parent = out(['rev-parse', '--verify', `${mc}^1`]);
        const fork = SHA.test(parent) ? out(['merge-base', '--end-of-options', head, parent]) : '';
        if (!SHA.test(fork)) return false;
        const paths = run(['diff', '--name-only', '--no-renames', '-z', '--end-of-options', fork, head]).split('\0').filter(Boolean);
        return paths.length > 0 && ok(['diff', '--quiet', '--no-ext-diff', '--end-of-options', mc, base, '--', ...paths]);
      },
      // The bottom's OWN change as the merge saw it: its head against its fork point from the merge commit's first parent.
      ownPatch: (sha, mc) => {
        const parent = out(['rev-parse', '--verify', `${mc}^1`]);
        const fork = SHA.test(parent) ? out(['merge-base', '--end-of-options', sha, parent]) : '';
        const text = SHA.test(fork) ? run(['diff', '--no-ext-diff', '--end-of-options', fork, sha]) : '';
        return text.trim() ? fingerprintOf(text) : null;
      },
    };
    return judgeBottomLanded({ marker, bottom, facts });
  } catch (e) { return { ok: false, why: `the landing of #${marker?.bottom} could not be read (${String(e?.message ?? e).split('\n')[0].slice(0, 120)})` }; }
}

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
    // Trust boundary: the SAME rule as the fix daemon's `pr-stack.mjs#readStacksForPass` (shared helpers, not a copy).
    // Fork status and AUTHOR always come from GitHub's own open-PR record, never from the caller's list (which may
    // lack them): a PR with no record is a fork, and a pair needs one known actor on both sides (`sameStackActor`,
    // applied by `findStackBases`). The caller's list only says which PRs, at which head, to look at.
    const refs = readRefs(root);
    const listed = Array.isArray(prs)
      ? prs.map((p) => ({ pr: Number(p.number), headRefName: p.headRefName ?? null, headRefOid: p.headRefOid ?? null }))
      : [...refs.entries()].map(([n, r]) => ({ pr: n, headRefName: r.headRefName, headRefOid: r.headRefOid }));
    const rows = listed.map((r) => ({ ...r, ...stackRowFlags(refs.get(r.pr)) }));
    const trusted = flagUntrustedStackRows(rows, tips)
      .filter((r) => Number.isInteger(r.pr) && !r.untrusted && LANE_REF.test(r.headRefName));
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
