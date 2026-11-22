---
kind: story
size: 2
status: open
scope: ["we:scripts/ci-minutes/usage.test.ts"]
dateOpened: "2026-11-22"
tags: []
---

# Red-team follow-ups [live-reproduced, coverage-or-style] from web-everything/web-everything#7342 (head d7f0f35ec)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7342 (reviewed head `d7f0f35ecaa742fe24175247fa4b3a5a85a5826a`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/ci-minutes/usage.test.ts:28` — (failing-input, degraded) The fixture pins incorrect casing and masks a zero-minute result for documented API responses.
   - Scenario: Pass the [documented usage-summary response] (https://docs.github.com/en/rest/billing/usage#get-billing-usage-summary-for-an-organization), containing product="Actions", unitType="minutes", discountQuantity=0 and netQuantity=1000, through the added minute-selection expression. It returns 0 instead of 1000 because it requires product="actions" and unitType="Minutes". Changing only those two fields in the synthetic fixture to documented casing likewise changes its result from 4600 to 0. Correct the fixture casing and make the calculation accept the documented values.
   - Class: live-reproduced (basis: Executed the expression extracted from the added test, removing TypeScript annotations, against both the synthetic fixture and documented response. Observed 4600 and 0 respectively. The demonstrated defect concerns this PR's pinned fixture and test calculation; no production API consumer is introduced.)
   - Also class: coverage-or-style
   - Claude's re-check: demonstrated break

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
