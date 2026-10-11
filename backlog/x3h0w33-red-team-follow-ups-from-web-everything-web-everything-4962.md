---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/carry-equivalence.mjs"]
dateOpened: "2026-10-11"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#4962 (head 9a6b3b40f)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#4962 (reviewed head `9a6b3b40f40b86e323294b88b915cbc9eac0894c`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/carry-equivalence.mjs:34` — (edge-case, degraded) Malformed settings containers silently enable contribution equivalence.
   - Scenario: With no environment override, settings containing {"review":false}, {"review":[]}, {"review":null}, or a top-level null all resolve to {value:"contribution",source:"default"}. In-memory probes confirmed that differing strict fingerprints with matching contribution fingerprints then compare as equivalent. These malformed policy containers should resolve to strict under the documented fail-closed rule, rather than being treated as absent configuration and enabling the broader tier.
   - Claude's re-check: JSON.parse(...)?.review that is false, [], null, or absent (top-level null) skips the hasOwn check, so the code returns {value:'contribution',source:'default'}. The header says invalid policy fails closed to strict, and loadGateSetting in the same PR fails closed on non-object blocks. The malformed container is treated as unset and enables the broader tier.

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
