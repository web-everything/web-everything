---
kind: story
size: 2
status: open
scope: ["we:scripts/drain-classify-only.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use] from web-everything/web-everything#7260 (head d826c6d8d)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7260 (reviewed head `d826c6d8de357483f4369b21513c0e59f3930ad9`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/drain-classify-only.mjs:24` — (failing-input, degraded) The new handler never receives cross-repo context listing failures from the configured workflow.
   - Scenario: Run the workflow with an otherwise enqueueable local PR: its own-repo listing succeeds, but frontier-ui/frontierui returns a permission denial. runCli invokes merge-ai-prs with --this-repo, so failedRepos only describes the own-repo candidate listing. The other repository fails inside collectOpenPrContext, which records contextComplete=false without exposing failedRepos in the result JSON. Consequently this new branch is skipped and the PR can receive enqueue instead of unknown with a reason. An isolated probe of the actual collector and classifier functions reproduced the missing failure fiel
   - Class: correctness-in-normal-use (basis: The workflow's actual CLI arguments restrict candidate listings to the local repository; cross-repo reads use the separate context collector. This ordinary permission-denial path is absent from the new tests, which inject cross-repo failedRepos entries directly.)
   - Claude's re-check: demonstrated break

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
