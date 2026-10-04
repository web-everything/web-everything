import { preventionCardTitle } from '../operations/machine-pr-title.mjs';
/**
 * @file scripts/lib/approval-prevention-notice.mjs
 * @description THE APPROVAL-TIME PREVENTION-FILING DEFAULT (operator, 2026-09-27, ~8:05 AM ET, verbatim:
 * "prevention outstanding should be filed by default on approval"). PURE — every function here reads rendered
 * markdown TEXT (a comment body already posted, or about to be posted) and decides what, if anything, a caller
 * should file; none of it touches `fs`/`gh`/the clock. The one impure caller is
 * `we:scripts/review-set-label.mjs#runReviewLabelCli`, the single label home every approval path passes through
 * — see that file's own header for the wiring and why THAT seam, not the drain's land step, was chosen.
 *
 * THE GAP THIS CLOSES. The #2749 mechanism (`we:scripts/lib/review-loop-policy.mjs`'s
 * `isPreventionOutstandingParked` + `buildPreventionFilingInput`, wired in `we:scripts/operations/review-loop-
 * cli.mjs`) makes the UNATTENDED review loop file ONE prevention card through the `file-item` operation, but
 * ONLY when a run's own verdict is `prevention-outstanding`. Three other places print an owed `_Prevention
 * (OWED — file it):_` line and never file anything:
 *   (a) an ADVISORY note posted on a `review:human` PR (`review-pr.mjs`'s `advise` step) — the advisory outcome
 *       can be `accept` (only the two MANDATORY lenses gate that label) while an ADVISORY lens still named an
 *       owed guard; live example: web-everything/web-everything#2800's advisory at 2026-09-27T11:24:13Z, `advisory:
 *       accepted` label live, one `codex-correctness` finding carrying `_Prevention (OWED — file it):_`.
 *   (b) an ACCEPT verdict (a human's `/review` accept, or the review-loop's own) whose findings list ONE OR
 *       MORE non-blocking owed guards — `hasUncapturedPrevention` is notice-wide (see `jury-core.mjs`'s
 *       "notice-wide, verdict-narrow split"), so a clean `accept` can still carry a guard below
 *       `PREVENTION_IMPACT_BAR`.
 *   (c) the human ceremony (`--to=clear-human`) and a plain `--to=accepted` clearance, whichever surface posted
 *       the debt (an advisory note, since a `review:human` PR's own advise step never records a verdict).
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT COVER: a `prevention-outstanding` VERDICT ITSELF.
 * {@link isPreventionOutstandingVerdictText} exists so the caller can SKIP that one case — the #2749 mechanism's
 * own rule ("file the guard(s), then resume with `accept`") already owns it end to end, entirely upstream of
 * `review-set-label.mjs` (the unattended loop never even reaches a label swap until AFTER it has filed). Running
 * this file's mechanism on that same verdict too would either double-file (no shared marker between the two
 * mechanisms) or require this file to reach into the review-loop's own bookkeeping — both worse than the clean
 * split: two verdict shapes, two owners, two independent card-builders.
 *
 * WHY THIS FILE BUILDS ITS OWN `file-item` INPUT ({@link buildApprovalPreventionFilingInput}) RATHER THAN
 * IMPORTING `we:scripts/lib/review-loop-policy.mjs#buildPreventionFilingInput`. Two reasons, one structural and
 * one purely tactical:
 *   1. IMPORTING IT WOULD CREATE A CYCLE. `review-loop-policy.mjs` imports `CONFIRM_ACTORS`/`CONFIRM_OPTIONS`
 *      from `we:scripts/operations/review-pr.mjs`, which imports `decideSetLabel`/`presentRemoveLabels` FROM
 *      `we:scripts/review-set-label.mjs` (this file's own impure caller) at ITS top level — so
 *      `review-set-label.mjs` → this file → `review-loop-policy.mjs` → `operations/review-pr.mjs` →
 *      `review-set-label.mjs` would be a genuine cycle. Node tolerates some cycles by evaluation-order luck;
 *      relying on that is exactly the fragility this repo's OWN leaf-module precedents (`reasonless-bounce.mjs`,
 *      `jury-core.mjs`) already refuse.
 *   2. IT IS A MOVING TARGET RIGHT NOW. web-everything/web-everything#2766 (open, mergeable, still under active
 *      review as this was written) substantially rewrites `buildPreventionFilingInput` in place (adds a `head`
 *      pin, `cleanFindingFile`, `preventionGuardAnchor`, `cardCoversGuard` for its own by-content dedup). Sharing
 *      that function via a cross-file move (the cycle-avoiding fix for reason 1) would put this PR and #2766 in
 *      a real conflict on the SAME lines — the operator's own instruction named it as a *risk to check for*, and
 *      the safer, smaller-blast-radius answer is: this file owns a self-contained builder, scoped to exactly
 *      what an approval-time card needs (no `head` pin — this file's OWN GH-comment marker, {@link
 *      buildApprovalPreventionMarker}, already gives it per-head idempotency a different way). The two builders
 *      may converge later; that is a deliberate follow-up, not a thing to force under conflict risk today.
 *
 * @see {@link module:advisory-labels} for {@link latestAdvisory}/{@link advisoryCoversHead}, reused rather than
 *   re-derived so "which comment is the live advisory" can never disagree between the label sweep and this file.
 * @see {@link module:jury-core} for {@link hasUncapturedPrevention} and {@link module:citation-check} for
 *   {@link IN_REPO_LOCUS} — both true leaves, reused here for the same reason: no path back to
 *   `review-set-label.mjs` or `operations/review-pr.mjs`.
 */

import { latestAdvisory, advisoryCoversHead } from './advisory-labels.mjs';
import { hasUncapturedPrevention } from './jury-core.mjs';
// PR #2805 review (security) — WE's PRs are public, so any GitHub account can post a comment shaped like this
// file's marker or like an advisory note. Every comment-scanned read below runs through the SAME trusted-author
// gate the repo's other durable markers use (epic #3383, #4140), never a body match alone.
import { isTrustedMarkerAuthor } from './marker-authorship.mjs';

/** Only the comments a trusted principal (the automation or the operator) posted. PURE. */
const trustedComments = (comments) => (Array.isArray(comments) ? comments : []).filter(isTrustedMarkerAuthor);
// #883 — every code-path reference filed into a backlog card's `scope` or BODY prose must carry its `<repo>:`
// locus prefix (the write-time `lint-locus-prefix.mjs` hook enforces this on every scaffold/file-item write, no
// exceptions) — reusing the SAME token `citation-check.mjs` already exports rather than re-typing the literal
// `'we:'` a second place could drift from.
import { IN_REPO_LOCUS } from './citation-check.mjs';
// web-everything/web-everything#2766 approval (2026-09-27) — the REAL detector the write-time gate itself runs,
// reused as the digest safety net's second pass below (mirrors `we:scripts/lib/review-loop-policy.mjs
// #buildPreventionFilingInput`'s own fix for the identical gap, landed in #2766). A true leaf like
// `citation-check.mjs` above — no path back to `review-set-label.mjs` or `operations/review-pr.mjs`.
import { findUnmarkedLocusRefs } from '../check-standards-rules.mjs';

/**
 * Does this rendered comment's OWN `**Verdict:**` line say `prevention outstanding`? PURE text match against
 * the exact label `renderPanelComment` (`we:scripts/lib/review-render.mjs`) emits for
 * `VERDICTS.PREVENTION_OUTSTANDING` (`'🚩 prevention outstanding — file the guard before accept'`) — matched on
 * the stable substring, not the emoji, so a copy-edit of the emoji alone cannot silently break this.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isPreventionOutstandingVerdictText(text) {
  return /^\*\*Verdict:\*\*.*prevention outstanding/im.test(String(text ?? ''));
}

/**
 * Does this text carry a rendered `**Verdict:**` line at all — i.e. is it a FULL panel write-up
 * (`renderPanelComment`'s own shape), not a bare ceremony comment? PURE. The caller uses this to decide whether
 * to read findings off `commentBody` itself (a real verdict write-up) or fall back to the PR's latest advisory
 * comment (a `clear-human` ceremony comment carries no findings of its own).
 *
 * @param {string} text
 * @returns {boolean}
 */
export function hasRenderedVerdictLine(text) {
  return /^\*\*Verdict:\*\*/m.test(String(text ?? ''));
}

/**
 * PARSE every OWED prevention guard out of a rendered comment body. PURE. Reads exactly the two-line shape
 * `renderFindingLine` (`we:scripts/lib/review-render.mjs`) emits for an uncaptured guard:
 *
 *   - `\`file:line\`` — summary … _[CONFIRMED]_ _[impact if unfixed: …]_
 *     - _Prevention (OWED — file it):_ <the guard text>
 *
 * A CAPTURED guard renders `_Prevention (captured):_` instead and is never matched here — this function only
 * ever returns items {@link hasUncapturedPrevention} would itself call owed, so a caller needs no second filter.
 * The file/line anchor is OPTIONAL (a finding can carry no file at all); when absent, `file`/`line` are both
 * `undefined` and {@link buildApprovalPreventionFilingInput} renders `(no file cited)` for it.
 *
 * @param {string} text
 * @returns {Array<{file?: string, line?: number, prevention: string, preventionCaptured: false}>}
 */
export function parseOwedPreventionFindings(text) {
  const OWED_LINE_RE = /^\s*-\s*_Prevention \(OWED — file it\):_\s*(.+?)\s*$/;
  // The parent bullet's OPTIONAL leading anchor: `` `file` `` or `` `file:line` `` followed by an em-dash.
  const ANCHOR_RE = /^-\s*`([^`]+?)`\s*—\s*/;
  const lines = String(text ?? '').split(/\r?\n/);
  const findings = [];
  for (let i = 1; i < lines.length; i += 1) {
    const owedMatch = OWED_LINE_RE.exec(lines[i]);
    if (!owedMatch) continue;
    const parentLine = (lines[i - 1] ?? '').trim();
    const anchorMatch = ANCHOR_RE.exec(parentLine);
    let file;
    let line;
    if (anchorMatch) {
      const raw = anchorMatch[1];
      const lineMatch = /^(.*):(\d+)$/.exec(raw);
      if (lineMatch) {
        file = lineMatch[1];
        line = Number(lineMatch[2]);
      } else {
        file = raw;
      }
    }
    findings.push({ ...(file ? { file } : {}), ...(line ? { line } : {}), prevention: owedMatch[1], preventionCaptured: false });
  }
  return findings;
}

/**
 * THE MARKER — a durable, greppable, invisible (HTML-comment) record that THIS mechanism already filed a card
 * for `<repo>#<pr>` at `<headSha>`, so a later run (a restamp, a repeated status check, a re-run of the same
 * ceremony) never files a duplicate. PURE string composition, mirroring the `reviewed-sha` marker's own shape
 * (`we:scripts/lib/review-escalation.mjs#buildReviewedShaMarker`) rather than inventing a new convention.
 *
 * @param {{headSha: string}} o
 * @returns {string}
 */
export function buildApprovalPreventionMarker({ headSha } = {}) {
  return `<!-- approval-prevention-filed:${String(headSha ?? '').toLowerCase()} -->`;
}

const MARKER_RE = /<!-- approval-prevention-filed:([0-9a-f]{7,40}) -->/gi;

/** A detached landing job's own session slug — the only shape the job/retraction markers below accept. */
const SESSION_RE = /^[A-Za-z0-9._-]{1,120}$/;
const JOB_RE = /<!-- approval-prevention-job:([A-Za-z0-9._-]{1,120}) -->/i;
const RETRACTED_RE = /<!-- approval-prevention-retracted:([0-9a-f]{7,40}):([A-Za-z0-9._-]{1,120}) -->/gi;

/**
 * #4317 advisory review (2026-09-29, codex-correctness) — the marker is posted when the detached landing job is
 * SPAWNED, not when it LANDS. So the marker comment also names that job's session slug, and a job that then
 * fails posts {@link buildApprovalPreventionRetraction} for the same head + session. A filed marker whose job
 * was retracted no longer counts ({@link hasApprovalPreventionMarkerForHead}), so the next approval on that head
 * files again instead of the guard being lost for good. Keyed by session, not by comment order: a job that fails
 * within milliseconds can post its retraction BEFORE the marker comment itself lands. `''` for an unsafe slug.
 * @param {string} session
 * @returns {string}
 */
export function buildApprovalPreventionJobMarker(session) {
  return SESSION_RE.test(String(session ?? '')) ? `<!-- approval-prevention-job:${session} -->` : '';
}

/**
 * The failed landing job's retraction of its own marker (see {@link buildApprovalPreventionJobMarker}). PURE.
 * `''` when the head is not a hex SHA or the session is not a safe slug.
 * @param {{headSha: string, session: string}} o
 * @returns {string}
 */
export function buildApprovalPreventionRetraction({ headSha, session } = {}) {
  const head = String(headSha ?? '').toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(head) || !SESSION_RE.test(String(session ?? ''))) return '';
  return `<!-- approval-prevention-retracted:${head}:${session} -->`;
}

/** The line {@link buildApprovalPreventionFilingInput} appends the card-side key to the digest with. Exported so
 *  `we:scripts/operations/land-prevention-card.mjs#boundLandPreventionCardInput` finds that line by the SAME
 *  constant, never a copy that could drift (#4317 advisory review, 2026-09-29). */
export const APPROVAL_PREVENTION_DIGEST_KEY_SEP = '\n\nIdempotency key (do not edit): ';

/** The prefix every {@link buildApprovalPreventionKey} key starts with. */
export const APPROVAL_PREVENTION_KEY_PREFIX = 'approval-prevention-key:';

/**
 * THE CARD-SIDE IDEMPOTENCY KEY — written into the filed card's own body by
 * {@link buildApprovalPreventionFilingInput}, so the card itself (not only the PR marker comment) records which
 * approval filed it. PURE. The PR marker is posted AFTER the card is filed; if that post fails, the next approval
 * attempt finds no marker, and this key is what lets the caller find the card it already filed instead of filing
 * a second one (PR #2805 review, codex-correctness finding).
 *
 * @param {{repo: string, pr: number|string, headSha: string}} o
 * @returns {string}
 */
export function buildApprovalPreventionKey({ repo, pr, headSha } = {}) {
  const repoKey = String(repo ?? '').toLowerCase(); // GitHub slugs are case-insensitive
  return `${APPROVAL_PREVENTION_KEY_PREFIX}${repoKey}#${String(pr ?? '')}@${String(headSha ?? '').toLowerCase()}`;
}

/**
 * Has THIS mechanism already filed a card for this exact head? PURE. Scans every comment body for
 * {@link buildApprovalPreventionMarker}'s own marker, tolerant of a short-SHA marker matching a full one (either
 * direction — the same prefix tolerance {@link advisoryCoversHead} already uses, so the two can never disagree
 * about what "the same head" means). A marker counts only from a trusted author ({@link isTrustedMarkerAuthor}) —
 * otherwise any commenter could suppress the filing by posting the marker string.
 *
 * A marker whose comment names a landing job ({@link buildApprovalPreventionJobMarker}) does NOT count once a
 * trusted retraction for that same head + job exists ({@link buildApprovalPreventionRetraction}) — the job
 * failed, so the guard was never filed and the next approval must retry it.
 *
 * @param {Array<{body?: string, author?: {login?: string}}>} comments
 * @param {string} headSha
 * @returns {boolean}
 */
export function hasApprovalPreventionMarkerForHead(comments, headSha) {
  const head = String(headSha ?? '').toLowerCase();
  if (!head) return false;
  const sameHead = (marked) => head.startsWith(marked) || marked.startsWith(head);
  const trusted = trustedComments(comments);
  const retracted = new Set();
  for (const comment of trusted) {
    for (const m of String(comment?.body ?? '').matchAll(RETRACTED_RE)) {
      if (sameHead(m[1].toLowerCase())) retracted.add(m[2].toLowerCase());
    }
  }
  for (const comment of trusted) {
    const body = String(comment?.body ?? '');
    const job = JOB_RE.exec(body)?.[1]?.toLowerCase();
    if (job && retracted.has(job)) continue;
    for (const m of body.matchAll(MARKER_RE)) {
      if (sameHead(m[1].toLowerCase())) return true;
    }
  }
  return false;
}

/**
 * THE DECISION: given the label swap about to land (`to`), the comment about to be posted for it, and the PR's
 * PRIOR comments, which owed findings (if any) does the approval-time mechanism owe a card for? PURE — returns
 * `null` for "nothing to file" (not an approval target, the verdict is `prevention-outstanding` and #2766 owns
 * it, or there is simply no owed guard), else `{ findings, source }`.
 *
 * TWO SOURCES, IN ORDER:
 *   1. `commentBody` ITSELF, when it carries a rendered `**Verdict:**` line — the ordinary accept path (this
 *      file's own unattended accept, or a human's `/review --answer=accept`) always renders one
 *      (`renderPanelComment` pushes it unconditionally). This is case (b) from the file header.
 *   2. The PR's LATEST advisory comment that covers `headSha`, when `commentBody` carries no verdict line at
 *      all — the `clear-human` ceremony's own comment is a bare clearance record, never a re-rendered panel, so
 *      the owed findings (if any) are wherever the advisory step already printed them. This is cases (a)/(c).
 *
 * Either source is SKIPPED (this function returns `null`) when ITS OWN text says `prevention outstanding` — see
 * the file header for why that verdict shape is out of scope here.
 *
 * @param {{to: string, commentBody?: string, prComments?: Array<{body?: string, createdAt?: string}>,
 *   headSha?: string}} o
 * @returns {{findings: Array<object>, source: ('verdict-comment'|'advisory')}|null}
 */
export function selectApprovalPreventionFindings({ to, commentBody = '', prComments = [], headSha = '' } = {}) {
  if (to !== 'accepted' && to !== 'clear-human') return null;
  if (hasRenderedVerdictLine(commentBody)) {
    if (isPreventionOutstandingVerdictText(commentBody)) return null;
    const findings = parseOwedPreventionFindings(commentBody);
    return findings.length ? { findings, source: 'verdict-comment' } : null;
  }
  // Trusted authors only: a forged, later advisory-shaped comment must neither hide the real advisory's owed
  // items nor inject its own. `advisory.index` indexes THIS filtered list, so the lookup below uses it too.
  const candidates = trustedComments(prComments);
  const advisory = latestAdvisory(candidates);
  if (!advisory || !advisoryCoversHead(advisory, headSha)) return null;
  const advisoryComment = candidates[advisory.index];
  const body = advisoryComment?.body ?? '';
  if (isPreventionOutstandingVerdictText(body)) return null;
  const findings = parseOwedPreventionFindings(body);
  return findings.length ? { findings, source: 'advisory' } : null;
}

/**
 * BUILD the `file-item` operation's own input for ONE mechanically-filed backlog card covering EVERY owed
 * finding {@link selectApprovalPreventionFindings} selected. PURE. Self-contained — see the file header for why
 * this does not import `we:scripts/lib/review-loop-policy.mjs#buildPreventionFilingInput` (its #2749 sibling)
 * even though the shape is deliberately close to it: same scope-union-plus-test-sibling heuristic, same #883
 * locus-prefix safety net, so a card this mechanism files reads the same way as one #2749's mechanism files.
 *
 * @param {{repo: string, pr: number|string, findings?: Array<object>, parent?: string, source?: string}} o -
 *   `source` is {@link selectApprovalPreventionFindings}'s own `'verdict-comment'|'advisory'` tag, rendered into
 *   the digest's own header so a reader of the filed card knows where the debt was first printed. `key` is
 *   {@link buildApprovalPreventionKey}'s value, appended as the digest's last line when given.
 * @returns {{title: string, kind: string, size: string, digest: string, scope: string, parent: string, queue: string}}
 */
export function buildApprovalPreventionFilingInput({
  repo, pr, findings = [], parent = '', source = '', key = '',
} = {}) {
  // A juror-authored `file` is UNTRUSTED text that ends up in the filed card's YAML `scope:` frontmatter
  // (`we:scripts/backlog/scaffold.mjs#renderItem` quotes each entry but escapes nothing), so a value carrying a
  // quote, newline, comma or any other non-path character is withheld from BOTH the scope and the digest anchor
  // (the guard text itself is still filed). Ordinary juror path forms are normalized first (a `./` or diff
  // `a/`/`b/` prefix, a trailing `:line`/`:line:col`) so a legitimate citation is kept rather than withheld.
  const SAFE_PATH = /^(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_.][A-Za-z0-9._/-]*$/;
  const normalizePath = (p) => String(p).trim().replace(/^\.\//, '').replace(/^[ab]\//, '').replace(/:\d+(?::\d+)?$/, '');
  const owed = (Array.isArray(findings) ? findings : []).filter(hasUncapturedPrevention).map((f) => {
    if (!f.file) return f;
    const file = normalizePath(f.file);
    return SAFE_PATH.test(file) ? { ...f, file } : { ...f, file: undefined, fileWithheld: true };
  });
  const files = [...new Set(owed.map((f) => f.file).filter(Boolean))];
  // `null` for a file that is ALREADY test code — its own sibling is itself, and only a JS/TS-family source has
  // a `__tests__/<stem>.test.mjs` sibling at all (a .yml/.sh/.json/.md cited file gets no phantom scope entry).
  const testSiblingOf = (f) => {
    const slash = f.lastIndexOf('/');
    const dir = slash === -1 ? '.' : f.slice(0, slash);
    const base = slash === -1 ? f : f.slice(slash + 1);
    if (/(^|\/)__tests__(\/|$)/.test(dir) || /\.(test|spec)\.[cm]?[jt]s$/.test(base)) return null;
    if (!/\.[cm]?[jt]s$/.test(base)) return null;
    const stem = base.replace(/\.[cm]?[jt]s$/, '');
    return `${dir}/__tests__/${stem}.test.mjs`;
  };
  // #883 — every entry, in `scope` AND in the digest's backticked paths, carries the `we:` locus prefix: a bare
  // path is refused at write time (`lint-locus-prefix.mjs`).
  const scope = [...new Set([...files, ...files.map(testSiblingOf).filter(Boolean)])]
    .map((f) => `${IN_REPO_LOCUS}${f}`).join(',');
  const digestLines = owed.map((f, i) => {
    const where = f.file
      ? `${IN_REPO_LOCUS}${f.file}${typeof f.line === 'number' ? `:${f.line}` : ''}`
      : f.fileWithheld ? '(cited file withheld: not a plain path)' : '(no file cited)';
    return `${i + 1}. \`${where}\` — ${f.prevention ?? '(no guard text recorded)'}`;
  });
  const sourceNoun = source === 'advisory' ? "this PR's latest advisory review" : 'this accept verdict';
  const digestRaw = 'Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should '
    + `be filed by default on approval") — ${sourceNoun} named the guard(s) below as owed. None of them blocked `
    + `the approval; the debt is tracked here instead:\n\n${digestLines.join('\n')}`;
  // #883 SAFETY NET — a juror's own `prevention` PROSE can casually re-mention a file this card already cites by
  // its bare basename with no locus prefix at all. The explicit `file:line` anchor built above is prefixed
  // already; this closes the OTHER surface — free prose — for exactly the files THIS card's own `scope` already
  // names (never a blind scan of arbitrary text for anything extension-shaped, which would risk over-matching
  // unrelated words). A mention already carrying a locus prefix, or already part of a longer `dir/basename` or
  // hyphenated `prefix-basename` name, is left alone (explicit path-character lookarounds, NOT `\b`: `\b` treats
  // `-` as a boundary, so citing both `foo.mjs` and `prefix-foo.mjs` would corrupt the latter).
  const basenamesQualified = files.reduce((text, f) => {
    const base = f.includes('/') ? f.slice(f.lastIndexOf('/') + 1) : f;
    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return text.replace(new RegExp(`(?<![\\w./:-])${escaped}(?![\\w-])`, 'g'), `${IN_REPO_LOCUS}${f}`);
  }, digestRaw);
  // web-everything/web-everything#2766's OWN approval (2026-09-27, ~09:00 ET) proved the pass above insufficient: it
  // deliberately skips a name already part of a longer `dir/basename` path (by design, to avoid corrupting a
  // longer name it should leave alone), so a FULL bare path a juror's `prevention` prose names — here, this
  // card's OWN test-sibling path (`scope` already carries it, `we:`-prefixed, but the finding's free-text prose
  // said "Add a regression test in scripts/lib/__tests__/review-loop-policy.test.mjs", no prefix at all) —
  // survived unprefixed. The write-time gate (`we:scripts/backlog/guarded-write.mjs#assertPublishableContent`)
  // then refused the whole card (`stopped: 'effect-halted'`), so the mechanically-filed card for #2766's own
  // review never landed. Second pass: `findUnmarkedLocusRefs` is the REAL detector the write-time gate itself
  // runs, so nothing it would still flag can survive; longest-first and never inside an already-prefixed token
  // or a longer one, mirroring `we:scripts/lib/review-loop-policy.mjs#buildPreventionFilingInput`'s identical
  // fix for this identical gap (landed in #2766 itself — this file could not import that one's copy without
  // closing the import cycle its own header describes, so the fix is ported here as its own copy instead).
  const digest = findUnmarkedLocusRefs(basenamesQualified)
    .sort((a, b) => b.length - a.length)
    .reduce((text, ref) => {
      const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return text.replace(
        new RegExp(`(?<!(?:we|fui|plateau|webeverything|frontierui|plateau-app):)(?<![\\w./-])${escaped}(?![\\w/-])`, 'g'),
        `${IN_REPO_LOCUS}${ref}`,
      );
    }, basenamesQualified);
  return {
    title: preventionCardTitle({ repo, pr, digest }),
    kind: 'story',
    size: '3',
    // The key is appended AFTER the #883 rewrite so that pass can never alter it (a later lookup matches it byte
    // for byte).
    digest: key ? `${digest}${APPROVAL_PREVENTION_DIGEST_KEY_SEP}${key}` : digest,
    scope,
    parent: parent || '',
    queue: 'true',
  };
}
