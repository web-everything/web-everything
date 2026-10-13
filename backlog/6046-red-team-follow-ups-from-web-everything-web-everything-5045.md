---
bornAs: xgzvwyx
kind: story
size: 2
status: open
scope: ["we:scripts/lib/daemon-live-smoke.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5045 (head 8879b3b3d)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5045 (reviewed head `8879b3b3da70cc0be00c1dd7c92750f882c8a291`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/daemon-live-smoke.mjs:1231` — (failing-input, degraded) A dirty filename containing 'rate limit' launders an unrelated cleanliness failure into an outage hold.
   - Scenario: Reproduced through runLiveSmokeWithRetry with injected git/gh results and retries=0: initial git status is empty, final status reports an untracked 'rate limit.txt', every other smoke check passes, and the subsequent bulk GitHub probes return HTTP 502. The only failed row is tree-stays-clean with mayBeTransient=false, but the unrestricted /rate limit/i signature treats its filename as a GitHub-read failure. The result is env-unavailable, suppressing the code rejection and reporting GitHub as the cause of a dirty tree. This unrelated cleanliness failure should remain code and prevent outage cla
   - Claude's re-check: isGithubReadFailureRow tests the detail text against /rate limit/i and ignores mayBeTransient. A non-transient tree-stays-clean row whose detail includes a filename like 'rate limit.txt' therefore counts as a GitHub read failure. The diff's own test shows non-transient rows are excluded for transient patterns, but this path has no such guard. If the bulk probes then return 502, the verdict becomes env-unavailable and the dirty tree is hidden. This assumes the row's detail includes the filename, which the diff doesn't show.

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
