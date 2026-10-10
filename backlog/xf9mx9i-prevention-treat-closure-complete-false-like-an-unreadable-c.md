---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:tools/drain-daemon/daemon.mjs", "we:tools/drain-daemon/lib.mjs", "we:tools/drain-daemon/__tests__/daemon.test.mjs", "we:tools/drain-daemon/__tests__/lib.test.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Prevention — Treat closure.complete === false like an unreadable closure (return null, so it is logged as blind). Add… (from plateauapp/plateau-app#222 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:tools/drain-daemon/daemon.mjs:405` — Treat `closure.complete === false` like an unreadable closure (return null, so it is logged as blind). Add a test for that branch.
2. `we:tools/drain-daemon/lib.mjs:1596` — Add a WE-side test or lint asserting that the deps-job spawn site builds its argv from `DEPS_JOB_NPM_ARGS`, and that the argv includes `--ignore-scripts`. Optionally also set `npm_config_ignore_scripts=true` in the job's env. File this as a backlog item.
3. `we:tools/drain-daemon/daemon.mjs:345` — A test asserting that `we:pr-event-feed.mjs` does not use `importWe`, or a linter enforcing loader segregation for non-rebuild code.
4. `we:tools/drain-daemon/lib.mjs:1630` — A regex assertion in the `the daemon wires it` test checking for the expected log lines, ensuring the shell fulfills its logging responsibilities.

Idempotency key (do not edit): approval-prevention-key:plateauapp/plateau-app#222@807db10303c699a1a8c188c949a8a280749183e5

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
