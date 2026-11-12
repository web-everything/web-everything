/**
 * R883 slice 2 — the PR's OWN change between the prior reviewed head and the new head.
 *
 * A raw `prior..head` diff also contains every commit that came in from main (merges, rebases), which pushes most
 * later rounds past the delta cap. For each file in the raw range this compares the PR's own patch against the
 * merge-base with `base` at both heads; a file whose own patch is identical (content, mode, binary data) and sits at
 * the same place (its line numbers differ only by what main itself added or removed above it) was not changed by the
 * PR and is dropped. Where main touched lines next to a hunk its place cannot be proven, so the file is kept.
 * Pure: git is injected as `exec`. Fails closed: ANY unreadable input returns null so the caller keeps the raw range
 * (or a full review). Kept files keep their raw line data, so the result is only ever a subset of the raw range.
 */

const SHA = /^[0-9a-f]{4,64}$/i;
const REF = /^[A-Za-z0-9._/-]+$/;
const MAX = 64 * 1024 * 1024;
const MAX_FILES = 2000;
const TIMEOUT_MS = 60_000;
const TOTAL_BUDGET_MS = 120_000;

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Split a `git diff` for one path into the part that does not depend on main (the header without its `diff --git` /
 * `index` lines, which carry blob ids and paths) and its hunks. Each hunk keeps its old-side start and length plus its
 * full body (changed lines and 3 lines of context), so a binary change (`--binary` data), a mode change, an empty-file
 * add, a moved block and a content line that merely looks like a header (`---old`) all stay in the comparison.
 * Anything not recognised stays in the header or body text, which can only keep a file, never drop one.
 */
function parsePatch(text) {
  const header = [];
  const hunks = [];
  let cur = null;
  let inHeader = true;
  for (const l of text.split('\n')) {
    if (!cur) {
      const m = HUNK.exec(l);
      if (m) { cur = { oldStart: Number(m[1]), oldLen: m[2] === undefined ? 1 : Number(m[2]), body: [] }; hunks.push(cur); inHeader = false; continue; }
      if (inHeader) {
        if (l.startsWith('GIT binary patch') || l.startsWith('Binary files')) inHeader = false;
        else if (l.startsWith('diff --git ') || l.startsWith('index ')) continue;
      }
      header.push(l);
      continue;
    }
    const m = HUNK.exec(l);
    if (m) { cur = { oldStart: Number(m[1]), oldLen: m[2] === undefined ? 1 : Number(m[2]), body: [] }; hunks.push(cur); continue; }
    cur.body.push(l);
  }
  return { header: header.join('\n'), hunks };
}

/**
 * Old-side hunks of a `--unified=0` diff: how main's own change moved lines between the two merge-bases. `lines` is the
 * text of every line main added or removed, used to detect an ambiguous alignment (see mapStart).
 */
function shiftHunks(text) {
  const hunks = [];
  const lines = new Set();
  let inHunk = false;
  for (const l of text.split('\n')) {
    const m = HUNK.exec(l);
    if (m) { inHunk = true; hunks.push({ oldStart: Number(m[1]), oldLen: m[2] === undefined ? 1 : Number(m[2]), newLen: m[4] === undefined ? 1 : Number(m[4]) }); continue; }
    if (inHunk && (l[0] === '+' || l[0] === '-')) lines.add(l.slice(1));
  }
  return { hunks, lines };
}

/**
 * Where a PR hunk that started at old line `h.oldStart` in the prior merge-base sits in the head merge-base, given
 * main's own hunks between the two. null = the place cannot be proven: main touched lines in or next to the hunk, or
 * main added or removed a line whose text also appears in the hunk. Inside a run of identical lines git may report
 * main's edit at either end of the run, so the offset it implies is not trustworthy; keeping the file is the safe side.
 */
function mapStart(h, main) {
  const s = h.oldStart;
  const e = s + Math.max(h.oldLen, 1) - 1;
  if (main.lines.size && h.body.some(l => l[0] !== '\\' && main.lines.has(l.slice(1)))) return null;
  let offset = 0;
  for (const m of main.hunks) {
    // A pure insertion by main (oldLen 0) sits between old lines oldStart and oldStart+1; treat both as touched.
    const a1 = m.oldStart;
    const a2 = m.oldLen === 0 ? m.oldStart + 1 : m.oldStart + m.oldLen - 1;
    if (a1 <= e && a2 >= s) return null;
    if (a2 < s) offset += m.newLen - m.oldLen;
  }
  return s + offset;
}

/** Run git through the injected `exec`; anything but a string (null, undefined, a Buffer) is unreadable → throw. */
function run(exec, args, extra = {}) {
  const out = exec('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: TIMEOUT_MS, ...extra });
  if (typeof out !== 'string') throw new Error('exec-returned-non-string');
  return out;
}

/** The merge-base of `head` with `base` (path-independent, so computed once per head). */
function mergeBase(exec, head, base) {
  const mb = run(exec, ['merge-base', head, base]).trim();
  if (!SHA.test(mb)) throw new Error('merge-base-unreadable');
  return mb;
}

/** True when `path` is a tracked entry (file, symlink or submodule) of the tree at `rev`. Literal, never a glob. */
function inTree(exec, rev, path) {
  return run(exec, ['--literal-pathspecs', 'ls-tree', '-z', '--name-only', rev, '--', path]).split('\0').includes(path);
}

const DIFF_FLAGS = ['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--ignore-submodules=none'];

/** One file's PR-own patch from the merge-base `mb` to `head`, parsed. */
function ownPatch(exec, head, mb, path) {
  // --literal-pathspecs: `path` is data from the caller, never a glob or pathspec magic.
  // --ignore-submodules=none: a repo/user `diff.ignoreSubmodules` or `.gitmodules` `ignore=all` must not hide a pointer bump.
  return parsePatch(run(exec, [...DIFF_FLAGS, '--binary', '--unified=3', mb, head, '--', path], { maxBuffer: MAX }));
}

/**
 * True only when the PR's own patch is the same change in the same place at both heads. Text, mode and binary data must
 * match, and every hunk must sit where main's own edits between the two merge-bases say the prior hunk now is. Equal
 * context alone is not a place: a repetitive file has the same 3 lines around many spots.
 */
function samePatch(exec, a, b, mbPrior, mbHead, path) {
  if (a.header !== b.header || a.hunks.length !== b.hunks.length) return false;
  for (let i = 0; i < a.hunks.length; i += 1) if (a.hunks[i].body.join('\n') !== b.hunks[i].body.join('\n')) return false;
  if (!a.hunks.length) return true;
  const main = mbPrior === mbHead ? { hunks: [], lines: new Set() } : shiftHunks(run(exec, [...DIFF_FLAGS, '--unified=0', mbPrior, mbHead, '--', path], { maxBuffer: MAX }));
  return a.hunks.every((h, i) => mapStart(h, main) === b.hunks[i].oldStart);
}

/**
 * @param {{exec: Function, priorHead: string, head: string, base: string, rawFiles: Record<string, number[]|null>,
 *   budgetMs?: number, now?: () => number}} o  `budgetMs` is the total time for all git calls (default 120 s); `now` is injectable for tests.
 * @returns {{files: Record<string, number[]|null>, dropped: string[]}|null} null = cannot prove; use the raw range.
 */
export function netInterdiff({ exec: rawExec, priorHead, head, base, rawFiles, budgetMs = TOTAL_BUDGET_MS, now = Date.now } = {}) {
  try {
    if (typeof rawExec !== 'function' || !SHA.test(priorHead ?? '') || !SHA.test(head ?? '')) return null;
    if (typeof now !== 'function' || !Number.isFinite(budgetMs) || !(budgetMs > 0)) return null;
    // One deadline for the whole call. Every git call is clamped to the time left, and once none is left the call throws,
    // so the caller keeps the raw range instead of blocking the review on a slow or stalled git. The same check runs
    // once per path and after the last one, so in-process parsing between git calls is bounded too.
    const start = now();
    if (!Number.isFinite(start)) return null;
    const deadline = start + budgetMs;
    const timeLeft = () => {
      const left = deadline - now();
      if (!(left > 0)) throw new Error('interdiff-budget-exhausted');
      return left;
    };
    const exec = (cmd, args, opts = {}) => {
      const left = timeLeft();
      const own = opts.timeout > 0 ? opts.timeout : TIMEOUT_MS;
      // execFileSync wants a whole number of milliseconds; round up so a fractional clock never makes every call throw.
      return rawExec(cmd, args, { ...opts, timeout: Math.max(1, Math.ceil(Math.min(own, left))) });
    };
    if (typeof base !== 'string' || base.startsWith('-') || !REF.test(base)) return null;
    if (!rawFiles || typeof rawFiles !== 'object' || Array.isArray(rawFiles)) return null;
    const entries = Object.entries(rawFiles);
    // Bound the work (about five git calls per path): over the path cap, or past the total time budget (see `exec`
    // above), the caller keeps the raw range.
    if (entries.length > MAX_FILES) return null;
    for (const [path] of entries) if (typeof path !== 'string' || !path || path.startsWith('-')) return null;
    // Collected as entries and built with Object.fromEntries: `files[path] = …` would turn a path named `__proto__`
    // into a prototype assignment and silently lose it. fromEntries defines it as an own property.
    const kept = [];
    const dropped = [];
    if (!entries.length) return { files: {}, dropped };
    const mbPrior = mergeBase(exec, priorHead, base);
    const mbHead = mergeBase(exec, head, base);
    for (const [path, lines] of entries) {
      timeLeft();
      // A path git does not see at either head would give an empty diff at both and be "dropped": refuse instead.
      if (!inTree(exec, priorHead, path) && !inTree(exec, head, path)) return null;
      if (samePatch(exec, ownPatch(exec, priorHead, mbPrior, path), ownPatch(exec, head, mbHead, path), mbPrior, mbHead, path)) dropped.push(path);
      else kept.push([path, lines]);
    }
    timeLeft();
    return { files: Object.fromEntries(kept), dropped };
  } catch {
    return null;
  }
}

/** One shadow log line comparing the raw range with the interdiff (null interdiff = fell back to raw). */
export function interdiffShadowLine({ pr, raw, net } = {}) {
  const rawCount = raw && typeof raw === 'object' ? Object.keys(raw).length : 0;
  const netCount = net?.files ? Object.keys(net.files).length : null;
  return `[net-interdiff] pr=${pr ?? '?'} raw=${rawCount} interdiff=${netCount ?? 'unavailable'}`;
}
