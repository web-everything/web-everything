## Drain startup sibling provisioning

`scripts/lib/sibling-clone-provision.mjs` checks the drain checkout’s `../frontierui` and
`../plateau-app` even when its pool has no PORT_BANDS entry. Startup repairs absent paths once
per process; dry runs only log status. Existing paths are never reset, deleted or repaired.
A failed clone leaves the drain lookup fail-closed; the operator repairs the sibling and restarts.
The hermetic regression is `scripts/__tests__/sibling-clone-provision.test.mjs`: use a task-temp
directory, an injected home and a fake synchronous clone runner, never a real daemon pool or network.

Acceptance evidence must identify a named test or a recorded live check for every item:

| Acceptance | Evidence |
| --- | --- |
| Tier-1 missing clone, alias, failure reason, existing paths untouched | `sibling clone provisioning` and `sibling clone audit boundaries` suites |
| Startup dry-run, test isolation, once per process, lease refusal | `main sibling provisioning lifecycle` suite |
| Live drain missing frontierui, plateau-app present, then PR 53 routed after load | `liveDrainProvisionsFrontieruiAndRoutes53` observations below; pending until both are recorded |

Vitest setup sets `WE_UNDER_TEST=1` and `WE_TEST_HERMETIC=1`, inherited by spawned CLIs.
Either marker (including CLI fixtures that clear `WE_UNDER_TEST`) makes startup
provisioning status-only even without `--dry-run`, and logs the marker as the reason.
The `main sibling provisioning lifecycle` tests execute the real entry point through the
CLI harness. They assert zero clones for marked test CLIs and explicit dry runs, one
provision call across repeated main calls without resetting modules, and zero calls on lease
refusal. Their injected clone runner and private parent exercise production mode safely by
omitting the marker. The throwing-logger test pins continued processing of both siblings.

### Git environment and credential policy

Every git child of the sibling provisioner runs with inherited Git location, config override,
askpass and SSH command variables removed and lane pins applied. `GIT_TEMPLATE_DIR` is also
removed locally before hardening: an inherited template can install a credential helper or hook
in the new repository before its first fetch. The shared hardening helper is unchanged.

The clone alone uses `laneGitHardeningEnv` with `credentialPins: false`, removes inherited
proxy/trace/CA routing variables, and sets `HOME` from the OS account lookup, never the
provisioner's injectable primary-clone `home` or the caller's `HOME`. `XDG_CONFIG_HOME`,
`GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` overrides are removed. This permits trusted account
global **and system** Git configuration to authenticate the private sibling repositories; the
deployment uses the account's `gh auth git-credential` helper. No credential-helper or askpass
reset is added for this call, while terminal prompting remains disabled and every other lane
pin remains active.

The clone's cwd is the filesystem root (`parse(resolve('/')).root`); its URL, destination,
optional reference path and bounded supervisor path are absolute. The root has no repository
local/worktree configuration to inject a helper. This deliberately extends the shared helper's
documented validated-primary-checkout permission to a **no-repository cwd**, following the
salvage-push precedent; it does not permit that form inside a lane. Global and system account
configuration, including any trusted `init.templateDir`, remains part of the trust boundary.

The origin and shallow reads retain their repository cwd and use the full default lane pins,
including empty `credential.helper` and `core.askPass` resets. These reads use no credential
transport. The default form preserves proxy/trace/CA routing env; the clone-only prohibition
does not apply to these reads. Because `gitRun` merges overrides over `process.env`, each read
first masks **every current inherited key with `undefined`**, then overlays the hardened env.
Node omits the masked keys when spawning. Clone env and read masks are rebuilt on each call,
so newly introduced hostile variables cannot survive through a cached mask.

All four argv shapes (clone with/without reference, origin read, shallow read) pass through
`hardenLaneGitArgs`; they remain byte-identical for these subcommands. No remote-probe transport
policy is added. Existing clone timeouts, kill signal, output bound and uncaptured stdio remain
in place, as do failure cleanup, quarantine and operator repair/restart diagnostics.

The `sibling clone git hardening` suite names tests for clone env/cwd, full read masks/pins,
unchanged argv, env freshness, account-home isolation and hostile templates. Its env, OS account
lookup, cwd, primary clones and Git calls are controlled by temporary fixtures; setting
`DEVELOPER_DIR` prevents the helper's host Command Line Tools probe. Existing exact read-option
assertions include the complete masked env. Vitest 1.x stringifies `undefined` in `vi.stubEnv`:
to model an absent key, save its original with `stubEnv`, delete it explicitly, and restore with
`vi.unstubAllEnvs()` after each test. Run the provisioning, exec-output guard and
lane-git-hardening-env test files through heavy admission, then the related tests and standards
gate. Repeat the provisioning test from an unrelated temporary cwd.

Authenticated transport is a separate deployment proof, pending until recorded: baseline/fixed
legs need independent scratch directories and revision IDs. Probe inherited hooks, `GIT_DIR`
redirects and a template containing a credential helper/hook. Require positive evidence of both
canonical HTTPS clones after hardening and absence of each leg's hostile artifacts; hermetic
tests alone do not establish private-repository authentication. Do not run this proof when the
task prohibits the credential helper or live transport.

Drain CLI fixtures that deliberately exercise provisioning must also own the parent of their
checkout: put the checkout in a nested temporary directory. Local-only prestage
fixtures provide existing non-repository sibling paths, preserving refusal without launching clones.
Merge-queue fixtures provide synthetic sibling metadata and return each sibling's canonical origin
from its working directory; reusing the local checkout's origin correctly fails validation. Keep
these fixtures independent of host checkout symlinks and retain the downstream merge/hold assertions.

### Named deployment check: liveDrainProvisionsFrontieruiAndRoutes53

This check is pending until recorded on the deployment host; hermetic tests do not prove it.
Before loading the repaired daemon, record `siblingCloneStatus({ cwd: drainCheckout })`
from this library against the actual configured drain checkout, including its absolute cwd,
timestamp, frontierui missing reason and plateau-app presence. After the normal daemon
restart, record the same status (frontierui must be present with validated origin), plus
the daemon's structured pass report identifying the frontierui repo and PR 53. Require
positive evidence that PR 53 was considered or routed, and no missing-clone skip for it;
absence of a skip line alone does not pass. Preserve both observations with the deployed
revision in the review evidence. A missing initial observation, no PR 53 in the pass, or an
unreadable report leaves this check pending. Do not run a drain solely to obtain this evidence.
