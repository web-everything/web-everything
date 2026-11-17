---
name: index-std
description: Authoring web standards, intents, protocols, adapters: native-first default, standards bodies are upstream, intents UX-only, protocol first-class + minting, adapters/polyglot reach, author in the standard’s own form, dimension vs fixed mechanic + most-flexible default, AI-over-contract, minimize lock-in, behavior/element + droplist taxonomy, catalogs auto-render. Recall when designing or authoring a standard, intent, protocol, adapter, or dimension.
metadata:
  type: reference
---

Standards · Intents · Protocols · Authoring cluster — open a leaf with `node scripts/memory-resolve.mjs <N>` (or `--cat`):

- 16. Vocabulary Completeness-Early — dimension designed in full when members settled in prior art; #1463
- 35. webexpressions Binding Already Exists — WE ships a `{{ }}`/`[[ ]]` binding layer; not greenfield; #792
- 37. Behavior "Can Do" vs Element "Is A" — behavior=headless verb; element/block=styled noun (→`we-`); #1457
- 66. Authoring Standard Workflow — feature-inventory tables, bold-defaulted open decisions, registry+adapter patterns
- 73. Impl Is Not A Standard — a native API/substrate=impl satisfying the standard, not a protocol entry; #020
- 75. Native-First Default — built-in defaults align to web-platform standards; libraries are opt-in
- 76. Standards Bodies Are Upstream — Open UI/WHATWG/W3C=upstream collaborators; native primitives shrink WE
- 77. AI Over A Contract, Not The Artifact — good AI=dev-time layer over a codified contract; not disposable UI artifacts
- 78. Config Extends Platform Default — defaults live in a project config extending a platform config; tool default-less
- 79. Minimize Lock-In; Protocol Is The Lock — refuse project-facing formats; devtools=zero lock-in
- 80. Authoring SoT = The Standard Form — FUI authors in the standard's own form, never a lowering engine; #1377
- 82. Adapter-As-Normalization-Hub — 2nd adapter direction: ingest incumbents into a lossy internal pivot; never project-seen
- 83. Polyglot Reach via Forward Adapters — contracts reach enterprise (.NET/Java/Go) via forward adapters; RATIFIED #463
- 85. Dimension vs Fixed Mechanic — expose a fork as a dimension only if BOTH branches are legit end-states
- 86. Most-Flexible Default — dimension default=most permissive; restriction=opt-in
- 89. Intent UX-Only, Technical→Configurator — intents UX-only (no impl refs); technical→Configurator domain
- 91. Protocol Is First-Class — Protocol=top-level entity owned by a Web Project; surfaced via /protocols/
- 92. Catalogs Auto-Render From JSON — /protocols/ & /intents/ render from registry; new surface=page+nav+note+validator
- 93. Protocol Mint Needs Owning Project — minting needs ownedByProject; verify owner before batchable; #1486
- 99. Intents Open Design — intents=never-finished open system; standardize the meta-schema, not the list
- 100. Harvest Cross-Cutting Paradigms — researching a component: extract reusable paradigms as candidate intents
- 111. Droplist Traits Model — droplist=abstract family, dropdown=member; HTML-first; traits=component/behavior/provider
- 123. Conventions Fold Into Compliance — WE never mandates conventions; ships a default vocabulary via webcompliance
- [Composition DX adoption gap](composition-dx-adoption-gap.md) — framework-parity composition is adoption-critical; per-case rubric = #1963; gap = stacked zero-DOM composition
- [Propose standards in platform shape](propose-standard-in-platform-shape.md) — WE proposals take the SHAPE of the closest native standard (`type=` is-a, not colon/top-level attrs); #1983
- [Internal spelling ≠ proposed standard](internal-spelling-not-the-proposed-standard.md) — ship collision-safe internal spelling, mark NOT-the-proposal, config as bridge; never `we-*`; #1987
- [Host-is-the-node default](host-is-the-node-default.md) — presentational custom element IS the node (ElementInternals, no sub-element); wrap only for irreplaceable-native; #2028
- [Comment-directive example is non-rendering](comment-directive-example-is-nonrendering.md) — use context-provider (zero render effect), NOT if/for-each (those are template directives); #1989
- [Declared over auto-derived format](declared-over-auto-derived-format.md) — prefer declared over clever auto-derivation (fragile); keep it a convention/house style, not a mandate; #2074
- [Reserve structure for real families](reserve-structure-for-real-families.md) — grep native's convention before a collision rule; native smashes multi-word attrs; family-less → single-hyphen; #1991
- [CLA before outside contributions](cla-before-outside-contributions.md) — no outside contribution is accepted until a CLA is in place
