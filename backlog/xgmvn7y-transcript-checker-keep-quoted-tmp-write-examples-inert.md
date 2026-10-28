---
kind: task
status: open
scope: ["we:scripts/lib/codex-transcript-check.mjs", "we:scripts/lib/__tests__/codex-transcript-check.test.mjs"]
dateOpened: "2026-10-28"
tags: []
---

# Transcript checker: keep quoted tmp-write examples inert

Deferred advisory card suggestion from PR #5912, codex-correctness: quoted command examples can be misclassified as tmp writes. Reproduce quoted redirection and patch examples as data, distinguish executable write destinations, and add a named positive/negative matrix covering quoting, escaping, concatenation and command separators. This finding was explicitly set aside for a follow-up rather than a source fix in PR #5912.

## Acceptance

- [A1] Add a named regression in `we:scripts/lib/__tests__/codex-transcript-check.test.mjs` that demonstrates the quoted-example false positive before repairing it.
- [A2] Quoted examples remain inert while real redirections, patch destinations and explicit tmp writes still produce flags in both warn and fail modes.
- [A3] Run the affected test gate, including the existing command-separator and mktemp send-back regressions.
- [A4] Missing, malformed and truncated transcript evidence must still reject a fail-mode check; quoted docs, config and patch examples remain data until used as executable destinations.

## Non-goals

- [N1] Do not expand the documented wrapped-shell detection limits or change token-cap policy.

## Edge cases this change must handle

1. **Untrusted text** — Cover single/double quotes, escapes, concatenation, newlines and command separators without executing input.
2. **Truncated reads** — Retain incomplete-evidence flags and the inspection cap.
3. **Shared state files** — n/a: parsing operates on a supplied transcript snapshot.
4. **Fail closed** — Preserve malformed and missing-evidence enforcement.
5. **Identity scoping** — Inspect only the requested run's transcript.
6. **State over time** — Keep prior operator send-back cases in the regression matrix.
7. **Who wrote it** — Treat every tool-input record as untrusted, regardless of author.
