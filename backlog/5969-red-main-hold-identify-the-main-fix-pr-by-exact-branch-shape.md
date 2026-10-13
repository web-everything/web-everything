---
bornAs: xxanl0v
kind: story
size: 1
status: open
scope: ["we:scripts/conveyor/main-ci-red-core.mjs", "we:scripts/conveyor/__tests__/main-ci-red-core.test.mjs", "we:scripts/conveyor/health-smells/__tests__/main-ci-red.test.mjs", "we:scripts/lib/__tests__/red-main-hold.test.mjs"]
dateOpened: "2026-10-12"
preparedDate: "2026-10-12"
preparedAgainstSha: "832e98ade1556aede9cbb9f1ed3c3cc2fb8d1864"
tags: []
---

# Red-main hold: identify the main-fix PR by exact branch shape, never by title words

Held finding 213 reports that on 2026-10-10 at 19:58Z the drain exempted #4814, #4813 and #4812, although only #4812 (`lane/main-fix-2cb94418d`) fixed the red. That historical observation has not been independently replayed during preparation. The current matcher still admits descriptive feature branches and title/body text. Restrict recognition to the exact owner branch for the current first-red SHA and record the matched rule in the published priority reason.

## Progress

- Original premise/scope: title-pattern and prefix matching in `we:scripts/conveyor/main-ci-red-core.mjs`, with changes also expected in `we:scripts/lib/red-main-hold.mjs` and tests only in `we:scripts/conveyor/__tests__/main-ci-red-core.test.mjs`.
- Corrected premise: `we:scripts/conveyor/main-ci-red-core.mjs:284` also accepts a seven-character SHA in a title, a fix/heal verb followed by that SHA in a body, and a configurable alternate branch regex. All are bypasses of exact incident identity; removing only the title regex is insufficient. The existing trusted-author and creation-window checks remain relevant.
- Corrected scope: the hold consumer already uses the published PR numbers without re-deriving identity (`we:scripts/lib/red-main-hold.mjs:73`), so no production edit there is needed. Add its existing test file for producer-to-consumer regression coverage. Add `we:scripts/conveyor/health-smells/__tests__/main-ci-red.test.mjs`, whose assertions at lines 241, 360 and 530 explicitly depend on the old recognition rules; the originally named core test file primarily tests the owner brief.
- Owner-record clarification: `we:scripts/conveyor/main-ci-red-io.mjs:271` publishes the matcher output, not an independent PR identity attestation. Its dispatch ledger stores session/handle information (`we:scripts/conveyor/main-ci-red-io.mjs:346`, `we:scripts/conveyor/main-ci-red-io.mjs:362`), not an authoritative PR mapping. Use the card's exact-branch route; do not feed a permissively derived priority record back as proof of ownership.
- Retain `size: 1`: expected touch set is roughly 40–60 changed lines in `we:scripts/conveyor/main-ci-red-core.mjs:269`, 60–90 in `we:scripts/conveyor/__tests__/main-ci-red-core.test.mjs`, 40–70 in `we:scripts/conveyor/health-smells/__tests__/main-ci-red.test.mjs:241`, and 25–40 in `we:scripts/lib/__tests__/red-main-hold.test.mjs:55`. One recognition invariant, existing publishing path, no new runtime subsystem. This is a story, so no `estimatedLoc` is added.

## Design

In `we:scripts/conveyor/main-ci-red-core.mjs`, make `findOwnerPrs` compare the complete branch string with the configured owner prefix plus the current first-red SHA's first nine hexadecimal characters (default `lane/main-fix-<sha9>`). Require a valid hexadecimal SHA with at least nine characters and a nonempty prefix; do not sanitize malformed input into an accepted identity. Do not accept extra suffixes, a different incident's SHA, shorter abbreviations, title words, title SHA mentions, body claims or the alternate branch regex.

Preserve existing open-state, trusted-author setting and creation-window behavior. Disabling the trusted-author check must not disable exact branch matching. Preserve the array result and ordering, singular owner wrapper, and downstream priority/combine interfaces. Update comments on the matching rules without removing legacy settings still used by other callers such as `we:scripts/pr-land.mjs:360`.

Return a stable match-rule field with each recognized PR (for example `exact-owner-branch`) and include that rule and the incident SHA9 in `planPriority`'s reason. The existing publisher in `we:scripts/conveyor/main-ci-red-io.mjs:281` records this diagnostic through `we:scripts/lib/main-red-priority.mjs:35`; no new log writer is needed. Keep support for caller-supplied priority inputs without match metadata, but do not falsely label those as exact matches.

## MVP

1. Replace all permissive recognition alternatives with complete branch equality and update the ownership documentation in `we:scripts/conveyor/main-ci-red-core.mjs`.
2. Carry the match rule into the published priority reason using the existing record shape and publisher.
3. Add matcher and hold-chain regressions, and revise legacy tests that currently endorse title-only or arbitrary alternate-branch recognition. Keep multi-PR priority/combine behavior tested with explicitly supplied owner inputs; do not silently remove those independent tests.

## Done when

- [A1] With a current SHA beginning `2cb94418d`, the regression returns only #4812 and holds #4813/#4814. Its assertions fail against the current permissive matcher and pass after implementation.
- [A2] Published priority diagnostics identify `exact-owner-branch` and the current SHA9; unrelated title/body content cannot change the recognized set.
- [A3] Existing trust, red-window, priority TTL, green-clear, repo scoping and merge-gate behavior retain coverage.

## Test plan

- In `we:scripts/conveyor/__tests__/main-ci-red-core.test.mjs`, add a synthetic incident regression using #4812 on `lane/main-fix-2cb94418d` and #4813/#4814 as descriptive/title-only lookalikes. Label reconstructed titles/branches as synthetic rather than historical captures. Cover prefix-only, extra suffix, wrong SHA9, missing/malformed SHA, seven/eight-character SHA, body fix claims, title SHA mentions and an alternate regex configured to match everything.
- Cover closed and pre-window PRs, absent/untrusted/trusted authors and the explicit trusted-author opt-out with otherwise identical exact branches. Assert priority match diagnostics and first-owner ordering.
- In `we:scripts/conveyor/health-smells/__tests__/main-ci-red.test.mjs`, update old positive recognition fixtures explicitly as synthetic exact-branch variants; retain original descriptive fixtures as negatives. Exercise the injected health tick's published priority and green-clear behavior, without dispatching live work. Preserve separate multi-owner planning tests through direct planner inputs.
- In `we:scripts/lib/__tests__/red-main-hold.test.mjs`, compose `findOwnerPrs` → `planPriority` → `redMainSignal` → `decideRedMainHold` for the three-PR fixture. Assert only #4812 is exempt, and that an empty match set holds every local PR while the published red signal is live. Preserve expiry and cross-repo coverage.
- Run each affected test file through the host heavy-run queue: invoke Node on `we:scripts/readiness/heavy-admission.mjs` with `run -- npx vitest run` followed by the corresponding test path (strip the documentation-only `we:` prefix when executing). Run `npm run check:standards` through that same queue. No bare test or gate invocations.

## Proof plan

Capture the new regression failing on the old matcher and passing on the implementation. Save the recognized PR numbers, priority reason, and hold decisions from the deterministic fixture. Verify the injected health tick publishes the exact-rule reason and clears priority after green. This proves the executable producer-to-consumer contract; it does not establish that the historical live incident was reproduced. Before claiming live repair, observe a real health tick and its published priority/hold output during a suitable red window; never manufacture a production outage or change coordination state for proof.

## Non-goals

- No new owner-registration protocol, arbitrary alternate-branch exemptions, dispatch-ledger migration, changes to combine policy, hold modes, TTLs or merge gates.
- No changes to the separate delivery fast-path recognizer in `we:scripts/pr-land.mjs:360`.

## Edge cases this change must handle

1. **Untrusted text** — title/body text cannot confer ownership; retain the existing author-trust guard.
2. **Truncated reads** — absent exact candidates grant no new exemption. Existing failed-read/TTL behavior remains unchanged; do not claim immediate revocation of a previously published record on a failed probe.
3. **Shared state files** — reuse the existing atomic priority writer; add diagnostic content only, no new writer or state-reset operation.
4. **Fail closed** — malformed incident identity or a nonmatching branch yields no owner PR. Source, docs, config and data PRs all obey the same identity rule; no file-type exception.
5. **Identity scoping** — exact current SHA9 plus existing trusted-author guard; the hold consumer retains local-repository scoping.
6. **State over time** — another incident's exact-shaped branch is rejected; existing expiry and green-clear mechanisms remain intact. A record published before deployment can remain until refreshed or expired.
7. **Who wrote it** — GitHub author metadata remains the trust input, never a title/body assertion. The existing explicit trust opt-out does not relax branch equality.
8. **Endpoint protections** — n/a: no receive/write endpoint is introduced; body-size, rate-limit and CSRF policy are outside this pure matcher change.

## Follow-ups

If operators need multiple differently named fix branches admitted in the same incident, pursue an explicit trusted owner-to-PR registration contract separately; the current dispatch ledger cannot supply it. Audit the separate fast-path matcher in `we:scripts/pr-land.mjs:360` independently. Neither extension is required for this exact-branch hold repair.
