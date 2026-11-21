---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs", "we:scripts/operations/operator-why.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7263 (head cb8f35f5d)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7263 (reviewed head `cb8f35f5dc834b5606a4429f8d62065fd5c09962`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/reconcile-core.mjs:1647` — (edge-case, degraded) An older readable advisory masks a newer unreadable advisory
   - Scenario: On review:human, post a valid advisory for head a repeated 40 times, then a newer trusted advisory retaining that Net basis footer but replacing '**Verdict:** accept' with '**Verdict unavailable**'. Mechanically move to head b repeated 40 times with green required CI and reruns enabled. The planner dispatches head-moved-advisory because latestAdvisory falls back to the older readable note. Without that older note, the identical newest note correctly produces advisory-unreadable. The newer unreadable advisory should prevent dispatch in both cases.
   - Class: live-reproduced (basis: Reproduced against the checked-out production reader, referral-hold enrichment, and planner using injected read-only inputs. No live GitHub mutation or concurrency assumption.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:scripts/operations/operator-why.mjs:47` — (failing-input, degraded) Why reports review ownership while CI healing owns the PR
   - Scenario: With review:human, a readable stale advisory, a mechanically moved head, advisory reruns enabled, startAfter=ci-green, and required check gate completed with failure, planReconcile emits only ci-heal. For the same PR, createWhyReader followed by explainWhy reports owner 'review daemon' and 'advisory re-run on bbbbbbbbb', despite observing the failed check. It should identify CI healing as the current owner and explain that the advisory awaits CI.
   - Class: live-reproduced (basis: Reproduced through the production why IO seam with injected PR, settings, and check readers; compared with the production planner. The why reader reported no evidence gaps.)
   - Also class: correctness-in-normal-use
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
