---
bornAs: xabqoah
kind: story
size: 3
parent: "x0hvbwx"
status: open
blockedBy: ["xcs4nce"]
scope: ["we:scripts/check-standards.mjs", "we:scripts/check-standards-rules.mjs", "we:scripts/__tests__/check-standards.test.mjs", "we:scripts/__tests__/check-standards-main-state-parity.test.mjs", "we:scripts/lane-drain.mjs", "we:scripts/__tests__/lane-drain.test.mjs", "we:scripts/__tests__/lane-drain-numbering.test.mjs"]
dateOpened: "2026-08-05"
preparedDate: "2026-10-03"
preparedAgainstSha: "838e849ab8b35fa4b94216b7d474b3138d979ba5"
tags: [backlog, gate, hygiene, policy, ci]
---

# Gate in-flight backlog hash citations outside the drain's rewrite scope

**Re-aimed 2026-10-03** under epic #x0hvbwx as the `prCi.mainStateParity` story. A PR's check now runs the
drain's post-land numbering as a dry run on the PR merged with current main, so a PR that would make the
drain refuse fails on the PR, not on main. Governed by `prCi.mainStateParity` (default `on`).

## Original premise (kept for lineage)

JIT numbering (#2288) gives a new item a temporary hash id (`x` + six chars) that the drain rewrites to its
real `NNN` at land. Every hash citation planted outside the rewrite scope dangles once the item lands. PR
#1046 (`#2942`) planted about 60 across `we:scripts/` and `we:skills-src/`; three were runtime text shown to a
reviewing model. The original ask: a `check:standards` rule that errors on in-flight hash citations outside
the drain's rewrite scope, derived from the same code the drain uses, so the gate follows any change to the
scope.

**Prevention for:** PR #1046 review, round 2 finding 8 (`#2942`).

## Progress

Prepared 2026-10-03 against `838e849ab`.

| Old premise or scope | Corrected, with evidence |
| --- | --- |
| The drain rewrites only `backlog/` and `docs/agent/`. | Wider now: `backlog/`, `docs/agent/`, `agent-memory-src/` and the conveyor flows (`we:scripts/lane-drain.mjs:647-652`). Open PR #3788 adds the top-level soak break definitions. |
| An out-of-scope citation silently dangles after land. | Since the #4075 hardening, a hash-**path** citation outside the scope makes the drain **refuse the whole numbering pass** (`we:scripts/lane-drain.mjs:840-875`). That is worse: every pending card stays un-numbered. On 2026-10-03, the merge of PR #3176 (`bc9db934c`) put a soak citation outside the scope, the numbering refused, 282 cards stayed hash-named on main, and main's CI went red with 270 errors. |
| The fix is a new scan over a path constant. | The drain's own refusal logic can run as a dry run: `numberPendingHashes(cwd, { dryRun: true })` reaches the refusal check before its dry-run return (`we:scripts/lane-drain.mjs:840-875`, then `:889`). Calling it **is** "derive from the same code". No second path list. |
| PR CI and main judge the same thing. | **No.** `strandedHashesOnMain` hard-errors on main but only warns in a lane or in PR CI (`we:scripts/check-standards.mjs:774`, through `isPullRequestCiRun` at `we:scripts/check-standards-rules.mjs:2865-2868`, rule at `:2870-2899`). So PR #3176 was green while its land turned main red: failure mode (1). |

Scope widened from "a citation rule" to "PR-side parity for main-only rules", with the dry run as the first
parity rule. The original goal, catching the dangling citation before land, is kept and delivered by the dry
run.

## Design

1. **Dry-run parity rule** `drainPostLandDryRun(root, { baseRef })` in `we:scripts/check-standards-rules.mjs`.
   It calls `numberPendingHashes(root, { dryRun: true })`. The refusal result today carries only an `error`
   string; the builder adds a structured `refusals: [{ file, hash }]` field beside it in
   `we:scripts/lane-drain.mjs` (the list `unsweptHashPathCites` already holds), with a test in
   `we:scripts/__tests__/lane-drain-numbering.test.mjs`. Start after PR #3788, which changes the same refusal path.
2. **Caused vs inherited: only a refusal this PR causes is an error.** The strand rule was deliberately
   relaxed in PR CI and in lanes because erroring on a condition already on main wedged `verify-lane` for
   every lane and turned each pre-existing strand into a red test for an unrelated PR (see the comment at
   `we:scripts/check-standards-rules.mjs:2860-2868`). This rule keeps that lesson, and decides "caused" **by
   difference, not by which files the PR touched**. The rule runs the dry run twice: once on the **base tree**
   (`baseRef`, checked out read-only into a temp worktree, running the base's own `we:scripts/lane-drain.mjs`)
   and once on the merged tree it is judging (running the PR's `we:scripts/lane-drain.mjs`). A refusal
   `{ file, hash }` in the merged result is **caused** when it is not in the base result. If the base run did
   not refuse at all and the merged run does, every merged refusal is caused. A refusal is **also** caused
   when its `file` is among the PR's changed files (`git diff --name-only <baseRef>...HEAD`) or its `hash`
   names a pending card the PR adds or edits: a PR that touches a refusing file owns it.
   - **The rule, in one line (operator ruling on this card):** a refusal that is **new against current main**
     is **caused**, whichever file it names and whether or not that file is in the PR's diff. It is never
     downgraded to a warning. "Current main" is the freshly fetched `baseRef`; a refusal counts as already on
     main only when the base run proves it (below).
   - **Inherited needs positive proof; caused is the default.** A refusal is **inherited** only when all of
     these hold: the base run **completed without throwing** and returned a structured `refusals` list (empty
     or not, even when it also carries an `error` string), that list contains
     the same `{ file, hash }`, and neither the file nor the hash is touched by the PR. A refusal that is
     **new against current main** is caused, even when its file is not in the PR's diff. Anything short of
     that proof is caused, never downgraded (the one exception is a bare lane with no `baseRef`, below, and
     PR CI judges the same tree again): the base run threw or returned no structured list; the merged
     run refuses with an `error` string but no parsable `refusals` list (so the keys cannot be compared);
     `baseRef` is stale (the rule re-fetches `baseRef` first, and if the fetch fails in PR CI the base
     comparison counts as failed, below). The warning is reserved for a refusal main **already holds**.
   - **Why the file-in-the-diff test alone is not enough.** A PR can cause a refusal **without touching the
   refusing file**: it narrows the drain's rewrite scope, edits the refusal logic in
   `we:scripts/lane-drain.mjs`, or moves or renames the scope constant, and citations already on main start
   refusing though neither they nor their cards are in `git diff --name-only`. The differential catches all of
   these, because it compares what the drain would do on each tree.
   - Caused, under `on`, in PR CI or a lane: a hard error: "after this lands, the drain's JIT numbering will
     refuse: <detail>. Cite the durable thing, or widen the sweep." The message says whether the PR touches
     the refusing file or only changed the sweep, so the author can see why.
   - Inherited, in PR CI or a lane: a **warning** naming the refusal and saying it comes from main, never an
     error. An unrelated PR stays green on a main that already holds a refusing citation, and a CI heal is not
     asked to fix what it cannot.
   - No `baseRef` available (a bare lane with no origin ref): everything is inherited, so a warning only. The
     rule fails open to today's relaxed behaviour rather than wedging a lane. **In PR CI a `baseRef` always
     exists**, so there the base run is never skipped: if the base run itself cannot be executed (the
     worktree or the dry run throws), the rule does not guess "inherited"; it treats every merged-tree
     refusal as caused and says in the error that the base comparison failed. Only a bare lane may fail open.
   - On main (push-to-main CI): any refusal is an error, because a strand is about to happen or has.
   - In PR CI, the checkout is the PR merged with current main (`we:.github/workflows/ci.yml:168-172`,
     check-standards at `:215`), and `baseRef` is the PR's base (`origin/<base>`).
3. **Main-state rule registry.** Export `MAIN_STATE_RULES` from `we:scripts/check-standards-rules.mjs`. It
   lists each rule whose severity depends on the locus (today `strandedHashesOnMain`) next to its PR-side
   twin (`drainPostLandDryRun`). A test fails if `we:scripts/check-standards.mjs` branches on
   `isPullRequestCiRun` or `inLane` for a rule that is not in the registry. So a new main-only difference
   cannot land without a PR-side twin.
4. **Policy.** `on`: the dry-run rule runs. `off`: it is skipped (today's behaviour). Read through the loader
   from story #xcs4nce. In PR CI and lanes, the policy is read from the **base** copy of the config
   (`ref` = `baseRef`), so a PR cannot switch this rule off for itself.

This also covers failure mode (3), a CI heal turning a PR green without fixing the cause. Under `on`, a heal
is judged by the same post-land rule, so it cannot green a PR whose land would stop the numbering.

## MVP

Steps 1 to 4.

## Test plan

- **Capability (RED today, fails before this lands):** `we:scripts/__tests__/check-standards-main-state-parity.test.mjs`:
  - **Replay of the PR #3176 merge (`bc9db934c`):** a temp repo with a pending card `xhash01-alpha` and a file
    outside the rewrite scope citing that card by its hash-named backlog path. Use the nested fixture path from PR #3788's
    refusal cases, so the case stays valid after #3788 widens the sweep. Run with
    `GITHUB_EVENT_NAME=pull_request` and `GITHUB_ACTIONS=true`.
    - Before this story: no error on the PR.
    - After, under `on`: one error naming the file and the hash.
    - Under `off`: no error.
  - Default (no config): behaves as `on`.
  - **Inherited, not caused (an unrelated PR on a main that already refuses):** main already holds the PR
    #3176 citation (the 2026-10-03 state). A PR that changes only an unrelated file gets a **warning** naming
    the inherited refusal and **no error**, in PR CI and in a lane. The same tree on push-to-main is an error.
  - **Caused:** a PR that adds a new out-of-scope citation of a pending hash, and a PR that adds a pending
    card whose hash main already cites out of scope, each get an error (the refusal is in the merged run and
    not in the base run, or names a pending card the PR adds). A PR that touches the file that already holds
    the citation (without introducing it) is also an error: the file is in the diff.
  - **Caused indirectly, by changing the sweep (RED today):** the base tree has a citation in a file that is
    inside the rewrite scope, so the base dry run does not refuse. The PR changes only
    `we:scripts/lane-drain.mjs` (narrows the scope constant, or moves or renames it) so that file is now
    outside the scope. Neither that file nor its card appears in `git diff --name-only`. Expect **an error**,
    not a warning. A second case changes the refusal logic itself so a previously accepted citation now
    refuses: also an error.
  - **New against current main is caused, wherever the file is (RED today):** a PR whose diff touches only
    an unrelated file, merged onto a main tip that has moved since the PR branched, where the merged tree
    refuses `{ file: F, hash: H }` and the **successful** base run's `refusals` list does not contain it,
    and neither `F` nor the card for `H` is in `git diff --name-only`: an **error**, not a warning. The same
    PR with `{ F, H }` present in the base list: a warning.
  - **No proof, no downgrade (RED today):** each of these gives an **error**, never a warning, in PR CI:
    the base run returns an `error` string with no `refusals` list, so a merged refusal whose file is not in
    the diff is not proven inherited; the base run returns `refusals: undefined`; the merged run returns
    an `error` with no parsable `refusals` list (any refusal is an error, since no file is known to
    compare); the `baseRef` fetch fails. The error names which proof was missing. A base run that
    returns `refusals` **and** an `error` string still proves inherited for the keys it lists.
  - **Inherited stays inherited under the differential:** a refusal present in both the base run and the
    merged run, from a PR that touches neither the sweep, the file nor the card, is still a warning.
  - **Base comparison failure in PR CI:** with the base dry run injected to throw, every merged refusal is an
    error and the message says the base comparison failed. In a bare lane with no `baseRef`, a warning only.
  - No `baseRef`: the refusal is a warning only.
  - The policy file is read from the base: a PR whose head sets `prCi.mainStateParity` to `off` is still
    judged under the base's `on`.
  - A clean tree (citations only in scope): no error under either value.
  - The registry test: a locus branch with no registered twin fails.

## Proof plan

1. In a scratch clone, check out the PR #3176 merge state (`bc9db934c`) and run `npm run check:standards`
   with the pull-request environment set. **Before** (current main's rules): passes, with only the
   stranded-hash warning path. **After:** fails with the dry-run error naming the soak citation.
2. Run the same on current origin/main (which already holds the inherited refusal) with an unrelated one-file
   PR on top. It must show a warning and **no error**, so the rule adds no false red.
2a. In a scratch clone of current origin/main, make a one-file change that narrows the drain's rewrite scope
   (touching only `we:scripts/lane-drain.mjs`). **Before:** the PR-side check shows no error. **After:** it
   shows the error for the citation that now refuses, though that citation's file is not in the diff.
3. Paste both outputs in the PR.

## Follow-ups

- Bare hash tokens (an `x` plus six characters, without a backlog path) outside the scope do not make the
  drain refuse. They only dangle. A warning for them was part of the original ask. It is left as a follow-up,
  because it never turns main red.

## Done when

1. **Executable:** the replay case in `we:scripts/__tests__/check-standards-main-state-parity.test.mjs` fails
   before this lands and passes after.
2. Proof steps 1 and 2 are pasted in the PR.
3. **Executable (the operator's indirect-cause ruling):** the "Caused indirectly, by changing the sweep" and
   "New against current main is caused, wherever the file is" cases in
   `we:scripts/__tests__/check-standards-main-state-parity.test.mjs` fail before this lands (they assert an
   error where today's relaxed rule gives none) and pass after.
