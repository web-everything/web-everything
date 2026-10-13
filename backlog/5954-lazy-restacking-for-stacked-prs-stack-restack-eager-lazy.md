---
bornAs: xhhbmel
kind: story
size: 5
status: open
scope: ["we:scripts/conveyor/ci-red-recovery-watch.mjs", "we:scripts/conveyor/__tests__/ci-red-recovery-watch*.test.mjs", "we:scripts/conveyor/pr-stack.mjs", "we:scripts/conveyor/__tests__/pr-stack.test.mjs", "we:scripts/lib/stack-restack-policy.mjs", "we:scripts/lib/__tests__/stack-restack-policy.test.mjs", "we:scripts/settings/stack.json", "we:scripts/lib/__tests__/settings-files.test.mjs", "we:scripts/__tests__/pr-merge-gate.test.mjs"]
dateOpened: "2026-10-12"
preparedDate: "2026-10-13"
preparedAgainstSha: "f329d380e7808c09b33b36db7403ba3cbd961a65"
tags: []
---

# Lazy restacking for stacked PRs (stack.restack: eager | lazy)

Held finding 228 (2026-10-10, operator OK) reports that three of four commits on #4814 were base updates as #4799 changed, each restarting roughly twenty minutes of CI. Preserve the goal: a cascaded `stack.restack` setting, default `lazy`, avoids updating children on every parent-head change while review-on-stack-base continues. `eager` retains existing behavior. The drain's just-before-merge retarget remains the existing “next in line” boundary; it changes PR metadata, not the child's commit history.

## Progress

- Preparation inspection: the old scope named only we:scripts/conveyor/ci-red-recovery-watch.mjs and we:scripts/settings/stack.json, with size 2 and no test scope. The incident timings above are the original operator report, not newly reproduced measurements.
- Corrected premise: we:scripts/conveyor/ci-red-recovery-watch.mjs:925 implements whole-chain refresh, called for missing-run recovery at we:scripts/conveyor/ci-red-recovery-watch.mjs:1055; it is not a general parent-head watcher. The separate content-stack planner eagerly schedules moved-parent restacks at we:scripts/conveyor/pr-stack.mjs:299 and idle restacks at we:scripts/conveyor/pr-stack.mjs:244. Both paths must consume the setting or the churn remains.
- Corrected drain scope: we:scripts/merge-ai-prs.mjs:6431 invokes pre-delete retargeting; we:scripts/lib/pr-merge-gate.mjs:252 edits PR bases without refreshing child branches. Keep this safety path unchanged and cover it through existing we:scripts/__tests__/pr-merge-gate.test.mjs:383. No drain source edit is needed to make retargeting lazy: it already occurs immediately before the parent merge attempt.
- The setting is absent from we:scripts/settings/stack.json:1. The boolean `prStack.restack` in we:scripts/conveyor/pr-stack.mjs:25 is an existing enable switch, not the requested eager/lazy timing policy. The standard/platform/tool/env cascade is available in we:scripts/lib/policy-cascade.mjs:4; settings discovery is automatic in we:scripts/lib/settings-files.mjs:7. Add one shared resolver rather than duplicate policy in the consumers.
- Scope now includes both consumers, a planned shared resolver and its planned test, settings with its existing layout test, and the existing retarget regression test. Size changes **2 → 5**: estimate roughly 360 changed lines, comprising two consumer files × 35, one resolver × 45, settings × 1, recovery tests × 85, planner tests × 85, resolver tests × 55, settings tests × 4, retarget tests × 15. Evidence for the added work is the two independent scheduling paths and cascade cited above. This is a story, so no `estimatedLoc` is added.
- No claim, preparation stamp, status change, dependency edit, or production mutation is part of this preparation. Implementation and live proof remain outstanding.

## Design

1. Add we:scripts/lib/stack-restack-policy.mjs with an injectable resolver using `cascadePolicy('stack', …)` from we:scripts/lib/policy-cascade.mjs. Resolve only the `restack` leaf through standard `lazy`, platform preference, tool override from we:scripts/settings/stack.json, then proposed env `WE_STACK_RESTACK`. Accept only `eager` and `lazy`; invalid values fall through to the next valid layer, with cascade diagnostics. Keep `reviewWhileBaseOpen` unchanged. Document both values in the resolver's module contract and keep the committed tool file free of a redundant default override so platform preferences remain effective.
2. In we:scripts/conveyor/pr-stack.mjs, resolve the timing policy alongside existing settings and pass it to both `applyStackOrder` and `planIdleRestacks`. Keep `prStack.restack=false` as the existing disable switch. With timing `lazy`, an open bottom does not authorize a restack merely because its head moved. Skip the restack branch and continue the existing bottom-first/parallel-fix/hold-age logic; do not discard an owed fix or takeover. A positively detected landed bottom remains eligible for the ordinary bounded restack onto main. With `eager`, retain current scheduling. Do not infer landing from disappearance alone: retain the ancestry proof at we:scripts/conveyor/pr-stack.mjs:143.
3. In we:scripts/conveyor/ci-red-recovery-watch.mjs, consult the same policy before whole-chain recovery. Under `lazy`, a candidate still targeting a non-default base is deferred without fetch, refresh, push, retry comment, or label clearing. Use the existing structured deferred outcome, which the sweep already exempts from attempt accounting at we:scripts/conveyor/ci-red-recovery-watch.mjs:1062. Expose the deferral reason in the plan as well as apply results so dry-run does not promise an action it will suppress. Unknown/missing stack evidence must never become permission to write. Under `eager`, retain the current chain verification and recovery behavior. Default-branch recovery remains available after retargeting.
4. “Next in line” means the existing drain execution point after candidate revalidation, immediately before attempting to merge its parent, at we:scripts/merge-ai-prs.mjs:6431. It does not mean a guessed queue rank, elapsed time, green CI alone, or a new persisted scheduling signal. Retargeting must still happen before deletion in both modes. If the merge attempt fails after retargeting, existing merge/review/CI guards remain authoritative; no policy result grants merge permission.
5. Keep mode selection separate from review acceptance and merge safety. All existing claims, identity checks, retry caps, required checks, and current-head review validation still apply when an action becomes eligible. No new persistent state, endpoint, timer, or daemon is required.

## MVP

- Implement the shared resolver and focused precedence tests first; update the settings layout test to prove the `stack` block remains singly owned and platform `eager` is not masked by a committed redundant default.
- Thread the resolved mode through the two planner paths and recovery plan/apply path. Give deliberate lazy deferral an explicit reason, with zero attempt consumption.
- Add a sequence regression: parent moves twice while open, child head stays unchanged in lazy mode, ordinary review/fix eligibility remains governed by existing rules, then parent landing permits the existing restack. Preserve explicit eager tests for today's behavior.
- Add retarget regression coverage proving that lazy timing never suppresses the pre-delete metadata operation. Keep drain and merge-gate source unchanged.
- Deliver these changes together: a setting that gates only one restack producer does not satisfy the story.

## Done when

- Default lazy mode schedules no child restack on an open parent's head changes through either planner path or stacked missing-run recovery. Eager mode retains those actions.
- A deferred recovery does not push, clear labels, post an attempt marker, increment retry rounds, or spend a dedupe key. Changing to eager or observing a landed parent can make it eligible on a later pass.
- Parent landing enables ordinary bounded recovery; pre-delete retargeting still runs. Review and legitimate fix work continue under the existing stack policy.
- Must refuse writes on unknown identity, ambiguous ancestry, unreadable required state, or a live claim whenever the existing action guards require refusal; lazy mode is not an authorization bypass.
- Must apply identical timing and safety rules to source, documentation, configuration, and data changes. No extension-based exemption.
- Executable acceptance: through we:scripts/readiness/heavy-admission.mjs, run the focused Vitest files listed in Test plan. New default-lazy sequence assertions must fail against pre-change consumer behavior and pass after implementation; existing eager and safety assertions must remain green.

## Test plan

- Planned we:scripts/lib/__tests__/stack-restack-policy.test.mjs covers planned we:scripts/lib/stack-restack-policy.mjs: absent values → lazy; platform/tool/env precedence; both valid modes; invalid enum, wrong types, unreadable settings; source diagnostics; no change to review policy.
- Existing we:scripts/conveyor/__tests__/pr-stack.test.mjs covers we:scripts/conveyor/pr-stack.mjs: lazy versus eager for both active and idle paths; repeated parent movement; observed landing; missing/unknown ancestry; disable switch; caps and used keys; fix/takeover preservation; overlap holds and hold expiry; no restack-round increment from lazy deferral. Mark old eager expectations explicitly rather than silently deleting coverage.
- Existing we:scripts/conveyor/__tests__/ci-red-recovery-watch.test.mjs (additional matching shards allowed by scope) covers we:scripts/conveyor/ci-red-recovery-watch.mjs: lazy stacked defer in dry-run and apply; no writer calls, comment, or label clear; eager chain recovery; default-branch recovery after retarget; unknown/fork/ambiguous parent and held-claim guards; missing-run retry accounting over multiple sweeps.
- Existing we:scripts/lib/__tests__/settings-files.test.mjs covers we:scripts/settings/stack.json: leaf ownership, discovery, valid stack object, and no redundant mode override masking the platform layer.
- Existing we:scripts/__tests__/pr-merge-gate.test.mjs verifies unchanged pre-delete retarget behavior, including failed retarget reporting. Use injected command runners to assert command order and absence of any child push.
- Run focused suites only via the host queue: invoke `node` with we:scripts/readiness/heavy-admission.mjs, arguments `run -- npx vitest run`, then the WE-relative forms of the test paths above. Run `npm run check:standards` through the same queue. The preparation runner owns these checks for this card-only change.

## Proof plan

- Implementer captures a before/after focused regression result, recording checkout SHA and effective setting source. A green suite alone is not proof of reduced live CI churn.
- In an authorized disposable stack, record parent and child head SHAs, PR bases, required-check runs, and review state. Move the parent twice with lazy mode effective; observe repeated planner/recovery passes and verify no restack dispatch or child-head change attributable to either producer, and no retry comments/label clearing from deferral.
- Repeat with eager mode to show the same eligible input reaches existing restack behavior. Restore lazy and exercise the parent through the drain: observe child retarget before branch deletion, then eventual bounded child recovery and CI on its actual new head. Record failures honestly; do not treat retargeting or a push as proof CI ran.
- Check a three-level stack: intermediate parent movement must not cascade background pushes into its child. Land bases in order and observe each child become eligible without manual state resets. Include one failed parent merge after retarget and confirm the ordinary merge gates still hold.
- Retain command/log receipts and head/run identifiers with the implementation review. Do not mutate the reported historical PRs merely to reproduce the incident. If no authorized live fixture is available, report live proof pending rather than declaring the performance goal verified.

## Non-goals

- No review-acceptance relaxation, CI bypass, new queue ranking, stack detector redesign, history rewriting, or changes to branch-deletion policy.
- No guarantee that all CI reruns disappear: explicit fixes, real conflicts, eventual restacks, and GitHub base-retarget events may legitimately trigger checks.

## Edge cases this change must handle

1. **Untrusted text** — retain validated refs, repository checks, and argument-array command execution; setting text is an enum, never shell input.
2. **Truncated reads** — unknown ancestry/identity remains unknown; no incomplete read authorizes restacking or claims parent landing.
3. **Shared state files** — no new state; deferred actions leave attempt counters and dedupe state untouched. Preserve existing atomic stack-memory writes.
4. **Fail closed** — malformed mode layers fall back through the validated cascade to lazy; existing mutation guards still refuse when evidence is missing.
5. **Identity scoping** — preserve same-repository, verified branch-tip and actor checks. A branch-name collision cannot authorize a push.
6. **State over time** — repeated open-parent moves defer without spending retries; mode changes and observed landing are reevaluated, not latched. Retarget-before-merge failure grants no merge permission.
7. **Who wrote it** — preserve writer claims and ownership checks; this setting changes timing, not the authorized actor.
8. **Receive/write endpoints** — no new endpoint, request body, or externally callable reset surface; body-size caps, rate limits, and CSRF/origin handling are not introduced by this change.

## Follow-ups

- Compare observed restack pushes and required-check runs per landed stack after deployment; tune nothing until receipts show a remaining problem.
- Any richer “next in line” prediction or persisted queue signal is a separate proposal, not part of this setting.
- If live proof exposes a defect in existing landing detection or retarget failure handling, file it with its evidence rather than silently widening this story into a detector or drain rewrite.
