---
name: no-gemini-reviews-until-v4
description: Gemini (incl. via Antigravity) takes no PR review seat until Gemini 4; its reviews raised false CONFIRMED findings that looped reviews for hours.
metadata:
  type: feedback
---

Do not seat Gemini as a PR reviewer — not as an extra review seat and not as the Antigravity review seat — until Gemini 4 is out and proven. Antigravity Claude may review again once it has usage, but Gemini-backed review stays off.

**Why:** operator, 2026-10-02: "I think Gemini might be too weak for review for now until v4", then "review from agy are not reliable … well, more Gemini". Live evidence: the gemini-3.1-pro seat claimed a CONFIRMED bug that did not exist (an undeclared variable at pr-status.mjs:179 that is declared at line 172), which looped PR #3432's review about 80 times overnight; Antigravity Claude seats all failed with quota-exhausted the same day.

**How to apply:** keep `WE_REVIEW_SEAT_CAP_AGY_GEMINI=0` and `REVIEW_PR_ANTIGRAVITY_REVIEW=0` on the review daemon (set 2026-10-02) until the default-off code change lands; when routing reviewers, pick Claude or Codex. Gemini stays fine for other work only where its value is proven (see [[gemini-only-where-confident-of-value]]).
