---
name: project_linear_cost_revenue_on_device
description: "Plateau hard rule — cost must scale ~linearly with revenue; a flat-subscription feature can't carry uncapped per-call external SDK cost, so prefer owned on-device (fixed-cost) capabilities; per-usage/BYO-key is a tier, not the floor"
metadata: 
  node_type: memory
  type: project
  originSessionId: fe5e3854-508c-4407-a924-091e5489cf3b
---

**Plateau monetization hard rule (author-stated 2026-06-13): cost must scale ~linearly with revenue.** A flat-subscription feature must NOT depend on an uncapped per-call external SDK (e.g. a hosted vision/LLM API) — a heavy user's metered cost can exceed their subscription, so margin goes negative on the best users. You cannot safely flat-price a feature whose cost floor is someone else's metered API.

**The resolution — owned fixed-cost capabilities at the floor.** Two ways to keep cost linear:
1. **Per-usage / bring-your-own-key pass-through** — the *consumer* carries the variable cost (this is what #086 mockup-to-standard already assumes). Valid as a TIER, but weak as the only choice: can't power a clean flat subscription, and pushes setup friction + a metered bill onto the user.
2. **Owned on-device model** — runs on the user's device → zero marginal inference cost to us → bundles into a flat subscription with no margin risk, AND reinforces the platform (a moat; less vendor lock-in [[feedback_minimize_lock_in_protocol_only_lock]]).

They compose: **on-device model as the bundled/default tier; API/BYO-key as an optional higher-quality upgrade.** Linear-safe at the floor, premium path on top.

**How to apply / standing directive:** like all work in this project, take the opportunity to reinforce the platform — prefer building an owned, on-device/fixed-cost capability over renting a per-call SDK for anything that will sit inside flat-rate pricing. The swappable-provider seam ([[project_vision_is_plateau_service_no_leakage]], #475/#480) already makes the model a provider swap, so an external API is fine as the **dev/interim** provider while the **product path targets an on-device model**.

**The clean loop (vision instance):** the design-ref corpus gate caches every (frame → verdict) pair in `verdicts.json`; big-model labels over the corpus we're already building = a **distillation dataset for a small on-device UI-screenshot classifier**. So running the API gate during WE development *also* generates the training data for the on-device model that later powers the product gate (and #086) for free. The narrow task (coarse app-vs-marketing classification, optional UI element/region detection) is well-trodden (ScreenAI / Ferret-UI / UI-element detectors / Rico-WebUI) — distillation, not a research moonshot. Persist every (frame, verdict) pair from day one so dev runs accumulate the set.

**Three framing principles for on-device-model decisions (author steers 2026-06-13 — codified in #488):**
1. **Benchmark to reach, not reject.** The AI frontier moves fast — what's infeasible today may be feasible in months. Frame each tier with a *graduation benchmark* (metric+threshold to move on-device); the hosted-API/BYO-key provider is the **always-on bridge** meanwhile. A feature is never "rejected," only "below threshold, on the bridge."
2. **Re-assess on a cadence.** A recurring re-benchmark of the small-model frontier against the targets (the #192 longitudinal / gap-sweep cadence) flips a tier on-device the moment it clears. Never a one-shot model pick.
3. **Codify training as a model-agnostic, re-applicable artifact.** Durable assets = labeled corpus + distillation recipe + benchmark suite, NOT any one trained model. Switching base model = re-run the recipe, never re-label — [[feedback_minimize_lock_in_protocol_only_lock]] applied to the model itself (model swappable, training pipeline = the moat).

Capability survey (#488, /research/on-device-ui-vision): the gate verdict is *coarse screen classification* — a ≲10MB distilled classifier runs in-browser on any device (Enrico 75% top-1 / 20 classes; ours = 6), feasible NOW; a small VLM (SmolVLM/Moondream/Florence-2, ≲2B device ceiling) is a separate heavier tier. #488 prepared (5 forks, ✓ ready to ratify).

Related: [[project_monetization_strategy]] (open-core; self-run > single-service > enterprise; defer live-serve — an on-device model is the cleanest "self-run, no hosting cost" shape), [[project_managed_offering_constellation_layering]], [[feedback_native_first_default]].

**Codified:** the canonical rule is `docs/agent/platform-decisions.md#monetization` (the statute is source-of-truth; any `#NNN` above is provenance, not the reference).
