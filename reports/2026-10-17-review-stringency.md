# Review stringency — evidence, outside models and source verification
**Date**: 2026-10-17
**Point**: Evidence and prior art behind the review-stringency decision, with each outside source marked verified, corrected or unverified.
**Plan file**: none (operator request, 2026-10-17)
**Research page**: `/research/review-stringency/`
---
## Question
How strict should review be per defect class and release level, and how is deferred work tracked?

## Our record (14 days, web-everything repo)
- 5,971 unique findings on 869 PRs; 42 classes; labels are model judgement.
- Top classes: missing test 794, weakened guard 336, doc drift 291, card test missing 277, parser edge 264, fail-open 248.
- 780 findings reached a ruling: block 414 (53%), card 77 (10%), not-real 257 (33%).
- Auto-block policy wrote 134 block rulings; on 126 the reviewer had ruled not-real.
- Only 51 of 341 parseable changes-requested comments had a single cause.
- Security-class findings (secret 86, injection 210, authorization 225, data loss 75, local path 12) caused no stall.
- Stall or red-main causes: timeouts, performance, races, non-hermetic tests, recovery paths, counters, wiring.

## Source verification
- Verified: Fowler quadrant; Fowler interest sentence; Google SRE error budget policy; Pearce arXiv 2108.09293; Perry arXiv 2211.03622; Bacchelli and Bird abstract (publication page); CWE Top 25 (2025 edition); Sonar new-code quality gate (about-new-code page); ISO 25010 page (edition inferred).
- Corrected: DORA has five metrics (adds deployment rework rate; recovery metric renamed failed deployment recovery time); AIDev abstract has no rejection reasons, so the scope-rejection claim is dropped; Mozilla bug fields page defines no must-fix blocking flag; the Sonar clean-as-you-code URL is dead.
- Unverified (dead URL or content absent): IEEE 1044-2009 page, IBM ODC page, ASVS level definitions, Mozilla tracking-flags page, Kruchten and SEI register fields.

## Decision
See the decision card for the forks and recommended defaults.
