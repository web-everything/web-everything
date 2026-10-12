---
bornAs: xgxo1sx
kind: story
size: 3
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/lib/drain-workflow-edit-hold.mjs", "we:scripts/__tests__/drain-workflow-edit-replay.test.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs", "we:scripts/lib/__tests__/drain-workflow-edit-hold.test.mjs"]
dateOpened: "2026-10-12"
tags: []
---

# Prevention — Add a replay test through buildDrainVerdicts where the listing is ['we:archive/ci.yml'] and the p… (from web-everything/web-everything#4965 review)

Filed mechanically by the unattended review loop (#2749) — every finding below reduced web-everything/web-everything#4965's review (reviewed head `1615528782a34adcbf1c868e40416a8b22bbb736`) to prevention-outstanding by naming a guard neither captured nor filed:

1. `we:scripts/merge-ai-prs.mjs:1953` — Add a replay test through `buildDrainVerdicts` where the listing is `['we:archive/ci.yml']` and the pinned diff includes a workflow path, expecting park. Or treat any listing row whose `changeType` is RENAMED, or whose paths look like a move out of a gated prefix, as incomplete and force the pinned read.
2. `we:scripts/merge-ai-prs.mjs:5237` — Add a `merge-ai-prs-required-check-read`-style CLI test where `CHECK_PR.files` includes a workflow path under `--no-review-escalation`, asserting the report shows skip and `humanRequired`. A check:standards rule requiring every new `runCli` gate to cite a spawned-CLI test would catch the whole class.
3. `we:scripts/lib/drain-workflow-edit-hold.mjs:9` — Add the drain/merge-gate settings files to the human-only path list (the shared GATE_PATH_PREFIXES, or a check:standards rule), with a test that a PR touching them is held.
4. `we:scripts/__tests__/drain-workflow-edit-replay.test.mjs:57` — Add the named regression to the unit-test gate, using a short stale non-workflow listing and unavailable local recovery; require defer with no label regardless of clearance.

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
