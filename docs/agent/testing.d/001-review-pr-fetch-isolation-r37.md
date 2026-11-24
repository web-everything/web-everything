## Review PR fetch isolation (R37)

Review PR transport runs in a fresh temporary bare repository with empty global/system
config, never in the agent-writable lane. The lane contributes only alternate objects and
one negotiation ref; a bounded binary pack/index-pack handoff imports the pinned commit.
`review-job-fetch-security.test.mjs` replants hostile local/worktree/includeIf config after
the scrub to prove isolation, and checks failed handoffs and moved heads leave the commit absent.

