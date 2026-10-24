---
bornAs: xbn4afs
kind: story
size: 3
status: open
scope: ["we:scripts/lib/__tests__/gh-app-shim.test.mjs", "we:scripts/lib/gh-app-shim.mjs"]
dateOpened: "2026-10-21"
tags: []
---

# Prevention: generate host refusal cases for supported boolean shorthand bundles

PR #5729 advisory requested parameterized prevention coverage for repository selectors after boolean shorthands. The checkout -qR runtime finding has an operator not-real ruling; preserve that ruling and establish actual CLI-supported shorthand semantics before adding any such case. Generate cases for every supported command and boolean shorthand followed by attached and separate -R enterprise selectors, including multiple boolean prefixes and both single-label and dotted hosts. With fresh public App cache and trusted public provenance assert refusal and zero real-gh invocations. Include valid public selectors and value-taking options as controls. Gate: npm run test:unit -- we:scripts/lib/__tests__/gh-app-shim.test.mjs; named test refuses enterprise selectors after every supported boolean shorthand must catch a removed supported scanner entry.

## Acceptance

- [A1] **Executable** — Add `refuses enterprise selectors after every supported boolean shorthand`, generated from an independently specified command/boolean matrix. For attached and separate -R selectors after every supported boolean, assert refusal and zero real-gh calls despite fresh public App cache and trusted public token provenance. Include single-label/dotted hosts and multiple boolean prefixes. Run `npm run test:unit -- <suite>` from the WE checkout, using the repository-relative path for suite `we:scripts/lib/__tests__/gh-app-shim.test.mjs`.
- [A2] **Executable** — Add public-repository and value-taking-option controls; demonstrate that removing a supported scanner entry makes a generated enterprise case fail. Preserve the operator not-real ruling on checkout -qR: establish whether the supported CLI accepts -q before deciding its expected behavior, without treating the advisory as an established runtime defect.

## Non-goals

- [N1] Reopening the operator ruling or changing the guard based solely on the disputed checkout invocation.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — Generate attached and separate repository selectors; distinguish option values from targets.
2. **Truncated reads** — Scan entire option bundles rather than stopping before a supported repository flag.
3. **Shared state files** — n/a: every generated case uses isolated fixture caches and invocation logs.
4. **Fail closed** — Enterprise repository selectors refuse before gh; public selectors remain allowed.
5. **Identity scoping** — Public App provenance cannot authorize enterprise host credentials.
6. **State over time** — Use fresh caches so token expiry cannot mask a host-parser failure.
7. **Who wrote it** — Maintain expected shorthand semantics independently of the implementation table.
