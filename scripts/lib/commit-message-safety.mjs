/**
 * @file commit-message-safety.mjs — the #2779-incident guard (2026-09-26 03:14Z).
 *
 * INCIDENT. PR #2785 (branch `lane/2779-session-token-fresh`) merged; the drain's own resolve-on-land
 * bookkeeping then committed `drain: resolve #2779 on land (#2748)`. GitHub reads "resolve #2779" as a CLOSING
 * KEYWORD reference — the same vocabulary as "closes #N" / "fixes #N" — so pushing that commit to `main`
 * auto-closed pull request #2779 (a real, unmerged bg-isolation fix, wrongly credited as this PR's own
 * database identically to how "resolves #2779 …") as a side effect nobody intended. GitHub's closing-keyword
 * grammar (https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/using-keywords-in-issues-and-pull-requests)
 * fires on `close(s|d)?`, `fix(es|ed)?`, `resolve(s|d)?` immediately followed by `#N` (optionally with a colon
 * in between), in EITHER a commit message that lands on the repo's default branch OR a PR/issue body — never
 * in a plain comment. The drain's OWN commit messages are exactly such commit messages, so every template it
 * writes must be provably free of this shape before it is ever handed to `git commit -m`.
 *
 * THE FIX IS NOT "never say resolve" — the drain's job IS to say a card resolved. The fix is: refer to the
 * card by its bare number (`card 2779`, `card:2779`) rather than by `#2779`. That reads identically to a human
 * and is fully searchable/grep-able, but carries none of GitHub's auto-close grammar, because the trigger is
 * the `#N` sigil specifically, not the word "resolve" alone.
 *
 * `hasClosingKeywordRef` is the pure detector (unit-tested directly); `assertNoClosingKeywordRef` is the
 * RUNTIME guard every drain-authored commit-message template is wrapped in (`lane-drain.mjs`) — belt AND
 * suspenders, so a future edit that reintroduces the shape fails LOUD, at the point of the write, rather than
 * silently landing on `main` and closing someone else's PR again.
 */

// GitHub's closing-keyword grammar: one of the keyword forms as a WHOLE word, then a reference. Case-insensitive
// (GitHub's own matcher is). Reference forms (GitHub "Linking a pull request to an issue"):
//   - `#N`                 — optional colon/whitespace between keyword and `#` (`fix #1`, `fixes: #1`, `fix#1`);
//   - `owner/repo#N`, a full `https://github.com/o/r/(issues|pull)/N` URL, or `GH-N` — these need a real separator
//     (whitespace, or a colon) after the keyword, so a token that merely STARTS with a closing verb
//     (`fixtures/foo#12`, `closer/x#1`, `fix-it/a#1`) is never mistaken for one (#6774 round 3).
// `\s*(?::\s*)?#` (not `\s*:?\s*#`): two adjacent `\s*` backtrack quadratically on a keyword followed by a long
// whitespace run with no `#` (~8s on a 64 KB body) — this form matches the same strings in linear time.
const CLOSING_KEYWORD_REF = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)(?:\s*(?::\s*)?#\d+|(?:\s*:\s*|\s+)(?:[\w.-]+\/[\w.-]+#\d+|https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/\d+|gh-\d+\b))/i;

/** Pure: does `text` contain a GitHub closing keyword followed by a reference (`#N`, `owner/repo#N`, issue/PR URL, `GH-N`)? */
export function hasClosingKeywordRef(text) {
  return CLOSING_KEYWORD_REF.test(String(text ?? ''));
}

/**
 * Throws if `text` contains a closing-keyword + `#N` reference; returns `text` unchanged otherwise, so it can
 * be wrapped directly around a message-building expression at the call site (`quietGit(CWD, ['commit', '-m',
 * assertNoClosingKeywordRef(\`drain: …\`), …])`).
 * @param {string} text
 * @param {string} [label] — what to call `text` in the thrown error (e.g. "commit message", "PR body").
 */
export function assertNoClosingKeywordRef(text, label = 'message') {
  if (hasClosingKeywordRef(text)) {
    throw new Error(
      `refusing to write a drain ${label} containing a GitHub closing-keyword + #N reference `
      + `(#2779-incident guard — this would auto-close whatever #N names on the next push to main): ${JSON.stringify(String(text))}`,
    );
  }
  return text;
}
