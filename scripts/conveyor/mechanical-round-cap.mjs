/**
 * we:scripts/conveyor/mechanical-round-cap.mjs — a MECHANICAL round never spends a review round.
 *
 * Before (live: #4631, 2026-10-10): the takeover fix pushed a head, the parked-PR conflict watch bounced it for a
 * merge conflict with `main`, and a mechanical conflict-resolution round (merge of main, no other edits) pushed
 * f0f4943fb. The planner then refused that head as `cap-exhausted` (6/5) and nothing judged it: the conflict
 * watch's bounce read as a review verdict, so the one review the takeover head was owed (#4759) looked spent.
 *
 * Now, under `review.mechanicalRoundsCountTowardCap: false` (the standard default):
 *   - a conflict-watch bounce (a sequencing finding, not a review) is never a review verdict
 *     ({@link isReviewVerdictComment}), so it spends no review allowance;
 *   - a head produced by a PROVEN mechanical round inherits its parent head's standing at the cap:
 *       * net diff byte-identical to the parent head's, and the parent head was reviewed → that verdict is carried
 *         forward (no new review);
 *       * net diff changed only in files `main` also changed (the conflict hunks) → exactly ONE review past the
 *         cap for that head (mirrors the takeover allowance, we:scripts/conveyor/takeover-review.mjs).
 *   With the setting `true`, mechanical rounds count toward the cap like any other round.
 *
 * "Proven mechanical" needs BOTH the round's own trusted marker comment (`CONFLICT_FIX_COMMENT_MARKER`, posted by
 * `rearm-review.mjs --round=conflict`) AND git: the head is a two-parent merge whose second parent is on the PR's
 * base branch, and every file whose net diff (vs merge-base) changed is a file the base changed in the merged span.
 * A rebase-mode round, an unreadable head or any extra edit is not proven, and the normal cap applies.
 *
 * NEVER loosens the merge gate or the `review:human` ceremony: a grant only lets a REVIEW run; a carried accept is
 * applied (or not) by the accept carry-forward sweep, which owns its own proofs.
 *
 * Setting cascade (card x5wnfcg): standard default `false` → platform preference
 * (`we:scripts/lib/delivery-platform-preferences.json` `review.mechanicalRoundsCountTowardCap`) → repo override
 * (`we:scripts/review-settings.json` `mechanicalRoundsCountTowardCap`) → env `WE_REVIEW_MECHANICAL_ROUNDS_COUNT_TOWARD_CAP`.
 * The resolved value carries the layer it came from (`source`) so the daemon can log it.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { CONFLICT_FIX_COMMENT_MARKER } from './conflict-fix-round-count.mjs';
import { ADVISORY_NOTE_MARKER } from './advisory-round-count.mjs';
import { REVIEWED_SHA_MARKER, normalizeDiffFingerprint } from '../lib/review-escalation.mjs';
import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';

export const MECHANICAL_ROUNDS_SETTING = 'mechanicalRoundsCountTowardCap';
export const MECHANICAL_ROUNDS_ENV = 'WE_REVIEW_MECHANICAL_ROUNDS_COUNT_TOWARD_CAP';
export const MECHANICAL_ROUNDS_STANDARD_DEFAULT = false;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PLATFORM_PREFERENCES_PATH = resolve(ROOT, 'scripts/lib/delivery-platform-preferences.json');
export const REPO_REVIEW_SETTINGS_PATH = resolve(ROOT, 'scripts/review-settings.json');

const readJson = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };

/**
 * The policy cascade for `review.mechanicalRoundsCountTowardCap`. Each layer is a boolean or it is skipped.
 * `readPlatform`/`readRepo` are injectable for tests.
 * @returns {{value:boolean, source:'standard'|'platform'|'repo'|'env'}}
 */
export function resolveMechanicalRoundsSetting({
  env = process.env,
  readPlatform = () => readJson(PLATFORM_PREFERENCES_PATH),
  readRepo = () => readJson(REPO_REVIEW_SETTINGS_PATH),
} = {}) {
  let out = { value: MECHANICAL_ROUNDS_STANDARD_DEFAULT, source: 'standard' };
  const platform = readPlatform()?.review?.[MECHANICAL_ROUNDS_SETTING];
  if (typeof platform === 'boolean') out = { value: platform, source: 'platform' };
  const repo = readRepo()?.[MECHANICAL_ROUNDS_SETTING];
  if (typeof repo === 'boolean') out = { value: repo, source: 'repo' };
  const raw = String(env?.[MECHANICAL_ROUNDS_ENV] ?? '').trim().toLowerCase();
  if (raw === 'true' || raw === 'false') out = { value: raw === 'true', source: 'env' };
  return out;
}

const bodyOf = (c) => (typeof c === 'string' ? c : typeof c?.body === 'string' ? c.body : '');
const timeOf = (c) => { const t = Date.parse(c?.createdAt ?? ''); return Number.isFinite(t) ? t : NaN; };
const SHA40 = /^[0-9a-f]{40}$/;
const lc = (s) => String(s ?? '').trim().toLowerCase();

/** The bounce prefix every `review:changes` verdict comment leads with (a review, or a conflict-watch bounce). */
export const BOUNCE_PREFIX = '🔁 review — changes requested';
/**
 * The phrase `we:scripts/conveyor/reconcile-finding.mjs#RECONCILE_FINDING_BANNER` puts in every mechanical/sequencing
 * bounce (the parked-PR conflict watch's included). Pinned to that banner by a test; not imported, because that
 * module pulls in the whole review-set-label CLI.
 */
export const MECHANICAL_BOUNCE_PHRASE = 'not a correctness/security review verdict';

/** A sequencing/merge-conflict bounce raised by a mechanical pass: it asks for a rebase, it judges nothing. */
export function isMechanicalBounce(c) {
  const body = bodyOf(c);
  return body.trimStart().startsWith(BOUNCE_PREFIX) && body.includes(MECHANICAL_BOUNCE_PHRASE);
}

/**
 * A trusted REVIEW verdict on the thread: an advisory panel note, a review bounce, or an accept (reviewed-sha
 * marker). A mechanical bounce is not one. Shared with we:scripts/conveyor/takeover-review.mjs.
 */
export function isReviewVerdictComment(c) {
  const body = bodyOf(c);
  const lead = body.trimStart();
  const shaped = lead.startsWith(ADVISORY_NOTE_MARKER) || lead.startsWith(BOUNCE_PREFIX) || body.includes(`<!-- ${REVIEWED_SHA_MARKER}:`);
  return shaped && !isMechanicalBounce(c) && isTrustedMarkerAuthor(c);
}

/** `accept` | `changes` | `advisory` for a review verdict comment. */
export function verdictKind(c) {
  const body = bodyOf(c);
  if (body.trimStart().startsWith(BOUNCE_PREFIX)) return 'changes';
  if (body.trimStart().startsWith(ADVISORY_NOTE_MARKER)) return 'advisory';
  return 'accept';
}

const REVIEWED_MARKER_RE = new RegExp(`<!--\\s*${REVIEWED_SHA_MARKER}:\\s*([0-9a-f]{7,40})\\s*-->`, 'gi');
const NET_BASIS_RE = /Net basis: `[0-9a-f]+\.\.([0-9a-f]{7,40})`/gi;

/**
 * The commits a trusted verdict comment says it JUDGED: its structured `reviewed-sha` markers and its `Net basis:
 * <base>..<head>` heads (7-40 hex, lower-cased). A sha merely mentioned in prose ("compared against <sha>") is NOT a
 * reviewed commit and is never returned. Pure.
 */
export function reviewedHeadsOf(c) {
  const body = bodyOf(c);
  const out = [];
  for (const re of [REVIEWED_MARKER_RE, NET_BASIS_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(body)) !== null) out.push(m[1].toLowerCase());
  }
  return out;
}

/** Did this verdict judge `sha` (a full 40-hex head)? Matches a full or abbreviated structured sha, never prose. */
const verdictJudged = (c, sha) => SHA40.test(sha) && reviewedHeadsOf(c).some((h) => sha.startsWith(h));

const isMechanicalRoundMarker =(c) => bodyOf(c).trimStart().startsWith(CONFLICT_FIX_COMMENT_MARKER) && isTrustedMarkerAuthor(c);

/**
 * PURE: may the PR's CURRENT head, produced by a mechanical round, get past the review round cap?
 * `pr.mechanicalRound` is the git evidence from {@link readMechanicalRoundFacts}. Returns
 *   `{ ok: true, action: 'carry', verdict, priorHead }` — identical net diff, the parent head's verdict stands;
 *   `{ ok: true, action: 'review', priorHead, allowance: 1 }` — conflict hunks changed, one review is owed;
 *   `{ ok: false, reason }` — `counts-toward-cap`, `no-facts`, `stale-facts`, `not-mechanical`, `no-marker`,
 *   `head-already-reviewed`, `prior-head-unreviewed`, `mechanical-review-spent`.
 * @param {{pr:object, countTowardCap?:boolean}} o
 */
export function mechanicalRoundGrant({ pr, countTowardCap = MECHANICAL_ROUNDS_STANDARD_DEFAULT } = {}) {
  if (countTowardCap) return { ok: false, reason: 'counts-toward-cap' };
  const m = pr?.mechanicalRound;
  if (!m || typeof m !== 'object') return { ok: false, reason: 'no-facts' };
  const head = lc(pr?.headRefOid);
  if (!SHA40.test(head) || lc(m.head) !== head) return { ok: false, reason: 'stale-facts' };
  if (!m.proven) return { ok: false, reason: 'not-mechanical', detail: m.reason ?? null };
  const priorHead = lc(m.priorHead);
  const comments = Array.isArray(pr?.comments) ? pr.comments : [];
  const markers = comments.filter(isMechanicalRoundMarker).map(timeOf).filter(Number.isFinite);
  if (!markers.length) return { ok: false, reason: 'no-marker' };
  const roundAt = Math.max(...markers);
  const verdicts = comments.filter(isReviewVerdictComment);
  if (verdicts.some((c) => lc(bodyOf(c)).includes(head))) return { ok: false, reason: 'head-already-reviewed' };
  // A review landing after the round already used this head's allowance (it named an older sha, e.g. a stale read).
  if (verdicts.some((c) => timeOf(c) > roundAt)) return { ok: false, reason: 'mechanical-review-spent' };
  const onPrior = verdicts.filter((c) => verdictJudged(c, priorHead));
  // The parent head was never judged: the mechanical round did not take anything from it. Its own standing (a
  // takeover allowance, or the cap) governs, not this exemption.
  if (!onPrior.length) return { ok: false, reason: 'prior-head-unreviewed', priorHead };
  const prior = onPrior[onPrior.length - 1];
  if (m.netDiffIdentical === true) return { ok: true, action: 'carry', verdict: verdictKind(prior), priorHead };
  return { ok: true, action: 'review', priorHead, allowance: 1, changedFiles: Array.isArray(m.changedFiles) ? m.changedFiles : [] };
}

/** Split a unified diff into `{ header → fingerprint }` per file section. */
export function fileSectionFingerprints(diffText) {
  const out = new Map();
  let header = null; let lines = [];
  const flush = () => { if (header) out.set(header, normalizeDiffFingerprint(lines.join('\n')) ?? ''); };
  for (const line of String(diffText ?? '').split('\n')) {
    if (line.startsWith('diff --git ')) { flush(); header = line; lines = [line]; } else if (header) lines.push(line);
  }
  flush();
  return out;
}
const pathOfHeader = (h) => { const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(h); return m ? m[2] : h; };

const SAFE_REF = /^[A-Za-z0-9._/-]+$/;

/**
 * IO: the git evidence for {@link mechanicalRoundGrant}. Never throws; any read failure is `proven: false`.
 * @param {{pr:object, defaultBranch?:string, remote?:string, exec?:Function}} o
 */
export function readMechanicalRoundFacts({ pr, defaultBranch = 'main', remote = 'origin', exec = execFileSync } = {}) {
  const head = lc(pr?.headRefOid);
  const fail = (reason, extra = {}) => ({ head, proven: false, reason, ...extra });
  if (!SHA40.test(head)) return fail('no-head');
  const base = String(pr?.baseRefName || defaultBranch);
  const headRef = String(pr?.headRefName ?? '');
  if (!SAFE_REF.test(base) || base.startsWith('-') || (headRef && (!SAFE_REF.test(headRef) || headRef.startsWith('-')))) return fail('unsafe-ref');
  const git = (args) => String(exec('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, maxBuffer: 256 * 1024 * 1024 }) ?? '');
  const baseRef = `${remote}/${base}`;
  try {
    git(['fetch', '--quiet', '--no-tags', '--end-of-options', remote, `+${base}:refs/remotes/${remote}/${base}`,
      ...(headRef ? [`+${headRef}:refs/remotes/${remote}/${headRef}`] : [])]);
  } catch { /* a failed fetch degrades to what is cached; the reads below are the real probe */ }
  try {
    const parents = git(['rev-list', '--parents', '-n', '1', '--end-of-options', head]).trim().split(/\s+/);
    if (parents.length !== 3) return fail('not-a-merge');
    const [, priorHead, merged] = parents;
    try { git(['merge-base', '--is-ancestor', '--end-of-options', merged, baseRef]); } catch { return fail('merged-parent-not-on-base', { priorHead }); }
    const mbPrior = git(['merge-base', '--end-of-options', baseRef, priorHead]).split('\n')[0].trim();
    const mbHead = git(['merge-base', '--end-of-options', baseRef, head]).split('\n')[0].trim();
    const diffPrior = git(['diff', '--no-ext-diff', '--end-of-options', mbPrior, priorHead]);
    const diffHead = git(['diff', '--no-ext-diff', '--end-of-options', mbHead, head]);
    const fpPrior = normalizeDiffFingerprint(diffPrior);
    const fpHead = normalizeDiffFingerprint(diffHead);
    const identical = !!fpPrior && fpPrior === fpHead;
    const a = fileSectionFingerprints(diffPrior); const b = fileSectionFingerprints(diffHead);
    const changed = [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k)).map(pathOfHeader);
    const baseChanged = new Set(git(['diff', '--no-ext-diff', '--name-only', '--end-of-options', mbPrior, merged]).split('\n').map((s) => s.trim()).filter(Boolean));
    const outside = changed.filter((f) => !baseChanged.has(f));
    const proven = identical || outside.length === 0;
    return {
      head, priorHead, merged, netDiffIdentical: identical, changedFiles: changed, proven,
      ...(proven ? {} : { reason: 'edits-outside-conflict-files', outside }),
    };
  } catch (e) {
    return fail('git-read-failed', { error: String(e?.message ?? e).split('\n')[0] });
  }
}

/** The cheap pre-filter: a trusted mechanical-round marker is the latest round event after the latest verdict. */
export function hasPendingMechanicalRound(pr) {
  const comments = Array.isArray(pr?.comments) ? pr.comments : [];
  const markers = comments.filter(isMechanicalRoundMarker).map(timeOf).filter(Number.isFinite);
  if (!markers.length) return false;
  const verdicts = comments.filter(isReviewVerdictComment).map(timeOf).filter(Number.isFinite);
  return Math.max(...markers) > (verdicts.length ? Math.max(...verdicts) : -Infinity);
}

/** IO: attach `mechanicalRound` facts to each PR whose latest round was mechanical. Never throws. */
export function enrichPrsWithMechanicalRound(prs, { defaultBranch = 'main', readFacts = readMechanicalRoundFacts } = {}) {
  return (Array.isArray(prs) ? prs : []).map((pr) => {
    if (!hasPendingMechanicalRound(pr)) return pr;
    try { return { ...pr, mechanicalRound: readFacts({ pr, defaultBranch }) }; } catch { return pr; }
  });
}
