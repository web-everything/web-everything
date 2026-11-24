---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:.github/workflows/ci.yml", "we:scripts/ci/__tests__/fetch-main-history.test.mjs", "we:scripts/ci/fetch-main-history.sh"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Add a size-budget check in the save step that skips the upload when the pack exceeds a threshold.… (from web-everything/web-everything#7452 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:.github/workflows/ci.yml:170` — Add a size-budget check in the save step that skips the upload when the pack exceeds a threshold. Alternatively, skip the upload when the restored mirror's recorded tip is already within N commits of the new tip. Capture it as a backlog card to measure first, then add the guard.
2. `we:scripts/ci/__tests__/fetch-main-history.test.mjs:225` — Add a stubbed-git save test that fails `pack-objects` (and one that fails `rev-list`) and asserts the cache directory is absent. A gate that checks every 'fails closed' test name has a failure injected after the first command would catch this class.
3. `we:scripts/ci/fetch-main-history.sh:50` — Add a lint rule or helper that treats cache-derived values as untrusted. A simple fix is to require `$tip` to match `^[0-9a-f]{40,64}$` and to pass `--end-of-options` before it.
4. `we:scripts/ci/fetch-main-history.sh:22` — Add a deterministic regression test in we:scripts/ci/__tests__/fetch-main-history.test.mjs that removes a reachable tree while retaining the tip and asserts rejection, seeded-pack removal, and successful live-fetch fallback.
5. `we:scripts/ci/fetch-main-history.sh:24` — Add deterministic tests in we:scripts/ci/__tests__/fetch-main-history.test.mjs with a valid tip and independently failing rev-list and pack-objects commands; assert each command was reached, save returned nonzero, and no replacement cache was published.
6. `we:scripts/ci/fetch-main-history.sh:45` — Add a deterministic fault-injection test making metadata reading fail and asserting that the live fetch still executes successfully.
7. `we:scripts/ci/__tests__/fetch-main-history.test.mjs` — Add real-Git incomplete-graph fixtures and gate them in the unit suite; replacing traversal validation with a tip-existence check must make these tests fail.
8. `(no file cited)` — Define a planned check named 'warm main-history fetch improves across three CI runs' that records cache hits, cache size, baseline and warm fetch durations, and an explicit improvement criterion.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7452@166fc2bd05c2e78fac2b20d4d8591240624a3486

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
