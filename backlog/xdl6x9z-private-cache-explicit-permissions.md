---
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
