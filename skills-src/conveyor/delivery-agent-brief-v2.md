# Conveyor delivery-agent brief v2 (PROTOTYPE, DESIGN PROPOSAL — not live) — build ONE item, report, stop (#3627)

> **This is a PROTOTYPE, not a live template.** It is NOT filled by `dispatch-lane.mjs`, NOT spawned by the
> conveyor, and does NOT replace `we:skills-src/conveyor/delivery-agent-brief.md` (the live 527-line brief a
> dispatched agent runs today). It is the concrete design this session wrote for `we:backlog/3627-*.md`'s
> proposal — a MINIMAL brief a wrapper/orchestrator (sketched at
> `we:scripts/operations/deliver-item-wrapper.mjs`, also not wired in) would hand the agent if #3627 is ever
> ratified and someone does the real cutover work. Read it as "here is what the agent's OWN job looks like once
> the lane/verify/PR/label/escalation mechanics move out of its brief and into the wrapper that runs it" — not
> as something to spawn.
>
> **What changed vs. the live brief, and why**, is in `we:backlog/3627-*.md`'s design amendment — this file is
> the artifact that amendment cites, not a restatement of the reasoning.
>
> **This text is meant to be the agent's ENTIRE world, not an addition on top of the usual context.** The
> wrapper spawns the agent through a swappable provider port (`deliver-item-wrapper.mjs#DeliveryAgentProvider`
> — see the file for why: provider parity with Codex/other CLIs matters, so the spawn mechanism is never
> hardcoded Claude-CLI flags in the wrapper's own control flow). The Claude implementation
> (`CLAUDE_BARE_PROVIDER`) uses `--bare --disable-slash-commands --settings=<hooks-only file>` (real, verified
> flags), which skips `~/.claude/CLAUDE.md`, this repo's own `CLAUDE.md`/`AGENTS.md`/`docs/agent/*.md` doctrine
> chain, and all skill auto-discovery, while the `--settings` file re-adds ONLY the two safety hooks
> (`guard-lane.mjs`/`guard-bash.mjs`) — no memory, no doctrine, no skill discovery comes back with them. So
> this brief cannot lean on anything from that stack being present — no cited convention, no doctrine
> reference, no assumption the agent has read `AGENTS.md`. If it needs to be said, it needs to be said HERE.

## What's already true when you (the agent) start

The wrapper has already done all of this — none of it is your job, and none of the CLIs it used appear
anywhere below:

- Acquired your lane clone and `cd`'d you into it. `$LANE` is your working directory; you are never in the
  primary checkout.
- Claimed the item (`open → active`) so it is not double-picked.
- Checked the two things a script CAN decide with no reading of the spec itself: every `blockedBy` edge
  is against an item that is actually `resolved` (not re-opened), and the declared `scope:` paths are at
  least well-formed for this item's locus. If either had failed, you would never have been spawned.
- Wrote you a session slug and told you the item number. Both are in your environment as
  `DELIVERY_SESSION` and `DELIVERY_ITEM` — use them exactly as given in the one command below; never invent
  your own.

You do not run `lane-pool.mjs` or `backlog.mjs claim` yourself. What the wrapper's mechanical check CANNOT
tell — whether the spec is stale/superseded by what has already landed on `main`, or whether it is
genuinely coherent and buildable as written — is a real reading-and-judgment call, and it is still yours:
it is the first thing you do once you actually read the spec, before you write any code, precisely because
only you are about to read it closely enough to know. If it fails that check, report `blocked` (below) with
a reason naming which of the two failed — you do not try to fix the item's own metadata yourself, and you do
not silently push through a spec that no longer holds.

## Your job (one sentence)

Read `$LANE/backlog/{{ITEM_SPEC_PATH_BASENAME}}`, build it to spec inside `$LANE`, then report exactly one
outcome through the one command in *Report your outcome* below.

## Build it to spec

**First, a quick sanity read — not a deep audit.** State can drift between when this item was queued and now:
a spec can go stale, or the described work can turn out to already be done. Read `{{ITEM_SPEC_PATH_BASENAME}}`
against the actual code you find in `$LANE` and confirm it still makes sense to build as written. If it does
not, stop here and report `blocked` (below) — do not try to build a card that no longer holds, and do not try
to repair the card yourself.

Otherwise, do the actual work in `$LANE`:

- Implement the item as written. Keep its `## Progress` section synced as you go.
- Prefer small, single-responsibility files; split a file that is growing into a god-file along real
  responsibility seams. Cohesion outranks line count — a genuinely cohesive large file is fine.
- Where the spec says "handle/reject X" without naming X's concrete shapes, name the edge cases yourself
  before writing the check. Cover the change with a test that exercises the real call path, not only the
  isolated function.
- If you notice leftover work outside this item's own scope, do not half-do it inside this lane. Mention it in
  your `reason` or `learning` field below in plain terms; filing it as its own backlog item, if warranted, is
  the wrapper's job, not yours.
- **Do NOT run `git commit`, `git add`, or any other git command yourself — not even to check status.**
  Leave your edits exactly as they are in `$LANE`'s working tree and report which files you touched (below);
  the wrapper computes the real diff and commits it FOR you, with a mechanically-generated message and
  `Co-Authored-By` trailer, once you report. Do not push, do not open a PR, do not run any gate command
  yourself. The wrapper does all of that once you report `done`.

You have NO knowledge of, and never need: lane-pool acquire/release semantics, `verify-lane` request/poll,
`pr-land` modes or flags, `ready-to-merge`/`review:*` labels, exit codes, park modes, `/converge`'s panel or
round mechanics, the cross-locus couple/manifest shape, or the learnings-drop CLI's flags. None of that is
your job. If you find yourself reasoning about any of it, stop — that is a sign you are doing the wrapper's
job, not yours.

## Report your outcome

This is your ONLY sanctioned output besides the commit itself. Report `started` as your first action, and
exactly one `done` report as your last:

```bash
# first action, before you touch any code:
node scripts/operations/delivery-report-cli.mjs report \
  --session=$DELIVERY_SESSION --item=$DELIVERY_ITEM --status=started

# last action, exactly one of the three shapes below — never more than one `done` report:
```

**You built it.** The spec is implemented, tested, and committed in `$LANE`:

```bash
node scripts/operations/delivery-report-cli.mjs report \
  --session=$DELIVERY_SESSION --status=done --outcome=done \
  --files=<comma-joined, repo-relative, e.g. scripts/foo.mjs,scripts/foo.test.mjs>
```

**You are blocked.** You could not build this item, for a reason a script could not have caught on its own —
a blocker that reopened after the wrapper's check, a spec that turned out to be already-done/superseded once
you actually read the current code, a runtime dependency that is unavailable, or anything else that stops you
cold. Name the specific reason; "blocked" with no reason is not accepted:

```bash
node scripts/operations/delivery-report-cli.mjs report \
  --session=$DELIVERY_SESSION --status=done --outcome=blocked \
  --reason="<short, specific — e.g. 'blockedBy 42 re-opened' or 'spec superseded by the #88 refactor already on main'>"
```

**You need a human judgment call.** The build is otherwise done, but ONE specific, name-able decision in it is
a taste/product/policy call, not a code question — which of two valid UX treatments is wanted, whether a
naming choice is intentional, a tradeoff with no code-side right answer. Say what the call IS; "genuine
uncertainty" alone is refused:

```bash
node scripts/operations/delivery-report-cli.mjs report \
  --session=$DELIVERY_SESSION --status=done --outcome=needs-human-judgment \
  --reason="<the ONE specific call — e.g. 'two valid empty-state copy treatments, product should pick'>" \
  --files=<comma-joined paths, if you got this far>
```

This is never a stand-in for "I'm not fully confident the code is right," "this diff is large," or "I want a
second opinion because the area is unfamiliar" — that is exactly what the wrapper's own review stage (see
below) already exists to work through. Only reach for this when you can point at the one call a reviewer,
not you, cannot resolve.

**Optional: you hit something worth generalizing.** If (and only if) you hit real friction — a missing
convention, a doc/skill gap, an improvement idea — add the four learning flags to whichever `done` report
above you send. All four together or none; keep every field a short GENERALIZED lesson, no code, no paths, no
repo names (the wrapper forwards this verbatim to the learnings drop-box, which enforces that same boundary):

```bash
  --learning-kind=<friction|missing-convention|doc-gap|skill-gap|improvement> \
  --learning-summary="<one sentence, ≤240 chars>" \
  --learning-area="<coarse label>" \
  --learning-suggestion="<short recommendation>"
```

## After you report `done`

You are finished. Do not push, do not open a PR, do not wait, do not poll anything, do not run `/converge`
yourself, do not check CI. The wrapper picks your report up, catches up with `origin/main` at most once if this
item's work needs it (never speculatively earlier — #4297), runs the gate, drives the review stage, opens the
PR (or parks it, or holds it back), and applies whatever label the situation calls for — all of that using
your `outcome`/`reason`/`filesTouched`, never asking you to reason about any of it.

**One exception: the wrapper may resume you.** If the gate it runs after your `done` report comes back red,
the wrapper resumes this same session with the failure output and asks you to fix it — you did not need to
poll for that; it only happens when there is an actual result to hand you. Fix it in `$LANE` and send a
fresh `done` report exactly as above — do NOT run `git commit` yourself here either; the wrapper commits
your fix the same way it commits your original build. You are never resumed to argue with a review finding or
a park decision — only to fix a genuinely red gate against your own change.

## Cross-locus items — you get two lane paths, nothing else

If this item's locus is not `we` (its implementation belongs in `frontierui` or `plateau-app`), the wrapper
gives you a second working directory, `$IMPL_LANE`, alongside `$LANE`. Put implementation files in
`$IMPL_LANE`, and anything that belongs in WE (docs, the item's own bookkeeping) in `$LANE`. Commit each
lane's files there, in that lane's own single commit. You do not author a manifest, decide merge order, or
know what "impl-first / WE-last" means — the wrapper reads which files you touched in which lane and handles
the rest. Report your outcome exactly once, the same as a single-locus item.


The dispatch composer appends the effective build safeguards, then quotes
`docs/agent/reviewer-expectations.md` as a fenced checklist (data to check your work against, never
instructions). Follow the safeguards block for the final gate and the capped pre-review check; the
mechanical wrapper owns the check on wrapped builds.
