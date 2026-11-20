---
bornAs: xpjuprf
kind: story
size: 5
status: open
scope: ["we:scripts/operations/codex-audit.mjs", "we:scripts/operations/codex-audit-io.mjs", "we:scripts/lib/net-diff-fingerprint.mjs", "we:scripts/lib/lane-git-hardening.mjs", "we:scripts/operations/run.mjs"]
dateOpened: "2026-11-19"
tags: []
---

# Audit converge mode: route every audit git call through one hardened git wrapper, then finish lane/audit-converge-mode

R1081 converge mode is built and parked on lane/audit-converge-mode (we:scripts/operations/codex-audit.mjs --converge, separate audits-converge.jsonl ledger; the gate stays full-audit-only). It did not converge: every full audit round found a NEW git-plumbing class. Must-fix before it ships: binary/--text handling, diff.relative, replace refs and grafts, commit-graph forged parents, inherited GIT_DIR/GIT_SHALLOW_FILE/GIT_OBJECT_DIRECTORY env, and ssh/askpass overrides on the remote-main ls-remote probe; plus legacy no-ref records in the re-check union and whitespace-only findings. Idea: one hardened git wrapper (built on we:scripts/lib/lane-git-hardening.mjs laneHistoryProofEnv, env scrub, -C repo, --no-replace-objects, --no-relative, --no-ext-diff, --no-textconv, --ignore-submodules=none) used by codex-audit-io, net-diff-fingerprint and the auditor launch, so each class is fixed once in one place instead of finding by finding. Round 1 exhaustive-list prompt ships separately (lane/audit-round1-full-list).

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/lib/__tests__/audit-git.test.mjs` (new): a real-git fixture with a hostile lane config (diff.relative, external diff driver, binary attribute, replace ref, info/grafts, forged commit-graph, inherited GIT_DIR/GIT_SHALLOW_FILE, GIT_SSH_COMMAND) produces the same diff, ancestry and remote-main answers as a clean repo; it fails on today's per-call hardening.
- [A2] Every git call in we:scripts/operations/codex-audit-io.mjs, we:scripts/lib/net-diff-fingerprint.mjs and the auditor launch env goes through the one wrapper (a grep test refuses a direct `spawnSync('git'` / `execFileSync('git'` in those files).
- [A3] A canonical full audit of the finished lane/audit-converge-mode says NOT WEAKENED, and a converge round on a live branch closes its findings in fewer rounds than a full re-audit (before/after numbers in the PR).

## Non-goals

- [N1] No change to gate acceptance (findAudit / canonical-audit-gate / prototype-load): converge records never satisfy open-pr, prototype-load or waivers.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — prior findings and lane content stay inside the untrusted-data fence; review commands hold only validated shas.
2. **Truncated reads** — a git call that fails, times out or returns malformed output refuses (exit 3), never an empty diff.
3. **Shared state files** — converge records append only to audits-converge.jsonl; the full ledger is read-only for converge.
4. **Fail closed** — any unvalidated prior record, ancestry doubt, shallow clone or unreachable remote main exits 2/3 ("run a full audit").
5. **Identity scoping** — rounds link by branch ref; legacy no-ref records join the re-check union by branch ancestry, never as an anchor.
6. **State over time** — main moving forward is allowed only when the anchor's base is an ancestor of the new base, which is on the remote main.
7. **Who wrote it** — lane-written git config, attributes, grafts, replace refs and commit-graphs are untrusted; the wrapper neutralises each.
