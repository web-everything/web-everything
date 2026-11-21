---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/author-stamp-restore.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7231 (head 33d3c2dae)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7231 (reviewed head `33d3c2dae4d05fe6e910060c1154eb45401bcd6f`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/author-stamp-restore.mjs:158` — (failing-input, degraded) Ordinary task lists and array examples now prevent stamp restoration
   - Scenario: Use an OPEN PR with body 'Updated body', authorLogin 'alice', and one complete historical snapshot by User alice at 2026-11-20T10:00:00Z containing '- [x] Unit tests pass.\n\n&lt;!-- authored-by-actor: 01f39b97-274a-4078-8eeb-e7f8d6008673 --&gt;'. Restoration now refuses and never writes because the checkbox brackets remain after closed-link removal. The same happens with 'Accepts 'items[0]'.' or a completed reference link before the stamp. These standalone author-supplied stamps should restore, as they did on base; none is enclosed by a link.
   - Class: live-reproduced (basis: Executed the head planner and restoration write path with injected reads and a recording writer, retaining the real stamp parser. Each input refused with zero writes; the base implementation restored each input. An ordinary inline-link control restored successfully on head.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:scripts/lib/author-stamp-restore.mjs:164` — (failing-input, degraded) Every closed code fence now blocks restoration of a subsequent standalone stamp
   - Scenario: Use an OPEN PR with body 'Updated body', authorLogin 'alice', and one complete historical snapshot by User alice at 2026-11-20T10:00:00Z containing a three-backtick sh fence, 'npm test', its matching closing fence, a blank line, and '&lt;!-- authored-by-actor: 01f39b97-274a-4078-8eeb-e7f8d6008673 --&gt;' on its own line. The new snapshot-wide fence check refuses and prevents writing even though the stamp follows the completed fence. It should restore this unambiguous author stamp. The previously passing closed-fence test was changed to expect refusal, leaving ordinary PR descriptions with command ex
   - Class: live-reproduced (basis: Executed this exact snapshot through the head restoration write path: action refuse, zero writes. The base planner returned restore for the identical snapshot. This requires no malformed Markdown or concurrency.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
