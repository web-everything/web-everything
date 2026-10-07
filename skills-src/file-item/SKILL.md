---
name: file-item
description: File a new backlog item through the declared `file-item` operation — never a hand-composed prompt, never a raw `backlog.mjs scaffold` call an agent typed itself. Use when the user or a driving session wants to "file a backlog item", "open a new card", "add a story/task/epic/decision to the backlog", or when a mechanical/conveyor session needs to file something it just discovered. NOT for editing an existing card (that's `backlog.mjs` directly, or `claim`/`resolve`) and NOT for choosing what to work on next (that's `/next`).
---

# File a backlog item the mechanical way (#3383)

**Live on `main` (#3548).** This skill and the `file-item` operation it wraps graduated from
`origin/lane/mechanical-dispatcher`; see `we:scripts/operations/file-item.mjs`'s own header for history.

## Never hand-roll a backlog item file

Found live 2026-09-06: a session driving epic `#3383` realized every single item it had filed that session
went through a hand-dispatched `Agent`-tool subagent with a bespoke prompt — composing the card's text and
running `backlog.mjs scaffold` itself, or worse, hand-authoring the `.md` file directly. This is exactly the
violation `we:.claude/skills/mechanical-delivery-doctrine/SKILL.md`'s rule 2 names for BUILD dispatch
("mechanical dispatch runs on the card + the generic brief, never a bespoke prompt") — it had simply never
been extended to cover FILING.

**Do NOT run `we:scripts/backlog.mjs scaffold` directly, and do NOT hand-author a new `backlog/*.md` file with
the `Write` tool.** Both skip the one thing this operation adds over bare scaffolding: clearing the card for
the conveyor. A card that is filed and never cleared sits invisible to
`we:scripts/conveyor/tick-core.mjs#planTick`, which builds every one of its five dispatch lists from
`state.queue`'s CLEARED (`buildQueued`) rows ONLY — an uncleared item, however ready, is never dispatched.
Route every new filing through `file-item` instead:

```
node scripts/operations/run.mjs file-item --title="<title>" --kind=story --size=<fib> \
  --digest="<why this exists, we:-prefixed for every bare code path>" \
  --scope="we:path/one.mjs,we:path/two.mjs" \
  --parent=<NNN or xHASH> --json
```

## What it does, end to end

`file-item` is `we:scripts/operations/scaffold.mjs`'s own read/plan/write — reused verbatim, not
re-derived — plus one more effect: once the card is written, it decides whether to clear it for the conveyor
(`we:scripts/conveyor/queue-store.mjs`'s pure `addToQueue`, the same sidecar `we:scripts/conveyor/queue.mjs
add` writes) and does so automatically unless:

- the kind can never be dispatched (`epic` needs `/slice` first; `decision` needs `/prepare` + `/decision`
  first) — filed, not queued, and the verdict says why;
- the card was born `active` (a `--session` filing, #670) — pool-excluded until `settle`d, so auto-queuing it
  would offer a half-authored card to the conveyor the same tick it was born;
- you pass `--queue=false` explicitly.

Read `run.verdict` for the scaffold shape (`num`, `id`, `rel`, `kind`, `status`) exactly as a bare `scaffold`
caller would — this operation does not reshape it.

## Composing the content is still your job

Filing an item is not fully mechanical, and this operation does not pretend otherwise: **you (the calling
agent) still compose the title, digest, scope and sizing** — that step needs judgment, and none of the four
declared-operation step kinds (`compute`/`judge`/`effect`/`confirm`) performs open-ended authorship. What
changes is what happens AFTER you have the text: it goes through `file-item`, never through a bespoke prompt
handed to a subagent, and never through a raw `backlog.mjs scaffold` call you type yourself.

**The scaffolded card carries a `## Edge cases this change must handle` section** (seven classes: untrusted
text, truncated reads, shared state files, fail closed, identity scoping, state over time, who wrote it; the single
source is `we:scripts/backlog/edge-case-classes.mjs`). Replace each `TODO` line with the handling, or
`n/a: <why>`, before you land the card. A card that still carries the `TODO` lines is not filled.

**Every bare code path in `--digest` and `--scope` needs a `we:` locus prefix (#883)** — the guarded writer
this operation writes through (`we:scripts/backlog/guarded-write.mjs`) refuses the whole write otherwise, and
it is a REAL refusal you will hit, not a hypothetical: write `we:scripts/operations/file-item.mjs`, never
bare `scripts/operations/file-item.mjs` or bare `file-item.mjs`.

## Landing the card

`file-item` only writes to the lane's own working tree — same as `scaffold`, it does not commit or open a PR.
Land the new card the normal way, from the SAME lane:

1. `git add backlog/<the new file>.md && git commit -m "..."` (tight pathspec — the card only, unless this is
   riding along with real code in the same lane).
2. `node scripts/operations/run.mjs verify --checkout=<this lane>` — the standard pre-PR gate, already a
   declared operation; this skill does not fold it into `file-item` (see the operation's own header for why).
3. `node scripts/operations/run.mjs open-pr --ref=lane/<slug> --title="<title>" --bodyFile=<path> --json` —
   same as every other constellation-repo change (`we:.claude/skills/pr/SKILL.md`).

## If you find `file-item` is missing on your checkout

`file-item` is live on `main` (#3548); if your checkout is missing it, it is behind — sync it first. If you
cannot sync and must proceed anyway, fall back to `we:scripts/operations/scaffold.mjs` (`run.mjs scaffold`)
for the write, then run
<!-- @operation-home-ok: #3383 — the deliberate fallback for a checkout that is behind main and missing file-item; this is the documented path, not a bypass of it. -->
`node scripts/conveyor/queue.mjs add <the new id>` yourself as a SEPARATE step — and note, in the item you are
filing or in your own session notes, that you had to do the hand-off by hand, so the staleness stays visible
rather than silently absorbed.
