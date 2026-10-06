---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/completion-record.mjs", "we:scripts/operations/__tests__/completion-record.test.mjs"]
dateOpened: "2026-10-05"
tags: []
---

# Prevention — Render the denied command inside a fenced or inline code span with the backtick delimiter strippe… (from web-everything/web-everything#3990 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/completion-record.mjs:140` — Render the denied command inside a fenced or inline code span with the backtick delimiter stripped (already done), or collapse it to executable plus first two tokens. Add a lint or test that every agent-supplied string interpolated into a bot comment is code-fenced.
2. `we:scripts/operations/completion-record.mjs:143` — Post only a bounded allowlist projection (executable plus subcommand, no arguments) or keep the full command in the operator-only completion record and link to it. Back this with a test that arguments are never echoed into note text.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3990@003a4b73476983a489f7327e50b3dd906c578083

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
