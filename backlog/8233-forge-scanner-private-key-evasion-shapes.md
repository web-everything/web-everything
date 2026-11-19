---
bornAs: xs82dq1
kind: task
status: active
scaffoldedBy: "orch-6748-cards"
dateScaffolded: "2026-11-14"
dateOpened: "2026-11-14"
tags: []
related: ["6748"]
---

# we:forge scanner private-key rule: catch pretty-printed private JWK and digit-free base64url private keys

The Forge exec-manifest credential scanner (we:scripts/readiness/forge-exec-manifest.mjs) misses two private-key shapes that the PR 6748 red team reproduced: a pretty-printed (multi-line) private JWK, and a valid digit-free base64url private key. Main misses both, so this is a follow-up card, not a regression. Close the holes without re-introducing the privateKeyPath false positive.

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/readiness/forge-exec-manifest.test.mjs -t "flags a pretty-printed private JWK"` and `-t "flags a digit-free base64url private key"` fail before and pass after; `-t "does not flag a privateKeyPath next to a git revision"` passes before and after.
- [A2] **Must** — fail closed: any ambiguous private-key shape yields a blocking finding, never a warning; JWK/config/data files get the same scrutiny as source.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not fix the privateKeyPath false positive or the quadratic-time lookahead on PR 6748; those are regressions for the PR fixer.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — Scanned bundle text is untrusted; findings must not echo the secret.
2. **Truncated reads** — n/a: scanner reads whole added lines.
3. **Shared state files** — n/a: no shared state files.
4. **Fail closed** — Unknown shapes block, never pass.
5. **Identity scoping** — n/a: no identity.
6. **State over time** — n/a: stateless.
7. **Who wrote it** — n/a: author-independent.

## Duplicate admission

Red-team breaks on PR 6748 at we:scripts/readiness/forge-exec-manifest.mjs:122 and we:scripts/readiness/forge-exec-manifest.mjs:131; main also misses these shapes

new evasion shapes found by red team on PR 6748
