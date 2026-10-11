---
bornAs: xemzfsg
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/__tests__/pr-ownership-io-real.test.mjs"]
dateOpened: "2026-09-28"
preparedDate: "2026-10-11"
preparedAgainstSha: "0726047008980bcce058960120cd5d03a6224e6c"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2842's independent review

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/__tests__/pr-ownership-io-real.test.mjs:59` — Add a deterministic missing-checkout test with an injected run spy and assert that it was never called, while retaining the real filesystem existence check.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2842@1a49f07cc1f0f46c1e97c111205d507230b6c3e2

## Progress

- Premise checked against the current checkout: the original review citation, `we:scripts/operations/__tests__/pr-ownership-io-real.test.mjs:59`, still points to the gap assertion. The missing-checkout case starts at `we:scripts/operations/__tests__/pr-ownership-io-real.test.mjs:51`; despite its title, it does not observe child-process attempts. The guard is still owed, not already delivered.
- Original scope: add a deterministic missing-checkout test with an injected run spy while retaining the real filesystem existence check. Corrected implementation scope: strengthen the existing missing-checkout case, rather than duplicate it. The production seam already exists at `we:scripts/operations/pr-ownership-io.mjs:105`, and checkout resolution is at `we:scripts/operations/pr-ownership-io.mjs:157`, and the existence gate is at `we:scripts/operations/pr-ownership-io.mjs:158`. No production change is needed.
- Scope remains the existing test file, `we:scripts/operations/__tests__/pr-ownership-io-real.test.mjs`, which is itself the matching test scope; the production reader is investigation evidence only. Size remains 3. No prerequisite change or unresolved policy choice was identified.

- Rechecked for this preparation: the old premise remains an unobserved no-child claim at `we:scripts/operations/__tests__/pr-ownership-io-real.test.mjs:51`, with only a gap assertion at line 59 of that same file. The corrected premise is specifically missing regression coverage, not a broken production gate: `we:scripts/operations/pr-ownership-io.mjs:158` skips the lane read when the checkout is absent, and `we:scripts/operations/pr-ownership-io.mjs:109` routes that read through the injectable runner. The prior gate citation pointed at checkout resolution (line 157); it is corrected above. Old and retained scope are the single existing test file; no source or matching-test path has moved. The injected ownership suite at `we:scripts/operations/__tests__/pr-ownership.test.mjs:75` forces existence true and does not supply this real-absence guard. Existing preparation stamps are left untouched for the runner. No tests or mutation proof were run during this preparation.

## Design

Strengthen the existing missing-checkout case in `we:scripts/operations/__tests__/pr-ownership-io-real.test.mjs:51`. Import `vi` from Vitest and inject a local `run = vi.fn(() => '{"lanes":[]}')` into `createPrOwnershipReader`. Bind `checkout = join(root, 'absent')` beneath the fixture's unique real repository root, use it as the reader's `root`, and assert `expect(existsSync(checkout)).toBe(false)` before invoking the reader. Do not inject `pathExists`: its production default must remain the real filesystem probe (`we:scripts/operations/pr-ownership-io.mjs:105`).

Call the reader once as `const out = read()`, preserve the missing-checkout gap assertion on `out.gaps`, assert `expect(out.repos[0]).toMatchObject({ repo: 'we', lanes: [] })`, and assert `expect(run).not.toHaveBeenCalled()`. A returning spy is deliberate: a thrown error could be swallowed by lane-read error handling, whereas the call assertion directly detects an attempted spawn. Preserve the real-child success and nonzero-exit cases at `we:scripts/operations/__tests__/pr-ownership-io-real.test.mjs:29` and `we:scripts/operations/__tests__/pr-ownership-io-real.test.mjs:43`.

Update the file-level description at `we:scripts/operations/__tests__/pr-ownership-io-real.test.mjs:3` to distinguish real child execution in the positive/error cases from the injected no-call witness in the missing-checkout case. The checkout existence probe remains real in all cases. The no-call witness covers the lane-enumeration runner, not every process in fixture setup: the real repository helper itself invokes git (`we:scripts/operations/__tests__/helpers/real-repo.mjs:90`). Phrase the case title/comment accordingly.

## MVP

1. Edit only `we:scripts/operations/__tests__/pr-ownership-io-real.test.mjs`: add the filesystem/spy imports, strengthen the existing missing-checkout test, and correct its descriptive comment.
2. Retain fixture cleanup, the existing reader doubles, and both real-child cases. Do not modify the reader, shared fixture helper, or ownership policy.
3. Deliver the no-call assertion together with the real absence and gap assertions; none alone proves the whole guard.

## Test plan

Run the focused suite through the host heavy-run queue. From the WE checkout, invoke `node` with `we:scripts/readiness/heavy-admission.mjs`, followed by `run -- npx vitest run` and `we:scripts/operations/__tests__/pr-ownership-io-real.test.mjs` (strip the `we:` locus prefixes when passing filesystem arguments).

Verify all three cases pass: real child success, real child nonzero exit converted to a gap, and real missing checkout reported with empty lanes and zero injected-run calls. The test must use the real `existsSync` default, not a stubbed false result. Run `npm run check:standards` through the same queue at implementation validation.

## Proof plan

The current reader already has the correct gate, so an ordinary baseline suite is expected to pass; that alone does not demonstrate the missing prevention coverage. During implementation, temporarily mutate the missing-checkout branch at `we:scripts/operations/pr-ownership-io.mjs:158` to attempt `readLanes(checkout)` inside a caught try/catch before retaining the existing gap message. Discard the return value of that extra call and leave `lanes` unchanged. This models an attempted child spawn whose failure is swallowed and preserves the old assertion's observable output; with the returning spy it still preserves the empty lanes, isolating the no-call assertion as the mutation detector.

Run the focused suite through the queue with the original test and this mutation: the missing-checkout case should remain green. With the strengthened test and the same mutation, it must fail specifically on the nonzero spy call count. Restore the production reader, rerun the suite, and retain the green result plus the targeted mutation failure as review evidence. No mutation belongs in the delivered diff. This preparation records the proof procedure; it does not claim those runs have occurred.

## Done when

1. The existing missing-checkout test proves real checkout absence, the expected gap, empty lanes, and zero `run` calls.
2. Both existing real-child cases still pass through the queued focused command described above.
3. The targeted mutation survives the old assertion and is rejected by the new no-call assertion; the production reader is restored and the focused suite passes.
4. The implementation diff contains only the scoped test file, and queued standards validation passes.

## Follow-ups

None required. The existing injection seam supports the requested prevention guard without a production API change, new dependency, or additional backlog edge.
