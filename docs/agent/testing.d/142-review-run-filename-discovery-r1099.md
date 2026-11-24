## Review-run filename discovery (R1099)

`review-run-names.fs.test.mjs` covers 6,000 real files, full-scan parity across PR-keyed names,
legacy parsing, in-place corruption, shared parse budgets, filename churn, archive
claims and age-gated archives. Run it with `review-run-index.test.mjs`,
`drain-red-team-evidence.test.mjs`, `archive-closed-review-runs.test.mjs`, and
`red-team-skip-settle-r622.test.mjs` through heavy admission.

`writeRun` validates keyed filename/payload identity before atomic publication.
Archiving keeps keyed filename/payload PR mismatches live in `kept.mismatch`,
including dry-run proposals. `archive-closed-review-runs.test.mjs` covers old
mismatched files, matching numeric/string PRs, claim-time mismatch rollback,
and CLI mismatch counts and IDs. Legacy IDs retain their existing behavior.
Discovery lists every review-pr ID without name-based exclusion, using the ordinary
scan order, parse cap and liveness bounds. Every examined candidate is
parsed; keyed ID, operation or PR disagreement holds through fallback. Compare
names around parsing, retry once on churn, then use the bounded scan and HOLD.
Claims or a nonempty target archive require operator restoration before absence
can be proven. Archives default to closed/merged terminal records at least 14 days
old under `archive/review-pr/<owner>/<repo>/<pr>/`; race fixtures explicitly use
`minAgeDays: 0` to exercise fresh-record claims. The probe CLI is
`scripts/review-run-probe.mjs --probe <repo>#<pr> [--head=] [--runs-dir=]`.

Filesystem mtime fixtures must restore numeric seconds (`mtimeMs / 1000`), not a
`Date`: Date truncates fractional milliseconds and cannot verify unchanged mtime
at sub-millisecond precision. The retained JSON index sidecar is expected; the
filename contract removes journal JSONL and seals, not the existing index writer.
