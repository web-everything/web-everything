## Shadow reviewer agreement evidence

`promotionReplaces` names the existing seat Carbon replaces on manual promotion (default `claude`); the pure `assertCrossVendorPanel` helper checks that the resulting panel retains a non-builder vendor, with tests preserving seat count for Claude, Codex and agy builders.

The agy mandatory-seat shadows are off by default (operator 2026-10-16).
`review.shadowSeats.antigravity.enabled` / `WE_REVIEW_SHADOW_AGY_ENABLED` enables shadows only within the selected scope.
`scope` / `WE_REVIEW_SHADOW_AGY_SCOPE` defaults to `high-care`: use the read's
`earnedShape` from `review-core-cli.mjs shape`, seating elevated/high care and sensitive
escalation reasons (including human-required surfaces). Routine PRs stay unseated.
`sampled` restores the deterministic PR sample, with `sampleRate` / `WE_REVIEW_SHADOW_AGY_SAMPLE_RATE` defaulting to 0.1.
Rates must be finite numbers in `[0, 1)`; 1 is refused and the invalid layer is logged.
Selection uses SHA-256 of lowercase `owner/repo#pr` (first unsigned 32 bits below
`floor(sampleRate * 2^32)`; at least one bucket always excluded), shared across lenses and rounds. Missing PR identity does not seat a shadow.
Disabled panel rows say `agy shadow off (setting)`; unsampled rows say `off (sample)`.
Routing-policy declarations and model/trial settings alone do not enable live shadows.

`review.minNonClaudeSeats` / `WE_REVIEW_MIN_NON_CLAUDE_SEATS` defaults to 1, accepts
positive integers, and adds the Codex simplicity and then correctness advisory seats
as needed. These answers stay advisory. A skipped/unavailable answer does not count;
a shortfall (including a minimum above the two available Codex lenses) is recorded on
the verdict and printed in both the verdict write-up and human advisory note. Saved
runs retain their original roster and persisted minimum. Historical runs saved before
both `seatSteps` and `minNonClaudeSeats` existed resume with their original zero minimum;
incomplete modern policy records still use the live minimum. `review-ruling-resume.test.mjs`
pins that migration and drives a historical two-seat panel through reduction.
These settings resolve through standard → platform `review` → tool
`scripts/settings/review.json` → env, logging effective values and sources.
Validate each complete scalar before cascading: nested and empty objects, arrays,
and null must be logged as invalid and fall through. Cover every safeguard setting at
both platform and tool layers, including platform `{value:false}` against tool
`enabled:false` through directive selection: neither lens may launch a shadow.
Test the actual judge request and panel reduction with injected providers, including
zero agy calls when disabled and failed Codex answers, through heavy-admission.
Historical optional-roster fixtures explicitly use a zero declaration minimum; the
operational settings never accept zero.
Exercise historical confirmation through both `resolveOperation('review-pr', {resumeId})`
and the real `run.mjs review-pr --resume=<id>` CLI, with Codex flags off and the default
minimum, then with changed flags and a minimum of two. Both CLI confirmation paths
use `reviewSeatOptionsForRun` to keep every saved optional seat; fresh registrations
still enforce the live minimum.

`dailyCap` / `WE_REVIEW_SHADOW_AGY_DAILY_CAP` defaults to 100 sessions per
America/New_York day (zero disables launches). The runner atomically reserves a
numbered slot under `agy-shadow-agreement.jsonl.sessions/<day>/` before each
attempt, including model retries. Reservations count starts rather than completions;
quota refusals and crashes conservatively consume a slot. Slots are shared across
lanes and survive process restarts; local midnight, including DST, selects a new day.
A full budget logs `daily cap reached` and records a skipped shadow. An unreadable
counter refuses admission. Neither a cap skip nor a quota hold retries on the
routing model or adds a Claude fallback; the original mandatory Claude answer remains.
Skipped shadows have their own count in agreement and trial reports; they are neither
failures nor comparisons and do not advance the trial. A primary `agy` seat still
falls back to Claude on quota or skip results when its `onEscape` policy is `claude`.
Use temporary stores and injected admission/providers in tests, never host quota.

Gemini admission settings leave Codex advisory selection to the requested roster and the non-Claude minimum.
Tests cover primary and shadow modes with each escape policy, quota holds, quota exhaustion, and cap skips,
all runner statuses through the real row builder and both reports, unavailable
budget storage, and reserving a second slot before a model retry at the cap.

`review-runner.mjs` appends each shadow prediction through `appendVerdict` as `verdict: observed`,
`mode: shadow`, boolean `wouldClear`, and `applied: false` / `mutated: false`. The builder and reader
reject shadow metadata on bearing verdicts. The existing non-bearing fold keeps these rows in history
without changing clearance, outstanding holds, review-round counts, or live label drift comparisons.
Append failures are reported best-effort on stderr and do not abort the shadow report.

Query the durable evidence offline with
`node scripts/lib/verdict-ledger.mjs shadow-agreement --repo=web-everything/web-everything --human-actor=nic --json`.
Use the exact declared human actor stored in your verdict rows. Without `--human-actor`, only the explicit
`clear-human` ceremony is a human outcome; with it, accepted/changes rows for that actor also qualify.
Declared attribution is not identity verification. `summarizeShadowAgreement` compares the latest preceding
prediction against the next qualifying human outcome for the same repo and PR, consuming each pair once.
It reports superseded predictions and unmatched pending predictions separately. This is PR-level outcome
agreement, not proof that two reviews covered identical content, and it does not enable enforcement.
`summarizeAgreement` retains its separate ledger-versus-live-label drift meaning.

Tests redirect `WE_VERDICT_LEDGER_DIR` and `CONVEYOR_JURY_DIR` into temporary directories and drive the
runner with a read-only `gh` fixture; a file in place of the ledger directory probes real append failure.

