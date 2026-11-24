## Label timeline and clearance race fixtures

Label timeline fixtures keep GitHub's opaque node `id` for deduplication. GitHub GraphQL's
LabeledEvent/UnlabeledEvent expose no `databaseId`: pin their supported query selections and
exercise timestamp/connection-order fallback with opaque IDs. The planner can also accept numeric
`eventId` from other inputs. Exercise missing/non-decimal event IDs and reversed removal/re-add
arrays: latest selection and clearance baselines must use the same order.
Clear-human fixtures advance or fail the live head read during each ledger append and assert
that no subsequent write occurs. New undelegated approval rows bind to their witnessed head;
persisted rows without `headSha` retain legacy behaviour. Scoped regressions live in
`pr-label-mirror.test.mjs`, `review-set-label.test.mjs`, and
`delegated-approval-binding.test.mjs`; run them through heavy admission.

The `record-verdict` transport takes the operator-approved head explicitly as
`--expectedHead=<full 40-hex head SHA>` alongside `--operatorInstruction` for `--to=clear-human`.
It never infers clearance authority from a saved review or a newly read head.
`scripts/operations/__tests__/record-verdict.test.mjs` covers request validation;
`scripts/operations/__tests__/record-verdict-cli.test.mjs` drives both CLI adapters through
staging the JSON request. The applier carries that pin to `review-set-label` as `--expect-head`.
