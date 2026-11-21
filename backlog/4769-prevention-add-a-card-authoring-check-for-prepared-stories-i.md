---
bornAs: xawiuqz
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/review-core.mjs", "we:scripts/lib/__tests__/review-core.test.mjs"]
dateOpened: "2026-10-02"
preparedDate: "2026-11-21"
preparedAgainstSha: "a70ef56b5d94e34a4a4c82ce66df653bec323238"
tags: []
---

# Prevention — Add a card-authoring check for prepared stories in the responder family: any text that makes an operato… (from chalbert/web-everything#3481 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. Historical review target: `we:backlog/4922-health-responder-contain-review-loops-and-route-owed-advisor.md` at commit `3ec08c53214e4b409d79d1b508736e13551fa539` (absent from this checkout; the former line-30 citation is not a live location). Add a card-authoring check for prepared stories in the responder family: any text that makes an operator or human artifact the authority for an action must name the existing authenticated ceremony or record and carry a forged-artifact refusal case in the test plan. A review-lens checklist line is the cheapest durable form.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3481@3ec08c53214e4b409d79d1b508736e13551fa539

## Acceptance

Each proposed test below belongs in `we:scripts/lib/__tests__/review-core.test.mjs` and runs with the queued command in Proof plan. Each must fail with the new assertions against the current security brief (which is absent), then pass after implementation. These guarantees concern checklist content and delivery, not runtime authentication or model compliance.

- [A1] Executable — proposed test `security responder authority requires an existing validating owner` asserts a nonempty security brief scoped to prepared responder-family stories, requiring the existing authenticated ceremony/record, its repository-prefixed validating-owner citation, authorized origin and action/current-episode binding, and separating authorization from cause-fixed evidence.
- [A2] Executable — proposed test `security responder authority refuses incomplete evidence` asserts explicit missing, forged, stale, ambiguous and unverifiable authority cases, refusal of the proposed side effect, rejection of an agent-authored approval assertion alone, and the visible fallback: report a preparation gap without inventing a ceremony. Assert the checklist requires a named forged-input consumer test and refused side effect plus a valid-authority control.
- [A3] Executable — proposed test `security responder authority covers prose and code` asserts coverage of documentation, configuration, data, backlog text and source code, with no prose-only exemption; assert the unsafe approval example and the source-verification caveat on the safe example.
- [A4] Executable — proposed test `security panel delivers responder authority by default` asserts the complete nonempty security brief reaches `buildPanelMandate({ lens: 'security' })` without caller opt-in, including with a backlog-only changed-file list and on a repair round. Assert security-only delivery alongside existing claim-accuracy and empty-fallback checks. Removing the entry or its composition hook must fail this test. No seating, validator, persistence or disposition default changes are proposed.

## Progress

- Original premise/scope: the prevention was scoped only to the triggering responder card, with a line-30 citation. That would repair one example rather than install the requested durable authoring check.
- Corrected premise/scope: the historical card is absent from the working tree. The prior preparation recorded that its version at `3ec08c53214e4b409d79d1b508736e13551fa539` depended on an explicit operator resolution plus separately observed cause-fixed evidence; that historical reading was not repeated in this preparation. That history establishes the motivating authority claim, not a current authenticated implementation. Preserve the goal by adding a review checklist in the existing mandate owner and its matching tests; no responder runtime change is required.
- Current source evidence: `we:scripts/lib/review-core.mjs:1972` defines `LENS_HUNT_BRIEF`; only claim-accuracy currently has an entry. `we:scripts/lib/review-core.mjs:1138` injects the selected hunt brief into the mandate. `we:scripts/lib/__tests__/review-core.test.mjs:1845` already tests brief registration, fallback and mandate inclusion. These are the implementation and regression homes, replacing the nonexistent card in scope.
- This prevention is not already delivered by the historical responder-card correction: the current hunt-brief registry has no security entry requiring the paired authenticated-authority citation and forged-artifact refusal case. Existing runtime holds in `we:scripts/conveyor/health-responder-core.mjs` are read-only context, not a substitute for the requested authoring check.

- Re-preparation correction: the incoming card already scoped the durable checklist to two files, but its source citations were stale and its proof commands bypassed host admission. The current locations above preserve that scope and goal. `we:scripts/lib/review-core.mjs:1138` is the shared delivery hook; callers are `we:scripts/review-core-cli.mjs:248`, `we:scripts/converge-cli.mjs:282`, and `we:scripts/operations/review-pr.mjs:1592` and `we:scripts/operations/review-pr.mjs:1674`. They inherit the security text without a new option or caller edits. No persisted-state schema changes are needed for a generated mandate string.
- Size remains 3: estimate approximately 20–35 changed lines for the checklist at `we:scripts/lib/review-core.mjs:1972` and 60–90 lines for registration, semantic clauses and delivery assertions beside `we:scripts/lib/__tests__/review-core.test.mjs:1845` (two files, approximately 80–125 changed lines). This is a story; no task-only estimatedLoc is added. Preparation stamps are left to the runner.

## Design

Add a security-lens entry to `LENS_HUNT_BRIEF` in `we:scripts/lib/review-core.mjs`, using the existing `huntBriefForLens` and mandate composition path. The checklist self-scopes to prepared responder-family stories that make a human/operator artifact the authority for an action. It must require both:

1. A repository-prefixed citation to the existing ceremony or record and its validating owner, explaining how the consumer establishes authorized origin and binds it to the intended action and current episode/PR/head where applicable. An artifact's label, prose, marker or claimed actor is not evidence of authentication by itself. If no existing mechanism can be identified, flag the preparation gap rather than inventing an authorization route.
2. A concrete forged-artifact refusal case in the story's Test plan, naming the matching test file, forged input, consumer under test and refused side effect. Pair it with a valid-authority control so blanket refusal cannot masquerade as correct validation. Keep authorization distinct from evidence that the cause was fixed.

This is the review-lens checklist explicitly requested by the original prevention, not a new semantic linter or runtime authentication policy. Retain the existing review disposition and seating rules. The checklist explicitly requires refusal of the proposed side effect for missing, forged, stale, ambiguous or unverifiable authority and reporting the missing evidence as a preparation gap. A tool-free reviewer identifies the missing evidence and does not claim to have executed the refusal test.

## MVP

1. Add the bounded checklist to the security hunt brief in `we:scripts/lib/review-core.mjs`.
2. Extend `we:scripts/lib/__tests__/review-core.test.mjs` to cover security registration and propagation through `buildPanelMandate`, alongside the existing claim-accuracy checks.
3. Include compact unsafe/safe examples in the checklist: an agent-authored “operator approved” record alone is insufficient; a cited existing validating ceremony plus a named forged-record refusal case satisfies the authoring requirements, subject to source verification. Do not prescribe a new record format or pretend the historical resume ceremony already exists.

## Test plan

- Implement the four named A1–A4 tests in `we:scripts/lib/__tests__/review-core.test.mjs`; assert the security brief contains the applicability boundary, existing authenticated ceremony/record and validating-owner requirement, forged-artifact refusal case, valid-authority control and no-invented-authority instruction.
- Assert the generated security panel mandate actually contains the checklist; retain claim-accuracy inclusion and unknown-lens empty fallback coverage. `buildPanelMandate` consumes the hunt brief; `buildValidatorMandate` in `we:scripts/lib/review-core.mjs:1226` currently does not. Extending validator delivery is outside this bounded panel-checklist change.
- Check that the wording covers docs/config/data/backlog inputs and distinguishes a claimed operator approval from independently verified authority. These tests establish prompt delivery, not reliable semantic classification by a model or runtime authentication.
- During review, apply the checklist to two synthetic responder-card excerpts: one grants resume on an agent-written approval message and lacks a named negative test; the other cites an existing verified owner and supplies the refusal test and valid control. Record why the first is incomplete and what source evidence the second still requires. No production actions or real operator records are needed.

## Proof plan

Run the new assertions against the pre-change brief and capture their failure, then run the suite with the brief installed and capture its passing result. Use repository-prefixed path variables:

```bash
test_file='we:scripts/lib/__tests__/review-core.test.mjs'
admission='we:scripts/readiness/heavy-admission.mjs'
node "${admission#we:}" run -- npx vitest run "${test_file#we:}"
node "${admission#we:}" run -- npm run check:standards
```

If admission is busy, wait once using its supported wait option, then stop and report; do not poll. The builder runs these checks after implementation; preparation itself changes only this card.

Inspect a generated security mandate in the test output/assertions to verify the full requirement reaches the reviewer, not just an exported constant. Removing the security brief must break the new inclusion test. Record the synthetic excerpt review separately from automated results; neither is proof that a responder runtime refuses forged records. The runner owns preparation stamping and checks for this preparation-only change.

## Follow-ups

No prerequisite policy fork remains for this checklist-only change. Runtime authority mechanisms, repairs to other prepared cards and any future semantic authoring gate are separate work discovered by applying the checklist, not additional scope here. A missing real ceremony must remain a visible preparation gap rather than being filled with a newly invented policy. Record any observed checklist misses before proposing broader enforcement.
