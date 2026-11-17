---
bornAs: xk2zls7
kind: decision
size: 3
parent: "5407"
status: open
dateOpened: "2026-10-08"
preparedDate: "2026-11-17"
preparedAgainstSha: "157f3184592f9b20aa4356a18cfd34df7f86a099"
relatedReport: reports/2026-11-17-delivery-initiative-names.md
tags: []
---

# Name the delivery initiative: umbrella, delivery protocols, platform protocols and open core

Source: AI Delivery Landscape research brief, 2026-10-08, section 'Name candidates, checked' (domain map and trademark screen, 8 Oct). Names needed: umbrella for the 'ever' standards (leading Everstandard; also Evernorm, Everaccord, Everpact); development-platform protocols (Platform Forever, platformforever.dev free); delivery protocols (Ship Evermore, shipevermore.dev free, trademark risk moderate because EVERMORE is crowded); open delivery core (Longshore recommended in round 5; also ShoreAI with moderate-to-high risk from Shore GmbH's SHORE marks, Keelway, Feluccai, Perennai, Lockgate). The screen is not legal clearance; a formal trademark search on the chosen names is owed before use (see #186). Relates to the constellation branding system #2209. Naming and trademark choices are the operator's; not ruled here.

## Chosen in chat 2026-11-15 (operator; prepared as ratify-the-existing-choice)

The names were already chosen in operator chat on 2026-11-15 (rulings R941d, R942, R944 to R948). Report: [we:reports/2026-11-17-delivery-initiative-names.md](/reports/2026-11-17-delivery-initiative-names/). Related prepared item: #5402 (the delivery standard's repo home; this card names it, #5402 places it).

| Card slot | Chosen name | Scope / status |
| --- | --- | --- |
| Umbrella for the "ever" standards | **everstandards** | GitHub org, exists (R947); standard repos grouped under it later, nothing waits on it (R946) |
| Delivery protocols | **Ship Evermore** | spelling "Evermore" (R944); no own org, repo under everstandards when created (R948) |
| Platform protocols | **Platform Forever** | second standard family, not a product; repo under everstandards when created |
| Open delivery core | **Longshore** | org longshoreai, repo longshoreai/longshore, private until #5499 (R947) |

Web Everything stays the web standard (R942 CORRECTED, repo-level); the product is Plateau (R941d SUPERSEDED entry, R160, #5488). Who chose what: the operator chose the slugs shipevermore (spelling Evermore), longshoreai, platformforever and the everstandards org (R942, R944, R947, R948); "Longshore" as the core's repo name and the layer split come from the orchestrator (R160, #5488), so the operator affirms "Longshore" itself at ratification.

## Prior-art delta (collision check, web search 2026-11-17, not legal clearance)

- Longshore: no comparable AI-delivery tool uses it (Forge, Apex, Shipwright, Shift AX, Loom checked). Ordinary English word, so class 9 and 42 search still owed.
- Ship Evermore: no direct hit; the EVERMORE word mark is crowded (Evermore Software, Evermore Technology, Soda Health; classes 9, 36, 42). Risk stays moderate, as the 8 Oct screen said.
- Platform Forever, everstandards: no hit; the nearest is an unrelated Evernode Standards repo.
- Domains platformforever.dev and shipevermore.dev were free on 8 Oct (not re-checked). npm, crates and PyPI names are unchecked; verify at first publish.

## Why this is not a fork

The names are the operator's, chosen with reasons; no coherent rival branch is excluded by any of them, so there is nothing to pick between. What remains is validation: (1) a formal trademark search on all four names, filed under #186, before any public use; (2) usage rules below; (3) the everstandards role beyond org (docs hub or not) is support-both, not a fork: an org and a docs site can both carry the name, and R946 already sets the direction (group standard repos under it later; it supersedes the docs-only reading).

## Supported by default

- Usage: Ship Evermore names the delivery standard and its repo; Longshore names the open core only (not the standard); everstandards names the org and umbrella brand; Plateau stays the product. Never use one name for two layers.
- Repo and org names stay a setting (R945), so a later regrouping is a one-line change.
- Package namespaces follow the layer owner (standard packages under the standard's name, core packages under longshore; npm scope mirrors layer, #855); registry availability is checked at first publish, not here.

## Recommendation

**Ratify the four names as chosen: everstandards (umbrella), Ship Evermore (delivery standard), Platform Forever (platform standard), Longshore (open core).** Go. Trigger for revisiting: the formal trademark search (#186) returns a blocking conflict for a name, or Longshore goes public (#5499) without the search done. The #186 search should cover the bare word EVERMORE (classes 9, 35, 42) and LONGSHORE (classes 9, 42), and also asks whether a name is generic but registrable, not only whether it conflicts. Ratifying records the ruling on this card and files the trademark search; it does not create repos.

Skeptic: SURVIVES-WITH-AMENDMENT. Ratify-only is the right class (no hidden fork; no naming/org anchor in we:docs/agent/platform-decisions.md conflicts); folded in: dropped the superseded R941d/R945 citation, corrected the everstandards role to R946, split operator-chosen slugs from orchestrator-chosen Longshore, cited #855 for namespaces, widened the #186 search scope.
Screen: clear

## Done when

1. **Executable** — n/a: a decision, no code. Tier 3 instead: the card is prepared (`/prepare`: options, rejection reasons, bold default, `preparedDate`), then the operator rules it and the ruling is recorded on the card; one name per layer is chosen, and a formal trademark search is filed or done before public use.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
2. **Truncated reads** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
3. **Shared state files** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
4. **Fail closed** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
5. **Identity scoping** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
6. **State over time** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
7. **Who wrote it** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
