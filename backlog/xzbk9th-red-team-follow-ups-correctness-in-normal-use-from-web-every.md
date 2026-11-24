---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/review-job.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use] from web-everything/web-everything#7430 (head 2096ae413)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7430 (reviewed head `2096ae413bdedd47db67dc65beab95f297697ca4`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/review-job.mjs:1644` — (failing-input, degraded) Required head lookup rejects supported repository keys before normalization
   - Scenario: Run we:review-dispatch.mjs with --pr=77 --repo=we and --expected-head equal to the PR's actual full SHA. The new mandatory guard calls liveHead with repo='we', producing gh arguments containing --repo=we. That read fails and dispatch returns refused-head-moved before planReviewDispatch can normalize 'we' to 'web-everything/web-everything'. Supported repository keys should be normalized before the head lookup, allowing a matching head to proceed.
   - Class: correctness-in-normal-use (basis: Source inspection confirms planReviewDispatch accepts internal keys through repoKeyForSlug, while createReviewJobIo.liveHead passes its repository argument directly to gh. Full-module probes were blocked by missing dependencies; this is not claimed as live-reproduced.)
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
