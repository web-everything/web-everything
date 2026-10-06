/**
 * Directory/spawn preparation port for dispatchers (#3371), shaped like JudgeProvider in
 * scripts/operations/cli-adapter.mjs. This is tooling, not a WE standard.
 *
 * THREE backends, kept side by side on purpose, not one replacing another — they hold
 * materially different guarantees, each proven live, not assumed:
 *
 * - `createMacosDeletionIsolationProvider` (Probes 10/11): the excluded path(s) are ABSENT from
 *   the child's clone before it ever starts. A tool-bearing agent that later runs `cat AGENTS.md`
 *   itself gets ENOENT — there is nothing on disk to read. Costs a full `git clone` per
 *   invocation. Git history is untouched, so `git show HEAD:<path>` still recovers the file —
 *   Probe 14a found this is actively counterproductive on its own: `git status` prints a
 *   ` D <path>` signpost naming exactly what was removed, and a real tool-bearing Codex session
 *   followed that signpost to `git show HEAD:AGENTS.md`, unprompted, on an ordinary task.
 * - `createConfigOverrideIsolationProvider` (Probe 12): Codex CLI's own `-c
 *   project_doc_max_bytes=0` suppresses its automatic startup read of the doctrine file into the
 *   model's context. No clone, no filesystem mutation — it operates on `sourceCwd` directly. But
 *   the file is still ON DISK: Probe 12 proved live that a tool-bearing agent told to `cat
 *   AGENTS.md` recovers the full text verbatim, in both `-s read-only` and `-s workspace-write`
 *   sandbox modes. This backend defeats only the CLI's *automatic* injection, not a deliberate
 *   read — the weakest and cheapest of the three guarantees.
 * - `createNativeDenyWithHistoryStripIsolationProvider` (Probe 14): the evidence-backed fix for
 *   the deletion backend's git-history gap. Real git-history surgery (verified against every
 *   object in the packfile, not just the working tree — see that function's own header) so there
 *   is no `git status` signpost and no recoverable blob, PLUS the argv fragment for Codex's
 *   undocumented native filesystem-deny permission so a direct read of the live path is denied
 *   everywhere on the host, not just inside one clone. Neither half alone is a general
 *   adversarial-isolation guarantee — see that function's own header for the residual gap (any
 *   OTHER readable git repo on disk, e.g. this repo's own lane clones, still leaks the same way;
 *   closing that is #3621's read-allowlist territory, not this port's).
 *
 * Probe 9 (2026-09-09) concluded no context-strip flag existed for a tool-bearing Codex juror;
 * Probe 12 (2026-09-11) found and live-verified `project_doc_max_bytes=0` and corrects that
 * conclusion; Probe 14 (2026-09-11) found deletion's git-history gap is real and exploitable, and
 * that Probe 14f's native deny is a stronger fix than an external Seatbelt wrapper. See #3371 for
 * every probe's verbatim before/after commands and output. Pick the backend by the guarantee the
 * call site actually needs — the doctrine cannot be read at all short of `git show HEAD:<path>`
 * (deletion), the CLI does not hand the doctrine to the model unasked and cost/complexity is not
 * worth paying for more (config-override), or the doctrine is unreachable by ANY means this port
 * can express short of another readable repo on disk (native-deny + history-strip). None of the
 * three is read denial in the adversarial sense, resource capping (#3621), or a replacement OS
 * sandbox.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

/**
 * @typedef {object} IsolationProviderRequest
 * @property {string} sourceCwd - Absolute local repository path; clone committed HEAD only.
 * @property {string} [scratchParent] - Absolute existing temporary parent; defaults to OS temp.
 *   Ignored by backends that never clone (e.g. the config-override backend).
 * @property {string[]} [excludePaths] - Repo-relative doctrine-file path(s) this backend should
 * exclude/strip, e.g. `['AGENTS.md']` or a different repo's own convention (`['CLAUDE.md']`,
 * `['.github/copilot-instructions.md']`) plus any nested overrides. Defaults to `['AGENTS.md']`
 * when omitted — every existing caller and test that predates this field keeps working unchanged.
 * Every backend below reads this the same way (`normalizeExcludePaths`); none hardcodes the name.
 * The config-override backend accepts and validates this field for interface consistency, but it
 * has NO effect on that backend's behavior — see its own header for why.
 */

/**
 * @typedef {object} IsolationProviderOutcome
 * @property {string} cwd - Directory to launch the child in, only after resolution. For a
 * cloning backend this is an owned, disposable directory; for a non-cloning backend it may be
 * `sourceCwd` itself (realpath'd) — check `excludedPaths`/`guarantee`, not just this field's
 * presence, to know what protection was actually applied.
 * @property {string[]} excludedPaths - Repo-relative paths physically absent from `cwd` at
 * handoff, not enduring read bans. Empty for a backend that suppresses context injection or
 * denies reads without making the path physically absent.
 * @property {'root-agents-absent-before-start'|'root-agents-doc-suppressed-in-cli-context'|'history-stripped-before-start'} guarantee -
 * Which property actually holds. `root-agents-absent-before-start` means the file does not exist
 * at `cwd` (git history and other copies are untouched). `root-agents-doc-suppressed-in-cli-context`
 * is weaker: only the CLI's own automatic startup read was suppressed — the file may still be
 * present and readable by any tool the child runs. `history-stripped-before-start` means the file
 * is amended out of the clone's own git history (not just the working tree) — see
 * `createNativeDenyWithHistoryStripIsolationProvider`'s own header for what it does and does not
 * additionally close. Callers must not treat these as interchangeable.
 * @property {string[]} extraCliArgs - CLI arguments the caller MUST splice into the child
 * process's own argv for the guarantee to hold. Empty for a backend whose guarantee is already
 * true by the time its promise resolves (e.g. deletion, history-strip). Non-empty for a backend
 * whose guarantee is enforced by the CHILD reading a flag (e.g. Codex's `-c
 * project_doc_max_bytes=0`, or the native-deny backend's permissions config) — no preparation step
 * can substitute for the caller actually passing these through.
 * @property {() => Promise<void>} cleanup - Idempotent release. Call after child exit and result
 * extraction in finally. A no-op for a backend that never allocated anything. Rejects if release
 * fails (safe to retry).
 */

/**
 * @typedef {(request: IsolationProviderRequest) => Promise<IsolationProviderOutcome>} IsolationProvider
 *
 * The function-type contract is backend-neutral, not a claim that preparation is pure.
 * Implementations reject on preparation failure, release partial resources, and return no
 * usable outcome until exclusions/suppressions are applied. Callers must keep an owned directory
 * exclusively owned through child exit, and must always append `extraCliArgs` to the child's
 * invocation. Future Linux/Windows preparation backends use this same contract; process/container
 * execution and stronger guarantees need a separate execution contract.
 */

/** Throws unless every named value is an absolute, NUL-free local path string. Shared by every
 * backend below so path validation stays one rule, not one copy per backend. */
function assertAbsoluteLocalPaths(named) {
  for (const [name, value] of Object.entries(named)) {
    if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
      throw new TypeError(`isolation: ${name} must be an absolute local path without NUL`);
    }
  }
}

/**
 * Pure validator/normalizer for a request's `excludePaths`, shared by every backend so all of them
 * fail closed on the same bad input the same way, and so "no field passed" resolves to exactly
 * `['AGENTS.md']` everywhere rather than each backend re-deriving its own default. `fallback` lets a
 * factory set its OWN default (still validated) for callers that never pass the request field at all.
 */
export function normalizeExcludePaths(excludePaths, fallback = ['AGENTS.md']) {
  const paths = excludePaths === undefined ? fallback : excludePaths;
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new TypeError('isolation: excludePaths must be a non-empty array of repo-relative paths');
  }
  for (const path of paths) {
    if (typeof path !== 'string' || path.length === 0 || isAbsolute(path) || path.includes('\0')) {
      throw new TypeError('isolation: each excludePath must be a non-empty repo-relative path without NUL');
    }
  }
  return paths;
}

/** Pure argv builder. Paths are single arguments; no shell interpolation or CLI options as paths. */
export function buildIsolationCloneArgv(sourceCwd, destination) {
  assertAbsoluteLocalPaths({ sourceCwd, destination });
  return ['clone', '--quiet', '--no-hardlinks', '--', sourceCwd, destination];
}

/**
 * First backend: deletion before launch, evidenced on macOS. No platform auto-selection:
 * portable Node/Git mechanics do not imply a live Linux/Windows context-loading proof.
 * Never mutates the source. Git clone excludes uncommitted/ignored files and dependencies.
 * The returned cwd is not a pooled lane; existing judge lane validation is not bypassed.
 *
 * @param {object} [options]
 * @param {(file: string, argv: string[], options: object) => Promise<unknown>} [options.execFn]
 *   execFile-compatible promise function; must reject on nonzero exit. Injected for tests.
 * @param {string[]} [options.defaultExcludePaths] - This factory's own default when a request omits
 *   `excludePaths` entirely. Defaults to `['AGENTS.md']`; a request-level `excludePaths` always wins.
 * @returns {IsolationProvider}
 * @test-only-export-ok: production wiring is deliberately deferred (see file header) — this is the
 *  first real backend of a new port, proven by #3371 Probes 10/11's direct evidence, not yet wired into
 *  any dispatch call site. isolation-provider.test.mjs is its only consumer until that wiring lands.
 */
export function createMacosDeletionIsolationProvider({
  execFn = promisify(execFile), defaultExcludePaths = ['AGENTS.md'],
} = {}) {
  return async ({ sourceCwd, scratchParent = tmpdir(), excludePaths }) => {
    // Validate before allocating or executing anything, even with an injected execFn.
    const paths = normalizeExcludePaths(excludePaths, defaultExcludePaths);
    buildIsolationCloneArgv(sourceCwd, scratchParent);
    const source = await realpath(sourceCwd);
    const parent = await realpath(scratchParent);
    const ownedRoot = await mkdtemp(join(parent, 'we-isolation-'));
    const cwd = join(ownedRoot, 'clone');
    const cleanup = async () => { await rm(ownedRoot, { recursive: true, force: true }); };
    try {
      await execFn('git', buildIsolationCloneArgv(source, cwd), {
        cwd: parent, encoding: 'utf8', shell: false,
      });
      // Unlink a symlink itself, never its target. A directory/error fails closed.
      for (const path of paths) {
        try { await unlink(join(cwd, path)); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      // Confirm the clone exists even if a broken injected executor reports success.
      await realpath(cwd);
      return {
        cwd,
        excludedPaths: [...paths],
        guarantee: 'root-agents-absent-before-start',
        extraCliArgs: [],
        cleanup,
      };
    } catch (error) {
      try { await cleanup(); }
      catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'isolation: preparation and cleanup failed');
      }
      throw error;
    }
  };
}

/**
 * Second backend: suppress Codex CLI's own automatic AGENTS.md ("project doc") injection via its
 * `-c project_doc_max_bytes=0` config override — real and live-verified (#3371 Probe 12), not
 * documentation-sourced. Probe 12 ran the exact override in both `-s read-only` and `-s
 * workspace-write` (tool-bearing) modes against a real canary AGENTS.md: the child reported "NOT
 * LOADED" for its automatic context in both, and real tool use (file create, `git status`) kept
 * working normally in workspace-write mode. `project_doc_max_bytes` is a genuine Codex config key
 * (default 32768 bytes; confirmed against the installed 0.153.4 binary), not a guessed flag name.
 *
 * No clone: this backend never mutates or copies anything, so it needs no scratch directory and
 * no cleanup — it operates on `sourceCwd` directly and `scratchParent` is ignored if given.
 *
 * WEAKER guarantee than the deletion backend, on purpose, not by oversight, and this is the one
 * thing this backend must not be trusted to do: AGENTS.md remains ON DISK and fully readable.
 * Probe 12 proved this live too — the same session that reported "NOT LOADED" for its automatic
 * context then ran `cat AGENTS.md` on request and recovered the canary text verbatim. Use this
 * backend only when the goal is "the CLI does not hand the doctrine to the model unasked"; use
 * the deletion backend when the goal is "the doctrine is not recoverable by the child at all
 * short of `git show HEAD:AGENTS.md`," or the native-deny+history-strip backend when even that
 * git-history route must be closed too.
 *
 * The guarantee is enforced by the CHILD PROCESS reading `extraCliArgs` — unlike the deletion
 * backend, nothing this function does before returning makes the guarantee true. A caller that
 * drops `outcome.extraCliArgs` from the child's invocation silently loses the guarantee entirely;
 * there is no fallback enforcement here.
 *
 * `excludePaths` is accepted and validated for interface consistency with the other two backends,
 * but has ZERO effect on this backend's behavior: `project_doc_max_bytes=0` suppresses whichever
 * doctrine file Codex's OWN auto-loader resolves, not a caller-named path, so there is nothing for
 * this backend to scope by filename. A caller that passes the same request shape across backends
 * still gets the same fail-loud validation on a malformed list; it just never changes what this
 * particular backend does.
 *
 * @param {object} [options]
 * @param {string[]} [options.defaultExcludePaths] - Validated the same way as the other backends'
 *   own option of the same name, purely for interface symmetry; never read otherwise.
 * @returns {IsolationProvider}
 * @test-only-export-ok: production wiring is deliberately deferred to #3630, the same open item
 *  that defers createMacosDeletionIsolationProvider's wiring — this is a second backend of the
 *  same not-yet-wired port. isolation-provider.test.mjs is its only consumer until that wiring lands.
 */
export function createConfigOverrideIsolationProvider({ defaultExcludePaths = ['AGENTS.md'] } = {}) {
  return async ({ sourceCwd, excludePaths }) => {
    normalizeExcludePaths(excludePaths, defaultExcludePaths); // validated, then deliberately unused
    assertAbsoluteLocalPaths({ sourceCwd });
    const cwd = await realpath(sourceCwd);
    return {
      cwd,
      excludedPaths: [],
      guarantee: 'root-agents-doc-suppressed-in-cli-context',
      extraCliArgs: ['-c', 'project_doc_max_bytes=0'],
      cleanup: async () => {},
    };
  };
}

/**
 * Pure argv builder for the history-surgery clone (#3371 Probe 14e). `--depth 1` collapses the
 * clone to a single grafted root commit — the fact that makes `buildHistorySurgeryCommands`'s
 * `commit --amend` below rewrite the ENTIRE history in one step, instead of needing a
 * filter-repo-style rewrite across many commits. `file://` (a URL, not a bare filesystem path)
 * forces a real object transfer rather than git's `--local` hardlink fast-path, matching exactly
 * what Probe 14e measured (2s wall, then 0 hits across all 8252 objects after surgery).
 */
export function buildHistorySurgeryCloneArgv(sourceCwd, destination) {
  assertAbsoluteLocalPaths({ sourceCwd, destination });
  return ['clone', '--quiet', '--depth', '1', '--no-hardlinks', '--', pathToFileURL(sourceCwd).href, destination];
}

/**
 * Pure builder for the ordered git-surgery command sequence (#3371 Probe 14e). Every returned argv
 * runs with `cwd` set to the clone directory produced by `buildHistorySurgeryCloneArgv`, in the
 * returned order — order is load-bearing, and both traps Probe 14e hit by getting it wrong are
 * baked in structurally rather than left for a caller to remember:
 * - `remote remove origin` runs BEFORE the amend. Skipping it leaves `refs/remotes/origin/main`
 *   pointing at the pre-amend commit, and `git show origin/main:<path>` walks straight around the
 *   surgery.
 * - `repack -a -d -f` (not `git gc --prune=now`) is the step that actually evicts the unreachable
 *   object. Probe 14e's own first attempt used plain `gc --prune=now`, passed `git show`, and still
 *   printed the file via `git cat-file -p <known-hash>` — gc does not evict an object that is
 *   already sitting unreachable inside an existing packfile; only a forced repack rewrites it away.
 * Commit identity is passed via `-c user.name=…/user.email=…` on the amend invocation itself, not
 * written into the clone's own config, so this works with no ambient git identity configured
 * anywhere (a bare CI box, a from-scratch scratch parent) without mutating global state.
 */
export function buildHistorySurgeryCommands(targetPaths) {
  if (!Array.isArray(targetPaths) || targetPaths.length === 0) {
    throw new TypeError('isolation: targetPaths must be a non-empty array of repo-relative paths');
  }
  for (const path of targetPaths) {
    if (typeof path !== 'string' || path.length === 0 || isAbsolute(path) || path.includes('\0')) {
      throw new TypeError('isolation: each targetPath must be a non-empty repo-relative path without NUL');
    }
  }
  return [
    ['remote', 'remove', 'origin'],
    ['rm', '--quiet', '--', ...targetPaths],
    ['-c', 'user.name=we-isolation', '-c', 'user.email=isolation@localhost',
      'commit', '--quiet', '--amend', '--no-edit'],
    ['reflog', 'expire', '--expire=now', '--all'],
    ['repack', '-a', '-d', '-f', '-q'],
    ['prune'],
  ];
}

/**
 * Pure argv builder for Codex's native per-profile filesystem-deny permission (#3371 Probe 14f/14h)
 * — undocumented: absent from the public config-reference page, recovered by exhaustive search of
 * the CLI binary's own serde config tables (14h). This module never launches Codex itself (see file
 * header — preparation is this port's whole job); the returned flags are for the CALLER to splice
 * into its own `codex exec` argv (see `extraCliArgs` on the outcome this feeds).
 *
 * `project_doc_max_bytes=0` is INCLUDED UNCONDITIONALLY and is not an optional extra: the deny map
 * also denies Codex's own AGENTS.md auto-loader, and without the byte cap at 0 that loader trips its
 * own denial and kills session startup before the model ever runs — Probe 14f's own words for the
 * failure this prevents: "Fatal error: Failed to initialize session: failed to load AGENTS.md
 * instructions ... Operation not permitted". `--strict-config` is included so a mistyped or
 * no-longer-valid key fails LOUD instead of being silently ignored — Probe 14h found plain `-c` keys
 * are NOT validated without it, which makes "no effect" and "key does not exist" indistinguishable
 * otherwise.
 *
 * Deny-BY-PATH ONLY — this is Gap 1's residual, stated here rather than only in the provider below.
 * It closes every DIRECT filesystem read of `denyPaths`, on this host and inside any clone at those
 * paths (14f), but does nothing about `git show`/`git cat-file` reading the identical bytes out of
 * `.git/objects` at a DIFFERENT path (14d, proved live: a session under a Seatbelt path-deny still
 * recovered the file through `git show HEAD:AGENTS.md`). Always pair this with real history surgery
 * (`buildHistorySurgeryCommands`) against every git repo the child can reach; this function alone is
 * a read denial, not history isolation.
 *
 * DO NOT ALSO PASS `-s <mode>` to `codex exec` alongside these flags — measured live on codex-cli
 * 0.153.4 (this backend's own real end-to-end re-verification, not carried over from Probe 14's
 * text): `-s workspace-write` and, separately, `-s danger-full-access` each made the deny map have
 * ZERO effect — a live agentic run under either flag read a denied path's content successfully. Omit
 * `-s` entirely and `default_permissions=locked` governs the sandbox on its own (its `extends
 * ":workspace"` already grants the same write access `-s workspace-write` would have), and the same
 * live run then genuinely declined every denied read. The mechanism most consistent with this: `-s`
 * is CODEX'S OWN selector for one of its three built-in named profiles, and it silently wins over a
 * custom `default_permissions` selection for the same underlying setting rather than composing with
 * it — so the two are alternatives, not flags meant to be combined.
 *
 * One more measured, honest limit from that same re-verification, not a new finding but a direct
 * reproduction of Probe 14g's own: a cooperative `codex exec` session that is TOLD about the active
 * deny (Codex surfaces it in the model's own context) self-declines a denied read without attempting
 * it at all — a real, useful protective behavior, but a MODEL-COOPERATION signal, not an OS-syscall
 * guarantee for that path. Forcing an actual attempt (direct instruction, obfuscating the path via
 * shell indirection/base64, framing it as authorized security testing) failed every way tried, same
 * as Probe 14g's own two red-team attempts. The genuinely OS-enforced half of this same permission
 * profile is independently verified via the separate `codex sandbox -P <name>` subcommand (a raw
 * command wrapper with no model involved) — confirmed live: `Operation not permitted`, real Seatbelt
 * denial, on the identical profile. `codex exec`'s own internal application of that same profile to
 * its model-issued shell calls was not independently forced past the model's cooperation in this
 * verification; treat the `codex exec` protection as strong-in-practice-against-a-cooperative-model,
 * and `codex sandbox` as the harder, OS-level guarantee when that distinction matters.
 *
 * #4348 — `writableRoots` (optional, default none, so the argv is byte-identical when omitted) adds
 * `"<dir>"="write"` entries to the SAME `filesystem` map: an extra writable root beyond the
 * `:workspace` cwd. Live-verified on codex-cli 0.155.1 via `codex sandbox -P locked` (no model in the
 * loop): a write into the granted dir and into a nested subdir succeeded, a write into its sibling
 * came back `Operation not permitted`, and the deny entries alongside it still held. Chosen over
 * `codex exec --add-dir` because `exec resume` accepts no `--add-dir`, while `-c` spans both.
 *
 * #4443 — measured limit: an extra writable root does NOT open its Git metadata. Live on codex-cli
 * 0.155.1 (`codex sandbox -P locked`, macOS Seatbelt, the root granted being an independent clone made
 * with `git clone --reference`, the production lane topology, with a directory-shaped `.git`): creating
 * and overwriting `<root>/.git/hooks/*`, `mv`-ing and `rm -rf`-ing `<root>/.git` all came back `Operation
 * not permitted` with the metadata unchanged, while `<root>/backlog/*` writes succeeded. The CLI protects
 * `.git` under a write grant on its own, so this builder adds no `.git` exclusion; the opt-in live suite
 * (`codex-delivery-provider-sandbox.test.mjs`, `WE_CODEX_SANDBOX_TEST=1`) fails if a CLI upgrade changes that,
 * and the manual `codex-sandbox-proof.yml` workflow re-runs it for a candidate CLI version.
 * Not covered: linked-worktree `.git` files and symlink aliases.
 */
export function buildNativeDenyCodexArgs(denyPaths, { writableRoots = [] } = {}) {
  if (!Array.isArray(denyPaths) || denyPaths.length === 0) {
    throw new TypeError('isolation: denyPaths must be a non-empty array of absolute paths or globs');
  }
  const entry = (path, access) => {
    if (typeof path !== 'string' || path.length === 0 || path.includes('\0') || path.includes('"')) {
      throw new TypeError(`isolation: each ${access} path must be a non-empty string without NUL or a double quote`);
    }
    return `"${path}"="${access}"`;
  };
  const entries = [
    ...denyPaths.map((path) => entry(path, 'deny')),
    ...writableRoots.map((path) => entry(path, 'write')),
  ];
  const permissions = `permissions={locked={extends=":workspace",filesystem={${entries.join(',')}}}}`;
  return ['--strict-config', '-c', permissions, '-c', 'default_permissions=locked', '-c', 'project_doc_max_bytes=0'];
}

/**
 * Third backend (#3371 Probe 14): real git-history surgery on a scratch clone, plus the Codex
 * native-deny argv fragment — the combined, evidence-backed fix Probe 14's verdict recommends over
 * `createMacosDeletionIsolationProvider` above. Deletion alone is actively counterproductive: `git
 * status` prints a ` D <path>` signpost naming exactly what was removed, and a real tool-bearing
 * Codex session followed that signpost to `git show HEAD:AGENTS.md` unprompted, on an ordinary
 * non-adversarial task that never mentioned git, history, or recovery (14a). This backend leaves no
 * such signpost: the resolved `excludePaths` are amended out of the clone's own single grafted root
 * commit, so `git status` stays clean and `git show`/`git cat-file` on every object in the resulting
 * packfile come back empty — verified in Probe 14e against all 8252 objects in a real repository,
 * and by this module's own real-git integration test.
 *
 * What this backend does NOT do: launch Codex, or apply the deny config to anything. Per the file
 * header, this port prepares a directory; it never owns child argv, sandbox policy, or launch. The
 * returned `extraCliArgs` is `buildNativeDenyCodexArgs`'s output, ready for the CALLER to splice
 * into its OWN `codex exec` invocation — the `guarantee` field describes only the history-surgery
 * half this function actually performs before returning; the filesystem-deny half only takes effect
 * once the caller actually launches Codex with `extraCliArgs` included.
 *
 * RESIDUAL GAP — stated plainly, do not read this backend as closing more than it does (14g/14h):
 * 1. **Any OTHER readable git repo on disk holding the same file still leaks.** Proved live, not
 *    hypothesised — under the full recipe, `git show` inside a SIBLING clone still printed the file
 *    (14b/14g). This repo's own `workspace/.lanes/<repo>/lane-*` clones are exactly that shape.
 *    Closing that needs a read-ALLOWLIST profile rather than a deny-list, which is #3621's territory,
 *    not a fix this port can express — a directory-preparation contract has no view of every other
 *    repo on the host.
 * 2. **Another tracked file that merely QUOTES the stripped file's content is untouched** (14g notes
 *    `we:backlog/2561-…` quotes `we:AGENTS.md`). "Exclude/strip one path" is never total content
 *    exclusion of that path's text.
 * 3. **No agent-driven adversarial confirmation that the combined recipe is sealed** (14g): two
 *    attempts to have an agent red-team it both refused to run anything, even reframed as authorized
 *    testing of the repo's own sandbox. The evidence behind this backend is mechanism-level (the
 *    direct command matrix in 14e/14f) plus one realistic non-adversarial live run (14g) — a real,
 *    useful bar, but not an adversarial-isolation guarantee, and this header does not claim one.
 *
 * @param {object} [options]
 * @param {(file: string, argv: string[], options: object) => Promise<unknown>} [options.execFn]
 *   execFile-compatible promise function; must reject on nonzero exit. Injected for tests.
 * @param {string[]} [options.defaultExcludePaths] - This factory's own default when a request omits
 *   `excludePaths` entirely. Defaults to `['AGENTS.md']`; a request-level `excludePaths` always wins,
 *   so one factory instance can still serve callers with different doctrine-file conventions.
 * @param {string[]} [options.extraDenyPaths] - Additional absolute paths/globs folded into the
 *   returned `extraCliArgs`, beyond the resolved exclude paths (as `/**\/<path>` globs) and the
 *   source tree itself (both the exact path and a `/**` glob under it).
 * @returns {IsolationProvider}
 */
export function createNativeDenyWithHistoryStripIsolationProvider({
  execFn = promisify(execFile), defaultExcludePaths = ['AGENTS.md'], extraDenyPaths = [],
} = {}) {
  return async ({ sourceCwd, scratchParent = tmpdir(), excludePaths }) => {
    // Validate before allocating or executing anything, even with an injected execFn.
    const paths = normalizeExcludePaths(excludePaths, defaultExcludePaths);
    buildHistorySurgeryCloneArgv(sourceCwd, scratchParent);
    buildHistorySurgeryCommands(paths);
    const source = await realpath(sourceCwd);
    const parent = await realpath(scratchParent);
    const ownedRoot = await mkdtemp(join(parent, 'we-isolation-native-'));
    const cwd = join(ownedRoot, 'clone');
    const cleanup = async () => { await rm(ownedRoot, { recursive: true, force: true }); };
    try {
      await execFn('git', buildHistorySurgeryCloneArgv(source, cwd), {
        cwd: parent, encoding: 'utf8', shell: false,
      });
      // Confirm the clone exists even if a broken injected executor reports success.
      await realpath(cwd);
      for (const argv of buildHistorySurgeryCommands(paths)) {
        await execFn('git', argv, { cwd, encoding: 'utf8', shell: false });
      }
      const extraCliArgs = buildNativeDenyCodexArgs([
        ...paths.map((path) => `/**/${path}`),
        source,
        `${source}/**`,
        ...extraDenyPaths,
      ]);
      return {
        cwd,
        excludedPaths: [...paths],
        guarantee: 'history-stripped-before-start',
        extraCliArgs,
        cleanup,
      };
    } catch (error) {
      try { await cleanup(); }
      catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'isolation: preparation and cleanup failed');
      }
      throw error;
    }
  };
}
