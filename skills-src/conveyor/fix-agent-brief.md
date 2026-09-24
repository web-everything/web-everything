# Conveyor fix-agent brief (template) — repair a `review:changes` bounce IN ITS OWN LANE, then hand back for re-review (#2630)

> **This is a TEMPLATE, not a runnable skill.** The `/conveyor` skill (#2613) instantiates it when a
> conveyor-launched PR is bounced `review:changes` (a human ran `/review` and requested changes). It fills the
> `{{PLACEHOLDERS}}` below and passes the result as the prompt for **one background fix agent** spawned into
> that PR's lane. One agent = one bounced PR = one repair = one re-push. The agent does the JUDGMENT work (apply
> the reviewer's finding); every script-decidable step around it is a script it shells, per
> [we:docs/agent/platform-decisions.md#deterministic-core-thin-judgment](../../../docs/agent/platform-decisions.md#deterministic-core-thin-judgment)
> (#2607).

> **Why this exists.** Before #2630, a `review:changes` bounce only PARKED (pr-watch exit 2): the delivery agent
> that built the PR had already exited (one agent = one item = one PR), so nothing repaired it — a human had to
> take over via `/finish` or by hand. This brief is the **auto** path: the conveyor re-dispatches a fix agent
> into the bounced PR's lane to apply the finding, re-push, and re-arm review. The **human `/finish` path uses
> this SAME procedure** (see *Manual take-over* at the end) — the auto and manual repairs are one procedure, not
> two.

> **(no backlog item) case (multi-repo slice 6).** Most bounced PRs deliver a backlog item, but some don't (a
> hand-opened PR, an externally-branched fix). For those, `{{ITEM_NUM}}` is filled **blank** and
> `{{ATTRIBUTION}}` reads `PR #{{PR_NUM}}` instead of `<REPO-TAG> #{{ITEM_NUM}}` — every step below still works
> unchanged (this brief never resolves, claims, or otherwise touches a backlog card at any point; the repair is
> always scoped to the PR's own diff, item or no item).

> **ADVISORY-FIX MODE (#xkmu3gv) — a `needs-human` PR carrying `advisory:changes`, no `review:changes`.** The
> reconcile pass (`we:scripts/conveyor/reconcile-core.mjs`) now also dispatches this brief at a `review:human`
> PR that carries `advisory:changes` but no `review:changes` — an admitted finding from
> `we:scripts/operations/review-pr.mjs`'s automatic `advise` step, which runs BEFORE the human review ceremony
> and never touches any `review:*` label. **Confirm which mode you are in before step 2**:
> `gh pr view {{PR_NUM}} --json labels --repo {{REPO}}`. If `review:changes` is present, this is the ORDINARY
> (or conflict) mode below — proceed as written. If it is **absent** and `advisory:changes` is present, you are
> in ADVISORY-FIX MODE: skip straight to *2a. Read the advisory finding (advisory-fix mode)* below instead of
> step 2, and at hand-back use *7a. Advisory-fix hand-back* instead of step 7. Every other step (3–6, 8) is
> unchanged — same reproduce/fix/converge/evidence discipline — except the fence is the advisory finding alone,
> never a fresh `review:human` gate concern.

## Fill these before spawning

| Placeholder | What the conveyor fills it with |
|---|---|
| `{{ITEM_NUM}}` | the backlog item number the bounced PR delivers — e.g. `2608`; **blank** for a PR that names no backlog item at all (multi-repo slice 6 — `{{ATTRIBUTION}}` is `PR #{{PR_NUM}}` in that case, never a fabricated number) |
| `{{PR_NUM}}` | the bounced PR's number (the one carrying `review:changes`) — e.g. `701` |
| `{{LANE_REF}}` | the PR's head ref — `lane/{{ITEM_NUM}}-<slug>` for an item-carrying PR, any ref shape for an item-less one (`gh pr view {{PR_NUM}} --json headRefName`) |
| `{{LANE}}` | a FREE lane id the conveyor assigned this repair (a fresh clone; the repair is reconstituted from `{{LANE_REF}}`, not the original lease) |
| `{{SESSION_SLUG}}` | a stable per-repair session slug, e.g. `fix-{{PR_NUM}}` (ties `acquire`↔`release`) |
| `{{SCOPE}}` | the item's `scope:` frontmatter, repo-qualified & comma-joined (same as the build's scope) — for an item-less PR, its own already-changed files under its repo's prefix instead |
| `{{REPO}}` | the target repo's gh slug (e.g. `chalbert/web-everything`) — every `--repo=` flag below |
| `{{LANE_REPO}}` | what `lane-pool.mjs --repo=` itself expects — `.` for WE, an absolute checkout path for a sibling repo |
| `{{GATE_COMMAND}}` | the target repo's own gate command (`gateFor(...)`, `we:scripts/lib/repo-profile.mjs`) |
| `{{WE_ROOT}}` | the absolute WE checkout that owns every tool this brief runs (`rearm-review.mjs`, `stand-down.mjs`, …) |
| `{{ATTRIBUTION}}` | the commit-title reference — `WE #{{ITEM_NUM}}`-shaped for WE today, `PR #{{PR_NUM}}` for an item-less fix |

> **`{{LIKE_THIS}}`** are **conveyor-injected** (the table above). **`<like-this>`** are **agent-runtime values**
> you produce as you work (the reviewer's finding you read off the PR, the `<msgfile>` you write). Do not expect
> the conveyor to fill a `<...>`; that's your job at the moment it's used.

---

## Your job (one sentence)

Reconstitute the bounced PR's work in a lane clone, **apply the reviewer's requested change** (repair only the
broken part — reuse, don't rebuild), get the gate green, **re-push HEAD to the same `lane/*` ref**, then
**re-arm the review** (`review:changes → review:pending`) and **EXIT WITHOUT MERGING**. You **NEVER** self-clear
the human review label — the human (or the drain's AI-review convergence pass) re-verdicts.

## The arc — one command per transition

### 0. Report `started` — BEFORE anything else (#3436)

The one durable trace that a repair of PR #{{PR_NUM}} was ever dispatched, written before step 1 can fail for
any reason — a lane-pool outage, a crash, a refused effect. Without this a session that dies here is
indistinguishable from one never dispatched at all — no `claude logs` archaeology needed to tell them apart
(`we:backlog/3436-*.md`). A script, not a step to remember under stress — the same reasoning `stand-down.mjs`
already applies to a fixer's own escalation marker.

```bash
node "{{WE_ROOT}}/scripts/operations/completion-cli.mjs" report --repo={{REPO}} --session={{SESSION_SLUG}} --kind=fix --pr={{PR_NUM}} --item={{ITEM_NUM}} --status=started
```

### 1. Reconstitute the bounced PR's work in a lane clone (reuse the ref — never rebuild from scratch)

The work is intact on the `{{LANE_REF}}` ref (the pushed PR head). Acquire a free lane reset **to that ref**
(not to `origin/main`), so your clone opens at the exact HEAD the reviewer saw:

```bash
export LANE_SESSION={{SESSION_SLUG}}
LANE=$(node "{{WE_ROOT}}/scripts/lane-pool.mjs" acquire --repo={{LANE_REPO}} --lane={{LANE}} --purpose=conveyor-fix \
  --session={{SESSION_SLUG}} --scope={{SCOPE}} --base={{LANE_REF}}) && cd "$LANE"
```

- `--base={{LANE_REF}}` lands the clone on the pushed lane tip (via `checkout -B main <ref>`), so you **reuse
  the ~done work** — you are repairing a diff, not redoing the item. If `--base` fails to resolve (the ref was
  deleted / the PR was force-closed), report the completion record (`--status=done --outcome=not-applicable`)
  and stop and report `#{{ITEM_NUM}} → fix not-applicable (lane ref gone)`:
  ```bash
  node "{{WE_ROOT}}/scripts/operations/completion-cli.mjs" report --repo={{REPO}} --session={{SESSION_SLUG}} --status=done --outcome=not-applicable
  ```
- **`cd "$LANE"` just left WE's own checkout.** `{{LANE_REF}}` can belong to any constellation repo, so from
  here on your cwd may hold no `scripts/` directory at all — every remaining tool call in this brief is
  qualified with `{{WE_ROOT}}` for exactly that reason. Never drop the `{{WE_ROOT}}/` qualifier for a bare
  relative path.
- Do **NOT** re-`claim` the item — it is already `active` from the build; a re-claim would race. The repair is
  a diff on an existing PR, not a fresh item pickup.

### 2. Read the reviewer's finding (the change to apply)

The `/review` changes-verdict posts a durable PR comment (header `🔁 human review — changes requested` or
`🔁 review — changes requested`) summarizing what to fix. Read it — and the escalation block in the PR body:

```bash
gh pr view {{PR_NUM}} --json title,body,comments --repo {{REPO}}
```

Take the **latest** changes-requested comment as the authoritative ask.

**Reproduce it before you touch any code.** Run or write a test that FAILS for the exact reason the reviewer
named, and show it red. Where the finding is observable on a real surface — a CLI dry-run, a read-only query, a
page render — probe that surface too and show the SAME failure there, not only in the test. Trim both outputs;
you post them as evidence at step 6, alongside the after-fix run from step 4. **If you genuinely cannot
reproduce the finding** — it does not repro on this HEAD, or the described behavior is not occurring — say so
explicitly, with the reason, in that same evidence comment and in your one-line return (step 9). Never claim the
fix works without having reproduced it, or explicitly recorded why you could not.

If the finding is ambiguous or needs a
judgment you cannot safely make, do **NOT** guess. **Record the stand-down on the PR first**, then leave the PR
`review:changes` (do **not** re-arm) and RETURN `#{{ITEM_NUM}} → fix escalated (finding needs human judgment)`:

```bash
node "{{WE_ROOT}}/scripts/conveyor/stand-down.mjs" {{PR_NUM}} --repo={{REPO}} --reason=needs-judgment \
  --detail="<one line — what you could not decide>"
node "{{WE_ROOT}}/scripts/operations/completion-cli.mjs" report --repo={{REPO}} --session={{SESSION_SLUG}} --status=done --outcome=escalated-needs-judgment
```

A human handles it via `/finish`.

> **Why a script and not just the RETURN line (#3296).** Stopping to ask is the *right* call — but before this
> step existed it wrote **nothing durable**: the PR kept `review:changes`, no comment was posted, and your
> one-line return went to a calling session that then exited. On the PR itself, *"a fixer proved the fix wrong
> and stood down"* was byte-identical to *"a fixer died"* — so the reconcile pass
> (`we:scripts/conveyor/reconcile-core.mjs`) re-dispatched the refusal forever, re-asking a question nobody was
> there to answer. The marker is what tells the two apart. It changes **no label** and re-arms nothing; it is
> terminal for the automatic loop and cleared by a **person**.

### 2a. Read the advisory finding (advisory-fix mode, #xkmu3gv — skip if you are NOT in this mode)

There is no `review:changes` comment on this population — the finding is the automatic advisory-panel comment
instead (leading line `⚠️ THIS IS AN ADVISORY REVIEW, NOT A RECORDED VERDICT.`):

```bash
gh pr view {{PR_NUM}} --json title,body,comments --repo {{REPO}}
```

Take the **latest** such comment as the authoritative ask — read its findings table and its
`**Advisory outcome:** \`changes\`` line. Everything else in step 2 above still applies unchanged: reproduce the
finding red before you touch code, and if it is ambiguous or needs judgment you cannot safely make, **stand
down** exactly as step 2 says (`stand-down.mjs {{PR_NUM}} --reason=needs-judgment`) — this population is never
exempt from that escalation path. **Do NOT** treat this comment as a human-ceremony bounce: it explicitly is
not one (its own text says so, twice), so nothing here ever touches `review:human`, `review:pending`, or
`review:accepted` — this repair's only output is the fix itself plus the durable marker at step 7a.

### 3. Apply the fix — repair ONLY the reviewer's finding

Make the smallest change that addresses the finding, in `$LANE`, on the lane's **current branch** (its local
`main` — do **NOT** `git checkout -b`; the single-branch hook blocks branch creation even in a lane clone).
Keep scope tight: the repair's files should stay within `{{SCOPE}}`. Do not fold in unrelated work, and do not
weaken or delete a test to sidestep the finding.

**Change a tracked file's content (source, a backlog card, docs) with the Edit/Write tool — never a `Bash`
rewrite** (a `python`/`node`/`sed` heredoc or one-liner that reads the file and overwrites it). Even inside
your own lane clone, where Bash is fully permitted, a Bash command whose EFFECT is to rewrite a git-tracked
file can be denied by Claude Code's own auto-mode permission classifier as `[Modify Shared Resources]`, with
nobody watching this session to answer it — confirmed live on PR #2518 (`fix-2518`, 2026-09-23): a `python3`
heredoc rewriting `backlog/3945-*.md` was denied exactly this way, and the fix agent then (wrongly) treated
the denial as a judgment call rather than the tooling failure it actually was. Edit/Write is the sanctioned,
already-allow-listed surface for this — reach for it first (see *If applying the fix is denied* below for what
to do if it, or anything else, gets refused).

**If applying an otherwise-CLEAR fix is denied by a permission or tool-use guard, that is INFRASTRUCTURE
FRICTION, not a judgment call — do NOT stand down.** The reviewer's finding still says exactly what to do; only
the *mechanism* to do it failed. Report it as `blocked-on-infra` instead, so the reconciler retries this PR
once the friction has had time to clear (`we:scripts/conveyor/reconcile-core.mjs#INFRA_RETRY_COOLOFF_MS`) —
never `stand-down.mjs`, which is terminal and reserved for a genuine judgment call (see step 2):

```bash
node "{{WE_ROOT}}/scripts/operations/completion-cli.mjs" report --repo={{REPO}} --session={{SESSION_SLUG}} --status=done --outcome=blocked-on-infra
```

Then report `#{{ITEM_NUM}} → blocked-on-infra (tool/permission denial applying an otherwise-clear fix on PR
#{{PR_NUM}})` and exit — do not retry the same denied action yourself in a loop, and do not fall back to a
Bash rewrite to work around the denial (that is the exact shape that got denied).

**Resolve against this PR's OWN base branch, never an assumed `main`** (#3383). Most PRs base off `main`, but a
**stacked** PR (built on another still-open lane/PR — `#poc-branch-declared-delivery-mode` clause 5) does not, and
merging `main` into a PR based on something else would pull in the wrong history entirely. Confirm the real base
LIVE, every time — never trust a value you were told earlier in this dispatch, since GitHub RETARGETS a stacked
PR to `main` automatically the moment its base branch merges and is deleted (the normal, expected path):

```bash
gh pr view {{PR_NUM}} --json baseRefName --repo {{REPO}} --jq .baseRefName
```

If `origin/main` advanced under the lane and a **conflict**
blocks the gate, resolve it the `/finish` way (regenerate derived artifacts, take-main for coordination JSON) —
or, if it is a genuine same-line code overlap you cannot safely resolve, **record the stand-down on the PR
first** (`#xu2krte` — this call was missing here until then; only the *manual* `/finish` path posted it, so an
auto-dispatched escalation was silently re-dispatched at the same unresolved conflict next tick, bounded only
by the 5-attempt rearm cap instead of this terminal exit), THEN report the completion record and stop. (This is
written against `main` because that is the common case — see the STACKED-BASE MODE note below for a PR whose own
base is something else; the same reproduce/resolve/escalate discipline applies either way, just against a
different ref.)

```bash
node "{{WE_ROOT}}/scripts/conveyor/stand-down.mjs" {{PR_NUM}} --repo={{REPO}} --reason=conflict \
  --detail="<one line — what made the overlap unsafe to resolve automatically>"
node "{{WE_ROOT}}/scripts/operations/completion-cli.mjs" report --repo={{REPO}} --session={{SESSION_SLUG}} --status=done --outcome=escalated-conflict
```

Then report `#{{ITEM_NUM}} → fix escalated (conflict with main)`.

> **Dispatched onto a `review:human` PR for a review-human statute amendment (`#xu2krte` Fork 2,
> `we:scripts/conveyor/parked-pr-conflict-watch.mjs`).** The finding itself already says this, but it is worth
> repeating here because the scope discipline is stricter than usual: **resolve the conflict ONLY.** `main` was
> already verified (by diff-hunk comparison, not guessed) to have NOT independently touched the same region this
> PR amends, so keep this PR's own intended change and reconcile it against whatever ELSE landed on `main` —
> make **no other edit**, and do **not** touch any `review:*` label. `review:human` was never cleared or
> downgraded to get you here and stays exactly as it was: a human still reviews the FINAL merged result through
> the normal review flow before this can land. **Post a comment on the PR showing the conflicting hunk BEFORE
> your resolution and the resolved hunk AFTER**, as before/after evidence of exactly what you changed — this is
> in addition to, not instead of, the ordinary reproduce/fix/verify evidence step 1 above already asks for.
> **At hand-back (step 7), use `rearm-review.mjs {{PR_NUM}} --repo={{REPO}} --round=conflict`** (#xkmu3gv) — the
> SAME `review:changes → review:pending` swap, but it posts the mechanical-round marker so this repair counts
> against its own, smaller `CONFLICT_FIX_ROUND_CAP` (3) instead of the ordinary 5-round negotiation cap; using
> the plain (no `--round=`) form here would silently spend the wrong budget.

> **STACKED-BASE MODE (#3383) — dispatched from `reconcile-core.mjs`'s STACKED-BASE CONFLICT branch onto a PR
> whose own base is NOT `main`.** You are in this mode if `gh pr view {{PR_NUM}} --json baseRefName,labels
> --repo {{REPO}}` shows a `baseRefName` other than `main` AND the PR still carries `review:accepted` (or
> whatever review label it already had) rather than `review:changes` — this PR was never bounced, unlike the
> ordinary conflict-fix population just above. It is a **stacked** PR (built on another still-open lane/PR): the
> drain will never land it regardless of label (`#poc-branch-declared-delivery-mode` clause 5, "base is not
> `<default>`"), so its conflict against that base — typically caused by a fixer pushing new commits to the base
> lane out from under it — is a purely mechanical rebase, never a reviewer-facing content conflict.
>
> **Resolve it by merging or rebasing onto the PR's OWN base ref** (the `baseRefName` you just read — never
> `main`, unless GitHub has ALREADY retargeted this PR to `main` because that base branch merged and was deleted
> in the meantime, the normal path; the live `gh pr view` read above is what tells the two apart, so always read
> it fresh rather than trusting a base named earlier in this dispatch). Resolve every conflicted hunk by reading
> BOTH sides' intent (this PR's own and whatever landed on its base since), run the gate green, and push.
> **Touch no `review:*` label of any kind** — `review:accepted` rides through this repair untouched, exactly as
> it was before the conflict appeared; there is no bounce to undo and nothing to re-arm. **Post a comment on the
> PR showing the conflicting hunk BEFORE your resolution and the resolved hunk AFTER**, the same before/after
> evidence discipline the main-base conflict-fix round above uses.
>
> **At hand-back, do NOT run `rearm-review.mjs` at all** (there is no `review:changes` to swap) — instead post
> the durable marker-only comment, which counts against the SAME `CONFLICT_FIX_ROUND_CAP` the ordinary
> conflict-fix round uses (they are the identical kind of work, just against a different ref):
>
> ```bash
> node "{{WE_ROOT}}/scripts/conveyor/conflict-fix-mark.mjs" {{PR_NUM}} --repo={{REPO}} --base-ref=<the baseRefName you resolved against> && \
>   node "{{WE_ROOT}}/scripts/operations/completion-cli.mjs" report --repo={{REPO}} --session={{SESSION_SLUG}} --status=done --outcome=re-armed
> ```
>
> If the overlap is a genuine same-line conflict you cannot safely resolve, the same stand-down escalation above
> applies unchanged (`stand-down.mjs {{PR_NUM}} --repo={{REPO}} --reason=conflict --detail=...`) — this mode
> changes only what a *successful* resolution hands back with, never the escalation path.

**Build-brief discipline applies to the repair too** (statute:
[we:docs/agent/platform-decisions.md#build-brief-discipline](../../../docs/agent/platform-decisions.md#build-brief-discipline),
#2819): if the reviewer's finding names a category ("reject X") without enumerating its shapes, name the
concrete edge cases yourself rather than the first narrow guess; cover the repair with an integration/wiring
test if the finding touches a call path, not only a unit test of the isolated piece; and never claim the repair
"closes" or "fixes" the item in your commit unless it truly does end-to-end.

### 4. Run the gate GREEN (the item's own locus gate)

```bash
{{GATE_COMMAND}}          # this repo's own gate ({{REPO}}'s package.json — gateFor(...) in scripts/lib/repo-profile.mjs)
```

If the repair also touches a WE-side file (docs, the backlog item itself, WE-side glue) — i.e. `{{SCOPE}}` names
anything outside `{{REPO}}` — additionally run `npm run check:standards` from `{{WE_ROOT}}` before re-pushing:
`{{GATE_COMMAND}}` is `{{REPO}}`'s own gate and does not check WE's cross-repo invariants. For WE itself
(`{{REPO}}` == WE), `{{GATE_COMMAND}}` already **is** `npm run test:unit && npm run check:standards`, so this is a
no-op today.

A green gate proves the **checks** pass; it does not, by itself, prove the reviewer's finding is actually fixed.
Re-run the SAME test from step 2 — it must now be green — and, where the finding had a real-surface probe,
re-run that SAME probe and confirm it now shows the fixed behavior. Keep the trimmed after-output next to the
before-output from step 2; step 6 posts both as the evidence.

A red gate is a hard stop. Record the stand-down on the PR, leave it `review:changes` (do **not** re-arm), and
RETURN `#{{ITEM_NUM}} → fix gate-red`. Do not re-push a red diff.

```bash
node "{{WE_ROOT}}/scripts/conveyor/stand-down.mjs" {{PR_NUM}} --repo={{REPO}} --reason=gate-red \
  --detail="<one line — which check stayed red>"
node "{{WE_ROOT}}/scripts/operations/completion-cli.mjs" report --repo={{REPO}} --session={{SESSION_SLUG}} --status=done --outcome=gate-red
```

Same reason as the exit in step 2 (#3296): without the durable marker the reconcile pass cannot tell your
deliberate stop from a crash, and re-dispatches a fixer at this PR forever.

### 5. Converge before handback — self-review the repair (proportionate to the change)

For anything beyond a trivial one-liner, spawn **one adversarial code-review subagent** on your repair diff and
**AWAIT its returned report as the verdict** — the same converge-before-handback discipline the delivery brief
uses ([we:skills-src/conveyor/delivery-agent-brief.md](delivery-agent-brief.md) step 6). Confirm the repair
actually addresses the reviewer's finding and introduces no new problem. Address every finding to convergence
(fix it, or dismiss it with a one-line reason). Only then re-push. A trivial, obviously-correct fix (a typo, a
pinned-count bump) may skip the subagent — but never skip re-reading the reviewer's finding to confirm you met it.

### 6. Commit + re-push HEAD to the SAME lane ref (update the existing PR in place)

Commit only the repair's files (explicit paths, never `git add -A`; one commit) on the lane's current branch,
then push HEAD to `{{LANE_REF}}` — this **updates the existing PR**, it does not open a new one (never
`gh pr create`, never `pr-land` — the PR already exists; you are pushing a new head to it):

```bash
printf '%s\n' "{{ATTRIBUTION}}: address review:changes on PR #{{PR_NUM}} — <one-line what you fixed>" "" \
  "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" > <msgfile>
git commit -F <msgfile> <explicit-paths>
git push origin HEAD:refs/heads/{{LANE_REF}}
```

Write the commit message to a file and `commit -F` it — a heredoc runs backticks (e.g. `` `scope:` ``) as a
subshell (`bad substitution`); a message file has no such footgun. Pushing to `lane/*` is allowed by the
single-branch guard; pushing to `main` is not.

**Post the before/after proof as a PR comment before re-arming.** A reviewer must be able to SEE that the fix
works, not just infer it from a green gate: post a comment carrying the trimmed red output (step 2) followed by
the trimmed green output (step 4) — or, if reproduction was genuinely impossible, the explicit statement of why
(step 2):

```bash
gh pr comment {{PR_NUM}} --repo {{REPO}} --body-file <evidence-file>
```

Do this before step 7's re-arm, so the evidence is already on the PR the moment a human (or the drain's
AI-review pass) looks at it.

### 7. Re-arm the review — hand back for re-review (NEVER self-clear the human gate)

The bounce is repaired and re-pushed; now hand it back. This is **the one label swap you may make** — and it is
a script, so you cannot route around the invariant:

```bash
node "{{WE_ROOT}}/scripts/conveyor/rearm-review.mjs" {{PR_NUM}} --repo={{REPO}} && \
  node "{{WE_ROOT}}/scripts/operations/completion-cli.mjs" report --repo={{REPO}} --session={{SESSION_SLUG}} --status=done --outcome=re-armed
```

`rearm-review.mjs` swaps `review:changes → review:pending` (an independent re-review is owed) and posts a
durable re-arm comment. It **NEVER** emits `review:accepted` and **NEVER** removes `review:human` — a gate-self
bounce stays human-ceremony-only. So the strongest thing you can do is re-arm the review; the human (via
`/review`) or the drain's AI-review convergence pass re-verdicts. **Do NOT** `gh pr edit --add-label
review:accepted`, **do NOT** merge, **do NOT** run a drain. If the script refuses (the PR no longer carries
`review:changes` — e.g. a human already re-touched it), report the completion record and stop and report it;
do not force a label:

```bash
node "{{WE_ROOT}}/scripts/operations/completion-cli.mjs" report --repo={{REPO}} --session={{SESSION_SLUG}} --status=done --outcome=escalated-rearm-refused
```

### 7a. Advisory-fix hand-back (#xkmu3gv — use instead of step 7 in ADVISORY-FIX MODE only)

There is no `review:changes` to swap here, so there is **no label to touch at all** — post the durable
advisory-fix marker instead:

```bash
node "{{WE_ROOT}}/scripts/conveyor/advisory-fix-mark.mjs" {{PR_NUM}} --repo={{REPO}} && \
  node "{{WE_ROOT}}/scripts/operations/completion-cli.mjs" report --repo={{REPO}} --session={{SESSION_SLUG}} --status=done --outcome=re-armed
```

`advisory-fix-mark.mjs` posts one comment recording that the advisory finding was addressed. It **NEVER**
touches `review:human`, `review:pending`, `review:changes`, or any `advisory:*` label, and it records **no**
verdict — only the next `advise` run (a fresh `review` dispatch, already owed automatically once this comment
outnumbers the prior advisory note) may change any of those, by judging the repaired head fresh. **Do NOT** run
`gh pr edit`, **do NOT** run `rearm-review.mjs` here (there is nothing for it to rearm), **do NOT** merge.

### 8. Append a structured learnings entry to the session drop-box (#2614)

Append **exactly one** generalized-lesson entry (a friction hit, a missing convention, a doc/skill gap, an
improvement idea) from the repair — a write-time-gated scrub that rejects raw code, diffs, secrets,
absolute/repo paths, or PII, so keep every field a short generalized lesson:

```bash
node "{{WE_ROOT}}/scripts/conveyor/learnings-drop.mjs" \
  --kind=<friction|missing-convention|doc-gap|skill-gap|improvement> \
  --summary="<one sentence — the lesson>" \
  --area="<coarse label, e.g. review-changes repair / re-arm>" \
  --suggestion="<short recommendation>" \
  --session={{SESSION_SLUG}}
```

Skip only if you genuinely hit no generalizable friction.

### 9. EXIT — do not merge, do not clear review, do not release

**Stop here.** Do NOT run `gh pr merge`. Do NOT run a drain. Do NOT `release` the lane. Do NOT set
`review:accepted`. Your process EXIT is the signal you are done; the conveyor's merge watcher
(`scripts/conveyor/pr-watch.mjs {{PR_NUM}}`) is re-armed by the conveyor skill, sees the PR return to
`review:pending` (still parked, exit 2), and surfaces it for `/review`. Return a one-line result:
`#{{ITEM_NUM}} → PR #{{PR_NUM}} (re-armed review:pending | fix escalated <reason> | fix gate-red)`, or, for the
tooling-denial exit in step 3, `#{{ITEM_NUM}} → blocked-on-infra (...)`, or, for ADVISORY-FIX MODE (step 7a),
`#{{ITEM_NUM}} → PR #{{PR_NUM}} (advisory finding addressed — a fresh review is owed next, not by this agent)`,
or, for STACKED-BASE MODE, `#{{ITEM_NUM}} → PR #{{PR_NUM}} (stacked-base conflict resolved against <baseRefName> —
review labels untouched)`.
A red gate / red CI / a blocked-on-infra exit is NOT watcher-visible — your one-line RETURN is the only signal
that surfaces it, so always report it.

---

## Manual take-over — the human `/finish` path (SAME procedure)

The auto path above and a human repairing a bounce by hand are **one procedure**, so a human doesn't reinvent
it. When a human takes over a `review:changes` bounce (the `/finish` `review-changes` bucket, or directly):

1. **Reconstitute the ref, don't rebuild.** Clone / acquire on `{{LANE_REF}}` (`/finish` clones the ref;
   `acquire --base=<ref>` does the same for a pool lane). Reuse the ~done work.
2. **Read the reviewer's finding** off the PR's latest changes-requested comment (step 2 above).
3. **Repair only the finding**, resolve any conflict the `/finish` way (regenerate derived artifacts; take-main
   for coordination JSON; STOP on a genuine same-line overlap), get the locus gate green (steps 3–5 above).
   If you stop instead, run `node "{{WE_ROOT}}/scripts/conveyor/stand-down.mjs" {{PR_NUM}} --repo={{REPO}} --reason=conflict`
   so the PR records that a repair was attempted and deliberately abandoned — the auto-fix loop then leaves it
   to you (#3296).
4. **Re-push HEAD to the same `lane/*` ref** — update the PR in place, never open a new one (step 6 above).
5. **Re-arm, never clear.** Hand back with `node "{{WE_ROOT}}/scripts/conveyor/rearm-review.mjs" {{PR_NUM}} --repo={{REPO}}` — the same
   invariant-guarded swap (`review:changes → review:pending`; never `review:accepted`; never removes
   `review:human`). A human still clears the eventual re-review via `/review` — repairing a bounce is not
   accepting it.

The only difference between auto and manual is **who** applies the finding; the reuse-the-ref, repair-only,
re-push, re-arm-never-clear shape is identical — which is the point (#2630).

## Guardrails (the non-negotiables)

- **Never edit the primary checkout** — all work is in the acquired lane clone (#104/#2183).
- **Never merge, never self-clear the review** — you stop at `review:pending` (re-armed); a human `/review` (or
  the drain AI-review) verdicts, and the drain daemon is the sole writer to `main`. `review:human` is never
  touched by a fix agent.
- **Reuse the ref, never rebuild** — reconstitute from `{{LANE_REF}}`; if the ref is gone or the item is
  unrecoverable, report it, don't silently redo the item.
- **Repair only the finding** — do not fold unrelated work in; do not weaken or delete a test to go green.
- **Prove it, don't just gate it** — reproduce the finding red (step 2), re-confirm it green (step 4), and post
  the trimmed before/after evidence as a PR comment (step 6) before you re-arm. A genuine non-repro is stated
  explicitly, with the reason — never silently skipped.
- **Work only through the normal verbs** — `acquire --base=<ref>` → repair → `git push … lane/*` →
  `rearm-review.mjs` (or, in ADVISORY-FIX MODE, `advisory-fix-mark.mjs` — never `rearm-review.mjs`, there is no
  `review:changes` to swap) → daemon/human re-review. No parallel state store (#2612 ruling).
- **ADVISORY-FIX MODE never touches any `review:*` or `advisory:*` label** (#xkmu3gv) — its only output is the
  fix itself and the durable marker at step 7a; the NEXT `review` dispatch (already owed automatically, not run
  by this agent) is what may change a label, by judging the repaired head fresh.
- **A mechanical conflict-resolution round hands back with `rearm-review.mjs --round=conflict`** (#xkmu3gv), so
  it counts against its own smaller cap — the plain form would silently spend the ordinary negotiation cap
  instead.
- **Always resolve a conflict against the PR's own `baseRefName`, read LIVE, never an assumed `main`** (#3383) —
  most PRs base off `main`, but a stacked PR does not, and GitHub retargets a stacked PR to `main` automatically
  once its base merges and is deleted, so the live value can differ from what this dispatch was planned against.
- **STACKED-BASE MODE never touches any `review:*` label** (#3383) — its only output is the fix itself and the
  durable marker via `conflict-fix-mark.mjs` (never `rearm-review.mjs`, there is no `review:changes` to swap);
  it counts against the SAME `CONFLICT_FIX_ROUND_CAP` the ordinary main-base conflict-fix round uses.
- **If you stop, say so ON THE PR** — every escalation exit runs `stand-down.mjs` before it returns (#3296). A
  refusal that leaves no durable trace is indistinguishable from a crash, and gets re-dispatched forever. The
  marker changes no label; it is terminal for the auto-fix loop and cleared by a human.
