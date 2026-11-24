## Test timing ownership

The scheduled bot refresh (`.github/workflows/ci-timings-refresh.yml`, currently weekly)
owns `scripts/ci/test-timings.json`. PR authors adding unit tests or soak breaks should
leave that file to the bot. Files without entries in that shared sharding map get their
suite's median stored timing and still land in exactly one shard.

Added and renamed soak tests need neither a shared timing entry nor a timing sidecar
for PR admission. The scheduled refresh currently updates unit timings and preserves
existing soak timings; new soak tests use the median fallback until measured data
is added by a bot refresh. PR authors do not supply timing metadata.
The named test `assigns an unknown file exactly once using its suite median` in
`scripts/ci/__tests__/shard-assign.test.mjs` defends the fallback weight and unique assignment.
The precheck reads `git diff --name-status -z`, preserving Unicode, quotes, tabs,
newlines, backslashes and trailing spaces in filenames. Rename/copy scores include
Git's padded forms such as `R095` and `C075`; only destination paths count as replay
evidence. Type changes are modifications. Unmerged/unknown statuses refuse only for
daemon-soak paths; unrelated files do not supply replay evidence. An unavailable or
malformed diff still refuses admission: restore the base/source commits or resolve
the unsupported records and retry. This fail-closed diff policy is independent of
timing ownership.
The PR-open soak precheck also requires break coverage for daemon-scope bug fixes as
before. The balance diagnostic still requires measurements for every file before
claiming measured balance; it is not a PR admission requirement.

Before changing an admission gate, compare each PREP acceptance line with the net
behavior change. Every new refusal path needs explicit authorization in the card;
keep a deterministic test for admission without timing metadata so a separate
measurement policy cannot silently reintroduce per-PR timing work.
