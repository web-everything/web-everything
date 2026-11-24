---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:src/main.ts", "we:src/route-mounts.test.ts", "we:src/__tests__/main.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Extract the initial-load block into we:route-mounts.ts as an injectable function (initialRouteLoad({isLog… (from plateauapp/plateau-app#235 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:src/main.ts:996` — Extract the initial-load block into we:route-mounts.ts as an injectable function (`initialRouteLoad({isLoggedIn, fetch, getPath, token})`) and unit-test it. Alternatively, add a Playwright direct-load smoke test per route as a check:standards requirement for route fixes.
2. `we:src/main.ts:1002` — Route both paths through one 'wait for container, then act' helper with a bounded frame retry. Add a test where the container appears after the data resolves.
3. `we:src/main.ts:996` — Extract the initial-load block into `we:route-mounts.ts` as an injectable function, e.g. `runInitialLoad({isLoggedIn, path, fetch, tokenSource})`. Then add a gate test and a stale-token test. A standards check could also flag security-relevant conditionals in `we:src/main.ts` that no test imports.
4. `we:src/route-mounts.test.ts:31` — Add a parameterized browser test to plateauapp/plateau-app's Tier-1 smoke suite covering seven routes, both themes, actual direct loads, and subsequent navigation; require it in CI.
5. `we:src/main.ts:997` — Add CI-required bootstrap tests in plateauapp/plateau-app covering default logged-out, explicit logged-out, and authenticated states, with observable fetch and mount assertions.
6. `we:src/route-mounts.test.ts:31` — Add the named parameterized browser test to the required Tier-1 CI gate, covering seven routes and both themes.
7. `we:src/main.ts:997` — Require a startup integration test with explicit logged-out and logged-in states in CI, asserting mount and request behavior.

Idempotency key (do not edit): approval-prevention-key:plateauapp/plateau-app#235@f4e36f5ceb46f5d02afab370281ac6e5877d5d11

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
