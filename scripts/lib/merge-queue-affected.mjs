/**
 * @file scripts/lib/merge-queue-affected.mjs
 * @description The merge queue's `affected` re-test mode (operator go 2026-10-09 16:35 ET). Decides whether the code
 *   main gained since a PR's tested base CAN affect that PR. If it cannot, the PR's passing run still proves its
 *   code, so the drain merges it without a rebase + CI re-run.
 *
 * WHY: in the middle-ground mode (`any-code`, #4538/#4619) ANY code change on main since the PR's passing run forces
 *   a refresh. Measured 2026-10-09: drain passes of 72-231 s, mergeCascade up to 138 s, mostly refreshes of PRs whose
 *   files main never came near.
 *
 * THE RULE (pure, {@link decideAffected}). Re-test (affected) when ANY of these hold, else not affected:
 *   1. a gate file is touched on either side — the merge path, the queue rules, CI workflows, test infra, package
 *      and config files ({@link isGateFile}). A change to the gate itself is never trusted to judge itself, so this is
 *      checked FIRST: even a main move that gained no code (docs, backlog) does not excuse a PR that edits the gate.
 *      Of the declared settings (`scripts/settings/`) only the ones the gate reads are the gate; any other changed
 *      settings file is replaced by the source files that read it before rules 2-7 run ({@link SETTINGS_FILE_RE});
 *   2. a changed code file sits under a directory-discovered fixture root (`hitsGlobEdge`): those edges are not
 *      imports, so the import graph cannot see them;
 *   3. main changed a file the PR also changed;
 *   4. a file main changed reaches a file the PR changed (imports followed transitively, through unchanged modules,
 *      read at the main tip), or a file the PR changed reaches a file main changed (read at the PR head). Through the
 *      repo's own import parser (we:scripts/lib/related-test-selection.mjs, the same one the local gate's test
 *      selection uses);
 *   5. a shared importer: an UNCHANGED test, spec or entry-point file (one nothing outside its own import cycle
 *      imports, such as check:standards or a build script, or a member of a closed cycle) reaches (reverse imports, through any unchanged modules, read at the main tip) both a file
 *      the PR changed and a file main changed. The two forward walks of rule 4 cannot see it; CI running that file
 *      after the merge exercises both together. A file the PR adds counts as imported by every unchanged file that
 *      already names it by a specifier that resolved to nothing or to a lower-priority file;
 *      Test infrastructure vitest loads for every test file (root `vitest.*.{ts,mjs}`: config, setup, global setup) has no
 *      importing test, so a change on either side that those files reach re-tests, under reason `test-infra-reached`;
 *   6. a changed non-source file (JSON, YAML, CSS, HTML, an image, an extensionless script) on either side: data a test
 *      or script reads through `fs` has no import edge, and its reader can be an unchanged file or one either side adds,
 *      so it re-tests, under reason `data-file-changed` (checked last: a data file an import does reach keeps the more
 *      specific reason);
 *   7. an import list could not be read, the tip's reverse graph could not be read in full or has more than
 *      {@link MAX_REVERSE_FILES} sources, or a forward closure is larger than {@link MAX_CLOSURE_FILES} — fail closed.
 *   NOT covered, by design: SOURCE files read through `fs` as text (a repo-scanning test) and files loaded through a
 *   computed path — card x0e6tik. This is the ACCEPTED BOUND (operator ruling 2026-10-10): closing it would re-test a
 *   large share of PRs and erase the speed gain, and tests still run on main and on the PR per settings, so a miss is
 *   caught eventually. The card stays open; closing it is card x0e6tik's remaining work.
 *   PROSE under `nonCodePaths` (Markdown/text docs, backlog cards) never counts, as in `any-code`; a source or data file
 *   there is code like any other ({@link isNonCodeFile}, shared with the hook). A prose-only main move answers
 *   `main-gained-no-code` without reading any graph, so it never excuses the pass's age ({@link excusesPassAge}): it
 *   is judged exactly as `any-code` judges it (a disjoint non-code move, inside `maxAgeMinutes`). A PR file that reads
 *   changed prose (`fs`, a `?raw` import) is covered to that extent, no further.
 *
 * IO ({@link readAffectedFacts}): reads file contents with `git show <sha>:<path>` in the drain's own clone,
 *   fetching the two commits from `origin` when absent. Rule 5 reads the whole tip tree in ONE `git cat-file --batch`
 *   spawn, once per tip sha (shared by every PR judged against that tip), and only when rules 1-4 left the PR open. A clone that cannot produce them (another repo, offline)
 *   fails closed: affected.
 */
import { execFileSync } from 'node:child_process';
import { isGraphSourceFile, relativeSpecifierBases, resolvedImportsOf, specifierBasesResolvingTo } from './related-test-selection.mjs';
import { hitsGlobEdge, isLocalFullSuiteTrigger, isTestFile } from '../readiness/test-selection.mjs';
import { readDeclaredSettings } from './settings-files.mjs';
import { isUnderTest } from './under-test.mjs';

/** `any-code`: today's middle ground — any main code change re-tests. `affected`: only a change that can reach the PR. */
export const RETEST_MODES = Object.freeze(['any-code', 'affected']);
export const DEFAULT_RETEST_MODE = 'affected';
/** More changed files than this on either side ⇒ do not walk them; re-test (bounded IO, fail closed). */
export const MAX_GRAPH_FILES = 400;
/** A forward import closure that visits more files than this is not walked to the end; re-test (bounded IO, fail closed). */
export const MAX_CLOSURE_FILES = 1500;
/** Wall-clock budget for one PR's graph reads (one `git show` spawn per file, ~20 ms each); past it, re-test. */
export const MAX_GRAPH_MS = 25_000;
/** More graph source files than this at the main tip ⇒ the reverse graph is not built; re-test (bounded IO, fail closed). The repo has ~3000 today. */
export const MAX_REVERSE_FILES = 8000;
/** Total reverse-walk steps spent deciding whether unchanged files are entry points, per PR; past it, treat the file as an entry (re-test, fail closed). */
export const ENTRY_WORK_BUDGET = 200_000;

/** The gate itself: a change here always re-tests (operator constraint). Repo-relative path patterns. */
export const GATE_PATTERNS = Object.freeze([
  /^scripts\/merge-ai-prs\.mjs$/,
  /^scripts\/lib\/merge-(queue|freshness)[\w-]*\.mjs$/,
  /^scripts\/lib\/related-test-selection\.mjs$/,
  /^scripts\/readiness\/test-selection\.mjs$/,
  /^scripts\/ci\//,
  /^\.github\//,
  /^\.githooks\//,
]);

/**
 * DECLARED SETTINGS (`scripts/settings/*.json`) — live 2026-10-10 18:23 ET: the drain merged #4763 (it added the review
 * seats' settings file) and every other ready PR (#4805, #4811, #4813, #4821, #4822, #4827, #4828, #4829) got
 * `refresh (… affected:gate-touched:<that file>)`: a forced rebase + full CI each, a 690 s pass for one
 * merge. The whole folder was the gate, and every policy is a settings file, so nearly every merge re-tested everything.
 *   - Only the settings the merge gate and test selection read stay the gate ({@link DEFAULT_SETTINGS_GATE_FILES}).
 *   - Any other changed settings file is replaced by its READERS: the source files under {@link SETTINGS_READER_DIRS}
 *     that name the file, or a top-level key whose value changed (settings merge into one object, so a reader names the
 *     key, not the file). Those readers then count as the changed files in the import-graph rules below.
 *   - Fail closed: a file that cannot be read or parsed, a changed key with no reader, a reader that is not a source
 *     file (a shell script), or too many readers re-tests. A reader that is itself the gate re-tests (`gate-touched`).
 * Both lists are settings (cascade: built-in → `mergeFreshness.settingsGateFiles` / `.settingsReaderMode` in the
 * declared settings → env), resolved once per process and logged with their source ({@link resolveSettingsPolicy}).
 */
export const SETTINGS_FILE_RE = /^scripts\/settings\/[^/]+$/;
/** Settings the gate reads: a glob over the file name (`*` = any run of characters). merge-ai-prs.mjs reads the red-main hold.
 *  A gate file that names any other settings file or its key is found by the reader search and re-tests too. */
export const DEFAULT_SETTINGS_GATE_FILES = Object.freeze(['merge-queue*.json', 'merge-freshness*.json', 'red-main-hold*.json', 'test-selection*.json']);
/** `resolve`: a non-gate settings file is replaced by its readers. `gate-all`: every settings file is the gate (the old rule). */
export const SETTINGS_READER_MODES = Object.freeze(['resolve', 'gate-all']);
export const DEFAULT_SETTINGS_READER_MODE = 'resolve';
export const SETTINGS_GATE_FILES_ENV = 'WE_MERGE_QUEUE_SETTINGS_GATE_FILES';
export const SETTINGS_READER_MODE_ENV = 'WE_MERGE_QUEUE_SETTINGS_READER_MODE';
/** Where a reader of a settings file can live (searched at both the PR head and the main tip). */
export const SETTINGS_READER_DIRS = Object.freeze(['scripts', 'skills-src', '.github', '.githooks']);
/** The built-in policy: what a pure caller and a test run get unless they pass one. */
export const DEFAULT_SETTINGS_POLICY = Object.freeze({ mode: DEFAULT_SETTINGS_READER_MODE, gateFiles: DEFAULT_SETTINGS_GATE_FILES });

const globRe = (glob) => new RegExp(`^${String(glob).split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);

/** PURE. Is this changed settings file part of the gate under `policy`? (Anything but a top-level `.json` always is.) */
export function isGateSettingsFile(path, policy = DEFAULT_SETTINGS_POLICY) {
  const p = String(path ?? '');
  if (!SETTINGS_FILE_RE.test(p)) return false;
  const name = p.slice('scripts/settings/'.length);
  if (policy?.mode !== 'resolve' || !name.endsWith('.json')) return true;
  return (policy.gateFiles ?? DEFAULT_SETTINGS_GATE_FILES).some((g) => globRe(g).test(name));
}

/** PURE. A changed settings file this rule replaces by its readers (not the gate under `policy`). */
export function isResolvableSettingsFile(path, policy = DEFAULT_SETTINGS_POLICY) {
  return SETTINGS_FILE_RE.test(String(path ?? '')) && !isGateSettingsFile(path, policy);
}

/**
 * The settings policy through the cascade: built-in → declared settings (`mergeFreshness.settingsReaderMode`,
 * `mergeFreshness.settingsGateFiles`) → env. Inside a test run the live files are not read. Never throws; an invalid
 * value keeps the layer below it and is named in `errors`. Each field carries its `source`.
 */
export function resolveSettingsPolicy({ env = process.env, declared } = {}) {
  const errors = [];
  let mode = DEFAULT_SETTINGS_READER_MODE; let modeSource = 'built-in';
  let gateFiles = [...DEFAULT_SETTINGS_GATE_FILES]; let gateFilesSource = 'built-in';
  let read = declared;
  if (read === undefined && !isUnderTest(env)) {
    try { read = readDeclaredSettings(); } catch (e) { errors.push(`settings: ${String(e?.message ?? e).split('\n')[0]}`); }
  }
  const fresh = read?.settings?.mergeFreshness;
  const owner = (leaf) => read?.owners?.[`mergeFreshness.${leaf}`] ?? 'settings';
  if (fresh && fresh.settingsReaderMode !== undefined) {
    if (SETTINGS_READER_MODES.includes(fresh.settingsReaderMode)) { mode = fresh.settingsReaderMode; modeSource = owner('settingsReaderMode'); }
    else errors.push(`mergeFreshness.settingsReaderMode: ${JSON.stringify(fresh.settingsReaderMode)} is not one of ${SETTINGS_READER_MODES.join('|')}`);
  }
  if (fresh && fresh.settingsGateFiles !== undefined) {
    const v = fresh.settingsGateFiles;
    if (Array.isArray(v) && v.every((g) => typeof g === 'string' && g)) { gateFiles = [...v]; gateFilesSource = owner('settingsGateFiles'); }
    else errors.push('mergeFreshness.settingsGateFiles: not a list of file-name globs');
  }
  const envMode = String(env?.[SETTINGS_READER_MODE_ENV] ?? '').trim();
  if (envMode) {
    if (SETTINGS_READER_MODES.includes(envMode)) { mode = envMode; modeSource = `env ${SETTINGS_READER_MODE_ENV}`; }
    else errors.push(`${SETTINGS_READER_MODE_ENV}: ${JSON.stringify(envMode)} is not one of ${SETTINGS_READER_MODES.join('|')}`);
  }
  const envGate = String(env?.[SETTINGS_GATE_FILES_ENV] ?? '').trim();
  if (envGate) { gateFiles = envGate.split(',').map((s) => s.trim()).filter(Boolean); gateFilesSource = `env ${SETTINGS_GATE_FILES_ENV}`; }
  return { mode, modeSource, gateFiles, gateFilesSource, errors };
}

const LOGGED_POLICIES = new Set();
/** Log the policy once per process per distinct value (stderr, so it reaches the daemon log under --json). */
function logPolicyOnce(policy, log = (line) => process.stderr.write(`${line}\n`)) {
  const line = `merge-queue · affected-settings: ${JSON.stringify(policy)}`;
  if (LOGGED_POLICIES.has(line)) return;
  LOGGED_POLICIES.add(line);
  try { log(line); } catch { /* logging is best-effort */ }
}

/** Root-level vitest entry files (`vitest.config.ts`, `vitest.setup.ts`, `vitest.globalSetup.mjs`, `vitest.<suite>.config.ts`, …): loaded for every test file, imported by none. */
const TEST_INFRA_ENTRY_RE = /^vitest\.[\w.-]+\.(?:ts|mts|js|mjs|cjs)$/;

/** PURE. Is this path part of the merge gate or the test infrastructure? A settings file is, per `policy` ({@link isGateSettingsFile}). */
export function isGateFile(path, policy = DEFAULT_SETTINGS_POLICY) {
  const p = String(path ?? '');
  if (!p) return true;
  if (SETTINGS_FILE_RE.test(p)) return isGateSettingsFile(p, policy);
  return GATE_PATTERNS.some((re) => re.test(p)) || isLocalFullSuiteTrigger(p);
}

/** Prose a merge never executes or loads as data: the only kind of file a `nonCodePaths` entry exempts. */
const PROSE_RE = /\.(?:md|markdown|txt)$/i; // not `.mdx`: it compiles to JSX and can import modules

/** The verdict reason of the no-IO shortcut: main gained only prose. No import graph was read to reach it. */
export const NO_CODE_REASON = 'main-gained-no-code';

/**
 * PURE. Does this verdict excuse the pass's AGE? Only an `unaffected` verdict that walked the import graph does: the
 * no-code shortcut read nothing, so it proves nothing about a PR file reading changed prose (`fs`, a `?raw` import).
 * That move is then judged exactly as `any-code` judges it: a disjoint non-code move, excused inside the age window.
 */
export function excusesPassAge(verdict) {
  return verdict?.affected === false && verdict.reasons?.[0] !== NO_CODE_REASON;
}

/**
 * PURE. Is this changed path non-code: under a `nonCodePaths` entry (`dir/` = a prefix, else an exact path) AND prose?
 * A source or data file under docs/ or backlog/ is code like any other: a PR file can import it, a test can read it.
 * The ONE predicate for both this rule and the hook's `mainGainedCode` (we:scripts/lib/merge-queue-hook.mjs).
 */
export function isNonCodeFile(file, patterns) {
  const f = String(file ?? '');
  return !!f && PROSE_RE.test(f) && patterns.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p));
}
const isNonCode = isNonCodeFile;

/**
 * PURE. Can main's delta affect the PR?
 * @param {object} a
 * @param {string[]} a.prFiles     files the PR changes (incl. a rename's old path)
 * @param {string[]} a.mainFiles   files main changed since the PR's base
 * @param {string[]} [a.nonCodePaths]
 * @param {(side: 'pr'|'main', file: string) => string[]|null} a.importsOf  resolved imports of a changed file on its
 *   side (`[]` = deleted there / imports nothing; `null` = could not read → fail closed)
 * @returns {{affected: boolean, reasons: string[], mainCodeFiles: number}}
 */
export function decideAffected({ prFiles = [], mainFiles = [], nonCodePaths = ['backlog/', 'docs/'], importsOf, importersOf, settingsReadersOf, settingsPolicy = DEFAULT_SETTINGS_POLICY }) {
  const prRaw = [...new Set(prFiles.filter(Boolean))];
  const mainAll0 = [...new Set(mainFiles.filter(Boolean))];
  const mainCode0 = mainAll0.filter((f) => !isNonCode(f, nonCodePaths));
  const notes = [];
  const done = (affected, reasons) => ({ affected, reasons: [...reasons, ...notes], mainCodeFiles: mainCode0.length });
  // The gate rule answers first, on BOTH sides and on EVERY changed file (a configured non-code entry never hides one):
  // a PR that edits the gate must not be excused (its pass's age included) by a main move that gained no code. Only
  // then may "main gained nothing that can matter" end the question — and only prose counts as nothing (isNonCodeFile).
  const gate = [...mainAll0, ...prRaw].find((f) => isGateFile(f, settingsPolicy));
  if (gate) return done(true, [`gate-touched:${gate}`]);
  if (!mainCode0.length) return done(false, [NO_CODE_REASON]); // read nothing: never excuses age (excusesPassAge)
  // A changed non-gate settings file is replaced by its readers (see SETTINGS_FILE_RE): from here on, those readers
  // are the changed files on that side. Unresolvable → re-test; a reader that is the gate → re-test.
  const isSettings = (f) => isResolvableSettingsFile(f, settingsPolicy);
  const keysBySide = { pr: new Set(), main: new Set() };
  const readersBySide = { pr: [], main: [] };
  for (const [side, files] of [['main', mainCode0], ['pr', prRaw]]) {
    for (const f of files.filter(isSettings)) {
      const r = typeof settingsReadersOf === 'function' ? settingsReadersOf(side, f) : null;
      if (!r || !Array.isArray(r.readers)) return done(true, [`settings-readers-unresolved:${f}${r?.why ? ` (${r.why})` : ''}`]);
      if (r.gateReader) return done(true, [`gate-touched:${f} (read by ${r.gateReader})`]);
      readersBySide[side].push(...r.readers);
      for (const k of r.keys ?? []) keysBySide[side].add(k);
      notes.push(`settings-readers:${side}:${f}=${r.readers.length}`);
    }
  }
  // Two sides that each change the same top-level settings key (in any settings files) collide in the merged settings
  // object (a duplicate owner fails the settings layout test): re-test.
  const sharedKey = [...keysBySide.main].find((k) => keysBySide.pr.has(k));
  if (sharedKey) return done(true, [`settings-key-both-sides:${sharedKey}`]);
  const pr = [...new Set([...prRaw.filter((f) => !isSettings(f)), ...readersBySide.pr])];
  const prSet = new Set(pr);
  const mainAll = [...new Set([...mainAll0.filter((f) => !isSettings(f)), ...readersBySide.main])];
  const mainCode = mainAll.filter((f) => !isNonCode(f, nonCodePaths));
  if (!mainCode.length) return done(false, ['main-delta-unaffected']); // main's only code was settings that no one reads
  const glob = [...mainCode, ...pr.filter((f) => !isNonCode(f, nonCodePaths))].find(hitsGlobEdge);
  if (glob) return done(true, [`glob-edge:${glob}`]);
  const same = mainCode.find((f) => prSet.has(f));
  if (same) return done(true, [`same-file:${same}`]);
  if (mainCode.length > MAX_GRAPH_FILES || pr.length > MAX_GRAPH_FILES) return done(true, ['too-many-files']);
  // Targets include main's prose files too (a `?raw` import of a card): a PR file that imports one is coupled to it.
  const mainSet = new Set(mainAll);
  // Forward closure: from every changed file on `side`, follow imports through UNCHANGED modules too (A → B → C is
  // coupling even when neither changed end imports the other). Each file is read once (`seen`), so cycles terminate;
  // a closure past MAX_CLOSURE_FILES or an unreadable import list fails closed.
  const walk = (side, files, other) => {
    const via = new Map(); // file → the file it was reached from (null for a root)
    const queue = [];
    for (const f of files.filter(isGraphSourceFile)) { via.set(f, null); queue.push(f); }
    const chain = (f) => { const path = []; for (let c = f; c != null; c = via.get(c)) path.unshift(c); return path.join('->'); };
    for (let i = 0; i < queue.length; i++) {
      const f = queue[i];
      const imports = importsOf(side, f);
      if (!Array.isArray(imports)) return `imports-unreadable:${side}:${f}`;
      for (const t of imports) {
        if (other.has(t)) return `${side === 'main' ? 'main-file-imports-pr-file' : 'pr-file-imports-main-file'}:${chain(f)}->${t}`;
        if (via.has(t)) continue;
        if (via.size >= MAX_CLOSURE_FILES) return `closure-too-large:${side}`;
        via.set(t, f);
        if (isGraphSourceFile(t)) queue.push(t);
      }
    }
    return null;
  };
  const edge = walk('main', mainCode, prSet) ?? walk('pr', pr, mainSet);
  if (edge) return done(true, [edge]);
  // Shared importer: an UNCHANGED file that CI executes and that reaches a PR file and a file main changed runs both
  // together after the merge, which neither forward walk sees (it starts at a changed file and never meets the other
  // side). What CI executes is a test or spec file, or an entry point (a file nothing imports: check:standards, a
  // build). A middle module importing both is not a meeting point itself; whatever runs it, further up, is.
  if (typeof importersOf !== 'function') return done(true, ['importers-unavailable']);
  // Reverse closure at the main tip. The PR's own new edges need no overlay: every one starts at a PR-changed file,
  // which the forward PR walk above already followed to the end (a PR-ADDED file that an unchanged file already names
  // is the one exception, and `importersOf` supplies those importers).
  const reach = (roots) => {
    const origin = new Map(); // file → the root it was reached from
    const queue = [];
    for (const r of roots) { origin.set(r, r); queue.push(r); }
    for (let i = 0; i < queue.length; i++) {
      const importers = importersOf(queue[i]);
      if (!Array.isArray(importers)) return `importers-unreadable:${queue[i]}`;
      for (const t of importers) if (!origin.has(t)) { origin.set(t, origin.get(queue[i])); queue.push(t); }
    }
    return origin;
  };
  // What this reverse walk sees is import edges only. ACCEPTED BOUND (operator ruling 2026-10-10, card x0e6tik): a test
  // that reads a changed SOURCE file through `fs` as text has no edge here and is not excused or re-tested by this rule;
  // tests still run on main and on the PR per settings, so a miss is caught eventually. A cycle is NOT part of that
  // bound: a closed cycle CI runs is caught below by `isEntryPoint`.
  const fromPr = reach(pr);
  if (typeof fromPr === 'string') return done(true, [fromPr]);
  const fromMain = reach(mainSet);
  if (typeof fromMain === 'string') return done(true, [fromMain]);
  // Test infrastructure vitest loads for EVERY test file (config, setup, global setup) has no importing test, so no
  // edge shows it. A change on either side that those files reach (a helper `vitest.setup.ts` imports) runs under
  // every test of the merged tree: re-test.
  for (const { side, closure } of [{ side: 'pr', closure: fromPr }, { side: 'main', closure: fromMain }]) {
    for (const [file, root] of closure) if (TEST_INFRA_ENTRY_RE.test(file)) return done(true, [`test-infra-reached:${file} (${side}:${root})`]);
  }
  // An entry point is a file nothing OUTSIDE its own import cycle imports: a script CI runs directly (check:standards, a
  // build). "Zero importers" alone misses a cycle (A <-> B, run as A): every member has an importer, so none looked like
  // a root. A file is an entry point iff every ancestor of it (reverse closure) is also reachable from it, i.e. sits in
  // its cycle. Any ancestor outside the cycle means a file further up is the entry, and that one is reached too.
  // The walk ignores importers the PR itself changes: the tip graph shows main's version of such a file, and the PR may
  // drop its import, leaving the imported file a root in the merged tree. The ones that keep it are covered by the entry
  // above them, which is reached too. Total work is bounded (ENTRY_WORK_BUDGET); past it, fail closed.
  let entryWork = 0;
  const upFrom = (root) => {
    const seen = new Set([root]);
    const queue = [root];
    for (let i = 0; i < queue.length; i++) {
      if (++entryWork > ENTRY_WORK_BUDGET || seen.size > MAX_CLOSURE_FILES) return 'bounded';
      const importers = importersOf(queue[i]);
      if (!Array.isArray(importers)) return 'unreadable';
      for (const t of importers) if (!prSet.has(t) && !seen.has(t)) { seen.add(t); queue.push(t); }
    }
    return seen;
  };
  const entryMemo = new Map();
  const isEntryPoint = (file) => {
    if (entryMemo.has(file)) return entryMemo.get(file);
    const answer = (() => {
      const ancestors = upFrom(file);
      if (typeof ancestors === 'string') return true; // unbounded or unreadable: cannot show an outside importer, fail closed
      for (const a of ancestors) {
        if (a === file) continue;
        const back = upFrom(a);
        if (typeof back === 'string') return true;
        if (!back.has(file)) return false; // `file` is not among `a`'s ancestors, so `a` imports it from outside any cycle
      }
      return true; // every ancestor is in a cycle with `file`
    })();
    entryMemo.set(file, answer);
    return answer;
  };
  for (const [file, prRoot] of fromPr) {
    // A meeting point is something CI executes: a test or spec file, or an entry point (see isEntryPoint).
    if (prSet.has(file) || mainSet.has(file)) continue; // the meeting point is an UNCHANGED file (a changed one is rules 3-4)
    if (fromMain.has(file) && (isTestFile(file) || isEntryPoint(file))) return done(true, [`shared-importer:${file} (pr:${prRoot}, main:${fromMain.get(file)})`]);
  }
  // Data read through `fs` rather than imported (a fixtures dir a test scans, a JSON/YAML a script loads): no import edge
  // shows it, and a reader can be on either side (an unchanged test, or one main/the PR adds). A changed non-source file
  // therefore never counts as "no code". Docs and backlog cards stay exempt (nonCodePaths). Checked last so a data file
  // an import does reach keeps its more specific reason above.
  const data = [...mainCode, ...pr.filter((f) => !isNonCode(f, nonCodePaths))].find((f) => !isGraphSourceFile(f));
  if (data) return done(true, [`data-file-changed:${data}`]);
  return done(false, ['main-delta-unaffected']);
}


function gitRunner(root) {
  return (args, opts = {}) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: 60_000, ...opts });
}

/**
 * IO. The reverse-import graph of the whole tree at `tipSha` (`Map<imported file, importing files>`), read with ONE
 * `git cat-file --batch` spawn (a `git show` per file would be ~60 s for ~3000 sources). Returns the graph, or a
 * named failure reason: `reverse-graph-too-large` (more source files than `maxFiles`) / `reverse-graph-unreadable:<why>`
 * (a failed spawn, a missing or non-blob object, a short or malformed answer). Never a partial graph.
 */
function readTipGraph({ git, tipSha, maxFiles, tipFiles }) {
  const sources = tipFiles.filter(isGraphSourceFile);
  if (sources.length > maxFiles) return 'reverse-graph-too-large';
  // `cat-file --batch` reads one object name per line: a path holding a newline would desync every answer after it.
  if (sources.some((f) => /[\r\n]/.test(f))) return 'reverse-graph-unreadable:newline-in-path';
  const known = new Set(tipFiles);
  const reverse = new Map();
  const bases = new Map(); // relative specifier base → the files that name it, resolved or not (see specifierBasesResolvingTo)
  if (!sources.length) return { reverse, bases };
  let buf;
  try {
    buf = Buffer.from(git(['cat-file', '--batch'], { input: Buffer.from(`${sources.map((f) => `${tipSha}:${f}`).join('\n')}\n`), encoding: 'buffer', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 512 * 1024 * 1024, timeout: 45_000 }));
  } catch (e) {
    return `reverse-graph-unreadable:${e?.code ?? String(e?.message ?? e).split('\n')[0].slice(0, 80)}`;
  }
  let pos = 0;
  for (const file of sources) {
    const nl = buf.indexOf(0x0a, pos);
    const header = nl < 0 ? '' : buf.toString('latin1', pos, nl);
    const m = /^[0-9a-f]{40,64} blob (\d+)$/.exec(header);
    if (!m || nl + 1 + Number(m[1]) > buf.length) return `reverse-graph-unreadable:${header.slice(-60) || 'short-answer'}`;
    const end = nl + 1 + Number(m[1]);
    const text = buf.toString('utf8', nl + 1, end);
    for (const target of resolvedImportsOf(file, text, known)) {
      if (!reverse.has(target)) reverse.set(target, []);
      reverse.get(target).push(file);
    }
    for (const base of relativeSpecifierBases(file, text)) {
      if (!bases.has(base)) bases.set(base, []);
      bases.get(base).push(file);
    }
    pos = end + 1; // the answer's own newline after the content
  }
  return { reverse, bases };
}

/** More readers than this for one settings file ⇒ do not walk them; re-test (bounded IO, fail closed). */
export const MAX_SETTINGS_READERS = 200;
const DATA_HIT_RE = /\.(?:json|jsonl|snap|md|markdown|txt|csv|svg|html?|css|lock)$/i; // cannot read a setting: text or data
const YAML_RE = /\.ya?ml$/i;
const escapeEre = (s) => String(s).replace(/[.+?^${}()|[\]\\*]/g, '\\$&');

/**
 * IO. The readers of one changed settings file, across the trees at `shas` (the main tip and the PR head: together
 * they hold both the old and the new version of a file only one side changed). Returns
 * `{readers, keys, gateReader}` or `{why}` when it cannot be resolved (→ the rule re-tests).
 *   - keys: the top-level keys whose value differs between the versions (a `$comment…` key is documentation, not a setting);
 *   - readers: the SOURCE files under SETTINGS_READER_DIRS naming the file (its base name) or a changed key as a whole
 *     word (`git grep -w`-like, deliberately wide: a destructured `{ key }` still counts), other settings files excluded;
 *   - gateReader: the first hit that is the gate itself (a gate YAML counts).
 */
export function readSettingsReaders({ git, file, shas, policy = DEFAULT_SETTINGS_POLICY }) {
  const versions = [];
  for (const sha of [...new Set(shas)]) {
    let text;
    try { text = String(git(['show', `${sha}:${file}`])); } catch (e) {
      if (PATH_ABSENT_RE.test(`${e?.message ?? ''}\n${e?.stderr ?? ''}`)) { versions.push({}); continue; }
      return { why: `unreadable at ${String(sha).slice(0, 9)}` };
    }
    let data;
    try { data = JSON.parse(text); } catch { return { why: `not JSON at ${String(sha).slice(0, 9)}` }; }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return { why: 'not a JSON object' };
    versions.push(data);
  }
  const all = [...new Set(versions.flatMap((v) => Object.keys(v)))].filter((k) => !k.startsWith('$comment'));
  const keys = all.filter((k) => new Set(versions.map((v) => JSON.stringify(v[k]))).size > 1);
  const name = file.slice(file.lastIndexOf('/') + 1);
  const patterns = [`(^|[^A-Za-z0-9_.-])${escapeEre(name)}`, ...keys.map((k) => `(^|[^A-Za-z0-9_$])${escapeEre(k)}([^A-Za-z0-9_$]|$)`)];
  const hits = new Set();
  for (const sha of [...new Set(shas)]) {
    let outText;
    try {
      outText = String(git(['grep', '-l', '-z', '-I', '-E', ...patterns.flatMap((p) => ['-e', p]), sha, '--', ...SETTINGS_READER_DIRS]));
    } catch (e) {
      if (e?.status === 1 && !String(e?.stderr ?? '').trim()) continue; // git grep: exit 1 + no stderr = no match
      return { why: `grep failed at ${String(sha).slice(0, 9)}` };
    }
    for (const entry of outText.split('\0').filter(Boolean)) hits.add(entry.startsWith(`${sha}:`) ? entry.slice(sha.length + 1) : entry);
  }
  const readers = [];
  let gateReader = null;
  for (const h of [...hits].sort()) {
    if (SETTINGS_FILE_RE.test(h)) continue; // another settings file holding the same key: the both-sides key rule covers it
    if (isGateFile(h, policy) && (isGraphSourceFile(h) || YAML_RE.test(h) || !DATA_HIT_RE.test(h))) { gateReader ??= h; continue; }
    if (DATA_HIT_RE.test(h) || YAML_RE.test(h)) continue;
    if (!isGraphSourceFile(h)) return { why: `non-source reader ${h}` };
    readers.push(h);
  }
  if (gateReader) return { readers, keys, gateReader };
  if (keys.length && !readers.length) return { why: `no reader of ${keys.join(',')}` };
  if (readers.length > MAX_SETTINGS_READERS) return { why: `too many readers (${readers.length})` };
  return { readers, keys, gateReader: null };
}

/** Tip graphs shared by the PRs of one drain pass, keyed by `<checkout>\0<tip sha>`: a sha names one immutable tree, so an entry can never go stale. */
const SHARED_TIP_GRAPHS = new Map();

/** git's wording when a path is not in the commit: `path 'x' does not exist in '<sha>'` / `exists on disk, but not in '<sha>'`. */
const PATH_ABSENT_RE = /does not exist in |exists on disk, but not in /;

const hasCommit = (git, sha) => { try { git(['cat-file', '-e', `${sha}^{commit}`]); return true; } catch { return false; } };

/**
 * IO. The `affected` verdict for one PR, from the drain's clone at `root`. Never throws: any failure is affected
 * (re-test), with the reason.
 * @param {{root?: string, num?: number, headSha: string, tipSha: string, prFiles: string[], mainFiles: string[],
 *   nonCodePaths?: string[], git?: Function, budgetMs?: number}} a
 * @returns {{affected: boolean, reasons: string[], mainCodeFiles: number, ms: number}}
 */
export function readAffectedFacts({ root = process.cwd(), num = null, headSha, tipSha, prFiles, mainFiles, nonCodePaths, git: injectedGit, budgetMs = MAX_GRAPH_MS, maxReverseFiles = MAX_REVERSE_FILES, tipGraphCache, settingsPolicy, log }) {
  const git = injectedGit ?? gitRunner(root);
  // The real runner shares tip graphs across PRs of one drain pass; an injected git (a test's fake tree) never does.
  const cache = tipGraphCache ?? (injectedGit ? new Map() : SHARED_TIP_GRAPHS);
  const t0 = Date.now();
  const out = (r) => ({ ...r, ms: Date.now() - t0 });
  let policy = settingsPolicy;
  if (!policy) {
    const p = resolveSettingsPolicy();
    logPolicyOnce(p, log);
    policy = p;
  }
  // Cheap first: no IO when the pure rule already answers without the graph. Settings readers are not read yet: an
  // empty answer can only make the pre-check LESS affected, and its unaffected answer is discarded below.
  const pre0 = decideAffected({ prFiles, mainFiles, nonCodePaths, importsOf: () => [], importersOf: () => [], settingsReadersOf: () => ({ readers: [], keys: [] }), settingsPolicy: policy });
  const pre = { ...pre0, reasons: pre0.reasons.filter((r) => !r.startsWith('settings-readers:')) }; // the stub's reader counts are not facts
  if (pre.affected || pre.reasons[0] === NO_CODE_REASON) return out(pre);
  if (!headSha || !tipSha) return out({ ...pre, affected: true, reasons: ['shas-unknown'] });
  try {
    const missing = [headSha, tipSha].filter((s) => !hasCommit(git, s));
    if (missing.length) {
      try { git(['fetch', '--quiet', '--no-tags', 'origin', ...missing]); } catch { /* try the PR ref below */ }
      if (num && !hasCommit(git, headSha)) { try { git(['fetch', '--quiet', '--no-tags', 'origin', `refs/pull/${Number(num)}/head`]); } catch { /* checked below */ } }
      const still = [headSha, tipSha].filter((s) => !hasCommit(git, s));
      if (still.length) return out({ ...pre, affected: true, reasons: [`commits-unavailable:${still.map((s) => s.slice(0, 9)).join(',')}`] });
    }
    // `-z`: without it git quotes a path with a non-ASCII character (`"caf\303\251.test.mjs"`) and the test is invisible.
    const tipTree = new Set(String(git(['ls-tree', '-r', '-z', '--name-only', tipSha])).split('\0').filter(Boolean));
    const fileSet = new Set(tipTree);
    for (const f of [...prFiles, ...mainFiles]) if (f) fileSet.add(f);
    const memo = new Map(); // a closure walk reads a shared module once per side, not once per path that reaches it
    const importsOf = (side, file) => {
      const k = `${side}:${file}`;
      if (!memo.has(k)) memo.set(k, readImports(side, file));
      return memo.get(k);
    };
    const deadline = Date.now() + budgetMs;
    const readImports = (side, file) => {
      if (Date.now() > deadline) throw new Error('graph-budget-exceeded'); // caught below → affected (a closure walk spawns one git per file)
      const sha = side === 'pr' ? headSha : tipSha;
      let text;
      try { text = git(['show', `${sha}:${file}`]); } catch (e) {
        // Only git's own "no such path in that commit" answer means deleted / renamed away. Any other failure
        // (timeout, EAGAIN, corrupt object) is an unreadable list → null → fail closed, never "imports nothing".
        return PATH_ABSENT_RE.test(`${e?.message ?? ''}\n${e?.stderr ?? ''}`) ? [] : null;
      }
      return resolvedImportsOf(file, text, fileSet);
    };
    // The importers of a file at the main tip: the whole tip tree is read once, and only when the forward walks left
    // the question open. A graph that cannot be read in full is `null` here and named in the verdict below.
    let graphFailure = null;
    // A file the PR ADDS has no importer at the tip, but an unchanged file may already name it by a specifier that
    // resolved to nothing (a guarded dynamic import) or to a lower-priority file (`./x` → x.js, and the PR adds x.mjs).
    // Those files become its importers. (Every other new edge starts at a PR-changed file, which rule 4 already walks.)
    const prAdded = new Set(prFiles.filter((f) => f && !tipTree.has(f)));
    const importersOf = (file) => {
      const key = `${root}\0${tipSha}`;
      let graph = cache.get(key);
      if (graph === undefined) {
        // A build that failed is remembered for this tip too: every PR of the pass would otherwise re-spawn it (up to its timeout).
        if (Date.now() > deadline) { graphFailure = 'graph-budget-exceeded'; return null; } // this PR's budget, not a fact about the tip: not cached
        graph = readTipGraph({ git, tipSha, maxFiles: maxReverseFiles, tipFiles: [...tipTree] });
        for (const k of [...cache.keys()].slice(0, Math.max(0, cache.size - 1))) cache.delete(k); // this pass's tip and one before it
        cache.set(key, graph);
      }
      if (typeof graph === 'string') { graphFailure = graph; return null; }
      const real = graph.reverse.get(file) ?? [];
      if (!prAdded.has(file)) return real;
      return [...new Set([...real, ...specifierBasesResolvingTo(file).flatMap((b) => graph.bases.get(b) ?? [])])].filter((f) => f !== file);
    };
    const settingsMemo = new Map(); // one resolution per settings file: it reads both trees, whichever side changed it
    const settingsReadersOf = (_side, file) => {
      if (!settingsMemo.has(file)) settingsMemo.set(file, readSettingsReaders({ git, file, shas: [tipSha, headSha], policy }));
      return settingsMemo.get(file);
    };
    const verdict = decideAffected({ prFiles, mainFiles, nonCodePaths, importsOf, importersOf, settingsReadersOf, settingsPolicy: policy });
    return out(graphFailure ? { ...verdict, affected: true, reasons: [graphFailure] } : verdict);
  } catch (e) {
    return out({ ...pre, affected: true, reasons: [`graph-read-failed:${String(e?.message ?? e).split('\n')[0].slice(0, 120)}`] });
  }
}
