---
bornAs: xdl6x9z
kind: task
status: open
dateOpened: "2026-10-14"
scope: ["we:scripts/check-standards-rules.mjs", "we:scripts/__tests__/"]
tags: [prevention]
---

# Flag private cache writes without explicit permissions

Add a scoped check:standards rule for filesystem writes into private agent state that omit explicit permission modes. The CI cache review in web-everything/web-everything#5290 found logs written with the process umask into a potentially readable directory.

## Done when

The rule flags mkdirSync and writeFileSync writes into ~/.claude/** without explicit modes. Fixtures cover 0700 directories, 0600 files, temporary files renamed into place, existing directory repair, aliases and helpers, and unrelated public output that must stay allowed. Dynamic destinations that cannot be classified should be identified for review rather than silently claimed safe.

Also require a finite retention bound for persistent caches of remote private content, including job logs. Test expiry as a cache miss, deletion of expired payloads, and cleanup/accounting of abandoned temporary files. The 2026-10-15 review of PR #5290 identified indefinite local log retention after upstream deletion or access revocation; explicit filesystem permissions do not address that separate retention concern.

The PR #5290 repair bounds serving to 24 hours from fetch, including when collection revalidation is disabled; expired and stale-generation payloads are deleted on lookup. Maintenance is opportunistic, so document that an unused cache is not erased by a background timer. Resource tests must cover a burst without clock advancement, a writer paused before rename, zero-byte metadata exhausting inodes, and rejection before base64/JSON encoding above a 16 MiB entry limit. Count temporary files and cap entry count as well as payload bytes; preserve invalidation-generation files during eviction. Distinguish an every-write soft disk budget from an atomic disk quota under concurrent writers.
