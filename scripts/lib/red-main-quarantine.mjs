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
 *   Audit trail (`events.jsonl`, same commit): one `{type:'quarantine-added'|'quarantine-removed', ...}` per change.
 */

export const QUARANTINE_BRANCH = 'ops/quarantine';
export const QUARANTINE_REF = `refs/heads/${QUARANTINE_BRANCH}`;
export const QUARANTINE_LIST_PATH = 'quarantine.json';
export const QUARANTINE_EVENTS_PATH = 'events.jsonl';
export const QUARANTINE_WRITERS = Object.freeze(['red-main-safety-net', 'operator']);
export const QUARANTINE_DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
export const RED_MAIN_MODES = Object.freeze(['stop', 'quarantine']);

const isStr = (v) => typeof v === 'string' && v.trim() !== '';
const SAFE_TEST = /^[\w./@-]+(?:::[^\n\r]{1,200})?$/; // a repo-relative test file, optionally `::<test name>`

/** Validate one list (shape only). A malformed list is unreadable, never "empty". PURE. */
export function validateQuarantineList(list) {
  const errors = [];
  if (!list || typeof list !== 'object' || list.version !== 1 || !Array.isArray(list.entries)) return { ok: false, errors: ['not a v1 quarantine list'] };
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
    const e = { test, brokenSha, owner, reason, addedAt: now, expiresAt: now + ttlMs, ...(area ? { area } : {}) };
    entries.push(e);
    events.push({ type: 'quarantine-added', at: now, actor, ...e });
  }
  const next = { version: 1, entries };
  const v = validateQuarantineList(next);
  if (!v.ok) return { ok: false, error: v.errors.join('; ') };
  return { ok: true, list: next, events };
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
  return { list: { version: 1, entries: keep }, events };
}

/**
 * Which tests CI should skip for this job. The main-fix PR (and main itself) skip nothing — the fix must prove
 * the quarantined test passes. PURE.
 */
export function testsToSkip({ list, now, prNumber = null, fixPrs = [], onMain = false }) {
  if (onMain) return [];
  if (prNumber != null && fixPrs.map(Number).includes(Number(prNumber))) return [];
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
 * skips them). Unknown failing tests ⇒ not a quarantine case. A name-qualified entry covers only that exact test,
 * never the other tests of its file. PURE.
 */
export function classifyQuarantinedFailure({ failedTests, list, now }) {
  if (!Array.isArray(failedTests) || !failedTests.length) return { rerun: false, why: 'failed tests unknown' };
  const q = activeEntries(list, { now });
  const covered = (t) => q.some((e) => e.test === t || (isWholeFileEntry(e.test) && testFileOf(e.test) === testFileOf(t)));
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
