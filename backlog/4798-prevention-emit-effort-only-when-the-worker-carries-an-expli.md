---
bornAs: xdr24g7
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/probation-launcher.mjs", "we:scripts/operations/dispatch-providers/build.mjs", "we:scripts/lib/dispatch-routing-policy.mjs", "we:scripts/operations/dispatch-lane-io.mjs", "we:scripts/lib/__tests__/probation-launcher.test.mjs", "we:scripts/operations/dispatch-providers/__tests__/build.test.mjs", "we:scripts/lib/__tests__/dispatch-routing-policy.test.mjs", "we:scripts/operations/__tests__/dispatch-lane-io.test.mjs"]
dateOpened: "2026-10-01"
preparedDate: "2026-11-20"
preparedAgainstSha: "c5048aa20e1c76289b25f51c126d31dad17346ea"
tags: []
---


# Prevention — Preserve explicit worker effort and guard delivery-provider selection

Prevent invented effort flags, unsupported delivery providers, misleading inherited-policy errors, and false effort telemetry in the probation and build dispatch boundaries. These are the four prevention guards owed by the approval of chalbert/web-everything#3311.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3311@4f38c1ff3b054458f911e1c085406d69d988abc3

## Progress

- Rechecked against checkout `c5048aa20e1c76289b25f51c126d31dad17346ea` on 2026-11-20. The original preparation said all four guards were absent, described three workers, treated two test files as new, and placed effort reporting at line 1790. Corrected premise: the launcher still injects `medium` at `we:scripts/lib/probation-launcher.mjs:59`; provider forwarding remains unchecked at `we:scripts/operations/dispatch-providers/build.mjs:128`; unsafe effort reporting is now at `we:scripts/operations/dispatch-lane-io.mjs:2014`. Policy validation already rejects inherited scalar effort through `we:scripts/lib/dispatch-routing-policy.mjs:38-42,79`; the missing work is targeted coverage and an actionable inherited-route diagnostic, not a newly prohibited policy shape.
- The registry now contains four workers, including `antigravity-argon`, at `we:scripts/lib/provider-routing.mjs:343-348`. The Claude registry model remains null. Argon model suffixes suppress effort in `we:scripts/gemini-direct-task.mjs:159-162`, as do the explicit unsupported models. Codex no longer uses the cited sonnet-tier default: `we:scripts/codex-direct-task.mjs:275-276` resolves model and effort through the task route.
- Original scope: four production files plus four test files. Corrected scope: the same eight paths; extend existing `we:scripts/operations/__tests__/dispatch-lane-io.test.mjs`, create only `we:scripts/operations/dispatch-providers/__tests__/build.test.mjs`. Keep size 3: approximately 10 launcher lines, 30 provider lines, 5 policy lines, 20 extraction/call-site lines, and 35/65/25/50 test lines respectively (about 240 changed lines). No `estimatedLoc` because this is a story.
- Caller audit: main build and lightweight revalidation use the shared builder at `we:scripts/operations/probation-build-run.mjs:510,838`; heal uses it at `we:scripts/operations/probation-heal-run.mjs:387`. Explicit routing efforts are preserved by `we:scripts/lib/provider-routing.mjs:368`. Existing explicit-low caller assertions in `we:scripts/operations/__tests__/repair-routing-dry-run.test.mjs:12,18` remain valid. The historical implicit-medium fixture at `we:scripts/lib/__tests__/probation-launcher.test.mjs:33-35` must explicitly request medium.
- Similar unchecked forwarding exists in `we:scripts/operations/dispatch-providers/fix.mjs:120-121` and `we:scripts/operations/dispatch-providers/ci-heal.mjs:95-96`; these are follow-ups, not an expansion of this build-adapter guard. No dependency change proposed. Preparation changes only this card; stamps and execution checks belong to the runner.

## Acceptance

Each named test below is to be authored in the stated file. Each numbered suite contains a regression that fails against the current implementation and passes after implementation; preservation rows must also pass and are not falsely claimed to be red today. Run through the host heavy queue as described in Proof plan.

- [A1] Executable — `we:scripts/lib/__tests__/probation-launcher.test.mjs`, test `registry workers preserve explicit effort without inventing a default`: table over every current registry entry, omitted/null/empty/whitespace effort and explicit low/medium/high. Absent effort emits no flag; nonblank string effort passes unchanged. Include the changed historical fixture, all shared-builder caller shapes (build, heal, lightweight review), null-model rejection, and unknown-launcher rejection. Chain the Gemini-launcher rows through `buildAgyDirectTaskArgv`, checking suffix/unsupported-model suppression and supported-model passthrough. Omitted-effort rows are red before the fix.
- [A2] Executable — `we:scripts/operations/dispatch-providers/__tests__/build.test.mjs`, test `build dispatch uses only implemented delivery providers and reports the actual executor`: supported policy routes win; `claude` maps to `claude-restricted`; unsupported/unknown routes consult the marker; unsupported/empty markers omit the flag and report `claude`. Assert captured argv and `reportExecutor` together. Unsupported-policy rows are red before the fix. Test a throwing marker reader propagates before spawn rather than guessing that unreadable evidence means no marker.
- [A3] Executable — `we:scripts/lib/__tests__/dispatch-routing-policy.test.mjs`, test `inherited scalar effort reports the required provider-keyed shape`: inherited string effort throws an error naming `inherit` and a provider-keyed effort object. That diagnostic assertion is red today. Companion rows preserve acceptance of valid provider-keyed objects and rejection of unknown provider keys and unknown effort values; never skip inherited-entry validation.
- [A4] Executable — `we:scripts/operations/__tests__/dispatch-lane-io.test.mjs`, test `dispatch reports only a present valued effort flag`: exercise exported extraction and the real reporting caller with injected process IO. Both flag forms return their value; absent, empty and valueless flags return undefined, including a following option instead of a value. No-flag argv with an executable first must never report that executable. The production callback regression is red today.

## Design

1. In `we:scripts/lib/probation-launcher.mjs`, conditionally append effort only for a string with nonempty trimmed content; retain its original value rather than normalize it. Unset/null/blank/non-string values omit the flag. Leave provider-specific vocabulary validation to the downstream launchers. Do not change timeout, attribution, model validation or gate arguments. The no-effort contract applies at this boundary: Codex still resolves its own task-route effort; agy receives no invented effort. For the null-model registry row, supply a concrete Claude model as routing does and separately assert the unmodified row rejects. The table must enumerate the registry dynamically so Argon and future rows cannot be forgotten; apply the second launcher only to agy rows, with a supported synthetic-model control for explicit passthrough.
2. In `we:scripts/operations/dispatch-providers/build.mjs`, resolve one delivery-provider name before both argv construction and executor reporting. Use the exported `DELIVERY_AGENT_PROVIDER_NAMES` from `we:scripts/operations/deliver-item-wrapper.mjs:1537`, not a second allowlist. Normalize the existing `claude` alias, accept only a supported name, otherwise lazily read and validate the delivery marker with the same rule. If neither names an implemented provider, omit `--provider`, selecting the existing `claude-restricted` default at `we:scripts/operations/deliver-item-wrapper.mjs:1540`. Pass that same resolved/omitted name to `wrapperExecutorFor` at `we:scripts/operations/detached-dispatch.mjs:158`. Unknown names cannot escape into detached argv; the reported executor makes the fallback visible. Read errors propagate before spawning. Do not silently reinterpret an unreadable marker as an absent marker.
3. In `we:scripts/lib/dispatch-routing-policy.mjs:79`, reject scalar string effort for an inherited entry with an explicit diagnostic requiring a provider-keyed object; continue to run the existing object validation for inherited entries. This improves the current `unknown effort ... for undefined` message without changing the accepted policy shape. Test a minimal cloned valid policy with one inherited operation to isolate these cases from live settings changes.
4. Add `extractEffortFlag` beside `extractModelFlag` in `we:scripts/operations/dispatch-lane-io.mjs:2687` and replace the unsafe expression at `we:scripts/operations/dispatch-lane-io.mjs:2014`. Handle equals and separate-token forms; return undefined for missing/blank values and for a separate value beginning with `--`. Preserve existing equals-form precedence when both syntaxes occur. The reporting callback receives undefined when no value exists; never substitute argv element zero. Exercise the caller as well as the helper so dead, unwired helpers cannot satisfy A4.

## MVP

Implement the four guards and their acceptance suites within the eight declared paths. Update the existing medium fixture by supplying explicit medium, preserving its exact-argv assertion. Reuse existing downstream effort behavior; no new provider implementation, worker-registry effort defaults, policy-routing redesign, or standards lint rule. Existing persisted routing policy remains subject to the same validation; no state migration is required because the accepted shape is unchanged.

## Test plan

- Extend `we:scripts/lib/__tests__/probation-launcher.test.mjs` with A1 and the agy chain table. Cover non-string input too. Existing downstream tests in `we:scripts/__tests__/gemini-direct-task.test.mjs:315-348` cover suffixes, exceptions, validation and resume; run them as regression coverage without changing that file.
- Create `we:scripts/operations/dispatch-providers/__tests__/build.test.mjs` for A2 using injected `spawnDetached`, marker reader, log-path and attempt-tag functions. Assert no real process or marker read for a supported policy route; capture the durable handle and argv. Table unsupported providers across `antigravity`, `agy-claude`, `agy-gemini` and an unknown name, supported/unsupported/absent markers, and missing policy route. Verify marker read failure prevents spawn.
- Extend `we:scripts/lib/__tests__/dispatch-routing-policy.test.mjs` for A3: inherited string, valid object, unknown provider key, invalid effort and absent effort. The diagnostic is the new behavior; object validation is preservation coverage. Mutation proof: bypassing inherited validation must fail the negative cases.
- Extend existing `we:scripts/operations/__tests__/dispatch-lane-io.test.mjs` for A4, including empty argv, executable-only argv, terminal `--effort`, empty equals, whitespace values, following `--model`, both valid syntaxes and both-syntax precedence. Inject the existing dispatch process seam to assert `reportEffort` receives the extracted result without launching an agent.
- Run unchanged explicit-low caller coverage in `we:scripts/operations/__tests__/repair-routing-dry-run.test.mjs`. Do not weaken assertions or add production defaults to keep old fixtures green.

## Proof plan

Use `node` with the host queue entrypoint `we:scripts/readiness/heavy-admission.mjs`, arguments `run -- npx vitest run`, followed by the selected test paths above with their repository prefixes removed only when passing filesystem arguments. This defines a runnable command while keeping all authored path references repository-qualified. Batch the four acceptance files; also run the two downstream/caller regression files named in Test plan. If admission is busy, wait once using the queue's own supported wait bound, then stop and report; no polling.

Before production edits, run the new tests and record the failing A1 missing-effort, A2 unsupported-provider, A3 inherited-diagnostic and A4 reporting assertions. After implementation, rerun the same tests and record green output. Preserve the negative cases that were already green; do not claim every row newly fails. For the policy preservation rows, temporarily bypass inherited validation, observe failure through the queue, and restore the production change before final verification. All spawns and external reads in these proofs are injected; no live agent launches are necessary.

The implementation runner should attach those before/after outputs and the captured argv/executor/reporting values to its review evidence. It also runs `npm run check:standards` through the heavy queue. This preparation makes no claim that future tests have already run or passed.

## Follow-ups

- Apply the supported-delivery-provider guard to the analogous fix and ci-heal adapters identified in Progress, with their own caller tests.
- Consider a standards rule against injected launcher effort defaults if registry table coverage proves insufficient.
- Implement agy delivery providers separately if required; that changes the delivery roster rather than this fallback contract.
