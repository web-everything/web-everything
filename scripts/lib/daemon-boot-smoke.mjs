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
 * entry gets its own, cold module graph, with no cross-entry contamination possible. Initial entries run
 * with bounded parallelism (default three); native signal deaths are retried serially after they drain.
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

import { cloneRuntimeEntries } from './daemon-clone-entries.mjs';
import { resolveClosureScopeMode } from './daemon-rebuild/closure-scope-settings.mjs';
import { randomBytes } from 'node:crypto';
import { closeSync, constants, existsSync, fchmodSync, mkdirSync, openSync, readdirSync, rmSync, statSync, writeSync } from 'node:fs';
import { join, posix } from 'node:path';

import { resolveChildTimeoutMs, runBounded } from './bounded-child.mjs';
import { redactDetail } from './daemon-rebuild/smoke-classify/redact-detail.mjs';
import { daemonStateDir } from './daemon-last-good.mjs';
import { cascadePolicy } from './policy-cascade.mjs';
import { readDeclaredSettings } from './settings-files.mjs';

// ── smoke diagnostics: an allow-listed summary out, raw child text only into an owner-only local file ──
// Operator decision (PR 5460, 2026-10-17): smoke failure details, self-sync alerts and PR comments never carry raw
// child stderr or stdout. They carry typed fields and an error CLASS; the raw tail goes to a 0600 file whose path the
// summary names.

/** `<daemon state dir>/smoke-diagnostics` — where the raw stderr tails live (never in a git tree, never in an alert). */
export function smokeDiagnosticsDir(env = process.env) {
  return join(daemonStateDir(env), 'smoke-diagnostics');
}

const ERROR_CLASS_LINE = /^[A-Z][A-Za-z]*Error:/;
const LINE_SPLIT = new RegExp(`\\r\\n|[\\n\\r${String.fromCharCode(0x85, 0x2028, 0x2029)}]`);
// Control AND format characters (bidi overrides, zero-width): none may reach an alert.
const CONTROL_CHARS = /[\p{Cc}\p{Cf}]/gu;
/** Each opening quote and its closer: ASCII, typographic, guillemets and fullwidth. */
const QUOTES = new Map([['"', '"'], ["'", "'"], ['`', '`'], ...[[0x201c, 0x201d], [0x2018, 0x2019], [0x201e, 0x201c],
  [0xab, 0xbb], [0xbb, 0xab], [0xff02, 0xff02], [0xff07, 0xff07]].map(([o, c]) => [String.fromCharCode(o), String.fromCharCode(c)])]);

const ANY_QUOTE = new Set([...QUOTES.keys(), ...QUOTES.values()]);
const OPEN_BOUNDARY = /[\s([{<:=,]/u;
const CLOSE_BOUNDARY = /[\s)\]}>.,;:!?]/u;

/**
 * Quoted text replaced with `<…>`. Pairing quotes is only trustworthy for ONE cleanly bounded string: V8 copies raw
 * input into a JSON SyntaxError (`Unexpected token 'h', "{"pw": hunter2}" is not valid JSON`) without escaping its
 * quotes, so pairing several would leave the text between them raw. So one string opened at a boundary, closed
 * before one, with no other quote after it, is masked in place; any other shape hides everything from the first quote.
 */
function maskQuoted(line) {
  let start = -1;
  for (let i = 0; i < line.length && start < 0; i++) if (QUOTES.has(line[i])) start = i;
  if (start < 0) return line;
  const close = QUOTES.get(line[start]);
  let j = start + 1;
  while (j < line.length && line[j] !== close) j += line[j] === '\\' ? 2 : 1;
  const rest = line.slice(j + 1);
  const clean = j < line.length && (start === 0 || OPEN_BOUNDARY.test(line[start - 1]))
    && (rest === '' || CLOSE_BOUNDARY.test(rest[0])) && ![...rest].some((c) => ANY_QUOTE.has(c));
  return `${line.slice(0, start)}<…>${clean ? rest : ''}`;
}

/** The closer of a quote still open after `line` (null when none), starting from `open`. An apostrophe between two
 *  letters (`can't`) is a contraction, not an opening quote. */
function quoteOpenAfter(line, open) {
  for (let i = 0; i < line.length; i++) {
    if (open !== null) {
      if (line[i] === '\\') i++;
      else if (line[i] === open) open = null;
      continue;
    }
    const close = QUOTES.get(line[i]);
    if (close !== undefined && !(line[i] === "'" && /\p{L}/u.test(line[i - 1] ?? '') && /\p{L}/u.test(line[i + 1] ?? ''))) open = close;
  }
  return open;
}

/**
 * The error class of untrusted child output: its first line matching `^[A-Z][A-Za-z]*Error:` that does not sit inside
 * a quote opened on an earlier line (a multi-line quoted value can hold a class-shaped line), cut to 80 chars, quoted
 * text masked ({@link maskQuoted}). Null when no line qualifies. This is the ONLY child text a smoke summary carries;
 * token shapes in it are redacted too.
 */
export function smokeErrorClass(text) {
  try {
    let open = null;
    for (const line of String(text ?? '').split(LINE_SPLIT)) {
      if (open === null && ERROR_CLASS_LINE.test(line)) return redactDetail(maskQuoted(line.slice(0, 80)).replace(CONTROL_CHARS, ''));
      open = quoteOpenAfter(line, open);
    }
    return null;
  } catch {
    return null;
  }
}

const REPO_FILE = /^[A-Za-z0-9_@+-][A-Za-z0-9._@+/-]{0,255}$/;
/** A repo-relative source path in a plain charset, no `..` segment: the only shape a summary's `files` may hold. */
export const isRepoFile = (p) => typeof p === 'string' && REPO_FILE.test(p) && !p.split('/').includes('..');

/**
 * PURE: the repo files named by complete source locations (`file:///…:N`, `/abs/x.mjs:N`) in raw child text under
 * `candidatePath` (or a `*.candidate-*` tree), plus `The requested module './x'` resolved against those importers.
 * Read in-process from the raw text, so a summary can name the culprit files without carrying the text.
 */
export function sourceFilesIn(text, candidatePath) {
  const files = new Set();
  const raw = String(text ?? '');
  const prefix = candidatePath ? candidatePath.replace(/\/$/, '') + '/' : null;
  const add = (path) => {
    const normalized = posix.normalize(path);
    if (normalized !== '.' && normalized !== '..' && !normalized.startsWith('../') && !posix.isAbsolute(normalized)) {
      files.add(normalized);
      return normalized;
    }
    return null;
  };
  const importers = [];
  for (const match of raw.matchAll(/(?:file:\/\/(\/[^\s"'<>():]+)|(\/[^\s"'<>():]+\.(?:mjs|js|cjs|json|ts))):\d+/g)) {
    const absolute = match[1] ?? match[2];
    const relative = prefix && absolute.startsWith(prefix)
      ? absolute.slice(prefix.length)
      : absolute.match(/\/[^/]+\.candidate-[^/]+\/(.+)$/)?.[1];
    if (relative) {
      const importer = add(relative);
      if (importer) importers.push(importer);
    }
  }
  for (const match of raw.matchAll(/The requested module '([^']+)'/g)) {
    if (!match[1].startsWith('./') && !match[1].startsWith('../')) continue;
    for (const importer of importers) add(posix.join(posix.dirname(importer), match[1]));
  }
  return [...files];
}

/** A signal name, an integer exit code: anything else from a child-shaped error object reads as null. */
export const smokeSignal = (v) => (typeof v === 'string' && /^SIG[A-Z0-9]{1,12}$/.test(v) ? v : null);
export const smokeExitCode = (v) => (Number.isSafeInteger(v) ? v : null);

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const PATH_TEXT = /^[^\n\r\u0000]{1,1024}$/;
const isBool = (v) => typeof v === 'boolean';
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
/** The smoke summary's allow-list: each field and the one type it may hold. Anything else is dropped. */
const SUMMARY_FIELDS = Object.freeze({
  launchStartedAt: (v) => typeof v === 'string' && ISO_TIME.test(v),
  signal: (v) => smokeSignal(v) !== null,
  exitCode: (v) => smokeExitCode(v) !== null,
  wrapperPid: (v) => Number.isSafeInteger(v) && v > 0,
  wrapperAliveAtTimeout: isBool,
  sessionAppeared: isBool,
  transcriptAppeared: isBool,
  firstOutputMs: (v) => Number.isFinite(v) && v >= 0,
  attempts: isCount,
  stderrFile: (v) => typeof v === 'string' && PATH_TEXT.test(v),
  // Last: the one field holding child text, so in a `k=v` rendering it cannot pose as a later field.
  errorClass: (v) => typeof v === 'string' && v.length <= 120 && ERROR_CLASS_LINE.test(v) && !LINE_SPLIT.test(v)
    && v === v.replace(CONTROL_CHARS, '') && v === redactDetail(v),
});

/** The allow-listed form of a smoke diagnostics object (null for a non-object): typed fields only, every other
 *  value null. A sink calls this, so even a hand-built or injected result cannot carry raw child text through. */
export function pickSmokeDiagnostics(d) {
  if (!d || typeof d !== 'object') return null;
  return Object.fromEntries(Object.entries(SUMMARY_FIELDS).map(([k, ok]) => [k, ok(d[k]) ? d[k] : null]));
}

const TAIL_LINES = 30;
const TAIL_READ_CHARS = 64 * 1024;
// Room for several rebuilds' worth (up to 6 entries × retries × smoke passes each) across every clone sharing the dir.
const KEEP_DIAGNOSTICS = 500;

/** Keep the newest {@link KEEP_DIAGNOSTICS} entries of the diagnostics dir, so failed smokes never grow it unbounded. */
function pruneDiagnostics(dir) {
  try {
    const rows = readdirSync(dir).map((name) => {
      try { return { name, at: statSync(join(dir, name)).mtimeMs }; } catch { return null; }
    }).filter(Boolean).sort((a, b) => b.at - a.at);
    for (const row of rows.slice(KEEP_DIAGNOSTICS)) rmSync(join(dir, row.name), { recursive: true, force: true });
  } catch { /* pruning is best effort */ }
}

/**
 * Write the last 30 lines of raw child output to a NEW owner-only (0600) file under `dir` (created 0700) and return
 * its path; null when there is nothing to write or the write fails (the text is then dropped, never inlined).
 */
export function writeStderrTail(text, { dir, label = 'smoke', now = Date.now } = {}) {
  try {
    const raw = String(text ?? '').slice(-TAIL_READ_CHARS).trimEnd();
    if (!raw || !dir) return null;
    const tail = raw.split(/\r\n|[\n\r]/).slice(-TAIL_LINES).join('\n');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
    const file = join(dir, `${String(label).replace(/[^A-Za-z0-9.-]+/g, '_').slice(0, 80)}-${stamp}-${randomBytes(4).toString('hex')}.log`);
    // O_EXCL + O_NOFOLLOW: always a fresh file, so its 0600 mode is the one set here, never an existing file's.
    const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      fchmodSync(fd, 0o600);
      writeSync(fd, `${tail}\n`);
    } finally {
      closeSync(fd);
    }
    pruneDiagnostics(dir);
    return file;
  } catch {
    return null;
  }
}

/** An env integer, strictly decimal digits; empty, blank, signed or hex values read as unset (never as 0). */
export const strictEnvInteger = (v) => (/^\d+$/.test(String(v ?? '')) ? Number(v) : undefined);

/** Initial boots are bounded; only native signal deaths get serial retries. */
export function resolveBootSettings(env = process.env) {
  const r = cascadePolicy('rebuildSmoke', readDeclaredSettings().settings?.rebuildSmoke, {
    env, standard: { bootSignalRetries: 1, bootConcurrency: 3, bootMinChildMs: 10_000 },
    envValues: { bootMinChildMs: strictEnvInteger(env.WE_SMOKE_BOOT_MIN_CHILD_MS), bootSignalRetries: strictEnvInteger(env.WE_SMOKE_BOOT_SIGNAL_RETRIES), bootConcurrency: strictEnvInteger(env.WE_SMOKE_BOOT_CONCURRENCY) },
    valid: {
      bootSignalRetries: v => Number.isSafeInteger(v) && v >= 0,
      bootConcurrency: v => Number.isSafeInteger(v) && v > 0,
      bootMinChildMs: v => Number.isSafeInteger(v) && v > 0,
    },
  });
  return { ...r.value, sources: r.sources };
}

const RETRY_SIGNALS = new Set(['SIGTRAP', 'SIGSEGV', 'SIGABRT', 'SIGBUS', 'SIGILL']);

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

/** Resolve the entry list: override (test/soak only), live clone discovery in `on` mode, else the fixed list.
 *  `overridden:true` whenever the override actually supplied the list — the check surfaces this loudly in its
 *  own `detail` (never silently), so an override that leaked into a real daemon's environment shows up in the
 *  smoke's own result instead of quietly narrowing what gets boot-checked. */
export function resolveDaemonEntries(env = process.env, { root, runtimeEntries = cloneRuntimeEntries, fixedEntriesOnly = false } = {}) {
  const raw = env?.[DAEMON_ENTRIES_ENV];
  if (typeof raw === 'string' && raw.trim()) {
    return { entries: raw.split(',').map((s) => s.trim()).filter(Boolean), overridden: true };
  }
  const cloneRoot = env?.WE_SMOKE_LIVE_CLONE || root;
  const discover = cloneRoot && !fixedEntriesOnly && resolveClosureScopeMode(env).mode === 'on';
  return { entries: discover ? runtimeEntries({ root: cloneRoot, entries: [], env }) : DAEMON_ENTRY_MODULES, overridden: false };
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

/** Boot ONE entry in its OWN fresh child — never throws; a child failure (killed, unparsable output) is
 *  reported the same shape as an entry that threw on import, so the caller has one uniform per-entry result.
 *  The result is the allow-listed summary only: raw child output goes to {@link writeStderrTail}'s 0600 file. */
async function bootOneEntry(entry, { root, timeoutMs, bootMinChildMs, runChild, env, diagnosticsDir, now }) {
  let startMs = NaN;
  let startedAt = null;
  try { startMs = now(); startedAt = new Date(startMs).toISOString(); } catch { /* a bad injected clock: no start time, never a throw */ }
  const elapsed = () => {
    try {
      const ms = now() - startMs;
      return Number.isFinite(ms) && ms >= 0 ? ms : null;
    } catch { return null; }
  };
  const keep = (text) => writeStderrTail(text, { dir: diagnosticsDir, label: `boot-${entry}`, now });
  // The culprit attribution (`daemon-rebuild/smoke.mjs#smokeFailureFiles`) reads these typed paths, not the text.
  const filesIn = (text) => sourceFilesIn(text, root).filter(isRepoFile);
  const importFailure = (parsed, elapsedMs) => {
    // The boot script joins its stack lines with ' | '.
    const error = String(parsed?.error ?? '').split(' | ').join('\n');
    return { entry, ok: false, kind: 'import failed', startedAt, elapsedMs, signal: null, exitCode: null,
      errorClass: smokeErrorClass(error), files: filesIn(error), stderrFile: keep(error) };
  };
  let out;
  try {
    out = await runChild('node', ['--input-type=module', '-e', buildEntryBootScript(entry)], { cwd: root, timeoutMs, minChildMs: Math.min(timeoutMs, bootMinChildMs), env });
  } catch (e) {
    const elapsedMs = elapsed();
    // An import may already have failed while an outstanding timer keeps the child alive until its kill.
    // Only a complete failure report overrides the child failure; malformed/missing output stays failed.
    let parsed;
    try { parsed = JSON.parse(e?.stdout); } catch { /* no complete harness report */ }
    if (parsed?.ok === false && typeof parsed.error === 'string') return importFailure(parsed, elapsedMs);
    const stderr = String(e?.stderr ?? '');
    // The rebuild's own budget refusal and the bounded child's own kill reasons (never child text): kept verbatim,
    // matched exactly, so a timeout still reads as one.
    const own = BUDGET_REFUSAL.exec(String(e?.message ?? '')) ?? BOUNDED_KILL.exec(String(e?.message ?? ''));
    return { entry, ok: false, kind: own ? `child failed: ${own[0]}` : 'child failed', timeoutMs, startedAt, elapsedMs, signal: smokeSignal(e?.signal), exitCode: smokeExitCode(e?.status),
      errorClass: smokeErrorClass(stderr) ?? smokeErrorClass(e?.message), files: filesIn(`${stderr}\n${e?.message ?? ''}`),
      stderrFile: keep(stderr || e?.message) };
  }
  const elapsedMs = elapsed();
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch {
    // V8's parse message copies raw output with unescaped quotes, so the class is fixed text; the output goes to the file.
    return { entry, ok: false, kind: 'unparsable child output', startedAt, elapsedMs, signal: null, exitCode: null,
      errorClass: 'SyntaxError: unparsable child output', stderrFile: keep(out) };
  }
  if (parsed?.ok) return { entry, ok: true, startedAt, elapsedMs };
  return importFailure(parsed, elapsedMs);
}

const BUDGET_REFUSAL = /^skipped: rebuild smoke budget exhausted \(\d+ms left\)$/;
/** `bounded-child.mjs#runBounded`'s own timeout / output-cap messages. */
const BOUNDED_KILL = /^(?:timed out after \d+ms|output exceeded \d+ bytes) \(process group killed\)$/;

/** One failed entry's summary line: typed fields, the local file, and the error class LAST (it is child text, so it
 *  cannot pose as a later field) — never other child text. */
function entrySummary(r) {
  return `- ${r.entry}: ${r.kind} (signal=${r.signal}, exitCode=${r.exitCode}, attempts=${r.attempts.length}, startedAt=${r.startedAt})`
    + ` stderr=${r.stderrFile ?? 'none'} class=${r.errorClass ?? 'none'}`;
}

/**
 * THE CHECK — same `(ctx) -> {ok, detail}` contract as every row in `daemon-live-smoke.mjs#SMOKE_CHECKS`.
 * @param {{root:string, budgets?:Record<string,number>, runChild?:typeof runBounded, env?:NodeJS.ProcessEnv, log?:Console,
 *   diagnosticsDir?:string, clock?:() => number, now?:() => number}} ctx
 * @returns {Promise<{ok:boolean, detail:string, entries?:Array<object>}>}
 */
export async function checkDaemonEntriesBoot({
  root, runtimeEntries, budgets = {}, runChild = runBounded, env = process.env, log = console, diagnosticsDir = smokeDiagnosticsDir(env), clock,
  // The live smoke's injected clock (ctx.clock) times the attempts, so a replayed smoke reports the same start times.
  now = typeof clock === 'function' ? clock : Date.now,
}) {
  const settings = resolveBootSettings(env);
  try {
    if (!process.env.VITEST || log !== console) {
      log.error?.(`daemon-boot-smoke: rebuildSmoke ${JSON.stringify(settings)}`);
    }
  } catch { /* diagnostics only */ }
  let entries, overridden;
  // `root` is the tree to boot, often a disposable candidate, not evidence of a live clone. Production
  // discovery in `on` mode uses WE_SMOKE_LIVE_CLONE; an injected resolver selects discovery against root.
  // When the boot tree has none of the fixed entries, boot that list directly: real imports must fail,
  // while injected-child fixtures need no host LaunchAgents. Inspect the boot tree, not the live root,
  // so an unreadable live root cannot bypass discovery when a real candidate's entries are present.
  try {
    const discover = runtimeEntries ?? (DAEMON_ENTRY_MODULES.some(entry => existsSync(join(root, entry)))
      ? cloneRuntimeEntries : () => DAEMON_ENTRY_MODULES);
    ({ entries, overridden } = resolveDaemonEntries(env, { root: runtimeEntries ? root : undefined, runtimeEntries: discover }));
  }
  catch { return { ok: false, detail: 'runtime entries unreadable — inspect clone LaunchAgents before retrying smoke' }; }
  // #4468 review — never silently trust an override-or-real entry's shape; a traversal/absolute/scheme
  // specifier resolves OUTSIDE the candidate tree via `new URL(rel, 'file://' + cwd + '/')`. Refuse loud,
  // before spawning anything.
  const unsafe = entries.filter((rel) => !isSafeRelativeEntry(rel));
  if (unsafe.length) {
    return { ok: false, detail: `refusing unsafe entry path(s) (must be repo-relative, no "..", no leading "/", no URL scheme): ${unsafe.join(', ')}` };
  }
  const overrideMarker = overridden ? `⚠ WE_SMOKE_DAEMON_ENTRIES override active (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}, real list bypassed) — ` : '';
  const timeoutMs = budgets.daemonBootMs ?? resolveChildTimeoutMs(env);
  const options = { root, timeoutMs, bootMinChildMs: settings.bootMinChildMs, runChild, env, diagnosticsDir, now };
  const results = new Array(entries.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(settings.bootConcurrency, entries.length) }, async () => {
    while (next < entries.length) {
      const index = next++;
      results[index] = await bootOneEntry(entries[index], options);
    }
  }));
  // Drain all initial children before retrying, one at a time, to avoid repeating the pressure spike.
  for (let index = 0; index < results.length; index++) {
    const attempts = [results[index]];
    while (!results[index].ok && RETRY_SIGNALS.has(results[index].signal) && attempts.length <= settings.bootSignalRetries) {
      results[index] = await bootOneEntry(entries[index], options);
      attempts.push(results[index]);
    }
    results[index] = { ...results[index], attempts };
  }
  const retryNotes = results.filter(r => r.attempts.length > 1)
    .map(r => `${r.entry}: retried after ${r.attempts.slice(0, -1).map(a => a.signal).join(', ')}`).join('; ');
  const notes = retryNotes ? ` — ${retryNotes}` : '';
  const failures = results.filter((r) => !r.ok);
  if (failures.length) {
    const retryLines = results.filter(r => r.attempts.length > 1)
      .map(r => `${r.entry}: retried after ${r.attempts.slice(0, -1).map(a => a.signal).join(', ')}`);
    return { ok: false, entries: results, detail: [`${overrideMarker}${failures.length}/${results.length} daemon entr${failures.length === 1 ? 'y' : 'ies'} failed to boot:`, ...failures.map(entrySummary), ...retryLines].join('\n') };
  }
  return { ok: true, entries: results, detail: `${overrideMarker}all ${results.length} daemon entries booted clean: ${results.map((r) => r.entry).join(', ')}${notes}` };
}

/** The `SMOKE_CHECKS` row `daemon-live-smoke.mjs` appends. */
export const DAEMON_BOOT_SMOKE_CHECK = Object.freeze({
  name: 'daemon-entries-boot',
  kind: 'env',
  run: checkDaemonEntriesBoot,
  mayBeTransient: false,
  codeEntries: DAEMON_ENTRY_MODULES,
});
