---
name: drain
description: Launch the deferred merge-queue drain — land the queued `lane/*` couples onto `main` via the standard PR transport, impl-first/WE-last, in cross-item `blockedBy` order. Use when the user asks to "drain the queue", "run the merge monitor/drain", "land the queued lanes", "watch the merge queue", or "clear the ready-to-merge couples". NOT for landing one specific committed change (that is `/pr`).
---

# Drain the deferred merge queue (#2162)

> **A resident daemon normally owns this now (#2449).** The phase-1 drain daemon
> (`plateau:tools/drain-daemon/`, hosted in plateau-app next to the dev-panel) holds the whole-process
> drain lease (#2391) for its entire residency and runs the sweep below as one-shot passes on an
> interval — *who runs `/drain`* is the one session convention it retires. The lease is now ALWAYS-ON
> for full/label sweeps and watches (#2449 closed #2424's opt-in gap and ratified #2443's "hold by
> default"): while the daemon (or any other drain) holds it, a manual full `/drain`/`/merge` **no-ops
> exit 0 surfacing the holder** — correct behavior, not a failure; the resident's next pass covers the
> work. `--only=<pr>` fast drains (what `/pr`/`/finish` shell) **bypass** the lease and stay instant
> (the numbering mutex serializes lands); `--dry-run` also bypasses, so the plan read below always
> works. Daemon stopped/absent ⇒ everything degrades to exactly this skill's manual flow — it remains
> the fallback and the single source for how a sweep works. Operate the daemon from the plateau-app
> checkout: `node tools/drain-daemon/cli.mjs status|once|logs|install|stop`.

The whole mechanism lives in **[scripts/merge-ai-prs.mjs](../../../scripts/merge-ai-prs.mjs)** — this skill is
the trigger + the ceremony around one invocation, so there is nothing to keep in sync here. The drain is the
consumer side of the #2183 PR fan-out: producing sessions (parallel `/workflow` lanes, solo `#2123` lanes, and
batch closeout) each **open a `ready-to-merge` PR per item** (#2196); this drain lands those labelled PRs
serially, in a later session, under the same self-approved PR transport the producers use.

> **Converged label lander (#2188/#2194).** `/drain` **is** the label lander
> `scripts/merge-ai-prs.mjs --label=ready-to-merge` — bare = one cascade pass, `--watch` = the poll loop. It
> merges the open `ready-to-merge` PRs (incl. orphans opened directly by `/pr`) in cross-item `blockedBy` order
> (each PR's `.lane-manifest.json`, read off its head ref, supplies the edges), and the PR-merge IS the single
> clear point (no `queued.json` unqueue). `/merge` (bare) is the same lander without the label scope. The old
> `queued.json` / `scripts/lane-drain.mjs` couple-drain is retired to a legacy no-op fallback (see below) — new
> producer output lands via the label lander.

> **Two-form ids — the drain numbers hashes at land (#2288).** A queued item's files may lead with EITHER a
> landed numeric `NNN` or a provisional `xNNNNNN` **hash** (born hash-keyed so parallel lanes never race on
> `max+1`). The drain is the **sole serial writer to main**, so it assigns the real sequential `NNN` at land
> (`numberPendingHashes`, blind-rewriting the hash → number across the filename, the item's frontmatter/body,
> and every other item's edges) — you never hand-assign one. Both the primary lander (`merge-ai-prs.mjs`) and
> the `pr-land --fallback-git` route number, so no land path strands a hash on main (#xzxc92d).

## Preconditions

- **Run from a LEASED lane-pool clone — NEVER the shared primary checkout (#2197 / ratified #2123).** The
  drain is an edit-action session (it advances `main` and, per #2198, rebuilds lane tips), so #2123's "every
  edit-action session runs in an isolated clone" applies. The primary tree almost always carries a peer
  session's uncommitted work, and the drain's own post-merge `git pull --ff-only --autostash` then hits an
  autostash-pop conflict and strands the tree mid-merge (observed 2026-07-03: an autostash-pop conflict on
  `claims.json` left the primary half-merged; recovery was manual). **Acquire a lease on the general
  lane-pool allocator (#2275/#2303)** instead of hand-rolling a clone — the drain is just another consumer
  of the same primitive `/batch`/solo `#2123` lanes use:

  ```
  node scripts/lane-pool.mjs acquire --purpose=drain --session=<drain-session-slug> --json
  ```

  This claims an exclusive `.git/.lane-lease` marker on the lowest free pool lane (or `--lane=N`), then
  `reset --hard`s it to `origin/<branch>` and ensures its `node_modules` (`npm ci`, real per-lane deps — no
  primary symlink) — exactly the "land on true `main` with deps present" state the old hand-rolled recipe
  manually constructed, but held so no concurrent `refresh`/`provision`/`acquire` can yank it mid-cascade.
  The JSON reply is `{ lane, path, session, purpose, branch }` — `cd` into `.path` and work there. `cd` back
  to `.path`'s repo root before every command below; do not run them from the primary. When the drain is
  done (a one-shot pass finishes, or a `--watch` loop exits/is stopped), hand the lane back:

  ```
  node scripts/lane-pool.mjs release --lane=<lane> --session=<drain-session-slug>
  ```

  `--session` (or the `LANE_SESSION` env) ties one `acquire` to its matching `release` — reuse the SAME
  slug for both calls. A `--watch` drain acquires ONCE at start and releases ONCE at exit, not per pass. If a
  release is skipped (a killed `--watch`), the lease self-reclaims after its TTL (`DEFAULT_LEASE_TTL_MINUTES`
  = 240) — a crashed drain returns its lane to the pool the same day, not never. The checkout root is
  allocator config (`LANE_POOL_ROOT` env, else `<the checkout's workspace>/.lanes`, derived from
  `git rev-parse --show-toplevel` rather than `$HOME` since #3265) — no skill embeds a literal
  `../we-drain-clean` or `.lanes` path.

  The pool already carries the render sibling every WE checkout needs: `../frontierui` at the pool root
  (`scripts/lane-pool.mjs` `ensureFuiSibling`, #2166), resolvable from a leased lane exactly as from a
  provisioned one — no extra step. `../plateau-app` has no pool-root sibling **yet** (tracked separately,
  #2349 — generalizing the FUI symlink into a per-repo pushable+built clone for both `frontierui` and
  `plateau-app`); until that lands, `--all-repos`' rebase-drop (#2198) degrades exactly as it did before
  #2263 for any repo with no sibling present — `left for its author`, never an error. The branch guard blocks
  `checkout -B`/`worktree add` even in a lane, so `acquire`'s own `reset --hard` is how the lane lands on
  `main` — never a manual checkout. **Never `git pull` in the primary** — all of this runs in the leased lane
  only.
- `gh` is authenticated (`gh auth status`) — landing is the same self-approved `gh pr merge` (0 required
  reviewers + the required `test` check) `/pr` uses. See [`/pr`](../pr/SKILL.md) for the transport.
- The lane's tree is clean on acquire (a fresh `reset --hard` + `clean -fd`): the post-merge sync (`git pull
  --ff-only --autostash`, in the lane) is a pure fast-forward there, so it never conflicts with a peer
  session's edits the way the primary would.

## Run it (the label lander — #2194)

`/drain` now drives the ONE label lander `scripts/merge-ai-prs.mjs --label=ready-to-merge`, **not**
`lane-drain.mjs` (the constellation sweep is the default since #2287 — no `--all-repos` needed; pass
`--this-repo` to scope to the cwd repo only). It sweeps the open `ready-to-merge` PRs and merges each as it becomes eligible (green +
mergeable), in cross-item `blockedBy` order (each PR's `.lane-manifest.json`, read off its head ref, supplies
the edges — the #2188 convergence).

> **One skill, all 3 repos — BY DEFAULT (#2257/#2287).** The single lander sweeps **every** constellation repo
> — web-everything **+ frontierui + plateau-app** — in ONE global `blockedBy` cascade, with **no flag needed**
> (#2287 made all-repos the default). This is why `/drain` stays a single skill instead of a copy per repo
> (#2244/#2245 superseded): the backlog is WE-global, so a frontierui PR can be `blockedBy` a WE item, and only
> a single cross-repo sequencer can order that. Every `gh` call is `--repo`-scoped; a remote-repo PR reads its
> manifest via the GitHub API (never a local clone). The rebase-drop (#2198) still needs local git plumbing
> (merge-tree/commit-tree/push): for the LOCAL clone's own repo it runs in place; for a remote repo it routes
> through that repo's **sibling clone** (`../frontierui`, `../plateau-app`) when the leased lane's pool root
> carries one (#2263; the pool-root `../frontierui` symlink, #2166 — see the precondition above) — so a
> CONFLICTING/BEHIND non-local lane tip gets rebuilt too, not just left for its author. No sibling clone
> provisioned ⇒ unchanged legacy skip. **Landing a frontierui/plateau PR still needs
> that repo's own required `test` check + branch protection (#2242/#2243/#2246)** or GitHub blocks the merge;
> until those land, those PRs surface here as `skip (required check "test" is not green)` rather than silently
> vanishing. Pass `--this-repo` to scope to the cwd repo only, or `--repos=owner/a,owner/b` for an explicit set.
> (`--all-repos` is still accepted — it's a no-op alias of the default now.)

```
node scripts/merge-ai-prs.mjs --label=ready-to-merge --dry-run                          # plan only — print the blockedBy-ordered merge order (across ALL 3 repos, the default) + deferred set, merge NOTHING
node scripts/merge-ai-prs.mjs --label=ready-to-merge --primary=<primary>                 # /drain (bare): ONE cascade pass across all 3 repos — land every ready labelled PR, exit
node scripts/merge-ai-prs.mjs --label=ready-to-merge --primary=<primary> --watch --interval=30 # /drain watch: keep polling; land each PR the instant it goes green (--max-idle=N bounds it; Ctrl-C stops)
node scripts/merge-ai-prs.mjs --label=ready-to-merge --primary=<primary> --watch --until-batches-idle # /drain watch that SELF-TERMINATES when the active batch is fully delivered (#2330)
node scripts/merge-ai-prs.mjs --label=ready-to-merge --this-repo                         # opt OUT: scope to the cwd repo only (a deliberately single-repo drain)
```

**Always dry-run first** to show the merge plan, then run bare (one-shot) or `--watch` (follow). Prefer the
one-shot unless the user wants a long-lived monitor waiting for producers still opening PRs.

**`--until-batches-idle` — a batch-aware exit for a drain launched to land a batch (#2330).** `--max-idle=N` is
UNSAFE for a live batch: items take minutes, so the watch goes idle *between* PRs and `--max-idle` would exit
mid-batch. `--until-batches-idle` instead exits only when the safe conjunction holds — **no `kind:batch
status:running` run remains** AND the **ready-to-merge queue is empty** AND **nothing is deferred** — debounced
over `--batch-idle-debounce` passes (default 2). It reads the running-batch signal from the active-progress feed
(`_site/active-progress.json`, written by `scripts/dev/active-progress-watch.mjs`); an **absent/stale feed ⇒
keep watching, never a false stop**. The feed only exists while that dev watcher runs, so for a drain-only
session point `--batch-feed=<path>` at the primary checkout's copy (else the drain harmlessly runs unbounded —
it now prints a one-time note when the feed is absent so the inert degrade is visible). Before honoring the
exit the drain **re-polls once** to confirm the ready-to-merge queue is genuinely empty (the last PR's label
can lag the producer's resolve — the #2230 defense, so the final PR is never dropped). Keep
`--batch-feed-stale-sec` (default 30s) comfortably above the watcher's ~4s write cadence.
*(Design note carried from the #2330 review: the feed is a dev-only, website-facing artifact — a later
refinement should read the batch journals directly to drop that coupling; the exit contract above is unchanged.)*

> **Pass `--primary=<primary>` so the post-land sync can find your primary checkout (#xwokc1n).** After each
> land the drain fast-forwards the user's primary checkout to the advanced `origin/main` so it never rots. It
> locates that primary via `--primary=<path>` (or the `WE_PRIMARY` env), falling back to the clone's git
> alternates. **A leased lane-pool clone (#2303) IS `git clone --reference`-based**, so it carries an
> alternates file pointing at the pool's reference checkout (normally the primary) — the fallback now
> usually resolves it automatically, unlike the old hand-rolled `git clone --local` recipe (which created
> **no** alternates file, so without `--primary`/`WE_PRIMARY` the primary silently drifted — observed 75
> commits behind). Still pass `--primary`/`WE_PRIMARY` explicitly when you want it guaranteed (e.g. the pool
> was provisioned with a non-primary `--reference`). The sync is a pure `git pull --ff-only` and **only
> touches a primary that is on `main` with a clean tree** — a dirty primary (a peer session's uncommitted
> work) is left UNTOUCHED and logged, never autostashed or stranded (the 2026-07-03 incident). Omit the flag
> deliberately if you do NOT want your primary advanced.

## How it works (per pass)

1. Lists the open PRs carrying the `ready-to-merge` label — `gh pr list --state open --json …,labels`, filtered
   by label CLIENT-SIDE, never `gh pr list --label …` (that flag is served by GitHub's issue-SEARCH index, a
   separate and much smaller rate-limit budget than the ordinary list — #no-label-search, 2026-09-27 live
   incident) — every producer (`/workflow`, `/pr`, solo `#2123` lanes, batch closeout) applies it (#2196), so
   this is the single collection point for ALL AI-generated work.
2. For each candidate, reads its `.lane-manifest.json` off its head ref and orders by cross-item `blockedBy` —
   a PR whose blocker is still an open (unlanded) PR **defers** to a later pass (the cascade). Orphan PRs (no
   manifest) are always ready.
3. **Rebase-drops the shared manifest (#2198)** — a certified + green PR that is only CONFLICTING/BEHIND on the
   one shared `.lane-manifest.json` path is rebuilt onto `main` (manifest dropped) via pure plumbing (no
   checkout) before merging, so the "manifest lands then conflicts every other PR" wall no longer stalls the
   queue. A real (non-manifest) code conflict is left as a skip for a human. On by default; `--no-rebase-drop`
   disables. A rebuilt tip re-runs `test`, so it lands on a later `--watch` pass (expected, not a failure).
4. Merges each ready PR via the SAME self-approved, non-admin `gh pr merge --merge --delete-branch` the `/pr`
   flow uses — only when its required `test` check is green and GitHub reports it cleanly mergeable. A merge
   **frees its dependents** the next inner pass; a failed/behind PR stays blocking its dependents (never land
   past a broken blocker). The closed PR carries the label away — that PR-merge IS the single clear point (no
   `queued.json` unqueue).
5. After anything merged, fast-forwards **the clone's** local `main` to the advanced `origin/main`
   (`git pull --ff-only --autostash`, best-effort) — in the isolated clone, never the primary checkout.

**Report the pass to the operator via `renderDrainRunSummary()` (#2433), not hand-composed prose.** Feed it the
(sub)shape of the pass's own `--json` result (`{merged, failed, deferred, parked, skipped, dryRun}` — the exact
fields `merge-ai-prs.mjs` already returns, see `## Run it` above) and post its output verbatim as the end-of-run
line(s) — this is the ONE place that wording is templated, so a plain one-shot pass, a `--watch` loop's final
pass, and a batch-closeout drain all report the same way.

## Stacked-chain couples — the proof-of-land gate (#2387)

A serial `/batch` may hand this drain an **overlap-stacked chain**: item N+1's lane was cut from item N's
**pushed tip** because they share files, so their PRs must land **in order**. The transport above is
**unchanged** — the ordering is enforced by a positive, **identity-based proof-of-land gate** read off each
PR's manifest, never by ref-absence:

- A stacked PR's `.lane-manifest.json` carries **`stackParents`** (an `asItemId` list — the frontier-tip
  item(s) its lane was cut from / merged onto) plus a per-repo **`base`** SHA. `blockedBy` stays the hard
  *semantic* edge; `stackParents` is the *lineage* edge.
- **Gate a couple READY only when every `stackParent` is proven landed** — either **landed this same pass**
  (the in-memory set) **or `bornAs`-proven on `main`**. A parent that is neither is a **DEFER**, not a skip.
  **Never read a missing ref as "landed"** — this is a *positive* gate by construction (the #2387 F5
  stowaway defense: salvaging a tail past an unlanded parent would drag the parent's unreviewed code onto
  `main` under the child's number).
- **`bornAs: <hash>` is the landed proof.** At land the numbering routine stamps `bornAs: <birth-hash>` on
  the item's frontmatter and **excludes it from the blind hash→NNN rewrite** (the one-line guard in
  [we:scripts/backlog/id.mjs](../../../scripts/backlog/id.mjs)) — so it survives on `main` as the durable,
  cross-clone, renumber-immune birth record every clone reads; `landedNumberFor(hash)` resolves it. (Not
  excluding it is a permanent-strand deadlock — the parent's proof would be rewritten to a number the child's
  recorded parent never matches.) `bornAs`-on-`main` is the **sole** cross-clone landed proof; the local
  `id-ledger.json` is numbering bookkeeping only, and `bornAs` derives one-directionally from it so they
  cannot diverge.
- **Couple-granular.** The gate is evaluated at couple granularity via the impl-PR→WE-manifest `laneRef`
  join, so a manifest-less impl PR inherits its couple's `stackParents` and is never independently "ready"
  ahead of its couple.

Because a landed parent is an ancestor of `main`, git auto-computes it as the merge-base and the stacked
child lands **three-way-clean** through the **unchanged** rebase-drop rebuild (#2198) — no `--merge-base`
override. A **broken parent** (red `test` / bounced `review:changes`) **defers its true overlap-descendants**
while disjoint siblings land normally; the tail is rebuilt by [`/finish`](../finish/SKILL.md)'s stack-repair.
Full end-to-end narrative — overlap-stacking, the `actual ⊆ declared` producer contract, the capability-marker
rollout, push-at-close: *[docs/agent/backlog-workflow.md → Overlap-stacked serial batches](../../../docs/agent/backlog-workflow.md)*.

**Two locks (#2391), not one.** The drain holds a **whole-process lease** (`O_EXCL` + TTL) for its lifetime
(the daemon note at the top of this skill) **and** a distinct fine **numbering-critical-section mutex** around
*number + publish* at every land call site. They are separate on purpose: the lease delivers "exactly one
drain," the mutex enforces "sole serial writer to `main`" (no two lands race to `max+1` and mint a duplicate
`NNN`). Push-at-close checks the **lease**.

## Auto-review the parked PRs (#2285 v1 + v2)

The #2171/#2262 review-escalation gate **parks** a blast-radius PR (`review:pending`) and waits for an
independent reviewer to apply `review:accepted`/`review:changes` — otherwise every escalated PR stalls the
queue until a human gets to it. **v1 makes the drain run that independent review itself, in a spawned
reviewer** — for the PRs where an agent reviewer is genuinely independent of the *producer*. **v2 (#2311)
replaces v1's author-bounce with a bounded editor↔reviewer negotiation loop** (below). The one invariant BOTH
preserve: **a landed PR was accepted by an agent that did not author it.**

> **One engine (#2326).** The `{findings, verdict}` contract is single-sourced in `we:scripts/lib/review-core.mjs`
> (#2325): `buildMandate()` renders the judge-only instruction each juror is seeded with (it bakes in
> the #2336 diff-only, **no-checkout** clause), `normalizeFindings()` shapes what it returns, and
> `deriveVerdict()` maps findings → `accept`/`changes`/`needs-human`. The drain review below and the
> [`/review`](../review/SKILL.md) human-verdict skill BOTH render through it — no hand-rolled reviewer prose.
> **#2311 (v2)** adds `buildEditorMandate()` (seeds the editor subagent's revision round) and
> `deriveNegotiationOutcome()` (the ONE deterministic `continue`/`land`/`escalate` derivation from a round's
> verdict + the round cap) — same module, same single-sourcing discipline. **#2310 (v3)** adds the
> `MANDATE_LENSES`/`MANDATORY_LENSES`/`ADVISORY_LENSES` panel, `buildPanelMandate()` (seeds one reviewer per
> lens), `derivePanelVerdict()` (reduces the panel's per-lens verdicts to the ONE combined verdict
> `deriveNegotiationOutcome` already consumes — the round loop itself is unchanged) and
> `renderPanelVerdictTable()` (the operator-facing split-verdict surface). **#2433** adds the SESSION/NOTICE
> renderers (distinct from the PR-comment table above): `renderDrainRunSummary()` (the end-of-run pass
> summary) and `renderReviewNotice()` (the in-chat escalation/clearance notice — used by both this skill and
> [`/review`](../review/SKILL.md)) — same module, same discipline: template the render, never hand-type the
> prose.

The lander classifies each parked PR (see `we:scripts/lib/review-escalation.mjs` `isDeclarativeLeashPath`) and
emits it in the `--json` output's `parked` array as `{ num, repo, humanRequired, reasons }`.

> **`humanRequired` is NARROWER than "touches the gate" (#2771/#2785, statute
> [`#review-human-declarative-leash-only`](../../docs/agent/platform-decisions.md#review-human-declarative-leash-only)).**
> Only the **declarative leash** — the policy contract, the `we:gate-config.mjs` roster, and the invariant /
> conformance suites — forces a human. The gate's **derivation code** (`we:review-escalation.mjs`,
> `we:review-core.mjs`, `we:review-policy.mjs`, the two land seams) parks `review:pending` and the independent
> committee clears it, exactly like the engine tier. So do NOT tell the operator a PR is theirs merely because it
> edits the gate — read `humanRequired` / the `gate-self` vs `gate-derivation` reason, never the file path.

> **The converge-vs-human branch is ONE derivation (#2285).** Don't hand-branch on `humanRequired` — call
> `deriveReviewDisposition({ reasons })` in `we:scripts/lib/review-core.mjs` and act on `{ mode, autoLand }`. It
> is single-sourced so **every** review surface (this drain, `/review`, `/merge`) shares the policy, keyed on WHY
> the PR escalated. `mode: 'converge'` → run the panel↔editor loop below; `mode: 'human'` → hand straight to a
> human, no convergence. `autoLand: false` → an agent may FIX but never CLEAR it (a human gates the merge). Map
> the drain's signals to reasons: don't re-derive them — the `parked` entry's `reasons` already carry the exact
> decorated strings (`gate-self` / `gate-derivation` / `statute` / blast-radius / size / dismissed-findings /
> cross-repo), and a negotiation that hits the round cap or a mandate conflict (below) adds `non-convergence` /
> `mandate-conflict`. Pass them through verbatim.

> **No park ever times out (x30jq9n, resolving #2412 Gap 1).** The old 30-minute merge-anyway window
> (`--review-window-minutes`, #2262) is REMOVED: it raced the very review it was waiting for — observed
> 2026-07-10, PR #396 merged mid-negotiation at its round-1 head while mandatory-lens fixes were still being
> written. A parked PR now rests parked until a verdict label (`review:accepted`/`review:changes`) arrives. A
> genuinely stuck park is the OPERATOR's call: run a manual `/drain`, then use the **per-PR** relief valve
> (#2423) to push just the stuck PR through.
>
> **PREFERRED — the per-PR form `--no-review-escalation=<pr#>`** (repeatable, comma-separated:
> `--no-review-escalation=396,401`). It waives ONLY the named PR's agent-reviewable `review:pending` park to a
> merge; the escalation rubric stays **LIVE for every other candidate in the pass**, so a fresh PR with no
> `review:*` label yet — even a gate-self diff — is still scored and parked normally. The named PR is scored too:
> the override still **refuses `review:human`** (a gate-self/statute edit — human-only, #2285) and
> **`review:changes`** (the reviewer actively rejected the diff). This is the relief valve to reach for.
>
> **DEPRECATED — the bare, PASS-WIDE form `--no-review-escalation`** (no `=<pr#>`). It turns the escalation
> rubric off for **EVERY candidate in that pass**, so a fresh PR with no `review:*` label yet (even a gate-self
> diff) would merge unscored — a strictly wider unreviewed-merge window than the per-PR form. It still works and
> still refuses `review:human`/`review:changes`, but the drain now prints a loud deprecation warning pointing at
> the per-PR form. If you must use it, scope the pass (`--this-repo`, a narrow `--label`) and confirm with
> `--dry-run` that the plan is only the stuck PR first. Landing unreviewed code is never the drain's failure mode.

- **`gate-self` (`humanRequired: true`) → `{ mode: converge, autoLand: false }`.** The diff edits the **auto-review
  trust chain itself** (`we:scripts/lib/review-escalation.mjs` or `we:scripts/merge-ai-prs.mjs`) — the code that
  decides whether the gate fires and what clears it. This is a **sensitivity** park, not a deadlock, so an agent
  reviewer/editor is still useful: **run the SAME panel↔editor negotiation loop as the agent-reviewable path
  below** to actually fix any clear bug (an advisory FIX, not just an advisory comment). The one difference is
  `autoLand: false` — on a `land` outcome the drain **does NOT apply `review:accepted`**; it keeps `review:human`,
  posts the converged diff's findings + verdict table as a PR comment clearly marked `🤖 advisory AI review /
  fix (non-clearing)` **and flags that the diff now carries agent-authored trust-chain edits the human must
  scrutinize**, and surfaces the PR to the operator, who clears it with [`/review <PR>`](../review/SKILL.md). This
  PR is **never agent-clearable** — an agent policing a change to its own leash is the conflict of interest the
  gate exists for; the panel may improve the diff but only a human merges it (the #2285 invariant, enforced by
  `autoLand: false`).

  > **Single PAT ⇒ you cannot verify a gate-self clearance by actor (#2416).** The whole constellation runs on
  > ONE personal access token, so EVERY `review:accepted` label + `"cleared by the operator"` comment is
  > applied as `chalbert` whether a human ran [`/review`](../review/SKILL.md) or an automation (a
  > closing-session / batch flow) did. The GitHub actor therefore proves nothing — this is exactly the #2416
  > gap ("honor `review:accepted` only when a human applied it"). The closed-set-of-callers guarantee now
  > lives in `we:scripts/lib/review-skill-guard.mjs`'s `check:standards` gate (doc instructions, #2882; raw
  > code paths, #2416) — it is NOT actor provenance, which stays permanently unsolvable under one shared
  > token. **Operational rule when draining:** if a `gate-self`
  > PR arrives already carrying `review:accepted`, do NOT treat the label/comment as proof of human clearance —
  > surface it and get the operator to confirm they personally cleared it before letting it land. Do not,
  > however, treat "shows as `chalbert`" as suspicious on its own — it is the only actor there is.
- **sensitivity park (`humanRequired: false`) → `{ mode: converge, autoLand: true }` — agent-reviewable.** Escalated (blast-radius / size / dismissed-findings / sampling)
  but independent of the producer. **v3 (#2310) runs a bounded MULTI-MANDATE PANEL↔editor NEGOTIATION LOOP** —
  v2's single reviewer fans out into a panel of distinct mandated reviewers (`PANEL_LENSES`: `correctness` /
  `security` / `simplicity` / `standards-conformance`, the `/code-review` lenses), driven up to
  `NEGOTIATION_ROUND_CAP` (5) rounds of propose → critique → revise, in-session, before escalating:
  1. **Round 1 panel review.** Get the diff on the NET basis vs CURRENT main — `computeNetDiffText({ exec, rev:
     v.headRef, fetchExtraRefs: [v.headRef] })` (`we:scripts/merge-ai-prs.mjs`, #2450): the two-tree
     `git diff <forkpoint> <head>` TEXT resolved off the SAME #2373/#2404 basis the escalation SCORE uses, so the
     diff the panel reviews and the score can't drift. This is **not** `gh pr diff <num>`'s three-dot merge-base
     diff, which still lists a sibling-lane file that has since landed on main as if this PR added it — the
     phantom scope-creep that burns rounds (#2450). If it returns `scored:false` (a foreign clone without the
     head ref, a diff failure), fall back to `gh pr diff <num> --repo <repo>`. Also `gh pr view <num> --repo
     <repo> --json title,body,files`, and take the NET changed-file list from **`computeNetDiffPaths(...)`** —
     plain paths off the same basis. NOT `computeNetDiffChangedFiles`, which is the scoring path and emits git's
     display encoding (`a.txt => b.txt` for a rename, C-quoted non-ASCII), so intersecting it with `gh`'s plain
     paths drops those entries and a rename-only PR reads as zero files. **Fan the panel out through
     `judgePanel`, NOT the `Agent` tool** (#3145) — a subagent inherits this session's
     `CLAUDE_CODE_SESSION_ID`, the identity `we:scripts/lib/review-independence.mjs` keys independence on, so
     a panel of subagents is ONE ACTOR WEARING N HATS and the independent reviewer this whole section claims
     does not exist. Build ONE payload — one juror per lens, each carrying `buildPanelMandate({ lens,
     netChangedFiles, goal, round })` verbatim (the net changed-file list is passed as GROUND TRUTH so a
     reviewer will NOT flag a diff-side file outside that set as scope creep, #2450; same diff-only,
     no-checkout isolation as v2 (#2336), each juror judging only its own lens and blind to the others) —
     then shell the panel shim, which spawns one **tool-free headless `claude -p` per seat with its own
     derived `--session-id`** and refuses a roster whose ids are not pairwise distinct before anything runs:

     ```bash
     # $DIFF ← computeNetDiffText's TEXT on disk; $NET ← computeNetDiffPaths as a JSON array on disk.
     # Write the payload with node, NEVER by interpolating the diff into a shell string — a diff routinely
     # contains `$(…)` and backticks, which the shell would evaluate before Node ever saw the JSON.
     node --input-type=module -e '
       import { writeFileSync, readFileSync } from "node:fs";
       import { PANEL_LENSES, buildPanelMandate } from "./scripts/lib/review-core.mjs";
       const round = Number(process.env.ROUND);
       writeFileSync(process.env.PAYLOAD, JSON.stringify({
         subject: "pr-diff", subjectNoun: "diff", round,
         materialFile: process.env.DIFF,
         jurors: PANEL_LENSES.map((lens) => ({
           id: `${lens}#1`, lens,
           mandate: buildPanelMandate({
             lens, round, goal: process.env.GOAL ?? "",
             netChangedFiles: JSON.parse(readFileSync(process.env.NET, "utf8")),
           }),
         })),
       }));'
     node skills-src/jury/panel-fanout.mjs --payload-file="$PAYLOAD" \
       --depth=0 --max-depth=2 --max-total-budget-usd=8 --run-id="drain-<pr>-r<round>"
     ```

     Each seat comes back as `{ id, lens, sessionId, ok, findings, notes, error, costUsd }`. A seat with
     `ok: false` is a lens that **DID NOT RUN** — it never reads as accept, and a mandatory lens that did not
     run degrades the round (same rule as everywhere else). Shape each seat's findings with
     `normalizeFindings()`, reduce each to its own verdict with `deriveVerdict()` — you now have one
     `{ lens: verdict }` map (`lensVerdicts`) and, via `buildPanelFindings()`, one lens-tagged findings list.

     > **What a tool-free juror cannot do — stated, not buried.** `judgePanel` seats are always `--tools ''`
     > (it forwards no `allowedTools` — RULING in `we:scripts/lib/judge-panel.mjs`, #3158: panel seats stay
     > tool-free rather than pay the N-seats-need-N-lanes cost of a tool-bearing panel). A tool-free juror
     > cannot literally break a line or clone the repo, so all three clauses that demanded it —
     > `MUTATION_PROBE_RULE`, `GUARANTEE_NEEDS_A_TEST_RULE` (the same demand, narrowed to prose guarantees),
     > and the mandate's isolation
     > clause — now SELF-SCOPE on that fact (same pattern as the mutation probe's own lens-scoping): a tool-free
     > seat is told to name the test it BELIEVES would redden and say plainly it ran nothing, never to
     > describe a break or a clone it did not perform. `panel-fanout` separately tells each juror it has no
     > tools and must not claim to have opened anything, so a seat reports honestly rather than fabricating —
     > it fails safe. The panel is still weaker at exactly the class of finding a real mutation run catches;
     > that is a trade this change made deliberately in exchange for jurors that are actually distinct
     > actors, now stated honestly to the juror itself rather than left as an unrunnable instruction. Ruled in
     > [#3158](../../backlog/3158-tool-free-panel-jurors-cannot-run-the-mutation-probe-their-m.md).
  2. **Reduce the panel to one verdict** — `derivePanelVerdict({ lensVerdicts, humanRequired, conflict,
     mandatoryLenses, findings: buildPanelFindings(lensFindings) })`. **Pass `findings` — the whole panel's list
     from step 1 — always** (#2823 round-3 finding 1): the prevention scan is derived from the FINDINGS (immune to
     per-lens verdict flattening), so dropping the list silently reinstates the advisory-prevention leak on the ONE
     path the drain actually runs. `findings` is a REQUIRED argument — an omitting call now throws rather than
     defaulting to `[]`. `MANDATORY_LENSES` (`correctness`, `security` — real invariants with no other gate)
     must **unanimously accept** to land; `ADVISORY_LENSES` (`simplicity`, `standards-conformance`,
     `claim-accuracy` — `standards-conformance` already has a deterministic backstop in `check:standards`,
     #2199; `simplicity` is genuine stylistic judgment; `claim-accuracy` is advisory PENDING ITS OWN RULING,
     #3035, not on merit) are always surfaced but never block on their own. (This line read
     "(`simplicity`, `standards-conformance`)" until #3035 added the third member — it was a two-member list
     stating a set that had grown to three.) `conflict` is a **judgment
     call, not a mechanical one** (#51): read the mandatory lenses' findings — if they are a genuine
     MUTUALLY-EXCLUSIVE tradeoff (e.g. security's fix directly undoes simplicity's, or vice versa within the
     mandatory pair), pass `conflict: true`; a merely-unlucky pair of independent "changes" verdicts is not a
     conflict, it is ordinary non-convergence and follows the round-cap path below.
  3. **Decide what's next** — `deriveNegotiationOutcome({ verdict, round, roundCap })` on the REDUCED panel
     verdict from step 2 (pure; the round-cap decision is deterministic, not a judgment call):
     - **`land`** (verdict `accept` — every mandatory lens unanimously accepted) → **gate on the disposition's
       `autoLand`.** `autoLand: true` (a plain sensitivity park, incl. the engine-tier lander) → **run the
       INDEPENDENT HARDENED VALIDATOR (#2439) before landing.** Run the validator JURY through the SAME
       `judgePanel` shim as step 1 — **never the `Agent` tool** (#3145). This is the site where the subagent
       fan-out was most wrong: the jury's entire claim is that it *"took NO part in the negotiation"*, and a
       subagent jury shares the negotiating session's `CLAUDE_CODE_SESSION_ID`, so by this repo's own
       independence test it took part in all of it. Same payload shape, one juror per `PANEL_LENSES` lens,
       each seeded with `buildValidatorMandate({ lens })` instead of `buildPanelMandate(...)`, and
       `materialFile` pointed at the FINAL diff. **Give it a DIFFERENT `--run-id` from every negotiation
       round** (e.g. `drain-<pr>-validator`): a seat's session id is derived from `runId` + `lens#slot`, so
       reusing the round's run id would mint the validator the very same actor id as the panel juror it is
       supposed to be independent of. The jury is NEVER shown the peers' findings, dismissals, or reasoning —
       only the FINAL diff and the tests it touches, which is exactly what a fresh payload carrying only
       `buildValidatorMandate` + the diff gives it. Reduce its per-lens verdicts with `derivePanelVerdict({ lensVerdicts: validatorVerdicts,
       mandatoryLenses, findings: buildPanelFindings(validatorFindings) })` → `validatorVerdict` — again passing the
       validator jury's OWN `findings` (required, same reason as step 2: the validator can re-report a resolved finding
       that still names an uncaptured guard, which only the findings scan sees) — then
       `combineValidatedVerdict({ panelVerdict, validatorVerdict })` and re-run `deriveNegotiationOutcome`
       on the combined verdict: **combined `land`** (BOTH the panel and the independent validator accepted) →
       **first run the BAR-UN-BLOCKED PREVENTION CHECK, THEN** apply `redteam:accepted` THEN
       `review:accepted` (`gh pr edit <num> --repo <repo> --add-label redteam:accepted --add-label
       review:accepted`) and **re-run the drain** — the non-author-accepts invariant now holds INDEPENDENTLY;
       **combined `continue`** (the validator wants changes the panel missed) → step 4,
       another editor round; **combined `escalate`** (validator `needs-human`) → the `escalate` path below.
       `autoLand: false` (`gate-self`) → **do NOT apply
       `review:accepted`**: the panel converged and fixed the diff, but a human must clear a trust-chain edit.
       Keep `review:human`, post the converged findings + `renderPanelVerdictTable(...)` as the `🤖 advisory AI
       review / fix (non-clearing)` comment, and surface the PR to the operator via
       `renderReviewNotice({ event: 'escalated', pr, repo, verdict, disposition, reasons, findings })` (#2433) —
       pass `findings = buildPanelFindings(lensFindings)` (the whole panel's list) so the notice's #2823 prevention
       summary renders the guards owed before accept — rather than hand-typing the in-chat notice; the fix rode the
       PR branch, the clearance did not.

       > **THE BAR-UN-BLOCKED PREVENTION CHECK — the compensating control for `PREVENTION_IMPACT_BAR`.** The
       > impact bar (`we:scripts/lib/jury-core.mjs`) lets a finding whose named prevention guard is neither
       > captured nor filed ride a CLEAN `accept`, as long as the reviewer declared the finding cheap
       > (`impactIfUnfixed` below the bar). That is a scaling of the gate rather than a silent loosening ONLY if
       > the declared impact and the still-owed guard reach a human on the path it opens — and the path it opens
       > is exactly THIS one, the auto-land. `renderReviewNotice` fires only on `escalated`, which an
       > un-blocked finding never reaches; a rendering function nobody calls is not a control.
       >
       > So, on the **combined `land` / `autoLand: true`** branch, BEFORE applying the accept labels: take
       > `findings = buildPanelFindings(lensFindings)` merged with the validator jury's
       > `buildPanelFindings(validatorFindings)`, and test each for **`hasUncapturedPrevention(f) === true` AND
       > `blocksAcceptance(f) === false`** — a guard the BAR un-blocked. If ANY finding matches, you **MUST** post
       > `renderPanelComment({ findings, verdict, disposition, lensVerdicts })` as a PR comment
       > (`node scripts/review-core-cli.mjs comment --file=<result.json>` → `gh pr comment <num> --repo <repo>
       > --body-file -`) first, so the impact each finding declared and the guard it still owes are on the record
       > where someone can dispute them before the merge. Only then apply the labels.
       >
       > If NO finding matches — a clean accept with nothing the bar un-blocked — post **nothing**. The emission is
       > deliberately conditional: making every land noisy would train the operator to skim past the one comment
       > that carries real prevention debt. The guarantee this control makes is therefore narrow and exact: **no
       > land that the bar un-blocked happens silently.** Say it that way anywhere you restate it — a claim that
       > every finding is posted on every land would be false.
     - **`escalate`** (verdict `needs-human` — a genuine mandate `conflict` or the global `humanRequired`
       conflict-of-interest flag — OR `changes` with `round >= roundCap`) → this is the `deriveReviewDisposition`
       DEADLOCK case (`mandate-conflict` / `non-convergence` → `{ mode: human }`): the loop already ran and could
       not agree, so **hand it to the human — do NOT re-enter convergence.** Apply `review:human` (never
       `review:changes`/author-bounce — that path is retired by v2) and post BOTH the round-by-round findings
       history AND `renderPanelVerdictTable({ lensVerdicts, mandatoryLenses })` (the per-lens
       mandatory/advisory/verdict breakdown) as a PR comment, so the human sees exactly which lens(es)
       disagreed and whether via non-convergence or a genuine mandate conflict. Then report it the same way as
       the gate-self case, via `renderReviewNotice({ event: 'escalated', pr, repo, verdict, disposition,
       reasons, findings })` (#2433) — again passing `findings = buildPanelFindings(lensFindings)` so a
       `prevention-outstanding` escalation names the guards owed in the same line. This is the **only** escalation
       shape agents produce; the operator clears it with
       [`/review <PR>`](../review/SKILL.md).
     - **`continue`** (verdict `changes`, `round < roundCap`) → step 4.
  4. **Editor round.** Spawn a **fresh-context editor subagent** seeded with `buildEditorMandate({ findings,
     round, roundCap })`, where `findings` is `buildPanelFindings(lensFindings)` — the WHOLE panel's
     lens-tagged findings merged into one list (not just one lens) — so the editor sees every mandate's
     concerns in one pass. It does its writing in an **isolated throwaway clone of the PR branch** (never the
     drain's shared checkout — the #2336 constraint applies to the editor too), then **pushes back to the SAME
     PR branch** (the PR updates in place; no new PR opens). It must fix each finding or explicitly dismiss it
     with a stated reason (never drop one silently) — a dismissal of a MANDATORY lens's finding is exactly what
     the next round's reviewer for that lens re-checks.

     > **The editor is the ONE spawn here that stays a subagent, and that is deliberate** (#3145). It
     > *authors*; independence is a property of the **judge**, and `judgePanel` has no editor to be — its
     > seats are tool-free and answer a forced findings schema. What the invariant needs is that the editor is
     > not one of the actors that judged it, and after this change that holds by construction: every juror is
     > a headless process with its own session id, and the editor carries the drain's. Giving the editor its
     > own tool-bearing headless spawn is a real but separate change —
     > [#xl5jroq](../../backlog/xl5jroq-give-the-revision-round-editor-its-own-tool-bearing-headless.md).
  5. **Next round.** Re-fetch the now-updated diff and re-run the panel shim with the round's new
     `buildPanelMandate()` payload — **and a `--run-id` carrying the new round number** (`drain-<pr>-r<round>`),
     so round N+1's seats are different actors from round N's rather than the same derived ids re-judging their
     own prior verdicts. No memory of the prior round travels: a headless juror has none to begin with, which
     is the fresh-context property the old wording asked a subagent for and could not get. → back to step 2
     with `round + 1`.

  The pushed revision re-runs the PR's required `test` check — a round's editor commit is a normal PR update,
  not a merge, so a red check simply blocks that round's land/continue decision until it goes green, same as
  any other PR.

> **The label must exist.** `review:human` is provisioned like the other `review:*` labels (see #2262/#2279);
> if it is missing, `gh pr edit --add-label review:human` silently no-ops. Ensure it exists once:
> `gh label create review:human --description "conflict-of-interest: gate-self edit, a human must review" --color B60205 --force`.

## Exit codes (surface these)

- `0` = swept clean (merged 0+ qualifying PRs, none failed) or a dry-run.
- `2` = at least one merge attempt FAILED (surfaced per PR). A deferred PR (blocker unlanded) is not a failure.

## Legacy `queued.json` fallback

The old `queued.json` / `scripts/lane-drain.mjs` couple-drain is **retired as the primary path** — new producer
output opens a `ready-to-merge` PR (above), never a `queued.json`-only couple. `lane-drain.mjs` stays only as a
no-op fallback for any **legacy** couple still sitting in `queued.json` (`node scripts/lane-drain.mjs drain
--dry-run` shows it; it is a clean no-op when the queue is empty). Do not reach for it unless a dry-run shows a
stranded legacy couple.

## Guardrails

- **Re-uses the shared transport, never re-implements it:** PRs land via the same self-approved `gh pr merge`
  (0 required reviewers + the required `test` check) `/pr` uses — never `--admin`, never a raw `git merge`/`git
  push` of `main`.
- **Never force-updates a PR branch** — a `BEHIND` PR (needs rebase) is left for its author / a later pass,
  never force-rebased by the sweep.
- **Label-scoped:** with `--label=ready-to-merge` the sweep only touches PRs a producer certified (#2196).
  Bare (`/merge`, no label) it also sweeps orphan AI PRs on the every-commit-AI gate — see [`/merge`](../merge/SKILL.md).
- **Rebase-drop can livelock on an overlapping batch — `--no-rebase-drop` breaks it.** When several
  `ready-to-merge` PRs in the SAME batch overlap on the same files (e.g. multiple PRs each touching
  `scripts/merge-ai-prs.mjs` / `scripts/readiness/lane-manifest.mjs`), every pass rebase-drops whichever tips
  read as BEHIND/CONFLICTING, which pushes a NEW commit → resets each tip's `test` check to pending → the tip
  is behind/pending again at the next merge attempt → rebuilt again. The check-reset outruns the poll, so no
  tip stays green long enough to land. Observed 2026-07-10: **12 `--watch` passes, 0 merges, `main` never
  advanced**, even though tips individually reached CLEAN+green between passes. **Remedy:** stop the churn and
  run one pass with `--no-rebase-drop` — it skips the commit-fabricating rebuild and merges every PR GitHub
  already reports CLEAN + green directly (GitHub's merge-commit strategy handles a not-behind mergeable PR).
  This landed 3 of 4 overlapping PRs in a single pass. A genuinely BEHIND straggler is then left as a skip;
  land it on a follow-up pass (a normal rebase-drop pass rebuilds the LAST one cleanly, no siblings left to
  race). Relates to #2391 (drain dual-lock / whole-process critical section).
