---
kind: story
size: 8
status: open
scope: ["we:scripts/lib/import-closure.mjs", "we:scripts/lib/daemon-rebuild/closure-scope.mjs", "we:scripts/lib/daemon-rebuild/skip-unrelated.mjs"]
dateOpened: "2026-11-01"
tags: []
---

# Closure-scope exclusion: fail-closed allowlist instead of per-form dynamic-eval detection (from #6033)

Design-stage card split from #6033 (R387). The closure-scope exclusion decides which files a daemon rebuild may treat as unrelated. Per-form detection of dynamic code loading keeps losing: the red-team found a new break class every round, each letting an executable dependency be excluded. Classes found: (1) inspector (node:inspector evaluating code), (2) Function constructor, (3) Function-constructor alias (indirect reference to Function), (4) TS import-assign (import x = require(...)). R115: a new break class in 3 consecutive rounds means stop rounds and return to design; this is a design-stage miss, so no more detector patches. DESIGN QUESTION: replace the denylist of dynamic-eval forms with a fail-closed allowlist (a file is excluded only when it is proven to be one of an explicit set of inert forms: static ESM/CJS imports with literal specifiers, no eval-capable globals or builtins), and everything else counts as in-closure. Decide: allowlist grammar, how unknown syntax or parse failure is handled (in-closure), the cost in rebuilds skipped, and the red-team proof required before build. Code: we:scripts/lib/import-closure.mjs, we:scripts/lib/daemon-rebuild/closure-scope.mjs, we:scripts/lib/daemon-rebuild/skip-unrelated.mjs. Prior work to mine: lane/overlay-generation-s1-r2.

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
