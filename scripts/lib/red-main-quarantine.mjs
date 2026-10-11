/**
 * @file scripts/lib/red-main-quarantine.mjs
 * @description Red-main containment, mode QUARANTINE (card xx7ckd6; OFF until its red-team review — the default mode
 *   is STOP, see we:scripts/lib/red-main-hold.mjs). PURE: no fs, no git, no network.
 *
 *   While main is red on KNOWN failing test(s), those tests go on a quarantine list and other PRs keep landing:
 *   CI skips only the listed tests (read fresh from the `ops/quarantine` branch at job start), so a PR needs a CI
 *   re-run, never a rebase. Guards:
 *     - only the red-main safety net or the operator may write the list ({@link QUARANTINE_WRITERS}); the list lives
 *       on its own ops ref, so a PR's own tree can never add an entry for itself;
 *     - the main-fix PR always RUNS the quarantined tests ({@link testsToSkip} returns nothing for it);
 *     - every entry expires; entries for a broken commit are removed when main's CI is green ({@link pruneOnGreen});
 *     - a PR whose files overlap the main-fix PR's files or a quarantined test's area is still HELD
 *       ({@link decideQuarantineHold}) — 2026-10-09 #4617 went CONFLICTING because such PRs kept landing;
 *     - no live entry for the current red ⇒ fall back to STOP (fail closed).
 *
 *   List file (`quarantine.json` on `ops/quarantine`):
 *     `{ version:1, entries:[{ test, brokenSha, owner, reason, addedAt, expiresAt, area? }] }`
 *     plus optional `fixPrs:[n,..]` — the main-fix PR numbers CI runs the quarantined tests for (set by a writer only),
 *     and optional `mode:'stop'|'quarantine'` — the red-main mode the safety net resolved when it last wrote
 *     ({@link setMode}). CI reads it from here, as it reads the entries, so CI and the daemon use ONE switch (the
 *     daemon's env/preference cascade is not visible to a CI job). No stamp ⇒ CI falls back to its own cascade.
 *   Audit trail (`events.jsonl`, same commit): one `{type:'quarantine-added'|'quarantine-removed', ...}` per change.
 */

export const QUARANTINE_BRANCH = 'ops/quarantine';
export const QUARANTINE_REF = `refs/heads/${QUARANTINE_BRANCH}`;
export const QUARANTINE_LIST_PATH = 'quarantine.json';
export const QUARANTINE_EVENTS_PATH = 'events.jsonl';
export const QUARANTINE_WRITERS = Object.freeze(['red-main-safety-net', 'operator']);
export const QUARANTINE_DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
export const QUARANTINE_MAX_TTL_MS = 24 * 60 * 60 * 1000; // an entry can never outlive a day, whatever `--ttl-min` says
export const RED_MAIN_MODES = Object.freeze(['stop', 'quarantine']);

const isStr = (v) => typeof v === 'string' && v.trim() !== '';
const SAFE_TEST = /^[\w./@-]+(?:::[^\n\r]{1,200})?$/; // a repo-relative test file, optionally `::<test name>`

/** Validate one list (shape only). A malformed list is unreadable, never "empty". PURE. */
export function validateQuarantineList(list) {
  const errors = [];
  if (!list || typeof list !== 'object' || list.version !== 1 || !Array.isArray(list.entries)) return { ok: false, errors: ['not a v1 quarantine list'] };
  if (list.fixPrs !== undefined && (!Array.isArray(list.fixPrs) || !list.fixPrs.every((n) => Number.isInteger(n) && n > 0))) errors.push('fixPrs: not a list of PR numbers');
  if (list.mode !== undefined && !RED_MAIN_MODES.includes(list.mode)) errors.push('mode: not a red-main mode');
  list.entries.forEach((e, i) => {
    if (!e || typeof e !== 'object') { errors.push(`entry ${i}: not an object`); return; }
    if (!isStr(e.test) || !SAFE_TEST.test(e.test) || e.test.includes('..')) errors.push(`entry ${i}: bad test id`);
    if (!isStr(e.brokenSha) || !/^[0-9a-f]{7,40}$/.test(e.brokenSha)) errors.push(`entry ${i}: bad brokenSha`);
    if (!isStr(e.owner)) errors.push(`entry ${i}: owner required`);
    if (!isStr(e.reason)) errors.push(`entry ${i}: reason required`);
    if (!Number.isFinite(e.addedAt) || !Number.isFinite(e.expiresAt) || e.expiresAt <= e.addedAt) errors.push(`entry ${i}: bad addedAt/expiresAt`);
  });
  return { ok: errors.length === 0, errors };
}

/** Is this writer allowed to change the list? PURE. */
export function canWriteQuarantine(actor) { return QUARANTINE_WRITERS.includes(String(actor ?? '')); }

/** Entries not yet expired at `now`. PURE. */
export function activeEntries(list, { now }) {
  return (list?.entries ?? []).filter((e) => Number.isFinite(e.expiresAt) && now < e.expiresAt);
}

/** The test file of an id (`a/b.test.mjs::name` → `a/b.test.mjs`). PURE. */
export const testFileOf = (id) => String(id).split('::')[0];

/** A test's area: its `area` if given, else the directory that holds its `__tests__` folder (or its own dir). */
export function testArea(entry) {
  if (isStr(entry?.area)) return entry.area.replace(/\/?$/, '/');
  const f = testFileOf(entry?.test ?? '');
  const i = f.indexOf('__tests__/');
  const dir = i >= 0 ? f.slice(0, i) : f.slice(0, f.lastIndexOf('/') + 1);
  return dir || null;
}

/**
 * Add entries (idempotent per test) — returns the new list and the audit events. Refuses an unknown writer. PURE.
 * @returns {{ok:boolean, list?:object, events?:object[], error?:string}}
 */
export function addEntries(list, { tests = [], brokenSha, owner, reason, actor, now, ttlMs = QUARANTINE_DEFAULT_TTL_MS, area = null }) {
  if (!canWriteQuarantine(actor)) return { ok: false, error: `writer "${actor}" may not change the quarantine list (allowed: ${QUARANTINE_WRITERS.join(', ')})` };
  const base = list && list.version === 1 ? list : { version: 1, entries: [] };
  const entries = [...base.entries];
  const events = [];
  for (const test of tests) {
    if (entries.some((e) => e.test === test && now < e.expiresAt)) continue;
    const e = { test, brokenSha, owner, reason, addedAt: now, expiresAt: now + Math.min(Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : QUARANTINE_DEFAULT_TTL_MS, QUARANTINE_MAX_TTL_MS), ...(area ? { area } : {}) };
    entries.push(e);
    events.push({ type: 'quarantine-added', at: now, actor, ...e });
  }
  const next = { version: 1, entries, ...(Array.isArray(base.fixPrs) ? { fixPrs: base.fixPrs } : {}), ...(base.mode !== undefined ? { mode: base.mode } : {}) };
  const v = validateQuarantineList(next);
  if (!v.ok) return { ok: false, error: v.errors.join('; ') };
  return { ok: true, list: next, events };
}

/**
 * Publish the red-main mode the writer resolved on the list, so CI (which reads ONLY this list) applies the same mode
 * as the daemon. Only a writer may set it. Unchanged ⇒ no event. PURE.
 */
export function setMode(list, { mode, actor, now }) {
  if (!canWriteQuarantine(actor)) return { ok: false, error: `writer "${actor}" may not change the quarantine list (allowed: ${QUARANTINE_WRITERS.join(', ')})` };
  if (!RED_MAIN_MODES.includes(mode)) return { ok: false, error: `mode "${mode}" is not a red-main mode` };
  const base = list && list.version === 1 ? list : { version: 1, entries: [] };
  if (base.mode === mode) return { ok: true, list: base, events: [] };
  const next = { ...base, version: 1, entries: [...base.entries], mode };
  return { ok: true, list: next, events: [{ type: 'quarantine-mode', at: now, actor, mode }] };
}

/**
 * Drop expired entries, and EVERY entry once main's CI is green again. `mainGreen` must be a real green read;
 * `null` (unknown) removes only expired entries. PURE.
 */
export function pruneOnGreen(list, { mainGreen, now, actor = 'red-main-safety-net' }) {
  const keep = [];
  const events = [];
  for (const e of list?.entries ?? []) {
    const why = mainGreen === true ? 'main-green' : !(now < e.expiresAt) ? 'expired' : null;
    if (why) events.push({ type: 'quarantine-removed', at: now, actor, test: e.test, brokenSha: e.brokenSha, why });
    else keep.push(e);
  }
  // The main-fix PR set belongs to the red it fixes: it goes with the last entry (or on green).
  const fixPrs = keep.length && mainGreen !== true && Array.isArray(list?.fixPrs) ? { fixPrs: list.fixPrs } : {};
  if (!keep.length && list?.fixPrs?.length) events.push({ type: 'quarantine-fix-prs', at: now, actor, fixPrs: [] });
  return { list: { version: 1, entries: keep, ...fixPrs, ...(list?.mode !== undefined ? { mode: list.mode } : {}) }, events };
}

/**
 * Record the main-fix PR numbers on the list, so CI (which reads ONLY the list's ops ref) can run the quarantined
 * tests for them. Only a writer may set it; the numbers come from the safety net's owner-PR recognition
 * (`main-ci-red-core.mjs#findOwnerPrs`), never from a PR's own tree. PURE.
 */
export function setFixPrs(list, { fixPrs, actor, now }) {
  if (!canWriteQuarantine(actor)) return { ok: false, error: `writer "${actor}" may not change the quarantine list (allowed: ${QUARANTINE_WRITERS.join(', ')})` };
  const base = list && list.version === 1 ? list : { version: 1, entries: [] };
  const nums = [...new Set((fixPrs ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
  const next = { ...base, version: 1, entries: [...base.entries], fixPrs: nums };
  const v = validateQuarantineList(next);
  if (!v.ok) return { ok: false, error: v.errors.join('; ') };
  return { ok: true, list: next, events: [{ type: 'quarantine-fix-prs', at: now, actor, fixPrs: nums }] };
}

/** ANSI colour codes and the GitHub log timestamp prefix (`2026-10-10T18:51:42.3059106Z `). */
const ANSI = /\x1b\[[0-9;]*m/g;
const LOG_TS = /^\d{4}-\d\d-\d\dT[\d:.]+Z /;

/**
 * Failing vitest tests from one CI job's log (untrusted text). `complete` only when the run's own summary line
 * (`Test Files  N failed | …`) names exactly as many failed files as were parsed — anything else (a crash before the
 * summary, a cut-off log, a failure outside vitest) is NOT a known-failing-test case. PURE.
 * @returns {{files:string[], tests:Array<{file:string,name:string|null}>, failedFiles:number|null, complete:boolean}}
 */
export function parseVitestFailures(logText) {
  const tests = [];
  let failedFiles = null;
  for (const raw of String(logText ?? '').split('\n')) {
    const line = raw.replace(LOG_TS, '').replace(ANSI, '').trimEnd();
    const m = /^\s*FAIL\s+(\S+)(?:\s+\[[^\]]*\])?(?:\s+>\s+(.+))?$/.exec(line); // `FAIL file > a > b`, or `FAIL file [ file ]` (a suite that failed to load)
    if (m && SAFE_TEST.test(m[1]) && !m[1].includes('..') && /\.test\.[cm]?[jt]sx?$/.test(m[1])) tests.push({ file: m[1], name: m[2] ? m[2].replace(/\s+>\s+/g, ' > ').slice(0, 200) : null });
    const s = /^\s*Test Files\s+(\d+) failed\b/.exec(line);
    if (s) failedFiles = Number(s[1]);
  }
  const files = [...new Set(tests.map((t) => t.file))];
  return { files, tests, failedFiles, complete: failedFiles !== null && failedFiles === files.length && files.length > 0 };
}

/** Built-in (standard) knobs of the safety net; the IO resolves each through the policy cascade. */
export const QUARANTINE_SAFETY_NET_DEFAULTS = Object.freeze({
  /** A failed job matching this is a unit-test job: its log must name every failing test file. */
  unitJobPattern: '^test-shard \\(\\d+\\)$',
  /** Aggregator jobs that fail only because a unit job did (`test` gates on `needs.test-shard`). */
  derivedJobs: Object.freeze(['test']),
  /** More failing files than this is not "a known failing test": stay in STOP. */
  maxTests: 5,
  /** Entry lifetime (minutes); capped by QUARANTINE_MAX_TTL_MS. */
  ttlMin: 360,
});

/**
 * What the red-main safety net should do with the list this tick. PURE.
 *   - main red, every failed job either a unit job whose log names its failing files completely or a derived
 *     aggregator, and ≤ maxTests files ⇒ `add` the files (whole-file entries — the only kind CI can skip) not
 *     already live for this red;
 *   - main green ⇒ `prune` when the list has any entry; expired entries ⇒ `prune` (expired only);
 *   - anything unknown ⇒ `none` (fail closed: STOP keeps holding).
 * `fixPrs` differing from the list's ⇒ `setFixPrs` alongside.
 * @param {{status:'red'|'green'|'unknown', firstRedSha?:string|null, failedJobs?:string[]|null,
 *   jobFailures?:Record<string, ReturnType<typeof parseVitestFailures>|null>, list?:object|null, fixPrs?:number[],
 *   addedForRed?:string[], now:number, settings?:object}} o  `addedForRed` = files already added for this first red
 *   commit (the safety net's ledger) — never re-added after they expire.
 * @returns {{action:'add'|'prune'|'none', tests?:string[], names?:string[], why:string, mainGreen?:boolean|null,
 *   fixPrs?:number[]|null}}
 */
export function planSafetyNet({ status, firstRedSha = null, failedJobs = null, jobFailures = {}, list = null, fixPrs = [], addedForRed = [], now, settings = {} }) {
  const s = { ...QUARANTINE_SAFETY_NET_DEFAULTS, ...settings };
  const entries = list?.entries ?? [];
  if (status === 'green') return entries.length ? { action: 'prune', mainGreen: true, why: 'main is green' } : { action: 'none', why: 'main is green; list empty' };
  if (status !== 'red') return { action: 'none', why: 'main state unknown' };
  // `fixPrs: null` = the fix-PR read is unknown this tick: leave the list's set as it is.
  const wantFix = Array.isArray(fixPrs) ? [...new Set(fixPrs.map(Number).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b) : null;
  const haveFix = [...(list?.fixPrs ?? [])].sort((a, b) => a - b);
  const fixDelta = wantFix && JSON.stringify(wantFix) !== JSON.stringify(haveFix) ? wantFix : null;
  const expired = entries.some((e) => !(now < e.expiresAt));
  const live = activeEntries(list, { now });
  // The fix-PR set is only worth a write while some entry is live (it exists to un-skip those entries for the fix PR).
  const liveFix = live.length ? fixDelta : null;
  const none = (why) => (expired ? { action: 'prune', mainGreen: null, why: `${why}; expired entries pruned`, fixPrs: liveFix } : { action: 'none', why, fixPrs: liveFix });
  if (!isStr(firstRedSha) || !/^[0-9a-f]{7,40}$/.test(firstRedSha)) return none('first red commit unknown');
  if (!Array.isArray(failedJobs) || !failedJobs.length) return none('failing jobs unknown');
  let unitRe;
  try { unitRe = new RegExp(s.unitJobPattern); } catch { return none('unitJobPattern invalid'); }
  const derived = new Set(s.derivedJobs ?? []);
  const files = [];
  const names = [];
  for (const job of failedJobs) {
    if (unitRe.test(job)) {
      const f = jobFailures?.[job];
      if (!f?.complete) return none(`failing tests of ${job} unknown (not a known-failing-test red)`);
      files.push(...f.files);
      names.push(...f.tests.map((t) => (t.name ? `${t.file} > ${t.name}` : t.file)));
    } else if (!derived.has(job)) return none(`job ${job} failed outside the unit suite (quarantine cannot skip it)`);
  }
  const uniq = [...new Set(files)];
  if (!uniq.length) return none('no unit job failed');
  if (uniq.length > s.maxTests) return none(`${uniq.length} failing test files > maxTests ${s.maxTests}`);
  // A file quarantined once for THIS red is never re-added after it expires: the TTL bounds how long one break may be
  // skipped, so a red that outlives it falls back to STOP instead of being quarantined forever (stale-entry guard).
  const done = new Set(addedForRed ?? []);
  const todo = uniq.filter((f) => !live.some((e) => e.test === f) && !done.has(f));
  if (!todo.length) return none(uniq.some((f) => done.has(f) && !live.some((e) => e.test === f)) ? 'quarantine for this red expired — STOP until main is green' : 'failing tests already quarantined');
  return { action: 'add', tests: todo, names: [...new Set(names)], firstRedSha, why: `main red since ${firstRedSha.slice(0, 9)} on ${todo.length} known failing test file(s)`, fixPrs: fixDelta };
}

/**
 * Which PR (if any) a CI job is for, from the GitHub Actions context. `onMain` for a push to / dispatch on main
 * (main skips nothing). A merge-queue group commit is for the PR at its head (`gh-readonly-queue/<base>/pr-<n>-<sha>`).
 * Unknown context ⇒ `{prNumber:null, onMain:false, known:false}` (the caller then skips nothing). PURE.
 */
export function ciJobContext({ eventName, ref, event = null }) {
  if (eventName === 'push' || eventName === 'workflow_dispatch' || eventName === 'schedule') return { onMain: ref === 'refs/heads/main', prNumber: null, known: ref === 'refs/heads/main' };
  if (eventName === 'pull_request' || eventName === 'pull_request_target') {
    const n = Number(event?.pull_request?.number ?? /^refs\/pull\/(\d+)\//.exec(String(ref ?? ''))?.[1]);
    return Number.isInteger(n) && n > 0 ? { onMain: false, prNumber: n, known: true } : { onMain: false, prNumber: null, known: false };
  }
  if (eventName === 'merge_group') {
    const n = Number(/\/pr-(\d+)-[0-9a-f]+$/.exec(String(event?.merge_group?.head_ref || ref || ''))?.[1]);
    return Number.isInteger(n) && n > 0 ? { onMain: false, prNumber: n, known: true } : { onMain: false, prNumber: null, known: false };
  }
  return { onMain: false, prNumber: null, known: false };
}

/**
 * The CI skip decision for one job. Skips nothing when: the mode is not `quarantine`, the list is unreadable, the job
 * context is unknown, it is main, or the PR is a recorded main-fix PR. A PR that CHANGES a quarantined test file
 * also runs that file (it may be the real fix, or it may be hiding a further break in it). Changed files unknown ⇒
 * every quarantined file runs. PURE.
 * @returns {{skip:string[], why:string, unsupported?:string[]}}
 */
export function decideCiSkip({ mode, read, ctx, changedFiles = null, now }) {
  if (mode !== 'quarantine') return { skip: [], why: `redMainMode is ${mode}` };
  if (!read?.ok) return { skip: [], why: `quarantine list unreadable (${read?.error ?? 'unknown'}) — running everything` };
  if (!ctx?.known) return { skip: [], why: 'job context unknown — running everything' };
  const fixPrs = read.list.fixPrs ?? [];
  const tests = testsToSkip({ list: read.list, now, prNumber: ctx.prNumber, fixPrs, onMain: ctx.onMain });
  if (!tests.length) return { skip: [], why: ctx.onMain ? 'main runs every test' : fixPrs.includes(ctx.prNumber) ? `PR #${ctx.prNumber} is the main-fix PR — it runs the quarantined tests` : 'no live quarantine entry' };
  if (!Array.isArray(changedFiles)) return { skip: [], why: 'this PR\'s changed files are unknown — running everything' };
  const changed = new Set(changedFiles);
  const touched = tests.filter((t) => changed.has(testFileOf(t)));
  const rest = tests.filter((t) => !changed.has(testFileOf(t)));
  const { args, unsupported } = vitestExcludeArgs(rest);
  const skip = args.map((a) => a.slice('--exclude='.length));
  return { skip, unsupported, why: `skipping ${skip.length} quarantined test file(s)${touched.length ? `; running ${touched.length} this PR changes` : ''}` };
}

/**
 * Which tests CI should skip for this job. The main-fix PR (and main itself) skip nothing — the fix must prove
 * the quarantined test passes. PURE.
 */
export function testsToSkip({ list, now, prNumber = null, fixPrs = [], onMain = false }) {
  if (onMain) return [];
  // The main-fix PR set published on the list always counts: a caller's `fixPrs` only adds to it, so no reader (CI's
  // step, the `skip` CLI) can make the fix PR skip the test it must prove passes by forgetting to pass them.
  const fix = [...(fixPrs ?? []), ...(Array.isArray(list?.fixPrs) ? list.fixPrs : [])].map(Number);
  if (prNumber != null && String(prNumber).trim() !== '' && fix.includes(Number(prNumber))) return [];
  return [...new Set(activeEntries(list, { now }).map((e) => e.test))];
}

/** Is this entry a whole-file quarantine (no `::<test name>`)? Only those may stand for a whole file. PURE. */
export const isWholeFileEntry = (testId) => !String(testId).includes('::');

/**
 * The vitest CLI args for the tests CI should skip. A whole-file entry becomes `--exclude=<file>`; a name-qualified
 * `file::test name` entry NEVER does — an exclude is per file, so it would also skip every other test in that file,
 * and a test name is free text that must not reach a shell. Those entries are returned in `unsupported` instead (CI
 * runs them: the safe direction). PURE.
 * @returns {{args:string[], unsupported:string[]}}
 */
export function vitestExcludeArgs(tests) {
  const ids = [...new Set((tests ?? []).map(String))];
  const files = [...new Set(ids.filter(isWholeFileEntry))];
  return { args: files.map((f) => `--exclude=${f}`), unsupported: ids.filter((t) => !isWholeFileEntry(t)) };
}

/** `gh pr list --json files` returns at most this many files per PR (GraphQL `first:100`); a list this long may be cut off. */
export const LISTED_FILES_CAP = 100;

/**
 * A PR's changed-file paths from its open-PR listing row, or `null` when they are not fully known: no list, or one at
 * the listing cap (a larger PR is silently truncated, which would hide an overlap). PURE.
 */
export function listedPrFiles(pr) {
  if (!Array.isArray(pr?.files) || pr.files.length >= LISTED_FILES_CAP) return null;
  return pr.files.map((f) => (typeof f === 'string' ? f : f?.path)).filter(Boolean);
}

/**
 * The main-fix PR's files, for {@link decideQuarantineHold}. `null` (unknown — fail closed there) when ANY published
 * fix PR's files cannot be read; `[]` only when no fix PR is published at all. PURE.
 * @param {{fixPrs:number[], filesOf:(n:number)=>string[]|null}} o
 */
export function resolveFixFiles({ fixPrs, filesOf }) {
  if (!fixPrs?.length) return [];
  const all = [];
  for (const n of fixPrs) {
    const f = filesOf(n);
    if (!Array.isArray(f)) return null;
    all.push(...f);
  }
  return all;
}

/**
 * A red required check that failed ONLY on quarantined tests is routed to the existing re-run path (the next run
 * skips them). Unknown failing tests ⇒ not a quarantine case. A failure is covered ONLY if the next run will actually
 * skip it: that is a whole-file entry ({@link vitestExcludeArgs}). A name-qualified entry is never skipped by the
 * per-file exclude, so routing its failure to a re-run would just fail again (a re-run loop) and is not covered. PURE.
 */
export function classifyQuarantinedFailure({ failedTests, list, now }) {
  if (!Array.isArray(failedTests) || !failedTests.length) return { rerun: false, why: 'failed tests unknown' };
  const q = activeEntries(list, { now });
  const covered = (t) => q.some((e) => isWholeFileEntry(e.test) && testFileOf(e.test) === testFileOf(t));
  const other = failedTests.filter((t) => !covered(t));
  return other.length ? { rerun: false, why: `non-quarantined failures: ${other.slice(0, 3).join(', ')}` } : { rerun: true, why: 'failed only on quarantined tests' };
}

/**
 * Mode QUARANTINE's per-PR hold. Called only while main is red and the mode is `quarantine`. PURE.
 * @param {{num:number, files:string[]|null, signal:object, list:object|null, fixFiles:string[]|null, now:number}} o
 * @returns {{hold:boolean, reason?:string, fix?:boolean, fallback?:'stop'}}
 */
export function decideQuarantineHold({ num, files, signal, list, fixFiles, now }) {
  if (signal.fixPrs.includes(Number(num))) return { hold: false, fix: true };
  const live = activeEntries(list, { now }).filter((e) => !signal.firstRedSha || String(signal.firstRedSha).startsWith(e.brokenSha) || e.brokenSha.startsWith(String(signal.firstRedSha)));
  if (!live.length) return { hold: true, fallback: 'stop', reason: 'red-main-hold: main is red and no quarantine entry covers it — stop mode until one is published' };
  if (!Array.isArray(files)) return { hold: true, reason: 'red-main-hold: main is red (quarantine) and this PR\'s files are unknown — held (fail closed)' };
  const fixSet = new Set(fixFiles ?? []);
  const overlapFix = files.filter((f) => fixSet.has(f));
  if (fixFiles == null && signal.fixPrs.length) return { hold: true, reason: 'red-main-hold: main is red (quarantine) and the main-fix PR\'s files are unknown — held (fail closed)' };
  if (overlapFix.length) return { hold: true, reason: `red-main-hold: overlaps the main-fix PR ${signal.fixPrs.map((n) => `#${n}`).join(', ')} (${overlapFix.slice(0, 3).join(', ')})` };
  const areas = live.map(testArea).filter(Boolean);
  const inArea = files.filter((f) => areas.some((a) => f.startsWith(a)) || live.some((e) => testFileOf(e.test) === f));
  if (inArea.length) return { hold: true, reason: `red-main-hold: touches a quarantined test's area (${inArea.slice(0, 3).join(', ')})` };
  return { hold: false };
}
