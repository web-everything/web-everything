---
kind: story
size: 3
status: open
scope: ["we:.github/workflows/merge-gate.yml", "we:scripts/merge-gate/"]
dateOpened: "2026-10-10"
tags: []
---

# merge-gate required check must come from our GitHub App, not any job named merge-gate

Operator ruling 2026-10-10 on PR #4708 security referrals (we:.github/workflows/merge-gate.yml:1 and :18): the required check's workflow YAML is read from the PR merge ref / merge-group commit, so a PR can edit we:.github/workflows/merge-gate.yml to exit 0 or add a job named merge-gate and turn it green; only the human hold on workflow edits defends it today. Fix: when the ruleset is flipped, bind the required merge-gate status check to our GitHub App (ruleset required_status_checks integration_id) and have the App post the check run from main-pinned code, so a workflow edit cannot satisfy it. Ruleset change is the operator's (App has no admin). Done when: a test PR whose workflow edit exits 0 leaves merge-gate pending/red; live ruleset shows the integration binding.

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
