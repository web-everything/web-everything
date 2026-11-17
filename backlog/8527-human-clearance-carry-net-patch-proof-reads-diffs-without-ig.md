---
bornAs: xv40a0y
kind: task
status: active
scaffoldedBy: "fix-6659"
dateScaffolded: "2026-11-10"
dateOpened: "2026-11-10"
tags: []
related: ["6659"]
---

# human-clearance-carry net-patch proof reads diffs without --ignore-submodules=none

human-clearance-carry net-patch proof reads diffs without --ignore-submodules=none. Context from the finding: same class as PR 6659 red-team break: tracked ignore=all hides an unreviewed submodule pointer change from proveIdenticalNetPatch (we:scripts/lib/human-clearance-carry.mjs passes a raw exec); fix by wrapping with submoduleStrictExec or hardening we:scripts/lib/identical-net-patch.mjs itself.

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

## Duplicate admission

same class as PR 6659 red-team break: tracked ignore=all hides an unreviewed submodule pointer change from proveIdenticalNetPatch (we:scripts/lib/human-clearance-carry.mjs passes a raw exec); fix by wrapping with submoduleStrictExec or hardening we:scripts/lib/identical-net-patch.mjs itself
