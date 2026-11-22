---
bornAs: xsde084
kind: epic
parent: "2445"
status: parked
priority: low
dateOpened: "2026-07-12"
tags: []
---

# Plateau Loop: multi-project registry — manage WE, Frontier UI, and plateau-app as first-class projects

Make the Loop manage a registry of projects, each with its own backlog, lane pool, and gate
config. The machinery is already keyed by repo name; this makes the registry first-class.

The registry is what lets the operable console ([#2474](/backlog/2474-plateau-loop-operable-console-manage-and-operate-the-drain-d/))
handle **multiple backlogs from multiple repos** with per-repo build status and orchestration —
the end state the console morphs toward. Its data-model prerequisite is per-repo backlog ownership:
each repo holds its own `backlog/*.md` rather than everything living in Web Everything today
([#2475](/backlog/2475-per-repo-backlog-files-each-constellation-repo-owns-its-own-/)).

> **Ruled 2026-09-06 (operator, [#3129](/backlog/3129-per-repo-backlog-data-model-distributed-backlog-md-tooling-p/)) — the
> sentence above stands as the DESTINATION; the timing is the amendment.** #3129's prep expected ratifying the
> interim to *override* that premise and owed this epic a correcting edit. It does not: fully distributed
> per-repo backlogs are the declared end state, on a product-shape ground this epic never argued — a customer
> with dozens of repos whose ownership moves between owners cannot route every repo through one central
> tracker, because a repo and its backlog are the same artifact and must move together. What changes is the
> **interim**: until then a per-repo surface is a **locus-filtered virtual view** over WE's single tracker (no
> second `backlog/`, no second numbering authority), and the id scheme moves first — an item id always carries
> its locus, additive half carved as [#3533](/backlog/3533-a-backlog-id-always-carries-its-locus-bare-nnn-keeps-meaning/).
>
> **One thing left to the operator, flagged rather than taken:** this epic is `priority: low` and deferred
> behind #2456's evidence gate. #3129 narrowed that deferral's ground — the "no evidenced need for repo
> autonomy" reading measured our own three-repo constellation, which is the wrong population for a product
> built for enterprise scale. Whether that re-prioritises this epic is a separate call, not made here.

Deferred behind the phase-1 evidence gate (#2456) — `priority: low`, parked, pickable.
