---
bornAs: xxdr63i
kind: story
size: 3
status: open
scope: ["we:scripts/readiness/heavy-admission.mjs", "we:scripts/readiness/heavy-repair-priority.mjs", "we:scripts/readiness/heavy-queue-projection.mjs", "we:scripts/readiness/__tests__/heavy-admission.test.mjs", "we:scripts/readiness/__tests__/heavy-repair-priority.test.mjs", "we:scripts/readiness/__tests__/heavy-queue-projection.test.mjs"]
dateOpened: "2026-10-28"
tags: []
---

# Heavy admission P1 wiring: policy-cascade fixPatterns/unblockPatterns and per-row waiter class on the queue baseline (R203 part B)

Part A added the bounded P1 classifier and projection helper. Part B must resolve fixPatterns/unblockPatterns through the policy cascade, persist waiter classes, and order live admission P0>P1>ordinary waiters before enabling projection discounts. Part A now keeps discounts disabled unless the baseline producer explicitly supplies `p1OrderingEnabled: true`; missing or invalid waiter classes always remain counted. Reconcile with existing m2 admission work. Live proof remains owed: a fix refused at queue-cap while builds queue becomes admitted after wiring lands.

## Design

Resolve `heavyAdmission.priority.fixPatterns` / `unblockPatterns` via standard → platform → tool → environment, with source diagnostics and bounded validation. Write the effective P0/P1 class onto waiting markers and carry it onto baseline rows. Keep FIFO within a class. Only `resolveQueueBaseline` may emit `p1OrderingEnabled: true`, and only when the effective live scheduler enforces the same ordering; priority mode off must omit it or set false. Never derive this capability from caller identity, marker text or an environment flag. Preserve unknown baseline classes as counted demand even after wiring.

## MVP

Must ship policy resolution, class persistence, live ordering and the producer capability together, with paired producer-to-projection and live-slot tests. Holders and pending demand remain charged in every projection branch.

## Acceptance

- [A1] **Executable / Must** — The scoped command in Test plan passes. Add planned case `P1 producer and live ordering agree` in `we:scripts/readiness/__tests__/heavy-admission.test.mjs`: use real temp-pool P0/P1/P3 markers, assert P0 wins, P1 then wins ahead of older builds, same-class FIFO is preserved, and the producer enables discounts only in enforce mode. Its real `tryAdmit('fix')` / `tryAdmit('ci-heal')` ahead set must match `isOldestLiveWaiter`.
- [A2] **Executable / Must fail closed** — Add planned case `P1 policy cascade rejects malformed settings` in `we:scripts/readiness/__tests__/heavy-admission.test.mjs`: invalid/unreadable policy, missing/unknown marker classes, mode off and legacy markers never grant priority or erase queue demand; source diagnostics name the effective fallback. Keep existing case `retains unclassified P0 and earlier fix demand from the real baseline producer; projection agrees with live FIFO` in `we:scripts/readiness/__tests__/heavy-queue-projection.test.mjs` as the pre-wiring guard, migrating its producer-class assertions explicitly when wiring lands.
- [A3] **Executable / Must handle non-code inputs** — Add planned cases `P1 non-code inputs fail closed` and `P1 names and env cannot impersonate P0` in `we:scripts/readiness/__tests__/heavy-admission.test.mjs`: docs/config/data job contents, PR text and malformed identities cannot become trusted priority/capability inputs; valid self-asserted fix/unblock identities and the local unblock env may grant P1 only, never P0, bypass the cap, or discount another P1. Test missing, null, invalid, oversized and adversarial text.
- [A4] **Executable / Must preserve occupied slots** — Add planned case `P1 admission never preempts live holders` in `we:scripts/readiness/__tests__/heavy-admission.test.mjs`: occupy every eligible slot with live holders, queue P1, assert acquisition refuses and holder owner/meta stay intact; release one slot, assert the next eligible waiter takes only that slot. Keep existing case `never discounts a running lower-priority holder: its remaining work can still hold a fix` in `we:scripts/readiness/__tests__/heavy-queue-projection.test.mjs` and the legacy non-split cases for both fix and ci-heal.

## Risks

- Projection/live-order drift can admit work past the cap: A1 pairs the producer and scheduler; enabling the capability before that test passes is forbidden.
- Unknown classes can conceal P0 or prior fixes: A2 retains their demand and covers policy errors rather than silently granting a discount.
- Name/env priority is self-asserted, not authentication: A3 pins that local trust boundary and P0 isolation. No HTTP endpoint is introduced; body/rate/CSRF controls are inapplicable. Pattern count, length and execution-time bounds remain mandatory.
- P1 can starve builds under persistent repair demand; this item changes queue order only, with no preemption, slot expansion or cap bypass (A4).

## Test plan

Run the A1 command from the WE checkout:

```bash
npm run test:unit -- scripts/readiness/__tests__/heavy-admission.test.mjs scripts/readiness/__tests__/heavy-queue-projection.test.mjs scripts/readiness/__tests__/heavy-repair-priority.test.mjs
```

The named A1–A4 cases above are planned Part B tests, not claims of existing coverage. Exercise real marker files, real slot locks and `resolveQueueBaseline`, with an isolated temp root and injected local policy inputs; never depend on the host queue. Run the A1 command through admission and the diff-selected verify gate. Keep the existing split and non-split projection cases for fix/ci-heal; mutate each branch independently (restoring total backlog must turn its case red). For the live proof, record held/waiting classes, baseline capability, queue-cap verdict and eventual slot order at the same congested moment; if no congestion occurs, retain the proof as owed.

## Non-goals

- [N1] No P0 classifier expansion, running-holder eviction, additional slots, HTTP endpoint, general priority authentication or starvation policy.

## Edge cases this change must handle

1. **Untrusted text** — A3 treats newline, CR/U+2028, quotes, backticks, leading flags, path segments, invisible/NFKC text and concatenated fragments as data; no shell evaluation or promotion from PR/job content.
2. **Truncated reads** — A2 retains unknown demand and leaves discounts disabled on incomplete class/policy evidence; no truncated read may establish the capability.
3. **Shared state files** — A1/A4 use the existing lock/marker writers, concurrent waiters, repeated reads and a live holder; preserve FIFO ties and never overwrite another owner's slot.
4. **Fail closed** — A2 never discounts a missing, invalid or unreadable class; absent capability retains all demand. Preserve documented unrelated bypass modes rather than introducing a new one.
5. **Identity scoping** — A3 scopes identity/env to the local admitted process and decoded lease; PR title, comment, docs/config/data content cannot supply trusted env or claim P0.
6. **State over time** — A1 includes earlier fixes across successive baseline reads and mode changes; retries retain their queue position and counted backlog.
7. **Who wrote it** — A3 distinguishes local self-asserted P1 from P0 classification; marker contents alone cannot enable the producer capability.

## Prevention work recorded from PR #6053

- Ordering/projection: the A1 paired test is a prerequisite for enabling the Part A capability; the default-off and real-producer regressions remain required until then.
- Branch coverage: preserve paired split/non-split tests for both dispatch kinds and require a branch-specific revert probe in the Test plan; no production enablement without both paths.
- Card validation follow-up (outside this repair's code scope): add a `check:standards` gate rejecting placeholders in Acceptance/Edge cases and executable Acceptance entries missing a repo-qualified test, named case or observable assertion. Planned validator cases in `we:scripts/__tests__/check-standards-rules-backlog-integrity.test.mjs`: `rejects acceptance and edge-case placeholders` and `requires an executable acceptance test and assertion`; use valid/invalid card fixtures and assert a nonzero verdict for each invalid form. This entry records the owed gate; it does not claim the gate exists.
