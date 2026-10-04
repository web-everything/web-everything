/**
 * @file scripts/lib/marker-authorship.mjs
 * @description THE ONE SHARED ANSWER TO "did a TRUSTED principal write this PR comment?" — closing the gap an
 *   adversarial coverage review found (epic #3383, 2026-09-24): every durable marker counter in this repo
 *   (`we:scripts/conveyor/stand-down.mjs#countStandDownComments`, `we:scripts/conveyor/rearm-review.mjs#countRearmComments`,
 *   `we:scripts/conveyor/ci-heal-mark.mjs#countCiHealComments`, `we:scripts/conveyor/advisory-fix-mark.mjs#countAdvisoryFixComments`,
 *   `we:scripts/conveyor/conflict-fix-round-count.mjs#countConflictFixComments`,
 *   `we:scripts/conveyor/advisory-round-count.mjs#countAdvisoryComments`) matched a comment's LEADING LINE against a
 *   fixed marker string with NO author check at all. WE's PRs are public, so any GitHub account can post one of
 *   these strings: a fake stand-down permanently blocks a fixer (terminal, no decay, per
 *   `we:scripts/conveyor/stand-down.mjs`'s own header), and a fake rearm/ci-heal/advisory-fix/conflict-fix marker
 *   inflates that PR's round count toward `cap-exhausted`, silently swallowing a real fixer's remaining rounds.
 *
 * THE SIGNAL: `author.login`, NOT a comment-body substring. `gh pr list/view --json comments` (the shape every
 * caller in this repo actually reads — confirmed live, `web-everything/web-everything#2578`/`#2602`/`#2607`,
 * 2026-09-24) returns each comment's poster as `author.login`, a field GitHub itself assigns from the real
 * authenticated identity that posted the comment. A comment BODY can say anything a commenter likes; `author.login`
 * cannot be forged by writing a comment. `viewerDidAuthor` (GitHub's "did the CURRENT read's credential post
 * this") is accepted as an ADDITIONAL signal — true whenever the read itself runs under the automation's own
 * credential — but never REQUIRED, because `author.login` is the READ-STABLE half: it means the same thing
 * whichever credential happens to be making the read (see `we:scripts/conveyor/stand-down.mjs#AUTOMATION_LOGINS`'s
 * own docblock, xaer296/#2587, for the incident this mirrors — `viewerDidAuthor` alone read `false` on every
 * marker comment when replayed against the real daemon-clone shape).
 *
 * TWO TRUSTED PRINCIPALS, ONE RULE. This repo's conveyor automation posts under its own GitHub identity
 * ({@link AUTOMATION_LOGINS}); the human operator sometimes posts the identical marker BY HAND (running the same
 * CLI a fix agent would — `/finish`, a manual re-arm, or an automation that fell back to the operator's own
 * personal `gh auth` when its own credential was unavailable, as happened for several hours on 2026-09-24). Both
 * are principals this repo already trusts with every write these scripts make (label swaps, comments, pushes),
 * so both count for dispatch decisions — the trust boundary that matters here is "was this posted by someone
 * this repo's own automation/operator already controls", not "was it posted by the automation's OWN credential
 * on THIS particular read". A comment from any OTHER GitHub login — however the body reads — is NEVER trusted,
 * however sympathetic-looking the text: {@link isTrustedMarkerAuthor} is the single gate every counter above now
 * runs its comments through before matching a marker line.
 *
 * #4140 UPDATE: every coverage-deciding marker reader in `we:scripts/lib/review-escalation.mjs` —
 * `#parseReviewedSha`, `#parseReviewedDiff`, `#parseReviewedContribution` and `#parseLatestHumanClearedSha` —
 * now runs every comment through {@link isTrustedMarkerAuthor} before matching its marker, exactly mirroring
 * this file's own pattern. All four are needed together: `acceptanceCoversHead` ORs THREE independent coverage
 * branches (SHA, diff fingerprint, contribution fingerprint), and `review-set-label.mjs`'s restamp path
 * (`decideRestampHumanClearance`) reaches all of them plus `cleared-human` — gating only some left the others
 * as a forge path (review round 1 on PR #2716). That restamp path also names the carried actor from TRUSTED
 * comments only. `parseOperatorClearance` itself stays ungated, and ONE caller still reads it over every
 * comment: `we:scripts/merge-ai-prs.mjs` feeds it to `decideReviewGate`, where (since #3184) a clearance
 * record also withholds re-applying `review:human` on a pass whose live diff read failed. That never lands
 * anything — the gate still parks — but a forged `cleared-human` comment can delay the hold's re-imposition.
 * Open follow-up, outside this item's file scope: filter that read through {@link isTrustedMarkerAuthor} too.
 *
 * NOT IN SCOPE HERE (documented residuals, unchanged by this file, each with its own existing acknowledgment):
 *   - `we:scripts/conveyor/stuck-pr-dispatch-marker.mjs` gates an inspection DISPATCH (diagnosis only — no
 *     label/code/branch change), not a round cap or a terminal refusal; forging it wastes at most one inspection
 *     agent, not a fixer's remaining rounds or a permanent stand-down.
 *   Flagged in this item's PR body as a follow-up candidate rather than folded in silently.
 *
 * PURE. No fs, no clock, no network. Reads `process.env` once per call (env overrides), same discipline
 * `we:scripts/conveyor/stand-down.mjs#AUTOMATION_LOGINS` already uses.
 */

/**
 * we:scripts/lib/marker-authorship.mjs#AUTOMATION_LOGINS — the GitHub login(s) this repo's own conveyor
 * automation posts comments under. Overridable via `WE_AUTOMATION_LOGINS` (comma-separated) for a
 * differently-named install; the default covers both shapes actually observed live in this repo — the plain
 * GraphQL-backed `gh pr list/view --json comments` shape (`web-everything`, confirmed on
 * `web-everything/web-everything#2578`/`#2602`/`#2607`) and the REST App-bot shape some `gh` paths/installs surface
 * (`web-everything[bot]`) — so a caller reading either shape resolves the same way. Compared case-insensitively.
 * @returns {string[]}
 */
function readLoginList(envVar, fallback) {
  const raw = process.env[envVar];
  const list = raw ? raw.split(',') : fallback;
  return list.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
}

export const AUTOMATION_LOGINS = Object.freeze(
  readLoginList('WE_AUTOMATION_LOGINS', ['web-everything', 'web-everything[bot]']),
);

/**
 * we:scripts/lib/marker-authorship.mjs#OPERATOR_LOGINS — the repo operator's own GitHub login(s), trusted for
 * EVERY marker (not just the human review ceremony) per this item's ratified rule: an operator login is a human
 * (or a daemon that fell back to the operator's own credential) — a principal this repo already trusts with
 * every write these scripts make — so it is never narrower-trusted than the automation's own login. Overridable
 * via `WE_OPERATOR_LOGINS` (comma-separated); default is the repo owner observed live (`chalbert`).
 * @returns {string[]}
 */
export const OPERATOR_LOGINS = Object.freeze(
  readLoginList('WE_OPERATOR_LOGINS', ['chalbert']),
);

/** Body of one comment (`gh --json comments` shape or a bare string) — same tolerant read every sibling counter
 *  in this repo uses. */
const bodyOf = (c) => (typeof c === 'string' ? c : c?.body);

/** The comment's `author.login`, lower-cased, or `''` when absent/not-an-object/bare-string (a bare string has
 *  no author at all, and is therefore never automation- or operator-authored — fail closed). */
const loginOf = (c) => {
  if (typeof c !== 'object' || c === null) return '';
  const login = c.author?.login;
  return typeof login === 'string' ? login.toLowerCase() : '';
};

/**
 * we:scripts/lib/marker-authorship.mjs#isAutomationAuthored — did THIS repo's own conveyor automation write this
 * comment? PRIMARY signal: `author.login` against {@link AUTOMATION_LOGINS} (read-stable — see this file's own
 * header for why `viewerDidAuthor` alone is not). `viewerDidAuthor === true` is accepted as an ADDITIONAL path
 * (true whenever the read itself runs under the automation's own credential). Fails closed on anything else,
 * including a bare string (no author at all) or a missing/blank login.
 * @param {{viewerDidAuthor?:boolean, author?:{login?:string}}|string|null|undefined} c
 * @returns {boolean}
 */
export function isAutomationAuthored(c) {
  if (typeof c !== 'object' || c === null) return false;
  if (c.viewerDidAuthor === true) return true;
  const login = loginOf(c);
  return login.length > 0 && AUTOMATION_LOGINS.includes(login);
}

/**
 * we:scripts/lib/marker-authorship.mjs#isOperatorAuthored — did the repo OPERATOR write this comment (by hand,
 * or a daemon that fell back to the operator's own credential)? `author.login` against {@link OPERATOR_LOGINS}
 * only — the operator's read credential is never assumed to make `viewerDidAuthor` meaningful here, since the
 * usual reader is the automation's own credential, not the operator's.
 * @param {{author?:{login?:string}}|string|null|undefined} c
 * @returns {boolean}
 */
export function isOperatorAuthored(c) {
  const login = loginOf(c);
  return login.length > 0 && OPERATOR_LOGINS.includes(login);
}

/**
 * we:scripts/lib/marker-authorship.mjs#isTrustedMarkerAuthor — THE gate every durable marker counter in this
 * repo runs a comment through before matching its leading line. True iff the comment is automation-authored
 * ({@link isAutomationAuthored}) OR operator-authored ({@link isOperatorAuthored}) — see this file's header for
 * why both principals count identically for every marker. A comment from any other login, or with no author
 * information at all (a bare string, or an object with no `author`), is never trusted — fail closed, the
 * direction every sibling counter in this repo already takes on a malformed/missing field.
 * @param {{viewerDidAuthor?:boolean, author?:{login?:string}}|string|null|undefined} c
 * @returns {boolean}
 */
export function isTrustedMarkerAuthor(c) {
  return isAutomationAuthored(c) || isOperatorAuthored(c);
}

/**
 * we:scripts/lib/marker-authorship.mjs#countTrustedLeadingMarker — the ONE shared leading-line + trusted-author
 * count every marker counter in this repo now delegates to, so the narrowing rule (leading line, trusted author,
 * tolerant shapes) is written exactly once. Pure.
 * @param {Array<{body?:string, viewerDidAuthor?:boolean, author?:{login?:string}}|string>|null|undefined} comments
 * @param {string} marker - the marker's stable leading-line string.
 * @returns {number}
 */
export function countTrustedLeadingMarker(comments, marker) {
  if (!Array.isArray(comments)) return 0;
  let n = 0;
  for (const c of comments) {
    const body = bodyOf(c);
    if (typeof body === 'string' && body.trimStart().startsWith(marker) && isTrustedMarkerAuthor(c)) n += 1;
  }
  return n;
}
