---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/daemon-live-smoke.mjs"]
dateOpened: "2026-10-26"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5960 (head 9ac3e3cb9)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5960 (reviewed head `9ac3e3cb9977fe0dfa3837e39e9cafad71f93633`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/daemon-live-smoke.mjs:272` — (failing-input, degraded) A normal Node stack trace still hides the actual error
   - Scenario: Probed a real runBounded child executing: console.error("pr-snapshot: smoke sample 3"); function crash(n) { if (n) return crash(n - 1); throw new Error("UNIQUE_REAL_FAILURE"); } crash(12); Passing its rejection into reconcile-dry-run produces a detail containing only the informational preamble and a stderrTail containing five stack frames plus the Node version. UNIQUE_REAL_FAILURE is absent from the entire row, even though the tail is well below 500 characters. Preserve the primary error line within the diagnostic budget alongside the stack tail.
   - Claude's re-check: demonstrated break
2. `we:scripts/lib/daemon-live-smoke.mjs:485` — (edge-case, degraded) Reconcile's timeout-only branch discards captured stderr
   - Scenario: With repos=["example/repo"], make runChild reject with Error("timed out after 120000ms (process group killed)") carrying stderr="Error: waiting on missing state file\n". The returned row has the timeout summary but no stderrTail: this early return discards the diagnostics already collected. Consequently rejection and held-state details cannot retain that child's diagnostic. Attach the collected stderrTail while preserving the exact timeout detail used by classifiers.
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
