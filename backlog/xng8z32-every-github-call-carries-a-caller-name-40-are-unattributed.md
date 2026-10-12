---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/gh-throttle.mjs"]
dateOpened: "2026-10-12"
tags: []
---

# Every GitHub call carries a caller name (40% are unattributed)

Held finding 225 (coroner-5). After the 18:30 ET shim fix: 13.2k calls/h, of which unknown 3.2k/h and node 2.0k/h (12 h: 18.9k unknown + 4.5k node of 114.5k deduped calls; top ops api -i, rest pulls/N, api --method, job logs). spend-hourly.jsonl is mostly unattributed, so cuts cannot be targeted. Fix: the gh shim and runGhSync fill caller from WE_GH_CALLER, else the parent script basename (argv[1]), else the launcher daemon label; health smell when the unattributed share passes a setting (default 10%). Evidence: .lanes/.admission/gh/calls.jsonl 2026-10-10 12:14Z-00:24Z. Also touches the gh-shim source and launchd templates.

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
