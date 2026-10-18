---
name: feedback-edge-load-after-review-accept
description: Load a guard, fixer or drain fix on its daemon once its review ACCEPTS, without waiting for the merge; prove it on the live case
metadata:
  type: feedback
---

Load a guard, fixer or drain fix on its daemon only once its review accepts, then right away, without waiting for the merge. Prove it on the live case.

**Why:** #5461 was loaded before its review and caused false stand-downs (2026-10-16). Waiting for the merge costs about an hour per fix. Operator "Ok", 2026-10-17.

**How to apply:** Do not load a fix on its daemon while it is still under review. When the review accepts, load it at once and show before/after evidence on the live case. Do not wait for the merge to land first.
