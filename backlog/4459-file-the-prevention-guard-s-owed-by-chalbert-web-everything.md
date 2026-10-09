---
bornAs: x0e7udq
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/sweep-orphan-backlog-cards.mjs", "we:scripts/operations/__tests__/sweep-orphan-backlog-cards.test.mjs", "we:docs/agent/testing.md"]
dateOpened: "2026-09-29"
preparedDate: "2026-10-09"
preparedAgainstSha: "e071391e43da1e5283dc3c24a1dd11cded126d59"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2901's independent review

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/sweep-orphan-backlog-cards.mjs:474-507` — Test bounded content-validation exhaustion and explicitly refuse to commit unless a validation pass succeeded. Document the exhausted-case convention for bounded retry loops.
2. `we:scripts/operations/sweep-orphan-backlog-cards.mjs:441-452` — Before acquiring a lane, refuse if any open PR has a head branch beginning with `lane/orphan-card-sweep-`. Test re-running while an earlier sweep PR remains open; the current session-specific branch is constructed at `we:scripts/operations/sweep-orphan-backlog-cards.mjs:530`.
3. `we:scripts/operations/sweep-orphan-backlog-cards.mjs:247-251` — Assert the complete exec options object for the documented cwd, timeout and noninteractive environment guard. Record this testing convention in `we:docs/agent/testing.md`.
4. `we:scripts/operations/sweep-orphan-backlog-cards.mjs:252-254` — Fetch with an explicit destination refspec and test both its argv and the resulting remote-tracking ref. The current test at `we:scripts/operations/__tests__/sweep-orphan-backlog-cards.test.mjs:231-235` asserts the old branch-only fetch.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2901@39c76fd99f3671069a724a79a9f115b16182ea40

## Done when

1. **Executable** — Run the focused suite through `node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/operations/__tests__/sweep-orphan-backlog-cards.test.mjs` and the standards gate through `node we:scripts/readiness/heavy-admission.mjs run -- npm run check:standards` (remove repository prefixes when executing from the WE root). The new exhaustion, pending-PR and explicit-refspec assertions fail against the pre-change source and pass with the implementation. Complete-options assertions detect removal of any documented guard.
2. Exhaustion and pending/unknown PR state prevent lane publication; acquired lanes still release, and the source clone remains read-only.

## Progress

- Preparation inspected checkout `e071391e43da1e5283dc3c24a1dd11cded126d59`. The goal is not already delivered: the loop still falls through to commit after five unsuccessful passes (`we:scripts/operations/sweep-orphan-backlog-cards.mjs:343`, `we:scripts/operations/sweep-orphan-backlog-cards.mjs:474-511`), and acquisition follows dry-run handling without a PR lookup (`we:scripts/operations/sweep-orphan-backlog-cards.mjs:441-452`). Source history includes review fix `39c76fd99`, but the current source retains these gaps.
- **Old premise:** review-time citations pointed to lines 420, 470, 168 and 245 of `we:scripts/operations/sweep-orphan-backlog-cards.mjs`; the fetch guard was described as a missing test. **Corrected premise:** the live sites are cited above; there is already an argv test, but it locks in the branch-only fetch. Tests cover a successful second validation pass and all-survivors-dropped, not exhaustion with survivors remaining (`we:scripts/operations/__tests__/sweep-orphan-backlog-cards.test.mjs:496-561`). The main-read stub records options but asserts only cwd (`we:scripts/operations/__tests__/sweep-orphan-backlog-cards.test.mjs:210-235`). A branch-only fetch is not proof of a stale ref under ordinary fetch configuration; the missing guarantee is an explicit remote-tracking destination independent of that configuration.
- **Old scope:** sweep source plus its existing test file. **Corrected scope:** those same files plus `we:docs/agent/testing.md` for the two expressly owed conventions. Every source change maps to the existing `we:scripts/operations/__tests__/sweep-orphan-backlog-cards.test.mjs`; no new shared helper or global lint is needed. Size remains 3: one orchestration module, its existing injected-IO test harness (`we:scripts/operations/__tests__/sweep-orphan-backlog-cards.test.mjs:371-383`), and a short convention entry. No dependency change is proposed.
- Preparation used source and test inspection only; implementation, red/green execution and stamps remain for the runner/build stages.

## Design

- **Bounded validation:** track whether a report actually returned `ok: true`. Set that flag only immediately before the success break. After the loop, return `fail('content-check', ...)` with an exhaustion reason and accumulated dropped cards unless the flag is set. Keep the existing no-survivors success return and finally-based lane release. Do not add a sixth attempt or let the later verification gate substitute for validation before commit.
- **Re-run guard:** retain the existing session-specific branch scheme and implement the review's pre-acquisition refusal. After survivor selection and the dry-run return, read all open PRs for this checkout's repository through the injected exec seam. Use paginated `gh api` pull-list requests, resolving repository context from `cwd: REPO_ROOT`, filtering head refs locally by the literal `lane/orphan-card-sweep-` prefix. Do not treat `--head` as a wildcard search or inspect only the first page. Bound each subprocess with `ACQUIRE_TIMEOUT_MS`; any failed request, invalid JSON or invalid response shape returns an explicit `open-pr-check` failure. A matching open PR returns that refusal with its number and URL, before acquiring a lane, copying files or creating scratch space. Empty/fully deduped and dry-run paths retain their current no-op behavior. This prevents sequential re-runs while a PR is open; it does not claim atomic exclusion between simultaneous starts.
- **Exec contract:** in the existing test file, compare each main-read exec options object with `{ cwd, timeout: ACQUIRE_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }`. Include fetch, ref verification, both grep calls and show. Assert complete options for the new PR lookup too. Use returned call logs for assertions so production catch blocks cannot swallow assertion failures in an exec stub.
- **Fetch destination:** replace the branch-only argument with `refs/heads/<branch>:refs/remotes/origin/<branch>`, derived from the existing origin-ref match. Keep fetch before ref verification and reads; propagate fetch failures through the existing read-main path. Preserve custom non-origin refs without fetching and preserve the current noninteractive options.
- **Conventions:** add a short entry to `we:docs/agent/testing.md`: bounded loops that break only on success need an explicit exhausted-case return before side effects, tested with work remaining; comments promising exec guards require whole-options assertions. Link the sweep regression examples. A repository-wide lint or helper extraction is unnecessary for these guards.

## MVP

1. Add the focused failing regressions in `we:scripts/operations/__tests__/sweep-orphan-backlog-cards.test.mjs`, updating the existing scripted orchestration calls to include the open-PR check.
2. Implement the validation-success flag, paginated pre-acquisition PR check and explicit fetch destination in `we:scripts/operations/sweep-orphan-backlog-cards.mjs`. Preserve returned result shape, read-only clone behavior and release cleanup.
3. Document the two conventions in `we:docs/agent/testing.md`, then run the focused suite and standards gate through host heavy admission. No production sweep or PR publication is required to build this guard.

## Test plan

All matching source tests live in `we:scripts/operations/__tests__/sweep-orphan-backlog-cards.test.mjs`.

- Supply six distinct valid orphan fixtures. Make each of the five validation reports implicate one different surviving card, leaving one survivor after the last pass. Assert exactly five checks, `ok: false`, step `content-check`, an exhaustion reason, five dropped cards, no commit/verify/open-pr/queue call, and exactly one release. Test success on the fifth pass separately to catch an off-by-one refusal. Retain existing early-success and all-dropped cases.
- Return an open sweep PR with a different session suffix: refuse before acquire and before any write. Exercise a matching PR on page two after a full first page, unrelated open branches, an empty list, malformed response data and command failure on a later page. Closed/merged PRs are excluded by the open-state request. Assert exact request state/pagination, cwd and timeout, and that only the no-match complete response proceeds. Preserve empty/deduped/dry-run cases with no PR query.
- Replace the existing branch-only fetch expectation with the full refspec; test origin/main, another origin branch, and a non-origin ref. Assert whole options objects on every main-read exec call, including the environment override when the parent environment has a conflicting prompt setting; restore that environment after the test.
- Add an isolated temporary local Git remote/consumer fixture in the same test file, with real Git subprocesses only for this case. Configure the consumer's fetch mapping to exclude main, advance the remote main with a prevention card, then call the real main-dedupe reader through an exec adapter. Assert the consumer's origin/main equals the advanced commit and the returned dedupe set sees its card. This demonstrates why an explicit destination is required without claiming ordinary branch-only fetch always fails. Clean temporary repositories in finally; use no network, real lane pool, real queue or forge writes.

## Proof plan

- Through the host heavy-run commands in Done when, run the new regressions against the pre-change source and retain the named failing assertions, then run them against the implementation and retain the passing summary. For options guards that already work, remove each guarded option in a temporary mutation and demonstrate the test fails; restore the source before the final run.
- Preserve call-log evidence for exhaustion and pending-PR refusal showing no commit/publication and the correct release behavior. These are probes of the actual exported orchestrator with injected external IO, not proof of a live forge transaction.
- Preserve the local Git fixture's before/after commit IDs and dedupe assertions as real subprocess evidence for fetch freshness under a restricted fetch mapping. Do not run the production sweep merely to gather proof: it acquires lanes and publishes PRs.
- Run the queued standards gate after the body/convention changes. Report any unrelated failure accurately rather than claiming a green gate.

## Follow-ups

- Simultaneous sweeps can both observe no open PR before either publishes. Atomic reservation is outside the review's sequential re-run guard; capture a separate follow-up if simultaneous execution must be supported. Do not describe this check as a lock.
- No global retry-loop lint, shared exec helper or source-clone cleanup is required here. The owed conventions and local regression tests are part of this item, not deferred work.
