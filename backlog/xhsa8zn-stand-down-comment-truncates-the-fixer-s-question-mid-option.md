---
kind: story
size: 1
status: open
scope: ["we:scripts/conveyor/fix-procedure.mjs", "we:scripts/conveyor/stand-down.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Stand-down comment truncates the fixer's question mid-options

Held item 209 (session 2026-10-10; stuck-PR class). Live #4631 (18:00Z): "Operator choice: (a) the drain's mechanical park uses i" -- the options were cut, so the operator could not see the choices; the full text was not in any job/run record either. Fix: never truncate the question+options block (put long rationale in a collapsed <details>), and persist the full stand-down text in the run record.

## Acceptance

- [A1] **Executable** — a test with a long question and options renders every option in full; rationale over the limit goes in `<details>`; the run record holds the full text.
- [A2] **Live** — the next stand-down with options shows them all.

## Non-goals

- [N1] Changing when a fixer stands down.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — Fixer text is rendered as markdown inside the comment; HTML-like content stays escaped.
2. **Truncated reads** — If the GitHub comment limit still applies, cut only the rationale, never the question or options, and link the run record.
3. **Shared state files** — n/a: comment write via the existing writer.
4. **Fail closed** — If the question cannot fit, post the options first.
5. **Identity scoping** — Per PR and head.
6. **State over time** — n/a.
7. **Who wrote it** — The comment names the fixer run id.
