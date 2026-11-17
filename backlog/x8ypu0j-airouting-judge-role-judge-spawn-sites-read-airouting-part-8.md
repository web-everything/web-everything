---
bornAs: x8ypu0j
kind: story
size: 3
status: open
dateOpened: "2026-11-16"
scope: ["we:scripts/operations/cli-adapter.mjs", "we:scripts/lib/judge-spawn.mjs", "we:scripts/lib/codex-judge-spawn.mjs", "we:scripts/lib/jury-core.mjs", "we:scripts/lib/judge-panel.mjs", "we:scripts/conveyor/referral-reverify.mjs"]
tags: []
---

# aiRouting judge role: judge spawn sites read aiRouting (part 8)

Judge spawn sites (cli-adapter, judge-spawn, codex-judge-spawn, jury-core, judge-panel, referral-reverify) pass aiRouting as an optional resolver input; inherit = no behaviour change, proven by a parity test.

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/lib/__tests__/ai-routing-judge-sites.test.mjs` fails before and passes after; with aiRouting unset or "inherit" every judge site routes exactly as today (parity), and a set value only reaches the resolvers that already accept aiRouting.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] No change to we:scripts/lib/ai-routing.mjs, the review role sites, or account routing.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: routing inputs only, no new input surface; unreadable or invalid aiRouting falls back to inherit.
2. **Truncated reads** — n/a: routing inputs only, no new input surface; unreadable or invalid aiRouting falls back to inherit.
3. **Shared state files** — n/a: routing inputs only, no new input surface; unreadable or invalid aiRouting falls back to inherit.
4. **Fail closed** — n/a: routing inputs only, no new input surface; unreadable or invalid aiRouting falls back to inherit.
5. **Identity scoping** — n/a: routing inputs only, no new input surface; unreadable or invalid aiRouting falls back to inherit.
6. **State over time** — n/a: routing inputs only, no new input surface; unreadable or invalid aiRouting falls back to inherit.
7. **Who wrote it** — n/a: routing inputs only, no new input surface; unreadable or invalid aiRouting falls back to inherit.
