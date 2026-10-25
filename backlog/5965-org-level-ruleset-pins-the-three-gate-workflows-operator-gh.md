---
bornAs: xtu0yr2
kind: story
size: 3
status: open
scope: ["we:scripts/rulesets/main-required-checks.merge-queue.json", "we:docs/agent/merge-queue-switch.md"]
dateOpened: "2026-10-12"
tags: []
---

# Org-level ruleset pins the three gate workflows (operator gh admin:org)

Operator action: pin the three gate workflows at the organization level for web-everything/web-everything and record the applied ruleset ID and readback in the runbook. The checked-in payload is still repository-shaped; it is not evidence that an organization rule is active. Keep the queue switch separate. #5918 covers live trigger/concurrency proof after a pin exists, not a prerequisite for creating the pin.

## Acceptance

- [A1] After the operator specifies the bypass policy below and applies the rule, `gh api --paginate orgs/web-everything/rulesets --jq '.[] | [.id,.name,.enforcement] | @tsv'` locates the active organization rule. Fetch its detail with `gh api orgs/web-everything/rulesets/"$RULESET_ID"` and assert active enforcement, main targeting, only the intended repository selector, the approved bypass list, and exactly the three workflow pins from we:scripts/rulesets/main-required-checks.merge-queue.json:59 at refs/heads/main. An absent or mismatched rule fails acceptance; never count a successful PUT alone. No local unit test can prove hosted enforcement.
- [A2] `gh api --paginate repos/web-everything/web-everything/rules/branches/main --jq '.[] | select(.type=="workflows")'` must expose the inherited rule. Record the readback, rule ID, source repository ID and operator identity in we:docs/agent/merge-queue-switch.md; redact tokens. Obtain a test PR's pinned run URLs with `gh run list --repo web-everything/web-everything --branch "$PROBE_BRANCH" --json databaseId,workflowName,headSha,url,event` and verify each pin has a run from the configured source. Missing or cancelled runs are not proof. #5918 owns the full label/body rerun and concurrency matrix.
- [A3] Run `q=we:scripts/readiness/heavy-admission.mjs; t=we:scripts/lib/__tests__/drain-merge-strategy.test.mjs; node "${q#we:}" run -- npx vitest run "${t#we:}"` (test: we:scripts/lib/__tests__/drain-merge-strategy.test.mjs), preserving repository queue/required-check payload regression coverage. This is a local guard only; [A1]–[A2] are the before/after hosted acceptance evidence.

## Non-goals

- [N1] No workflow implementation changes, queue-strategy switch, replacement of required status checks, or bot privilege expansion. Do not settle #5918's trigger/concurrency behavior here. No new receive endpoint is added: GitHub owns API payload limits, rate limits and authentication; browser CSRF/reset-trigger controls are inapplicable to the operator CLI action.

## Edge cases this change must handle

1. **Untrusted text** — Pins name workflows from the trusted main ref and verified source repository ID; PR-edited YAML must not substitute for that source.
2. **Truncated reads** — Paginate rule listings and fetch the selected rule detail; incomplete readback or API failure cannot establish installation.
3. **Shared state files** — Capture the existing organization rule before an update; do not replace unrelated rules or overwrite the repository queue configuration.
4. **Fail closed** — A 403/422, absent inherited rule, missing pin or cancelled pinned run leaves the installation unproven; do not proceed to the queue switch.
5. **Identity scoping** — Restrict the rule to web-everything/web-everything and main; verify repository ID 1142650361 instead of applying organization-wide by default.
6. **State over time** — Re-read after writes, reuse the recorded rule ID on retry, and check for an existing matching rule before creating a duplicate. Main is a moving ref, not an immutable commit pin.
7. **Who wrote it** — The operator's authenticated organization-admin identity applies the rule; an App token or agent must not infer the authority or choose bypass actors.

## Grounding

- we:scripts/rulesets/main-required-checks.merge-queue.json:55 contains the workflow rule; lines 61, 66 and 71 name we:.github/workflows/ci.yml, we:.github/workflows/merge-gate.yml and we:.github/workflows/soak-replay-gate.yml. Line 79 contains a repository-role bypass, not a chosen organization policy.
- we:docs/agent/merge-queue-switch.md:185 requires readback and treats a rejected repository workflow rule as a failed switch; line 189 calls organization pinning a separate change.
- we:backlog/5918-ruleset-pinned-workflows-prove-re-run-triggers-and-concurren.md:5 is open; its acceptance covers rerun/concurrency proof and organization fallback. That follow-on verification does not block creation of the pin.

## Open questions

Which organization-level bypass actors/modes should the operator authorize, and is there an existing organization rule ID to update? This blocks a concrete, non-expansive application payload; the repository-role bypass cannot be silently promoted to an organization policy. Live organization state and admin access were not queried during this card-only preparation.
