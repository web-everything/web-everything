# Prior art: where the open line sits between the open delivery kernel and paid Plateau Loop (#5410)

Date: 2026-11-17. Prepared for the operator. Pricing and packaging are operator-only calls; this report prepares options and a recommendation, it does not rule.

## Ground in this repo

- `we:docs/agent/platform-decisions.md#monetization` (soft, revisitable): the paid line is a structural property (per-call cost, or hosted/credential-holding), never a category; open-core = standard and open reference implementation free, hosted/managed/collab paid; the local fixed-cost product is gated by commercial-use licence (Gate 1, #1590/#1655), anything needing a server is paid for everyone (Gate 2).
- Backlog #098 (resolved, `we:backlog/098-licensing-strategy.md`): the gradient is standard (open), reference implementation (open), platform (fair source, FSL-1.1 with 2-year Apache conversion), products (proprietary). `webcases` conformance suite stays Apache-2.0 for life. The moat is "the platform plus the propose-and-verify products", not the implementation. Trademark and a conformance mark are the enforcement lever.
- Epic #5407: kernel is tier 2 (runs each step on request, one repo, one runtime, one forge binding); Plateau Loop is tier 3 (#2445). Its Done-when needs "a reference kernel [that] passes" the conformance cases, so a closed or absent kernel breaks the epic.
- Sibling prepared cards: #5402 (standard gets its own repo; default (a)) and #5403 (licence; kernel default Apache-2.0, flips to FSL-1.1 only if the operator says the kernel is Plateau-tier). This card decides that tier question in substance: the line chosen here is what makes the kernel open-tier.

## Comparable open-core boundaries

Observed pattern, from memory of public product pages; verify before citing externally.

- Grafana: AGPL core. Paid Enterprise adds SSO/SAML, RBAC, audit logs, enterprise data-source plugins, hosted Cloud. Single-team use is whole in the open core.
- GitLab: CE is a complete single-instance product. Paid tiers add org-wide features (compliance, advanced approvals, security dashboards, SSO, audit events) and hosting. Early "buyer-based" tiering is the documented rule: features for individual contributors open, for managers and executives paid.
- Temporal: MIT server, fully capable. Paid is Temporal Cloud (hosted operation).
- HashiCorp: Terraform CLI open (then BSL). Paid Terraform Cloud/Enterprise adds policy as code, SSO, audit, workspaces and cross-team governance, private registry.
- Jenkins and CloudBees: open CI engine; paid operations centre across many controllers (a cross-project layer).
- Sentry: FSL product, self-hostable; paid is hosted volume and org features.
- Confluent, Elastic, MongoDB: the open engine stays usable; the paid layer is managed service, security and operations features.

Pattern: one team, one repo, one run is open; SSO, audit, policy-across-teams, multi-instance coordination, and hosting are paid. This matches the brief's split. Cautionary evidence: where the open part was hollowed out or the paid part was really the core engine (Elastic and HashiCorp relicensing), forks followed (OpenSearch, OpenTofu). The damage came from moving the line after adoption, so the line should be chosen once, early, and written down.

Tension worth noting: no comparable product charges for a local single-repo loop. Autopilot (continuous dispatch, review panels) on one repo with the user's own model keys has no hosted or credential-holding step, so under the monetization anchor it is a Gate 1 commercial-use licence question, not a Gate 2 structural one. The brief lists it as paid; the anchor's strict reading would leave it open. That is the live fork, and the missing fact is which #098 tier Plateau Loop sits in. Counter-evidence to "nobody charges for a local loop": agent products (Claude Code, Cursor, Copilot agent) are paid; infrastructure open-core comparables are the wrong class for this one question. Skeptic note: GitLab CE tiers some single-team features, so the pattern is not a rule.

## Candidate paid items, tested against the structural rule

| Item (brief) | Structural property | Verdict |
|---|---|---|
| Integrator across many repos | cross-project | structural, paid |
| Cross-model review seats and routing (hosted seats) | credentials, per-call cost | structural, paid |
| Org policy, SSO, audit | hosted, org-wide | structural, paid |
| Cross-project cost and learning | cross-project | structural, paid |
| Compliance evidence packs (#3049) | signed attestation service | structural, paid; the verifier itself stays open |
| Continuous dispatch on one repo | none (local, BYO keys) | not structural; Gate 1 licence or open |
| Review panels on one repo, BYO keys | none | not structural; Gate 1 licence or open |

## Never paid

The standard, the conformance suite and the verifier (#098: `webcases` stays Apache-2.0 for life; the brief says the same of the verifier). A paid verifier would make "conformant" a product feature and undercut the standard's neutrality.
