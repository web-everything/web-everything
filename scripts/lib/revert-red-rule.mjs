/**
 * @file scripts/lib/revert-red-rule.mjs
 * @description THE REVERT-RED RULE (#5466, ruling P6 of the fixer/review proposal, 2026-10-08) — a fix's new or changed
 *   tests must FAIL when the fix's source changes are taken back out. A test that stays green without the fix does not
 *   discriminate: it is counted as coverage of the repair and cannot catch the defect coming back.
 *
 * WHY. The 2026-10-08 fixer audit found fix-introduced findings were the main reason later review rounds stayed blocked,
 * and two of the named causes were non-discriminating new tests (PRs 4441 and 4481). `gate-missed-catching-test` (10 in
 * the window) is the same shape seen from the gate's side.
 *
 * STANDARD SHAPE (protocol card 5468): pure decision functions over plain facts plus declared settings. No IO, no clock,
 * no git, no file paths of ours, no forge vocabulary. `now`-free: the only time-shaped input (the warn window's start) is
 * a setting the caller reports, never read here. Today's behaviour is the setting's off value (`mode: 'off'`).
 *
 * THREE FUNCTIONS:
 *   - `planRevert(facts)`          which files the fix changed are tests (kept and run) and which are source (reverted);
 *   - `newTestTitles(addedLines)`  the literal titles of tests a diff ADDED, for per-test attribution;
 *   - `revertRedVerdict(facts)`    the verdict: `skipped` | `clean` | `flagged` | `unproven`, and whether it blocks.
 *
 * `unproven` IS NOT `clean`. A run that could not execute, a baseline that was already red, a test file that failed to
 * load with the fix reverted, a restore that did not verify — none of these is evidence the tests discriminate. They are
 * reported as `unproven` and, in `enforce`, block exactly like `flagged` (the card's fail-closed rule). Same discipline as
 * `we:scripts/operations/mutation-check.mjs#assessMutant`, whose transaction this rule judges.
 */

/** The declared modes. `off` is today's behaviour; `warn` records and never blocks; `enforce` blocks. */
export const REVERT_RED_MODES = Object.freeze(['off', 'warn', 'enforce']);

/** The kinds of change a fix can be (from the fix role's own await record). Anything else is not a fix push. */
export const REVERT_RED_FIX_KINDS = Object.freeze(['fix', 'ci-heal']);

/** A test FILE the runner executes. */
const TEST_FILE_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
/** Test SUPPORT (helpers, fixtures) — kept as the fix wrote it, never reverted and never run on its own. */
const TEST_SUPPORT_RE = /(?:^|\/)(?:__tests__|__fixtures__|__snapshots__|fixtures)\/|\.snap$/;
/** Planning artifacts that are never behaviour: cards and agent docs. Kept, never reverted. */
const INERT_RE = /^(?:backlog|docs)\/|\.md$/;

/** Is this path a test file the runner executes? Pure. */
export const isTestFile = (path) => TEST_FILE_RE.test(String(path ?? ''));

/**
 * Decide what the revert touches. PURE.
 * @param {{changes: Array<{status: string, path: string}>, maxFiles?: number}} facts
 *   `status` is the one-letter change kind: `A` added, `M` modified, `D` deleted, `R` renamed (path is the new path).
 * @returns {{tests: string[], revert: string[], keptNew: string[], keptOther: string[], tooLarge: boolean}}
 *   `tests` — added or changed test files (run); `revert` — modified source files (put back to their pre-fix content);
 *   `keptNew` — source files the fix ADDED (a revert would delete them, which turns "the test fails to load" into a fake
 *   red, so they are kept and the count is reported); `keptOther` — deleted/renamed/inert files, reported, untouched.
 */
export function planRevert({ changes = [], maxFiles = 40 } = {}) {
  const tests = [];
  const revert = [];
  const keptNew = [];
  const keptOther = [];
  for (const change of Array.isArray(changes) ? changes : []) {
    const path = String(change?.path ?? '').trim();
    const status = String(change?.status ?? '').charAt(0).toUpperCase();
    if (!path) continue;
    if (isTestFile(path)) { if (status === 'A' || status === 'M' || status === 'R') tests.push(path); else keptOther.push(path); continue; }
    if (TEST_SUPPORT_RE.test(path) || INERT_RE.test(path)) { keptOther.push(path); continue; }
    if (status === 'M') revert.push(path);
    else if (status === 'A') keptNew.push(path);
    else keptOther.push(path);
  }
  const sort = (list) => [...new Set(list)].sort();
  return {
    tests: sort(tests), revert: sort(revert), keptNew: sort(keptNew), keptOther: sort(keptOther),
    tooLarge: tests.length + revert.length > maxFiles,
  };
}

/**
 * The literal titles of `it(...)` / `test(...)` calls on ADDED diff lines. PURE.
 * Only plain string literals count: a template with `${…}` cannot be matched to a runner line, so that test falls back to
 * file-level attribution instead of being guessed at.
 * @param {string[]} addedLines lines added by the fix in ONE test file (without the leading `+`).
 * @returns {string[]}
 */
export function newTestTitles(addedLines = []) {
  const titles = [];
  // Not preceded by `.`, a word character or `$`: `re.test('x')` and `fit(` are not test declarations.
  const re = /(?<![.\w$])(?:it|test)(?:\.(?:only|concurrent|skipIf\([^)]*\)|runIf\([^)]*\)))?\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
  for (const line of Array.isArray(addedLines) ? addedLines : []) {
    for (const m of String(line).matchAll(re)) {
      if (m[1] === '`' && m[2].includes('${')) continue;
      const title = m[2].replace(/\\(.)/g, '$1').trim();
      if (title) titles.push(title);
    }
  }
  return [...new Set(titles)];
}

/**
 * Split a runner failure line (`file > describe > title`, or a bare `file` when the file failed to load). PURE.
 * @param {string} line
 * @returns {{raw: string, file: string, path: string[], loadError: boolean}}
 */
export function parseFailureLine(line) {
  const trimmed = String(line ?? '').trim();
  // vitest marks a file that failed to LOAD as `file [ file ]`; only that exact suffix is stripped, so a test title that
  // itself ends in brackets (`handles arrays [1]`) is kept whole.
  const head = trimmed.split(' > ')[0].replace(/\s+\[.*$/, '');
  const raw = trimmed === `${head} [ ${head} ]` ? head : trimmed;
  const parts = raw.split(' > ').map((s) => s.trim());
  return { raw, file: parts[0] ?? '', path: parts.slice(1), loadError: parts.length < 2 };
}

const sameFile = (a, b) => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);

/**
 * Does the check apply at all? PURE. Returns the skip reason, or `null` when it applies. Asked first, before any git
 * read, so `off` (today) costs nothing.
 * @param {{mode: string, changeKind: string|null, recordMatchesHead: boolean}} facts
 * @returns {string|null}
 */
export function revertRedGate({ mode, changeKind = null, recordMatchesHead = false } = {}) {
  if (!REVERT_RED_MODES.includes(mode) || mode === 'off') return 'mode-off';
  if (!REVERT_RED_FIX_KINDS.includes(changeKind)) return 'not-a-fix-push';
  if (!recordMatchesHead) return 'fix-record-not-for-this-head';
  return null;
}

/**
 * THE VERDICT. PURE: facts and settings in, verdict out.
 *
 * @param {object} facts
 * @param {'off'|'warn'|'enforce'} facts.mode         the declared setting (anything unknown reads as `off`).
 * @param {string|null} facts.changeKind               the fix role's own record kind for this head (`fix`, `ci-heal`, …).
 * @param {boolean} [facts.recordMatchesHead]          that record names exactly the verified head.
 * @param {ReturnType<typeof planRevert>|null} facts.plan
 * @param {Record<string, string[]>} [facts.titles]    new test titles per test file (`newTestTitles`).
 * @param {object|null} facts.probe                    the transaction result (`mutation-check-io#createRevertProbe`).
 * @param {string} [facts.skipReason]                  a reason the caller already knows the check cannot run.
 * @returns {{status: 'skipped'|'clean'|'flagged'|'unproven', mode: string, blocking: boolean, reason: string,
 *   discriminating: Array<{file:string,test:string|null}>, nonDiscriminating: Array<{file:string,test:string|null}>,
 *   unproven: Array<{file:string,test:string|null,why:string}>, reverted: string[], keptNew: string[]}}
 */
export function revertRedVerdict({ mode, changeKind = null, recordMatchesHead = false, plan = null, titles = {}, probe = null, skipReason = '' } = {}) {
  const m = REVERT_RED_MODES.includes(mode) ? mode : 'off';
  const base = { mode: m, discriminating: [], nonDiscriminating: [], unproven: [], reverted: plan?.revert ?? [], keptNew: plan?.keptNew ?? [] };
  const skipped = (reason) => ({ ...base, status: 'skipped', blocking: false, reason });
  // Blocking only ever in enforce; warn records, off never runs.
  const result = (status, reason, lists) => ({ ...base, ...lists, status, reason, blocking: m === 'enforce' && status !== 'clean' });

  const gate = revertRedGate({ mode: m, changeKind, recordMatchesHead });
  if (gate) return skipped(gate);
  if (skipReason) return skipped(skipReason);
  if (!plan) return result('unproven', 'no-plan', {});
  if (plan.tests.length === 0) return skipped('no-test-changed');
  if (plan.revert.length === 0) return skipped('no-source-to-revert');
  if (plan.tooLarge) return skipped('too-large');

  const all = plan.tests.map((file) => ({ file, why: '' }));
  const unrun = (why) => result('unproven', why, { unproven: all.map(({ file }) => ({ file, test: null, why })) });
  if (!probe || typeof probe !== 'object') return unrun('no-probe-result');
  // THE RESTORE FIRST — a tree still holding the revert outranks every other answer.
  if (probe.applied && !probe.restored) return unrun('not-restored');
  if (!probe.baselineRan) return unrun('baseline-unrun');
  if (!probe.baselineGreen) return unrun('baseline-red');
  if (!probe.applied) return unrun('not-applied');
  if (!probe.mutantRan) return unrun('reverted-run-unrun');

  const failures = (Array.isArray(probe.killedBy) ? probe.killedBy : []).map(parseFailureLine);
  const truncated = probe.failuresTruncated === true;
  const discriminating = [];
  const nonDiscriminating = [];
  const unproven = [];
  for (const file of plan.tests) {
    const inFile = failures.filter((f) => sameFile(f.file, file));
    if (inFile.some((f) => f.loadError)) { unproven.push({ file, test: null, why: 'load-error-with-fix-reverted' }); continue; }
    const named = Array.isArray(titles?.[file]) ? titles[file] : [];
    if (named.length === 0) {
      // No parseable new title (changed assertions inside an existing test): the FILE must go red.
      if (inFile.length) discriminating.push({ file, test: null });
      else if (truncated) unproven.push({ file, test: null, why: 'failure-list-truncated' });
      else nonDiscriminating.push({ file, test: null });
      continue;
    }
    for (const test of named) {
      // Matched on the line's END, not its last ` > ` segment: a title may itself contain ` > `.
      if (inFile.some((f) => f.raw.endsWith(` > ${test}`))) discriminating.push({ file, test });
      else if (truncated) unproven.push({ file, test, why: 'failure-list-truncated' });
      else nonDiscriminating.push({ file, test });
    }
  }
  // A PARTIAL revert (some changed sources could not be reverted: binary, symlinked) cannot prove a green test weak —
  // it may guard exactly the file that stayed fixed. Such a test is unproven, never flagged.
  if (Array.isArray(plan.unrevertable) && plan.unrevertable.length) {
    unproven.push(...nonDiscriminating.splice(0).map((t) => ({ ...t, why: 'partial-revert' })));
  }
  // Likewise a source file the fix ADDED stays in place (reverting it would only make the test fail to load): a green
  // test may be testing exactly that new code.
  if (Array.isArray(plan.keptNew) && plan.keptNew.length) {
    unproven.push(...nonDiscriminating.splice(0).map((t) => ({ ...t, why: 'new-source-kept' })));
  }
  const lists = { discriminating, nonDiscriminating, unproven };
  if (nonDiscriminating.length) return result('flagged', 'tests-pass-with-fix-reverted', lists);
  if (unproven.length) return result('unproven', unproven[0].why, lists);
  return result('clean', 'all-new-tests-red-with-fix-reverted', lists);
}

/** One line for a log or an evidence comment. PURE. */
export function formatRevertRed(v) {
  if (!v) return 'revert-red: no result';
  const name = (t) => (t.test ? `${t.file} > ${t.test}` : t.file);
  const head = `revert-red (${v.mode}): ${v.status} — ${v.reason}`;
  if (v.status === 'skipped') return head;
  const parts = [`${v.discriminating.length} discriminate`, `${v.nonDiscriminating.length} do not`, `${v.unproven.length} unproven`];
  const listed = v.nonDiscriminating.length ? `; NOT discriminating: ${v.nonDiscriminating.map(name).join('; ')}` : '';
  return `${head} (${parts.join(', ')})${listed}`;
}
