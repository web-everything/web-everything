---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/enqueue-on-event.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use] from web-everything/web-everything#7424 (head 8e7fb8b0c)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7424 (reviewed head `8e7fb8b0c9e9b609752bdbdb356f87144c469d3c`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/enqueue-on-event.mjs:773` — (failing-input, degraded) Routine drain preambles hide the actual error
   - Scenario: Supply stderr 'policy · drain.overlapYieldOnlyToEnqueueable=on (source: default)\nmerge-ai-prs ✗ Error: merge queue refused\n' and exit 1. The new diagnostic publishes only the policy setting; 'merge queue refused' remains lost. we:merge-ai-prs.mjs unconditionally emits this configuration preamble at lines 4974–4975 before drain work, so ordinary failures encounter this sequence. Select the actual error after informational preambles, retaining sanitization and redaction.
   - Class: correctness-in-normal-use (basis: A read-only probe executed the source-extracted runChild and sanitizer with an injected child and the real policy formatter. stderrFirstLine contained only the policy preamble and omitted the error. The production drain's unconditional preamble establishes ordinary reachability; no production drain was launched.)
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
