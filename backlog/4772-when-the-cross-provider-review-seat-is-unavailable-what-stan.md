---
bornAs: xb1e9nj
kind: decision
parent: "4936"
status: resolved
dateOpened: "2026-10-03"
dateStarted: "2026-10-03"
dateResolved: "2026-10-03"
codifiedIn: "docs/agent/platform-decisions.md#cross-provider-seat-fallback"
tags: [review, independence]
---

# When the cross-provider review seat is unavailable, what stands in for it?

Story for the Codex mandatory seat ships fail-closed: if Codex is quota-held or fails, a Claude-authored PR's accept parks review:human. Options: (A) keep that park; (B) wait for the Codex hold to lift, then re-run, parking only after a bound; (C) count a different Claude model (for example Opus judging a Sonnet-authored PR) as independent. C is the same question decision xud2hha (open in PR #3771) asks for the judge seat; rule them together.

## Context

Story 4880 adds a blocking Codex seat to every PR with Claude-authored commits. Codex is effectively uncapped (`WE_REVIEW_SEAT_CAP_CODEX=5000` in the review daemon plist), but it still has quota holds and outages. Quota holds are recorded through `we:scripts/lib/provider-quota-hold.mjs`. Gemini and Antigravity are off, so no third provider exists today. When Codex cannot sit, 4880 marks the run `independence.crossProvider: unmet`, and `reviewLoopAutoConfirm` declines the unattended accept. That is option A, and it is what ships until this is ruled.

## Fork 1 — what stands in for an unavailable cross-provider seat?

- **(A) Park for a human (what 4880 ships).** Strictest: no same-provider clearance ever. Cost: every Codex outage turns Claude-authored accepts into operator work, and the cost grows with the outage.
- **(B) Wait, then park — default.** Keep the run parked as `review:pending` and re-dispatch when the hold's reset time passes. The reset time comes from the existing quota-hold record. Park `review:human` only after a bound, for example 24 hours or two failed retries. Keeps independence strict and the human queue small. Cost: a delayed land, plus a re-dispatch rule in the review daemon.
- **(C) A different Claude model counts.** For example, Opus judges a Sonnet-authored PR. Cheapest. Weakest: same vendor, same training lineage, and likely shared blind spots. The independence rule (`we:scripts/lib/review-independence.mjs`) is about actors, and C would stretch "different provider" to mean "different model". It should be ruled together with xud2hha's option C, so the review seat and the judge seat cannot disagree.

**Skeptic:** B only helps if outages are short. If Codex holds routinely last more than a day, B becomes A with extra latency. Measure the hold durations from the quota-hold history before ruling.

Not prepared yet: it needs `/prepare` (a research topic on hold durations and prior art for provider diversity in review) before the operator rules it.

## Ruling (operator, 2026-10-03)

Operator: "Ok to wait, make it a configurable dimension".

- **Fork 1 → (B), expressed as a configurable dimension, not a baked mechanic.** The default is to wait for Codex for a bounded time, then park the PR for a human (`review:human`).
- The policy is the `crossProviderFallback` dimension under [config-extends-platform-default](../docs/agent/platform-decisions.md#config-extends-platform-default), with values `park-now` | `wait-then-park` (default) | `same-provider-other-model`, plus a wait-timeout parameter (`waitTimeoutMs`).
- `park-now` is option A. `wait-then-park` is option B. `same-provider-other-model` is option C and is an explicit opt-in only; it is never the default.
- Declared in `we:config/defineConfig.ts` (type + key) and `we:config/platformDefaults.ts` (default value and default timeout). The review daemon consumes it; that impl is card 4880.
- **Decision xud2hha follows this ruling.** The operator answered "Ok" to "the judge follows the same cross-provider rule": Claude-authored PRs get a Codex judge, Codex-authored PRs get an Opus judge. When the cross-provider judge is unavailable, the same `crossProviderFallback` dimension applies. xud2hha lives only on open PR #3771 and is not edited here.
