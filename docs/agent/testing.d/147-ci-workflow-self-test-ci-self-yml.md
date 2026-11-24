## CI workflow self-test (ci-self.yml)

An edit to `ci.yml` is never run by its own PR: the ruleset pins the workflow from main. Before a
`clear-human` on a workflow edit, run `gh workflow run ci-self.yml --ref <branch>` and cite the green
run id in the clearance comment. `ci-self.yml` is manual dispatch only and calls the branch's own
`ci.yml` (`workflow_call`), so checks are named `self / <job>` and never satisfy or shadow the required
`test`, `smoke` or `daemon-soak`. GitHub only dispatches a workflow that exists on main, so this works
after the first merge. `scripts/ci/__tests__/ci-self-workflow.test.mjs` parses the YAML to keep the
contract (triggers, local call, no required-name collision). Merge-gate enforcement is a later card.

