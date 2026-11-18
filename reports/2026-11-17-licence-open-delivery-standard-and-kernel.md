# Prior art: licence for an open delivery standard and its kernel (#5403)

Date: 2026-11-17. Prepared for the operator. Licensing is an operator-only call; this report prepares options and a recommendation, it does not rule.

## Ground in this repo

- Backlog #098 (resolved, `we:backlog/098-licensing-strategy.md`) is the standing ruling: standard = CC BY prose plus Apache-2.0 code and schemas; reference implementation (Frontier UI) = Apache-2.0; platform (Plateau) = FSL-1.1 with a 2-year Apache conversion; `webcases` stays Apache-2.0 permanently; trademark is the enforcement lever; CLA is a contribution blocker.
- `LICENSE` and `LICENSE-DOCS` ship the standard split. They disagree slightly on which prose directories are covered (`reports/` and site pages appear only in `LICENSE-DOCS`).
- The epic #5407 puts the open kernel as tier 2 and the paid Plateau Loop as tier 3. So the live question is only which #098 tier the kernel belongs to.

## Comparable standards (specs, schemas, conformance suites)

Observed pattern (from memory of public licence files; verify before citing externally): standards that want many independent implementers use permissive licences with a patent grant.

- OpenAPI Specification, OCI specs, CloudEvents, gRPC: Apache-2.0.
- Kubernetes and CNCF projects: Apache-2.0 by default.
- WHATWG: CC BY 4.0 for spec text, permissive for code snippets. W3C: its own permissive licences.
- No widely adopted interoperability standard uses AGPL or a source-available licence for its spec or schemas.

## Comparable kernels and products

- HashiCorp: MPL-2.0 to BSL (Aug 2023); OpenTofu fork under the Linux Foundation. The card's 21% to 9% community-PR figure is unverified here.
- Redis: BSD to RSALv2/SSPL (Mar 2024); Valkey fork; AGPLv3 added alongside in Redis 8 (2025). That is an added option about 14 months later, not a full reversal.
- Elastic: Apache to SSPL/ELv2 (2021); OpenSearch fork; AGPL added in 2024.
- Grafana: AGPLv3 since 2021, no fork took over. Best evidence that AGPL is survivable.
- Sentry and others: FSL (Fair Source), converting to Apache-2.0 or MIT after two years; not OSI open source.

Lesson: the damage came from relicensing after adoption, not from any one licence. Pick once, early.

## Option trade-offs for the kernel

| Option | Adoption | Deters closed clone | Patent grant | Fit with #098 |
|---|---|---|---|---|
| Apache-2.0 | highest | no (trademark does it) | explicit | matches the open reference-implementation tier |
| AGPL-3.0 | lower; some firms ban it | yes for network services | explicit (section 11) | departs from #098; needs a reconciliation note |
| FSL-1.1 | medium; not "open source" | yes for 2 years | yes | matches the platform tier only |

## Recommendation (prepared, not ruled)

- Standard: settled by #098; ratify Apache-2.0 plus CC BY 4.0 and align the two licence files' prose scope.
- Kernel: Apache-2.0 as default, because the epic calls it open tier 2 and #098 gives the open reference implementation Apache-2.0. Clone defence is the trademark and conformance mark. AGPL is the named fallback with a trigger (a credible non-contributing hosted clone seen early). If the operator treats the kernel as Plateau-tier, FSL-1.1 per #098 applies instead.
- CLA: already required by #098; confirm it covers the kernel repo.
