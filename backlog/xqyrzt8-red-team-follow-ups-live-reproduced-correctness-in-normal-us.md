---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/soak-precheck-at-open.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7357 (head eafb4fde0)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7357 (reviewed head `eafb4fde09648fb0831ba3db03219ffdf24bb950`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/soak-precheck-at-open.mjs:19` — (edge-case, degraded) Git-quoted filenames bypass the new sidecar requirement
   - Scenario: Add scripts/conveyor/soak/breaks/caféwe:.soak.test.mjs without a sidecar in a test-only PR. With Git's default core.quotePath, name-status quotes and escapes this path. parseNameStatus preserves those quotes, so the prefix/suffix check skips it. Passing that exact Git-format input through the production parser and precheck returned ok:true; it should refuse the missing sidecar.
   - Class: live-reproduced (basis: A read-only Node probe invoked the actual parseNameStatus and soakPrecheckAtOpen functions. The ordinary ASCII path was refused, while the Git-quoted non-ASCII path was accepted without timing evidence.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:scripts/lib/soak-precheck-at-open.mjs:26` — (failing-input, degraded) Sidecar validation checks working-tree bytes instead of the published commit
   - Scenario: Commit a new soak test without its sidecar, then leave a valid sidecar untracked in the checkout. The precheck reads that untracked file and accepts, allowing publication of a commit without the required committed evidence. Conversely, publishing an explicit --sha containing both files from a checkout lacking the sidecar falsely refuses. Validate the sidecar from refSha, which already determines the changed-file list.
   - Class: correctness-in-normal-use (basis: The production CLI computes files from refSha but passes only repoRoot to the reader. An in-memory filesystem probe confirmed acceptance of working-tree-only evidence and refusal when valid source-commit evidence is absent from the working tree; no files were created or changed.)
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
