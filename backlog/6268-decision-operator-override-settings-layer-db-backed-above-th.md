---
bornAs: xouq5b0
kind: decision
status: resolved
scaffoldedBy: "decision-settings-override"
dateScaffolded: "2026-10-17"
dateOpened: "2026-10-17"
dateStarted: "2026-10-17"
dateResolved: "2026-10-17"
codifiedIn: "docs/agent/platform-decisions.md#operator-override-settings-layer"
preparedDate: "2026-10-17"
preparedAgainstSha: "4f1b2c821c11dcbf05e9d866ac7ea03c9fcca39f"
relatedReport: reports/2026-10-17-operator-override-settings-layer.md
tags: [settings, cascade, operator, override, decision-prep]
---

# Decision: operator-override settings layer (db-backed), above the code cascade

## Ruling

**Ruled 2026-10-17 by the operator (Nicolas Gilbert), in conversation.** Verbatim: *"Ok"*, to "Settings override: (a), (a), (a)?". The rule is codified at
[we:docs/agent/platform-decisions.md#operator-override-settings-layer](../docs/agent/platform-decisions.md#operator-override-settings-layer).
The preparation below explains the forks; its example is updated to the build cards' read interface. Where it differs from this ruling, this section wins.

- **Fork 1 = (a).** A local-first store at one host-wide path, not inside a lane clone; plateau's DB is deferred.
- **Fork 2 = (a).** Above env: standard < platform < tool < env < operator-override.
- **Fork 3 = (a).** A loosening write is refused until the operator confirms, then flagged in needs-you; the floor is also enforced on read.

**Build slices:** see the children of this card (`parent` edges). The settings-edit authority decision `xugqjw1` is cited by id (not yet on main).

**Operator authority, operator input 2026-10-18 (PR #5549).** A red-team round confirmed that a local authority check (an interactive terminal plus the host's `gh` login) can be passed by an agent on the same host. Per the operator's binding input, the "operator-only command" below is realized as slice 1's (`#6266`) request → protected-CI-verified operator review → apply flow, reusing `#6246` slice 2 A10's authenticated-actor pattern. Read the preparation's single `operator-override` command, its `--confirm-loosen` flag and "rejects any agent caller" with that meaning: anyone may request or apply, and only an allowlisted operator's verified GitHub review authorizes a write or a confirmation. A loosening override that expires between needs-you polls still produces an attention event on the next poll (`#6265`). The three fork rulings are unchanged.

Operator, 2026-10-17, verbatim: "we should have the option to use a db for settings instead of in code, at least as override".
Today every setting lives in a repo file, so a tweak needs a PR, and a file held by an open PR cannot be tweaked at all. This card decides the shape of one new top layer, `operator-override`, backed by a store the operator writes through one command. Three forks follow: where the store lives, where the layer sits in the cascade, and what stops an override from loosening a safety guard.

## Why this is needed (live cases, 2026-10-17)

- `we:scripts/settings/merge-queue.json` was held by PR #5480, so a merge-queue setting could not change.
- The review settings files were held by #5465 and #5482.
- Each tweak needed a PR round, even when the operator only wanted a temporary change.

## Grounding in the tree

- Resolver: `resolveCascade` at `we:scripts/lib/policy-cascade.mjs:98`. Layers: `CASCADE_LAYERS = ['standard','platform','tool','env']` at `we:scripts/lib/policy-cascade.mjs:38`. Env is applied last and replaces a whole top-level key (`we:scripts/lib/policy-cascade.mjs:113`).
- Source log line per leaf, e.g. `leaf=value (platform)`: `we:scripts/lib/policy-cascade.mjs:132` and `we:scripts/lib/policy-cascade.mjs:153`. The new layer adds `operator-db` here.
- Call-site helper: `cascadePolicy` at `we:scripts/lib/policy-cascade.mjs:176`.
- File settings merge: `we:scripts/lib/settings-files.mjs:105` and `we:scripts/lib/settings-files.mjs:132`.
- Review settings: the referral safety keys resolve through `resolveReferralSafetySettings` (`we:scripts/lib/review-settings.mjs:96`), and `resolveReviewSettingSource` (`we:scripts/lib/review-settings.mjs:117`) reports the source. `resolveReviewSettings` (`:107`) logs nothing. These must also read the new layer.
- Merge-queue switches such as `mergeQueue.refreshOnStaleMergeGate` resolve outside the cascade, through `resolveRefreshSetting` (`we:scripts/lib/merge-queue-enqueue.mjs:42`), a third resolver that must read the layer.
- The wording "standard < platform < tool": `we:scripts/settings/merge-queue.json:2`.
- Guard keys an override could loosen: `REFERRAL_SAFETY_KEYS` at `we:scripts/lib/review-settings.mjs:94`, plus the merge-queue switches. The confirmed-broken always-block (`we:scripts/lib/review-round-rules.mjs:268`) is hard-coded and stays out of reach.
- Machine-local, gitignored state directory: `we:.gitignore:186`.
- Authority model: decision `xugqjw1` (settings-edit authority) is cited in the proposal, but a grep of the tree did not find it. Treat the citation as unverified until the operator confirms where it lives.

## Prior art

Report `we:reports/2026-10-17-operator-override-settings-layer.md`. Feature-flag services, Kubernetes live config, Consul/etcd, and Terraform input variables all put a runtime-written override above a code default. All of them keep an audit log. Flag services also support expiry.

## Settled by forced invariant (not forks)

- **Only the operator writes it.** If agents could write the layer, an agent could loosen its own guards, so that branch is broken. One operator-only command is the sole writer. Each write records: the operator's verbatim instruction, actor, channel, time, an optional expiry, and a reason.
- **Append-only change log.** Writes never edit history. The plateau dashboard later reads the log to show active overrides.
- **Daemons read it each tick**, and every resolved value from this layer logs `source: operator-db`.

## Supported by default

- Optional expiry per override. An expired override is ignored and logged once.
- The store sits behind one read interface, so Fork 1 stays reversible.

## Fork 1 — Where the override store lives

Fork-existence: both branches are coherent, but they cannot both be the single source the daemons read each tick. Two stores would give two answers to "what is the value now".

- **(a) Local first: the source of truth is a machine-local store, no new service. (default)** The storage format (for example an append-only JSONL log plus a snapshot, or SQLite) is left to the build card; only the single read interface is ruled here.
- (b) Plateau's DB from day one. Gives sharing and a dashboard at once, but daemons then depend on a service being up, and it needs plateau to ship first.

```js
// Fork 1 (a): read the host-wide store each tick (slice 1's effective view, floored by slice 3).
const op = readOperatorOverrides();   // { readable, entries }, not a .value property
// Slice 2 projects each effective entry's key/value into this policy's layer shape.
const operatorOverride = op.readable ? projectPolicyEntries(policy, op.entries) : undefined;
const r = resolveCascade({ standard, platform, tool, envValues, operatorOverride, valid });
// r.sources['<cascade key>'] === 'operator-db'; merge-queue switches read the same layer in resolveRefreshSetting
```

`projectPolicyEntries` above is pseudocode for slice 2's per-policy projection, not an existing exported helper. Resolver activation waits for the store, guard floor and needs-you producer (6264's blockers); preparation is complete and this decision is ratified, as the ruling and frontmatter record.

Recommended: (a). It needs no service, works offline, and matches how other machine-local state already lives (`we:.gitignore:186`). Downside: it is per machine.
Skeptic: SURVIVES-WITH-AMENDMENT. A repo-relative operations directory gives each lane clone its own copy, so an override could miss the daemon that needs it. Folded in: the store sits at one host-wide path, not inside a clone, and the per-host scope is shown on the dashboard.
Screen: flagged(impl) → fix applied: the card now rules only the contract (local first, one read interface); the storage format moves to the build card.

## Fork 2 — Where the layer sits in the cascade

Fork-existence: env and the new layer both claim to be the last word; only one order is possible, and the other leaves a hidden override.

- **(a) Above env, the new top layer. (default)** Order: standard < platform < tool < env < operator-override. The operator's recorded instruction always wins, and the source log shows why.
- (b) Between tool and env. Keeps the launch-time env flag as the last word, but then a stale shell variable silently beats a recorded operator instruction, which is the opposite of the goal.

Recommended: (a). Env stays useful for one-off process launches that carry no override.
Skeptic: SURVIVES. It composes with the existing rule that an env var may sit on top of the settings file for a one-off run (`we:docs/agent/platform-decisions.md:3838`); the new layer goes above that. Build note: the merge-queue switches have their own env path separate from the cascade (the referral safety keys resolve through `cascadePolicy`), so the build card must cover the cascade, the review source reporter and the merge-queue resolver (slice 2, `#6264`).
Screen: clear

## Fork 3 — Guard floor: what stops an override from loosening a safety guard

Fork-existence: "no confirmation at all" breaks the invariant that a merge-gate or review guard cannot be switched off silently. The two remaining branches differ on whether the guard stays on until the operator confirms, which cannot both hold. (The confirmed-broken always-block at `we:scripts/lib/review-round-rules.mjs:268` is hard-coded and outside this layer.)

- **(a) Block until confirmed. (default)** The write command classifies each key as loosening or not. A loosening write without a confirmation flag is refused. A confirmed one is logged and shown in the needs-you feed.
- (b) Flag after the fact. A loosening write takes effect at once and is only flagged in the needs-you feed. Faster for the operator, but the guard is off until someone reads the feed.

Settled alongside (not part of the fork): the floor also holds on read. The reader ignores any loosening entry that lacks a recorded confirmation, so a hand-edited snapshot cannot bypass it.

```sh
# Fork 3 (a): the one operator-only command (declared operation, run.mjs)
node scripts/operations/run.mjs operator-override --key=mergeQueue.refreshOnStaleMergeGate --value=off \
  --instruction="<operator words, verbatim>" --reason="..." --expires=2026-10-18T09:00-04:00 \
  --confirm-loosen
```

Recommended: (a). Blocking until confirmed means a guard is never off without the operator having said so.
Skeptic: SURVIVES-WITH-AMENDMENT. A confirm flag alone stops nothing if an agent can call the command; the agent-rejecting authority check is what holds. Folded in: every key declares its safe direction in a table, a key with no entry counts as loosening, and the write operation rejects any agent caller. Statute to cite when codifying: an agent may veto but never grant its own constraints (`we:docs/agent/platform-decisions.md:4118`) and mutations go through typed, fail-closed operations (`we:docs/agent/platform-decisions.md:4787`). Citation fix: the confirmed-broken always-block above is hard-coded, not a setting, so an override cannot loosen it; the keys an override can loosen are `REFERRAL_SAFETY_KEYS` (`we:scripts/lib/review-settings.mjs:94`), the merge-queue switches, and the cascade keys whose reader uses `cascadePolicy(...).value` (slice 1's `SETTABLE_OVERRIDE_KEYS`, `#6266`). Each still needs a safe-direction entry, and a key with none counts as loosening.
Screen: flagged(impl) → fix applied: the on-read enforcement mechanism moved out of the fork into the settled note above; the fork now rules only block-until-confirmed vs flag-after.

## Acceptance

- [A1] **Executable** — the `operator-override set` operation then `readOperatorOverrides` returns the value and the source log prints `(operator-db)`; a loosening write without confirmation exits non-zero. The build card names the test file.

## Non-goals

- [N1] No plateau DB work now (Fork 1 (b) is a later swap behind the read interface).
- [N2] No agent write path.

## Edge cases this change must handle

1. **Untrusted text** — the verbatim instruction is stored as a quoted string, never executed or interpolated.
2. **Truncated reads** — a snapshot that fails to parse is skipped whole and logged; never half-applied.
3. **Shared state files** — the log is append-only with a lock; the snapshot is replaced atomically.
4. **Fail closed** — unreadable layer or unknown guard direction means the override is ignored or treated as loosening.
5. **Identity scoping** — the actor and channel come from the command's authority check, not from a flag.
6. **State over time** — expired entries are ignored on read; the log keeps them.
7. **Who wrote it** — every entry carries actor, channel, time, instruction, reason.
