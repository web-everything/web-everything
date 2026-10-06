/**
 * @file scripts/lib/repo-scan-tests.mjs
 * @description The REPO-SCANNING TEST manifest and its verify-time selection (#3887).
 *
 * WHY. `verify`'s default gate selects tests with `vitest related <changed files>`, i.e. tests that IMPORT a changed
 * file. A repo-scanning test (one that reads source files from disk to enforce a rule, e.g. "no hard-coded repo
 * slug") imports nothing, so it is never selected: a new file with a literal passed local verify and failed CI on
 * `multi-repo-checks.test.mjs` (PR #3887).
 *
 * THE FIX, WITHIN THE OPERATOR'S COST CONSTRAINT (no full suite — only the cost of checking the changed files).
 * Every scanning test is listed in {@link REPO_SCAN_TESTS} (the "mark"; a guard test fails when a new scanner is not
 * listed). When an added/changed/deleted file falls inside a scanner's reach, verify runs THAT scanner:
 *   - `scope: 'files'` — the test honours {@link SCAN_FILES_ENV} (a JSON array of changed repo-relative paths) and
 *     scans only those files, so the cost is the number of changed files, not the whole repo.
 *   - `scope: 'full'`  — the test genuinely cannot be scoped (it derives a whole-repo fact); it runs its full scan,
 *     but ONLY when a file inside its reach changed. Listed so the cost is visible and reviewable.
 * A scanner whose own inputs (its lib, data file, or the test itself) changed always runs FULL: the rule changed,
 * so every file must be re-judged.
 *
 * Pure: no fs, no child_process. `scopedScanFiles` reads only the env it is handed.
 */

/** Env var carrying the changed-file list (JSON array of repo-relative paths) a `scope: 'files'` scanner honours. */
export const SCAN_FILES_ENV = 'VERIFY_SCAN_FILES';

/**
 * Env var naming the directory a `scope: 'files'` scanner reads its sources from, instead of the live checkout. A test
 * that needs to prove the scanner catches a violating file points it at a throwaway tree, so the violation never
 * exists in the real tree where a concurrently running scanner (another vitest worker) could read it.
 */
export const SCAN_ROOT_ENV = 'VERIFY_SCAN_ROOT';

const SOURCE_EXT =/\.(mjs|cjs|js|ts|mts|cts)$/;
const inTree = (file, roots) => roots.some((r) => file.startsWith(`${r}/`));
const skipped = (file) => /(?:^|\/)(?:__tests__|__fixtures__|node_modules)(?:\/|$)/.test(file);

/**
 * @typedef {{test: string, scope: 'files'|'full', why: string, matches: (file: string) => boolean, inputs: string[]}} RepoScanTest
 * `matches` = does this changed path fall in the scanner's reach (a changed file the scanner would read).
 * `inputs`   = paths that define the scanner's RULE; a change to one runs the scanner full.
 */

/** @type {readonly RepoScanTest[]} */
export const REPO_SCAN_TESTS = Object.freeze([
  {
    test: 'scripts/lib/__tests__/exec-output-guard.test.mjs',
    scope: 'files',
    why: 'captured gh/git reads cannot exceed the per-file unbounded-output baseline',
    matches: (f) => /\.(mjs|js)$/.test(f) && !skipped(f) && !/\.test\./.test(f)
      && inTree(f, ['scripts', 'skills-src'])
      && !/^scripts\/lib\/(?:proc-read|exec-output-guard)\.mjs$/.test(f),
    inputs: ['scripts/lib/exec-output-guard.mjs', 'scripts/exec-output-baseline.json', 'scripts/lib/__tests__/exec-output-guard.test.mjs'],
  },
  {
    test: 'scripts/__tests__/multi-repo-checks.test.mjs',
    scope: 'files',
    why: 'every scanned source names its repo explicitly (gh --repo / no repo literal) — the #3887 case',
    matches: (f) => /\.(mjs|js|ts)$/.test(f) && !skipped(f) && !/\.test\./.test(f)
      && inTree(f, ['scripts/conveyor', 'scripts/operations', 'skills-src/conveyor', 'scripts/lib']),
    inputs: ['scripts/lib/multi-repo-scan.mjs', 'scripts/lib/we-only-checks.json', 'scripts/__tests__/multi-repo-checks.test.mjs'],
  },
  {
    test: 'scripts/lib/__tests__/no-search-backed-pr-list.test.mjs',
    scope: 'files',
    why: 'no pr/issue list call uses a search-backed label, search or author flag',
    matches: (f) => /\.(mjs|js)$/.test(f) && !skipped(f) && inTree(f, ['scripts', 'skills-src']),
    inputs: ['scripts/lib/no-search-backed-pr-list.mjs', 'scripts/lib/__tests__/no-search-backed-pr-list.test.mjs'],
  },
  {
    test: 'scripts/lib/__tests__/review-policy.conformance.test.mjs',
    scope: 'full',
    why: 'sweeps every source tree for vocabulary injection and DERIVES which files import review-core (a whole-repo fact: filesWalked / importers); not expressible per file',
    matches: (f) => SOURCE_EXT.test(f) && !skipped(f) && !f.startsWith('.'),
    inputs: ['scripts/lib/__tests__/review-policy.conformance.test.mjs'],
  },
]);

/**
 * Repo-scanning tests that exist but are DELIBERATELY not run by the verify scanner step, each with the reason.
 * The guard test requires every detected scanner to be in {@link REPO_SCAN_TESTS} or here — so adding a scanner
 * forces a decision, and this list is the standing record of what verify still leaves to CI.
 * @type {Readonly<Record<string, string>>}
 */
export const DEFERRED_SCAN_TESTS = Object.freeze({
  'scripts/__tests__/stdout-flush.test.mjs': 'its one-home drain-loop guard lives in a test the default vitest config excludes (runs under vitest.integration.config.ts with real child processes), so `vitest run <file>` cannot select it; CI runs it',
  'scripts/__tests__/check-standards.test.mjs': 'asserts over the real tracked tree via check-standards itself; the verify gate already runs `check:standards --local --files=<changed>`',
  'scripts/__tests__/check-standards-rules-backlog-integrity.test.mjs': 'walks backlog/ cards; a backlog/ change already runs check:standards UNSCOPED in the same gate',
  'scripts/__tests__/check-standards-rules-conformance-gates.test.mjs': 'classifies every tracked src/** path; the same rule runs in check:standards',
  'scripts/__tests__/check-backlog-item.test.mjs': 'reads one backlog dir to assert an id is absent; not a rule scan',
  'scripts/design-refs/__tests__/taxonomy.test.mjs': 'validates design-refs sidecar data under its own tree, selected by its own inputs',
  'scripts/lib/__tests__/decision-docket-real-cards.test.mjs': 'parses real backlog cards; a backlog/ change already runs check:standards UNSCOPED',
  'scripts/review-corpus/__tests__/gates.test.mjs': 'reads one named backlog card as a fixture; not a rule scan',
  'scripts/conveyor/__tests__/fix-procedure.test.mjs': 'walks skills-src markdown for `--repo` on fix-* commands; markdown-only reach, large file, follow-up',
  'scripts/lib/__tests__/daemon-rebuild.test.mjs': 'walks a throwaway git dir it created, not the repo',
  'scripts/operations/__tests__/run.test.mjs': 'lists a throwaway run directory, not the repo',
  'scripts/operations/__tests__/review-loop-cli.test.mjs': 'lists a throwaway temp root, not the repo',
  'scripts/__tests__/review-set-label.approval-prevention-filing.test.mjs': 'lists a throwaway temp root, not the repo',
});

/** The marker every manifest test must carry in its own header so a reader of the test sees it is a verify scanner. */
export const SCAN_TEST_TAG = '@repo-scanning-test';

/**
 * Which scanners must run for this diff, and how. Pure.
 * @param {{changedFiles: string[]|null|undefined, fileExists?: (repoRelativePath: string) => boolean}} args
 *   repo-relative added/changed/deleted paths; `fileExists` says whether THIS checkout has the scanner test
 * @returns {{scoped: RepoScanTest[], full: RepoScanTest[], widened: RepoScanTest[], scopedFiles: string[]}}
 *   `scoped` run with {@link SCAN_FILES_ENV}=scopedFiles; `full` are `scope: 'full'` scanners (they ignore the env, so
 *   they share the scoped invocation and its vitest startup); `widened` are scopable scanners whose own rule/data
 *   changed, so they must run with NO scope, in their own invocation.
 */
export function selectScanTests({ changedFiles, fileExists = () => true }) {
  const files = Array.isArray(changedFiles) ? changedFiles : [];
  const scoped = [];
  const full = [];
  const widened = [];
  const scopedFiles = new Set();
  for (const entry of REPO_SCAN_TESTS) {
    // A sibling checkout (plateau-app, frontierui) or a fixture repo does not carry these tests: nothing to run there.
    if (!fileExists(entry.test)) continue;
    const reach = files.filter((f) => entry.matches(f));
    const inputChanged = files.some((f) => entry.inputs.includes(f));
    if (!reach.length && !inputChanged) continue;
    if (entry.scope === 'full') full.push(entry);
    else if (inputChanged) widened.push(entry);
    else { scoped.push(entry); reach.forEach((f) => scopedFiles.add(f)); }
  }
  return { scoped, full, widened, scopedFiles: [...scopedFiles].sort() };
}

/**
 * The scan scope a `scope: 'files'` test reads: `null` = scan everything (env unset), else the changed-file Set.
 * Malformed input throws — a scoped run must never silently widen or narrow to something the gate did not choose.
 * @param {Record<string, string|undefined>} [env]
 * @returns {Set<string>|null}
 */
export function scanScope(env = process.env) {
  const raw = env?.[SCAN_FILES_ENV];
  if (raw === undefined || raw === '') return null;
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((p) => typeof p !== 'string')) throw new Error(`${SCAN_FILES_ENV} must be a JSON array of paths`);
  return new Set(parsed);
}

/** The directory a scanner reads sources from: {@link SCAN_ROOT_ENV} when set, else `defaultRoot` (the live checkout). */
export function scanRoot(defaultRoot, env = process.env) {
  const raw = env?.[SCAN_ROOT_ENV];
  return raw === undefined || raw === '' ? defaultRoot : raw;
}

/** Narrow `files` (repo-relative) to the scan scope; unchanged when the scope is `null` (full scan). */
export function scopedScanFiles(files, env = process.env) {
  const scope = scanScope(env);
  return scope ? files.filter((f) => scope.has(f)) : files;
}

/** Shell-quote for embedding in a gate command. */
function shellQuote(str) {
  return `'${String(str).replace(/'/g, `'\\''`)}'`;
}

/**
 * The gate commands (run in order after the related-tests half) for this diff. Empty when no scanner is in reach.
 * @param {{changedFiles: string[]|null|undefined, fileExists?: (repoRelativePath: string) => boolean}} args
 * @returns {string[]}
 */
export function scanCommands({ changedFiles, fileExists }) {
  const { scoped, full, widened, scopedFiles } = selectScanTests({ changedFiles, fileExists });
  const cmds = [];
  const together = [...scoped, ...full];
  if (together.length) {
    cmds.push(`${SCAN_FILES_ENV}=${shellQuote(JSON.stringify(scopedFiles))} npx vitest run ${together.map((e) => shellQuote(e.test)).join(' ')}`);
  }
  if (widened.length) cmds.push(`npx vitest run ${widened.map((e) => shellQuote(e.test)).join(' ')}`);
  return cmds;
}
