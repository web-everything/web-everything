---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/gh-throttle.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5276 (head b5858c9ab)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5276 (reviewed head `b5858c9ab0850a636f109b0416c88d1ce47fc113`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/gh-throttle.mjs:1721` — (failing-input, degraded) Storing decoded stdout corrupts subsequent reads under another encoding.
   - Scenario: Enable the memo and read identical argv ['api','repos/o/r'] twice, with stdout containing UTF-8 'héllo\n': first use encoding:'ascii', then encoding:'utf8'. The first result is 'hC)llo\n'; the memo also returns 'hC)llo\n' to the UTF-8 caller, which should receive 'héllo\n'. A native Node probe reproduced this with one child execution and in-memory memo storage. Likewise, caching bytes ff8041 through UTF-8 decoding makes a subsequent Buffer read return efbfbdefbfbd41. Preserve original stdout bytes or separate incompatible encoding contexts.
   - Claude's re-check: The memo key (args + context) has no encoding, and entries store the already-decoded string under the caller's encoding. An 'ascii' miss stores 'hC)llo\n', and a later utf8 caller gets that lossy string back. Invalid UTF-8 decoded to U+FFFD is likewise returned as those bytes to a later Buffer caller.
2. `we:scripts/lib/gh-throttle.mjs:1707` — (edge-case, degraded) Memo hits bypass the next caller's maxBuffer and stdio contracts.
   - Scenario: Enable the memo, then read ['api','repos/example/project'] with twenty ASCII A bytes on stdout and maxBuffer:1024. Repeat with identical context and maxBuffer:1: the memo returns all twenty bytes, whereas a fresh execFileSync throws ENOBUFS. Repeat the cached call with stdio:'ignore': it returns the cached Buffer, whereas fresh execution returns null. Both differences were reproduced against the actual wrapper using in-memory memo storage and real child stdout. Memo hits must honor these options or bypass caching when their contracts cannot be preserved.
   - Claude's re-check: The memo-hit path returns cached bytes before any exec. The key doesn't include maxBuffer or stdio, and nothing checks them on a hit. A later call with a smaller maxBuffer, which would throw ENOBUFS fresh, gets the full output. A later call with stdio:'ignore', which returns null fresh, gets the cached Buffer.

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
