/**
 * @file scripts/lib/daemon-boot-smoke.mjs — #4468. Closes a real gap in `daemon-live-smoke.mjs#SMOKE_CHECKS`:
 * every existing check exercises a DISPATCH/RECONCILE CODE PATH (a dry run, a lane-pool round trip, a `gh`
 * read) — none of them ever BOOTS a daemon's own entry module, the exact file `daemon-self-sync.mjs#withSelfSync`
 * (or launchd's `KeepAlive`) next runs `node <entry>.mjs` on.
 *
 * LIVE 2026-09-29 ~10:45 ET (#2921): an overlay introduced an ESM circular-import TDZ (`ReferenceError: Cannot
 * access 'DELIVER_ITEM_RUN_SCRIPT' before initialization` in `scripts/operations/dispatch-provider-registry.mjs`,
 * imported transitively by every dispatch-shaped daemon entry via `dispatch-lane-io.mjs`). The live smoke PASSED
 * — nothing it runs ever imports that closure the way `node build-dispatch-daemon.mjs --live` actually does — so
 * the candidate was adopted, and the moment the daemon next started onto it, the process died at IMPORT time,
 * before a single line of `main()` ran. `daemon-live-smoke.mjs#rollbackToSha` — the code that would otherwise
 * roll a bad build back — runs INSIDE that same process, so a build broken this way can never roll itself back:
 * the daemon crash-loops until a human removes the overlay by hand.
 *
 * THE FIX: {@link checkDaemonEntriesBoot} spawns ONE CHILD PER ENTRY, each dynamically `import()`ing ONE module
 * from {@link DAEMON_ENTRY_MODULES} against the CANDIDATE tree (`cwd: root`) — never invoking that entry's
 * `main()`. Every entry gates its own CLI body behind an `import.meta.url === pathToFileURL(process.argv[1]).href`
 * (or the equivalent `resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))`) guard. The harness
 * that runs here is a bare `node --input-type=module -e <script>` — in eval mode `process.argv[1]` is
 * `undefined`, not the harness's own path — so EVERY entry's guard reads false the moment it dereferences
 * `process.argv[1]` (a falsy `&&` short-circuit, or a `resolve(undefined)` throw an entry would need to guard
 * against explicitly; every entry here already does, by writing `process.argv[1] && …`). Only module-top-level
 * code (imports, top-level `const`s, the exact code that crashed live) ever executes.
 *
 * ONE CHILD PER ENTRY, NOT ONE SHARED CHILD FOR ALL SIX (#4468 review — a real correctness gap in an earlier
 * draft): Node's ESM loader caches a module by resolved URL for the LIFETIME of the process. If entry A and
 * entry B both transitively import module X, and X's own circular-import TDZ only manifests when X is reached
 * via B's particular cycle (not A's), then checking A FIRST in a shared child would warm X into the cache
 * successfully — and B's later `import()` of X would return the CACHED module without re-evaluating it,
 * silently masking exactly the class of bug this check exists to catch. A fresh child per entry means each
 * entry gets its own, cold module graph, with no cross-entry contamination possible. The entries run in
 * PARALLEL (`Promise.all`), so this costs wall-time only up to the SLOWEST entry, not the sum of all six.
 *
 * A dynamic `import()` that throws (a `ReferenceError`, a `SyntaxError`, a missing module) is caught PER ENTRY —
 * one broken entry is reported by name, and every OTHER entry still gets its own independent child, so a caller
 * sees every broken entry, not just the first — and ANY entry failing to boot fails the whole check.
 *
 * Exported as {@link DAEMON_BOOT_SMOKE_CHECK}, appended to `daemon-live-smoke.mjs#SMOKE_CHECKS` (right before
 * the always-last `tree-stays-clean` row): same check contract (`{ok, detail}`), `mayBeTransient:false` (it runs
 * code FROM the tree under test — the same rule every `cwd:root` check in that file follows), `codeEntries` =
 * {@link DAEMON_ENTRY_MODULES} itself, so `#4044`'s skip-unchanged logic still skips a re-run when none of these
 * entries' own import closure changed since the last live-verified build.
 *
 * THE STRING-SPLIT `import()` CALL BELOW, and building the specifier via `new URL(rel, 'file://' + cwd + '/')`
 * rather than a static `import … from` line, mirror `daemon-live-smoke.mjs#DISPATCH_DRY_RUN_LINES`'s own
 * documented trick: a literal `import(...)`/`import … from '...'` inside a source string is read as a real
 * import by static scanners (`we:scripts/operations/__tests__/import-graph.mjs`, and `import-closure.mjs`'s own
 * closure walker), which then tries to resolve it as if IT were this file's own import and fails, or marks the
 * closure incomplete (silently disabling skip-unchanged). Splitting the token, and avoiding `node:url`/
 * `node:path` imports in the child entirely, is invisible to both scanners while producing the exact same
 * runtime call.
 */

import { resolveChildTimeoutMs, runBounded } from './bounded-child.mjs';

/** Env override: a comma-separated list of repo-relative paths, in place of {@link DAEMON_ENTRY_MODULES} — for
 *  a test/soak scenario to point the check at a fixture entry without needing a real production daemon file to
 *  actually be broken. Intended for a test/soak run only — production is expected to leave this unset, so it
 *  always uses the real list — but nothing in a daemon's own env can enforce "unset in production" from here;
 *  see {@link checkDaemonEntriesBoot}'s loud `detail` marker (a real-panel finding, #4468) and
 *  {@link isSafeRelativeEntry}'s path-shape check for the two things THIS module can still guarantee even if
 *  the override leaks into a real environment: the override is never silent, and it can never resolve outside
 *  the candidate tree. */
export const DAEMON_ENTRIES_ENV = 'WE_SMOKE_DAEMON_ENTRIES';

/** Default budget for this check, folded into `daemon-live-smoke.mjs#resolveSmokeBudgets` as `daemonBootMs`
 *  (env override `WE_SMOKE_DAEMON_BOOT_MS` — that file's own `SMOKE_BUDGET_ENV.daemonBootMs` is the ONE place
 *  the env var name is spelled; #4468 review — a second copy of the same string here was dead weight). */
export const DEFAULT_DAEMON_BOOT_MS = 45_000;

/**
 * Every standalone daemon entry point this repo runs `node <entry>.mjs --live/--once/--self-sync` on — the file
 * `withSelfSync`/launchd's `KeepAlive` boots after a rebuild. Repo-relative, one per real long-lived daemon
 * process (its own `runDaemonLoop`/`withSelfSync` call). Deliberately NOT
 * `scripts/operations/runner-activity-io.mjs#KNOWN_DAEMONS` (scoped to process-IDENTITY matching for exactly 3
 * daemons, by that file's own header) and NOT `skills-src/conveyor/daemon-manifest.mjs#DAEMON_MANIFEST` (a
 * closed allowlist for `pass-daemon.mjs`'s own lighter per-pass watchers, not standalone daemon processes) —
 * this is its own list, scoped to exactly this concern: which files the constellation actually runs as a
 * long-lived daemon process. A new standalone daemon entry (its own `runDaemonLoop`/`withSelfSync` call) belongs
 * here too.
 * @type {ReadonlyArray<string>}
 */
export const DAEMON_ENTRY_MODULES = Object.freeze([
  'skills-src/conveyor/runner.mjs',
  'skills-src/conveyor/build-dispatch-daemon.mjs',
  'skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs',
  'skills-src/conveyor/review-daemon.mjs',
  'skills-src/conveyor/verify-daemon.mjs',
  'skills-src/conveyor/pass-daemon.mjs',
]);

/** Resolve the entry list a call should use: `env`'s override when set (test/soak only), else the real list.
 *  `overridden:true` whenever the override actually supplied the list — the check surfaces this loudly in its
 *  own `detail` (never silently), so an override that leaked into a real daemon's environment shows up in the
 *  smoke's own result instead of quietly narrowing what gets boot-checked. */
export function resolveDaemonEntries(env = process.env) {
  const raw = env?.[DAEMON_ENTRIES_ENV];
  if (typeof raw === 'string' && raw.trim()) {
    return { entries: raw.split(',').map((s) => s.trim()).filter(Boolean), overridden: true };
  }
  return { entries: DAEMON_ENTRY_MODULES, overridden: false };
}

/** A fixed, never-real marker base — resolving `rel` against THIS exact base is how {@link isSafeRelativeEntry}
 *  proves containment, rather than pattern-matching the raw string for `..`/a leading slash/a scheme (#4468
 *  review: a naive `!rel.includes('..')` string check misses a percent-encoded traversal like
 *  `%2e%2e/evil.mjs` — `new URL('%2e%2e/evil.mjs', 'file:///root/')` resolves to `file:///evil.mjs`, OUTSIDE
 *  `root`, because dot-segment removal runs on the DECODED path. Resolving against this marker and checking the
 *  RESULT's pathname stays prefixed with it inherits whatever the URL spec actually does — including that
 *  exact decode — instead of re-deriving it by hand and risking the next encoding trick). */
const SAFE_ENTRY_BASE = 'file:///__daemon_boot_smoke_root__/';
const SAFE_ENTRY_PATH_PREFIX = '/__daemon_boot_smoke_root__/';

/** A `rel` entry is safe to hand to {@link buildEntryBootScript}'s `new URL(rel, 'file://' + cwd + '/')` resolution
 *  only when resolving it against {@link SAFE_ENTRY_BASE} stays a `file:` URL whose path is still UNDER that
 *  base — i.e. it can never escape the candidate root (no `..` traversal, encoded or not), never jump to an
 *  absolute filesystem path, and never switch to a different URL scheme (`data:`, `https:`, … — an absolute
 *  specifier resolves AS ITSELF, ignoring the base entirely, which is exactly what a scheme change reveals
 *  here). Applied to EVERY entry, not just an override-supplied one — defense in depth, since
 *  {@link DAEMON_ENTRY_MODULES} is trusted but this check is cheap and the two paths (real list, override)
 *  share the same resolution code either way. */
export function isSafeRelativeEntry(rel) {
  if (typeof rel !== 'string' || !rel) return false;
  let resolved;
  try {
    resolved = new URL(rel, SAFE_ENTRY_BASE);
  } catch {
    return false;
  }
  return resolved.protocol === 'file:' && resolved.pathname.startsWith(SAFE_ENTRY_PATH_PREFIX);
}

/** Build ONE entry's own child harness script — a single dynamic `import()`, reporting `{ok}` or
 *  `{ok:false, error}` as its whole stdout. See the file header for why the `import(` token is split across a
 *  string concatenation rather than written literally, and why this is one script per entry, not one shared
 *  script for the whole list. */
export function buildEntryBootScript(entry) {
  const im = 'im' + 'port';
  const lines = [
    // A stable, harmless marker so a caller (or a test fixture) can tell this script apart from
    // `daemon-live-smoke.mjs#DISPATCH_DRY_RUN_SCRIPT` — both spawn `node --input-type=module -e <script>`, and
    // both happen to share the `'file://' + process.cwd() + '/'` base-URL idiom, so neither script's own
    // content is otherwise a safe disambiguator.
    '// daemon-boot-smoke:entry-boot',
    'try {',
    `  await ${im}(new URL(${JSON.stringify(entry)}, 'file://' + process.cwd() + '/').href);`,
    "  process.stdout.write(JSON.stringify({ ok: true }));",
    '} catch (e) {',
    "  process.stdout.write(JSON.stringify({ ok: false, error: String((e && e.stack) || e).split('\\n').slice(0, 3).join(' | ') }));",
    '}',
  ];
  return lines.join('\n');
}

const firstLine = (e) => String((e && e.message) || e).split('\n')[0];

/** Boot ONE entry in its OWN fresh child — never throws; a child failure (killed, unparsable output) is
 *  reported the same shape as an entry that threw on import, so the caller has one uniform per-entry result. */
async function bootOneEntry(entry, { root, timeoutMs, runChild, env }) {
  let out;
  try {
    out = await runChild('node', ['--input-type=module', '-e', buildEntryBootScript(entry)], { cwd: root, timeoutMs, env });
  } catch (e) {
    return { entry, ok: false, error: `child failed: ${firstLine(e)}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch (e) {
    return { entry, ok: false, error: `unparsable child output: ${firstLine(e)}` };
  }
  return { entry, ok: !!parsed?.ok, error: parsed?.error };
}

/**
 * THE CHECK — same `(ctx) -> {ok, detail}` contract as every row in `daemon-live-smoke.mjs#SMOKE_CHECKS`.
 * @param {{root:string, budgets?:Record<string,number>, runChild?:typeof runBounded, env?:NodeJS.ProcessEnv}} ctx
 * @returns {Promise<{ok:boolean, detail:string}>}
 */
export async function checkDaemonEntriesBoot({ root, budgets = {}, runChild = runBounded, env = process.env }) {
  const { entries, overridden } = resolveDaemonEntries(env);
  // #4468 review — never silently trust an override-or-real entry's shape; a traversal/absolute/scheme
  // specifier resolves OUTSIDE the candidate tree via `new URL(rel, 'file://' + cwd + '/')`. Refuse loud,
  // before spawning anything.
  const unsafe = entries.filter((rel) => !isSafeRelativeEntry(rel));
  if (unsafe.length) {
    return { ok: false, detail: `refusing unsafe entry path(s) (must be repo-relative, no "..", no leading "/", no URL scheme): ${unsafe.join(', ')}` };
  }
  const overrideMarker = overridden ? `⚠ WE_SMOKE_DAEMON_ENTRIES override active (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}, real list bypassed) — ` : '';
  const timeoutMs = budgets.daemonBootMs ?? resolveChildTimeoutMs(env);
  // One child PER entry, run in PARALLEL — see the file header for why a shared child risks a cross-entry
  // module-cache false negative. Wall time is bounded by the slowest entry, not the sum of all of them.
  const results = await Promise.all(entries.map((entry) => bootOneEntry(entry, { root, timeoutMs, runChild, env })));
  const failures = results.filter((r) => !r.ok);
  if (failures.length) {
    const detail = failures.map((f) => `${f.entry}: ${f.error}`).join('; ');
    return { ok: false, detail: `${overrideMarker}${failures.length}/${results.length} daemon entr${failures.length === 1 ? 'y' : 'ies'} failed to boot: ${detail}` };
  }
  return { ok: true, detail: `${overrideMarker}all ${results.length} daemon entries booted clean: ${results.map((r) => r.entry).join(', ')}` };
}

/** The `SMOKE_CHECKS` row `daemon-live-smoke.mjs` appends. */
export const DAEMON_BOOT_SMOKE_CHECK = Object.freeze({
  name: 'daemon-entries-boot',
  kind: 'env',
  run: checkDaemonEntriesBoot,
  mayBeTransient: false,
  codeEntries: DAEMON_ENTRY_MODULES,
});
