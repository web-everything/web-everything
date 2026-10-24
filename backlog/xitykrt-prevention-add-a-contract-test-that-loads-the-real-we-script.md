---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-clones.mjs", "we:scripts/lib/__tests__/daemon-clones.test.mjs", "we:scripts/lib/adoption-matrix-settings.mjs", "we:scripts/lib/__tests__/adoption-matrix-settings.test.mjs"]
dateOpened: "2026-10-24"
tags: []
---

# Prevention — Add a contract test that loads the real we:scripts/settings/prototype-load.json and checks that e… (from web-everything/web-everything#5866 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-clones.mjs:43` — Add a contract test that loads the real we:scripts/settings/prototype-load.json and checks that every daemon with a `clone` entry resolves to the settings path rather than the plist path. Ideally share one resolver with prototype-load-io.
2. `we:scripts/lib/__tests__/daemon-clones.test.mjs:62` — Add a check:standards rule or a test that runs `loadAdoptionMatrixSettingsFile()` with the default arguments. The PR's cache-keying concern could be met by declaring the file as a test input.
3. `we:scripts/lib/daemon-clones.mjs:28` — Pass a source-specific reason into `add`. A review lens is enough here; no gate is warranted.
4. `we:scripts/lib/daemon-clones.mjs:14` — Have 3b's call site pass onIncomplete, and add a test there that asserts incompleteness reaches the rendered matrix. Alternatively, make onIncomplete required, or return {clones, incomplete} so completeness cannot be ignored. This is a review lens; no existing deterministic gate covers it.
5. `we:scripts/lib/adoption-matrix-settings.mjs:13` — Reject keys outside an allow-list in the validator and add a test for it. For a general guard, require settings validators to be strict schemas.
6. `we:scripts/lib/__tests__/daemon-clones.test.mjs:62` — Add a test that runs loadAdoptionMatrixSettingsFile() against the real file. The JSON is in-repo, so this does not conflict with cache-key concerns if the file is declared as a test input.
7. `we:scripts/lib/__tests__/daemon-clones.test.mjs:80` — Add the named malformed-JSON regression test to the automated test gate, asserting both incomplete reporting and preservation of readable evidence.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5866@df68b1d5a9bfda2b14d10d1b884c66faf3bf52e1

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
