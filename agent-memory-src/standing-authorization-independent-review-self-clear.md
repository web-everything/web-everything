---
name: standing-authorization-independent-review-self-clear
description: Standing authorization to spawn a genuinely independent review session when a self-authored PR is blocked by the review self-clear guard
metadata:
  node_type: memory
  type: feedback
---

When a PR this session (or one of its subagents) opened gets parked `review:pending` and is blocked from
self-clearing — because the reviewing actor's session id is the same as, or inherited from, the authoring
session's id, per the independence guard in `we:scripts/lib/review-independence.mjs` / `we:scripts/review-set-label.mjs`
— the operator has given STANDING authorization (2026-08-31) to resolve it by spawning a genuinely independent
review session directly, without asking for sign-off each time.

**How:** mint a fresh session id (not inherited from the current session or any of its subagents), spawn a
`claude --session-id=<fresh-uuid> -p "..."` child process running the repo's own review operation
(`we:scripts/operations/review-pr.mjs` / `we:scripts/operations/review-loop-cli.mjs` as of 2026-08-31, or
whatever supersedes it) against the PR, in its own lane — never the primary checkout, never the lane that
authored the PR. Let that independent session record whatever verdict the juror actually reaches; never force
`accept` regardless of the real finding set.

**Why:** the safety property the operator actually cares about is that a real, independent juror looks at the diff
and decides — not that a human personally clicks the button every time. A freshly-spawned session with its own
id satisfies the check `review-independence.mjs` actually runs — but that check is a CONVENTION, not a proof.
Quoting its own header verbatim, not paraphrasing it, because a memory that softens a guard's own disclaimer
is exactly the failure mode `#2895` named:

> SAY PLAINLY WHAT IT IS NOT (the #2895 discipline — a record trusted further than it earns is the failure
> mode). This is NOT an unforgeable actor signal. #2895 RULED that deferred: no local construct survives an
> agent with shell access on the same machine, and `env CLAUDE_CODE_SESSION_ID=…` is exactly such an agent's
> escape. #2946 (a hardware human-presence gesture) is the durable fix. What this buys is that self-clearing
> now takes a DELIBERATE FORGE of a value written by another tool at another time, instead of costing
> nothing; and that every clearance record NAMES both parties, so a self-clear is visible after the fact.

So this doesn't make self-clearing IMPOSSIBLE, only COSTLY — that is the same bar `#2844`/`#2895` already
accepted as the durable one available today, not a weaker one invented here.

**The residual this authorization does NOT close, named directly (found in review of this memory itself,
2026-08-31).** The guard's own text says a self-clear stays *visible after the fact* — but that assumes the
clearing session is merely a DIFFERENT actor, not one hand-picked, briefed, and timed by the very session with
the interested outcome. Here, the "independent" reviewer's existence, its prompt content, and its timing are
ALL chosen by the author. The guard's machine fact (a distinct `CLAUDE_CODE_SESSION_ID`) still holds — but the
disinterestedness that fact is a PROXY for does not, and nothing in the resulting review record marks it as
self-initiated: a human later looking at a queued accept sees an ordinary-looking independent clearance, with
no visible signal that the reviewer was selected by the party it is reviewing. **Do not read this
authorization as closing that gap — it only ever bought the same cost-not-impossibility property the guard
itself claims, applied to a genuine bootstrapping deadlock (this session's own PR could not otherwise be
reviewed by anyone at all).** The property that actually protects against this residual is the one already
ratified and unchanged by this memory: an AGENT-tier `autoConfirm` may never answer `accept` unattended (epic
`#3383`, 2026-08-31) — every accept this mechanism can produce still queues for a human, and that human should
weigh a self-dispatched review's accept with LESS trust than an arms-length one, not the same trust, precisely
because of the gap this section names.

**How to apply:** use this the next time a session's own dispatched/authored PR is blocked by this exact
self-clear guard, AND treat it as closing only the bootstrapping deadlock, never the disinterestedness gap
named above. It does NOT extend to the separate, still-gated question of whether an AGENT-tier `autoConfirm`
may answer `accept` unattended inside the review-loop machinery itself — per the epic #3383 ruling on
2026-08-31, an agent may auto-answer `changes`/`abstain` unattended but never `accept`; an accept verdict
still queues for a human to clear on their own time, who should weigh it knowing the reviewer was
self-dispatched.
