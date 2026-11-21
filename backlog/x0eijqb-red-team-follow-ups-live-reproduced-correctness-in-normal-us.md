---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/run.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7268 (head ac95f9c7f)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7268 (reviewed head `ac95f9c7f7a119c12eff43be974cc1f8d11a4b1d`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/run.mjs:284` — (failing-input, degraded) --preview still attempts persistent writes before validation
   - Scenario: Run build-priority-set --ids=42 --mode=only --ttl-hours=2 --actor=operator --reason=probe --preview with an unwritable operation-run directory. The CLI selects createFileRunStore and calls store.write before validating card evidence, so preview fails attempting to create the directory. With writable storage it persists run records despite the writes-nothing promise. Preview should select an in-memory store and suppress persistent call logging.
   - Class: live-reproduced (basis: Executed the actual CLI entry point with filesystem mkdirSync intercepted to reject mutations, OPERATION_RUNS_DIR=/nonexistent/red-team-preview-runs, and the managed-clone freshness exemption. It attempted mkdirSync on that directory and exited 1 before preview validation. No files were changed.)
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
