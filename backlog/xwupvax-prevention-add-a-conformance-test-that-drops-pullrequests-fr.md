---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:contracts/plateau-progress-view.schema.json", "we:contracts/plateau-progress-view.examples.json", "we:contracts/plateau-progress-view.test.ts"]
dateOpened: "2026-10-02"
tags: []
---

# Prevention — Add a conformance test that drops pullRequests from pr-complete-cross-repo and expects validate() to fa… (from chalbert/web-everything#3541 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:contracts/plateau-progress-view.schema.json:1619` — Add a conformance test that drops pullRequests from pr-complete-cross-repo and expects validate() to fail. More generally, a rule that every allOf if/then branch needs a test which fails only when that branch is removed.
2. `we:contracts/plateau-progress-view.examples.json:4139` — Add a conformance assertion that summary.openPullRequests.value equals coverage.collections.pullRequests.total when the collection is complete, or states a documented relationship otherwise. This would be a deterministic check in the existing test.
3. `we:contracts/plateau-progress-view.schema.json:3568` — Add a schema lint that detects newly duplicated substantial object schemas and requires shared local definitions for structurally identical copies.
4. `we:contracts/plateau-progress-view.examples.json` — Add deterministic fixture assertions linking openPullRequests value and completeness to the PR collection's declared counting semantics, with negative cases for conflicting counts and false completeness.
5. `we:contracts/plateau-progress-view.test.ts` — For every nullable fact wrapper, deterministically test value:null with reason:null as invalid and value:null with a nonempty reason as valid, regardless of its seed value.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3541@489ae3308923f12abe877e6996b2cb494a33b0bc

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
