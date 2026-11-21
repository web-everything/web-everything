---
bornAs: x6hbdjq
kind: decision
parent: "5407"
status: open
dateOpened: "2026-11-20"
tags: [decision-filing, everstandards]
relatedTo: ["5405", "186"]
preparedDate: "2026-11-20"
---

# Which namespace and domain identify schemas, events and predicates?

Ask: Use everstandards.dev with one full-word slug per standard. Confirm registrar ownership before public identifiers are issued.

## Digest

Prepared, not ratified except the later source naming ruling. Two calls: umbrella authority **everstandards.dev/<slug>** and breaking-unit version ids. The prep's later `standards.namingStrategy` ruling (2026-11-21 02:51) selects full-word slugs **web, ship, platform, flow**; examples below incorporate it. RDAP is not ownership proof.

## Fork 1 — Public identifier authority

Either/or: exact-string $id/type/predicate identities cannot have two canonical hosts. Redirects do not make different ids equal.

- (a) **One umbrella domain, standard slug path and reverse-DNS event prefix (default).** Stable authority survives brand changes; brand domains may still serve docs/redirects.
- (b) Domain per standard: clear branding, but trademark-driven rename changes the authority and creates dual-namespace obligations.
- (c) GitHub/raw/github.io ids. *Excluded:* tie identity to org/repo, contrary to portable ownership (R945).

Evidence:
- `2026-11-20-es-adopted-norms` §5b; `2026-11-20-gov-stewards-legal-namespaces` §C; #5405/#186 trademark review.
- Prep RDAP/DNS snapshot (2026-11-20): everstandards.dev, shipevermore.dev, platformforever.dev registered together 2026-10-08 at Squarespace; expiry 2027-10-08. Ownership UNVERIFIED; operator registrar confirmation and auto-renew required.
- OWS namespace rename requires both names through 1.x: [releases](https://github.com/serverlessworkflow/specification/releases).

Skeptic: SURVIVES-WITH-AMENDMENT; brand domains remain useful without being identity authorities. Screen: clear.

## Fork 2 — Version in ids (forced invariant)

**Breaking unit in native ids (default): v0.N before 1.0, vN afterwards.** Schema documents retain MAJOR.MINOR folders. Full patch-level native types are excluded under this template: compatible patch changes must not rename filtered identities. Before 1.0 minors may break, so major-only is insufficient.

Evidence: SLSA/in-toto versioning in N1 §5b; format change rules. [CDEvents v0.5.1](https://github.com/cdevents/spec/blob/v0.5.1/spec.md) intentionally retains its own M.m.p naming for registered extensions; that binding is exempt.

Skeptic: SURVIVES-WITH-AMENDMENT; changed “major only” to breaking unit and scoped rejection to native template types. Screen: clear.

## Supported by default

- While private, relative ids may remain; no public release with relative ids or unconfirmed domain.
- Schema: `https://everstandards.dev/ship/0.1/readout.schema.json`; predicate: `https://everstandards.dev/ship/attestation/verdict/v0.1`; event: `dev.everstandards.ship.handoff.accepted.v0.1`. Later predicate/type suffix v1.
- Extension attributes: CloudEvents lower-case alphanumeric, ≤20 characters; predicate extensions ship_<field>. Bound CDEvents types retain dev.cdeventsx native naming.
- Stable resolvable redirects; renewal is a permanence duty. Full-word slugs follow the later ruling even where old repo names differ. No everflow.dev purchase (#8633).
- Trademark knock-out search includes unscreened “everstandards” under #186.

## What ratifying unlocks

Publication-time identifier/redirect work and final predicate/event registry strings (#8632). Private drafting continues; operator ownership/access is still required beyond ratification.

## Trust boundary and threat model

Dated DNS/RDAP records are third-party claims, never ownership authorization. Publication fails closed until registrar/domain and trademark gates pass.

Binding precedent: [in-toto attestation types](https://in-toto.io/attestation/). The later full-word-slug ruling supersedes the prep's shipevermore path examples.

Full prep (Standards decisions-prep set):

```text
D11-x6hbdjq.md
```

Source and proposed artifact filenames (handoff references are by name only):

```text
2026-11-20-es-adopted-norms.md
2026-11-20-gov-stewards-legal-namespaces.md
D11-x6hbdjq.md
```
