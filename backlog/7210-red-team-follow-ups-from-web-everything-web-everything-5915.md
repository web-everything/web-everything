---
bornAs: x3bbgib
kind: story
size: 2
status: open
scope: ["we:scripts/codemap.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5915 (head 164c89e7a)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5915 (reviewed head `164c89e7afd6ddf0bc4448c6d6b50d36ce7cd918`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/codemap.mjs:172` — (edge-case, degraded) Importer changes never invalidate an unchanged module's cached summary.
   - Scenario: Generate we:scripts/subject.mjs with no importers, then add and track we:scripts/new-consumer.mjs containing 'import { subject } from 'we:./subject.mjs';' and rerun without modifying we:subject.mjs. The generator summarizes the new consumer but skips we:subject.mjs, whose summary permanently retains 'Importers: none'. Reproduced through the production entry point with filesystem and subprocess boundaries mocked in memory. Importer metadata should be refreshed when importing files change, independently of the target module's source hash.
   - Claude's re-check: demonstrated break
2. `we:scripts/codemap.mjs:155` — (edge-case, degraded) Different checkouts share one manifest and delete each other's summaries.
   - Scenario: Under the same home directory, generate a map for checkout A containing we:scripts/subject.mjs and we:scripts/onlyA.mjs. Run with --root pointing to checkout B, which contains an identical we:subject.mjs but lacks we:onlyA.mjs. B reports we:subject.mjs as skipped and we:onlyA.mjs as deleted, then removes A's onlyA summary and manifest entry even though that source still exists in A. Reproduced through the production entry point with all writes mocked in memory. Output and deletion bookkeeping should be scoped to the checkout, or the command should reject incompatible roots before modifying the shared map.
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
