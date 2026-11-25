---
bornAs: x155hmp
kind: story
size: 5
parent: "3383"
status: open
scope: ["we:.github/workflows/soak-replay-gate.yml", "we:.github/workflows/ci.yml", "we:config/platformDefaults.ts", "we:config/defineConfig.ts", "we:scripts/lib/ci-checks-policy.mjs", "we:scripts/ci/soak-gate-group.mjs", "we:scripts/merge-gate-check.mjs", "we:scripts/ci/check-timings-bot-only.mjs", "we:scripts/lib/hermetic-net-preload.mjs", "we:scripts/soak-replay-gate-cli.mjs", "we:scripts/lib/hermetic-tests.mjs", "we:scripts/lib/hermetic-tests-vitest.mjs", "we:scripts/hermetic-tests.settings.json", "we:scripts/conveyor/__tests__/", "we:scripts/lib/__tests__/", "we:scripts/ci/__tests__/", "we:tests/interaction/"]
dateOpened: "2026-10-03"
preparedDate: "2026-11-25"
preparedAgainstSha: "4239129c0d1d880c03cb5ffabda5225a2b2c82b4"
tags: []
---

# Required checks are hermetic: a GitHub outage or rate limit never fails a PR or turns main red

Operator ruling 2026-10-03. Live: PR #3828's required soak-replay-gate failed at 18:49Z with 'gh: API rate limit exceeded for installation', because we:.github/workflows/soak-replay-gate.yml calls the API to read the live PR body. A required check that depends on GitHub's API budget makes good code look broken, and on main it reads as main-red and blocks every PR. Fixed rules: (1) soak-replay-gate reads the PR body from the workflow's event payload (github.event.pull_request.body), not the API; this is the cheap first step. (2) Tests never call real gh or the network; they use recorded responses. Any live-GitHub test moves to a non-required scheduled group that alerts but never gates. (3) A guard fails any required test that spawns gh or opens a network socket. Configurable (config-extends-platform-default, we:config/platformDefaults.ts and we:config/defineConfig.ts): ciChecks.onGithubUnavailable = retry-then-neutral (default) | fail | skip, plus a retry budget; a neutral 'could not run' result never counts as main-red and never dispatches a fixer. Done when: soak-replay-gate passes with the API blocked; the guard catches a seeded gh call in a test; a rate-limited check reports neutral, not failure.

## Progress

Prepared 2026-11-25 against `origin/main` 4239129c0d. The goal is unchanged and only partly delivered.

**Old premise → corrected premise**

- Rule 1 is still open. we:.github/workflows/soak-replay-gate.yml still runs `gh api` for the live body in its `pull_request` step and for each PR in its `merge_group` step. The `pull_request` call came from #4479 (live body on rerun). This card's 2026-10-03 ruling is later and replaces it.
- Rule 2 is delivered. we:scripts/lib/hermetic-tests.mjs puts a fake `gh` and a `git` shim on PATH. Live tests run only in we:.github/workflows/live-tests.yml (card xcu4cqf, 2026-10-08).
- Rule 3 is half delivered. A seeded `gh` call already fails its test. Sockets do not: the only network guard is the `fetch` wrapper (we:scripts/lib/hermetic-tests.mjs:461), and it refuses GitHub hosts only (we:scripts/lib/hermetic-tests.mjs:244). The Playwright specs under we:tests/interaction/ have no guard.
- The config key is absent: no `ciChecks` or `onGithubUnavailable` anywhere in code.
- A second required-path API call was not named: we:scripts/ci/check-timings-bot-only.mjs runs `gh api` three times in the `changes` job of we:.github/workflows/ci.yml, which the required `test` check depends on.
- The live merge strategy is `drain-direct` (we:scripts/lib/delivery-platform-preferences.json), so the `merge_group` path does not run today.

**Old scope → corrected scope:** we:scripts/conveyor/reconcile-core.mjs is removed. `skipped` and `neutral` are already non-blocking in the CI-state reducer (we:scripts/operations/pr-status.mjs:92), are excluded from failing names (we:scripts/conveyor/reconcile-core.mjs:665-668), and are not main-red conclusions (we:scripts/conveyor/main-red-recovery.mjs:63). Added: the timings check, the config resolver, the merge-group evaluator and listing, the hermetic guard and the tests (see `scope:`).

Not every reader accepts `skipped`: we:scripts/lib/review-ci-gate.mjs:57, we:scripts/merge-ai-prs.mjs:576 and we:scripts/lib/merge-queue-enqueue.mjs:515 refuse it (see the note at we:.github/workflows/ci.yml:80-81). They read PR-head rows, so a `pull_request` run must never skip the gate.

## Design

**1. Pull-request path makes no API call.** In we:.github/workflows/soak-replay-gate.yml set `PR_BODY: ${{ github.event.pull_request.body }}` in the step `env`. Delete the `gh api` read, `GH_TOKEN`, `PR_REPO` and `PR_NUMBER` there. The body reaches the CLI only as `--body="$PR_BODY"`, never interpolated into `run`. The `edited` trigger already starts a fresh run when a waiver is added or removed. Delete the bootstrap branch that exits 0 when we:scripts/soak-replay-gate-cli.mjs is absent (we:.github/workflows/soak-replay-gate.yml, the `not present on main yet` block): the script is on main, so a missing script now fails. Update the workflow header comment and the usage text in the CLI.

**2. Timings check makes no API call.** we:scripts/ci/check-timings-bot-only.mjs takes its file list from git: merge base of the base branch and `HEAD_SHA`, then `git diff -z --name-status -M`, keeping both sides of a rename. Base is `refs/remotes/origin/main` for main (fetched earlier in the job) and a fetched base ref for `lane/**` (pass `BASE_REF` in we:.github/workflows/ci.yml). It does not reuse the fallback in we:scripts/lib/soak-gate-merge-base-diff.mjs that diffs against the base when there is no merge base. No merge base, a git error or an empty list fails.

The `changes` job checks out with `fetch-depth: 50`, and the main fetch does not deepen the PR's own commits. The script therefore first fetches the full, blobless ancestry of `HEAD_SHA` and the base itself (unshallow when the repo is shallow), so a long branch keeps its merge base. Fetching inside the script adds no workflow `run` step. If the build does add one, it must also update the mirror in we:scripts/operations/urgent-verify-marker.mjs and add that file to `scope:`. Use `--no-renames` if rename detection would need missing blobs; both sides then still appear. `BASE_REF` is passed only as a fully qualified refspec after `--end-of-options`.

The current script also refuses a stale run (live head differs from `HEAD_SHA`) and reads the live base ref. Without the API, it takes `BASE_REF` from the event and compares `HEAD_SHA` with the branch's current head from `git ls-remote` (fully qualified head ref), refusing when they differ or the read fails. Without the live base read, a PR retargeted from a lane to main could keep a stale `BASE_REF`. So when `BASE_REF` is not main, the script diffs against **both** merge bases (`BASE_REF` and main) and fails if either diff touches the timings file. This is stricter than today.

**3. Merge-group path applies the setting.** It still needs the API, because the event payload carries no PR bodies. A new job `soak-replay-group-eval` (`merge_group` only) runs we:scripts/ci/soak-gate-group.mjs from main's checkout and outputs `verdict` = `pass`, `fail` or `could-not-run`. It lists the group, reads each PR's title and body and runs the CLI against the head **embedded in the group** (`heads` from `readGroupPrs`, we:scripts/merge-gate-check.mjs), not the live `.head.sha` the step uses today (we:.github/workflows/soak-replay-gate.yml:180); a PR with no embedded head is `fail`. The `soak-replay-gate` job keeps its name and adds `needs: soak-replay-group-eval`. It skips only when the eval job **succeeded** and said `could-not-run`:

`if: ${{ always() && !(!cancelled() && needs.soak-replay-group-eval.result == 'success' && needs.soak-replay-group-eval.outputs.verdict == 'could-not-run') }}`

Its first step carries `if: cancelled()` (a default step would not run) and exits 1, so a cancelled run never reads `skipped` or `success`. It may then read `failure` instead of `cancelled` until the newer run for the same head reports. On `merge_group` it passes only when the eval succeeded with `pass`. A crashed eval, even one that already wrote an output, or an empty verdict fails the gate. On `pull_request` the eval is skipped, so the gate always runs.

The listing currently hides the errors this classification needs: we:scripts/merge-gate-check.mjs swallows the queue GraphQL failure, turns a failed commit-to-PR read into `[]`, and `--list-group` then prints only "membership incomplete". `readGroupPrs` must also return the failed `gh` stderr as data. An incomplete listing is `could-not-run` only when there is at least one failed `gh` read classified unavailable **and** every incompleteness reason is caused by such a read. Any other incomplete listing is `fail`, including one with no `gh` failure at all (no commits, or a commit that a successful read maps to no PR; `groupMembership`, we:scripts/lib/merge-gate-ci.mjs). A list left empty wholly by unavailable reads follows this rule (`could-not-run`); "empty group" in Design 4 means empty for any other cause. The build pins both with a test.

An Actions job cannot conclude `neutral`. The neutral result is therefore a `skipped` `soak-replay-gate` job plus a `::warning title=could not run::<reason>` annotation from the eval job. Branch protection, the CI-state reducer, the failing-name filter and the main-red list treat `skipped` as they treat `neutral` (the stricter PR-head readers in Progress never see this result). No check run is created through the API, because that call would hit the same exhausted budget.

Consequences of the ruled default, to be repeated in the build PR: a skipped required check lets GitHub's merge queue merge the group **without the group re-check**, relying on each PR head's own verdict. Under `drain-direct` there is no `merge_group` run, so the setting has no live effect today. The required `test` check can still fail in an outage at job setup (app-token mint, checkout).

**4. What counts as unavailable.** Only a failed `gh` call whose own error line shows a rate limit with its status (`gh: ... (HTTP 403)` or `(HTTP 429)` plus GitHub's rate-limit message), an HTTP 5xx, or a network/timeout error. The bare phrase match of `isRateLimitShaped` (we:scripts/lib/gh-throttle.mjs:948) is too loose to use alone: "rate limit" elsewhere in stderr, or with another status, is `fail` and has a test. Everything else is `fail`: 401, 404, permission 403, unparsable output, an empty group, a group incomplete for any reason other than those unavailable reads (Design 3), a missing merge base, a failed `git` call, a missing script. A red verdict for any PR wins over `could-not-run` for another.

**5. Setting.** Add `PLATFORM_CI_CHECKS_DEFAULTS` to we:config/platformDefaults.ts: `onGithubUnavailable: 'retry-then-neutral'` and `githubRetry: { attempts: 3, maxWaitSeconds: 120 }`. Add the `ciChecks` dimension to we:config/defineConfig.ts. we:scripts/lib/ci-checks-policy.mjs mirrors the defaults (test-pinned) and reads the `ciChecks` key of we:webeverything.config.json from main's checkout, so a PR cannot loosen its own gate.

- `retry-then-neutral`: retry within the budget, then `could-not-run`.
- `fail`: first unavailability is `fail` (today's behaviour).
- `skip`: first unavailability is `could-not-run`, with no retry. (The ruling names the value without defining it; this reading is the preparer's assumption.)
- Unreadable file or invalid value: behave as `fail` and name the reason. An absent key means the platform default.

**6. Socket guard.** `installHermeticGuards` (we:scripts/lib/hermetic-tests.mjs:405) also wraps `net.Socket.prototype.connect`, which `http`, `https`, `tls` and `fetch` go through (the build proves each with a test). Loopback addresses, `localhost` and local socket paths pass. Anything else records a violation and throws, so we:scripts/lib/hermetic-tests-vitest.mjs fails the test even if the error was swallowed. UDP is guarded the same way (`dgram.Socket.prototype.send` and `connect`). The live suite stays exempt.

The `hermeticDebt` exception is removed, because a debt-listed file today has its `gh` calls recorded but not failed. Fix the four listed files with fixtures and empty the list in we:scripts/hermetic-tests.settings.json. Non-Node children: `curl`, `wget`, `ssh` and `nc` get PATH shims like the fake `gh`, refusing non-loopback targets. `child_process` spawns that pass a fresh env get the preload and shim PATH re-added. `net.connect` passes its arguments to `Socket.prototype.connect` as a normalized array, so the wrapper must read that form.

Child Node processes (soak scenarios fork daemon hosts) get the same guard from we:scripts/lib/hermetic-net-preload.mjs, added through `NODE_OPTIONS=--import` with an absolute, URL-encoded `file:` URL (children change directory and paths may hold spaces), keeping existing options. It records into the same per-file violation log as the `gh` shim, so the parent test fails, as any other violation.

For Playwright, add we:tests/interaction/test-base.ts exporting a `test` with an automatic fixture that routes at context level, aborting and recording every non-loopback request and WebSocket, then fails the test. It must also cover the `request` fixture and any manually created context, or refuse their use, and set `serviceWorkers: 'block'`, because service-worker requests bypass routing. All seven specs import it, and a meta-test refuses a spec that imports `test` from `@playwright/test` directly.

## Ruled loosenings

Three effects weaken today's behaviour because the 2026-10-03 operator ruling requires them. The build must not widen them, and its PR must name them.

- Default `retry-then-neutral` ("a neutral 'could not run' result"): a merge group can merge without the group re-check.
- The `skip` value ("retry-then-neutral (default) | fail | skip"): the same, on the first unavailable read.
- Rule 1 ("reads the PR body from the workflow's event payload ... not the API"): re-running an older run replays its older body, which can restore a removed waiver or miss later bug-fix wording.

## MVP

Musts:

- Design items 1 to 6.
- **On error, refuse:** only the positively classified causes in Design 4 may become `could-not-run`.
- **Every input kind stays cautious:** the loosening covers GitHub API unavailability only. Docs, config, data and card-only changes get the same verdict as source changes. A PR body, config value or diff never selects the neutral path.
- Rewrite the tests that pin the old transport (we:scripts/lib/__tests__/soak-replay-gate-workflow.test.mjs, the soak-replay case in we:scripts/lib/__tests__/merge-gate-ci.test.mjs, the API cases in we:scripts/ci/__tests__/check-timings-bot-only.test.mjs).
- Run the full unit and soak suites with the socket guard on. Give each offender a fixture so its assertions stay in the blocking suite. Only a test whose claim is about live GitHub itself may go to `liveSuite.tests`, with a reason. Never add anything to `hermeticDebt`.

Out of scope:

- Gates whose evidence exists only on GitHub (we:.github/workflows/merge-gate.yml, review-gate) stay fail-closed. This card does not loosen them.
- Job setup that depends on GitHub itself (checkout, app-token mint, caches, artifacts). See Follow-ups.

## Edge cases this change must handle

1. **Untrusted text** — the PR title and body pass only through `env` into `--title=`/`--body=` arguments, including a body that starts with `--`, holds backticks or `$(…)`, has CRLF, or is null. API error text in the warning annotation has newlines and `::` neutralised so it cannot issue workflow commands.
2. **Truncated reads** — an incomplete group list is `fail` unless it is wholly caused by unavailable `gh` reads (Design 3). The git diff sets a large `maxBuffer`, and overflow is `fail`. A truncated or non-JSON PR read is `fail`.
3. **Shared state files** — n/a: each job writes only its own step outputs; no shared file is added.
4. **Fail closed** — Design 4 and 5: an unknown error, invalid setting, crashed eval job, empty verdict or missing script never passes. A socket whose target cannot be determined is refused.
5. **Identity scoping** — each group PR is judged with its own body and base/head shas. Socket violations carry the running test's id.
6. **State over time** — re-running an older run replays that run's event body, so it can differ from the current body. This is the accepted cost of rule 1; the `edited` run for the same head carries the current body. The retry budget is bounded and below the job timeout.
7. **Who wrote it** — the setting and the evaluator come from main, never the PR ref, on the merge-group path. Rate-limit wording inside a PR title or body never classifies as unavailability; only the failed `gh` process's own stderr does.

## Test plan

Each failure case asserts its specific message or logged call, not only a nonzero exit. Cases marked *pin* already pass today and guard against regression.

- A rate-limited group **listing** (GraphQL or commit-to-PR read) gives `could-not-run`; the same listing with a 401 gives `fail`, and so does an incomplete listing with zero `gh` failures. RED: the error is swallowed.
- Workflow `pull_request` step with a `gh` that exits 1: exit 0 for a waived body, exit 1 for an unwaived daemon fix, and no `gh` call logged. RED today: the step calls `gh` and exits 1. Cases include null, CRLF and `--`-leading bodies.
- we:scripts/ci/__tests__/soak-gate-group.test.mjs (new): rate limit, 5xx and timeout give `could-not-run`; 401, 404, permission 403, bad JSON and empty group give `fail`; one red PR plus one unavailable PR gives `fail`; each setting value and the retry count with an injected clock. RED: module absent.
- we:scripts/lib/__tests__/ci-checks-policy.test.mjs (new): default, override, invalid value, absent key, mirror equals the TypeScript defaults. RED: module absent. The `ciChecks` type in we:config/defineConfig.ts narrows `onGithubUnavailable` to the three values; the run-time test does not type-check it, and `defineConfig` already accepts any key at run time.
- Workflow shape: the gate job has the exact `needs`/`if`, its first step fails a cancelled run, and a missing or `fail` verdict, or a failed eval, exits nonzero. RED: no eval job. *Pin:* a `skipped` row among green rows reduces to green with no failing name.
- Timings check with a fixture repo and a `gh` that exits 1: a clean diff passes, also on a shallow clone of a branch with more than 50 own commits. RED: it calls `gh` and exits 1. An edited timings file (including by rename) and no merge base each fail with their own message. RED: today the message is the generic API failure.
- Socket guard: `net`, `http`, `https`, `tls` and `fetch` to a TEST-NET address are refused, also when swallowed over UDP, from a child Node process (including one given a fresh env) and from a shimmed `curl`; a previously debt-listed file's `gh` call fails; a group PR whose live head moved is judged on its embedded head; loopback (including the normalized-array form) and a local socket path pass. RED: the connect is attempted.
- Playwright: a spec makes a non-loopback request and asserts the recorded violation names that URL (a bare expected failure would accept any error); the meta-test names a spec that bypasses the fixture. RED: no fixture.

## Proof plan

1. Before and after: run the real `pull_request` step script locally with a `gh` that prints `HTTP 403: API rate limit exceeded for installation`. Record exit 1 before and exit 0 after.
2. On the build PR itself, show from the `soak-replay-gate` and `changes` job logs that neither runs `gh api`. Add then remove a waiver without a push and record both `edited` runs.
3. Run the evaluator with the same fake `gh` and record `could-not-run` and the annotation, then with a 401 and record `fail`. State plainly that a live merge-group run is not possible under `drain-direct`.
4. Seed a test that opens an external socket, record it passing or merely erroring before and failing with `EHERMETIC` after, then remove the seed. Do the same with a seeded external request in one interaction spec.
5. On a throwaway branch, run a `push`-triggered copy of the two-job `needs`/`if` shape in real Actions and record the gate's conclusion for `could-not-run` (skipped), `fail`, a crashed eval and a cancelled run (never skipped or success; note whether a superseded same-head run briefly reads red). Delete the branch. If this cannot be run, say that the skip behaviour is unproven.

## Follow-ups

- Existing soak-replay evaluator gaps found by the audit, unchanged by this card and each worth its own card: rename source paths are dropped by `parseNameStatus` (we:scripts/soak-replay-gate-cli.mjs); Git-quoted paths are not decoded (no `-z`); any non-deleted file under the soak `breaks/` directory, even a README, satisfies the gate.

- Outage handling for job setup that needs GitHub (checkout, app-token mint, sibling checkout, cache and artifact steps) in required jobs.
- Residual of rule 3, to be filed as its own reinforce-later card: sockets opened by native binaries invoked by absolute path, or by binaries without a PATH shim. Closing it needs OS-level network isolation of the test job.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/soak-replay-gate-workflow.test.mjs`: the `pull_request` step gives the correct verdict with the API blocked and makes no `gh` call.
- [A2] **Executable** — `npm run test:unit -- we:scripts/ci/__tests__/check-timings-bot-only.test.mjs`: the required timings check works with the API blocked and refuses when git evidence is missing.
- [A3] **Executable** — `npm run test:unit -- we:scripts/ci/__tests__/soak-gate-group.test.mjs`: a rate-limited, 5xx or timed-out merge-group read reports `could-not-run`, not failure.
- [A4] **Executable** — `npm run test:unit -- we:scripts/ci/__tests__/soak-gate-group.test.mjs`: every other error, and any red PR, fails (the fail-closed path).
- [A5] **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/ci-checks-policy.test.mjs`: the default is `retry-then-neutral` with the retry budget, `fail` and `skip` behave as declared, an invalid value behaves as `fail`, and the mirror matches the TypeScript defaults.
- [A6] **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/soak-replay-gate-workflow.test.mjs we:scripts/lib/__tests__/merge-gate-ci.test.mjs`: the gate job skips only when the eval succeeded with `could-not-run`, never on `pull_request` or a cancelled run, and fails on an empty verdict (the never-red, never-fixer reader cases are regression pins).
- [A7] **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/hermetic-tests.test.mjs`: a required test that opens a non-loopback socket, itself or through a child Node process, fails (the existing seeded-`gh` case is a regression pin).
- [A8] **Executable** — `npm run test:interaction -- we:tests/interaction/hermetic.spec.ts` (new spec, absent today): a non-loopback browser request fails a required interaction test.
