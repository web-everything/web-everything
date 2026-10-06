---
bornAs: xfoyxjf
kind: story
size: 3
parent: "4075"
status: active
scope: ["we:backlog/2772-post-hoc-review-forensics-and-take-over-for-stalled-or-faile.md"]
dateOpened: "2026-10-02"
dateStarted: "2026-10-06"
preparedDate: "2026-10-03"
preparedAgainstSha: "9058b677f1ec7e7bc3d749168aa7771b6d6db585"
tags: []
---

# Prevention — Add an acceptance bullet and a named test: custody POSTs reject non-JSON content types, a mismatched Or… (from chalbert/web-everything#3521 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/2772-post-hoc-review-forensics-and-take-over-for-stalled-or-faile.md` — Add an acceptance bullet and a named test: custody POSTs reject non-JSON content types, a mismatched Origin and a non-loopback Host. Longer term, a lint or standards rule that every new vite.config middleware route with a mutating method must go through a shared origin-guard helper.
2. `we:backlog/2772-post-hoc-review-forensics-and-take-over-for-stalled-or-faile.md` — Add a design bullet and a test: untracked files are listed by name only, with no content. Gitignored and known secret paths are excluded or redacted from patch bodies. Add a lane-forensics test seeding a fake secret file and asserting it is absent from the DTO.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3521@f934b9ff297206063ca63daf6d945f92fcf448ca

## Progress

- **Implementation (2026-10-06):** sanity read confirmed #2772 still lacks the requested explicit guard/confidentiality requirements and named tests; the proposed WE collector/test files remain absent. Amended the target card's Design, MVP, Test plan, Proof plan and Follow-ups with independent custody header rejection and zero-mutation guarantees, filtering before forensic DTO serialization, both named implementation tests and positive controls. Preserved its existing scope/source-test pairings, custody round trip and per-repository delivery split. Reviewed the amendment against both approval debts; no runtime security proof is claimed.

- **Validation (2026-10-06):** `node we:scripts/check-backlog-item.mjs 2772` passed with no warnings; `node we:scripts/check-backlog-item.mjs 4816` passed with one warning about the unchanged test-plan case classifications in this card. A Python comparison against pre-edit snapshots passed changed-line trailing-whitespace/conflict-marker, EOF and unchanged-frontmatter checks for both edited cards. No git commands or standards gate were run, per the delivery brief; the wrapper owns the gate and commit. The named runtime tests remain planned and were not executed.

Preparation research at WE `9058b677f1ec7e7bc3d749168aa7771b6d6db585` and Plateau `7b9547db7bd6d45f87e15d19b6b50a05890d238d`; no implementation or runtime proof claimed.

- **Old premise/scope:** the mechanical approval note points only to we:backlog/2772-post-hoc-review-forensics-and-take-over-for-stalled-or-faile.md and could be read as hardening existing custody routes and a collector.
- **Corrected premise/scope:** this is a documentation prevention task: amend that card's acceptance, design and named tests before its proposed implementation. Keep the original single-card write scope. The card already specifies untracked filenames and generic content-type checks, but has no explicit Origin/Host acceptance, secret-path exclusion contract or named secret-fixture test. Its proposed we:scripts/readiness/lane-forensics.mjs and we:scripts/readiness/__tests__/lane-forensics.test.mjs do not exist in this checkout. Proposed plateau:src/backlog-view/post-hoc-api.ts and plateau:src/backlog-view/post-hoc-api.test.ts likewise do not exist in the inspected product checkout.
- **Source evidence:** plateau:vite.config.mts, `backlogApi` route dispatch at lines 727–733, has no forensics/custody route. Its existing build-stop and write branches at lines 764–790 check JSON content type; those checks do not establish the proposed custody Origin/Host contract. The target card's “Forensic detail and read contract,” “Operator custody and hand-back,” and “Test plan” sections are the current design homes, not evidence of delivered code. No delivering commit was established because the requested acceptance and named tests are absent from the target card.
- **Test scope:** no runtime source entry is in this item's scope, so no source/test pairing is missing. The implementing card already scopes the proposed collector and API tests named above. This item must retain those pairings and specify the cases below; it does not create those files or take over the implementation.

## Design

Amend we:backlog/2772-post-hoc-review-forensics-and-take-over-for-stalled-or-faile.md in place, preserving its custody round-trip goal and per-repository delivery split.

1. Add an explicit custody acceptance bullet: every custody POST rejects non-JSON content types, mismatched Origin and non-loopback Host before invoking a custody backend or changing runner/lease state. State that these are independent checks; JSON alone is not the complete guard. Carry this into the product API test plan, including a valid same-origin loopback JSON control to prove the guard does not simply reject every request.
2. Add a forensic design bullet: untracked files contribute filenames only, never file contents; gitignored and known secret paths are excluded or redacted from patch bodies across committed, staged and unstaged categories. Apply filtering before serialization, not just panel rendering. Do not claim general-purpose secret detection or expose secret contents in error/truncation metadata.
3. Name the two tests and their proposed files explicitly, as below. Keep the shared middleware guard/lint suggestion in Follow-ups; this card does not mandate a repository-wide middleware migration or invent a new standards rule.

## MVP

- The target card has explicit acceptance for all three custody request rejection classes and for zero mutation on rejection.
- Its design and acceptance require filename-only untracked evidence and absence of ignored/known-secret contents from the serialized forensic DTO.
- Its test plan names the request-guard and secret-fixture tests, their proposed repository-qualified files, negative assertions and positive controls.
- Existing custody, preservation, stale-lease and same-lane continuation requirements remain intact. No runtime files, standards definitions or other cards are changed by this documentation task.

## Test plan

Specify these implementation tests in the target card; they are planned, not runnable tests delivered by this item:

- **“custody POST rejects non-JSON, mismatched Origin and non-loopback Host without mutation”** in proposed plateau:src/backlog-view/post-hoc-api.test.ts. Exercise each invalid header independently with the other headers valid, for each custody action. Assert refusal and zero backend/stop/lease writes. Include a valid loopback, same-origin JSON request reaching the injected backend. Test real handler dispatch rather than a duplicate predicate in the test.
- **“lane forensics omits secret contents and lists untracked names only”** in proposed we:scripts/readiness/__tests__/lane-forensics.test.mjs. Seed an isolated git repository with unique fake-secret sentinel content in an ignored file, a known secret-path fixture, and an ordinary untracked file; cover secret-path changes in committed, staged and unstaged patch categories. Assert that the serialized DTO contains none of the sentinels, ordinary untracked evidence includes the filename only, and an ordinary tracked change still appears. Assert no repository mutation. Use fake values, never local credentials.

For this item, review the documentation diff against the two original approval debts and run the item validator plus whitespace validation. Runtime tests remain obligations of the target card's implementation; do not report a green documentation check as runtime security proof.

## Proof plan

1. Show the target-card diff placing the exact request guard acceptance in MVP, the confidentiality rule in Design/MVP, and both named tests in Test plan. Confirm each planned implementation file remains paired with its test in the target scope.
2. Run `node we:scripts/check-backlog-item.mjs 2772` from the WE checkout using the repository-relative executable path, then `git diff --check`. Run the required standards gate through the delivery runner. Record observed results without claiming the proposed tests ran.
3. Require the target implementation's proof to send the three invalid request classes to its real custody endpoint against a disposable backend/pool and record refusal plus unchanged ownership. Send the valid control separately.
4. Require its forensic proof to inspect the actual serialized response from a disposable secret-fixture repository, verify sentinel absence and ordinary patch/name presence, and compare repository state before/after. A screenshot with hidden secret text is insufficient.

## Follow-ups

- On implementation of the target card, materialize and execute the named tests in the matching WE and Plateau delivery slices. This prevention item completes when the explicit requirements and tests are documented, not when the entire custody feature ships.
- Longer term, consider a shared origin-guard helper and lint/standards enforcement for new mutating development middleware routes. Keep that separate from this bounded acceptance/test amendment; no global enforcement policy is selected here.
- Exact secret-path matching and missing-Origin handling must be made explicit and tested during the target API/collector implementation. This item records the already-requested rejection and confidentiality guarantees without claiming those additional policy details are settled.

## Done when

The target card contains both prevention requirements and both named tests with repository-qualified planned paths, passes its documentation checks, and retains its original delivery goal. This preparation edits only the present card; the target-card amendment is the subsequent implementation task.
