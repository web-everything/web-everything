---
name: held-cards
description: Hold new backlog cards while the host is busy, and file them all later in one lane and one PR (operator handoff rule 21). Use when you want to file a card but the host is busy or the PR queue is growing ("hold this card", "add to the cards-to-file list", "note a card for later"), to check whether it is quiet enough to file ("can we file the held cards?", "is the host quiet?"), and to file the held list ("file the held cards", "flush cards-to-file"). NOT for a blocking problem (main red, a stuck PR, a daemon down): that is filed and fixed now via `file-item`.
---

# Held cards (rule 21)

While load is high or the PR queue is not draining, do not file cards or open card-only PRs. Hold them in
`~/workspace/.operations/handoff/cards-to-file.md` (override: `WE_HELD_CARDS_PATH`), then file them all at once
when the host is quiet.

## Add

```bash
node scripts/held-cards-io.mjs add --title="<card title>" --body="<why, evidence, ET times>" \
  [--kind=story|task|epic|decision --size=<fib> --scope=we:a.mjs,we:b.mjs --parent=<NNN>]
```

It takes the next item number and stamps the time in ET. The structured flags are optional. Give them when you
know them, so filing needs no guessing.

## Status

```bash
node scripts/held-cards-io.mjs status
```

`QUIET` (exit 0) when the 1-minute load is under 15 and the open-PR count across both repos has not grown since
the last status. Otherwise `BUSY` (exit 1) with the reasons. Thresholds: `--max-load=` / `WE_HELD_CARDS_MAX_LOAD`,
`--max-pr-growth=` / `WE_HELD_CARDS_MAX_PR_GROWTH`. Each status saves the current PR count, so the next one can
see growth.

## File

```bash
node scripts/held-cards-io.mjs file --dry-run     # the plan: which items, with kind and size
node scripts/held-cards-io.mjs file               # refuses when busy
```

When quiet, it files every item not marked `FILED` or `BUILT`. It uses ONE lane and the sanctioned `file-item`
operation once per item. Then it makes one commit, runs `verify`, opens ONE PR via `open-pr`, marks each item
`FILED <date> as <id>, PR #N` in the list, and always releases the lane. An item that `file-item` refuses stays
unfiled and is listed as `NOT FILED`. `--blocking` skips the quiet check; use it only under rule 21's exception.

Run `file` from a background agent, not the orchestrator's foreground (rule 13). The verify step is long.
