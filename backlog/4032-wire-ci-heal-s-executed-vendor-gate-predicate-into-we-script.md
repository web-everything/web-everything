---
bornAs: x3m311f
kind: story
size: 2
parent: "3383"
status: active
scaffoldedBy: "close-4021"
dateScaffolded: "2026-09-24"
scope: ["we:scripts/conveyor/merge-ai-prs.mjs", "we:scripts/conveyor/ci-heal-mark.mjs"]
dateOpened: "2026-09-24"
tags: []
---

# Wire ci-heal's executed-vendor gate predicate into we:scripts/conveyor/merge-ai-prs.mjs's decideReviewGate (#3850 Fork 2 residual)

#3850 Fork 2's land-seam merge hold on delegated routes is live for build and fix (#4021, landed on lane/mechanical-dispatcher at d0440d1bc), but ci-heal only got the data half: we:scripts/conveyor/ci-heal-mark.mjs stamps the real executed vendor into its durable comment and parseCiHealExecutedVendor reads it back, but nothing yet refuses land on a non-Claude executed vendor. The actual gate predicate needs wiring into we:scripts/conveyor/merge-ai-prs.mjs's decideReviewGate. Deliberately deferred in #4021 rather than a blind edit to that ~4000-line production merge gate, mirroring this repo's own #3493 precedent (built-and-tested predicate, call-site wiring held back until a real writer exists). Needed before #3443 graduates the branch to main, since without it a delegated ci-heal fix has no enforced independent look before landing.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.
