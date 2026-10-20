---
bornAs: x7utze6
kind: story
size: 3
status: active
scaffoldedBy: "fix-5485"
dateScaffolded: "2026-10-17"
scope: ["we:scripts/operations/codex-worker.mjs", "we:scripts/lib/probation-launcher.mjs", "we:scripts/conveyor/concurrent-baseline-comparison.mjs", "we:scripts/lib/__tests__/codex-caller-policy.test.mjs"]
scopeRationale: "we:scripts/codex-direct-task.mjs is named only as the CLI whose invocations the new test lists; the change is in its callers."
dateOpened: "2026-10-17"
tags: []
---

# Decide Codex self-review and gate per caller class

PR 5485 turned on the full gate and the capped self-review by default in codex-direct-task. Three callers inherit them without an explicit choice: codex-worker (gate standards; self-review notes never reach its PR body; a reviewer outage now fails the codex step), the probation launchers (gate none; extra Codex repair turns credited to the worker before their own checker), and concurrent-baseline-comparison (no gate, so the Codex side now runs the full unit tier and self-review while Gemini does not, which skews the comparison). Each caller should pass an explicit gate and --no-self-review or carry the notes, with a test that lists every caller and its explicit choice.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/codex-caller-policy.test.mjs` fails before this item lands (no such test) and passes after: it lists every `codexDirectTask` caller and `we:scripts/codex-direct-task.mjs` CLI invocation and asserts each passes an explicit gate and an explicit self-review choice.
- [A2] **Executable** — where a caller keeps self-review on, its remaining notes reach the PR or report it publishes (`renderSelfReviewNotes`), and a reviewer outage stops that caller with a named outcome, never a silent pass. Defended by two cases per such caller in the same `we:scripts/lib/__tests__/codex-caller-policy.test.mjs`: `<caller> publishes remaining self-review notes` (a stub reviewer returns one note; the caller's PR body or report contains it, rendered inert) and `<caller> names a reviewer outage` (a stub reviewer throws; the caller exits non-zero with `self-review unavailable` in its outcome and publishes nothing). A caller that turns self-review off has neither case and is listed by A1 instead.

## Non-goals

- [N1] This item does not change the defaults in `we:scripts/codex-direct-task.mjs` or the self-review loop itself; it only makes each caller's choice explicit and tested.
- [N2] It does not decide the self-review for Claude-executed deliveries (`deliver-item-wrapper`); that path already parks `review:pending` under the default.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — self-review notes are model text; every caller that publishes them goes through `renderSelfReviewNotes` (inert fenced block), never raw interpolation. A2's notes case asserts the rendered form.
2. **Truncated reads** — an oversized net diff is the explicit "Self-review incomplete" note, not a clear review; a caller that keeps self-review on publishes that note like any other (A2's notes case covers both).
3. **Shared state files** — n/a: the callers keep no shared state for this choice; the gate and self-review choice are call arguments.
4. **Fail closed** — a reviewer outage, an invalid verdict, or a red repair gate is a failed caller outcome naming the cause (A2's outage case); a checkout without `we:scripts/verify-lane.mjs` is the named `gate-unavailable` failure, so a caller pointing `--dir` at a sibling repo must pass `--gate=standards` or `--gate=none` explicitly (A1 asserts the explicit gate).
5. **Identity scoping** — n/a: no actor or session identity is read or written by this choice.
6. **State over time** — a caller started under the old default (gate none, no self-review) and resumed after this item keeps the choice in its arguments, so the result does not depend on when it started; A1 asserts the argument, not the default.
7. **Who wrote it** — n/a: the choice is made in code reviewed with this item, not read from any comment or label.

## Risks

- [R1] A caller left on the inherited default silently gains the full gate cost and self-review turns (comparison skew in `concurrent-baseline-comparison`). Mitigation: A1 fails on any caller without an explicit choice.
- [R2] A caller that keeps self-review on but drops its notes hides findings from the human reviewer. Mitigation: A2's notes case.
- [R3] A reviewer outage reads as a pass in a caller that swallows errors. Mitigation: A2's outage case.

## Test plan

- `we:scripts/lib/__tests__/codex-caller-policy.test.mjs` — A1: enumerate every `codexDirectTask` import and `we:scripts/codex-direct-task.mjs` CLI invocation under `we:scripts/` (grep, so a new caller fails the test until it is listed), and assert each passes `gate` and `selfReview`/`--no-self-review` explicitly. A2: the two named cases per self-review caller above, with a stubbed reviewer and spawn.
