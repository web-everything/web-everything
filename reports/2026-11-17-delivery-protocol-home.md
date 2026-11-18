# Delivery protocol home: separate repo now, or incubate inside Web Everything (#5402)

Prepared 2026-11-17 for decision #5402 (parent epic #5407).

## Question

Where does the AI-delivery standard (JSON schemas, role registry, policy dimensions, glossary, conformance
cases and verifier) live while it is young: a new repo that holds only the standard, or inside the Web
Everything (WE) repo until it matures?

## Grounding in the tree

- WE rule #1282 (`we:docs/agent/platform-decisions.md#constellation-placement`): WE holds zero implementation;
  the WE project is contract, protocol, interface and conformance vectors (data). A schema-and-vectors
  standard fits that shape; a delivery engine does not.
- The same doc records implementation that leaked into WE as relocation debt (the ~10 subsystems of #1078,
  webpolicy relocated through #1294 W1-W4, webtheme #1910, the website #2006). That is the cost the brief
  warns about.
- Statute collision: `#constellation-placement` rule 1 homes contract content (types, protocol, conformance
  vectors) in WE and lists only WE, FUI, Plateau. Choosing (a) needs an explicit amendment for non-web
  standards. #2446 is still open, so it is not precedent.
- WE scope is web standards (identity, not a #1282 clause). The delivery protocol (roles, authority, handoffs, run records) is not a web
  standard; its bindings are MCP, A2A, OTel, in-toto, SARIF, Agent Trace.
- Engine and kernel home is a separate call (#2446, own repo); policy dimensions are #4376 / #4305; run record
  envelope #5348. Those cards consume whichever home this decision picks.

## Prior art (how comparable standards are homed)

- OpenTelemetry: spec repo (`opentelemetry-specification`) is separate from every SDK; the spec carries
  schemas and conformance only.
- in-toto and SLSA: attestation specs live in their own spec repos; reference implementations are separate.
- SARIF: OASIS spec with a separate schema repo; tools live elsewhere.
- MCP: `modelcontextprotocol` holds spec plus schema; SDKs are separate repos.
- Common pattern: the standard has its own home from day one, with schemas as the single source and
  implementations downstream. Incubating inside an unrelated project's repo is rare for a standard meant to
  be adopted by outsiders, because adopters will not take a dependency on an unrelated project.

## Classification (7-question pass)

1. Layer: standard (contract and conformance data), not implementation.
2. Protocol, not an intent dimension.
3. Whole axis exposed: yes, the repo is the protocol surface.
4. Fixed mechanic: the placement is a one-time call, not a config knob.
5. DI-injectable: n/a, no runtime.
6. Most-permissive default: separate home; incubating can always be done later by vendoring, while
   un-merging a standard out of WE history cannot be done cheaply.
7. Seam: WE keeps web intents; the delivery standard references WE only for the conformance-vector format.

## Recommendation

**(a) New repo now, standard only.** Engine stays where it runs until extraction (#2446).
