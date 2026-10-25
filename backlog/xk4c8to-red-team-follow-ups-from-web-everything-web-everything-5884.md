---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/prototype-load-io.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5884 (head d972f46d4)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5884 (reviewed head `d972f46d4ff635a54bd738152a9d4cae8d703d38`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/prototype-load-io.mjs:92` — (failing-input, degraded) Combined-test waiver is unreachable with this repository’s existing test inventory
   - Scenario: Use a clean candidate overlapping a stale registration whose tip is contained in the proof parents. This checkout has 1,775 tracked test files, exceeding the hardcoded 300-file bound. A read-only injected-I/O probe using the actual inventory returned related-tests-truncated without invoking the runner. Thus even a passing combined tree cannot obtain the new waiver. Complete evidence should remain runnable, for example through bounded batches.
   - Claude's re-check: demonstrated break
2. `we:scripts/operations/prototype-load-io.mjs:126` — (edge-case, degraded) macOS path aliases cause passing test evidence to be rejected
   - Scenario: With an inventory below the cap, create the worktree under macOS TMPDIR /var/folders/... and receive absolute report filenames under /private/var/folders/.... A read-only child-process probe confirmed this cwd canonicalization. Feeding an otherwise valid one-test passing report through the actual proof function returned tests-unproven; changing only its filename to the /var spelling returned success. Both paths identify the same file. Canonicalize the worktree and report paths before comparing them.
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
