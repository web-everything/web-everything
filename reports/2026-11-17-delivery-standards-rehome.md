# Re-home delivery standards to the new initiative (#5404)

Prepared 2026-11-17 for decision #5404 (parent epic #5407). Consistent with #5402 (home of the delivery
standard; see `we:reports/2026-11-17-delivery-protocol-home.md`) and independent of #5405 (naming).

## Question

Four standards-shaped artifacts sit in WE today: the delivery policy dimensions (#4376 / #4305), the
tool-agnostic methodology protocol (#672, owned by the `webprocess` node), the work-item contract
(`we:contracts/backlog.ts`) and the review-policy contract. Do they move to the new delivery-standard home, and
which statute anchors change?

## Grounding in the tree (corrections to the brief)

- The brief says #690 ruled the methodology protocol "has no owning project". The card says otherwise: #690
  was ratified 2026-06-15 as Axis 1 = A, a first-class WE-constellation node (`webprocess`, which owns the
  `self-driven-project-artefact-contract` protocol, `we:src/_data/protocols/self-driven-project-artefact-contract.json`),
  and Axis 2 = reinforce WE and Plateau, "lives in WE, scoped to web apps initially". So re-homing does not
  just add a repo: it **reverses #690's placement ruling**, and #690 itself kept the schema domain-general so
  that generalising would be a cheap later revision. That clause is the trigger this decision uses.
- #4376 already says WE = standard (dimensions, schema, validator), engine elsewhere. That was written when
  WE was the only candidate home; it names WE as the home and so is superseded in that one clause.
- `we:contracts/backlog.ts` is NOT delivery-specific. It is the provider-agnostic backlog interlingua minted
  by #2558 (Jira / Linear / GitHub / WE backlog all map into it) and is consumed by the Plateau console as
  `@webeverything/contracts/backlog`. Moving it breaks that import path; keeping it in WE costs nothing today.
- No separate review-policy contract file exists in `we:contracts/` today (only prose in docs and
  `we:scripts/review-core-cli.mjs`); the "review-policy contract" is a future authored artifact, so it simply
  lands in the new home with no move.
- The platform statute is `we:docs/agent/platform-decisions.md#constellation-placement` (rule 1 homes contract
  content in WE and knows three homes) and `#protocol-host-project` (a Protocol requires an owning WE project).

## Prior art

Same as #5402: OpenTelemetry, in-toto/SLSA, MCP, SARIF each keep spec content in a spec home, with consumers
that mirror a type or schema downstream. A downstream consumer mirrors or re-exports the schema; it does not
force the spec to stay in the consumer's repo.

## Classification (7-question pass)

1. Layer: standard (contracts and data), not implementation. 2. Protocol. 3. Whole axis exposed: yes.
4. Fixed mechanic: a one-time placement call. 5. DI-injectable: n/a. 6. Most-permissive default: move the
delivery-specific standards, keep the cross-provider interlingua where its consumers already import it.
7. Seam: the new repo references WE only for the conformance-vector format; WE re-exports or maps the new
work-item schema when it exists.

## Recommendation

**Conditional (c): re-home the delivery-specific standards, keep the generic backlog interlingua.** Policy
dimensions, the methodology protocol and the review-policy contract go to the #5402 home; `we:contracts/backlog.ts`
stays in WE as the type-only provider interlingua, and the delivery standard's own work-item schema maps onto it.
Applies only if #5402 rules (a); if #5402 rules (b) there is no new home and this is moot (nothing moves; only the
#690 generalisation clause is noted). Statute anchors changed on ratifying (c): `#constellation-placement`
(shared amendment with #5402, applied once), the #690 ruling (Axis 1 owner moves; `webprocess` node is retired or
repointed), and `#protocol-host-project` (the `self-driven-project-artefact-contract` entry leaves WE
`protocols/*.json`, or becomes a pointer, since a WE Protocol requires a WE owner).
