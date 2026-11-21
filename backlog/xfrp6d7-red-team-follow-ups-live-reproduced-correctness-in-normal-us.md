---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/resource-pool-io.mjs", "we:scripts/lib/resource-pool.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7181 (head e8d35fcae)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7181 (reviewed head `e8d35fcae15fe9159d4de4ef08e462fcf0685967`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/resource-pool-io.mjs:324` — (edge-case, degraded) Legacy review decisions double-count the same running jobs
   - Scenario: With four running review jobs, the reviews source contributes four holders and the rounds source contributes those same four jobs again. With legacy cap 8, the collector records legacyDecision='hold' because count is 8. The actual liveReviewRoundBudget reports live=4, max=8, left=4. Conservative pool accounting may intentionally overlap, but the legacy comparison should record 'grant'; recording hold/hold hides the pool's disagreement with existing admission.
   - Class: live-reproduced (basis: Executed the production collector body with injected complete source results and repository settings. Separately executed the existing round-budget and process-count functions against four review-job process entries, with platform/operator overrides isolated.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:scripts/lib/resource-pool.mjs:37` — (failing-input, degraded) The configurable class-4 reserve is ignored by allocation
   - Scenario: Set classes[4].reserve=28, leaving other defaults unchanged. Call grantDecision with budget=30, held=[], class=3, size=6 and builderFloor=4. It returns 'grant', leaving only 24 units despite the configured 28-unit builder reserve. The documented class-4 reserve should prevent this grant; currently only builderFloor protects builders.
   - Class: live-reproduced (basis: Executed the exported grantDecision directly with this valid configuration and observed decision='grant', unknown=false. The settings registry explicitly describes resourcePool.class.4.reserve as reserved builder units in shadow allocation decisions.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
3. `we:scripts/lib/resource-pool-io.mjs:112` — (failing-input, degraded) An empty-object builderFloor bypasses invalid-settings detection
   - Scenario: Supply resourcePool settings with mode='off' and builderFloor={}. loadPoolSettings returns unknown=false, mode='off' and builderFloor=4. Cascade flattening silently drops the empty object before integer validation, and the projection only checks object-valued per-class bounds. Invalid builderFloor evidence should produce unknown shadow mode, as other malformed bounds do; instead this input suppresses shadow logging and appears valid.
   - Class: live-reproduced (basis: Executed the production loadPoolSettings body with the actual cascade implementation and injected settings. The empty-object input returned valid off mode, while the control input builderFloor='bad' correctly returned unknown shadow mode.)
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
