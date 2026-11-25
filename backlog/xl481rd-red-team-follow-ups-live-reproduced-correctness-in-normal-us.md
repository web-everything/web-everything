---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/review-seat-runner.mjs", "we:scripts/lib/agy-review-juror.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7471 (head 6d048b304)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7471 (reviewed head `6d048b30492069cf7f383262d7cad355b5944d1a`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/review-seat-runner.mjs:102` — (edge-case, degraded) Multiple read_file-only errors bypass the slot refund
   - Scenario: Run a Carbon shadow with two completed read_file steps: parameters {path:'we:AGENTS.md',file_path:'we:README.md'} and {path:'we:package.json',file_path:'we:package-lock.json'}. The juror combines both diagnostics into one reason. The refund regex accepts only one formatted diagnostic, so releaseSession is never called despite read_file being the sole void cause. These attempts should refund their reservations. A single diagnostic containing a filename such as 'a].txt' also misses the regex.
   - Class: live-reproduced (basis: Executed the unchanged containment and runner functions with injected admission, juror and release hooks; unrelated imports were stubbed because markdown-it was unavailable. The single-error control invoked release once; both failing cases invoked it zero times.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:scripts/lib/agy-review-juror.mjs:315` — (failing-input, degraded) A file URL and ordinary path still void a same-file read
   - Scenario: Supply one read_file step with path equal to the absolute in-lane we:AGENTS.md path and file_path equal to its file:// URL. Both identify the same existing file, but seenPaths canonicalizes the URL through resolve(cwd,path) without converting it to a filesystem path. The function reports an invalid-path void instead of accepting the same-file read.
   - Class: live-reproduced (basis: Executed the unchanged stateChangingToolCalls function against the checked-out we:AGENTS.md with an actual filesystem-backed allowed root. It returned a void diagnostic naming we:AGENTS.md twice. Unrelated imports were stubbed; filesystem and path operations were real.)
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
