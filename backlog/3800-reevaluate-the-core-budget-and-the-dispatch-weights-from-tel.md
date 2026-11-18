---
bornAs: xukmbh0
kind: story
size: 3
parent: "3383"
status: open
relatedTo: ["3737", "3611", "3612", "3725", "3727", "3785"]
scope: ["we:scripts/lib/lane-concurrency.mjs", "we:scripts/operations/host-sampler.mjs", "we:docs/agent/platform-decisions.md"]
dateOpened: "2026-09-21"
tags: []
---

# Reevaluate the core budget and the dispatch weights from telemetry and ratify a lanes-per-hardware-profile formula

Reevaluate the core budget and the dispatch weights from telemetry, and ratify a formula for the number of lanes per hardware profile. Operator, 2026-09-21: "Ok for the suggested core sharing, we will reevaluate as data comes through". Design-first and deliberately not cleared for the conveyor. Relates #3737 (the review cadence, authority and rollback for changing a limit; this card is the first concrete reevaluation, and adds the per-kind weights and the per-hardware formula that #3737 does not name), #3611 (the staged admission project) and #3612 (the lane ceiling).

## FOUND (2026-09-21)

- **The budget is provisional.** The statute `we:docs/agent/platform-decisions.md#heavy-command-admission-queue` marks it "PROVISIONAL, to be re-evaluated from telemetry, not a ratified constant": a portion of host cores reserved for the system and VS Code, a heavy pool of 2 slots x 4 vitest threads = 8 cores, a worker dispatch cap of 3. The orchestrator has since worked to a weighted budget of 6 units (review 0.25, light task 0.5, prepare 1.0, build 1.5, capacity calibration exclusive); that rule is in the orchestrator's local notes, not the repo, and it disagrees with the statute's flat cap of 3.
- **Its own evidence was thin and contaminated.** The statute rests on 18.6 hours of samples (2026-09-20 13:06 EDT to 2026-09-21 07:41 EDT). Orphaned `eleventy --serve` processes from lane-3 (about 100% CPU each) ran until they were killed on 2026-09-21, and the operator's photo dedupe inflated the macOS system class. The "about 2 cores for the system" assumption also read too low in the samples the orchestrator took (system-macos 2.3 to 3.8 cores).
- **The data now exists.** The sampler (`we:scripts/operations/host-sampler.mjs`, on the prototype branch, schema 2, reloaded 2026-09-21) records heavy-run episodes, a hardware profile, command classes, worker lifecycle and the rollups `reservation-inputs` and `lane-load-model`. Its commands `lane-load`, `pressure` and `calibrate` are present. The per-worker samples were small (for example 12 reviews and 12 tasks live at once on 2026-09-21).
- **The number is set in three places that can drift.** The statute's flat worker cap, the lane ceiling in we:scripts/lib/lane-concurrency.mjs (#3612, hardware-blind by its own header) and the orchestrator's weighted rule.

## DESIGN TO SETTLE

1. **Which clean window counts.** From first clean data (after the eleventy kill and the end of the photo dedupe, which the operator has to confirm) for 5 to 7 days, first checkpoint 2026-09-22 about 13:06 EDT, then again after the schema 2 data has a few days.
2. **What is being set.** The reserve for the system, the heavy pool size and thread count, the worker budget and each dispatch kind's weight, and the lane ceiling.
3. **The formula.** Lanes and worker budget as a function of the hardware profile (cores, performance and efficiency cores, memory), not a constant for one the host.
4. **Evidence and authority.** Use the `reservation-inputs` rollup as the evidence; changes go through #3737's record-and-rollback rules and the operator applies them.
5. **One home for the numbers**, so the statute, the lane ceiling and the orchestrator's rule cannot disagree.

## Finding (2026-09-21): three cards now cover the process this one names

Operator, 2026-09-21: "keep adjusting as we learn. Suggest adjustment regularly, create a process that survives handoff" and "Do we need heavy worker and light worker count?". This card stays the first reevaluation and the per-hardware formula. Design point 5 (one home for the numbers) is built by card 3807 (the tracked `dispatch-budget` config, each change a reviewed commit with a dated reason). The regular suggestion is card 3808 (a read-only `capacity-review` operation returning raise, hold or lower on the runner tick, shown in `/wip`). The heavy-versus-light count question is the open decision 3806 (default: one weighted budget plus the heavy pool). The "which clean window counts" point (design point 1) needs the annotation reader that card 3808 lists as missing.

## Done when

1. **Observable, dated** — at the first checkpoint (2026-09-22, about 13:06 EDT) and again after 5 to 7 clean days, `node we:scripts/operations/host-sampler.mjs lane-load --json` and its `reservation-inputs` rollup are recorded on this card with the clean-window bounds (excluding the eleventy and photo-dedupe period). The evidence is the rollup, not a reading taken at one moment.
2. **Executable** — once ratified, `we:scripts/lib/lane-concurrency.mjs` computes the lane ceiling and worker budget from the hardware profile with one function; a test feeds it the recorded host profile and asserts the ratified numbers, and a second profile (for example 8 cores) asserts a different, smaller result. Fails today: the ceiling is a fixed count.
3. **Assertable** — the statute `we:docs/agent/platform-decisions.md#heavy-command-admission-queue` drops its PROVISIONAL marking and names the ratified formula and where its telemetry lives.
