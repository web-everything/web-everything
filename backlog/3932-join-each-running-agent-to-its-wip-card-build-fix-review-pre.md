---
bornAs: xa59gb9
kind: story
size: 3
parent: "3931"
status: open
dateOpened: "2026-09-22"
tags: []
---

# Join each running agent to its /wip card — build, fix, review, prepare, Codex and subagents, with the join reason recorded

The card-to-agent join, first because every other slice needs it. A pure resolver plus a declared read operation `agent-activity` (we:scripts/operations/agent-activity.mjs + an -io shell, the runner-activity pattern) that turns what is already on the laptop into runs tied to cards. Design: plateau:docs/wip-live-agent.md §1.3.

## What to build

Ordered resolvers, first match wins; the winner is recorded as `joinVia`:

1. Session name via `parseSessionSlug` (we:scripts/conveyor/session-slug.mjs): item kinds → card; PR kinds (`review`/`fix`/`ci-heal`) → PR number → card through a PR→card map passed in.
2. Codex thread record (we:.operations/codex-delivery-threads) → slug → resolver 1; `threadId` → rollout file.
3. Parent: the `toolUseId` in a subagent's meta file → the parent run's card; workflow lanes use the first `#NNN` in the child's first message (as `agentItemNum` in we:scripts/dev/active-progress-watch.mjs).
4. Lane lease (`.git/.lane-lease` `workerSession`/`ownerSession`) on a `lane/<num>-…` branch.
5. Claim replay — reuse `BACKLOG_VERB_RE` from we:scripts/dev/active-progress-watch.mjs, but read incrementally from a stored byte offset, never the whole transcript.
6. Mention — first `#NNN` in an unjoined subagent's prompt; tagged `mention` (weak).

No match → `unmatched[]`. The operator's own interactive session is listed only if resolver 4 or 5 ties it to a card.
Lifecycle from `claude agents --json --all` (cached 10 s). Output: `runs[] {runId, runtime, role, name, parentRunId, card, joinVia, state, startedAt, lastEventAt}` + `unmatched[]`.

## Done when

1. **Executable** — we:scripts/operations/__tests__/agent-activity.test.mjs passes under `npx vitest run` with one fixture per kind: `conveyor-N`, `prepare-N`, `prepare-decision-N`, `review-pa-P`, `fix-P`, `ci-heal-P` (PR→card via the supplied map), a Codex thread record, a subagent inheriting its parent, a lane-lease session, a claim-replay session, a mention-only subagent tagged `mention`, an unmatched background session, and an interactive session with no lane or claim that is NOT listed.
2. **Live** — on the laptop, the `agent-activity` operation run through we:scripts/operations/run.mjs with `--json` (redirected to a file) lists every session `claude agents --json` reports as working, each either on a card or in `unmatched`.

## Additions from 2026-09-24 incident review

- **Add `transcriptAgeS` to each run.** `lastEventAt` from `claude agents` is not enough: on 2026-09-23 and again on 2026-09-24 a session stayed `blocked` in the listing for hours while its transcript never moved (#3951). The transcript file's mtime age is the cheap truth. The new pr-ownership read (4056) uses the same field to flag a stale binding, so compute it once here.
- **Share the PR→card map.** The pr-ownership read needs the same PR→card map this card takes as input. Build it once, as a shared helper, so /wip's per-card agent view and its per-PR ownership view never disagree about which card a PR belongs to.
