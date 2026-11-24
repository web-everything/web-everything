## Canonical audit before opening PRs

`open-pr` and direct `pr-land` require the canonical codex-audit JSONL evidence, including in dry runs
and for docs-only changes. They resolve the local PR source to a full SHA and use the shared canonical
evaluator and origin/main coverage check. The record file comes from the same settings the audit writer
reads (`scripts/settings/prototype-load.json` beside these scripts), never the target checkout's, so
sibling-repo PRs work. WEAKENED requires a `ruledWeakened` waiver matching ref, full SHA and findings
exactly, from the same layers `prototype-load` reads: those settings, platform preferences, or the
operator ops store (`ruled-weakened-add`). Another head cannot supply the audit.

