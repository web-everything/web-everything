---
bornAs: xakxnnj
kind: story
size: 2
status: open
scope: ["we:ff.json", "we:ff2.json", "we:scripts/operations/coroner-extract.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# The coroner skill orders step 2d (false findings, `--since=last`) after step 1, but step 1 advances the cursor

LOW priority hint. 396. (coroner-1031, held, LOW) The coroner skill orders step 2d (false findings, `--since=last`) after step 1, but step 1 advances the cursor, so 2d reads an empty 4-minute window. Seen tonight: 0 findings until re-run with the explicit ISO time. The extractor also ran about 4 min in the foreground (auto-backgrounded at 180 s) and there is still no coroner-assistant script (7069), so ASSISTANT is hand-streamed for the 4th night.     Fix idea: extractor `--since=last` writes the cursor only after the false-findings and rounds scripts finish (one wrapper, or `--save-after`); run both from one command.     Evidence: we:ff.json vs we:ff2.json tonight (window 02:47-02:51Z vs 02:49Z 10-31). Scope: we:scripts/operations/coroner-extract.mjs, we:.claude/skills/coroner/SKILL.md. Size 1.

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
