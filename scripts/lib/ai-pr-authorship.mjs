/**
 * @file scripts/lib/ai-pr-authorship.mjs
 * @description The AI-authorship rubric — "is this PR's content AI-generated" / "does it carry this label" —
 *   extracted from `scripts/merge-ai-prs.mjs` (we:xniq7xs) into its OWN zero-dependency leaf so a small,
 *   read-only consumer (`scripts/lib/pr-limit.mjs`, and through it `scripts/operations/operator-queue.mjs` /
 *   `scripts/readiness/dispatch-plan.mjs`) can reuse the SAME rubric without inheriting `merge-ai-prs.mjs`'s
 *   own heavy transitive import graph (25 top-level imports spanning the whole land/merge/review subsystem) —
 *   the exact failure mode `scripts/operations/__tests__/operator-queue-entry.test.mjs`'s synthetic
 *   minimal-checkout harness exists to catch (an import of a file that checkout never staged crashes the
 *   child process with no diagnostic beyond "main() never ran").
 *
 *   `merge-ai-prs.mjs` re-exports every one of these names unchanged (`export { … } from './lib/ai-pr-
 *   authorship.mjs'`), mirroring `pr-land.mjs`'s own `forge-land-provider.mjs` re-export — every existing
 *   importer of `merge-ai-prs.mjs` keeps resolving them exactly as before; this file is the ONE definition,
 *   never a second, independently-drifting copy.
 *
 *   PURE. Zero imports — plain JS over plain objects (the shape `gh pr list --json commits,labels` returns).
 */

/** An anthropic/Claude identity on a commit author (the `Co-Authored-By: Claude …` trailer gh surfaces as an
 *  author). Matches the name "Claude" or an anthropic email — the stamp every commit in an AI session carries. */
export function isAiAuthor(author) {
  if (!author) return false;
  const name = String(author.name || '').toLowerCase();
  const email = String(author.email || '').toLowerCase();
  return /\bclaude\b/.test(name) || email.includes('anthropic.com') || email.includes('noreply@anthropic');
}

/** A commit is AI if ANY of its authors (author + Co-Authored-By co-authors) is an AI identity. */
export function isAiCommit(commit) {
  const authors = Array.isArray(commit?.authors) ? commit.authors : [];
  // Fallback: some gh versions omit co-authors from `authors` but keep the trailer in the body.
  const bodyHasTrailer = /co-authored-by:\s*claude/i.test(String(commit?.messageBody || commit?.body || ''));
  return authors.some(isAiAuthor) || bodyHasTrailer;
}

/** Rejoin a commit's REAL first line + remaining body from gh's shape. GitHub truncates `messageHeadline` at ~70
 *  chars with a trailing `…` and moves the rest of the first line into `messageBody`, prefixed `…` (confirmed
 *  live on PR #2748: `drain: rebase lane/xg790dh-… ont…` + body `…o origin/main, drop transient …`). Without
 *  rejoining, an exact-shape match on the subject misses a long drain headline and an empty-body check sees the
 *  continuation as authored body. Pure. */
function splitCommitMessage(commit) {
  let subject = String(commit?.messageHeadline || '').trim();
  let body = String(commit?.messageBody ?? commit?.body ?? '').replace(/\r\n?/g, '\n');
  if (subject.endsWith('…') && body.startsWith('…')) {
    const nl = body.indexOf('\n');
    const rest = nl === -1 ? '' : body.slice(nl + 1);
    subject = subject.slice(0, -1) + (nl === -1 ? body : body.slice(0, nl)).slice(1);
    body = rest;
  }
  return { subject: subject.trim(), body: body.trim() };
}

/** Strip GIT'S OWN auto-appended `# Conflicts:` footer from a merge commit body — the boilerplate
 *  `git merge`/`git commit` appends listing which paths conflicted, present whenever a merge is committed
 *  non-interactively (`--no-edit`, or a script that never invokes the edit-time comment-strip) REGARDLESS of
 *  whether the conflicts were resolved by a mechanical driver or a human. It is not evidence of "real content
 *  added", the same direction shape 1's plain empty-body check already reasons from.
 *  EXACT shape only (PR #2748 review): a TRAILING block that opens with the literal `# Conflicts:` line and
 *  holds nothing but git's `#\t<path>` lines (and blank / bare-`#` lines) is removed. Any other `#`-prefixed
 *  line — a markdown heading or bullet a human wrote, before or after the footer — is authored content and
 *  stays, so the body stays non-empty. Pure. */
function stripGitConflictFooter(body) {
  const lines = String(body ?? '').replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((line) => line.trim() === '# Conflicts:');
  if (start === -1) return lines.join('\n').trim();
  const footerOnly = lines.slice(start + 1).every((line) => line.trim() === '' || line.trim() === '#' || /^#\t\S/.test(line));
  return (footerOnly ? lines.slice(0, start) : lines).join('\n').trim();
}

/** A mechanical integration commit — either shape below carries no NEW authored content of its own, so neither
 *  counts as human work and neither may disqualify an otherwise-AI PR:
 *   1. `Merge branch 'main' …` / `Merge remote-tracking …` with an EMPTY body (after stripping git's own
 *      `# Conflicts:` footer, see {@link stripGitConflictFooter}) — what `gh pr update-branch` / a local
 *      rebase-on-behind creates, WITH OR WITHOUT a real conflict along the way. Live-caught 2026-09-26 on
 *      `web-everything/web-everything#2741`: `git merge origin/main` hit a conflict, git appended
 *      `# Conflicts:\n#\t<path>\n#\t<path>` to the default commit message, and the commit went through
 *      non-interactively — the body was therefore non-empty, and this shape's original bare `body === ''`
 *      check missed it even though the footer is git's OWN generated boilerplate, never authored prose.
 *   2. `Merge pull request #NNN from owner/branch` — GitHub's OWN fixed-boilerplate merge-commit headline
 *      (created by `gh pr merge --merge` / the merge button; this repo's own drain default,
 *      `we:scripts/lib/pr-merge-gate.mjs`'s `mergeMethodFlag`). Its body is always non-empty (GitHub fills it
 *      with the MERGED PR's own title), so it fails shape 1's empty-body test even though it is exactly as
 *      mechanical: this specific commit only merges two trees, it adds no line of its own. #3729 — a
 *      long-lived lane that later merges `origin/main` into itself (shape 1, routine) inherits every OTHER
 *      already-landed PR's shape-2 merge commit into its OWN open PR's `commits` list (the PR's recorded base
 *      predates them), so before this fix one stray shape-2 commit — authored solely by the merge bot, never
 *      by a human or Claude — silently flipped `isAiGeneratedPr` to `false` for an otherwise fully-AI PR,
 *      which disqualified it from the #2421 TOTAL ci-lifecycle reconcile forever (a `ci:failed` label from an
 *      earlier red head never cleared once the current head went green — confirmed live on PR #2685/#2653). */
export function isMechanicalMergeCommit(commit) {
  const { subject: head, body: rawBody } = splitCommitMessage(commit);
  const body = stripGitConflictFooter(rawBody);
  if (/^Merge (branch|remote-tracking branch) /i.test(head) && body === '') return true;
  if (/^Merge pull request #\d+ from \S+/i.test(head)) return true;
  return false;
}

/** we:scripts/lib/ai-pr-authorship.mjs#isDrainBookkeepingCommit — a THIRD shape of mechanical integration
 *  commit, live-caught 2026-09-26 on `web-everything/web-everything#2741`: the DRAIN ITSELF lands a family of
 *  bookkeeping commits directly onto `main` (never through a `Merge …` headline `isMechanicalMergeCommit`
 *  would catch) — `drain: JIT-number …→#NNNN at land (#2288)` / `drain: resolve #NNNN on land (#2748)`
 *  (`we:scripts/lane-drain.mjs`'s own `committed = quietGit(…, ['commit', '-m', \`drain: …\`, …])` call sites) /
 *  `drain: rebase …` (`we:scripts/lib/rebase-drop-content.mjs` / `rebase-drop-manifest.mjs`) / `drain: unqueue +
 *  cleanup …` / `drain: reopen stranded …` / `drain: resolve epic … on last-child … land (#2752)`
 *  (`we:scripts/conveyor/pr-watch.mjs`). A long-lived lane that merges/rebases a newer `main` into itself (the
 *  SAME routine shape #3729 already fixed for a stray `Merge pull request #N` commit) inherits every one of
 *  these into ITS OWN open PR's `commits` list — none of them add a line of authored content, all of them are
 *  authored by whatever git identity lands the drain's own commits (never a human, never Claude's own
 *  `Co-Authored-By` trailer) — so before this fix a single inherited `drain: …` commit silently flipped
 *  `isAiGeneratedPr` to `false` for an otherwise fully-AI PR, which (via `merge-ai-prs.mjs`'s `ciLifecycleCertified`
 *  gate) disqualified it from the #2421/#2281 TOTAL ci-lifecycle reconcile entirely: no `checking` / `ci:failed`
 *  / `blocked` / `ready-to-merge` label ever applied, in violation of the #2281-ratified "exactly one
 *  ci-lifecycle label present on every open AI PR, never inferred from absence" statute. CONFIRMED LIVE:
 *  `web-everything/web-everything#2741` carried `review:pending, review-round:1` only — no ci-lifecycle label at all —
 *  while `test`/`daemon-soak` were IN_PROGRESS, entirely because its inherited history carried
 *  `drain: JIT-number …`/`drain: resolve #…` commits from `main` alongside its own genuinely-AI fix commits.
 *  EXACT shapes only (PR #2748 review): the full subject must match one of the drain's own generated templates
 *  ({@link DRAIN_BOOKKEEPING_SUBJECTS}, one per call site above) AND the body must be empty — every drain call
 *  site commits a single `-m` line. A bare `drain: ` prefix is NOT enough: `drain: manually patch the flaky
 *  soak test` with an authored body, or any free-form `drain: …` headline, stays substantive and disqualifies
 *  a mixed PR exactly as before this fix. A new drain commit kind must add its template here.
 *  No author check: the drain commits under the host's ambient git identity (on this host the same one agent
 *  commits use), so there is no fixed drain identity to pin. Residual, stated plainly: git author and message
 *  are self-declared, so a pusher who copies a template verbatim with an empty body is still read as
 *  bookkeeping — the same trust level `isAiCommit` already gives a self-declared `Co-Authored-By: Claude`
 *  trailer, so this does not widen what a branch pusher could already forge. */
const DRAIN_BOOKKEEPING_SUBJECTS = [
  /^drain: JIT-number \S+→#\d+(?:, \S+→#\d+)* at land \(#2288\)$/, // lane-drain.mjs
  /^drain: resolve #\d+ on land \(#2748\)$/, // lane-drain.mjs
  /^drain: unqueue \+ cleanup #\d+ lane manifest post-land \(#2175\)$/, // lane-drain.mjs
  /^drain: reopen stranded #\d+ after failed land \(#2175\)$/, // lane-drain.mjs
  /^drain: resolve epic #?[\w-]+ on last-child #?[\w-]+ land \(#2752\)$/, // conveyor/pr-watch.mjs
  // lib/rebase-drop-manifest.mjs / lib/rebase-drop-content.mjs
  /^drain: rebase \S+ onto \S+, (?:drop transient \S+|auto-resolve non-overlapping content conflict\(s\) in [^,]+(?:, [^,]+)*?(?:, drop transient \S+)?)(?:, renumber #\d+→#\d+(?:\/#\d+→#\d+)*)?$/,
];

export function isDrainBookkeepingCommit(commit) {
  const { subject, body } = splitCommitMessage(commit);
  return body === '' && DRAIN_BOOKKEEPING_SUBJECTS.some((re) => re.test(subject));
}

/** A PR is AI-generated ONLY if — ignoring mechanical merge commits and the drain's own bookkeeping commits —
 *  it has ≥1 substantive commit and EVERY substantive commit is AI (one human content commit disqualifies it). */
export function isAiGeneratedPr(pr) {
  const commits = Array.isArray(pr?.commits) ? pr.commits : [];
  const substantive = commits.filter((c) => !isMechanicalMergeCommit(c) && !isDrainBookkeepingCommit(c));
  return substantive.length > 0 && substantive.every(isAiCommit);
}

/** Does this PR carry the given label? (#2196 producer-certification signal, e.g. `ready-to-merge`.) The gh
 *  list surfaces labels as `[{ name }]`; tolerant of a missing/odd shape. Pure. */
export function hasLabel(pr, label) {
  if (!label) return false;
  const labels = Array.isArray(pr?.labels) ? pr.labels : [];
  return labels.some((l) => (typeof l === 'string' ? l : l?.name) === label);
}
