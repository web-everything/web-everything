---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/run.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use] from web-everything/web-everything#7256 (head aee261e95)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7256 (reviewed head `aee261e95c4ad32a663217cde7519307dc011618`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/run.mjs:1037` — (failing-input, degraded) The CLI still performs an unquarantined freshness fetch before checking scope
   - Scenario: Run node we:scripts/operations/run.mjs check-scope --files=we:docs/a.md from an ordinary checkout outside a lane, without WE_DAEMON_MANAGED_CLONE=1, when the freshness cache is missing or expired. CHECK_SCOPE_OP was added to the memory-store list but omitted from the preceding zeroWrites list. Consequently assertRunnerFreshness fetches origin/main into the checkout and writes its freshness cache before the quarantined scope reader runs. The advertised read-only command should also select zeroWrites for this preflight.
   - Class: correctness-in-normal-use (basis: Executed the real assertRunnerFreshness with the check-scope declaration and recording Git/filesystem adapters. It requested fetch origin +refs/heads/main:refs/remotes/origin/main and cache write/rename operations. The CLI wiring supplies zeroWrites:false for check-scope. No actual filesystem mutation or fetch was performed.)
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
