---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/review-seat-routing.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7513 (head 55819a67e)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7513 (reviewed head `55819a67e31fc79333e2e584f94e26315ca43e25`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/review-seat-routing.mjs:61` — (failing-input, degraded) Unversioned Claude trailers leave correctness on Claude
   - Scenario: In mode B, a non-card PR with commit message 'fix\n\nCo-Authored-By: Claude &lt;noreply(at)anthropic.com&gt;' selects claude. The regex requires additional text between Claude and the email. This valid Claude identity should select codex; otherwise Claude reviews Claude-built work.
   - Class: live-reproduced (basis: Executed the unchanged routing functions in memory with unrelated imports removed because dependencies were unavailable. claudeTrailerIn returned false and correctnessSeatVendor returned claude for this input.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:scripts/lib/review-seat-routing.mjs:55` — (edge-case, degraded) Codex worker commits route correctness back to Codex
   - Scenario: Run we:scripts/operations/codex-worker.mjs on a code task that leaves dirty files. Its commit step at line 487 emits 'codex-direct pilot: coded by Codex, wrapped by we:scripts/operations/codex-worker.mjs.' followed by 'Co-Authored-By: Claude Opus 5.5 (1M context) &lt;noreply(at)anthropic.com&gt;'. Mode B detects that wrapper trailer and selects codex, assigning Codex to judge Codex-built work. This existing producer must retain a Claude correctness reviewer to satisfy the cross-vendor policy.
   - Class: live-reproduced (basis: Confirmed the existing worker's emitted commit message and executed that input through the unchanged routing functions in memory with unrelated imports removed. The result was codex despite the worker building through codex-direct-task.)
   - Also class: correctness-in-normal-use
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
