# Finish stuck lanes — take over the producer's half-done work, then land (#2200)

> **Invoked as `/finish`.** (Was `/resume`, renamed 2026-07-03 — `/resume` is a Claude Code built-in that
> shadowed the skill so it never dispatched. The mechanism + `lane-resume.mjs` keep the "resume" mnemonic.)

`/drain` lands couples that are **already ready**. But a producer (`/workflow`, `/batch`) routinely leaves
lanes that *aren't* ready — a **conflict** with a peer that landed first, a red required **`test`** (the lane
shipped a real bug), or (rarely) a **`blockedBy`** item that isn't landed yet. `/drain` skips those forever.
`/finish` is the consumer that **takes them over**: it seeds a finisher subagent with the **existing lane ref**
(reuse the ~done work — never rebuild from scratch), repairs only the broken part, and hands the now-ready
couple to the normal drain transport.

> **Reuse, not rebuild.** The work sits intact on the `lane/*` refs (WE + any coupled `frontierui` ref). Only
> the *landing* broke. A finisher clones the existing ref, rebases onto `main`, and fixes what's red — it does
> NOT re-provision a fresh lane or redo the item.

> **All 3 repos by DEFAULT (#2383 — parity with `/drain`'s #2287).** `discover` sweeps the whole constellation
> — web-everything **+ frontierui + plateau-app** — reusing the SAME `resolveRepos` as the drain, so a stuck
> plateau-app or frontierui lane is found without a per-repo copy of the skill. Every `gh` call is `--repo`-scoped;
> a remote lane reads its manifest via the GitHub API and lands through that repo's **sibling clone** (deferred to
> the drain, #2263). The backlog is WE-global, so a remote lane's `blockedBy` still resolves against the one WE
> backlog. **Manifest-less repos degrade gracefully:** a lane with no `.lane-manifest.json` (e.g. plateau-app's
> own batch branches) gets `item`/`blockedBy` null → unordered *within* its repo, exactly like the drain's
> orphan-PR handling — never an error. Pass `--this-repo` (or `--repos=owner/a,owner/b`) to scope.

## Preconditions

- Run the mechanical parts from an **isolated clean clone on `main`** — never the shared primary checkout
  (#2197: a dirty primary makes the housekeeping `git pull` conflict and strands the tree mid-merge).
  Provision one outside `.lanes/` and **never `git pull` in the primary** — all fetch/rebase/sync happens in
  the clone. (Env setup for the finisher — symlink `node_modules` + a sibling `../frontierui` — is in the
  finisher playbook below.)
- `gh` authenticated (`gh auth status`). Landing goes through the same self-approved transport as `/drain`
  (`scripts/merge-ai-prs.mjs` / `scripts/pr-land.mjs`).
- The single-branch guard forbids `git checkout <branch>` / `git switch` / worktrees in shared checkouts. A
  finisher gets a real working tree by **`git clone --branch <laneRef> --single-branch`** (clone is not
  guarded) and pushes only to `lane/*` (allowed) — no branch switch anywhere.

## Run it

```
node scripts/lane-resume.mjs discover            # classify every stuck lane across ALL 3 repos + why, blockedBy-ordered (#2383)
node scripts/lane-resume.mjs discover --json     # same, machine-readable (the plan the skill iterates); each lane is tagged with its `repo`
node scripts/lane-resume.mjs discover --this-repo        # scope to the cwd repo only (opt out of the constellation sweep)
node scripts/lane-resume.mjs discover --repos=owner/a,owner/b   # an explicit repo set
node scripts/lane-resume.mjs discover --window-days=N    # widen/narrow the pr-missing staleness cutoff (default 7)
node scripts/lane-resume.mjs open <laneRef>              # #xcf4556: open the PR for ONE pr-missing lane ref (below)
node scripts/lane-resume.mjs open <laneRef> --repo=owner/name   # open a REMOTE constellation-repo ref (use discover's `repo` tag)
node scripts/lane-resume.mjs land <pr> --dry-run # plan the enqueue of ONE repaired lane PR (enqueue vs rebase-drop vs skip)
node scripts/lane-resume.mjs land <pr> --repo=owner/name   # land a REMOTE constellation-repo PR (use discover's `repo` tag); omit for the cwd repo
node scripts/lane-resume.mjs land <pr>           # #2290: rebase-drop the manifest if only it conflicts, then ENQUEUE (label + trigger a single-couple drain) — never merges directly
node scripts/lane-resume.mjs rebuild-plan --spec=<file>|-    # #2396: after a broken stacked LINK is repaired, plan the descendant-tail rebuild; `landed` omitted → derived from bornAs-on-main
node scripts/lane-resume.mjs rebuild <laneRef> --onto=<sha>  # #2396: execute ONE planned step — rebuild a descendant tip onto the repaired parent tip SHA
```

**Always `discover` first.** It buckets the labelled PRs into `ready` (not stuck — `/drain` takes them),
`conflict` (rebase + resolve), `test-red` (a real bug to fix), `review-changes` (a human bounced the diff —
repair before any land, #2396), `blocked` (blocker not landed, OR poisoned by a broken stacked ancestor —
defer), and `unknown` (recompute mergeability and re-run). It reads each lane's `.lane-manifest.json` for
`item` / `repos` / `blockedBy` / `stackParents`, treats a blocker as landed when its backlog file is
`status: resolved` on `main`, and orders lanes so none precedes one it is `blockedBy`.

### `pr-missing` (#xcf4556) — a lane can finish and STILL never get a PR

Every bucket above starts from the labelled-PR sweep, so a lane that never got a PR at all is invisible to
it — the live case (2026-09-25): a `/workflow` orchestrator ended while a lane agent sat inside `pr-land`
waiting on required checks, so `gh pr create` never ran, even though the lane had already committed, resolved
its card, and pushed `lane/batch-2026-09-25-waveB4-3915`. `/drain` never sees it either (it only lands what's
already labelled). `discover` closes that gap with a SEPARATE sweep: it enumerates every remote `lane/*` ref
per constellation repo (local git for the cwd repo; the same sibling clone `../frontierui`/`../plateau-app` the
drain's own rebase-drop plumbing already depends on for a remote one, #2263 — no sibling clone provisioned ⇒
that repo is skipped for this bucket, fail-soft) and buckets a ref `pr-missing` when ALL of:

- it has **no PR in any state** — open, merged, **or a deliberately-CLOSED one**: a human closing a PR is a
  decision, never silently overridden;
- its tip is **not** already an ancestor of `origin/main` (nothing landed some other way already);
- it carries a **real, non-manifest delivery** (some file besides `.lane-manifest.json` changed against main —
  an aborted/empty lane is not a finished delivery);
- its tip commit is within `--window-days` of now (**default 7** — an ancient orphan reads as abandoned, not
  mid-flight; `/finish` never resurrects one silently).

The item it delivers, when derivable, comes from the lane manifest first, then a `resolve #NNN` commit
subject, then a changed `backlog/NNN-*.md` file's own id.

**Recover one** with `node scripts/lane-resume.mjs open <laneRef>` — it opens the PR through the SAME producer
transport every lane uses, `scripts/pr-land.mjs --label-on-green` (**never** a raw `gh pr create`), with a body
that says it was recovered by `/finish` and names the item. It REFUSES (opens nothing) when:

- a PR already exists for that head, in any state (including CLOSED);
- the ref's tip is already reachable from `origin/main`;
- the card it resolves is already `status: resolved` on main by a **different** commit — a human/finisher must
  reconcile which delivery is real before either lands.

`pr-land` opens the PR *before* it waits on checks, so a `check-timeout`/`check-red`/`behind`/`conflict` stop
still leaves a real PR. `open` reads pr-land's report through `open-pr.mjs`'s shared `classifySubmit` and prints
`✓ opened PR #N — pr-land then stopped (<reason>)` (exit 0) in that case. The PR exists: **never** open a second
one by hand. A `check-timeout` is picked up by the drain's ci-lifecycle reconcile; a `check-red`/`behind`/
`conflict` PR then needs the ordinary `/finish` repair (fix or rebase) like any other stuck PR.

**Do not open a PR for a `pr-missing` ref you are not confident is a genuinely finished delivery** — report it
instead (e.g. in the pass summary) and let a human or a later pass decide. `pr-missing` is a discovery signal,
not an unconditional auto-open list.

## How the skill drives it (per pass)

1. **`discover --json`** → the ordered plan. Drop `ready` (hand to `/drain`) and `blocked` (report, defer). For
   each `prMissing` entry, `open <ref>` the ones that clearly finished (real delivery, item known or plausibly
   inferred) and report the rest for a human — never auto-open one you aren't confident is genuinely done.
2. **For each remaining lane, in order**, spawn ONE finisher subagent (Agent tool) seeded with the lane. Run
   **independent lanes in parallel**; keep a `blockedBy` chain **serial**. For a **cross-repo** couple, the
   finisher lands the impl (`frontierui`) ref **before** the WE ref (impl-first / WE-last).
3. The finisher's contract (seed = the existing ref, NOT fresh `main`):
   - **When the lane already has an OPEN PR, take the fix claim FIRST** (fix procedure, operator-approved
     2026-09-27; draft-only-on-withdrawal, `docs/agent/platform-decisions.md#fix-claim-draft-only-on-withdrawal`):
     `node scripts/conveyor/fix-procedure.mjs fix-begin <pr> --repo=<the PR's repo slug, e.g.
     frontier-ui/frontierui> --who=<finisher name> --why="finish: <bucket>"`. `--repo` is required — a PR number is
     only unique within its repo, so a cross-repo couple names each half's own repo. **This is a normal repair
     loop, so it stays READY by default — never draft**; it refuses everyone else's pushes to the branch until
     you run `fix-procedure.mjs fix-end <pr> --repo=<same> --who=<same>` after your push (a claim never drafted
     leaves the PR ready with nothing further owed). Add `--draft --reason=scope-change` or
     `--draft --reason=withdrawn` to the SAME `fix-begin` call only if the finish pass itself discovers a
     genuine scope change or a fundamental miss against the card — never as the default. A finisher without a
     Claude session exports the `token` that `fix-begin` prints as `WE_FIX_TOKEN` (with `WE_FIX_WHO=<same>`) for
     its push and `fix-end` — the claim is bound to it, since `--who` alone is public. If `fix-begin` is
     refused, another fixer owns the PR right now — skip this lane this pass and report it; never push around it.
   - `git clone --branch <laneRef> --single-branch … && cd …`; symlink `node_modules` + a sibling
     `../frontierui` if the gate/generators need them.
   - `git fetch origin main && git merge FETCH_HEAD` → **resolve conflicts**; **regenerate derived artifacts**
     rather than hand-merging them (e.g. `node scripts/grammar-scorecard.mjs` re-emits the fidelity report).
   - Run the **full** scoped gate/tests (not the file-scoped fast-fail) — the lane owns a CI-green PR (#2199).
   - **drop the transient `.lane-manifest.json`**, commit, `git push origin HEAD:refs/heads/<laneRef>`, and
     confirm the required `test` check goes green.
4. **Land** the repaired couple. **#2290 — the drain is the sole writer to `main`.** Either hand the now-clean
   PR to `/drain` (`node scripts/merge-ai-prs.mjs --label=ready-to-merge`), or run `node
   scripts/lane-resume.mjs land <pr>` (#2202), which **enqueues** it (labels `ready-to-merge` + triggers a
   single-couple drain) rather than merging directly — both share the ONE #2198 rebase-drop-manifest helper, so
   a lane that only conflicts on the manifest lands without a human. Impl-first/WE-last, `blockedBy` order.
   (A `review:changes`-labelled PR is refused at this step too — repair + re-review first, #2396.)
5. **Rebuild a repaired link's descendant tail (#2396).** When the repaired lane was a broken stacked LINK
   (its descendants were bucketed `blocked` with "stacked ancestor #N is a broken link"), do NOT blind-rebase
   the batch: feed `rebuild-plan` a spec — `{repaired: <item>, descendants: [{item, ref, stackParents,
   fileset}], fixTouched: [<repo-qualified files the repair changed>]}` (descendant topology comes from
   `discover --json`'s `stackParents`; omit `landed` — it derives from bornAs-on-main). Then, per ordered step,
   `rebuild <ref> --onto=<repaired-tip-sha>`: exit 0 = fast-forwarded (push happened; land it normally);
   `guided-conflict` = that ONE descendant overlaps the fix — resolve it in that descendant's clone WITH the
   manifest topology, never force-resolve. `deferred` entries wait for a later pass (never past an unlanded
   parent). **Why the tail defers, why absence is never read as landed (the stowaway defense), and how
   `bornAs`-on-`main` proves land** — the full stacked-batch lifecycle is in
   *[docs/agent/backlog-workflow.md → Overlap-stacked serial batches](../../../docs/agent/backlog-workflow.md)*.

### The one knob — how autonomous on a red test

- **resolve-only (default):** finishers fix *conflicts + regenerated artifacts* (mechanical, safe) and land
  those. A genuinely-red `test` is reported back, not code-patched.
- **`--fix` (opt-in):** the finisher also debugs and fixes the failing code, then lands. Powerful, but an agent
  "making tests pass" can paper over a real bug — only with explicit go.

## Finisher playbook (#2202 — learned on the 2026-07-03 run)

**Env setup (do this first in every finisher clone).** Generators and gates need real deps and the sibling
impl repo: **symlink `node_modules` from the primary** (`ln -s <primary>/node_modules node_modules`) and make
the clone a **sibling of a `../frontierui`** checkout (cross-repo artifact builds resolve `../frontierui`). A
missing either → the gate fails with a spurious "cannot find module" that looks like a code bug but is an env
gap.

**Per-repo gate + env (each repo differs; run THAT repo's gate, not WE's):**

| Repo | Full gate the finisher must run | Env quirk beyond the symlink |
|---|---|---|
| **web-everything** | `npm run check:standards` | sibling `../frontierui` |
| **frontierui** | that repo's `test` script | sibling `../webeverything` |
| **plateau-app** | `node scripts/check-render-conformance.mjs` **+** `npx vitest run` | siblings `../frontierui` **and** `../webeverything`; **recreate the `@plateau/*` workspace links** |

> **plateau-app workspace-link gap (#2383 — learned 2026-07-09).** plateau-app is an npm-**workspaces** monorepo
> (`packages/*` = `@plateau/*`). A symlinked `node_modules` borrowed from a primary that predates a package
> split has **no `@plateau` scope**, so vite/vitest can't resolve `@plateau/tooling/*` and you get a spurious
> "Failed to resolve import" that looks like a lane bug but is an env gap (CI's fresh `npm install` links them).
> Fix the clone WITHOUT touching the primary: rebuild `node_modules` as a real dir that symlinks every entry
> from the primary's `node_modules`, then add `node_modules/@plateau/<pkg> → <clone>/packages/<pkg>` for each
> workspace package. `@plateau/tooling` resolves via its `exports` map (`"./*": "./src/*.ts"`); `@plateau/saas`
> /`core` have NO exports map and instead resolve through `vite.config.mts` aliases — so a NEW `@plateau/*` import
> the lane adds needs EITHER an exports map on that package OR a vite alias, or it 500s at boot.

**Conflict resolution table — resolve each conflicted path by its CLASS, never a blind hand-merge:**

| Conflicted path | Resolution |
|---|---|
| `.lane-manifest.json` (the transient manifest) | **drop it** — it is per-lane bookkeeping, not content (the `land`/drain helper does this automatically). |
| coordination JSON — `claims`/`reservations`/`capacity`/`queued` — and the `.claude/agent-memory/` tree | **take-main** — a peer session owns the newer state; your lane's copy is stale. |
| generated artifacts — grammar-scorecard report, `we:AGENTS.md`, parity report | **REGENERATE, don't hand-merge** — re-run the generator (`gen:inventory`, `grammar-scorecard.mjs`, the parity report) so the output matches the merged inputs. |
| code | **union additive by intent** (keep both sides' additions when they're independent). A genuine **same-line overlap** → **STOP and report** — never guess which side wins. |

**A sequencing conflict against a sibling decision is not in that table — post it, don't just report it.**
If, while rebasing onto `main`, you find the PR conflicts with a decision `main` already made elsewhere (e.g.
a sibling item deliberately deferred the exact feature this PR builds) — a cross-cutting concern
`review-pr` never checks for, since it only reviews a diff's own internal correctness — post it as a finding
directly on the PR: `node we:scripts/conveyor/reconcile-finding.mjs <pr> --body-file=<path> [--repo=<owner/name>]`.
This bounces the PR to `review:changes` so the finding enters the normal fix-and-re-review cycle, instead of
surfacing only in your own task summary where the operator has to ask before learning it exists.

**Recurring test-red root causes (fix MINIMALLY — never weaken or delete a test):**

- **epic-closeout** — resolving the last child of an epic ⇒ the umbrella epic must be resolved too (the
  all-slices-done gate). Resolve the parent.
- **living-catalog count-pins** — a new deliverable moves a `toBe(N)` count assertion. Bump the pinned N to the
  new true count (the test is a catalog census, not a regression).
- **reports-not-hidden** — a new `reports/*.md` the item produced trips the "report not referenced" gate. Add a
  `relatedReport:` field to the backlog item pointing at it.
- **stale generated inventory** — `we:AGENTS.md`'s generated block drifted. Regenerate it (`npm run
  gen:inventory`); never hand-edit the generated region.
- **backlog id-collision** — two files claim one NNN. The **newcomer yields** to the next free NNN
  (`scripts/backlog-renumber-collisions.mjs`, or rename by hand to the next free id).

**Landing nuances:**

- `UNSTABLE` + `test=pass` **IS mergeable** — only the `test` check is required; `cla` / Workers-Builds are
  non-required and their red never blocks a land (`landDecision` encodes this).
- **Land shared-file lanes SERIALLY and re-rebase between them** — two lanes touching one file each need the
  later one rebased onto the just-landed main; don't fan them out concurrently.
- **`discover` should warm-recompute mergeability** (`gh pr view` each) so no lane shows `UNKNOWN` — an
  `unknown` disposition means the recompute hasn't run yet, not that the lane is unlandable.

## Guardrails

- **Reuses transports, never re-implements them** — repair happens in the lane clone; landing is `/drain` +
  `pr-land`. No raw `git merge`/`git push` of `main`.
- **Never rebuilds a lane from scratch** — always seeds the finisher with the existing ref. If a lane is
  truly unrecoverable, report it; don't silently re-do the item.
- **Idempotent** — a re-run's `discover` no longer lists a landed lane; a partially-repaired lane resumes from
  its pushed state.
- **Respects `blockedBy`** — never finishes a lane ahead of an unlanded blocker.
