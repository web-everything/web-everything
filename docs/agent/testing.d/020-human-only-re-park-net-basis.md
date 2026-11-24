## Human-only re-park net basis

The human-surface sweep uses `readHumanSurfaceNetFiles` over the shared `readNetFileSets` reader.
Unlike the scope reader, this gate requires a successful fetch of current `origin/main`; cached refs
following a failed fetch cannot prove the absence of a sensitive change. Test inherited-main identity
files separately from the PR's own identity edits (#5381). On an unavailable net basis, a complete
GitHub files API list below its 3000-file cap with no human-only hits skips the PR. A sensitive hit,
cap-sized list, malformed list or failed list read still fails closed. Inject a sweep-wide net outage
across several accepted PRs with clean lists and assert zero re-parks, including in the soak fixture.
The fallback provider must retain both rename paths: moving a workflow to an ordinary directory
still removes a human-only surface. Count both paths conservatively against the API cap.
Inject net reads into sweep and soak
fixtures so synthetic heads never cause real network fetches. `review.humanSurfaceUsesNetDiff`
(default true) resolves through the policy cascade; false explicitly restores the legacy list decision.
Public comments use fixed failure reasons; raw git diagnostics stay in local logs. Test fetch,
merge-base and diff failures containing private paths and remote URLs, plus thrown reader errors.
Every fail-closed branch needs a named test, including successful-looking net results with missing
or non-string file arrays, including sparse arrays whose empty slots `.every()` skips. Validate both
net and fallback lists with the same check. Deterministic reader tests must reject branch/worktree mutation commands;
real-git fixtures must preserve HEAD, branch, index, status and dirty file contents around each read.
Review checklist: for each new fail-closed path, does the failure mode scale per PR or per sweep?

