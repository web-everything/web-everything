---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/daemon-rebuild/deps-job.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Red-team follow-ups [live-reproduced, coverage-or-style] from web-everything/web-everything#7592 (head 250c00b3d)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7592 (reviewed head `250c00b3d6ffb33afbeece2db1138cf6c9aeb33a`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/daemon-rebuild/deps-job.mjs:142` — (edge-case, degraded) Computed method names are incorrectly skipped as lazy function bodies
   - Scenario: Inspect 'const obj = {\n [await import("missing-computed-package")] () {}\n};' with the real TypeScript parser. The inspector returns packages: [], but executing this declaration immediately attempts the import and fails with ERR_MODULE_NOT_FOUND. Computed method names execute during object creation without invoking the method. They must be inspected in the enclosing startup context; only the method body should inherit the lazy function context. Removing the indentation makes this same import detectable.
   - Class: live-reproduced (basis: Reproduced both the empty package evidence from inspectDepsImports and the runtime import failure using the identical source. Also confirmed that removing indentation reports the package. This uses a literal specifier and never invokes the method, so the documented computed-specifier and invoked-function exclusions do not apply.)
   - Also class: coverage-or-style
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
