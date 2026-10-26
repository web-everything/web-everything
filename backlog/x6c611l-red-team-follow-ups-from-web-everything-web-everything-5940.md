---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/daemon-rebuild/rebuild.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5940 (head 3b271f87d)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5940 (reviewed head `3b271f87d33d93186f56569ad8cc37cfd621b017`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/daemon-rebuild/rebuild.mjs:71` — (edge-case, degraded) Versioned clones emit the version ID as the daemon identity.
   - Scenario: Call rebuildClone with root=/workspace/.daemon-clones/wev-review-daemon/versions/20261025-oldsha, versioning enabled, asJob=false, and a failed Git fetch. A read-only probe returned fetch-failed and emitted daemon='20261025-oldsha', although resolveVersionedContext identified 'wev-review-daemon'. Events should use the logical clone identity so attribution remains stable across versions. The adoption branch has the same basename calculation.
   - Claude's re-check: demonstrated break
2. `we:scripts/lib/daemon-rebuild/rebuild.mjs:61` — (edge-case, degraded) Thrown rebuild failures bypass failure-event emission.
   - Scenario: Make mkdirSync throw EACCES while acquiring the clone write lock, with a healthy injected emitEvent callback. A read-only fault-injection probe confirmed rebuildClone rejects with EACCES and emits zero events because rebuildCloneInternal is awaited before event handling. Emit rebuild-failed best effort for this exception while preserving the original rejection.
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
