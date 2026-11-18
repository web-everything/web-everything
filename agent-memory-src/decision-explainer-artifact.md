---
name: decision-explainer-artifact
description: For design rulings, build a small side-by-side visual explainer artifact (options + recommendation), not prose — the operator called it a keeper
metadata:
  type: feedback
---

**ALWAYS present a decision as this preview — automatically, for EVERY decision, not only when
asked** (the operator, 2026-07-19: "always present decision as a preview please"). The moment a decision
is prepared or surfaced for his ruling — design, placement, or mint — build the preview and hand over
its URL; do not wait for a "launch the decision preview" request, and do not surface a decision as a
wall of prose. (Lightweight execution-sequencing choices like "sequence i vs ii" are not decisions in
this sense.)

When a decision needs the operator's ruling, present it as a **small separate
artifact** that shows the options side by side: mini replicas of the affected surface
(same design tokens), the difference isolated between panes, a before/after table when
it's a system rule (color grammar, spacing, verbs), the honest counter-argument for the
status quo, and one bolded recommendation ("my take"). Example: the "green triple duty"
color-grammar explainer in the #2522 launch-review mockup session (Jul 2026).

**Why:** He explicitly flagged the pattern as a keeper to feed into the AI design
tools/product — "I really like to be offered options like this." It extends his standing
discussion-not-multiple-choice planning preference into visual form: he rules on a
rendered comparison instead of imagining one from prose.

**How to apply:** One self-contained HTML file with its OWN artifact URL (never
overwrite the main mock's URL — the explainer is a sibling, not a version). Reuse the
mock's tokens so panes look like the product. Screenshot-verify it like any mock and
include honesty notes from the pixels (e.g. "in dark these two hues sit close").
Structure: name the tension → numbered meanings with on-screen examples → side-by-side
panes → grammar table → counter-argument → recommendation. Also captured in the build-UI
skill-learnings working doc.
