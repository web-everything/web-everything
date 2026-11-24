---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/lane-pool-origin.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use] from web-everything/web-everything#7419 (head 6c83e215f)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7419 (reviewed head `6c83e215f8d10885e4a2eaa9756a2434f1d1114c`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/lane-pool-origin.mjs:27` — (edge-case, degraded) The origin guard rejects the repository's recognized GitHub rename
   - Scenario: Keep an existing lane's origin as git(at)github.com:chalbert/web-everything.git while the primary uses git(at)github.com:web-everything/web-everything.git. Acquisition skips the valid lane automatically and refuses explicit acquisition as WRONG-ORIGIN. The existing lane-alternates module explicitly recognizes these URLs as the same repository; the new comparator should preserve that supported alias.
   - Class: correctness-in-normal-use (basis: A read-only Node probe confirmed existing sameRepoUrl returns true for these exact URLs while new originsDiffer returns true. The alias is explicitly codified in we:scripts/lib/lane-alternates.mjs; this requires only existing lanes retaining the pre-rename URL.)
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
