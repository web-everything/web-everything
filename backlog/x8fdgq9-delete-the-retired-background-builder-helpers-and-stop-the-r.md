---
kind: story
size: 2
parent: "4075"
status: open
blockedBy: ["4772"]
scope: ["we:scripts/lib/daemon-background-build.mjs", "we:scripts/lib/daemon-background-build-settings.json", "we:scripts/lib/daemon-rebuild-builder.mjs", "we:scripts/lib/daemon-rebuild/rebuild-job.mjs", "we:scripts/lib/__tests__/daemon-background-build.test.mjs", "we:scripts/lib/__tests__/daemon-rebuild-job.test.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Delete the retired background-builder helpers and stop the rebuild job reading its consumed file as a corrupt job record

Follow-up of 5691 (x0m7a8x). (1) The background builder process is retired (no caller spawns it), but its record/spawn helpers in we:scripts/lib/daemon-background-build.mjs and the CLI we:scripts/lib/daemon-rebuild-builder.mjs stay, because PR #4772 held that file: delete them and their tests once #4772 lands, and drop the builder-only `buildMinIntervalMs` key (the built-in default, its env override and the key in we:scripts/lib/daemon-background-build-settings.json; nothing reads it since the builder retired); keep the other settings, the swap spacing and the tick-starved smell. (2) Live 2026-10-10 fix-daemon log: every rebuild-job tick logs 'daemon-jobs: job record consumed is corrupt' because we:scripts/lib/daemon-rebuild/rebuild-job.mjs keeps its consumed-ids file (consumed dot json) inside the job store dir, which the run store lists as a job id. Move it out of the listed names (a dot-file) and add a test.

## Acceptance

- [A1] **Executable** — `npm run test:unit --` on we:scripts/lib/__tests__/daemon-background-build.test.mjs,
  we:scripts/lib/__tests__/review-daemon-first-pass.test.mjs and we:scripts/lib/__tests__/daemon-rebuild-job.test.mjs passes,
  with a new rebuild-job test that queues and consumes a job, then lists the job store and asserts no record is
  reported corrupt (it fails before: the consumed-ids file is listed as a job id); and
  `rg -n "makeBuilderApi|spawnBuilder|decideBuilderStart|daemon-rebuild-builder" scripts` finds nothing.
- [A2] **Live** — a fix-daemon log covering at least 3 rebuild-job ticks has no `job record consumed is corrupt` line.

## Non-goals

- [N1] Does not change the swap spacing, the tick-starved smell or their settings (they stay in
  we:scripts/lib/daemon-background-build.mjs), nor the re-clone fail-closed rule in we:scripts/lib/daemon-self-sync.mjs.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: no external input; only local job-store file names.
2. **Truncated reads** — a truncated consumed-ids file reads as empty (a job is consumed at most once more, which the
   adopt pass already tolerates); the test pins it.
3. **Shared state files** — the consumed-ids file is shared by every daemon on the clone: write it with tmp + rename,
   as today; an old file at the previous name is read once for migration, then removed.
4. **Fail closed** — n/a: deleting dead helpers removes no guard; the moved file keeps its read/write semantics.
5. **Identity scoping** — the file stays per job store (one per clone), never shared across clones.
6. **State over time** — on first run after the change the old-name file is migrated, so no finished job is consumed
   twice across the upgrade.
7. **Who wrote it** — n/a: only the rebuild job's tick side writes it, as before.
