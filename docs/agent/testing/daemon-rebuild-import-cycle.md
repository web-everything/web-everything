## Daemon rebuild import initialization

Keep `prepare.mjs`'s main-sync conflict-reader import lazy: the sync worker imports
`daemon-self-sync` and rebuild, closing an initialization cycle. The unchanged
`daemon-rebuild-fallback.test.mjs` env-var identity assertion catches the resulting
Vitest-only undefined dispatcher export; removing its planner namespace import does not.
