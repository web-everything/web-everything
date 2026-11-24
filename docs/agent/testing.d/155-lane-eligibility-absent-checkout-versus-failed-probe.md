## Lane eligibility: absent checkout versus failed probe

`lane-pool-acquire-growth.test.mjs` covers both a removed lane directory and a removed
`.git` entry: skip those candidates without blocking bounded growth or touching the
remaining files. Only ENOENT proves absent metadata. Existing checkouts with failed
status/history/ahead probes remain ineligible and block growth/recovery; keep the
negative cases in `lane-pool-acquire-skips-unpushed.test.mjs` alongside this coverage.
That suite also publishes a fresh free-list hint before removing the directory or `.git`,
then checks bounded growth with and without `--no-reset` and absence of quarantine evidence.
The `lane-acquire-skips-unpushed` soak break replays the vanished-hint case through the real CLI.

The private deadline replay in `lane-acquire-default-wait.mjs` executes the production
acquire loop in a VM. When that loop adds a dependency, update the replay's context too:
import pure policy helpers and inject private IO for lease/history checks on growth and
recovery candidates. Keep explicit output bounds on Git and CLI children in soak replays.

