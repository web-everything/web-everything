---
bornAs: xge2d7v
kind: story
size: 3
status: open
scope: ["we:scripts/lane-drain.mjs", "we:scripts/lib/numbering-carry.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Numbering-carry proof allow-list is narrower than what numberPendingHashes rewrites, so a valid drain numberi…

Flow-sim gap R9c-G3, class K19 (proof or inventory check mismatch). Failing input: PR accepted on head A (plain agent accept, so needsAcceptanceRestamp is false, or the drain-path restamp failed). The PR adds a hash card xabc123 that is cited by agent-memory-src/*.md, a scripts/conveyor/flows/*we:.flow.json, a soak break file, or a relatedReport path (numberPendingHashes scopes #3100, #4075, #2400). Drain num… Cited: we:scripts/lane-drain.mjs:1143-1166, we:scripts/lib/numbering-carry.mjs:118-122, we:scripts/lib/numbering-carry.mjs:216-325, we:scripts/lib/numbering-carry.mjs:664-667, we:scripts/lib/numbering-carry.mjs:668. Soak-break sketch: Fixture: real git repo, accepted head A, hash card plus an agent-memory-src note citing it; run numberPendingHashes to make commit B. Action: proveNumberingOnlyMove({fromSha:A,toSha:B}). Assert (fails today): ok:true (id-only rewrite of a note citing the same…

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
