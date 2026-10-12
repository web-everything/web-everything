---
bornAs: xjdnlk0
kind: story
size: 3
status: open
scope: ["we:.github/workflows/merge-gate.yml", "we:.github/workflows/soak-replay-gate.yml", "we:.github/workflows/ci.yml", "we:docs/agent/merge-queue-switch.md"]
dateOpened: "2026-10-11"
tags: []
---

# Ruleset-pinned workflows: prove re-run triggers and concurrency before the merge-queue switch

PR #4950 adds a ruleset 'workflows' rule pinning we:.github/workflows/ci.yml, we:.github/workflows/merge-gate.yml and we:.github/workflows/soak-replay-gate.yml to main (layer 4 in the merge-gate workflow header). Three open points the PR's fix round could not settle inside its scope: (1) GitHub ruleset workflows ignore 'types'/'branches' filters and run only on opened/synchronize/reopened (+ merge_group checks_requested), so a label or body edit never re-runs the pinned merge-gate / soak-replay-gate, and an enforce-mode hold may never clear; (2) the pinned run may share a cancel-in-progress concurrency group with the repo's own run (merge-gate-<PR>, soak-replay-gate-<PR>, ci-<ref>) and cancel it, failing the rule; (3) GitHub documents ruleset workflows as an org/enterprise feature, so the repository ruleset 24883772 may refuse it and the pin may need an org ruleset. Also fix the merge-gate workflow's layer-4 wording ('runs them from main rather than from the group commit'): the pin adds a separate run from main; the PR's edited run still happens. Prove each point on a live PR before the switch in we:docs/agent/merge-queue-switch.md.

## Acceptance

- [A1] **Executable** — a vitest over the three pinned workflow files fails while any of them shares a `cancel-in-progress` concurrency group between the ruleset-started run and the repo's own run, and passes after the groups are separated (or the cancel is shown not to apply, with the live run ids cited).
- [A2] **Live proof** — on a real test PR, with the pin applied: a label change and a body edit each lead to a fresh pinned `merge-gate` / `soak-replay-gate` result (or the runbook documents the push-to-re-run step the operator must take), with run URLs recorded in the card.
- [A3] **Live proof** — the PUT of the `workflows` rule to ruleset 24883772 is either accepted (readback shows it) or refused; if refused, the pin moves to an organization ruleset and `we:docs/agent/merge-queue-switch.md` says so.
- [A4] The layer-4 text in the merge-gate workflow header says the pin adds a separate run from main and the PR's own run still happens.

## Non-goals

- [N1] Does not apply the ruleset or flip the merge-delivery strategy; that stays the operator step in `we:docs/agent/merge-queue-switch.md`.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the PR's own edits to the workflow YAML are untrusted; the pinned run from main must decide, never the PR's run.
2. **Truncated reads** — n/a: no list or log is parsed by this change beyond fixed workflow files.
3. **Shared state files** — the concurrency groups are the shared state: two runs for one PR must not cancel each other.
4. **Fail closed** — a cancelled or missing pinned run must fail the required rule, never pass it.
5. **Identity scoping** — required checks stay restricted to the GitHub Actions app (integration 15368).
6. **State over time** — a label or body change after the last push must not leave a stale pinned verdict that blocks or clears the PR.
7. **Who wrote it** — only the operator's admin login applies the ruleset; the App token never does.
