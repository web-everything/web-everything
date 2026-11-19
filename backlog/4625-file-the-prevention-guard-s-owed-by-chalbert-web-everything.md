---
bornAs: x3mwlhk
kind: story
size: 3
status: open

dateOpened: "2026-09-30"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#3125's independent review

Filed mechanically by the unattended review loop (#2749) — every finding below reduced chalbert/web-everything#3125's review (reviewed head `9a78a68162be23ef66f475ad6f3033b3f4df9baa`) to prevention-outstanding by naming a guard neither captured nor filed:

1. `we:docs/agent/plateau-progress-view.md:103` — Put `format: uri` plus a `pattern` restricting to https on known GitHub hosts in `we:contracts/plateau-progress-view.schema.json`. Add negative examples (hostile title, `javascript:` URL) to the examples file, so a schema/examples conformance gate rejects them. Add a rule to the story template that any story ingesting third-party text needs a hostile-input fixture.
2. `we:docs/agent/plateau-progress-view.md:132` — Add a schema/contract rule that collection validation is per-item with an error row, and add a fixture 'one invalid item among N valid' to the conformance examples so the relay contract test enforces it.
3. `we:backlog/4622-add-github-budget-and-overnight-evidence-to-plateau-health.md:29` — Add a deterministic publish-boundary scrubber and a canary test in `we:wip-relay-contract.test.ts`: any snapshot field matching absolute-path or token patterns fails the publish. File this as a standards rule requiring a canary fixture for any story that publishes host-state text.
4. `we:docs/agent/plateau-progress-view.md:140` — A standard LLM review or lint check that cross-references all operator additions and feature requests in a design document against the proposed data contract schemas to ensure completeness.

## Done when

1. **Executable** — `npx vitest run` on we:contracts/plateau-progress-view.test.ts fails before this item lands (the new hostile-URL and invalid-item cases are accepted by today's schema) and passes after.

## Progress

- **Premise check (2026-10-02, main `15f400ec`):** not delivered. `git log -S4625` finds only the card's own landing. In `we:contracts/plateau-progress-view.schema.json`, only the cached-PR page `url` (line 4558) has an https-github pattern. The other `url` fields (lines 557 and 1020, both inside the `action` definition; 557 is nullable via `anyOf [string, null]`) are bare `type: string, minLength: 1`. The third-party text (PR titles) rides `prRow.description`, plus `run.description` and `hold.description`, none of which has a `maxLength` or control-character bound; the `title` fields (819, 974, 1082) are operator-authored section/item titles. No hostile-input example and no per-item-error fixture exist in `we:contracts/plateau-progress-view.examples.json`.
- **Scope drift corrected:** old scope named the design doc and card #4622; the guards land in the contract triple (schema, examples, test) plus the doc. The doc line numbers cited by the findings (103/132/140) have moved; the contract has landed since (see `we:docs/agent/plateau-progress-view.md` "Canonical artifacts"). Finding 3's scrubber/canary belongs to the Plateau publisher repo (`plateau-app:src/wip/wip-relay-contract.test.ts` per #4622 scope), not this checkout, so it is a Follow-up here.

## Design

Findings 1 and 2 are contract-level and live in this repo. Today `we:contracts/plateau-progress-view.test.ts` compiles the schema with Ajv (line 7) and runs every example through it (line 10), so a schema rule plus a negative example is enforced by the existing test with no new harness.

1. **Link and text hardening.** Add a shared `githubUrl` definition (`type: string`, `pattern: ^https://(github\.com|api\.github\.com)/...`; the pattern alone enforces it, since `format: uri` is a no-op under the test's `strict: false` Ajv without ajv-formats). Use it in the `action` definition keeping the null branch at line 557 (`anyOf [{$ref githubUrl}, {type: null}]`, so `url: null` stays valid) and as the branch at line 1020. The PR page `url` at 4558 keeps its stricter pattern. Add `maxLength` and a no-control-character `pattern` to `prRow.description`, `run.description` and `hold.description`. Negative cases live in the test file (a negative-only entry in the examples file would break the `it.each` at test line 10; this deliberately deviates from the card's wording and is noted in the doc).
2. **Per-item PR-row validity (PR collection only).** In `pullRequests`, make each item `oneOf [prRow, errorRow]`, discriminated by a required `error` key on `errorRow` and `not: {required: [error]}` on `prRow`, so a malformed row cannot silently pass as an error row. `errorRow` is `{ error: { code, reason }, rawId? }` with `additionalProperties: false` and no free-form display text. Runs, holds, actions and items are out of the MVP (see Follow-ups). The schema cannot express `included === rows.length` (the root description says cross-field arithmetic is test-only), so the new `one-invalid-item-among-n` example is accompanied by a test asserting an error row counts toward `included` and `total` like any row, and the PR-conformance helper near test line 319 still holds. The doc gets one short paragraph stating the error-row rule.

Both changes are additive to schema 2. Ordering in the build: tests first (RED), then schema, then the new example, so the existing `accepts %s` stays green throughout.

## MVP

Musts only: (1) `githubUrl` on the `action` urls, description bounds on prRow/run/hold, and hostile negative cases in `we:contracts/plateau-progress-view.test.ts`; (2) the `oneOf` error-row shape on `pullRequests` plus the `one-invalid-item-among-n` example and its tests; (3) one doc paragraph in `we:docs/agent/plateau-progress-view.md`. Finding 2 is delivered here only for PR rows (deliberate partial; Done-when claims only the hostile-URL/description and PR error-row cases). Out of scope: everything in Follow-ups.

## Test plan

- `rejects javascript: action url` and `rejects non-github host action url` — set an `action` url (confirm an example action with a url exists; add one to the in-test clone if not) to `javascript:alert(1)` / `https://evil.example/x`; assert `validate()` false. RED today: `minLength: 1` accepts both. The PR page `url` (4558) is NOT used here since it is already guarded and would be green today.
- `accepts null action url` — positive control that the null branch at 557 still validates (GREEN before and after).
- `rejects oversize and control-character description` — 10k-char and `\u0000` on `prRow`, `run` and `hold` `description`, one case each; RED today (no bound).
- `accepts one invalid item among N valid` — the new example in `we:contracts/plateau-progress-view.examples.json`, added in the same step as the schema change; RED before (shape unknown, `prRow` has `additionalProperties: false`).
- `accepts a clean error row` (positive control, GREEN after) and `rejects an error row carrying extra display text` — only meaningful after the positive control passes, to avoid a false RED.
- `rejects a malformed prRow that omits required fields` — must NOT pass as an error row (the `oneOf` discriminator); GREEN today, kept as a regression guard.
- Existing `accepts %s` over all examples stays green throughout.

## Proof plan

Step 1: add only the new tests, run `npx vitest run we:contracts/plateau-progress-view.test.ts`, and record the failing names (the two action-url rejections, the description-bound cases, `accepts one invalid item among N valid`, the error-row cases) with their Ajv failure lines. Step 2: apply the schema, example and doc change; the same command is all green. Paste both outputs in the PR body. Show the examples file only gained an entry with `git diff -U0 we:contracts/plateau-progress-view.examples.json` (additions only).

## Follow-ups

Each is a future backlog item, filed by the eventual builder:

- Finding 3: deterministic publish-boundary scrubber (absolute-path/token patterns) with a canary test in `plateau-app:src/wip/wip-relay-contract.test.ts`, plus a standards rule requiring a canary fixture for any story that publishes host-state text.
- Finding 1 tail: story-template rule that any story ingesting third-party text needs a hostile-input fixture.
- Finding 4: review/lint check cross-referencing operator additions in a design doc against the contract schemas (needs its own design; the goal is an LLM-review check, not a deterministic rule).
- Relay-side enforcement of per-item validation in `plateau-app:wip-relay.js`.
- Extend the error-row rule to runs, holds, actions and items (needs a discriminator because `run`/`hold` allow additional properties).

## Findings (standalone worker, 2026-11-19)

The build-dispatch daemon held #4625 with:

> worker-declined: Not prepared: #4625 — could-not-prepare. A contract decision remains: should malformed PRs become counted error rows, including when repo/number identity is unavailable, or preserve the last good collection? The proposed identity-free error row conflicts with PR identity and cached-membership requirements in 'we:contracts/plateau-progress-view.schema.json:4793' and ':4837'. Existing failure behavior retains the last good section ('we:docs/agent/plateau-progress-view.md:148'). Choosing between these changes consumer semantics. No files changed or stamps applied; no tests run.

`scope:` was cleared above so this card is picked up by the existing unshaped-item auto-prepare path;
a prepare pass re-scopes it against the finding.
