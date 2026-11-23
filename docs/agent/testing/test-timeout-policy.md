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
