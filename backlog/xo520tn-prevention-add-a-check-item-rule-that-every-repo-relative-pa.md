---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/8617-reinforce-transient-fetch-retry-soak-break-networkbackoffms.md", "we:backlog/8618-lane-pool-branch-eight-hostile-holder-and-race-hardening-ite.md", "we:backlog/8620-ruling-cli-direct-entry-guard-fail-closed-on-realpath-errors.md", "we:backlog/8616-shared-awaiting-review-hardening-from-fast-mode-residual-ris.md", "we:backlog/8614-net-diff-pipeline-and-merge-gate-close-residual-pre-existing.md", "we:backlog/xq69k27-author-stamp-restore-real-markdown-parser-for-snapshot-html.md", "we:backlog/8615-needs-you-feed-harden-degraded-card-settlement.md"]
dateOpened: "2026-11-20"
tags: []
---

# Prevention — Add a check:item rule that every repo-relative path inside an Acceptance Executable command resol… (from web-everything/web-everything#7249 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:backlog/8617-reinforce-transient-fetch-retry-soak-break-networkbackoffms.md:29` — Add a check:item rule that every repo-relative path inside an Acceptance Executable command resolves to an existing file, or to a file the card says it creates.
2. `we:backlog/8618-lane-pool-branch-eight-hostile-holder-and-race-hardening-ite.md:10` — Add a check:item rule that a card citing a branch or PR as the code's location must declare blockedBy or deferredBlockedBy, and that any named test path exists.
3. `we:backlog/8620-ruling-cli-direct-entry-guard-fail-closed-on-realpath-errors.md:11` — Add a pre-land check:item that resolves each cited path against main and flags 'not yet on main' claims. Also require a scope list and concrete test paths.
4. `we:backlog/8616-shared-awaiting-review-hardening-from-fast-mode-residual-ris.md:16` — Make check:item require an Executable A1 to name at least one existing test path and a non-empty scope for task cards.
5. `we:backlog/8614-net-diff-pipeline-and-merge-gate-close-residual-pre-existing.md:36` — Require cards with an enumerated item list to carry an item-to-test-file table, or one A1 per touched module, so check:item can verify coverage per scope entry.
6. `we:backlog/8617-reinforce-transient-fetch-retry-soak-break-networkbackoffms.md:23` — Add a check:item rule that resolves every we:-prefixed or .test.mjs path in an A1 command and fails if the file does not exist.
7. `we:backlog/8620-ruling-cli-direct-entry-guard-fail-closed-on-realpath-errors.md:8` — Add a check:item rule requiring concrete repo paths in A1 and in scope. Reject 'on the X branch' phrasing in Acceptance.
8. `we:backlog/8614-net-diff-pipeline-and-merge-gate-close-residual-pre-existing.md:33` — A check:item rule: when a card enumerates N numbered items, A1 must contain N named test cases or a per-item test-file mapping. Every scope module needs a test path in A1.
9. `we:backlog/xq69k27-author-stamp-restore-real-markdown-parser-for-snapshot-html.md:22` — A check:item rule that every non-n/a edge-case line has a matching named case in A1 (or in a Test plan).
10. `we:backlog/8615-needs-you-feed-harden-degraded-card-settlement.md:29` — Same check:item rule: each non-n/a edge-case line must map to a named A1 case.
11. `we:backlog/8616-shared-awaiting-review-hardening-from-fast-mode-residual-ris.md:19` — Same check:item rule: A1 must contain concrete paths. Cards should have scope.
12. `we:backlog/8618-lane-pool-branch-eight-hostile-holder-and-race-hardening-ite.md:30` — Same check:item rule: A1 must name an existing or to-be-created test file.
13. `we:backlog/8617-reinforce-transient-fetch-retry-soak-break-networkbackoffms.md:32` — Require separate planned cases for explicit, omitted, and invalid options, plus an observable total-backoff assertion tied to lock expiry.
14. `we:backlog/8618-lane-pool-branch-eight-hostile-holder-and-race-hardening-ite.md:27` — Validate explicit test-file targets and require every behavioral edge case to identify a planned case and assertion.
15. `we:backlog/8620-ruling-cli-direct-entry-guard-fail-closed-on-realpath-errors.md:18` — Require explicit scope and test paths, and a named oversized-error case asserting a specified output limit.
16. `we:backlog/xq69k27-author-stamp-restore-real-markdown-parser-for-snapshot-html.md:16` — Require each behavioral requirement to reference a named planned test with an observable result, including refusal cases and repeated-operation invariants.
17. `we:backlog/8615-needs-you-feed-harden-degraded-card-settlement.md:37` — Require structured requirement-to-test references for behavioral edge cases in the card checker.
18. `we:backlog/8617-reinforce-transient-fetch-retry-soak-break-networkbackoffms.md:32` — Require temporal guarantees to map to named tests with explicit clock, elapsed-time, or scheduling assertions through a structured card test-plan gate.
19. `we:backlog/8618-lane-pool-branch-eight-hostile-holder-and-race-hardening-ite.md:25` — Validate complete A1 commands and require every behavioral edge-case requirement to identify a test file, case, and observable assertion.
20. `we:backlog/8616-shared-awaiting-review-hardening-from-fast-mode-residual-ris.md:20` — Gate task cards on nonempty file-level scope, a complete executable A1 command, and requirement-to-test references.
21. `we:backlog/8620-ruling-cli-direct-entry-guard-fail-closed-on-realpath-errors.md:18` — Gate cards on nonempty scope, concrete test command paths, and named assertion mappings for behavioral requirements.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 13 → #5473, finding 14 → #5668, finding 15 → #5668, finding 20 → #5615, finding 24 → #5360.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7249@5a49ac3c2016a1dc977d40f2eec74a719c6230eb

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
