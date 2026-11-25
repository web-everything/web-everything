---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/review-job.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use] from web-everything/web-everything#7430 (head 0826abf5f)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7430 (reviewed head `0826abf5f83927a5d6bfe9b4353e02837f83b0fd`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/review-job.mjs:1700` — (failing-input, degraded) Canonicalize repository aliases before the new session admission check
   - Scenario: Run we:review-dispatch.mjs --mode=session --pr=10 --repo=we --expected-head=&lt;the PR's actual full SHA&gt;. The new router admission forwards repo='we' to createReviewJobIo.liveHead, which invokes gh with --repo=we. That requires an owner/name slug, so the read fails and admission returns refused-head-moved despite an unchanged head. Previously the session dispatcher normalized this supported alias through planReviewDispatch. Normalize the repository before reading its head.
   - Class: correctness-in-normal-use (basis: Source inspection confirms repoKeyForSlug accepts 'we' and maps it to web-everything/web-everything, while the new preflight passes the raw alias to liveHead before normalization. The process reader forwards the argument unchanged; no concurrency or attacker is required.)
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
