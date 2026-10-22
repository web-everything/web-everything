---
bornAs: x89ywtw
kind: story
size: 3
status: open
scope: ["we:scripts/lib/git-identity.mjs", "we:scripts/lane-pool.mjs", "we:scripts/guard-git-identity.mjs"]
dateOpened: "2026-10-20"
tags: []
---

# Git-identity check: close the 4 round-5 audit gaps

Follow-up to the placeholder-git-author check (lane/git-identity-check). Operator stopped iterating after 5 Codex audit rounds and accepted these 4 round-5 findings verbatim as follow-up: (1) we:scripts/lib/git-identity.mjs:74 High: Malformed nested settings erase valid lower-layer additions: platform extraNames [CI Service] plus tool extraNames {nested: []} makes that placeholder pass; empty objects also escape the required warning. (2) we:scripts/lib/git-identity.mjs:232 High: Multiple local core.hooksPath values make repair fail silently because the error is returned without logging and callers discard it, allowing acquire to hand out a lane whose guards remain disabled. (3) we:scripts/lib/git-identity.mjs:62 Medium: Normal guard/bootstrap/lane-pool invocations emit no placeholder-setting source diagnostic because cascade logging defaults off outside daemons, violating the logged-source requirement. (4) we:scripts/lane-pool.mjs:2841 Medium: Human-readable status --leased-only probes unleased lanes again; the added reporting loop performed 300 synchronous git calls in 4.6 seconds for 100 entries, defeating the existing skip optimization.

## Acceptance

- [A1] **Executable** — `npx vitest run` over we:scripts/lib/__tests__/git-identity.test.mjs and we:scripts/__tests__/lane-pool-hooks-path.test.mjs gains one red-then-green case per finding: (1) platform `extraNames: ["CI Service"]` + tool `extraNames: {nested: []}` still flags "CI Service", and an empty-object value warns; (2) a lane with two local `core.hooksPath` values is logged and `acquire` refuses/flags it; (3) the guard, bootstrap and lane-pool each print one `gitIdentityPlaceholders` source line; (4) `status --leased-only` spawns no identity/hooks git in an unleased lane.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not change the built-in placeholder list or the fail-closed commit guard ruling.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — settings values are validated per layer before merging; a bad layer is ignored with a warning and never erases a lower valid layer.
2. **Truncated reads** — a `git config --get` that errors (multiple values, timeout) is logged and reported, never treated as ok.
3. **Shared state files** — lane `.git/config` is written only by provision/refresh/acquire; `status` stays write-free.
4. **Fail closed** — a lane whose hooksPath cannot be repaired is flagged loudly at hand-out; the commit guard keeps refusing on any error.
5. **Identity scoping** — identity resolved per lane by git; output never prints a full email address.
6. **State over time** — the source line logs once per process per distinct effective setting.
7. **Who wrote it** — n/a: no new records are written; findings came from the round-5 Codex audit of lane/git-identity-check.
