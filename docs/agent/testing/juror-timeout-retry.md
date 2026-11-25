## Juror timeout retry

A killed juror has no verdict. Preserve `juror-timeout` plus lens, actual routing provider and model
through the loop JSON, job result, pid-bound exit marker and ended diagnosis. Never infer routing
exclusions from log text. The daemon retains unique `(lens, provider)` exclusions and timeout counts
under the exact repo/PR/head in its restart-local `dispatchState`, like `noVerdictCounts`. A new head
clears them. Old state without this map initializes it empty.

Retry only within the existing resolved routing chain and roster. Disabled providers, shadow-only
routes, unpromoted Carbon models and a forbidden vendor cannot become counting replacements.
The replacement's escape path refuses fallback to an excluded provider. Mandatory lenses remain
seated; route exhaustion holds dispatch and prints an orchestrator ask. Two timeouts followed by
exhaustion produce `review-blocked-on-infra: juror timeout x2`. If there is already no permitted
replacement after the first timeout, hold immediately (`x1`) instead of spending the excluded provider
again. Repair routing and restart the daemon, or advance the head, to reconsider that hold.

Run affected Vitest files through `heavy-admission.mjs run --wait-ms=60000`. The sleeping juror test
uses a real Node child with a short injected timeout and verifies termination. The soak break
`juror-timeout-same-provider` runs four ticks: one alternative dispatch, then a persistent hold.
Use `--config vitest.soak.config.ts` for its `.soak.test.mjs` file.

Merge-path checklist applicability:

| Line | Application and negative proof |
| --- | --- |
| 1 Producer identity | Only a matching pid's local exit marker carries timeout authority; `carries structured timeout only from the matching job marker, never from log text` rejects spoofed log text and another pid. No new GitHub producer is trusted. |
| 2 Present vs absent | `never routes from missing timeout evidence` and `refuses incomplete exclusion evidence` refuse recovery authority from incomplete inputs; no verdict is created. |
| 3 Ordering | Each dispatch's pid identifies its marker; timestamps do not select timeout evidence. The mismatched-pid test rejects another run regardless of its age. |
| 4 Read/write races | Existing job head guards remain before/after review. `never routes from wrong-head timeout evidence` refuses moved-head evidence. No new remote write is introduced. |
| 5 Head binding | Exact 40-hex marker head must match the planned head; `resets old-head timeout exclusions and holds` prevents cross-head recovery. |
| 6 Run binding | Exit-marker pid and daemon's prior dispatched pid bind evidence; `never routes from untrusted-run timeout evidence` refuses an unbound run. |
| 7 Fail-open catches | `unreadable routing holds the head and asks the orchestrator instead of dispatching blindly` covers the routing-read catch. |
| 8 Write ordering | Exclusions record observed failures, not a successful review. Existing last-dispatched bookkeeping remains after successful launch; the four-tick soak verifies no redispatch after a hold. |
| 9 Crash windows | Missing markers remain unknown infra failures and cannot yield a verdict. Recovery holds never clear the review gate; the missing-evidence test covers this closed path. |
| 10 Credentials | No new GitHub writer or credential selection; existing App-token seams are unchanged. |
| 11 Environment | No new Git/fetch/process command. Exclusions travel in argv/JSON and a child environment value; malformed/oversized values refuse instead of becoming shell input. |
| 12 Exemptions | `never skips a mandatory lens when all allowed providers timed out`, `never chooses the forbidden author vendor`, and `never promotes a shadow-only provider` cover narrowed routing. |
| 13 Liveness | The sleeping juror test observes the actual child's termination before rejecting the missing verdict. Existing process-group kill behavior is retained. |
| 14 Simplest option | A stateless retry repeats the incident. Reuse existing restart-local dispatch maps, route resolver, pid marker and job launch path; no separate retry daemon or verdict bypass. |

The exclusion bound is 128 entries; `oversized exclusions refuse with an orchestrator fallback instead
of silently truncating` requires the operator-visible refusal. Deployment and live PR recovery are a
separate operator step; hermetic tests do not establish that a live daemon has loaded this change.
