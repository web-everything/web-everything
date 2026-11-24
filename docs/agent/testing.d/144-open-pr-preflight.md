## Open-pr preflight

`open-pr --check` collects audit, review/PREP enforcement and pre-push blockers without publishing, filing cards
or writing bypass receipts. `pr-land-preflight.test.mjs` runs the actual CLI with gate/forge ports replaced and
records push/create/card effects. A real refusal uses the same checkpoint. PR-limit refusal is a check-only
blocker hint: a real open evaluates capacity after pushing and leaves the ref pushed when refusing.
Park opens ready for review; draft-promotion still handles older drafts.

Check mode fetches origin main before evaluating canonical audit evidence. A failed fetch reports
`main not refreshed: <reason>` and refuses even when local evidence would pass against stale refs.
`open-pr-audit-gate.test.mjs` covers both refresh outcomes, aggregation and an unconfirmed check child.
