import { parseCardSquashMarkers, squashPatchHash } from '../lib/card-squash-marker.mjs';
import { CARD_SQUASH_SUBJECT, cardTreeOnly } from '../lib/card-squash-rebuild.mjs';
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
import { REVIEWED_SHA_MARKER, CONVERTED_ADVISORY_NOTE_MARKER, REVIEW_PR_CHANNEL, normalizeDiffFingerprint } from '../lib/review-escalation.mjs';
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
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The bounce prefix every `review:changes` verdict comment leads with (a review, or a conflict-watch bounce). */
export const BOUNCE_PREFIX = '🔁 review — changes requested';
/**
 * The phrase `we:scripts/conveyor/reconcile-finding.mjs#RECONCILE_FINDING_BANNER` puts in every mechanical/sequencing
 * bounce (the parked-PR conflict watch's included). Pinned to that banner by a test; not imported, because that
 * module pulls in the whole review-set-label CLI.
 */
export const MECHANICAL_BOUNCE_PHRASE = 'not a correctness/security review verdict';
// The banner's first line, exactly, and the actor suffix `reconcile-finding.mjs#defaultReconcileActor` always writes.
// Both pinned to the producer by a test.
export const MECHANICAL_BOUNCE_LEAD = `**⚠️ Sequencing / cross-cutting-concern finding — ${MECHANICAL_BOUNCE_PHRASE}.**`;
export const MECHANICAL_ACTOR = 'a mechanical reconciliation pass';
const MECHANICAL_ATTRIBUTION = new RegExp(`^Recorded by (?:\\S.* \\(${escapeRe(MECHANICAL_ACTOR)}\\)|${escapeRe(MECHANICAL_ACTOR)}) via \\S.*\\.$`);

/**
 * A sequencing/merge-conflict bounce raised by a mechanical pass: it asks for a rebase, it judges nothing. Read from
 * the opening lines only, in reconcile-finding's exact layout (we:scripts/review-set-label.mjs#buildVerdictComment):
 * the bounce heading, a blank line, `Recorded by <agent> (a mechanical reconciliation pass) via <channel>.`, a blank
 * line, then the banner's first line. The phrase anywhere else (a juror quoting PR text in a real bounce) is free text
 * and never turns a verdict into a non-verdict.
 */
export function isMechanicalBounce(c) {
  const lines = bodyOf(c).split('\n').map((raw) => (raw.endsWith('\r') ? raw.slice(0, -1) : raw));
  const at = lines.findIndex((l) => l.trim() !== '');
  return at >= 0 && lines[at].trim() === BOUNCE_PREFIX && lines[at + 1] === ''
    && MECHANICAL_ATTRIBUTION.test(lines[at + 2] ?? '') && lines[at + 3] === '' && lines[at + 4] === MECHANICAL_BOUNCE_LEAD;
}

// Both formats must fill a whole line at column 0, as the producers write them (we:scripts/lib/review-escalation.mjs
// #buildReviewedShaMarker, the review-pr `Net basis:` line): a marker mid-line, indented or after `>` is a quote.
const REVIEWED_MARKER_LINE = new RegExp(`^<!--\\s*${REVIEWED_SHA_MARKER}:\\s*([0-9a-f]{7,40})\\s*-->\\s*$`, 'i');
// A `Net basis` line counts only in a producer's exact shape, tail included (we:scripts/operations/review-pr.mjs
// #renderVerdictWriteUp / #renderAdvisoryNote, we:scripts/lib/review-escalation.mjs's converted advisory note), only
// in a comment whose OPENING lines name one of those producers, and only at that producer's fixed footer slot
// ({@link basisSlot}). The opening is the one part free text never reaches: a verdict with no footer of its own (a
// red-team or policy bounce, any other `review-set-label` caller) ends in juror free text, which may copy a whole
// `---` + basis footer. The fixed slot keeps out free text a producer itself renders below its own `---` (review-pr's
// skipped-seat reasons carry a juror's error text, and a degraded or unpinned basis leaves no real line to outrank it).
const NET_BASIS_LINES = [
  /^Net basis: `[0-9a-f]+\.\.([0-9a-f]{7,40})`(?: \(rev `[^`]*` at review time\))? — \d+ net changed file\(s\) vs current main\b/i,
  /^Net basis: `([0-9a-f]{7,40})\.\.\1` \(this head; no fresh diff computed\b/i,
];
const SECTION_RULE = /^---[ \t]*$/;
// A Markdown fence: at most 3 spaces of indent; a backtick fence's info string holds no backtick (```a``` is inline code).
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
// Any spelling of the marker, quoted or not: only the loose "is this verdict-shaped" check reads it (fail closed).
const ANY_REVIEWED_MARKER = new RegExp(`<!--\\s*${REVIEWED_SHA_MARKER}:`, 'i');

// review-pr's `record` posts through we:scripts/review-set-label.mjs#buildVerdictComment: its heading, a blank line,
// then `Recorded by <actor> via <channel>.`, all written before any caller body.
const REVIEW_PR_HEADINGS = [BOUNCE_PREFIX, '✅ review — accepted'];
const REVIEW_PR_ATTRIBUTION = new RegExp(`^Recorded by \\S.* via ${escapeRe(REVIEW_PR_CHANNEL)}\\.$`);
// The write-up's own last line, then (an accept only) buildVerdictComment's `<!-- … -->` marker block.
export const REVIEW_PR_FOOTER = `_Recorded through ${REVIEW_PR_CHANNEL}._`;
// One whole line shaped `<!-- … -->`. Tested by prefix/suffix, not a comment-matching regexp (CodeQL js/bad-tag-filter):
// this is a line classifier on text already split at `\n`, never an HTML sanitizer. A line terminator inside the line
// (`\r`, U+2028, U+2029) still disqualifies it, exactly as `.` did.
const LINE_TERMINATOR = new RegExp("[\\r\\u2028\\u2029]");
const isMarkerCommentLine = (line) => line.length >= 7 && line.startsWith('<!--') && line.endsWith('-->') && !LINE_TERMINATOR.test(line);

/**
 * The one line index where this comment's producer writes its `Net basis` line, or -1. The producer is read from the
 * opening lines only; the slot is fixed by that producer's own layout:
 *   - an advisory / converted advisory note (lead marker): `---`, a blank line, then the basis line;
 *   - a review-pr verdict (heading, blank, `Recorded by … via <review-pr channel>.`): the basis line, a blank line, then
 *     {@link REVIEW_PR_FOOTER} as the write-up's last line (only marker lines may follow it).
 * No other line of the comment names a head, whatever it looks like.
 */
function basisSlot(lines, lastRule) {
  const at = lines.findIndex((l) => l.trim() !== '');
  const lead = at < 0 ? '' : lines[at].trimStart();
  if (lead.startsWith(ADVISORY_NOTE_MARKER) || lead.startsWith(CONVERTED_ADVISORY_NOTE_MARKER)) {
    return lastRule >= 0 && lines[lastRule + 1] === '' ? lastRule + 2 : -1;
  }
  if (!(REVIEW_PR_HEADINGS.includes(lead.trimEnd()) && lines[at + 1] === '' && REVIEW_PR_ATTRIBUTION.test(lines[at + 2] ?? ''))) return -1;
  let end = lines.length - 1;
  while (end > at && (lines[end].trim() === '' || isMarkerCommentLine(lines[end]))) end -= 1;
  return lines[end] === REVIEW_PR_FOOTER && lines[end - 1] === '' && end - 2 > lastRule && lastRule > at ? end - 2 : -1;
}

const fenceOf = (line) => {
  const f = FENCE_LINE.exec(line);
  return f && !(f[1][0] === '`' && f[2].includes('`')) ? { ch: f[1][0], len: f[1].length, closer: !f[2].trim() } : null;
};

/**
 * The structured marker lines of a comment, in order, that are NOT quoted: a closed fenced code block, a blockquote,
 * an indented or mid-line marker, or a line joined by U+2028 (only `\n` ends a line) never count. A fence that never
 * closes hides nothing: reviewer text opening one must not swallow the producer's footer appended after it. Linear:
 * whether an opener closes is read from a suffix table, never by rescanning.
 * @returns {{kind:'reviewed-sha'|'net-basis', sha:string}[]}
 */
function structuredMarkerLines(body) {
  const lines = body.split('\n').map((raw) => (raw.endsWith('\r') ? raw.slice(0, -1) : raw));
  const fences = lines.map(fenceOf);
  // longestCloser[ch][i]: the longest closing fence of `ch` at or after line i.
  const longestCloser = { '`': new Array(lines.length + 1).fill(0), '~': new Array(lines.length + 1).fill(0) };
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    for (const ch of ['`', '~']) longestCloser[ch][i] = longestCloser[ch][i + 1];
    const f = fences[i];
    if (f?.closer) longestCloser[f.ch][i] = Math.max(longestCloser[f.ch][i], f.len);
  }
  const out = [];
  let lastRule = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const f = fences[i];
    if (f) {
      if (longestCloser[f.ch][i + 1] >= f.len) {
        i += 1;
        while (!(fences[i]?.closer && fences[i].ch === f.ch && fences[i].len >= f.len)) i += 1;
      }
      continue;
    }
    const line = lines[i];
    if (SECTION_RULE.test(line)) { lastRule = i; continue; }
    const s = REVIEWED_MARKER_LINE.exec(line);
    const n = s ? null : NET_BASIS_LINES.map((re) => re.exec(line)).find(Boolean);
    if (s) out.push({ kind: 'reviewed-sha', sha: s[1].toLowerCase(), at: i });
    else if (n) out.push({ kind: 'net-basis', sha: n[1].toLowerCase(), at: i, line });
  }
  const slot = basisSlot(lines, lastRule);
  return out.filter((m) => m.kind === 'reviewed-sha' || m.at === slot).map(({ kind, sha, line }) => ({ kind, sha, line }));
}

/**
 * The producer's own `Net basis` line at the fixed footer slot (the one {@link reviewedHeadsOf} may read), as
 * `{sha, line}`, or null. A quoted, fenced or juror-written basis line is never returned. Pure.
 */
export function basisLineOf(c) {
  const m = structuredMarkerLines(bodyOf(c)).find((row) => row.kind === 'net-basis');
  return m ? { sha: m.sha, line: m.line } : null;
}

/**
 * A trusted REVIEW verdict on the thread: an advisory panel note (or a converted advisory note), a review bounce, or
 * an accept (reviewed-sha marker). A mechanical bounce is not one. Shared with we:scripts/conveyor/takeover-review.mjs.
 * The shape check is deliberately loose (a quoted marker still makes it verdict-shaped, so it spends a round); what
 * the verdict judged and which kind it is are read from unquoted structure only ({@link reviewedHeadsOf}, {@link verdictKind}).
 */
export function isReviewVerdictComment(c) {
  if (!isTrustedMarkerAuthor(c)) return false;
  const body = bodyOf(c);
  const lead = body.trimStart();
  const shaped = lead.startsWith(ADVISORY_NOTE_MARKER) || lead.startsWith(CONVERTED_ADVISORY_NOTE_MARKER)
    || lead.startsWith(BOUNCE_PREFIX) || ANY_REVIEWED_MARKER.test(body);
  return shaped && !isMechanicalBounce(c);
}

/**
 * `accept` | `changes` | `advisory` for a review verdict comment. `accept` needs the accept stamp itself — an
 * UNQUOTED `reviewed-sha` marker line: a converted advisory note quotes the prior accept verbatim (`> <!-- reviewed-sha
 * … -->`) and may report blocking findings, so a quoted stamp is never an accept.
 */
export function verdictKind(c) {
  const body = bodyOf(c);
  const lead = body.trimStart();
  if (lead.startsWith(BOUNCE_PREFIX)) return 'changes';
  if (lead.startsWith(ADVISORY_NOTE_MARKER) || lead.startsWith(CONVERTED_ADVISORY_NOTE_MARKER)) return 'advisory';
  return structuredMarkerLines(body).some((m) => m.kind === 'reviewed-sha') ? 'accept' : 'advisory';
}

/**
 * The commit a trusted verdict comment says it JUDGED: the head of its LAST unquoted structured marker line, of either
 * format (`<!-- reviewed-sha: <sha> -->`, or a producer-shaped `Net basis: <base>..<head> — …` line at the fixed
 * footer slot of a comment whose opening lines name a basis producer — review-pr's verdict or an advisory note; 7-40
 * hex, lower-cased). It relies on every
 * producer appending that footer LAST, after any quoted text, so a quoted earlier one never wins. One head, never one
 * per format: a quoted `Net basis` naming the parent must not ride along with a real `reviewed-sha` footer for another
 * commit. A sha merely mentioned in prose is never returned. An advisory or converted advisory note never stamps a
 * `reviewed-sha` line (the converted note only `>`-quotes the prior accept) and is posted without
 * we:scripts/review-set-label.mjs#buildVerdictComment's `<!--` escaping, so on one only its `Net basis` names a head:
 * juror text there could otherwise forge an unquoted stamp. Pure.
 * @returns {string[]} zero or one head
 */
export function reviewedHeadsOf(c) {
  const body = bodyOf(c);
  const lead = body.trimStart();
  const advisory = lead.startsWith(ADVISORY_NOTE_MARKER) || lead.startsWith(CONVERTED_ADVISORY_NOTE_MARKER);
  const last = structuredMarkerLines(body).filter((m) => !(advisory && m.kind === 'reviewed-sha')).at(-1);
  return last ? [last.sha] : [];
}

/** Did this verdict judge `sha` (a full 40-hex head)? Matches a full or abbreviated structured sha, never prose. */
export const verdictJudged = (c, sha) => SHA40.test(sha) && reviewedHeadsOf(c).some((h) => sha.startsWith(h));

const isMechanicalRoundMarker = (c) => isTrustedMarkerAuthor(c) && bodyOf(c).trimStart().startsWith(CONFLICT_FIX_COMMENT_MARKER);

/** Latest mechanical candidate, independent of input order. Incomplete or tied chronology grants nothing. */
function latestMechanicalRoundAt(comments) {
  let mechanicalAt = -Infinity;
  let ordinaryAt = -Infinity;
  for (const c of comments) {
    if (!isTrustedMarkerAuthor(c)) continue;
    const mechanical = isMechanicalRoundMarker(c);
    const ordinary = isRearmMarker(c);
    if (!mechanical && !ordinary && !isReviewVerdictComment(c)) continue;
    const at = timeOf(c);
    if (!Number.isFinite(at)) return null;
    if (mechanical) mechanicalAt = Math.max(mechanicalAt, at);
    if (ordinary) ordinaryAt = Math.max(ordinaryAt, at);
  }
  return mechanicalAt > ordinaryAt ? mechanicalAt : null;
}

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
  const roundAt = latestMechanicalRoundAt(comments);
  if (roundAt === null) return { ok: false, reason: 'no-marker' };
  const verdicts = comments.filter(isReviewVerdictComment);
  // Fail closed both ways: a verdict that names the head in prose OR by a structured (possibly abbreviated) sha.
  if (verdicts.some((c) => lc(bodyOf(c)).includes(head) || verdictJudged(c, head))) return { ok: false, reason: 'head-already-reviewed' };
  // A review landing after the round already used this head's allowance (it named an older sha, e.g. a stale read).
  if (verdicts.some((c) => timeOf(c) >= roundAt)) return { ok: false, reason: 'mechanical-review-spent' };
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
// Keep in sync with lib/rebase-drop-manifest.mjs#LANE_MANIFEST (the drain rebase drops it); importing it here would
// pull fix-procedure into this module. Pinned by mechanical-rebase-rounds.test.mjs.
export const LANE_MANIFEST = '.lane-manifest.json';

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

/**
 * IO: collect the PR's own line for review-round accounting. Author dates survive rebases.
 * A drain rebase merge puts main first and the branch LAST; ordinary merges keep the branch first.
 * Every merge on the line carries `mergesPrWork`: true when a merged-in parent is reachable from neither the base
 * nor the default branch (a repair branch merged --no-ff), so its fix commits off the line are never read as a
 * mechanical round. It is also true when the merge's own tree is not git's clean merge of its parents: a repair
 * folded into an upstream merge (`--no-commit`, then edit), a conflict resolution, a reverted upstream hunk, or an
 * octopus merge all carry content no parent brought, so only a merge git reproduces exactly (bar the drain's dropped
 * lane manifest) is mechanical. Missing/malformed git data and a truncated walk fail closed, never a partial proof.
 */
export function readRoundCommits({ pr, defaultBranch = 'main', remote = 'origin', exec = execFileSync } = {}) {
  const head = lc(pr?.headRefOid);
  const fail = (reason) => ({ head, ok: false, reason });
  if (!SHA40.test(head)) return fail('no-head');
  const base = String(pr?.baseRefName || defaultBranch);
  const headRef = String(pr?.headRefName ?? '');
  if ([base, remote, defaultBranch, ...(headRef ? [headRef] : [])].some((ref) => !SAFE_REF.test(ref) || ref.startsWith('-'))) return fail('unsafe-ref');
  const git = (args) => String(exec('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, maxBuffer: 256 * 1024 * 1024 }) ?? '');
  const readRange = (upstream) => {
    const text = git(['log', '--format=%H%x00%P%x00%T%x00%aI%x00%s', '--end-of-options', `${remote}/${upstream}..${head}`]);
    const map = new Map();
    for (const line of text.split('\n').filter(Boolean)) {
      const fields = line.split('\0');
      if (fields.length !== 5) return null;
      const [sha, parentText, tree, authoredAt, subject] = fields;
      const parents = parentText ? parentText.split(' ') : [];
      if (!SHA40.test(sha) || parents.some((p) => !SHA40.test(p)) || !SHA40.test(tree)
        || !Number.isFinite(Date.parse(authoredAt)) || map.has(sha)) return null;
      map.set(sha, { sha, parents, tree, authoredAt, subject });
    }
    return map;
  };
  // A merge is mechanical only when its tree is what git itself makes of its two parents: a clean `merge-tree`
  // (no conflict) whose result differs from the commit at most by the drain's dropped lane manifest. Anything else
  // (a conflict, an edit folded into the merge, an upstream hunk reverted, three or more parents, an unreadable
  // result) carries content no parent brought, so it is the PR's own work. Never throws.
  const reproducesCleanMerge = (commit) => {
    if (commit.parents.length !== 2) return false;
    try {
      const out = git(['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', '--end-of-options', ...commit.parents]);
      const [tree, ...conflicted] = out.split('\0');
      if (!SHA40.test(tree) || conflicted.some(Boolean)) return false;
      if (tree === commit.tree) return true;
      // Only the manifest's DELETION is the drain's: an added or edited manifest is content no parent brought.
      const changed = git(['diff', '--no-ext-diff', '--name-status', '--no-renames', '-z', '--end-of-options', tree, commit.tree])
        .split('\0').filter(Boolean);
      return changed.length === 2 && changed[0] === 'D' && changed[1] === LANE_MANIFEST;
    } catch { return false; } // merge-tree exits 1 on a conflict: not a clean merge
  };
  try {
    git(['fetch', '--quiet', '--no-tags', '--end-of-options', remote, `+${base}:refs/remotes/${remote}/${base}`,
      ...(defaultBranch !== base ? [`+${defaultBranch}:refs/remotes/${remote}/${defaultBranch}`] : []),
      ...(headRef ? [`+${headRef}:refs/remotes/${remote}/${headRef}`] : [])]);
    const map = readRange(base);
    if (!map) return fail('invalid-commit-data');
    if (!map.has(head)) return fail('missing-head');
    // A merged-in parent is upstream when the base or the default branch reaches it (a sync, or a drain rebase of a
    // stacked PR onto main). Anything else is the PR's own work brought in off the line.
    const onDefault = defaultBranch === base ? map : readRange(defaultBranch);
    if (!onDefault) return fail('invalid-commit-data');
    const mechanicalSquash = (commit) => {
      const markers = parseCardSquashMarkers(pr?.comments).filter(m => m.newHead === commit.sha);
      if (commit.parents.length !== 1 || !CARD_SQUASH_SUBJECT.test(commit.subject) || !markers.length) return false;
      try {
        // readRange contains the PR-side range, so membership alone is NOT upstream reachability.
        git(['merge-base', '--is-ancestor', commit.parents[0], `${remote}/${defaultBranch}`]);
        const patchHash = squashPatchHash(git(['diff', '--binary', '--no-renames', '-U0', commit.parents[0], commit.sha]));
        // Shared tree proof requires 100644 blobs in this commit and in its parent if present.
        return markers.some(m => m.patchHash === patchHash) && cardTreeOnly({ run: (_cmd, args) => ({ status: 0, stdout: git(args) }),
          base: commit.parents[0], tree: commit.sha });
      } catch { return false; }
    };
    const commits = []; const seen = new Set();
    let sha = head;
    while (map.has(sha)) {
      if (commits.length >= 500 || seen.has(sha)) return fail('walk-limit');
      seen.add(sha);
      const { tree, ...commit } = map.get(sha);
      const lineParent = commit.parents.length > 1 && commit.subject.startsWith('drain: rebase')
        ? commit.parents.at(-1) : commit.parents[0];
      commits.push(commit.parents.length > 1
        ? { ...commit, mechanicalSquash: false, mergesPrWork: commit.parents.some((p) => p !== lineParent && map.has(p) && onDefault.has(p))
          || !reproducesCleanMerge({ ...commit, tree }) }
        : { ...commit, mechanicalSquash: mechanicalSquash(commit) });
      sha = lineParent;
    }
    // The walk must leave the range through a real parent (a base-side commit). A parentless last commit is a
    // root or a shallow-clone boundary: the earlier fix rounds are missing, so it proves nothing.
    if (!SHA40.test(sha ?? '')) return fail('truncated-history');
    return { head, commits };
  } catch { return fail('git-read-failed'); }
}

// Same leading-line/authorship match as countRearmComments; avoid importing its label CLI dependency.
// Pinned to REARM_COMMENT_MARKER by the enrichment regression in mechanical-rebase-rounds.test.mjs.
const isRearmMarker = (c) => isTrustedMarkerAuthor(c) && bodyOf(c).trimStart().startsWith('🔧 conveyor fix — re-armed for re-review');

/** The cheap pre-filter: a trusted mechanical-round marker is the latest round event after the latest verdict. */
export function hasPendingMechanicalRound(pr) {
  const comments = Array.isArray(pr?.comments) ? pr.comments : [];
  const roundAt = latestMechanicalRoundAt(comments);
  if (roundAt === null) return false;
  const verdicts = comments.filter(isReviewVerdictComment).map(timeOf).filter(Number.isFinite);
  return roundAt > (verdicts.length ? Math.max(...verdicts) : -Infinity);
}

// Keep in sync with reconcile-core.mjs#resolveRoundCap; importing it here would create a cycle.
function resolveRoundCap(env = process.env) {
  const value = env.WE_REVIEW_ROUND_CAP;
  return typeof value === 'string' && /^\d+$/.test(value.trim())
    && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 5;
}

/** IO: attach `mechanicalRound` facts to each PR whose latest round was mechanical. Never throws. */
export function enrichPrsWithMechanicalRound(prs, {
  defaultBranch = 'main', readFacts = readMechanicalRoundFacts, readRoundCommits: readCommits = readRoundCommits,
  roundCap = resolveRoundCap(),
} = {}) {
  return (Array.isArray(prs) ? prs : []).map((pr) => {
    let enriched = pr;
    if (hasPendingMechanicalRound(pr)) {
      try { enriched = { ...enriched, mechanicalRound: readFacts({ pr, defaultBranch }) }; } catch { /* preserve existing behavior */ }
    }
    if (Array.isArray(pr?.comments) && pr.comments.filter(isRearmMarker).length >= roundCap) {
      try { enriched = { ...enriched, roundCommits: readCommits({ pr, defaultBranch }) }; }
      catch { enriched = { ...enriched, roundCommits: { head: lc(pr?.headRefOid), ok: false, reason: 'git-read-failed' } }; }
    }
    return enriched;
  });
}
