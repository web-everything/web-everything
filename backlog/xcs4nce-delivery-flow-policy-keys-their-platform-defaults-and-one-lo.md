---
kind: story
size: 3
parent: "x0hvbwx"
status: open
scope: ["we:config/defineConfig.ts", "we:config/platformDefaults.ts", "we:config/index.ts", "we:config/__tests__/config-contract.test.ts", "we:scripts/lib/delivery-policy.mjs", "we:scripts/lib/__tests__/delivery-policy.test.mjs", "we:scripts/lib/gate-config.mjs", "we:scripts/lib/__tests__/gate-config.test.mjs"]
dateOpened: "2026-10-03"
preparedDate: "2026-10-03"
preparedAgainstSha: "838e849ab8b35fa4b94216b7d474b3138d979ba5"
tags: [policy, config, drain, conveyor]
---

# Delivery-flow policy keys, their platform defaults, and one loader the daemons read

Defaults ruled by the operator on 2026-10-03 (PR #3794 comment): `recheckWhenMainMoved` is
`if-older-than-N-min` (30), `reservedForRepairs` is 1 with a new `reservedBorrowAfterMin` (10), and the
`dispatchGate` name is accepted.

Declare the five delivery-flow policy dimensions (`prCi`, `mergeGate`, `dispatchGate`, `heavyQueue`, `drain`)
in `we:config/defineConfig.ts`, with their safe defaults in `we:config/platformDefaults.ts`. Add one loader
the daemons call to get the resolved values, and one durable policy-event journal they write to. Every other
story under epic #x0hvbwx reads its key through this loader.

## Progress

Prepared 2026-10-03 against `838e849ab`. This preparation changes no runtime code.

| Premise | Checked against the code |
| --- | --- |
| The repo has a config mechanism to extend. | Yes. `we:config/defineConfig.ts:91-111` is the open-set author surface, with one key per dimension. `we:config/platformDefaults.ts:38-49` holds platform default values as data. The rule is `config-extends-platform-default` (`we:docs/agent/platform-decisions.md:1684`). |
| `crossProviderFallback` (PR #3789) is the fresh example. | It is on open PR #3789, not on main yet. It adds a typed value interface, a `DimensionEntry` key, a default in `PLATFORM_FLAVOR_DEFAULTS`, a separate numeric default constant, and contract tests. Follow that shape exactly. |
| Daemons can already read a resolved config value. | **No.** No `webeverything.config` file exists at the repo root. No script under `we:scripts/` reads one: a grep for `webeverything.config` finds nothing. The TS contract is types and data only (`we:config/index.ts:1-8`). So this story must add the loader. Card #xp33bdf (on PR #3789) needs the same loader for `crossProviderFallback`. |
| Script code can read the TS defaults. | Yes, through the existing in-process esbuild pattern: `we:scripts/lib/component-tokens.mjs:25-41` transpiles TS and imports the result. Reuse it, so the defaults keep one source. |

**Start after PR #3789 lands.** It edits the same three config files. Building on its shape avoids a conflict
and avoids a second, different way of declaring a policy key.

## Design

**Keys.** Each is its own dimension, per Fork 1 of the rule: there is no cross-dimension merge. Values, with
the default listed first:

| Dimension.field | Values | Default |
| --- | --- | --- |
| `prCi.mainStateParity` | `on` or `off` | `on` |
| `mergeGate.recheckWhenMainMoved` | `if-older-than-N-min`, `always` or `off` | `if-older-than-N-min` |
| `mergeGate.recheckMaxAgeMin` | positive integer, read only by `if-older-than-N-min` | `30` |
| `mergeGate.onMainRed` | `halt`, `warn` or `off` | `halt` |
| `dispatchGate.overlapOverride` | `off`, `logged` or `free` | `off` |
| `heavyQueue.priority` | `repairs-first` or `fifo` | `repairs-first` |
| `heavyQueue.reservedForRepairs` | integer 0 or more; the consumer clamps it to the slot cap minus 1 | `1` |
| `heavyQueue.reservedBorrowAfterMin` | positive integer, minutes the reserved slot may sit idle before a build may borrow it | `10` |
| `drain.onStepRefusal` | `alert` or `log` | `alert` |

`dispatchGate` replaces the proposed name `mergeGate.overlapOverride`. The overlap check runs when a job is
dispatched, not when a PR merges (`we:scripts/conveyor/build-dispatch-policy.mjs:271-274`).

**Contract.** In `we:config/defineConfig.ts`, add one value interface and one typed key per dimension:
`PrCiPolicyValue`, `MergeGatePolicyValue`, `DispatchGatePolicyValue`, `HeavyQueuePolicyValue` and
`DrainPolicyValue`. Mirror `crossProviderFallback`. In `we:config/platformDefaults.ts`, export one constant
`PLATFORM_DELIVERY_POLICY_DEFAULTS` that holds the five default value objects above. Re-export the types from
`we:config/index.ts`.

**Loader** (`we:scripts/lib/delivery-policy.mjs`):

- `loadDeliveryPolicy({ root, env })` returns `{ prCi, mergeGate, dispatchGate, heavyQueue, drain, sources, warnings }`.
  For each field, `sources` says `default` or `config`.
- The defaults come from `we:config/platformDefaults.ts`, transpiled once per process.
- The project file is `we:webeverything.config.json` (at `root`), or the path in `WE_POLICY_CONFIG`. A dimension
  entry may be an inline value, an `extends-flavor` descriptor (its `overrides` apply over the default), or a
  string pointer to another JSON file. These are the three entry forms `we:config/defineConfig.ts:67-70`
  already allows. The MVP reads JSON only; TS and JS project files are a follow-up.
- **Trust: which copy of the file is read, and who may change it.** Every protection this epic adds can be
  switched off from this file (`onMainRed: off`, `recheckWhenMainMoved: off`, `overlapOverride: free`,
  `mainStateParity: off`). An ordinary PR must not be able to switch off the check that judges that same PR.
  - **PR-side gates read the base copy.** `loadDeliveryPolicy({ root, env, ref })` takes an optional `ref`.
    With a `ref`, the file (`we:webeverything.config.json`) is read from git at that ref with `git show`
    (pointer files likewise), never from the working tree. `check:standards` in PR CI (story #2940) and any gate that judges a PR pass
    the PR's **base** ref. A PR that edits the policy file therefore runs under the policy that was already
    on the base. Daemons that act on main itself read the working tree of their own main checkout (no `ref`).
  - **The policy file is human-gated.** Register `we:webeverything.config.json` in
    `we:scripts/lib/gate-config.mjs` as a **policy-tier, `leash: 'spec'`** member (human review, not
    agent-clearable), because it decides whether the merge protections fire. Register the loader
    `we:scripts/lib/delivery-policy.mjs` at the **engine tier**, like `we:scripts/merge-ai-prs.mjs`. An `off`/`free`/weaker value in a
    PR is then reviewed by a person, never cleared by an agent verdict.
  - **A pointer target is policy-tier too, or it is refused.** A string pointer hands part of the policy to
    another file, so editing only that file would otherwise skip `review:human` (the root file is untouched)
    and weaken a protection after landing. The loader therefore accepts a pointer **only if its resolved
    path is already a registered policy-tier, `leash: 'spec'` member** (`isPolicySpecPath` in
    `we:scripts/lib/gate-config.mjs`, the one registry; the loader asks it, nothing else lists targets). Any
    other pointer falls back to the default for that field with a warning naming the path. This holds with
    or without a `ref`, and for a pointer found inside a pointed-to file. The MVP registers **no** pointer
    target, so the pointer form is effectively off until a later story registers a target file in
    `we:scripts/lib/gate-config.mjs`; that registration is itself a human-reviewed edit of the roster.
  - **Confinement.** A pointer path must resolve **inside `root`** (after `realpath`, so a symlink out of the
    tree is refused); an absolute path, a `..` escape, or a symlink out falls back to the default for that
    field with a warning. This is checked in addition to the registered-target rule above, never instead of it. `WE_POLICY_CONFIG` is honoured only for a local daemon process (never when
    `GITHUB_ACTIONS` is set, so a workflow cannot be redirected to a file the PR controls) and must resolve
    inside `root` or inside the daemon's own state dir; otherwise it is ignored with a warning.
- Fields merge one by one over the default. A missing field keeps its default.
- **Fail safe, never crash.** An unknown value, a wrong type, an unreadable file or bad JSON falls back to the
  default for that field and adds a warning. The loader never throws, because a daemon must keep running.
- It re-reads the file when its mtime changes, so a long-running daemon picks up a change on its next pass
  without a restart.
- `recordPolicyEvent({ key, event, subject, reason, detail })` appends one JSON line, stamped with `at`, to
  `policyEventsPath(env)`. That path is `WE_POLICY_EVENTS_FILE`, or `policy-events.jsonl` in the health-watch
  logs dir (`defaultLogsDir`, `we:scripts/conveyor/health-watch.mjs:92-93`). It is best-effort and never
  throws. `readPolicyEvents({ sinceMs })` reads the journal back. The alert story and the overlap story write
  to it, and their health smells read it.
  - **Journal text is untrusted.** `reason` and `detail` carry text derived from agent flags and repository
    content (override reasons, file names in a refusal). On write, `recordPolicyEvent` strips every control
    character (C0 and C1, including newlines inside a value, so one event stays one line), truncates `reason`
    to 200 characters and each string in `detail` to 500, keeps at most 20 entries of any array in `detail`,
    and caps the whole line at 4 KB (dropping `detail` fields last-first, never the key, event or subject).
    A truncated value ends in `…`. Readers still treat the text as plain text, never markup.
- CLI: `node we:scripts/lib/delivery-policy.mjs [--json] [--ref=<git-ref>]` prints the resolved policy, the
  source of each field and any warnings.

## MVP

Types, defaults, the loader, the journal and the CLI. No consumer changes: each consumer is its own story.

## Test plan

- **Capability (RED today, fails before this lands):** `we:config/__tests__/config-contract.test.ts`:
  - `defineConfig` accepts every listed value for each key, both inline and as `extendsFlavor` with overrides.
  - `PLATFORM_DELIVERY_POLICY_DEFAULTS` equals the default column exactly.
- **Capability (RED today, fails before this lands):** `we:scripts/lib/__tests__/delivery-policy.test.mjs`:
  - No config file: every field equals its default and every source is `default`.
  - Each value of each key, set in a temp config, comes back with source `config`.
  - A partial override (only `mergeGate.onMainRed` set to `warn`) keeps the other `mergeGate` fields at default.
  - An unknown value (`onMainRed` set to `explode`), a wrong type (`reservedForRepairs` set to `"two"`), bad
    JSON and a missing pointer file each give the default plus one warning. Nothing throws.
  - A changed mtime triggers a re-read; an unchanged mtime is served from cache.
  - `recordPolicyEvent` then `readPolicyEvents` round-trips. A write to an unwritable path returns without
    throwing.
  - **Sanitising:** a reason with a newline and an ESC byte comes back without them, as one journal line; a
    5 000-character reason is cut to 200 with `…`; a detail with 100 file names keeps 20; one huge `detail`
    leaves a line of at most 4 KB with key, event and subject intact.
  - **Trust (base copy):** with a `ref`, a temp git repo whose base commit has `mergeGate.onMainRed: halt`
    and whose PR head commit sets it to `off` loads `halt`, even though the working tree says `off`. Without
    a `ref`, the working tree wins.
  - **Confinement:** a pointer that climbs out of `root` with `..`, an absolute path, and a symlink pointing
    out of `root` each give the default plus one warning. `WE_POLICY_CONFIG` is ignored under `GITHUB_ACTIONS=true` and
    when it points outside `root` and the state dir.
  - **Pointer target (registered-only):** a pointer to an in-`root` JSON file that is **not** a registered
    policy-tier member gives the default plus one warning that names the path, even though the file is valid
    and holds a legal value (e.g. `onMainRed: off`). With a `ref`, the same pointer is refused when read from
    git. A pointer inside a pointed-to file is refused the same way. With a temp registry that registers the
    target, the pointer is honoured (source `config`), proving the check reads the registry rather than a
    hardcoded list.
- **Capability (RED today, fails before this lands):** `we:scripts/lib/__tests__/gate-config.test.mjs`:
  `we:webeverything.config.json` is a registered policy-tier, `leash: 'spec'` member (so a PR touching it
  forces `review:human`), and `we:scripts/lib/delivery-policy.mjs` is a registered engine-tier member.
  **Pointer files:** a test that a pointer-target file (a temp JSON file the loader is pointed at) forces
  `review:human` **when it is edited alone**, with `we:webeverything.config.json` untouched, once it is
  registered. Together with the loader's registered-only pointer test above, no policy value can reach a
  daemon from a file outside the human-gated roster.
- **Capability (RED today, fails before this lands):** Replay of the failure this prevents: the defaults are the safe ones. With no config file, a test asserts
  `mergeGate.onMainRed` is `halt`, `drain.onStepRefusal` is `alert` and `dispatchGate.overlapOverride` is
  `off`. These are the settings whose absence let 2026-10-03 happen with no stop and no alert.

## Proof plan

In the build lane, paste three CLI runs into the PR (plus the trust run, step 4 below):

1. No config file: every field shows its default.
2. `WE_POLICY_CONFIG` pointing at a temp file that sets `mergeGate.onMainRed` to `warn`: that field shows
   `warn` from `config`, and every other field shows its default.
3. A temp file with `onMainRed` set to `explode`: the field shows `halt`, with one warning.

Also show one `recordPolicyEvent` line written to a temp `WE_POLICY_EVENTS_FILE`, and one with a control
character and a 5 000-character reason, showing it stripped and cut.

4. Trust: in a temp git repo, a base commit with `mergeGate.onMainRed` at `halt` and a PR commit that sets it
   to `off`. **Before** (reading the working tree): `off`. **After** (`--ref=<base>`): `halt`.
5. Pointer target: a temp config whose `mergeGate` entry is a string pointer to a second temp JSON file (valid,
   setting `onMainRed: off`) that is not registered. **Before** (no registered-target rule): `off` from
   `config`. **After:** `halt` from `default`, with one warning naming that file.

## Follow-ups

- TS and JS project config files, through the same esbuild path.
- Card #xp33bdf reads `crossProviderFallback` through this loader instead of a private reader.

## Done when

1. **Executable:** `npx vitest run we:config/__tests__/config-contract.test.ts we:scripts/lib/__tests__/delivery-policy.test.mjs`
   (paths without the `we:` prefix when run) fails before this lands, because there are no keys and no
   loader, and passes after.
2. `node we:scripts/lib/delivery-policy.mjs --json` prints all eight fields with their defaults.
