## Review PR transport isolation (R37)

`review-job-fetch-security.test.mjs` replants URL rewrites and transport settings after the lane
scrub: the network fetch must run in a fresh bare repository with empty global/system config.
Only object data crosses back through a bounded thin-pack handoff. Keep both review entry points,
worktree/includeIf config, unborn HEAD, and refused pack/index-pack cases covered; a moved PR head
must be refused before importing objects. Do not replace this boundary with more config reject rules.

