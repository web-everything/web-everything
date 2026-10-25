---
bornAs: xp6xw0p
kind: story
size: 2
status: open
scope: ["we:scripts/operations/adoption-matrix-io.mjs"]
dateOpened: "2026-10-24"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5867 (head 5e4c1c665)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5867 (reviewed head `5e4c1c665b4767e7ca841fdfc6841327cda7a135`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/adoption-matrix-io.mjs:111` — (edge-case, degraded) Missing objects bypass the shallow-history safeguard and produce false negative adoption results.
   - Scenario: Use a shallow clone whose HEAD directly descends from a logged fix SHA omitted by the shallow boundary. Reproduced read-only against this checkout: HEAD 5e4c1c665b4767e7ca841fdfc6841327cda7a135 names parent 499e2eb6d79b526e702dd7afc5951fea72838ede, and Git confirms the repository is shallow. Supplying that parent as the logged SHA to createAdoptionMatrixReader, using the installed CommandLineTools Git executable, returns cells:["no (not in clone)"] without an incomplete warning. The missing-object return occurs before the shallow check. Because the fix is already HEAD's parent, this is a false
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
