---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/main-staleness.mjs", "we:scripts/lib/__tests__/main-staleness.test.mjs"]
dateOpened: "2026-10-11"
tags: []
---

# Prevention — Add a gate for the redirect: require rev-list --count origin/main..HEAD to be 0 (HEAD is an ances… (from web-everything/web-everything#4977 review)

Filed mechanically by the unattended review loop (#2749) — every finding below reduced web-everything/web-everything#4977's review (reviewed head `74ca159a33355282c578e96b67cc613a3a8bafc6`) to prevention-outstanding by naming a guard neither captured nor filed:

1. `we:scripts/lib/main-staleness.mjs:415` — Add a gate for the redirect: require `rev-list --count origin/main..HEAD` to be 0 (HEAD is an ancestor of origin/main, or equal to it) and that the candidate's origin URL equals the root's. Pin both with fallback tests. A standards rule that any re-exec target must be verified as a reviewed-main checkout would cover the whole class.

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
