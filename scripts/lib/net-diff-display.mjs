import { resolvePinnedDiffBasis } from './pinned-diff-basis.mjs';
/** Legacy, non-evidence display compatibility. Gates must use the basis APIs. */
import { parseNumstat, isStrictAncestor } from '../merge-ai-prs.mjs';
import { hardenedGitDiff, hardenedGitRead, verifyRenderedDiff } from './hardened-git-diff.mjs';
import { diffHunksFrom } from './review-escalation.mjs';

function basisAnswersRequest(basis, { remote, base, rev }) {
  const f = basis && basis.requestedFor;
  return !!f && f.rev === rev && f.remote === remote && f.base === base;
}

/**
 * #3343 — the ANCESTRY-derived changed-file set for `<baseRef>..<candidate>`: the numstat of the commits that
 * are reachable from the head and NOT from the base. Used ONLY when `resolveNetDiffBasis`'s merge-base lookup
 * falls through, as a narrower stand-in for the base-TIP diff (see the call site for why the base tip is unsafe
 * for the one-way human gate). `null` when git can't answer, so the caller keeps the legacy base-tip basis.
 *
 * WHAT IT MEASURES, precisely: the per-commit numstat of `baseRef..candidate`, deduplicated by path, with the
 * line counts SUMMED across commits. That is branch CHURN, not a net two-tree diff — a file edited in two
 * commits counts its lines twice, and a file edited then reverted within the branch still appears. Both are the
 * over-scoring direction (more reviewers, never fewer), which is the direction this path is allowed to err in.
 * It is NOT a replacement for the merge-base basis and is never used when that one resolves.
 *
 * `--diff-merges=first-parent` so a merge commit contributes the files it BROUGHT IN rather than nothing —
 * without it git shows no diff for a merge at all, and a lane that merged `main` in would under-report, which is
 * the one direction this must never take. Renames render exactly as `git diff --numstat` renders them (the
 * same `parseNumstat` display encoding, normalised downstream by `newPathFromNumstatEntry`).
 * A trailing `--` so a refname that also names a path can't be re-read as a pathspec.
 * @param {Function} exec  `execFileSync`-shaped
 * @param {string} baseRef
 * @param {string} candidate
 * @returns {{changedFiles:string[], diffLines:number}|null}
 */
function ancestryNetDiff(exec, baseRef, candidate) {
  let parsed;
  try {
    parsed = parseNumstat(hardenedGitDiff(exec, ['log', '--numstat', '--diff-merges=first-parent', '--pretty=format:', '--end-of-options', `${baseRef}..${candidate}`, '--'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (err) {
    if (isExecContractError(err)) throw err; // let the caller's own contract short-circuit classify it
    return null; // git can't answer (old git, unresolvable range) — caller keeps the base-tip basis
  }
  const seen = new Set();
  const changedFiles = [];
  for (const f of parsed.changedFiles) { if (!seen.has(f)) { seen.add(f); changedFiles.push(f); } }
  return { changedFiles, diffLines: parsed.diffLines };
}

function isExecContractError(err) {
  // A shape-violating `exec` (wrong arity / wrong positional meaning) fails inside Node's own argument
  // validation or the caller's body dereferencing the wrong thing — both surface as a `TypeError`. A real git
  // command failure via `execFileSync` throws a plain `Error` carrying `.status`/`.signal`, never `TypeError`.
  return err instanceof TypeError;
}

/**
 * #2890-review-fix finding 3 — EXPORTED so a caller that needs BOTH the changed-file shape and the diff TEXT
 * for one ref can resolve the basis ONCE and hand the same resolved object to both helpers (`basis` option
 * below), instead of paying two full `resolveNetDiffBasis` runs — two network fetches and two candidate probes
 * — for one ref. In-repo, `computeNetDiffSignals` is the ONE place that does this; `pr-land.mjs` and the
 * drain's scoring loop both go through it.
 *
 * The result is a plain value with no hidden state, so two helpers handed the SAME basis cannot disagree with
 * each other. #2890-review-r2 finding 1 — that is NOT the same as "cannot be wrong": a basis resolved for ref A
 * and handed to a helper called with ref B used to answer, `scored:true`, about A, silently. For
 * `computeNetDiffText` that produced `text:''` for a lane whose real diff is large — i.e. the STRONGEST
 * clearance the `diffHunks` contract can express ("computed, genuinely empty"), for the wrong branch. So the
 * basis now CARRIES the request it was resolved for (`requestedFor: {remote, base, rev}`, on the failure shape
 * too), and both helpers REFUSE a basis that does not match their own call: `reason:'basis-mismatch'`,
 * `scored:false` — a caller bug to FIX, in the same class as `'exec-contract'`, never a fallback that answers
 * about some other ref. What is provable is therefore narrower and true: one basis, one fetch, and a mismatched
 * basis is refused rather than answered.
 */
// `pinRev` resolves a commit before merge-base and every probe, disables replace objects,
// and refuses a failed fork point instead of using the legacy ancestry/base-tip fallback.
// Full SHA requests always pin, including legacy explicit false; only branch display reads may opt out.
export function resolveNetDiffBasisForDisplay({ exec, remote = 'origin', base = 'main', rev, fetchExtraRefs = [], pinRev = false } = {}) {
  const requestedFor = { remote, base, rev: rev || null };
  const fail = reason => ({ ok: false, reason, requestedFor });
  if (typeof exec !== 'function' || !rev) return fail('ref-unresolved');
  const full = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
  if (pinRev || full.test(rev)) {
    let headSha = rev;
    if (!full.test(headSha)) {
      for (const ref of [`refs/remotes/${remote}/${rev}`, `refs/heads/${rev}`]) {
        try { headSha = String(hardenedGitRead(exec, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).trim(); if (full.test(headSha)) break; }
        catch (error) { if (error instanceof TypeError) return fail('exec-contract'); }
      }
    }
    const basis = resolvePinnedDiffBasis({ exec, remote, baseRef: base, headSha });
    if (!basis.ok) return fail(basis.reason);
    return { ...basis, baseRef: basis.baseSha, diffBase: basis.mergeBaseSha, candidate: basis.headSha,
      revSha: basis.headSha, humanBasis: parseNumstat(basis.numstat), requestedFor, basisKind: 'merge-base', basisNarrowed: true };
  }
  // Historical branch displays retain their cached-ref/ancestry fallback. No gate imports this module.
  const baseRef = `refs/remotes/${remote}/${base}`;
  try { exec('git', ['fetch', '--quiet', '--end-of-options', remote, `+${base}:${baseRef}`, ...fetchExtraRefs], { stdio: ['ignore', 'ignore', 'ignore'] }); }
  catch (error) { if (error instanceof TypeError) return fail('exec-contract'); }
  for (const candidate of [`refs/remotes/${remote}/${rev}`, `refs/heads/${rev}`]) {
    let diffBase = baseRef, basisKind = 'base-tip';
    try {
      const mb = String(hardenedGitRead(exec, ['merge-base', '--end-of-options', baseRef, candidate], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) || '').split('\n')[0].trim();
      if (mb) { diffBase = mb; basisKind = 'merge-base'; }
    } catch (error) { if (error instanceof TypeError) return fail('exec-contract'); }
    let humanBasis;
    try { humanBasis = parseNumstat(hardenedGitDiff(exec, ['diff', '--numstat', '--end-of-options', diffBase, candidate], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); }
    catch (error) { if (error instanceof TypeError) return fail('exec-contract'); continue; }
    if (basisKind === 'base-tip') {
      const ancestry = ancestryNetDiff(exec, baseRef, candidate);
      if (ancestry) { humanBasis = ancestry; basisKind = 'ancestry'; }
    }
    return { ok: true, baseRef, diffBase, candidate, humanBasis, basisKind, basisNarrowed: basisKind !== 'base-tip', requestedFor };
  }
  return fail('ref-unresolved');
}

export function computeNetDiffChangedFilesForDisplay({ exec, remote = 'origin', base = 'main', baseRev = null, rev, fetchExtraRefs = [], basis: sharedBasis = null, pinRev = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(rev ?? '') } = {}) {
  pinRev = pinRev || /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(rev ?? '');
  const empty = { changedFiles: [], diffLines: 0, scored: false, humanBasisFiles: [] };
  if (typeof exec !== 'function' || !rev) return empty;
  const baseRevOk = typeof baseRev === 'string' && /^[0-9a-f]{7,64}$/i.test(baseRev);
  // #2890-review-r2 finding 1 — a shared basis must have been resolved for THIS exact request, or it is refused
  // outright. Never fall back to resolving our own here: a caller that hands in the wrong basis has a bug to
  // fix, and silently doing the right thing anyway would hide it (same posture as `'exec-contract'`).
  if (sharedBasis && !basisAnswersRequest(sharedBasis, { remote, base, rev })) return { ...empty, reason: 'basis-mismatch' };
  // #2890-review-fix finding 3 — reuse a basis the caller already resolved for this same ref (see
  // `resolveNetDiffBasis`); absent one, resolve our own exactly as before.
  const basis = sharedBasis || resolveNetDiffBasisForDisplay({ exec, remote, base, rev, fetchExtraRefs, pinRev });
  if (pinRev && basis.ok && (!basis.revSha || basis.candidate !== basis.revSha || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(basis.baseSha ?? '') || basis.baseRef !== basis.baseSha || (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(rev) && basis.revSha !== rev.toLowerCase()))) return { ...empty, reason: 'basis-mismatch' };
  // #2952 — additive: `reason` distinguishes a fixable caller-side `exec`-contract violation ('exec-contract')
  // from a legitimately absent ref ('ref-unresolved'). Existing consumers that read only `scored` are untouched.
  if (!basis.ok) return { ...empty, reason: basis.reason };
  const { candidate, humanBasis } = basis;
  // SIZE / blast-radius de-inflate to the OWN delta (`baseRev…head`) ONLY when `baseRev` provably is a STRICT
  // ancestor of head; otherwise use the cumulative basis (the safe over-scoring direction).
  let own = humanBasis;
  if (baseRevOk && isStrictAncestor(exec, baseRev, candidate)) {
    // Same class: `baseRev` is hex-validated by `baseRevOk`, `candidate` is not — it is the caller-supplied
    // refname. Every argv position in this file that takes a caller-supplied ref is now guarded; `merge-base`
    // and `rev-parse` are hardening rather than live holes (both reject an unknown option on git 2.50.1, and
    // the surrounding catch absorbs it), while the `git diff` positions are genuinely exploitable — verified.
    try { own = parseNumstat(hardenedGitDiff(exec, ['diff', '--numstat', '--end-of-options', baseRev, candidate], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); }
    catch { return { ...humanBasis, humanBasisFiles: humanBasis.changedFiles, scored: false, reason: 'diff-failed' }; }
  }
  // #3343 — the basis's `basisKind` / `basisNarrowed` are DELIBERATELY not re-exported here. This function's
  // return shape is the SIZE/blast-radius payload, asserted whole (`toEqual`) at a dozen call sites; the
  // trust question belongs to the basis object itself (`resolveNetDiffBasis`) and to `computeNetDiffSignals`,
  // which is what both production callers actually use.
  return { changedFiles: own.changedFiles, diffLines: own.diffLines, scored: true, humanBasisFiles: humanBasis.changedFiles };
}

/**
 * #2450 — the reviewer-facing NET DIFF TEXT vs CURRENT main, resolved off the SAME #2373/#2404 basis
 * `computeNetDiffChangedFiles` uses (both go through `resolveNetDiffBasis`), so the diff the drain's panel
 * reviews and the escalation SCORE share ONE basis and cannot drift. Returns the two-tree
 * `git diff <forkpoint> <head>` TEXT — content-only, ancestry-independent — NOT `gh pr diff`'s three-dot
 * merge-base diff, which still lists a sibling-lane file that has since landed on main as if THIS PR added it
 * (the phantom scope-creep that burns negotiation rounds, #2450). Degrades to `{ scored:false, text:'' }` when
 * the basis can't be resolved OR the text diff itself fails — the caller then falls back to `gh pr diff`. Like
 * `computeNetDiffChangedFiles`, it NEVER checks out the PR branch (#2336): it only fetches tracking refs and
 * diffs two trees in place. `exec(cmd,args,opts)` is injected so this stays unit-testable with a fake.
 *
 * #2952 — additive: the unscored return now also carries `reason` — `'exec-contract'` (the injected `exec` isn't
 * `(cmd, args, opts) => execFileSync(cmd, args, opts)`-shaped — a caller bug to FIX, not license to fall back),
 * `'ref-unresolved'` (neither candidate resolves — legitimately absent, unfixable, correctly falls back), or
 * `'diff-failed'` (the basis resolved but the text diff itself then failed). Existing consumers that read only
 * `scored` are untouched.
 * @param {{exec:Function, remote?:string, base?:string, rev:string, fetchExtraRefs?:string[], basis?:object|null}} opts
 *   `basis` — an already-resolved `resolveNetDiffBasis` result for this same ref (#2890-review-fix finding 3);
 *   pass it to share ONE fetch + candidate probe with `computeNetDiffChangedFiles` instead of resolving twice.
 * @returns {{text:string, base:string|null, rev:string|null, scored:boolean, needsReview?:string[], reason?:'exec-contract'|'ref-unresolved'|'diff-failed'|'basis-mismatch'}}
 */
export function computeNetDiffTextForDisplay({ exec, remote = 'origin', base = 'main', rev, fetchExtraRefs = [], basis: sharedBasis = null, pinRev = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(rev ?? '') } = {}) {
  pinRev = pinRev || /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(rev ?? '');
  const unscored = { text: '', base: null, rev: null, scored: false };
  if (typeof exec !== 'function' || !rev) return unscored;
  // #2890-review-r2 finding 1 — refuse a basis resolved for a DIFFERENT request rather than answering about the
  // wrong ref. This is the fail-open the check exists for: an unchecked wrong basis returned `scored:true` with
  // `text:''`, which the `diffHunks` contract reads as "computed, genuinely empty" — a full clearance.
  if (sharedBasis && !basisAnswersRequest(sharedBasis, { remote, base, rev })) return { ...unscored, reason: 'basis-mismatch' };
  // #2890-review-fix finding 3 — reuse a caller-resolved basis for this ref when given one (one fetch, one
  // candidate probe, shared with `computeNetDiffChangedFiles`); otherwise resolve our own exactly as before.
  const basis = sharedBasis || resolveNetDiffBasisForDisplay({ exec, remote, base, rev, fetchExtraRefs, pinRev });
  if (!basis.ok) return { ...unscored, reason: basis.reason }; // caller falls back to `gh pr diff`
  let { diffBase, candidate } = basis;
  if (pinRev && (!basis.revSha || basis.candidate !== basis.revSha || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(basis.baseSha ?? '') || basis.baseRef !== basis.baseSha ||
      (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(rev) && basis.revSha !== rev.toLowerCase()))) {
    return { ...unscored, reason: 'basis-mismatch' };
  }
  const revSha = pinRev ? basis.revSha : null;
  try {
    // Same guard, same reason — this is the reviewer-facing diff TEXT, off the same caller-supplied candidate.
    // #2890-review-r2 finding 2b — `--no-ext-diff`. A `diff.external` in the caller's git config, or a
    // `GIT_EXTERNAL_DIFF` inherited from the developer's environment (delta, difftastic — both common), REPLACES
    // git's own diff output wholesale: verified, a one-line external driver made this return
    // `{text:'HIJACKED — no hunks here\n', scored:true}`. That text now feeds `diffHunks`, the anti-test-gaming
    // scan and the reviewer panel, none of which may read a user-configurable RENDERING of the diff.
    // Readable paths remain evidence; opaque paths bind raw OIDs but cannot clear review.
    // Structural/raw verification failures still throw and invalidate this entire result.
    const needsReview = [];
    const text = String(hardenedGitDiff(exec, ['diff', '--end-of-options', diffBase, candidate], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }, { needsReview }) || '');
    return { text, ...(needsReview.length ? { needsReview } : {}), base: diffBase, rev: candidate, scored: true, ...(revSha ? { revSha, baseSha: basis.baseSha } : {}) };
  } catch (err) {
    // the text diff failed even though the basis resolved → caller falls back to `gh pr diff`
    return { ...unscored, reason: isExecContractError(err) ? 'exec-contract' : 'diff-failed' };
  }
}


export function computeNetDiffSignalsForDisplay({ exec, remote = 'origin', base = 'main', baseRev = null, rev, fetchExtraRefs = [], pinRev = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(rev ?? '') } = {}) {
  pinRev = pinRev || /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(rev ?? '');
  // Keep ancestry probes as well as hardened diffs on the original objects.
  if (pinRev && typeof exec === 'function') {
    const run = exec;
    exec = (cmd, args, opts) => run(cmd, args, { ...opts, env: { ...(opts?.env ?? process.env), GIT_NO_REPLACE_OBJECTS: '1' } });
  }
  const basis = resolveNetDiffBasisForDisplay({ exec, remote, base, rev, fetchExtraRefs, pinRev });
  const net = computeNetDiffChangedFilesForDisplay({ exec, remote, base, baseRev, rev, fetchExtraRefs, basis, pinRev });
  const netDiffText = computeNetDiffTextForDisplay({ exec, remote, base, rev, fetchExtraRefs, basis, pinRev });
  return {
    ...(basis.revSha ? { revSha: basis.revSha } : {}),
    changedFiles: net.changedFiles,
    diffLines: net.diffLines,
    humanBasisFiles: net.humanBasisFiles,
    // #3317 — the CUMULATIVE line count, the twin of `humanBasisFiles`. `basis.humanBasis` is the
    // `mergeBase(<remote>/<base>, head)…head` numstat, so this is the merge-base measurement of SIZE, which a
    // stacked/self-declared `baseRev` cannot shrink. It comes off the SAME already-resolved basis as everything
    // else here (no extra subprocess). `scoreEscalation` floors `diffLines` at it. Zero when the basis did not
    // resolve — the same degraded posture the other fields take, and `scoreEscalation`'s `max` then leaves the
    // declared count alone rather than zeroing a real signal.
    cumulativeDiffLines: basis.ok ? basis.humanBasis.diffLines : 0,
    // #3343 — which left side the cumulative basis got (`'merge-base'` | `'ancestry'` | `'base-tip'`), and
    // whether it is the PR's own file set at all. `false` ONLY for the un-narrowed base-tip fallback.
    basisKind: basis.ok ? basis.basisKind : null,
    basisNarrowed: basis.ok ? basis.basisNarrowed !== false : false,
    scored: net.scored && netDiffText.scored && !netDiffText.needsReview?.length,
    netDiffText,
    diffHunks: diffHunksFrom(netDiffText),
  };
}


export function computeNetDiffPathsForDisplay({ exec, remote = 'origin', base = 'main', rev, fetchExtraRefs = [], basis: sharedBasis = null, pinRev = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(rev ?? '') } = {}) {
  pinRev = pinRev || /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(rev ?? '');
  const unscored = { paths: [], base: null, rev: null, scored: false };
  if (typeof exec !== 'function' || !rev) return unscored;
  if (sharedBasis && !basisAnswersRequest(sharedBasis, { remote, base, rev })) return { ...unscored, reason: 'basis-mismatch' };
  const basis = sharedBasis || resolveNetDiffBasisForDisplay({ exec, remote, base, rev, fetchExtraRefs, pinRev });
  if (pinRev && basis.ok && (!basis.revSha || basis.candidate !== basis.revSha || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(basis.baseSha ?? '') || basis.baseRef !== basis.baseSha || (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(rev) && basis.revSha !== rev.toLowerCase()))) return { ...unscored, reason: 'basis-mismatch' };
  if (!basis.ok) return { ...unscored, reason: basis.reason };
  const { diffBase, candidate } = basis;
  try {
    const raw = hardenedGitDiff(exec, ['diff', '--name-only', '-z', '--end-of-options', `${diffBase}..${candidate}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const paths = String(raw || '').split('\0').filter(Boolean);
    const text = String(hardenedGitDiff(exec, ['diff', '--end-of-options', diffBase, candidate]));
    verifyRenderedDiff(exec, diffBase, candidate, text, { paths });
    return { paths, base: diffBase, rev: candidate, scored: true, ...(pinRev ? { revSha: basis.revSha, baseSha: basis.baseSha } : {}) };
  } catch (err) {
    return { ...unscored, reason: isExecContractError(err) ? 'exec-contract' : 'diff-failed' };
  }
}
