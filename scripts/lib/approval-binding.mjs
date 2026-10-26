/**
 * @file scripts/lib/approval-binding.mjs
 * @description THE one answer to "does the operator's human clearance cover the PR's live head?" — shared by every
 *   reader that decides the human gate is cleared, removes `review:accepted`, or re-adds `review:human`.
 *
 *   THE PROBLEM (operator, 2026-10-21). A `review-set-label --to=clear-human` clearance was effectively bound to the
 *   commit sha: every mechanical new head (the drain's rebase/restamp, its card-numbering commit, a conflict-watch
 *   merge, a ci-heal restoring the same files) dropped it — #5742 (3×), #5773, #5502, #5530 (renumbering), and #5485,
 *   where a fresh review on the SAME head stamped a plain accept and so hid the clearance from every
 *   "latest accept is a clearance" reader.
 *
 *   THE RULE. A clearance is valid at live head X iff the PR's net change at X (vs its merge-base with main, read from
 *   git by trusted code — never from a comment) matches the fingerprint the clearance itself recorded:
 *     • X is the cleared sha                                                         → covered (`sha`);
 *     • the strict `reviewed-diff` fingerprint (`fingerprint`) or the `reviewed-contribution` fingerprint
 *       (`contribution`) matches, AND the cleared change replayed onto X's base reproduces X's tree exactly (git object
 *       ids: every byte, mode, path) — the text digests alone miss a relocation (#x413mbt) and a lossy UTF-8 decode;
 *     • no later comment stands against the clearance and the PR's formal reviews were read with no standing change
 *       request (both required for every tier below the sha one);
 *     • X = B + only the drain's own numbering commits (proved by numbering-carry's exact rename map + reference
 *       rewrite proof) and B is covered by the rules above                           → covered (`numbering`).
 *   Anything unprovable — an unreadable diff, a git error, a missing fingerprint, a failed proof — is NOT covered.
 *   Any content change (one byte, a mode, a trailing newline) changes both fingerprints and fails the replay.
 *
 *   WHICH RECORD COUNTS. Only a trusted-author comment that carries `reviewed-sha` AND `cleared-human` in the SAME
 *   comment (what `review-set-label --to=clear-human` writes, and what the trusted carry/restamp writers re-stamp after
 *   their own proofs). Unlike `parseLatestHumanClearedSha`, a LATER plain accept does not hide it: a fresh review on
 *   the same head never invalidates a clearance, and an older clearance can never lend itself to different content
 *   because coverage is decided by the content proof above. A later review's findings still apply through the normal
 *   gates (`review:changes`, the red-team gate, the guard-file classification) — this module decides only whether the
 *   recorded human clearance covers the head.
 *
 *   SETTINGS (policy cascade, `review.clearance`): `bindTo` fingerprint|sha (default fingerprint; `sha` is the kill
 *   switch — exact sha identity only, today's behaviour) and `normalizeNumbering` true|false (default true). Env
 *   `WE_REVIEW_CLEARANCE_BIND_TO`, `WE_REVIEW_CLEARANCE_NORMALIZE_NUMBERING`. Logged once per process with source. The
 *   existing switches only narrow it: `review.humanClearanceCarryForward=false` forces `bindTo=sha`,
 *   `review.carryHumanClearanceAcrossNumbering=false` forces `normalizeNumbering=false`. `bindTo=sha` restores the
 *   behaviour before this module; the older mechanical carry writers (human-clearance-carry, the restamp) keep their
 *   own switch (`review.humanClearanceCarryForward`).
 */
import { cascadePolicy } from './policy-cascade.mjs';
import { GH_ARGV, parseJsonLines } from './review-label-provider.mjs';
import { readSettings } from './settings-files.mjs';
import { isTrustedMarkerAuthor } from './marker-authorship.mjs';
import {
  parseReviewedShaMarker, parseReviewedDiff, parseReviewedContribution, parseOperatorClearance, clearanceBindsHead, parseLatestHumanClearedSha,
} from './review-escalation.mjs';

export { clearanceBindsHead };
import { compareCarryFingerprints, ensureCommitReadable, liveCarryFingerprints, resolveCarryEquivalenceSetting, TRANSIENT_CARRY_PATHS } from './carry-equivalence.mjs';
import { NUMBERING_SUBJECT_RE, MAX_NUMBERING_COMMITS, proveNumberingOnlyMove, isNumberingTolerableLaterBody, resolveNumberingHumanClearanceSetting } from './numbering-carry.mjs';
import { resolveHumanClearanceCarrySetting } from './human-clearance-carry.mjs';
import { laterReviewHold, isLaterVerdictBody } from './accept-carry-forward.mjs';

export const CLEARANCE_BIND_TO_ENV = 'WE_REVIEW_CLEARANCE_BIND_TO';
export const CLEARANCE_NORMALIZE_NUMBERING_ENV = 'WE_REVIEW_CLEARANCE_NORMALIZE_NUMBERING';
const SHA40 = /^[0-9a-f]{40}$/;
// The acceptance writers' own headings, at byte 0 (caller text is always appended after them and `<!--` in it is
// escaped, so prose cannot open with one). Only these, AND a `reviewed-sha` marker, AND no later-verdict shape, make a
// later comment an acceptance record rather than a possible hold.
const ACCEPTANCE_HEADING_RE = /^(?:✅ review — accepted\n|✅ review — `review:human` cleared via the sanctioned path\n|📌 review — acceptance re-stamped after a rebase \(no new review\)\n|📌 review — human clearance carried forward \(equivalent change after a mechanical refresh, no new review\)\n)/;
const isAcceptanceRecordBody = (body) => ACCEPTANCE_HEADING_RE.test(body) && !!parseReviewedShaMarker(body) && !isLaterVerdictBody(body);
// The review-hold reconcile's own heal notice (`buildContradictoryVerdictHealComment`): a sha-bound diagnostic, not a hold.
const MUTUAL_EXCLUSIVITY_HEAL_RE = /^\*\*`review:accepted` removed — mutual exclusivity \(#2766\/#2767\)\.\*\*\n/;
const BIND_TO = ['fingerprint', 'sha'];

const parseBool = (raw) => (raw === undefined ? undefined
  : /^(on|true|1|yes)$/i.test(String(raw).trim()) ? true
    : /^(off|false|0|no)$/i.test(String(raw).trim()) ? false : raw);

/**
 * IO: resolve `review.clearance.{bindTo,normalizeNumbering}` through standard → platform → tool → env. Never throws;
 * an invalid value never overrides a lower layer (an invalid env value falls back, it is not honoured).
 * @returns {{bindTo:{value:'fingerprint'|'sha',source:string}, normalizeNumbering:{value:boolean,source:string}}}
 */
export function resolveClearanceBindingSettings({ env = process.env, tool, platform, humanCarry, numberingCarry } = {}) {
  const resolved = resolveBindingLeaves({ env, tool, platform });
  // The existing kill switches keep their meaning: with the human-clearance carry off, a clearance binds by sha only;
  // with the numbering carry off, numbering is not normalized. Either can only narrow coverage.
  let human = humanCarry;
  if (human === undefined) { try { human = resolveHumanClearanceCarrySetting({ env }); } catch { human = { value: false, source: 'unreadable' }; } }
  let numbering = numberingCarry;
  if (numbering === undefined) { try { numbering = resolveNumberingHumanClearanceSetting({ env }); } catch { numbering = { value: false, source: 'unreadable' }; } }
  if (human?.value !== true && resolved.bindTo.value !== 'sha') {
    resolved.bindTo = { value: 'sha', source: `review.humanClearanceCarryForward=${human?.value} (${human?.source})` };
  }
  if (numbering?.value !== true && resolved.normalizeNumbering.value !== false) {
    resolved.normalizeNumbering = { value: false, source: `review.carryHumanClearanceAcrossNumbering=${numbering?.value} (${numbering?.source})` };
  }
  return resolved;
}

function resolveBindingLeaves({ env, tool, platform }) {
  let review = tool;
  if (review === undefined) { try { review = readSettings()?.review; } catch { review = undefined; } }
  const clearance = review && typeof review === 'object' ? review.clearance : undefined;
  const leaf = (key, standard, valid, envRaw) => {
    try {
      const p = cascadePolicy('review.clearance', clearance && typeof clearance === 'object' ? { [key]: clearance[key] } : undefined, {
        standard: { [key]: standard }, env, ...(platform === undefined ? {} : { platform }),
        valid: { [key]: valid }, envValues: { [key]: envRaw },
      });
      return { value: p.value?.[key] ?? standard, source: p.sources?.[key] ?? 'standard' };
    } catch { return { value: standard, source: 'standard (cascade unreadable)' }; }
  };
  const bindRaw = env?.[CLEARANCE_BIND_TO_ENV];
  return {
    bindTo: leaf('bindTo', 'fingerprint', (v) => BIND_TO.includes(v),
      bindRaw === undefined ? undefined : String(bindRaw).trim().toLowerCase()),
    normalizeNumbering: leaf('normalizeNumbering', true, (v) => typeof v === 'boolean',
      parseBool(env?.[CLEARANCE_NORMALIZE_NUMBERING_ENV])),
  };
}

const logged = new Set();
/** IO: one `policy · review.clearance.*` line per process per distinct effective value (stderr → the daemon log). */
export function logClearanceBindingSettings(settings, write = (s) => process.stderr.write(s)) {
  const key = `${settings?.bindTo?.value}:${settings?.bindTo?.source}:${settings?.normalizeNumbering?.value}:${settings?.normalizeNumbering?.source}`;
  if (logged.has(key)) return;
  logged.add(key);
  write(`policy · review.clearance.bindTo=${settings?.bindTo?.value} (${settings?.bindTo?.source}) · `
    + `review.clearance.normalizeNumbering=${settings?.normalizeNumbering?.value} (${settings?.normalizeNumbering?.source})\n`);
}
/** Test seam. @test-only-export-ok */
export function _resetClearanceBindingLog() { logged.clear(); }

/**
 * PURE: the latest recorded operator clearance on the thread — a trusted comment carrying a full `reviewed-sha` and a
 * named `cleared-human` in THAT SAME comment, with that comment's own fingerprints. A later plain accept does NOT hide
 * it (see the file note); a later clearance replaces it. `null` when none.
 * @returns {{sha:string, diff:string|null, contribution:string|null, actor:string, index:number}|null}
 */
export function latestOperatorClearanceRecord(comments) {
  const list = Array.isArray(comments) ? comments : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const c = list[i];
    if (!c || typeof c.body !== 'string' || !isTrustedMarkerAuthor(c)) continue;
    const sha = parseReviewedShaMarker(c.body);
    if (!sha) continue;
    const clearance = parseOperatorClearance([c]);
    if (!clearance) continue;
    // Only a full sha can be compared to the live head and fed to git; an abbreviated clearance is sha-unbindable.
    if (!SHA40.test(sha)) return null;
    // Nothing after the record may stand against it for a content-bound (non-sha) cover: a later comment must be a known
    // machine shape / head-move diagnostic (numbering-carry's vocabulary) or a trusted acceptance record (a fresh accept,
    // a re-stamp or carry record — only acceptance writers stamp `reviewed-sha`). Any other comment, from anyone, is a
    // possible hold (the carry's inverted rule).
    const laterStands = list.slice(i + 1).some((l) => {
      const body = typeof l?.body === 'string' ? l.body : '';
      if (isTrustedMarkerAuthor(l) && isAcceptanceRecordBody(body)) return false;
      if (isTrustedMarkerAuthor(l) && MUTUAL_EXCLUSIVITY_HEAL_RE.test(body)) return false;
      return !isNumberingTolerableLaterBody(body);
    });
    const at = typeof c.createdAt === 'string' ? c.createdAt : (typeof c.created_at === 'string' ? c.created_at : null);
    return { sha, diff: parseReviewedDiff([c]), contribution: parseReviewedContribution([c]), actor: clearance.actor, index: i, at, laterStands };
  }
  return null;
}

/**
 * PURE (given pure injections): does the recorded operator clearance cover the live head?
 * @param {{clearance:{sha:string,diff?:string|null,contribution?:string|null,at?:string|null,laterStands?:boolean}|null, liveHead:string,
 *   fingerprintOf?:(sha:string)=>({diff:string|null,contribution:string|null}|null),
 *   proveReplay?:(fromSha:string,toSha:string)=>({ok:boolean,reason?:string}),
 *   numberingProof?:(liveHead:string)=>({ok:boolean,base?:string,reason?:string}),
 *   bindTo?:'fingerprint'|'sha', normalizeNumbering?:boolean, equivalence?:'contribution'|'strict'}} o
 *   `fingerprintOf` MUST read the net diff from git (trusted code), never from a comment.
 * @returns {{covers:boolean, liveHead:string, tier?:'sha'|'fingerprint'|'contribution'|'numbering', reason:string, base?:string}}
 */
export function clearanceCovers(o = {}) {
  const head = String(o?.liveHead ?? '').toLowerCase();
  // The verdict names the head it was computed for, so `clearanceBindsHead` can refuse it for any other head.
  return { ...evaluateClearance(o), liveHead: head };
}

function evaluateClearance({
  clearance = null, liveHead = '', fingerprintOf = null, proveReplay = null, numberingProof = null,
  bindTo = 'fingerprint', normalizeNumbering = true, equivalence = 'contribution', reviews = undefined,
} = {}) {
  const no = (reason) => ({ covers: false, reason });
  const cleared = String(clearance?.sha ?? '').toLowerCase();
  const head = String(liveHead ?? '').toLowerCase();
  if (!SHA40.test(cleared)) return no('no recorded operator clearance with a full reviewed sha');
  if (!SHA40.test(head)) return no('live head unknown');
  if (cleared === head) return { covers: true, tier: 'sha', reason: `the clearance names the live head ${head.slice(0, 9)}` };
  if (bindTo !== 'fingerprint') return no(`review.clearance.bindTo=${bindTo}: the clearance names ${cleared.slice(0, 9)}, not the live head`);
  if (clearance.laterStands === true) return no('a later comment that is not an acceptance or a known machine note stands after the clearance');
  // `reviews` (the PR's formal reviews, or a lazy reader of them) is REQUIRED for any content-bound cover: omitted or
  // unreadable refuses (a standing change request is unproven absent); a standing one refuses (`laterReviewHold`).
  let formal = reviews;
  if (typeof formal === 'function') { try { formal = formal(); } catch { formal = null; } }
  if (!Array.isArray(formal)) return no('the PR\'s formal reviews were not read; a standing change request is unproven absent');
  if (laterReviewHold(formal, clearance.at ?? null)) return no('a formal changes-requested review stands');
  if (typeof fingerprintOf !== 'function') return no('no trusted git fingerprint reader');
  const recorded = { diff: clearance.diff ?? null, contribution: clearance.contribution ?? null };
  const mode = equivalence === 'strict' ? 'strict' : 'contribution';

  // One content proof: X's fingerprint matches the recorded one AND the cleared change replayed onto X's base reproduces
  // X's tree. The replay compares git object ids (every byte, mode and path), so it also closes what the text digests
  // cannot see — a lossy decode (two invalid UTF-8 bytes hash alike) or a relocation (#x413mbt). Both tiers need it.
  const contentProof = (sha) => {
    let live;
    try { live = fingerprintOf(sha); } catch { live = null; }
    if (!live || (!live.diff && !live.contribution)) return no(`net diff at ${sha.slice(0, 9)} unreadable`);
    const match = compareCarryFingerprints({ mode, cleared: recorded, live });
    if (!match.same) return no(match.reason);
    let replay;
    try { replay = typeof proveReplay === 'function' ? proveReplay(cleared, sha) : null; } catch { replay = null; }
    if (!replay?.ok) return no(`${match.reason}, but the replay proof failed: ${replay?.reason || 'unproven'}`);
    return { covers: true, tier: match.tier === 'strict' ? 'fingerprint' : 'contribution', reason: `${match.reason}; ${replay.reason}` };
  };

  const direct = contentProof(head);
  if (direct.covers) return direct;
  if (!normalizeNumbering || typeof numberingProof !== 'function') return direct;
  let proof;
  try { proof = numberingProof(head); } catch { proof = null; }
  const base = String(proof?.base ?? '').toLowerCase();
  if (!proof?.ok || !SHA40.test(base)) return no(`${direct.reason}; numbering: ${proof?.reason || 'no proven drain numbering commits on top'}`);
  if (base === cleared) return { covers: true, tier: 'numbering', base, reason: `the head is the cleared head plus the drain's own numbering (${proof.reason})` };
  const below = contentProof(base);
  if (!below.covers) return no(`${direct.reason}; numbering base ${base.slice(0, 9)}: ${below.reason}`);
  return { covers: true, tier: 'numbering', base, reason: `numbering base ${base.slice(0, 9)} covered (${below.reason}); on top: ${proof.reason}` };
}

/**
 * IO (read-only git): the contiguous run of drain numbering commits at the top of `liveHead` (single-parent, exact
 * drain subject), proved commit-by-commit by numbering-carry's `proveNumberingOnlyMove` from the run's parent.
 * @returns {{ok:boolean, base?:string, reason:string}}
 */
export function proveTopNumbering({ exec, liveHead, mainRef = 'origin/main', cwd, prove = proveNumberingOnlyMove } = {}) {
  try {
    if (typeof exec !== 'function' || !SHA40.test(String(liveHead ?? ''))) return { ok: false, reason: 'no git reader or head' };
    const git = (args) => String(exec('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...(cwd ? { cwd } : {}) }) ?? '');
    let at = liveHead;
    let count = 0;
    for (;;) {
      const [sha, ...parents] = git(['rev-list', '-1', '--parents', at]).trim().split(/\s+/);
      if (sha !== at || parents.length !== 1) break;
      const subject = git(['log', '-1', '--format=%s', at]).replace(/\n$/, '');
      if (!NUMBERING_SUBJECT_RE.test(subject)) break;
      count += 1;
      if (count > MAX_NUMBERING_COMMITS) return { ok: false, reason: `more than ${MAX_NUMBERING_COMMITS} numbering commits on top` };
      at = parents[0];
    }
    if (!count) return { ok: false, reason: 'the live head is not a drain numbering commit' };
    const proof = prove({ exec, fromSha: at, toSha: liveHead, mainRef, cwd });
    return proof?.ok ? { ok: true, base: at, reason: proof.reason } : { ok: false, reason: proof?.reason || 'numbering proof refused' };
  } catch (e) {
    return { ok: false, reason: `numbering read failed: ${String(e?.message ?? e).split('\n')[0]}` };
  }
}

/**
 * IO: the trusted git-side injections for {@link clearanceCovers}. `readNetDiff(sha)` must be the pinned net-diff read
 * (`merge-ai-prs.mjs#readNetDiffAtHead` — the same reader `review-set-label` stamps the clearance from) and return
 * `{text, scored, rev}`; anything unscored, or a diff read at another commit, is unreadable.
 */
export function gitClearanceProofs({ exec, cwd, mainRef = 'origin/main', readNetDiff } = {}) {
  const run = typeof exec === 'function' ? (cmd, args, opts) => exec(cmd, args, { ...(cwd ? { cwd } : {}), ...opts }) : null;
  return {
    fingerprintOf: (sha) => {
      const net = typeof readNetDiff === 'function' ? readNetDiff(sha) : null;
      if (!net?.scored || String(net.rev ?? '').toLowerCase() !== String(sha).toLowerCase()) return null;
      const fp = liveCarryFingerprints(net.text);
      return fp.diff || fp.contribution ? fp : null;
    },
    proveReplay: (fromSha, toSha) => (run ? proveTreeReplay({ exec: run, fromSha, toSha, mainRef }) : { ok: false, reason: 'no git reader' }),
    numberingProof: (liveHead) => (run ? proveTopNumbering({ exec: run, liveHead, mainRef }) : { ok: false, reason: 'no git reader' }),
  };
}

/**
 * IO convenience for readers: the recorded clearance on `comments`, and whether it covers `liveHead`, under the
 * resolved settings (logged once). `proofs` is {@link gitClearanceProofs} output (or a test double).
 * @returns {{clearance:object|null, covers:boolean, tier?:string, reason:string}}
 */
export function readClearanceCoverage({ comments, liveHead, proofs = {}, settings = resolveClearanceBindingSettings(),
  equivalence = 'contribution', reviews = undefined, log = (s) => process.stderr.write(s) } = {}) {
  logClearanceBindingSettings(settings, log);
  // bindTo=sha restores the parent behaviour exactly: only the LATEST accept-shaped record counts (a later plain accept
  // hides an older clearance, `parseLatestHumanClearedSha`), and only at its own sha.
  if ((settings?.bindTo?.value ?? 'fingerprint') !== 'fingerprint') {
    const head = String(liveHead ?? '').toLowerCase();
    const latest = parseLatestHumanClearedSha(comments);
    const covers = !!latest && SHA40.test(head) && latest === head;
    return { clearance: covers ? latestOperatorClearanceRecord(comments) : null, covers, liveHead: head,
      ...(covers ? { tier: 'sha' } : {}), reason: covers ? 'the latest clearance names the live head' : `review.clearance.bindTo=${settings?.bindTo?.value}: sha binding only` };
  }
  const clearance = latestOperatorClearanceRecord(comments);
  if (!clearance) return { clearance: null, covers: false, liveHead: String(liveHead ?? '').toLowerCase(), reason: 'no recorded operator clearance' };
  const verdict = clearanceCovers({ clearance, liveHead, ...proofs, equivalence, reviews,
    bindTo: settings?.bindTo?.value ?? 'fingerprint', normalizeNumbering: settings?.normalizeNumbering?.value !== false });
  return { clearance, ...verdict };
}

/**
 * IO (read-only git, one fetch of a missing object): the PR's net diff at `sha` vs its merge-base with `mainRef` — the
 * exact command `merge-ai-prs.mjs#computeNetDiffText` runs on its merge-base basis (`git diff --no-ext-diff <base> <sha>`),
 * so its fingerprints equal the ones `review-set-label` stamps. For readers that cannot load merge-ai-prs.mjs.
 * @returns {{text:string, scored:boolean, rev:string|null, reason?:string}}
 */
export function gitNetDiffAt({ exec, sha, mainRef = 'origin/main' } = {}) {
  const miss = (reason) => ({ text: '', scored: false, rev: null, reason });
  try {
    if (typeof exec !== 'function' || !SHA40.test(String(sha ?? '').toLowerCase())) return miss('no git reader or sha');
    const readable = ensureCommitReadable({ exec, sha });
    if (!readable.ok) return miss(readable.reason);
    const git = (args) => String(exec('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }) ?? '');
    const base = git(['merge-base', '--end-of-options', mainRef, sha]).split('\n')[0].trim();
    if (!SHA40.test(base)) return miss('merge-base unreadable');
    const text = git(['-c', 'diff.relative=false', 'diff', '--no-ext-diff', '--no-relative', '--end-of-options', base, sha]);
    return { text, scored: true, rev: String(sha).toLowerCase() };
  } catch (e) { return miss(`net diff unreadable: ${String(e?.message ?? e).split('\n')[0]}`); }
}

/**
 * IO: the whole coverage read for a reader with a git checkout of the repo (`cwd`, default the process's). Cheap when
 * the sha rule already answers (no clearance, or it names the head): no git is run. Never throws.
 */
export function computeClearanceCoverage({ comments, liveHead, exec, cwd, mainRef = 'origin/main', readNetDiff = null,
  settings, log, reviews = undefined } = {}) {
  const head = String(liveHead ?? '').toLowerCase();
  try {
    const opts = { ...(settings ? { settings } : {}), ...(log ? { log } : {}), reviews };
    const clearance = latestOperatorClearanceRecord(comments);
    if (!clearance || clearance.sha === head || typeof exec !== 'function') return readClearanceCoverage({ comments, liveHead: head, ...opts });
    const run = (cmd, args, o) => exec(cmd, args, { ...(cwd ? { cwd } : {}), ...o });
    const reader = typeof readNetDiff === 'function' ? readNetDiff : (sha) => gitNetDiffAt({ exec: run, sha, mainRef });
    return readClearanceCoverage({ comments, liveHead: head, proofs: gitClearanceProofs({ exec: run, mainRef, readNetDiff: reader }),
      equivalence: resolveCarryEquivalenceSetting().value, ...opts });
  } catch (e) {
    return { clearance: null, covers: false, liveHead: head, reason: `clearance coverage unreadable: ${String(e?.message ?? e).split('\n')[0]}` };
  }
}

/**
 * IO: a lazy reader of a PR's formal reviews (the same `gh api …/reviews` read the label provider uses), for coverage
 * callers that hold no review list. Throws on a miss; `clearanceCovers` turns that into "not covered".
 */
export function ghFormalReviewsReader({ exec, repo, pr } = {}) {
  return () => {
    if (typeof exec !== 'function' || !pr) throw new Error('no gh reader');
    const out = exec('gh', GH_ARGV.readPrReviews(repo || '{owner}/{repo}', pr), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
    const reviews = parseJsonLines(String(out ?? ''));
    if (!Array.isArray(reviews)) throw new Error('formal reviews read returned no array');
    return reviews;
  };
}

/**
 * IO (git): replay the cleared change onto the live head's merge-base with main and compare root trees with PLUMBING
 * (`diff-tree -r -z --no-renames --ignore-submodules=none`, no relative/external/textconv), so no diff configuration or
 * working directory can hide a changed path. Only the exact root `.lane-manifest.json` is ignored (the shared transient
 * list). Any conflict, unreadable object or git failure refuses. `merge-tree --write-tree` writes only loose objects.
 * @returns {{ok:boolean, reason:string}}
 */
export function proveTreeReplay({ exec, fromSha, toSha, mainRef = 'origin/main', transient = TRANSIENT_CARRY_PATHS } = {}) {
  try {
    if (typeof exec !== 'function' || !SHA40.test(String(fromSha ?? '')) || !SHA40.test(String(toSha ?? ''))) return { ok: false, reason: 'no git reader or head' };
    const git = (args) => String(exec('git', ['-c', 'diff.relative=false', '-c', 'diff.noprefix=false', ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }) ?? '');
    for (const sha of [fromSha, toSha]) { const r = ensureCommitReadable({ exec, sha }); if (!r.ok) return r; }
    const oldBase = git(['merge-base', fromSha, mainRef]).trim();
    const newBase = git(['merge-base', toSha, mainRef]).trim();
    if (![oldBase, newBase].every((sha) => SHA40.test(sha))) return { ok: false, reason: 'replay merge bases unreadable' };
    let output;
    try { output = git(['merge-tree', '--write-tree', `--merge-base=${oldBase}`, newBase, fromSha]); } catch {
      return { ok: false, reason: 'replaying the cleared change onto main conflicts' };
    }
    const tree = output.split('\n')[0].trim();
    if (!SHA40.test(tree)) return { ok: false, reason: 'replay tree unreadable' };
    const liveTree = git(['rev-parse', '--verify', `${toSha}^{tree}`]).trim();
    if (!SHA40.test(liveTree)) return { ok: false, reason: 'live tree unreadable' };
    if (tree === liveTree) return { ok: true, reason: `replay of ${fromSha.slice(0, 9)} onto main ${newBase.slice(0, 9)} reproduces ${toSha.slice(0, 9)} exactly` };
    const raw = git(['diff-tree', '-r', '-z', '--no-renames', '--no-relative', '--ignore-submodules=none', '--name-only', tree, liveTree]);
    const paths = raw.split('\0').filter((p) => p && !transient.includes(p));
    if (paths.length || !raw.length) return { ok: false, reason: `the live head differs from the cleared change replayed onto main${paths.length ? ` in: ${paths.slice(0, 3).join(', ')}` : ''}` };
    return { ok: true, reason: `replay of ${fromSha.slice(0, 9)} onto main ${newBase.slice(0, 9)} reproduces ${toSha.slice(0, 9)} (transient ignored: ${transient.join(', ')})` };
  } catch (e) {
    return { ok: false, reason: `replay proof failed: ${String(e?.message ?? e).split('\n')[0]}` };
  }
}
