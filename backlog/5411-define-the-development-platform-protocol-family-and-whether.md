---
bornAs: xyek4mq
kind: decision
size: 3
parent: "5407"
status: open
dateOpened: "2026-10-08"
tags: []
relatedTo: ["5409", "x25bedj"]
---

# Define the development-platform protocol family and whether it shares the delivery protocol home

Source: AI Delivery Landscape research brief, 2026-10-08, section 'Development platform protocols' (a working reading, to be confirmed). Delivery protocols say who does what; platform protocols describe the ground the work stands on. Candidates: workspace manifest (constellation repo list), isolated workspace lease (lane pool #1940/#1943, per-lane ports #1997), dev server discovery (lane proxy #2139), gate contract (check:standards contract #1937), platform graph (Plateau platform manager #092), dev tooling attach (dev-browser #141/#1391), mock and proxy services (#107). Forks: is this a real second family, which candidates are in v0, and does it live in the same home (the brief says the home's name must then not say 'delivery'). Operator's call; not ruled here.

## Done when

1. **Executable** — n/a: a decision, no code. Tier 3 instead: the card is prepared (`/prepare`: options, rejection reasons, bold default, `preparedDate`), then the operator rules it and the ruling is recorded on the card; /prepare also researches the prior-art column, which the brief says came from general knowledge only.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
2. **Truncated reads** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
3. **Shared state files** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
4. **Fail closed** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
5. **Identity scoping** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
6. **State over time** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
7. **Who wrote it** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.

## Update 2026-11-20 (D15, decisions page)

Operator ask (2026-11-20 20:59 ET): “note all as full decision item and run with preparation”.
Decision id: D15 (decisions page, 2026-11-20 20:58 ET)
Placement: everstandards
move-to: everstandards

### Digest / supported by default

**Platform Forever is a standard family later; for now, a preference file inside Longshore until a second team needs it (default).** This is compatible staged support, not “standard versus config” as mutually exclusive permanent architectures. It is not the Plateau product. Placement stays everstandards for this family decision; no private Plateau preference content is included here.

Context: [repo-separation brief](designs/repo-separation-brief-2026-11-20.md) §1.6 / §4.2 and [format design](designs/everstandards-format-2026-11-20.md) “Platform Forever candidates” / “Template detail”. Candidate protocols include workspace-manifest, workspace-lease, dev-server-discovery, gate-contract, platform-graph and dev-tooling-attach. The page names workspace setup and tooling attachment as team/platform preference examples.

Supported options: (a) **Longshore preference file now, standard family on the second-team trigger (default)**; (b) publish the family immediately, requiring protocol/prior-art work now; (c) permanently keep only a private config, losing the intended cross-team standard contract. The default supports local preferences and a later interoperable family together; it does not freeze the candidate list as v0.

Skeptic: “Second team” might become indefinite deferral or hard-code one team’s choices into a future standard. Preserve a clear preference boundary now, gather evidence of a second independent team’s need and survey Dev Containers, WebDriver BiDi and Backstage before fixing the public surface.
Screen: pending prep; separate the family’s merits from extraction timing and local implementation shape.
What ratifying unlocks: a bounded Longshore preference layer now and a concrete trigger for the later standard, without creating a Platform Forever repo today. Operator answers: “D15 yes”.
Prep still needed: verify the second-team trigger, map existing preference files and candidate protocols to primary prior art, and run an independent skeptic pass. Existing frontmatter/prepared state stays untouched except additive relatedTo links.
