---
kind: story
size: 3
status: open
scope: ["we:.github/workflows/merge-gate.yml", "we:docs/agent/testing/fast-drain-live-proof.md", "we:scripts/lib/drain-blocked-reason.mjs", "we:scripts/lib/drain-merge-strategy.mjs", "we:scripts/lib/enqueue-on-event.mjs", "we:scripts/lib/fast-drain-context.mjs", "we:scripts/lib/fast-drain-scope.mjs", "we:scripts/lib/merge-queue-enqueue.mjs", "we:scripts/lib/sibling-clone-provision.mjs", "we:scripts/merge-ai-prs.mjs", "we:scripts/settings/merge-queue.json"]
dateOpened: "2026-11-25"
tags: []
---

# Split PR lane/fastdrain-identity-index into focused changes

size-split-key:504bc04fa19ab89419d2f65a567b62b1506cde50d752038189377f97fd5ef2cf. Plan follow-up splits for PR lane/fastdrain-identity-index. File groups: we:.github/workflows: 8; we:docs/agent: 89; we:scripts/lib: 580; we:scripts/merge-ai-prs.mjs: 285; we:scripts/settings: 4

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
