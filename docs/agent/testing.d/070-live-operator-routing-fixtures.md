## Live operator routing fixtures

The shared Vitest setup sets `WE_CAPACITY_READERS=off`: default capacity observations and
the legacy Codex threshold see unknown usage, without reading host rollouts, usage files,
scorecards or rate ledgers, and ignore shipped operator readings. Inject `readers`/`quota`
for capacity cases; pass a private `env` without the switch to test persisted fixture evidence.
Production readers remain enabled unless the switch is explicitly set.

Review-seat roster fixtures must cover scoped added seats as well as exact keys. Use
`rosterForKey` at every lookup: exact settings-backed contracts win, and other `review-seat:`
keys return the shared added-seat roster by identity so provider caps still apply. Pin primary
and fallback rejection, unchanged preference bytes, and default-zero versus explicitly enabled caps.

`dispatch-routing-policy-io.test.mjs` covers rejecting schema-valid live overrides with no usable
route, retaining the last-good policy and applied-event state, and recovering on a valid edit.
The reader and writer share the route probe and provider caps from `scripts/lib`; keep that
validation ahead of reload events and snapshot mutation. Atomic writer fixtures must assert
unchanged bytes and no leftover scratch/lock files on refusal, including a failed rename.
`dispatch-routing-policy.test.mjs` pins unlisted lens and extra-juror roster identity, rejects
lookalike operation names, and checks last-good retention and recovery for unsupported scoped overrides.
The named `preserves preferences and removes scratch and lock files when rename fails` case in
`routing-override.test.mjs` injects a native rename error in an isolated child, checks the scratch
payload and held lock before failure, and proves cleanup permits the next write.
`routing-overrides.test.mjs` covers the routing reader's last-good snapshot across repo edits and
operator `routingOverrides` changes, including clearing and one event per applied change.
`routing-override.test.mjs` exercises the declared CLI and atomic preference writer with a temporary
`WE_PLATFORM_PREFERENCES_FILE`; never point write tests at the operator's real preferences.
The red-team live-reload case injects `io.readRoutingPolicy` and keeps CLI, quota and reservation
checks in the selection path. Explicit provider selection enables a default-zero provider with a
finite daily cap only when its env cap is unset; explicit env caps (including zero) remain binding.
Clearing restores the repo/env defaults on the next pass. The preference writer holds the shared
file lock across the full read-modify-write; overlapping writer fixtures must preserve both updates.
Non-judged operation declarations may use `provider` and `model` as real inputs. On judged
operations those names remain reserved juror controls; undeclared juror flags still fail closed.
Repo platform files must ignore `routingOverrides` and warn, even when the operator file has no
override; only the operator file (or its explicit replacement) can supply them. In added-seat
fixtures, enable Gemini for one seat and leave other seats inherited or with Gemini fallbacks:
only the enabled seat may use the default-zero provider. Check both synchronous and rejected
event writes: neither may prevent applying or clearing a validated policy. Agy Sonnet aliases
must resolve to an effort-suffixed catalog ID; historical persisted IDs remain readable.
Provider-disable regressions must reach `decideDispatchRoute` with an inherited task such as
`bugfix`, as well as concrete task routes and both prepare branches. Constrained inheritance
refuses with a request for an explicit provider/fallback; it must never delegate an unchecked
provider choice to the evidence router. Added review seats may retain inherited evidence selection
when their supplied candidate list excludes every disabled provider and the critical-work gate is
open. Test missing and unfiltered lists, a closed gate, and mandatory/work routes to keep that
exception confined to added seats. Review settings seats accept only Claude and agy
adapters: test rejection through the CLI before a preference write and retention of last-good
settings during live reload. Disabling the optional agy advisory seat must still allow review
initialization; exhausting a mandatory seat's routes must fail validation.

