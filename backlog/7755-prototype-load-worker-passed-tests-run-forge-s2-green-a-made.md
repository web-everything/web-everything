---
bornAs: xcfw5yt
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# Prototype-load worker passed `--tests-run=forge-s2-green` (a made-up id) and `--audit="NOT WEAKENED"` free tex

HIGH priority hint. - [HIGH, 2026-10-30 13:25 ET, P5 slip] Prototype-load worker passed `--tests-run=forge-s2-green` (a made-up id) and `--audit="NOT WEAKENED"` free text to load #6059@2268ded0 onto verify. 2268ded0 WAS Codex-audited NOT WEAKENED and CI-green, but the gate accepted unverifiable inputs. prototype-load must require real receipts (audit file + tests-run id), card 1909 again.

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
