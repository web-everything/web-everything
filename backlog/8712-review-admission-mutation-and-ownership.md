---
bornAs: x7fp747
kind: task
status: open
scope: ["we:scripts/lib/review-fast-pass.mjs", "we:scripts/operations/review-job.mjs", "we:scripts/operations/review-dispatch.mjs"]
dateOpened: "2026-11-25"
tags: [testing, prevention]
---

# Gate admission guards with mutations and require explicit dispatch ownership

Prevention owed by PR #7450: negative fixtures that omit an otherwise-admissible
dispatch row do not defend refusal predicates. Silent ownership defaults can hide
lost forwarding between daemon orchestration and the final spawn.

## Acceptance

- Run a bounded mutation gate on individual fail-closed clauses: PR identity/state,
  plan deferral/refusals, agent/pending completeness, saved timestamps, stack reference
  caps/failures and unreadable same-author ancestry bottoms. Each removed clause must
  fail a named test; report survivors and incomplete mutation execution as failures.
- Include late lease loss during stack/CI reads on both ordinary and fast paths,
  and check forwarding at each orchestration boundary.
- Remove permissive ownership defaults from effectful dispatcher APIs or enforce a
  standards rule requiring explicit ownership policy at every call site. Preserve
  deliberate manual/session callers with an explicit policy; do not infer ownership
  merely from missing arguments.
- Cover expired holders and successor leases, error refunds and cross-repo passes.
