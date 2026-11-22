---
bornAs: x9ah1zb
kind: epic
parent: "3383"
status: open
dateOpened: "2026-09-22"
tags: []
---

# Live agent activity on /wip cards — what each in-flight agent is doing, per card, with progressive disclosure

Every in-flight agent (build, fix, ci-heal, review, prepare, converge, Codex, subagents) shown live on its /wip card: an on-card status line, a step timeline, and a step detail excerpt — derived mechanically from the transcripts on the laptop, streamed over the existing relay only while a page watches, never stored. Design: plateau:docs/wip-live-agent.md.

## Why

The operator's ask (2026-09-22): *"would it be possible for in progress card - build, fix, review, etc - all of them, to actually have a live transcript of this agent from the WIP. status exposed on the step and then we see exactly what the agent is doing, with progressive disclosure of details"*.

Today a Doing card says only that something is claimed or has a PR. What the agent is doing right now is visible only by reading its transcript on the laptop (the inspect-agent-health and inspect-codex-transcript skills). Prior art: #1854 built a dev-only active-work tab from the same transcripts; this carries that idea to the phone, bounded and scrubbed.

## Shape (design: plateau:docs/wip-live-agent.md, mock plateau:docs/mocks/wip-live-agent.html)

- **L1** — a one-block agent line on each card: role · phase · phase rail · current step · elapsed.
- **L2** — card opened: run tabs and a timeline of phase groups (Lane → Read → Edit → Test → Verify → PR → Release).
- **L3** — step opened: tool, exit, times, and a scrubbed output tail or an edit summary.
- Everything is derived mechanically on the laptop — no model call. Only a watching page gets data. The relay stores nothing but closed-vocabulary fields.

## Slices (in order)

1. #3932 — join each running agent to its card (first; everything needs it).
2. #3934 — transcripts → steps.
3. #3936 — scrubbed step excerpt.
4. #3935 — coarse agent summary in the snapshot.
5. #3933 — relay watch/interest.
6. #3937 — laptop agent stream.
7. #3938 — live L1 line + L2 timeline.
8. #3939 — L3 step detail.
9. #3940 — blocked → Needs you, unmatched strip, several runs.
10. #3941 — converge the surface.

## Defaults the slices assume (still open for the operator — design doc §8)

Blocked agent moves the card to Needs you · only closed-vocabulary agent fields are stored · edits show path + line counts, never code · a Bash call with no description gets a fixed verb, never its command · ended runs stay 30 min · lifecycle comes from `claude agents --json` · the reader is a WE operation · standalone converge dispatches would get a `converge` session-slug kind.

## Done when

1. **Executable** — every slice above is resolved.
2. **Live** — with a conveyor build running, /wip on a phone shows that card's agent line change within 5 s of a new step; with no /wip page open, the laptop publisher's log shows zero `agent-delta` sends over 5 minutes.
