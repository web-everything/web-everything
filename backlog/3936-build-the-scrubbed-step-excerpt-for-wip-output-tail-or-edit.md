---
bornAs: x8gsl5r
kind: story
size: 2
parent: "3931"
status: open
blockedBy: ["3934"]
dateOpened: "2026-09-22"
tags: []
---

# Build the scrubbed step excerpt for /wip — output tail or edit summary, with a never-send list enforced by an allow-list

The L3 detail for one step, built on the laptop: `agent-activity --excerpt=<runId>:<seq>`. Output tail (≤ 12 lines, ≤ 4 KB) with control sequences stripped and `scrubPublish` from we:scripts/lib/secret-scrub.mjs applied per line — any hit withholds the whole excerpt. Edits give path + line counts only. Design: plateau:docs/wip-live-agent.md §4.

## What to build

- Allowed output fields only: `tool`, `exit`, `startedAt`, `endedAt`, `tail[]`, `file`, `added`, `removed`, `withheld`, `lines`.
- Never sent: raw commands, thinking/reasoning, prompts and user/system messages, `Read` results, `Edit`/`Write` bodies, hook output, attachments, env values.
- Home directory → `~`; absolute paths outside the known repo roots → "(outside the repo)".

## Done when

1. **Executable** — we:scripts/operations/__tests__/agent-excerpt.test.mjs under `npx vitest run`: from a hostile fixture transcript holding a `ghp_` token in command output, a PEM block, ANSI escapes, a thinking block, a `Read` result with file contents, an `Edit` body and the dispatch prompt, the serialized excerpts for every step contain none of those strings (substring search), and the `ghp_` step reports `withheld: true`.

Merged into plan step PD-LIVE (PL-WIP-CLEANUP, 2026-11-22).
