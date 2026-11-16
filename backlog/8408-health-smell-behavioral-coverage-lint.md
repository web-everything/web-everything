---
bornAs: xk9p6fr
kind: task
status: open
dateOpened: "2026-11-16"
tags: [conveyor, testing]
scope:
  - we:scripts/check-standards-rules.mjs
  - we:scripts/conveyor/health-smells/__tests__/
---

# Require behavioral coverage for health-smell readers and sanitizers

PR #6913 review identified a default-reader path assertion that only matched production source text, alongside untested sanitizer and read-budget promises. The repair adds real-file, bounded-IO, hostile-input and episode-to-notification tests. Prevent the same coverage gaps in future smells.

Acceptance:
- Add a standards lint that flags tests which read production source and use a regex assertion as the sole proof of runtime reader behavior. Allow explicit structural checks alongside behavioral fixtures.
- Require a named hostile-input fixture for health-smell sanitizers, covering control characters and output caps; determine whether a shared reusable fixture or a narrow lint gives the clearest enforcement.
- Keep the Forge default-reader byte-budget and missing-telemetry-to-breach episode integration regressions in the standard affected-test gate. Mutations removing the cap, the sanitizer, finding severity, or the escalation notification must fail those tests.

This is prevention work from the six findings in the 2026-11-16 review of PR #6913. Runtime repairs and their regression gates are in that PR; this task covers broader lint enforcement.
