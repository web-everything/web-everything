## Red-main timeout policy

`scripts/settings/test-timeout-policy.json` owns timeout values; the pure evaluator
resolves `all`, job, then test file through the shared policy cascade.
`runnerKillAtHard: false` permits only a kill exactly at soft to use the G1 exception.
The quarantine entry records G1 and the G2 file-level skip loss. This is an adapter
with recorded conformity losses, not full SHIP-TMO conformance.

Safety-net JSONL now includes typed output records alongside `wouldDo` snapshots.
Consumers of decision snapshots must select `wouldDo`, rather than parse the whole
file as one JSON object. Only published entries count in `tests[file].softQuarantines`;
shadow runs record outputs without contributing to escalation counts.

The policy is a standalone spec document, excluded by name from the generic conveyor
settings merger and its registry. Its file-keyed `tests` scope intentionally contains
dots; ordinary conveyor settings still reject dotted keys. Its own reader takes the
unconfigured, alerting path when the policy cannot be read.

Release requirements (`passesUnderSoft: 3` or `approvalRequired`) are advisory
metadata only. They do not gate removal: entries currently expire at their TTL or
are removed by the existing green-main/operator paths. The pre-mortem mitigation
is therefore escalation plus bounded TTL; release after three passes is pending
release-enforcement hardening, not a guarantee of this slice.

Timeout detection accepts only a complete runner timeout error on the first
nonblank line after a named failure header. Quoted assertion diagnostics do not
qualify. Reasons are short summaries; full outcomes and policy sources remain in
`timeout.outcomes`. Repeated fallback alerts are debounced per red window/run/mode.

Acceptance-to-test review: every acceptance sentence must name a behavioural test.
For this slice, `soft-timeout entry stops being skipped after ttlMin` covers expiry;
`replays run 45080540441 through shadow at 23:26Z and prints the expiring quarantine entry`
covers the emitted entry, alert, fix card, and fix-PR protection.
