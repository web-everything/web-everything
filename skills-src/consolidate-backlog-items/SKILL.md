---
name: consolidate-backlog-items
description: Cluster already-filed backlog items that are really one job into logical work sets — an umbrella epic or a batch pack — but only when it's provably one job and the grouping doesn't cost batchability. Always produces a report of what could and could not be grouped (with the action that would unblock the latter); the on-disk change is gated on approval. The inverse of /split. Use when the user wants to "consolidate" the backlog, group similar/duplicate items, find near-duplicates already on the board, or turn scattered related cards into one set of work to do.
---

# Consolidate — group filed items into logical work sets, only when it's one job

Trigger + pointer — the method lives in *backlog-workflow.md → Consolidating related items*, which builds
on *backlog-workflow.md → Rules → Review before adding (dedup)*, *backlog-workflow.md → Keep the blocker
DAG honest*, *backlog-workflow.md → Running a batch → Eligibility*, and *backlog-workflow.md →
Principle-conformance pre-flight → CTA invariant*. Don't restate the rubric here; if the method changes,
edit that doc.

The governing instinct is **conservative, and it points the opposite way from `/split`**: a *needless*
consolidation buries independently-deliverable work under an umbrella nobody can batch; a *missed* one just
leaves two adjacent cards to pick up separately. When the cluster isn't obvious, **don't group** — record it
as *left apart* with the unblocking action, and move on.

## Quick path — the loop in commands

1. **Build the candidate clusters** over open items, strongest machine signal first (*Consolidating related
   items → Candidate set*): overlapping **`scope:`** touch-sets, shared `parent`/`relatedProject`/`tags`,
   title+digest term overlap (`grep -rilE "<topic>" backlog/`), same-sweep provenance (a run of items sharing
   a `dateOpened`). The open set comes from `npm run check:readiness -- --select --json`; blocked and parked
   items aren't in that projection, so do a one-pass frontmatter scan of `backlog/*.md` for the complete
   board. A signal makes a **candidate**, never a verdict. `/consolidate <NNN>` clusters around one item;
   bare `/consolidate` sweeps the whole board.
2. **Investigate the real work before calling a cluster one job** (*→ The overlap-investigation pass*).
   Sameness is a claim about the code, so read it: the members' overlap must be **`file:line`-citable** —
   the same function, registry, or fixture, not merely the same subsystem or tag. Two items on the same file
   that change different commands are **neighbours**, not one job. A cluster justified only from the bodies'
   wording is under-investigated → *left apart*.
3. **Apply the consolidation-safety rubric to each cluster** (all five must hold — *→ The
   consolidation-safety rubric*). Any failure → **left apart**.
4. **Pick the outcome per surviving cluster** (*→ The three outcomes*): **umbrella** (one epic, members
   re-parented) · **pack** (`blockedBy` edges + a named pack for `/batch`, no epic) · **fold** (a true
   near-duplicate — closed **not built** into the survivor after approval; see *Executing*, step 2a).
5. **Write the report** `reports/<YYYY-MM-DD>-backlog-consolidation-analysis.md` — two tables: could
   consolidate (members, outcome, umbrella title/digest or pack edges, what changes on each member) and
   left apart (members, *which rubric condition failed*, the specific unblocking action). Produced even when
   zero clusters group. File any blocking fork surfaced along the way as its own `kind: decision` card.
6. **Stop and present.** The report is the deliverable; the on-disk change is gated on **one "go"** — do not
   auto-group.

## Executing — only after approval

A single "go" authorizes the clusters you presented (*→ Executing a consolidation*):

1. **Umbrella:** `node scripts/operations/run.mjs scaffold --kind=epic --title='…' --digest='…' --json` —
   **no `--size`** and **no `--scope`** (an epic is sliced, never built directly). **Single quotes** — a
   cluster title assembled from member text still runs `` ` `` / `$(…)` through bash inside *double* quotes
   (*backlog-workflow.md → Authoring an item → The quoting rule*). Then set `parent:` on each member and trim
   any member digest that now reads as the whole job. **Reuse** an existing epic that already covers the
   cluster instead of minting a sibling umbrella.
2. **Pack:** add only the `blockedBy` edges the investigation proved real — a "see also" is a `crossRef`,
   not an edge — and record the pack in the report.
3. **Gate:** `npm run check:standards` green, and re-evaluate `blockedBy` per *backlog-workflow.md → Keep
   the blocker DAG honest*.

2a. **Fold:** `node scripts/operations/run.mjs close-items --ids=<absorbed> --reason=duplicate
   --into=<survivor>` — a dry run by default; re-run with `--apply` (*backlog-workflow.md → Closing an item
   as not built*, ratified by #2982). Undo with `reopen-items`.

A consolidation never renumbers, deletes, or `resolve`s a member — it adds an umbrella, rewires edges, or
closes a folded duplicate *not built* (`status: closed`, never `resolved`).
Close with a net-flow line (`+1 epic`, N members re-parented, M clusters left apart).

## Relationship to `/split`

Inverses that cannot ping-pong, by construction: `/split`'s candidate set is oversized stories and childless
epics, and rubric condition (4) forbids consolidation from producing either (it never merges scope into one
bigger item, and its umbrella is born with children). Run `/consolidate` to make scattered cards one set,
then `/batch` to burn the set down.
