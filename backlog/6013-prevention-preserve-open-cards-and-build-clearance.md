---
bornAs: xr8p501
kind: story
size: 3
status: open
dateOpened: "2026-10-12"
scope: ["we:scripts/lib/build-queue.mjs", "we:scripts/lib/__tests__/build-queue.test.mjs", "we:scripts/operations/review-pr.mjs", "we:scripts/operations/__tests__/review-pr.test.mjs"]
tags: [prevention]
---

# Prevention — Preserve open backlog debt and pin build clearance (PR #5017 review)

Track the outstanding prevention requests and advisory suggestion from the 2026-10-12 review of web-everything/web-everything#5017. The repair restores the missing six-task prevention card and adds shipped-config and priority-log tests; these broader guards remain outstanding.

## Acceptance

- [A1] The net-diff review gate flags any deletion under `we:backlog/` that the PR description does not mention. Cover both hash and numbered filenames, including renames.
- [A2] A deterministic check requires a completion or migration record when deleting an open prevention card. A missing replacement, a replacement without the outstanding tasks, and an unrelated deletion must fail; a valid migration retaining every outstanding task must pass. A commit message claiming a duplicate is insufficient.
- [A3] Add a test in `we:scripts/lib/__tests__/build-queue.test.mjs` proving operator priority cannot bypass build clearance, including direct card ids, bornAs ids and inherited epic priority. Exercise the clearance-owning call path if clearance happens outside the sorter. Per review #5135, this advisory is filed rather than implemented in the priority PR.

## Non-goals

- Change queue ranking, readiness, clearance policy or the review verdict for PR #5017.

## Edge cases this change must handle

1. **Untrusted text** — Treat PR descriptions and card content as data; never execute them.
2. **Truncated reads** — Incomplete diffs or card reads cannot establish a valid migration.
3. **Shared state files** — Use a single immutable base/head pair for the check.
4. **Fail closed** — Missing completion or migration evidence refuses deletion of open prevention debt.
5. **Identity scoping** — Match the original card and replacement within the same repo; accept hash-to-number migration only with retained task evidence.
6. **State over time** — Preserve every unresolved task until explicitly completed or migrated.
7. **Who wrote it** — Read migration evidence from the reviewed tree and declared records.
