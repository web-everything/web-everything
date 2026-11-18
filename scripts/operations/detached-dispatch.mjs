/**
 * @file scripts/operations/detached-dispatch.mjs
 * @description THE PRIMITIVES EVERY DETACHED PER-KIND DISPATCH PROVIDER NEEDS — the handle SHAPE a detached
 *   dispatch carries (`pid:<n>`), the kernel probe that answers its liveness, the detached spawn itself, and
 *   the log path its narration lands in. Extracted from {@link ./dispatch-lane-io.mjs} VERBATIM.
 *
 * WHY THIS IS ITS OWN MODULE, AND WHY THAT IS NOT A SPLIT OF THE COHESIVE IO SHELL. `dispatch-lane-io.mjs`
 * carries an `@cohesive:` marker recording a prior ruling: its reader / sink / observer triple is ONE
 * operation's io boundary and must NOT be broken into three modules. Nothing here breaks it. The triple is
 * intact and still lives there; what moved out is the per-kind mechanical PROVIDER machinery #3645 ADDED to
 * that file — new code, not one of the three halves — plus the primitives it is built from. The reader, the
 * sink and the observer still sit together, still share the handle contract the sink's docblock owns, and
 * still get imported together.
 *
 * WHY IT MOVED AT ALL. #3645 wired exactly one launch kind (`build`) mechanically. Five siblings are queued to
 * wire the rest (`prepare` #3641, `prepare-decision` #3644, `fix` #3640, `ci-heal` #3642 — see
 * `we:backlog/3643-*.md`). Every one of them needs THESE FOUR THINGS and nothing else about the io shell: a
 * durable handle a later liveness read can resolve, a probe that answers it without the dispatching process
 * still existing, a spawn that survives the runner being restarted, and somewhere for the child's output to
 * go. Left inside the io shell they would be five lanes editing one 2000-line file; here each kind imports
 * them and touches nothing shared. See {@link ./dispatch-provider-registry.mjs} for how a kind is registered.
 *
 * THE DEPENDENCY IS ONE-WAY, deliberately: `dispatch-lane-io.mjs` → `detached-dispatch.mjs`, NEVER back. This
 * module knows nothing about the tick, the effect executor, the run store, or `claude`. That is what lets a
 * per-kind provider module import it without pulling the whole io shell (and its `claude agents` shelling)
 * into a process that only wants to spawn one child.
 *
 * A NOTE ON THE `{@link}`s IN THE MOVED DOCBLOCKS, which are kept verbatim rather than rewritten: references to
 * `isDispatchHandleLive`, `parseBackgroundedHandle`, `defaultSpawnAgent` and `stampLiveness` resolve in
 * {@link ./dispatch-lane-io.mjs}, which is where those still live — `isDispatchHandleLive` in particular STAYS
 * there because it composes `detachedHandlePid` (here) with `isHandleListed` (the `claude` listing read, which
 * is io-shell business), and splitting a composition from one of its halves buys nothing.
 *
 * IMPURE only in {@link defaultSpawnDetached} (`fs`, `child_process`) and {@link defaultIsPidAlive}
 * (`process.kill`). Everything else here is PURE.
 */

import { routingPolicyEnv } from '../lib/dispatch-routing-policy-io.mjs';
import { withRuntimeAdmission } from '../lib/runtime-admission.mjs';
import { spawn as nodeSpawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markWorkerEnv } from './session-role.mjs';
// #landing-freeze-2779 — see this function's own doc addition below for the incident this closes: a detached
// wrapper's own `process.env` is never sanitized before being handed to its child, so a static (daemon-minted,
// ~1h-lived) `GH_TOKEN`/`GITHUB_TOKEN` rides along unchanged for as long as the wrapper (and whatever it later
// spawns) lives — which routinely outlives the token. `sanitizeSpawnEnv` is the SAME primitive
// `dispatch-lane-io.mjs#defaultSpawnAgent`/`spawnAgentToCompletion` already apply to their own spawn's env;
// this file's own spawn never had it.
import { sanitizeSpawnEnv } from '../lib/gh-app-shim.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** The repo root, resolved by SCRIPT LOCATION and never by cwd — the same reason `dispatch-lane-io.mjs` and
 *  `run-store.mjs` each resolve their own. Held here rather than imported from the io shell so the one-way
 *  dependency above holds: a provider module needs the root, and must not import the io shell to get it. */
export const REPO_ROOT = resolve(HERE, '..', '..');

/** Where a detached delivery's stdout/stderr lands: `we:.operations/delivery-dispatch-logs/<slug>.log`, the
 *  same gitignored sidecar family `delivery-report-store.mjs` and `minimal-context-provider.mjs` already use. */
export function deliveryDispatchLogPath(sessionSlug, root = REPO_ROOT) {
  const safe = /^[A-Za-z0-9._-]+$/.test(String(sessionSlug || '')) ? String(sessionSlug) : 'unnamed-dispatch';
  return join(root, '.operations', 'delivery-dispatch-logs', `${safe}.log`);
}

/**
 * THE HANDLE SHAPE A DETACHED DELIVERY CARRIES. `pid:<n>` — deliberately unlike every `claude` handle
 * ({@link parseBackgroundedHandle} only ever yields lower-case hex), so {@link isDispatchHandleLive} can tell
 * the two apart with no extra field on the run record and no migration of the records already on disk.
 */
export const DETACHED_HANDLE_PREFIX = 'pid:';

/** The pid inside a `pid:<n>` handle, or `null` for anything else. PURE. */
export function detachedHandlePid(handle) {
  const raw = String(handle ?? '').trim();
  if (!raw.startsWith(DETACHED_HANDLE_PREFIX)) return null;
  const pid = Number(raw.slice(DETACHED_HANDLE_PREFIX.length));
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * IS THIS PID STILL RUNNING? `process.kill(pid, 0)` sends no signal — it only asks the kernel whether the
 * process exists and whether we may signal it. `EPERM` means it EXISTS and belongs to someone else, which is
 * still alive; `ESRCH` (and anything else) means gone.
 *
 * THIS IS THE READ THAT MAKES RESTART-SURVIVAL OBSERVABLE. It asks the kernel, not a listing and not the
 * process that started the delivery — so a runner that was restarted mid-delivery still gets a truthful `live:
 * true` for the detached process it no longer parents, and its double-dispatch guard holds the item instead of
 * starting a second build in an occupied lane.
 */
export function defaultIsPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return String(e?.code || '') === 'EPERM';
  }
}

/**
 * The DETACHED spawn primitive — named and exported for the same reason {@link defaultSpawnAgent} is: the
 * options ARE the contract (`detached`, the log fds, the `unref`), and an option no test can reach is an option
 * the next refactor deletes for free.
 *
 * `detached: true` makes the child a new session leader (Node calls `setsid`), so it is NOT in the runner's
 * process group and a group-wide signal — which is exactly what `we:scripts/operations/restart-runner-io.mjs`'s
 * shutdown sends — never reaches it. `.unref()` lets the dispatching process exit without waiting. `stdio` goes
 * to a real file because a detached child with a piped stdio nobody reads blocks on a full pipe, and because
 * the log is the only place a delivery's own narration survives.
 *
 * `settingsEnv` (#landing-freeze-2779) — THE FIX for a live landing-freeze incident (ci-heal-2779, 2026-09-26
 * ~20:55 ET transcript: "the GitHub token (GH_TOKEN) stopped working partway through, so I couldn't post the
 * CI-heal tally comment (HTTP 401)"). ROOT CAUSE: `dispatch-lane-io.mjs#createDispatchSinks` already computes
 * the correct per-dispatch env via `resolveSettingsEnv(sessionCwd)` — the gh-App-shim `PATH` override
 * (`gh-app-shim.mjs#buildGhShimSettingsEnv`) that resolves `gh` to a wrapper reading the shared token cache
 * FRESH on every call, never a value baked once — and hands it to `provider({..., settingsEnv})` for EVERY
 * launch kind. But every MECHANICAL provider (`dispatch-providers/*.mjs`) only ever read `pr`/`sessionSlug`/
 * `num`/`reason`/`cwd` off that request — `settingsEnv` was computed and then silently dropped on the floor.
 * This detached wrapper process's own `process.env` — inherited unsanitized from whatever process dispatched
 * it — was the ONLY env any of its own later `claude`/`gh` calls ever saw. On an App-auth-configured host that
 * env carries a REAL, then-valid `GH_TOKEN` (`github-app-auth-env.mjs#ensureFreshGithubAppEnv` sets it on the
 * DAEMON's own long-lived process) that is already up to an installation-token's ~1h life old by the time it
 * was inherited, and this wrapper (plus whatever agent/converge turn it spawns) can itself run for up to an
 * hour more (`deliver-item-wrapper.mjs`'s own docblock: "56 minutes, for the converge loop ALONE") — so the
 * token routinely expires mid-session, exactly as ci-heal-2779 hit.
 *
 * THE FIX, matching `defaultSpawnAgent`/`spawnAgentToCompletion`'s own already-correct treatment: (a)
 * `sanitizeSpawnEnv` strips any static `GH_TOKEN`/`GITHUB_TOKEN` from the inherited env before it can ride any
 * further — a stale value is worse than none; (b) the caller's own `settingsEnv` (when it has one — every
 * provider now forwards `request.settingsEnv`, see each `dispatch-providers/*.mjs`) is merged on top, so this
 * wrapper's OWN `process.env` — and thus every child it spawns via a plain `{...process.env, ...}` merge, which
 * is how every existing spawn site in `deliver-item-wrapper.mjs` already builds its child's env — carries the
 * shim `PATH` override too. That keeps `gh` on the App identity (never a fallback to the operator's own
 * personal auth by design elsewhere), just never a static value: every call reads the shared cache fresh.
 * `settingsEnv` omitted (a caller with nothing to add, or a test) keeps this byte-identical but for the
 * sanitize — no `--settings`-shaped surprise for anything that never wires one through.
 */
export function defaultSpawnDetached(argv, { cwd, logPath, settingsEnv = null, card = {}, kind = card.launchKind ?? 'build' } = {}, {
  spawn = nodeSpawn,
  ensureDir = (d) => mkdirSync(d, { recursive: true }),
  openLog = (p) => openSync(p, 'a'),
  closeLog = closeSync,
} = {}) {
  ensureDir(dirname(logPath));
  const fd = openLog(logPath);
  const env = markWorkerEnv({ ...sanitizeSpawnEnv(process.env), ...(settingsEnv || {}), ...routingPolicyEnv() });
  const opts = { cwd, detached: true, stdio: ['ignore', fd, fd], env };
  const child = withRuntimeAdmission(card, kind, () => spawn(process.execPath, argv, opts));
  if (child?.outcome === 'runtime-refused') { closeLog(fd); return child; }
  if (typeof child.unref === 'function') child.unref();
  return child;
}

/**
 * The vendor a detached wrapper runs for a given `--provider=<name>` (or none). PURE. `claude-restricted` is the
 * wrappers' Claude provider, so it reports as `claude`; any other name is the vendor itself (`codex`).
 * @param {string|null|undefined} deliveryAgent
 * @returns {string}
 */
// build-path-codex-isolation — lives here (not dispatch-lane-io.mjs) so the per-kind providers can import it
// without a cycle through the registry.
export function wrapperExecutorFor(deliveryAgent) {
  const name = String(deliveryAgent ?? '').trim();
  if (!name || name === 'claude-restricted') return 'claude';
  return name;
}

/** Diagnostic card filing has no delivery identity and remains available during a runtime hold. */
export function defaultSpawnDiagnosticDetached(argv, { cwd, logPath, settingsEnv = null } = {}, {
  spawn = nodeSpawn, ensureDir = d => mkdirSync(d, { recursive: true }),
  openLog = p => openSync(p, 'a'), closeLog = closeSync,
} = {}) {
  ensureDir(dirname(logPath));
  const fd = openLog(logPath);
  try {
    const child = spawn(process.execPath, argv, { cwd, detached: true, stdio: ['ignore', fd, fd],
      env: markWorkerEnv({ ...sanitizeSpawnEnv(process.env), ...(settingsEnv || {}), ...routingPolicyEnv() }) });
    child.unref?.();
    return child;
  } finally { closeLog(fd); }
}
