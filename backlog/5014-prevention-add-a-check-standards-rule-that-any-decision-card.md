---
bornAs: xtg1dcx
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:docs/agent/platform-decisions.md", "we:backlog/4999-per-test-flake-score-and-a-time-boxed-quarantine-for-the-req.md", "we:backlog/5008-add-the-auto-value-tighten-only-rule-and-bound-fields-to-the.md"]
dateOpened: "2026-10-03"
tags: []
---

# Prevention — Add a check:standards rule that any decision card adding a settings layer or override channel must name… (from chalbert/web-everything#3838 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:docs/agent/platform-decisions.md:5983` — Add a check:standards rule that any decision card adding a settings layer or override channel must name the writer and the gate class (review:human) that protects it. A review lens is the fallback.
2. `we:backlog/4999-per-test-flake-score-and-a-time-boxed-quarantine-for-the-req.md:16` — When a card routes a failure around a failure-handling path, require a Must line that names the trusted signal source and a bounded retry count. A card-lint rule could enforce the shape.
3. `we:backlog/5008-add-the-auto-value-tighten-only-rule-and-bound-fields-to-the.md:17` — Make check:item reject a story whose Done-when still holds the TODO placeholder when its body states a refusal or never-guarantee. The hint text suggests the rule exists but is not enforced for filed stubs.
4. `we:backlog/5008-add-the-auto-value-tighten-only-rule-and-bound-fields-to-the.md:13` — Add a deterministic backlog gate requiring stories with pending prerequisites to carry a resolvable dependency or an explicit machine-readable scheduling hold until the prerequisite can be linked.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3838@357976881258a3d6395c01e395918c7c328ff421

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
