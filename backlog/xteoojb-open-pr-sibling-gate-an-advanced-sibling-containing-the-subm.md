---
kind: task
status: active
scaffoldedBy: "card-7526-sibling-advanced"
dateScaffolded: "2026-11-27"
scope: ["we:scripts/lib/pr-size-admission.mjs", "we:scripts/operations/__tests__/open-pr-sibling-base.test.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# open-pr sibling gate: an advanced sibling containing the submitted head skips the ownership check (PR #7526 follow-up)

Problem: `we:scripts/lib/pr-size-admission.mjs:143,148` exempts every lane strictly ahead of the head when merge-base == head (`carried.has(inherited) && (inherited !== head || tip === head)`). That treats the lane as our child without asking the creation record, so an advancing source sibling is admitted. Shape A: lane/sib authors S; lane/own is created at S and adds nothing, so head = S; sib advances to C; carried={S}, merge-base(S,C)=S=head with tip!=head hits `continue` and returns ok:true, S is admitted. Shape B: own adds O on top of S, sib later contains O (fast-forwarded or merged own, then advanced): shared=[O]=head, same skip, so sib's first-parent ownHistory (:166, which includes S and would refuse) never runs. No test covers either shape (:203 covers divergence, :191 pins the legitimate advanced child).

Scope:

- we:scripts/lib/pr-size-admission.mjs
- we:scripts/operations/__tests__/open-pr-sibling-base.test.mjs

Fix direction: for a strictly-ahead lane, decide the ownership direction from creation evidence: it is a child only if its creation record (`creation[1]`) descends from or equals the shared commit and its first-parent ownHistory excludes `carried`; otherwise it becomes a candidate. Keep the fetched-creation rule at :173 from false-refusing a child created from published `origin/lane/own`. The :131 / same-tip "new branch name" advisories are the same family; include them if they are still open.

Acceptance (red on 0978c72c, green after):
- 'refuses an unchanged fork after its sibling advances' (shape A).
- 'refuses inherited sibling work after the sibling advances beyond the submitted head' (shape B; advance both the local and the origin/ sibling refs, keep the original creation reflog).
- Both expect reason sibling-base naming lane/7357, with only a `--check` spawn.
- :191 'allows an advanced parent with an unmerged child...' stays green, plus a new green test for a child created from fetched `origin/lane/own`.
- Full verify green.

Severity: not a security finding. main has no checkSiblingBase today, so these shapes already pass; the PR closes the common shapes. Impact is a PR carrying sibling commit S through review and drain (visible in the diff), i.e. duplicate or out-of-order landing, not unreviewed code on main.

Evidence: PR #7526 review comment 2026-11-28T00:46:55Z (both findings CONFIRMED), chunk-1 reviewer's block rationale 00:41:35Z, Steward Opus judge ruling 2026-11-27 (handoff-state judge-7526r6 text in this card), earlier ruling handoff-state judge-7526-ruling-2026-11-27 file (the --verbatim finding at :189 is fixed and holds; the :143 carve-out comes from 3bad8c0, before it).

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/operations/__tests__/open-pr-sibling-base.test.mjs` is red on 0978c72c for the two new shape A/B tests and green after (see the Acceptance list above).

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
