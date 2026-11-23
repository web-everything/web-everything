---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/wip-publish.ts", "we:scripts/__tests__/wip-publish.test.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Prevention — Move arg parsing and the token-required decision into a pure function under src/wip/, with unit tests. Al… (from plateauapp/plateau-app#230 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/wip-publish.ts:66` — Move arg parsing and the token-required decision into a pure function under `src/wip/`, with unit tests. Alternatively, add a smoke test that spawns the script with `--out` and an empty environment.
2. `we:scripts/wip-publish.ts:66` — Extract CLI mode parsing (--out, --once, --http, the token requirement) into a pure function in src/wip. Add a unit test that asserts --out yields mode 'dump' with no token requirement and no send. Add a subprocess smoke test for `--out` run with credentials unset.
3. `we:scripts/wip-publish.ts:129` — Add deterministic CLI tests to CI covering the output contract, missing-path validation, and absent credentials, with network attempts intercepted and asserted absent.
4. `we:scripts/wip-publish.ts:129` — Add the named CLI regression tests to the automated test gate, using an isolated process and observable publishing stubs to enforce credential independence, output correctness, and absence of publication.

Idempotency key (do not edit): approval-prevention-key:plateauapp/plateau-app#230@95c09f1086d06f160d620147eef5211e49973396

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
