---
bornAs: x9k3m7q
kind: task
status: resolved
scope: ["we:scripts/operations/__tests__/record-red-team-ruling.test.mjs"]
dateOpened: "2026-10-24"
dateResolved: "2026-10-24"
tags: [prevention]
---

# Parameterise card ruling release evidence by landing step

The advisory review of web-everything/web-everything#5873 requested an explicit release-or-hold assertion for every step accepted by cardLandingExists in we:scripts/operations/record-red-team-ruling-io.mjs. A batched receipt has no PR reference and intentionally keeps the break held until its card resolves on main; completion alone must never release it.

## Acceptance

- [A1] Exercise held, batched, done with a card path, mentioned with a mention count, and done with a mention count through the real receipt writer and ruling sink in we:scripts/operations/__tests__/record-red-team-ruling.test.mjs.
- [A2] Assert release or continued hold with present, missing, withdrawn-during-reason, and spooled evidence. Spool-only evidence releases only held receipts; mention-only evidence requires operator recovery with a readable card reference.
- [A3] A batched receipt with missing backing evidence holds on repeated retries, then releases after the card becomes readable on main, with exactly one landing invocation and the original durable completion unchanged.

## Delivery

Implemented in PR #5873's parameterised landing-step release tests. This tracks the delivered prevention rather than creating a second implementation task. Validation is pending the launcher's gate: the local test command was deferred before test execution because the sandbox denies the admission wrapper's sysctl probe. No passing test result is claimed here.

## Non-goals

- [N1] Change cross-root coordination. The operator ruled that finding not-real, and the PR already records its accepted follow-up.
- [N2] Release batched cards before published evidence is readable, or trust a completion receipt without revalidation.
