---
bornAs: x0dmf5e
kind: story
size: 2
status: open
scope: ["we:scripts/lib/repo-scan-tests.mjs", "we:scripts/__tests__/repo-scan-tests.test.mjs"]
dateOpened: "2026-10-04"
tags: []
---

# Repo-scan tests must ignore stray VERIFY_SCAN_* env outside the verify gate

Follow-up from #3890's advisory review, approved by the operator 2026-10-04. `VERIFY_SCAN_FILES` and `VERIFY_SCAN_ROOT` are read from the ambient environment by the repo-scanning tests (`we:scripts/lib/repo-scan-tests.mjs`). A stray value in a dev shell or CI job (e.g. `VERIFY_SCAN_FILES='[]'` or a fixture `VERIFY_SCAN_ROOT`) makes multi-repo-checks / no-search-backed-pr-list pass vacuously, so unscoped CI stops enforcing the repo-slug rule. Fix: (1) honour `VERIFY_SCAN_*` only when the verify gate also sets a second marker (e.g. `VERIFY_SCAN_GATE=1`), and otherwise run full; (2) explicitly clear `VERIFY_SCAN_FILES` when running widened, full-scope scanners (Codex correctness finding at `we:scripts/lib/repo-scan-tests.mjs:165`); (3) add a test asserting that the unscoped scan is unaffected by stray env. Low likelihood, defense-in-depth.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
