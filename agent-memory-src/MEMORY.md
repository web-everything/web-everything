<!-- Memory index = a TREE: each line → a category sub-index (recall-gated, loaded on demand). Open a leaf: node scripts/memory-resolve.mjs <N>. Add a rule via its sub-index, not here. -->

<!-- core-invariants: load-bearing rules kept always-loaded (each also lives in its sub-index). Open a leaf: node scripts/memory-resolve.mjs <N> -->
- 6. WE Holds ZERO Standard Implementation — FOUNDATIONAL; impl→FUI; OK in WE: definitions + validate scripts; #1282
- 96. Repo Constellation — WE (standard+plugs)→Frontier UI (impl)→plateau-app (product); legacy `plateau` ABANDONED
- 25. Platform Decisions = Statute Layer — platform-decisions.md = cite-able cluster rules; codifiedIn on resolve; #911
- 75. Native-First Default — built-in defaults align to web-platform standards; libraries are opt-in
- 95. Plug = Proposed Missing Standard — plugged=proposed standard; unplugged=safe-now; #1826/#1807
- 106. Backlog Is The Tracker — /backlog/ renders from backlog/*.md (one file per item); docs/agent/backlog-workflow.md
- 39. Never Take An Unprepared Decision — never rule w/o preparedDate; screen→/prepare or pick a prepared item; #1457
- 51. Hookable vs Judgment Rule — script-decidable→hook (deterministic); judgment stays in context; footguns first
- 9. Memory-Management Policy — index=TREE: always-loaded map+core-invariants; rules live in category sub-indexes; #1517/#1868
- 43. Enforce Shared Gate At Write-Time — PreToolUse(Edit|Write) hook scans content + denies the write; #883
- 104. Edit-Work Runs In A Lane Clone — edits land via lane-clone → ready-to-merge PR, NEVER direct to main (#2183/#2190); never branch a shared checkout; [[single-session-should-use-a-lane]]
- 105. Claim Ignores Git State — backlog ownership=status:active NOT the working tree; uncommitted edits never a drop-reason
- 148. Worker Model Routing — Sonnet default; Opus = design of hard stuff only and delegates execution; never Fable; never hand-set the model; fix limiting operations on the prototype
- 149. Operation Limit Fixed On The Prototype — an operation with a limitation is fixed on the prototype, never worked around in private notes

<!-- categories: everything else, recall-gated — open the sub-index whose keywords match the task -->
- **[Constellation & Placement](index-arch.md)** — placement · WE/FUI/Plateau · boundary · contract · impl · home · migration (21 rules)
- **[Standards · Intents · Protocols · Authoring](index-std.md)** — standard · intent · protocol · adapter · authoring · dimension · native-first (23 rules)
- **[Monetization](index-monetization.md)** — pricing · open-core · license · free/paid · cost↔revenue · on-device · assembler line (5 rules)
- **[Backlog Workflow & Item State](index-back.md)** — backlog · item state · resolve · slice · park · epic · NNN · locus (22 rules)
- **[Decisions & Forks](index-dec.md)** — decision · fork · ratify · prepare · merit · confidence · residual (24 rules)
- **[Verification & Proof](index-verif.md)** — verify · prove · probe · grounding · closure · evidence (8 rules)
- **[Batch · Commit · Git Hygiene](index-batch.md)** — batch · commit · git · stage · push · branch · claim (8 rules)
- **[Testing · Gates · Build Infra](index-infra.md)** — gate · check:standards · vitest · build · vite · hook · dev-port · footgun (12 rules)
- **[Agent Meta · Memory · Model Routing](index-meta.md)** — memory · agent · model routing · working style · context · orchestration (14 rules)
- **[Exercise Apps · Configurator · Governance](index-app.md)** — exercise app · conformance loop · configurator · governance · personas (4 rules)
