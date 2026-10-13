---
kind: story
size: 5
status: open
scope: ["we:scripts/lib/native-github-review.mjs", "we:scripts/lib/__tests__/native-github-review.test.mjs", "we:scripts/settings/native-github-review.json", "we:scripts/review-set-label.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Native GitHub reviews mirror our verdicts (adapter, mirror mode)

Our review verdict (review:accepted / review:changes labels set by we:scripts/review-set-label.mjs) also posts as a real GitHub pull-request review from the reviewer App identity, so GitHub's own review-required / approved / changes-requested can later replace the custom review-gate check. Mapping: accepted -> APPROVE, changes -> REQUEST_CHANGES, human-review advisory -> COMMENT (never APPROVE). Pinned to the reviewed head (commit_id), idempotent per (PR, head, verdict), fail-closed when the live token is not the reviewer App. Setting review.nativeGithubReview = off|mirror|authoritative (cascade, default off, repo file sets mirror). Mirror changes no gates: our own stale REQUEST_CHANGES is dismissed when our label verdict clears without an APPROVE, keeping we:scripts/lib/accept-carry-forward.mjs#laterReviewHold (card 5881) consistent. Every mirror logs one 'native-review:' comparison line next to the label verdict for later promotion.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/native-github-review.test.mjs` fails before (the module does not exist) and passes after: mapping, setting cascade, fail-closed identity, sha pinning, idempotency, human-review COMMENT, own-hold dismissal.
- [A2] With `review.nativeGithubReview=mirror` and no reviewer App configured, a live `accepted` verdict posts nothing and logs `native-review: ... outcome=skipped ... reason=reviewer-role-unconfigured`.
- [A3] `grep native-review` over the conveyor `native-review.log` gives one comparison line per mirrored verdict (label verdict, native event, outcome, agree, mode and its source layer).

## Non-goals

- [N1] No ruleset, workflow or required-check change: GitHub's required approval replacing the `review-gate` check is the operator's step after mirror proves out. `authoritative` is reserved and behaves like `mirror`.
- [N2] The human-review advisory wiring in we:scripts/operations/review-pr-io.mjs (held by an open PR) is card x0pyiu3.
- [N3] Re-approving after a drain restamp (a new head) is out of scope; it matters only once "dismiss stale approvals on push" is on.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the review body is fixed text plus a JSON marker; no PR title, body or finding text is interpolated.
2. **Truncated reads** — reviews are read with `--paginate`; an unreadable or malformed page skips the post (idempotency unproven, fail closed).
3. **Shared state files** — the comparison log is append-only, one line per write, best effort; nothing reads it back to decide.
4. **Fail closed** — any unreadable PR, viewer or review read, a moved head, or an identity mismatch posts nothing; the mirror never throws and never writes stdout.
5. **Identity scoping** — posts only when the live token's GraphQL viewer is the configured reviewer bot, the reviewer is not the shared/worker App, and the reviewer is not the PR author; dismissals touch only that bot's own CHANGES_REQUESTED reviews.
6. **State over time** — the review is pinned with `commit_id` = the reviewed head and skipped if the live head moved; idempotent per (PR, head, verdict); our own stale REQUEST_CHANGES is dismissed when our label verdict clears without an APPROVE, so card 5881's `laterReviewHold` and the drain's `reviewDecision` see no hold the labels already lifted.
7. **Who wrote it** — the comparison line names the label verdict, the native event and the setting's source layer; the native review is authored by the reviewer App.
