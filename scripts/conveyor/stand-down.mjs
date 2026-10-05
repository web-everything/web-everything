/**
 * stand-down.mjs — post the durable STAND-DOWN comment when a conveyor fix agent stops to ASK rather than
 * guess (#3296). This is the third sibling of `rearm-review.mjs` (#2643) and `ci-heal-mark.mjs` (#2666), and it
 * shares their difference from the re-arm swap: it posts a durable marker comment and makes **NO LABEL SWAP**.
 * A stand-down leaves the PR exactly as the reviewer left it — `review:changes` stays, `review:human` stays,
 * nothing is cleared. The strongest thing a stood-down agent records is a comment.
 *
 * WHY THIS EXISTS — cause 3 of #3296, the sharpest of the six. `we:skills-src/conveyor/fix-agent-brief.md`
 * has two escalation exits: the ambiguous-finding exit (§2) and the red-gate exit (§4). Both are CORRECT
 * behaviour — an agent that cannot safely make a judgment must not guess — and both wrote **nothing durable**.
 * The PR kept `review:changes`, no comment was posted, and the agent's one-line return went to a calling
 * session that then exited. So on the PR itself, *"a fixer proved the fix wrong and stood down"* was
 * byte-identical to *"a fixer died"*. Any reconciler reading that PR re-dispatches the refusal forever, burning
 * tokens to re-ask a question nobody is there to answer. This marker is the one bit that tells them apart.
 *
 * TERMINAL FOR THE RECONCILER, NOT FOR A PERSON. `planReconcile` treats a PR carrying this marker as terminal
 * with no decay and no clock: it will not dispatch a fixer at this PR again, however long it waits. The
 * intended exit is a HUMAN — who reads the escalation, makes the judgment, and clears the marker (or takes the
 * PR over via `/finish`). That asymmetry is deliberate and it is stated in the comment body itself, because a
 * marker that quietly buries a PR forever would be a worse defect than the one it fixes.
 *
 * WHY A SCRIPT AND NOT PROSE IN THE BRIEF. The brief already asks the agent to RETURN a one-line escalation;
 * asking it to also *remember* to write a durable record is a write-back responsibility placed on prose an LLM
 * must obey (the hazard #3095 names). #3095 explicitly declined to RULE on that hazard — its approach 2 "was
 * declined on COST and SIZE rather than on merit" — so this file does not claim its authority. Script-not-prose
 * stands here on its own argument: the count IS PR state, and a step that must never be skipped belongs in a
 * command the brief shells, not in a sentence it hopes was read. Per
 * [we:docs/agent/platform-decisions.md#deterministic-core-thin-judgment] (#2607).
 *
 * NO PARALLEL STATE STORE (#2612 invariant). The stand-down record lives on the PR's own comment thread, read
 * back by {@link countStandDownComments} — exactly as `countRearmComments` / `countCiHealComments` already work.
 * No label's meaning changes. (Fix procedure, 2026-09-27: the CLI now ALSO adds the purely informative
 * {@link STAND_DOWN_LABEL} on a terminal stand-down so it is visible without opening the thread — nothing reads
 * that label back to decide anything; the comment stays the one durable record. And a concurrent-author stop is
 * no longer a stand-down at all — see {@link CONCURRENT_AUTHOR_PAUSE_MARKER}.)
 */
import { resolve } from 'node:path';
import { repoKeyForSlug } from '../lib/constellation-repos.mjs';
import { execFileSync } from 'node:child_process';
import { resolveChildTimeoutMs } from '../lib/bounded-child.mjs';
import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';

/**
 * we:scripts/conveyor/stand-down.mjs#STAND_DOWN_MARKER — the stable FIRST LINE of the durable stand-down comment.
 * Single-sourced HERE and used two ways: the CLI POSTS a comment starting with it whenever a fix agent escalates,
 * and {@link countStandDownComments} MATCHES it to recover "did a fixer already stand down here" from the PR
 * ITSELF (#3296). Distinct from `REARM_COMMENT_MARKER` (#2643) and `CI_HEAL_COMMENT_MARKER` (#2666) so the three
 * durable counts can never cross-count. Treat this line as fixed: changing it orphans the marker on every PR that
 * already carries one, and each of those would read as never-stood-down again — re-opening the infinite
 * re-dispatch this file exists to close.
 */
export const STAND_DOWN_MARKER = '🛑 conveyor fix — stood down, human judgment needed';

/** fix procedure — the visible label every TERMINAL stand-down applies (single-sourced with
 *  `fix-procedure.mjs#STOOD_DOWN_LABEL`, which removes it again on the next `fix-begin`). Not in
 *  `review-status-tag.mjs#STATUS_LABEL_RE`, so the periodic status tagger never strips it. */
export const STAND_DOWN_LABEL = 'review-status:stood-down';

/**
 * we:scripts/conveyor/stand-down.mjs#STAND_DOWN_REASONS — the escalation exits the fix-agent brief actually has,
 * named once so the brief's two call sites and this file's comment body cannot drift apart. Keyed by the flag
 * value the brief passes; the value is the clause that goes in the durable comment.
 *
 * These four are the brief's REAL exits, read off it rather than imagined: the ambiguous-finding exit
 * (`fix-agent-brief.md` §2), the red-gate exit (§4), and the two `not-applicable` / conflict stops (§1, §3).
 */
export const STAND_DOWN_REASONS = Object.freeze({
  'needs-judgment': 'the reviewer\'s finding needs a judgment the fix agent could not safely make, so it did NOT guess',
  'load-flake': 'verify is red only on host-load timeouts; the saved fix awaits a quiet host',
  'gate-red': 'the gate stayed RED after the repair, and a red diff must never be re-pushed',
  'conflict': 'a genuine same-line conflict with `main` blocked the repair',
  'lane-ref-gone': 'the PR\'s lane ref no longer resolves, so the ~done work could not be reconstituted',
  // fix procedure (2026-09-27) — NOT terminal: the CLI posts {@link CONCURRENT_AUTHOR_PAUSE_MARKER} for this
  // reason instead of a stand-down. Even a comment built through {@link buildStandDownComment} with it is read
  // as a pause by {@link isConcurrentAuthorStandDownBody}, via the comment's machine trailer.
  'concurrent-author': 'a concurrent author pushed to this PR\'s lane mid-repair; this is a re-armable pause, not a judgment call',
});

/**
 * we:scripts/conveyor/stand-down.mjs#CONCURRENT_AUTHOR_PAUSE_MARKER — fix procedure (operator-approved
 * 2026-09-27, live incident PR #2811). A fixer that finds ANOTHER author pushing to the PR's lane mid-repair
 * does not need a human: it needs the other author to finish. So `--reason=concurrent-author` posts THIS
 * marker, never {@link STAND_DOWN_MARKER}: it is NOT terminal. The planner holds the PR only until the head
 * moves past the one recorded here, or the head has been quiet for `reconcile-core.mjs#CONCURRENT_AUTHOR_QUIET_MS`
 * — then it re-arms, and the next fixer starts from the saved alt branch. Treat this line as fixed.
 */
export const CONCURRENT_AUTHOR_PAUSE_MARKER = '⏸ conveyor fix — paused for a concurrent author, re-arms on the next head';

/** Machine-readable trailer on a pause comment: `<!-- fix-pause head=<sha> alt=<branch> alt-sha=<sha> -->`. */
const PAUSE_TRAILER_RE = /<!--\s*fix-pause\b([^>]*)-->/;

/** Machine-readable trailer {@link buildStandDownComment} ends every stand-down with:
 *  `<!-- stand-down reason=<reason> -->`. Anchored to the END of the body, so a `--detail` (free text, written
 *  earlier in the body) can never supply it. */
const STAND_DOWN_TRAILER_RE = /<!--\s*stand-down reason=([a-z-]+)\s*-->\s*$/;

/**
 * The last moment a TRAILER-LESS stand-down may be read by the legacy prose rule below. Every stand-down built
 * since this trailer shipped carries it and is classified by it alone; the prose rule exists only for comments
 * posted by the older builder (PR #2811's, 2026-09-27T15:45:27Z) — and by a stale daemon clone still running it
 * until this merges. Past the cutoff, or with no timestamp at all, a trailer-less body stays TERMINAL: the safe
 * direction, since a person then looks at it. Treat as fixed once shipped.
 */
export const LEGACY_CONCURRENT_AUTHOR_CUTOFF = '2026-10-01T00:00:00Z';

/**
 * Does this TERMINAL-marker stand-down comment actually describe a concurrent author (a re-armable pause, never
 * terminal)? Pure.
 *   1. A body with the machine trailer is classified by the trailer's reason ALONE — `concurrent-author` or not.
 *      Free prose (the `--detail`) never decides it, whatever it says.
 *   2. A trailer-less (legacy) body posted BEFORE {@link LEGACY_CONCURRENT_AUTHOR_CUTOFF}: the `conflict` reason
 *      clause, a detail naming a concurrent author, AND a saved `lane/…-alt` branch — PR #2811's shape. With no
 *      `createdAt`, or one at/after the cutoff, it stays terminal.
 * @param {string} body
 * @param {{createdAt?: ?string}} [opts] - the comment's own `createdAt`.
 */
export function isConcurrentAuthorStandDownBody(body, { createdAt = null } = {}) {
  if (typeof body !== 'string') return false;
  const trailer = STAND_DOWN_TRAILER_RE.exec(body);
  if (trailer) return trailer[1] === 'concurrent-author';
  const at = Date.parse(createdAt ?? '');
  if (!Number.isFinite(at) || at >= Date.parse(LEGACY_CONCURRENT_AUTHOR_CUTOFF)) return false;
  return body.includes(`stopped rather than guessing: ${STAND_DOWN_REASONS.conflict}.`)
    && /\bconcurrent[\s-]+author\b/i.test(body)
    && parseAltBranch(body) !== null;
}

/** {@link isConcurrentAuthorStandDownBody} for one comment as `gh pr view --json comments` returns it. */
export function isConcurrentAuthorStandDown(c) {
  return isConcurrentAuthorStandDownBody(typeof c === 'string' ? c : c?.body, { createdAt: typeof c === 'string' ? null : c?.createdAt });
}

/** Pull `lane/…-alt` (and the sha right after it, if any) out of free text. Pure. */
export function parseAltBranch(text) {
  const m = /\b(lane\/[A-Za-z0-9._/-]*?-alt)\b(?:[^\n(]*?\(`?([0-9a-f]{7,40})\b)?/.exec(String(text ?? ''));
  return m ? { branch: m[1], sha: m[2] ?? null } : null;
}

/**
 * we:scripts/conveyor/stand-down.mjs#concurrentAuthorPauses — every re-armable concurrent-author pause on a PR,
 * oldest first: new-style {@link CONCURRENT_AUTHOR_PAUSE_MARKER} comments AND legacy terminal-marker stand-downs
 * reclassified by {@link isConcurrentAuthorStandDownBody}. Trusted authors only (same #3383 rule as the
 * stand-down count). Pure.
 * @returns {Array<{createdAt:?string, head:?string, alt:?{branch:string, sha:?string}, legacy:boolean}>}
 */
export function concurrentAuthorPauses(comments) {
  if (!Array.isArray(comments)) return [];
  const out = [];
  for (const c of comments) {
    const body = typeof c === 'string' ? c : c?.body;
    if (typeof body !== 'string' || !isTrustedMarkerAuthor(c)) continue;
    const lead = body.trimStart();
    const createdAt = (typeof c === 'string' ? null : c?.createdAt) ?? null;
    if (lead.startsWith(CONCURRENT_AUTHOR_PAUSE_MARKER)) {
      const t = PAUSE_TRAILER_RE.exec(body)?.[1] ?? '';
      const kv = Object.fromEntries([...t.matchAll(/([a-z-]+)=(\S+)/g)].map((m) => [m[1], m[2]]));
      out.push({
        createdAt, head: kv.head ?? null, legacy: false,
        alt: kv.alt ? { branch: kv.alt, sha: kv['alt-sha'] ?? null } : null,
      });
    } else if (lead.startsWith(STAND_DOWN_MARKER) && isConcurrentAuthorStandDown(c)) {
      out.push({ createdAt, head: null, legacy: true, alt: parseAltBranch(body) });
    }
  }
  return out;
}

/** Build the non-terminal pause comment. Pure. */
export function buildConcurrentAuthorPauseComment({ actor = 'conveyor fix agent', head = null, alt = null, altSha = null, detail = '' } = {}) {
  const trailer = ['fix-pause', head ? `head=${head}` : null, alt ? `alt=${alt}` : null, altSha ? `alt-sha=${altSha}` : null]
    .filter(Boolean).join(' ');
  return [
    CONCURRENT_AUTHOR_PAUSE_MARKER,
    '',
    `${actor} paused: another author pushed to this PR's lane while the repair was in progress.${detail ? ` ${detail}` : ''}`,
    '',
    alt ? `**The repair is saved** on \`${alt}\`${altSha ? ` (\`${String(altSha).slice(0, 9)}\`)` : ''}. The next fixer starts from it.` : '**No repair was saved.**',
    '',
    '**This is not terminal and needs no person.** The fix loop re-arms on its own once the PR head moves past '
      + `${head ? `\`${String(head).slice(0, 9)}\`` : 'the head recorded here'}, or once the head has been quiet long enough that the other author is done.`,
    `<!-- ${trailer} -->`,
  ].join('\n');
}

/** Local verify recovery; #4999 covers the complementary CI flake quarantine. */
export const LOAD_FLAKE_HOLD_MARKER = '⏳ conveyor fix — fix ready, verify red only on host-load timeouts; re-verifies when the host is quiet';
export const LOAD_FLAKE_RESOLVED_MARKER = '↩ conveyor fix — load-flake reverify result';

/** Hold and result trailers are comment text that later reaches git argv and refspecs, so only plain hex shas and
 *  ordinary branch names (no `:`, `..`, leading `-`, `//`, `.lock`, whitespace or control characters) are read. */
export const isSafeGitSha = (v) => typeof v === 'string' && /^[0-9a-f]{7,40}$/.test(v);
export const isSafeGitBranch = (v) => typeof v === 'string' && v.length <= 200
  && /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(v) && !/\.\.|\/\/|\.lock(\/|$)|\/$|\.$|^\./.test(v);
export const LEGACY_LOAD_FLAKE_CUTOFF = '2026-10-05T00:00:00Z';

/** The repo key a `gh` comment URL (`https://github.com/<owner>/<repo>/pull/N#issuecomment-…`) names, or `null` when the
 *  comment carries no URL or one for an unknown repo. */
const commentRepoKey = (c) => {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\//.exec(typeof c?.url === 'string' ? c.url : '');
  return m ? repoKeyForSlug(m[1]) : null;
};

/**
 * A pre-cutoff gate-red stand-down that names load flakiness and a saved alt sha reads as a load-flake hold, but only
 * where the reverify pass actually works (`LOAD_FLAKE_REVERIFY_REPOS`). A comment whose URL names any other repo
 * stays a terminal stand-down: nothing would ever reverify it, so reclassifying it would park the PR silently
 * (PR #3945 advisory review). A comment with no URL (a fixture, a bare-string reader) cannot be placed in another
 * repo, so it keeps the reclassification. `standDownComments`, `loadFlakeHolds` and the answer reader all
 * share this one predicate, so a legacy comment is never both terminal and a hold, nor neither.
 */
export function isLoadFlakeStandDown(c) {
  const body = c?.body ?? '';
  const at = Date.parse(c?.createdAt ?? '');
  const repoKey = commentRepoKey(c);
  return (repoKey === null || LOAD_FLAKE_REVERIFY_REPOS.includes(repoKey))
    && body.trimStart().startsWith(STAND_DOWN_MARKER)
    && STAND_DOWN_TRAILER_RE.exec(body)?.[1] === 'gate-red'
    && at < Date.parse(LEGACY_LOAD_FLAKE_CUTOFF)
    // #3881 says "load flakiness", #3932 (17:06 ET) says "load timeouts"; both name a saved alt sha. Bounded by
    // the cutoff, and the re-verify pass still needs a GREEN verify before any push.
    && /load[\s-]+(?:flak|timeouts?\b)/i.test(body) && !!parseAltBranch(body)?.sha;
}

function loadTrailer(body, name) {
  const match = new RegExp(`<!-- ${name} ([^>]+)-->\\s*$`).exec(body);
  return Object.fromEntries([...(match?.[1] ?? '').matchAll(/([a-z-]+)=(\S+)/g)].map((m) => [m[1], m[2]]));
}

/**
 * A legacy hold was a terminal stand-down before it was reclassified, so it must also end the way a stand-down ends
 * (PR #3945 review). `isSuperseded(comments, index)` decides that; the default knows only the watcher's own
 * supersede, because this file must stay import-light (the operator queue stages it alone). Production callers use
 * `load-flake-hold.mjs`, which adds the advisory and operator-answer rules.
 */
export function loadFlakeHolds(comments, isSuperseded = isStandDownSuperseded) {
  const all = Array.isArray(comments) ? comments : [];
  return all.flatMap((c, i) => {
    if (!isTrustedMarkerAuthor(c)) return [];
    const body = c?.body ?? '';
    const createdAt = c.createdAt ?? null;
    if (isLoadFlakeStandDown(c)) {
      const alt = parseAltBranch(body);
      return isSuperseded(all, i) || !isSafeGitBranch(alt?.branch) || !isSafeGitSha(alt?.sha) ? []
        : [{ createdAt, head: null, alt, legacy: true }];
    }
    if (!body.trimStart().startsWith(LOAD_FLAKE_HOLD_MARKER)) return [];
    const t = loadTrailer(body, 'load-flake-hold');
    return isSafeGitBranch(t.alt) && isSafeGitSha(t['alt-sha']) && (t.head === undefined || isSafeGitSha(t.head))
      && t.outcome === 'blocked-on-load-flake'
      ? [{ createdAt, head: t.head ?? null, alt: { branch: t.alt, sha: t['alt-sha'] }, legacy: false }] : [];
  }).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

export function loadFlakeResults(comments) {
  return (Array.isArray(comments) ? comments : []).filter(isTrustedMarkerAuthor).flatMap((c) => {
    if (!c?.body?.trimStart().startsWith(LOAD_FLAKE_RESOLVED_MARKER)) return [];
    const t = loadTrailer(c.body, 'load-flake-resolved');
    return isSafeGitSha(t['alt-sha']) && ['pushed', 'red-again', 'head-moved', 'exhausted'].includes(t.result)
      ? [{ createdAt: c.createdAt ?? null, sha: t['alt-sha'], result: t.result }] : [];
  }).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

export function loadFlakeHoldState({ comments, headRefOid = null, now = 0, isSuperseded }) {
  const hold = loadFlakeHolds(comments, isSuperseded).at(-1);
  if (!hold) return { live: false, hold: null };
  const results = loadFlakeResults(comments).filter((r) => r.sha === hold.alt.sha
    && Date.parse(r.createdAt) >= Date.parse(hold.createdAt));
  const resolution = results.filter((r) => r.result !== 'red-again').at(-1);
  return { hold, results, resolution, live: !resolution && !(hold.head && headRefOid && !sameCommit(hold.head, headRefOid)) };
}

/** A recorded sha may be abbreviated (7–40 hex) while GitHub reports the full oid: equal when one prefixes the other. */
const sameCommit = (a, b) => a.startsWith(b) || b.startsWith(a);

/** Repositories whose load-flake holds a registered reverify pass actually works (the manifest's pass has no --repo flag). */
export const LOAD_FLAKE_REVERIFY_REPOS = ['we'];

/** Whether a `--reason=load-flake` stand-down may record a hold; anywhere nothing would ever reverify it, it stays terminal. */
export const loadFlakeHoldRequest = ({ reason, alt, altSha, repoKey }) =>
  reason === 'load-flake' && !!alt && !!altSha && LOAD_FLAKE_REVERIFY_REPOS.includes(repoKey);

export function buildLoadFlakeHoldComment({ head, alt, altSha, detail = '' }) {
  if (!alt || !altSha) return buildStandDownComment({ reason: 'gate-red', detail });
  return `${LOAD_FLAKE_HOLD_MARKER}\n\n${detail}\n<!-- load-flake-hold${head ? ` head=${head}` : ''} alt=${alt} alt-sha=${altSha} outcome=blocked-on-load-flake -->`;
}

export function buildLoadFlakeResolvedComment({ altSha, result, detail = '' }) {
  return `${LOAD_FLAKE_RESOLVED_MARKER}\n\n${result === 'exhausted' ? 'Retry cap reached; a human is the next step.\n\n' : ''}${detail.slice(-1500)}\n<!-- load-flake-resolved alt-sha=${altSha} result=${result} -->`;
}

/**
 * DELIBERATELY NOT A REASON HERE: a permission / tool-use denial while applying an otherwise-clear fix (live
 * 2026-09-23, PR #2518 — a `python3` heredoc rewriting `backlog/3945-*.md` was denied by Claude Code's own
 * auto-mode classifier, `[Modify Shared Resources]`). That is infrastructure friction, not a judgment call: the
 * WHAT to do stayed unambiguous, only the HOW failed. Adding a `blocked-by-permission`-shaped entry here would
 * make it terminal (this marker has no decay, no clock — see the file header) when the right behaviour is a
 * RETRY once the friction clears. `we:skills-src/conveyor/fix-agent-brief.md` step 3 routes this case through
 * `completion-cli.mjs report --outcome=blocked-on-infra` instead — the same self-reported-done channel
 * `we:scripts/conveyor/reconcile-core.mjs#markSelfReportedDone` already retries after
 * `INFRA_RETRY_COOLOFF_MS` — and never through this script. Keep it that way: a future reason added here for
 * "the tool call was denied" would re-introduce the exact misclassification this comment documents.
 */

/**
 * we:scripts/conveyor/stand-down.mjs#standDownComments — every comment on a PR whose LEADING line is
 * {@link STAND_DOWN_MARKER}, normalized to `{ body, createdAt }` in the order `comments` was given. Pure, and the
 * ONE place the leading-line match rule is written — {@link countStandDownComments} also counts a live hold; any
 * caller that needs to read a stand-down comment BACK (not just know one exists — e.g. the operator queue's
 * STOOD DOWN section, which surfaces when it stood down and why) filters through this, never re-derives the rule.
 *
 * The caller passes the PR's `comments` exactly as `gh pr view <pr> --json comments` returns them
 * (`[{ body, createdAt }]`); a bare-string array is tolerated too (its `createdAt` comes back `null`). A comment
 * matches only when the marker is its LEADING line (`trimStart().startsWith`), so a human QUOTING the stand-down
 * comment in a reply never counts — the same narrowing `countRearmComments` and `countCiHealComments` apply, for
 * the same reason. #3383 — ALSO requires {@link isTrustedMarkerAuthor}: WE's PRs are public, so before this
 * requirement any GitHub account could post this exact leading line and make the PR read as permanently stood
 * down (terminal, no decay) with no fixer having actually escalated. Only the conveyor automation's own login or
 * the repo operator's login now count — see `we:scripts/lib/marker-authorship.mjs`'s own header for the full
 * incident and the two-principal trust rule.
 * @param {Array<{body?:string, createdAt?:string, author?:{login?:string}}|string>|null|undefined} comments
 * @returns {Array<{body: string, createdAt: ?string}>}
 */
export function standDownComments(comments) {
  if (!Array.isArray(comments)) return [];
  const out = [];
  for (const c of comments) {
    const body = typeof c === 'string' ? c : c?.body;
    // fix procedure — a concurrent-author stand-down is a re-armable pause, never a terminal stand-down.
    if (typeof body === 'string' && body.trimStart().startsWith(STAND_DOWN_MARKER) && isTrustedMarkerAuthor(c)
      && !isConcurrentAuthorStandDown(c) && !isLoadFlakeStandDown(c)
      || loadFlakeResults([c]).some((r) => r.result === 'exhausted')) {
      out.push({ body, createdAt: (typeof c === 'string' ? null : c?.createdAt) ?? null });
    }
  }
  return out;
}

/**
 * Durable stand-down count plus one for a live load-flake hold. Pass the current head and legacy supersession
 * reader to exclude ended holds. Callers needing only human escalations use {@link standDownComments}.length.
 * Pure; the optional supersession reader keeps this module import-light.
 * @param {Array<{body?:string}|string>|null|undefined} comments
 * @returns {number} the number of conveyor stand-down comments on the PR (0 for a non-array / empty input)
 */
export function countStandDownComments(comments, { headRefOid = null, isSuperseded } = {}) {
  return standDownComments(comments).length + (loadFlakeHoldState({ comments, headRefOid, isSuperseded }).live ? 1 : 0);
}

/**
 * we:scripts/conveyor/stand-down.mjs#WATCHER_STAND_DOWN_ACTOR — the exact `--actor=` string
 * `we:scripts/conveyor/parked-pr-conflict-watch.mjs#defaultPostConflictStandDown` posts with, single-sourced here
 * so {@link countTerminalStandDowns} and that file can never drift on what counts as "the watch's own marker".
 */
export const WATCHER_STAND_DOWN_ACTOR = 'parked-pr-conflict-watch (#xu2krte statute-tier exception)';

/**
 * we:scripts/conveyor/stand-down.mjs#SUPERSEDE_STAND_DOWN_MARKER — the stable FIRST LINE of the comment the
 * parked-PR conflict watch posts when its re-check finds its OWN earlier stand-down no longer holds
 * (`we:scripts/conveyor/parked-pr-conflict-watch.mjs#buildSupersedeStandDownComment`). Single-sourced here so
 * {@link isStandDownSuperseded} and that builder can never drift. Same "treat as fixed" rule as
 * {@link STAND_DOWN_MARKER}: changing it orphans every supersede already on a PR.
 */
export const SUPERSEDE_STAND_DOWN_MARKER = '↩️ **This PR\'s earlier stand-down is superseded — routed to a fix agent instead**';

/** Body of one comment (`gh --json comments` shape or a bare string). */
const bodyOf = (c) => (typeof c === 'string' ? c : c?.body);

/**
 * we:scripts/conveyor/stand-down.mjs#AUTOMATION_LOGINS — the GitHub login(s) this repo's own conveyor
 * automation posts durable marker comments under. CONFIRMED LIVE (xaer296 follow-up, `web-everything/web-everything
 * #2549`, 2026-09-24): every durable marker this repo's own tooling posts (`stand-down.mjs`,
 * `advisory-fix-mark.mjs`, `rearm-review.mjs`, `conflict-fix-mark.mjs`, the parked-PR conflict watch, …) is
 * authored by `web-everything` — but GitHub's own `viewerDidAuthor` flag ("did the CURRENT caller write this")
 * read `false` on every single one of them, from BOTH a personal-token read (this repo's own operator account)
 * AND the resident daemon's own real production read (verified live by loading a candidate fix into the daemon
 * clone and running `runReconcilePass` for real against the actual PR): `reconcile-pass.mjs#defaultReadPrs`'s
 * discovery read never actually authenticates AS the identity that posted those comments, whatever env var IS
 * set for a WRITE (`we:scripts/lib/github-app-auth-env.mjs`). `viewerDidAuthor` is therefore NOT a safe
 * self-authorship signal for a READ in this system — only `author.login` is: GitHub assigns it from the
 * comment's real author and nothing a commenter writes in the BODY can forge it, the exact non-forgeability
 * property `viewerDidAuthor` was originally chosen for, just read off a different, READ-stable field.
 * Overridable via `WE_AUTOMATION_LOGINS` (comma-separated) for a differently-named install; the default is the
 * one login measured live across every marker this file's own history covers.
 */
export const AUTOMATION_LOGINS = Object.freeze(
  (process.env.WE_AUTOMATION_LOGINS ? process.env.WE_AUTOMATION_LOGINS.split(',') : ['web-everything'])
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

/**
 * we:scripts/conveyor/stand-down.mjs#isSelfAuthored — did THIS repo's own conveyor automation write this
 * comment? PRIMARY signal: `author.login` against {@link AUTOMATION_LOGINS} (READ-stable — see that constant's
 * own docblock for why `viewerDidAuthor` alone is not). `viewerDidAuthor === true` is kept as an ADDITIONAL
 * accepted path (widens, never narrows) for any reader that genuinely does authenticate as the posting
 * identity — this never disagrees with the login check when both are available, and costs nothing when neither
 * is. A bare string, or a comment with neither signal, is NOT self-authored: the fail-closed direction.
 * EXPORTED so a sibling supersede predicate for a DIFFERENT population
 * (`we:scripts/conveyor/advisory-fix-mark.mjs#isAdvisoryMechanismStandDownSuperseded`) can reuse the identical
 * check rather than growing a private copy — this repo's own "widen the shared thing" rule.
 * @param {{viewerDidAuthor?:boolean, author?:{login?:string}}|string|null|undefined} c
 * @returns {boolean}
 */
export function isSelfAuthored(c) {
  if (typeof c !== 'object' || c === null) return false;
  if (c.viewerDidAuthor === true) return true;
  const login = String(c.author?.login ?? '').trim().toLowerCase();
  return login.length > 0 && AUTOMATION_LOGINS.includes(login);
}

/**
 * we:scripts/conveyor/stand-down.mjs#isStandDownSuperseded — is the comment at `index` a watcher stand-down that
 * the watch ITSELF later superseded? PURE. True only when ALL of these hold:
 *   1. the comment is a stand-down (leading-line {@link STAND_DOWN_MARKER}) carrying {@link WATCHER_STAND_DOWN_ACTOR};
 *   2. it is self-authored (GitHub's `viewerDidAuthor`), so a forged body naming the watcher's actor never counts;
 *   3. a LATER comment in the thread (array order = GitHub's chronological order) leads with
 *      {@link SUPERSEDE_STAND_DOWN_MARKER} and is ALSO self-authored.
 * The watch posts that supersede comment only after re-classifying the conflict as safe to hand a fixer, so a
 * watcher stand-down that is still CURRENT (never re-classified) is never superseded and stays terminal.
 * @param {Array<{body?:string, viewerDidAuthor?:boolean}|string>|null|undefined} comments
 * @param {number} index
 * @returns {boolean}
 */
export function isStandDownSuperseded(comments, index) {
  if (!Array.isArray(comments)) return false;
  const c = comments[index];
  const body = bodyOf(c);
  if (typeof body !== 'string' || !body.trimStart().startsWith(STAND_DOWN_MARKER)) return false;
  if (!body.includes(WATCHER_STAND_DOWN_ACTOR) || !isSelfAuthored(c)) return false;
  for (let j = index + 1; j < comments.length; j += 1) {
    const later = comments[j];
    const laterBody = bodyOf(later);
    if (typeof laterBody === 'string' && laterBody.trimStart().startsWith(SUPERSEDE_STAND_DOWN_MARKER)
      && isSelfAuthored(later)) return true;
  }
  return false;
}

/**
 * we:scripts/conveyor/stand-down.mjs#countTerminalStandDowns — `#xu2krte` Fork 2 (review-human statute amendment).
 * Like {@link countStandDownComments}, EXCEPT it excludes a watcher stand-down the watch ITSELF has since
 * superseded ({@link isStandDownSuperseded}). The watcher's stand-down is a routing decision the same watch
 * re-derives every sweep, not "an agent examined the diff and could not safely proceed". When a later sweep
 * re-classifies the conflict as safe to hand a fixer, the watch posts a supersede comment, and only THEN does
 * the old marker stop blocking `reconcile-core.mjs`'s dispatch gate.
 *
 * NARROW, ON PURPOSE — two review findings on PR #2577 shaped it:
 *   - A watcher stand-down that was never superseded is a CURRENT, correct stand-down (e.g. a true hunk overlap,
 *     or a plain non-`review:human` statute conflict). It stays terminal, exactly like any other stand-down.
 *   - Both the stand-down and the supersede must be self-authored (`viewerDidAuthor`). Matching the actor string
 *     in the body alone let anyone who can comment forge a marker that escapes the gate.
 * A fix agent's OWN `needs-judgment` / `gate-red` / `lane-ref-gone` escalation, or a human's `/finish` stand-down,
 * never carries the watcher's actor and stays terminal whatever follows it. Only THIS gate call site
 * (`reconcile-core.mjs`'s dispatch refusal) uses the narrower count; every other reader (the operator queue's
 * STOOD DOWN section, `pr-status-io.mjs`, the watch's own idempotent re-post guard) keeps
 * {@link countStandDownComments}, so a human still SEES that the watch once stood this down.
 * @param {Array<{body?:string, viewerDidAuthor?:boolean}|string>|null|undefined} comments
 * @returns {number}
 */
export function countTerminalStandDowns(comments) {
  if (!Array.isArray(comments)) return 0;
  let n = 0;
  for (let i = 0; i < comments.length; i += 1) {
    const c = comments[i];
    if (!standDownComments([c]).length) continue;
    if (!isTrustedMarkerAuthor(c)) continue; // #3383 — a forged stand-down from an untrusted login is never terminal.
    if (isConcurrentAuthorStandDown(c)) continue; // fix procedure — reclassified as a re-armable pause.
    if (!isStandDownSuperseded(comments, i)) n += 1;
  }
  return n;
}

/**
 * we:scripts/conveyor/stand-down.mjs#standDownReason — read back the stated reason clause from a stand-down
 * comment body built by {@link buildStandDownComment}. Pure string parsing — the inverse of that builder: the
 * comment's third line always reads `<actor> stopped rather than guessing: <why>.<detail>`, so the clause between
 * the colon and the sentence's end is what a reader actually wants (the operator queue surfaces it verbatim,
 * per-PR, rather than making a human open the comment to find out).
 *
 * Returns `null` when the body does not carry that sentence — a hand-written or otherwise malformed stand-down
 * comment — so the caller decides how to render "no reason stated"; this never invents one.
 * @param {string} body
 * @returns {?string}
 */
export function standDownReason(body) {
  const match = /stopped rather than guessing:\s*([^\n]*)/.exec(typeof body === 'string' ? body : '');
  if (!match) return null;
  return match[1].trim().replace(/\.$/, '').trim() || null;
}

/**
 * we:scripts/conveyor/stand-down.mjs#buildStandDownComment — the durable comment body an escalating fix agent
 * posts. Its FIRST line MUST be {@link STAND_DOWN_MARKER} (single-sourced) so posting and counting can never
 * drift. Pure.
 *
 * The body states the ASYMMETRY explicitly — terminal for the reconciler, cleared by a person — because that is
 * the difference between a marker and a burial. A reader who finds this comment must be able to see, without
 * reading any code, that the automation has deliberately stopped and that they are the intended next step.
 * @param {{ actor?:string, reason?:string, detail?:string }} o
 * @returns {string}
 */
export function buildStandDownComment({ actor = 'conveyor fix agent', reason = '', detail = '' } = {}) {
  const why = STAND_DOWN_REASONS[reason] || 'the fix agent could not complete the repair safely';
  return [
    STAND_DOWN_MARKER,
    '',
    `${actor} stopped rather than guessing: ${why}.${detail ? ` ${detail}` : ''}`,
    '',
    'The PR was left EXACTLY as the reviewer left it — no label was changed, the review was not re-armed, and ' +
      'nothing was re-pushed. This comment is the durable record that a fixer *deliberately stood down* here, ' +
      'which is what tells the reconciler apart from a fixer that simply died.',
    '',
    '**A human is the intended next step.** The automatic fix loop will NOT try this PR again while this comment ' +
      'stands — re-running it would only re-ask the same question. Take it over with `/finish`, or delete this ' +
      'comment once the blocker is resolved to hand the PR back to the loop.',
    `<!-- stand-down reason=${Object.hasOwn(STAND_DOWN_REASONS, reason) ? reason : 'unknown'} -->`,
  ].join('\n');
}

// ── IO SHELL (runs only as a CLI — the pure exports above stay side-effect-free on import) ────────────────────────
const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (IS_CLI) {
  const argv = process.argv.slice(2);
  const flags = {};
  const positionals = [];
  for (const a of argv) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq === -1) flags[a.slice(2)] = true;
      else flags[a.slice(2, eq)] = a.slice(eq + 1);
    } else positionals.push(a);
  }
  const fail = (m) => {
    process.stderr.write(`✗ ${m}\n`);
    process.exit(1);
  };
  const pr = Number(positionals[0]);
  if (!Number.isInteger(pr) || pr <= 0) {
    fail(`usage: stand-down.mjs <pr> [--repo=<owner/name>] [--reason=<${Object.keys(STAND_DOWN_REASONS).join('|')}>] [--who=<session slug>] [--actor=<name>] [--detail=<text>] [--head=<sha> --alt=<lane/…-alt> --alt-sha=<sha>]  (pr must be a positive integer)`);
  }
  const actor = typeof flags.actor === 'string' ? flags.actor : undefined;
  const detail = typeof flags.detail === 'string' ? flags.detail : undefined;
  // fix procedure — a concurrent author is a PAUSE, never a terminal stand-down. Only the explicit reason makes
  // one: free `--detail` prose is never sniffed (PR #2821 review — an unrelated stand-down that merely mentioned
  // a "concurrent author" was re-armed). A legacy conflict-shaped post is still reclassified when READ.
  const concurrent = flags.reason === 'concurrent-author';
  const loadHold = loadFlakeHoldRequest({ reason: flags.reason, alt: flags.alt, altSha: flags['alt-sha'], repoKey: repoKeyForSlug(flags.repo) });
  if (flags.reason === 'load-flake' && !loadHold) {
    process.stderr.write('⚠ stand-down: no load-flake reverify worker serves this repo (or --alt/--alt-sha is missing); recording a terminal gate-red stand-down instead\n');
  }
  const body = loadHold ? buildLoadFlakeHoldComment({ head: flags.head, alt: flags.alt, altSha: flags['alt-sha'], detail }) : concurrent
    ? buildConcurrentAuthorPauseComment({
      actor, detail,
      head: typeof flags.head === 'string' ? flags.head : null,
      alt: typeof flags.alt === 'string' ? flags.alt : (parseAltBranch(detail)?.branch ?? null),
      altSha: typeof flags['alt-sha'] === 'string' ? flags['alt-sha'] : (parseAltBranch(detail)?.sha ?? null),
    })
    : buildStandDownComment({ actor, reason: flags.reason === 'load-flake' ? 'gate-red' : typeof flags.reason === 'string' ? flags.reason : undefined, detail });
  const repoArgs = typeof flags.repo === 'string' ? [`--repo=${flags.repo}`] : []; // a missing --repo derives from cwd.
  const gh = (args) => execFileSync('gh', args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL' });
  try {
    // #x5n4zn3 — was bare (no timeout).
    gh(['pr', 'comment', String(pr), '--body', body, ...repoArgs]);
  } catch (e) {
    fail(`could not post stand-down comment on PR #${pr}: ${String(e.message || e).split('\n')[0]}`);
  }
  let dispatchClaimReleased = [];
  const repo = repoKeyForSlug(flags.repo);
  if (typeof flags.who !== 'string' || !flags.who || !repo) {
    process.stderr.write('⚠ stand-down: dispatch claim retained; release requires --who and a known --repo\n');
  } else {
    const { releaseSessionFixDispatchClaims } = await import('./fix-dispatch-claim.mjs');
    dispatchClaimReleased = releaseSessionFixDispatchClaims({ repo, pr, who: flags.who }).released;
  }
  // fix procedure — a TERMINAL stand-down is VISIBLE: `review-status:stood-down` goes on the PR, so a person
  // scanning labels sees it without reading the thread (PR #2811 had no label at all). Best-effort: the comment
  // above is the durable record the planner reads; a failed label write is reported, never fatal.
  let labeled = false;
  if (!concurrent && !loadHold) {
    try {
      gh(['label', 'create', STAND_DOWN_LABEL, ...repoArgs, '--color', 'b60205', '--description', 'a fixer stood down; a person is the next step (auto-managed)', '--force']);
      gh(['pr', 'edit', String(pr), ...repoArgs, '--add-label', STAND_DOWN_LABEL]);
      labeled = true;
    } catch (e) {
      process.stderr.write(`⚠ stand-down: comment posted but the ${STAND_DOWN_LABEL} label failed: ${String(e.message || e).split('\n')[0]}\n`);
    }
  }
  process.stdout.write(JSON.stringify({ ok: true, pr, stoodDown: !concurrent && !loadHold, paused: concurrent, loadFlakeHold: loadHold, labeled, dispatchClaimReleased }) + '\n');
}
