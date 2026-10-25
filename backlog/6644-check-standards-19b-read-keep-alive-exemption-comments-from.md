---
bornAs: xr097a5
kind: task
status: open
scope: ["we:scripts/check-standards-rules.mjs", "we:scripts/lib/__tests__/test-keepalive.test.mjs"]
dateOpened: "2026-10-20"
tags: []
---

# check:standards 19b: read keep-alive exemption comments from one whole-file scanner pass

Follow-up to the keep-alive leak fix (branch lane/keepalive-leak-a). The final read-only audit (VERDICT: WEAKENED — template text can incorrectly exempt an unmanaged timer from the guard) found that isExempt in we:scripts/check-standards-rules.mjs calls ts.getTrailingCommentRanges from an offset inside a template literal, so text such as `${setInterval(() => {}, 1000)}// keepalive-helper-ok: x` reads as an exemption comment. The operator ruled that case deliberate obfuscation and out of scope for the first PR, accepting it as-is. Fix: collect exemption comments from a single TypeScript scanner / comment-range pass over the whole file (lexical context preserved, template text never a comment), then attach by position to the flagged call's statement or list element; add the audit example as a test in we:scripts/lib/__tests__/test-keepalive.test.mjs.

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/lib/__tests__/test-keepalive.test.mjs` (through `we:scripts/readiness/heavy-admission.mjs run`): a new case asserting that `` `${setInterval(() => {}, 1000)}// keepalive-helper-ok: x` `` (template text after an in-template call) is FLAGGED fails before this item and passes after; every existing exemption case still passes.
- [A2] Must: exemption comments come only from one whole-file comment/scanner pass that preserves lexical context (template and string text is never a comment); on any scanner inconsistency the call is NOT exempt (refuse).

## Non-goals

- [N1] Other deliberately obfuscated forms (eval, computed non-literal keys, aliases via variables) stay out of scope per the 2026-10-20 operator ruling.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the scanned file is untrusted text: only scanner-classified single-line comments can exempt; template/string text never can.
2. **Truncated reads** — a file that does not parse fully stays a gate error (unchanged), never "no findings".
3. **Shared state files** — n/a: a pure read-only scan, no state written.
4. **Fail closed** — any doubt about whether a comment is real leaves the call flagged.
5. **Identity scoping** — n/a: no identities involved.
6. **State over time** — n/a: evaluated fresh on every gate run.
7. **Who wrote it** — n/a: authorship does not affect the rule; only the comment's lexical position does.
