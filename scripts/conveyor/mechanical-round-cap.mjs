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

// Both formats must fill a whole line at column 0, as the producers write them (we:scripts/lib/review-escalation.mjs
// #buildReviewedShaMarker, the review-pr `Net basis:` line): a marker mid-line, indented or after `>` is a quote.
const REVIEWED_MARKER_LINE = new RegExp(`^<!--\\s*${REVIEWED_SHA_MARKER}:\\s*([0-9a-f]{7,40})\\s*-->\\s*$`, 'i');
// A `Net basis` line counts only in a producer's exact shape, tail included (we:scripts/operations/review-pr.mjs
// #renderVerdictWriteUp / #renderAdvisoryNote, we:scripts/lib/review-escalation.mjs's converted advisory note), only
// in the comment's LAST `---` section (every producer writes `---` after the reviewer's text and its basis line after
// that), and only in a comment whose OPENING lines name one of those producers ({@link writesNetBasis}). The opening
// is the one part free text never reaches: a verdict with no footer of its own (a red-team or policy bounce, any
// other `review-set-label` caller) ends in juror free text, which may copy a whole `---` + basis footer.
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
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const REVIEW_PR_ATTRIBUTION = new RegExp(`^Recorded by \\S.* via ${escapeRe(REVIEW_PR_CHANNEL)}\\.$`);

/**
 * Does this comment's producer write a `Net basis` footer? Read from the opening lines only: an advisory or converted
 * advisory note's lead marker, or a review-pr verdict's heading plus its attribution line naming the review-pr channel.
 */
function writesNetBasis(lines) {
  const at = lines.findIndex((l) => l.trim() !== '');
  const lead = at < 0 ? '' : lines[at].trimStart();
  if (lead.startsWith(ADVISORY_NOTE_MARKER) || lead.startsWith(CONVERTED_ADVISORY_NOTE_MARKER)) return true;
  return REVIEW_PR_HEADINGS.includes(lead.trimEnd()) && lines[at + 1] === '' && REVIEW_PR_ATTRIBUTION.test(lines[at + 2] ?? '');
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
    else if (n) out.push({ kind: 'net-basis', sha: n[1].toLowerCase(), at: i });
  }
  const basisFooter = lastRule >= 0 && writesNetBasis(lines);
  return out.filter((m) => m.kind === 'reviewed-sha' || (basisFooter && m.at > lastRule)).map(({ kind, sha }) => ({ kind, sha }));
}

/**
 * A trusted REVIEW verdict on the thread: an advisory panel note (or a converted advisory note), a review bounce, or
 * an accept (reviewed-sha marker). A mechanical bounce is not one. Shared with we:scripts/conveyor/takeover-review.mjs.
 * The shape check is deliberately loose (a quoted marker still makes it verdict-shaped, so it spends a round); what
 * the verdict judged and which kind it is are read from unquoted structure only ({@link reviewedHeadsOf}, {@link verdictKind}).
 */
export function isReviewVerdictComment(c) {
  const body = bodyOf(c);
  const lead = body.trimStart();
  const shaped = lead.startsWith(ADVISORY_NOTE_MARKER) || lead.startsWith(CONVERTED_ADVISORY_NOTE_MARKER)
    || lead.startsWith(BOUNCE_PREFIX) || ANY_REVIEWED_MARKER.test(body);
  return shaped && !isMechanicalBounce(c) && isTrustedMarkerAuthor(c);
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
 * format (`<!-- reviewed-sha: <sha> -->`, or a producer-shaped `Net basis: <base>..<head> — …` line in the last `---`
 * section of a comment whose opening lines name a basis producer — review-pr's verdict or an advisory note; 7-40 hex,
 * lower-cased). It relies on every
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
  // Fail closed both ways: a verdict that names the head in prose OR by a structured (possibly abbreviated) sha.
  if (verdicts.some((c) => lc(bodyOf(c)).includes(head) || verdictJudged(c, head))) return { ok: false, reason: 'head-already-reviewed' };
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
