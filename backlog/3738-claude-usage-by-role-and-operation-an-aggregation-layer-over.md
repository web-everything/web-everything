---
bornAs: x65vpsg
kind: story
size: 8
parent: "3383"
status: open
scope: ["we:scripts/operations/claude-otel-collector.mjs", "we:scripts/operations/run-store.mjs"]
dateOpened: "2026-09-20"
tags: []
---

# Claude usage by role and operation: an aggregation layer over the collected OTel data

GOAL (operator, 2026-09-20): see Claude token and cost usage broken down by role (main session, subagent) and by operation (build, fix, review, prepare and so on). CAPTURE ALREADY WORKS: the collector receives numeric token and cost counters from every session on the machine (attributes include session id, query source main or subagent, model, effort, token kind). THE MISSING PIECE is the query layer; related open item 3671 covers tool-use counting only and its own hooks cannot see an Agent call. DESIGN TO SETTLE BEFORE BUILD (strong design required): (1) SIGNAL: the OTel query source attribute is the only reliable main-versus-subagent signal; confirm it on real data before relying on it. (2) ATTRIBUTION JOIN: map session id to an operation using the dispatch slug grammar (review, fix, ci-heal, conveyor, prepare with the item or PR number) and the run records in we:scripts/operations/run-store.mjs; unmapped sessions report as unattributed, never guessed. (3) SOURCES: OTel day files plus per-Codex-dispatch token records plus per-judge usage in run records, reconciled so nothing is counted twice. (4) DEPENDS ON the collector data-root fix (one shared root) or the aggregation must read every lane root. (5) PRIVACY: numeric only; identity attributes (email, account id) are dropped from any output; never persist content. (6) OUTPUT: a CLI report by day, role, operation and model with USD cost, plus a JSON form; whether a short line appears in wip is a separate decision. ACCEPTANCE: a fixture reproduces per-role totals; report totals reconcile with the raw files within 1 percent; unattributed share is reported.

## Design review (jury, 2026-09-20, careLevel elevated): panel ran, all seven lenses returned findings

The panel completed (7 seats, $0.41) but its launcher failed to relay the result (see the jury launcher story), so the harness reported it as unreviewed; the findings were recovered from disk. All seven lenses agree the design needs these changes before it is cleared.

1. **Counter semantics unstated.** Say whether the OTel counters are deltas or cumulative, and how exporter re-sends, collector restarts and per-series resets are handled; otherwise summing records overcounts. Detect temporality from the stored record, take per-series deltas keyed on session id, metric and attribute set, and add a fixture with a restart and a re-export.
2. **The join key is unproven.** The design never shows that run records store the Claude session id. Verify on real data first. Run records keyed by session id are the only authority; the slug grammar only labels an operation a run record already tied to the session. Report separate buckets: interactive (no dispatch), dispatched-but-unjoined, ambiguous, unrecognised slug.
3. **Sources double-count or mix units.** Per-judge usage in run records is probably already emitted as Claude sessions in OTel; Codex tokens are not Claude and need a price table. Ship OTel only as the first slice; add other sources later, each with a dedupe key and a precedence rule, and label every cost row as measured or estimated (under a subscription the USD is notional).
4. **Decide the root question.** Point 4 is an either-or. Either make the collector data-root story a hard blocker, or take an explicit list of roots as input, print which roots and day files were read, dedupe by file identity, state the day timezone, tolerate a torn last line.
5. **Privacy must be an allowlist.** Project each record through an explicit allowlist (session id, query source, model, effort, token kind, value, timestamp) at ingest; a denylist at output leaks any new identity attribute. Treat the input as untrusted (the receiver has no authentication): sanitise label strings, validate values, count and report skipped lines. Use synthetic or scrubbed fixtures; never real emails.
6. **Role is not binary.** Enumerate the distinct query source values in the real day files, fix a value-to-role mapping with an explicit other or unknown bucket, and report its share next to the unattributed share.
7. **Acceptance is too weak.** Reconciling totals within 1 percent only tests summation, not attribution, which is the stated risk. Add fixture cases for the join (known slug, unknown slug, a subagent inheriting its parent operation, a session with no run record), assert exact per-role and per-operation truth, require the buckets to sum to the grand total exactly, and add an independent cross-check against one hand-audited session.

## Additions from 2026-09-24 incident review

Operator proposal 6 ("cost tracking per daemon/bot") lands here. The /telemetry page (#3943) already shows usage by model and role but not by who spent it or what it bought. Two additions to the output:

- **A daemon dimension.** Since #3870/#3876 each dispatch kind has one owning daemon (review daemon: `review-*`; fix-dispatch daemon: `fix-*`, `ci-heal-*`; dispatcher: `conveyor-*`, `prepare-*`; interactive: none). Report usage per daemon as a fixed mapping from the operation, so "the review daemon spent X this week" is one line.
- **Cost per outcome.** Divide each daemon's usage by what it produced in the same window: PRs reviewed, fixes pushed, items landed (from the drain history and the run records). Retries after a failure count against the daemon that caused them. On 2026-09-24 a 401 cascade and stuck sessions re-dispatched work many times; per-outcome cost is what would show that.
- **Show it on /telemetry**, as a new row group, once this operation exists. That is a follow-up slice under #3943, not part of this card.
