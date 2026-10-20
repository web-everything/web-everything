/** @file scripts/lib/daemon-rebuild/auto-refresh.mjs — xqz26k1 (x9diisp auto-refresh half): a clone HELD because main
 * moved onto its live overlays builds its own refresh candidate = the running last-good build merged with origin/main.
 *
 * WHY (live 2026-10-20, four times): main graduated changes the daemon clones also carried as overlays (#5755, #5747
 * at 19:22-19:28Z; #5770 at 20:42Z). Every registered stack top stopped merging with main, the x9diisp hold (PR 5757)
 * correctly froze the review and drain clones on their last-good build — and nothing refreshed them. An agent merged
 * origin/main into each top by hand (main where main already had the change, overlay behaviour otherwise), audited,
 * tested, registered and loaded it. Meanwhile no update reached the frozen clones.
 *
 * WHAT. When `prepareRebuild` reaches the established-overlay hold, {@link buildRefreshCandidate} merges the running
 * HEAD (main-then + every overlay the build carries) with origin/main IN THE OBJECT DB (merge-tree / merge-file /
 * a throwaway index file — the clone's tree, index and refs are never touched). A conflict hunk resolves only by a
 * deterministic containment rule; anything else keeps the hold and names the files (needs-you). No model call.
 *   (a) the overlay's change in the hunk is already carried by main — every line it removed is gone from main's side
 *       and every line it added is in main's side of the hunk or was added by a main-side commit to that file
 *       (main graduated it, possibly evolving it since) → take main's side;
 *   (a') the mirror: main's change in the hunk is already carried by the overlay side (the overlay already holds
 *       main's change and built on it) → take the overlay's side. Reported separately so the operator can rule on it.
 *   Docs / config / settings files are stricter (card A3): taken from main only when every overlay-only commit that
 *   touched the file is patch-id-equal (per file) to a main commit; never the mirror.
 *   GUARD DIFF: a hunk is never auto-resolved when the side it drops carries a numeric setting (`name: 3`,
 *   `name = 30`, "`name` defaults to 1") or a comparison (`v <= cap`) the side it keeps does not carry verbatim —
 *   the candidate is never weaker than either parent (today's case: attempts<=1 vs main's attempts 3 stays held).
 *   Any git error, an add/delete or mode conflict, a binary file, or marker-like content in a side: needs-human.
 * The candidate commit (parents: last-good HEAD, origin/main; the fixed rebuild identity; date = the later parent's, so
 * the same inputs mint the same sha) is then CHECKED off-lock by {@link runAutoRefreshCheck}: the daemon's normal live
 * smoke on a disposable candidate worktree, plus the tests that cover the conflicted files, through heavy admission.
 *
 * MODE — `rebuild.autoRefresh.mode` through the shared policy cascade (standard `off`; this repo's tool layer
 * `scripts/lib/daemon-rebuild-settings.json` sets `shadow`; env `WE_REBUILD_AUTO_REFRESH_MODE`), its source logged:
 *   off    — nothing (the plain x9diisp hold).
 *   shadow — build + check + LOG what it would adopt (`auto-refresh-candidate`, `auto-refresh-checked`). Never adopts,
 *            never pushes, never edits the overlay list.
 *   on     — after a clean build AND a passing smoke AND passing tests, push the candidate as a NEW branch
 *            `lane/auto-refresh-<clone>-<sha9>` (never a force-push, never an existing branch) and register it as an
 *            overlay with a reason. It contains every overlay the build carried plus main, so the next ordinary rebuild
 *            plans it as the stack top and adopts it through the normal smoke + finalize path.
 * One build per (last-good HEAD, main) pair and one check per candidate: the record lives beside the rebuild state
 * (`<stateDir>/<cloneKey>.auto-refresh.json`), claimed under the clone write lock (prepare) so sibling daemons never
 * run the same check twice.
 */

import { mkdtempSync, rmSync, readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cascadePolicy } from '../policy-cascade.mjs';
import {
  cloneKey, addOverlay, appendOverlayEvent, readOverlayState, removeOverlay,
} from '../daemon-overlays.mjs';
import { runLiveSmoke, runLiveSmokeWithRetry, refreshSmokeGithubEnv, decideSmokeVerdict } from '../daemon-live-smoke.mjs';
import { stateDir, alertsFilePath } from './state.mjs';
import {
  verifyRev, FULL_SHA_RE, REBUILD_IDENTITY_ENV,
} from './shared.mjs';
import {
  materializeCandidate, removeCandidate, candidateWorktreePath, candidateSmokeEnv,
} from './candidate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const AUTO_REFRESH_SETTINGS_PATH = join(HERE, '..', 'daemon-rebuild-settings.json');
export const AUTO_REFRESH_MODE_ENV = 'WE_REBUILD_AUTO_REFRESH_MODE';
export const AUTO_REFRESH_MODES = Object.freeze(['off', 'shadow', 'on']);
/** A check claim older than this is treated as abandoned (its process died) and may be re-claimed. */
export const AUTO_REFRESH_CHECK_CLAIM_MS = 90 * 60_000;
/** Upper bound on the touched-tests run (heavy-admission wait included). */
export const AUTO_REFRESH_TESTS_TIMEOUT_MS = 30 * 60_000;
const DOCS_CONFIG_RE = /\.(md|json|ya?ml|txt|toml)$/i;
const REBUILD_COMMITTER = REBUILD_IDENTITY_ENV.GIT_COMMITTER_EMAIL;

// ── setting ────────────────────────────────────────────────────────────────────────────────────────────────────

/** `rebuild.autoRefresh.mode` via the policy cascade. Never throws; anything unreadable resolves to the standard `off`. */
export function resolveAutoRefreshMode(env = process.env, { settingsPath = AUTO_REFRESH_SETTINGS_PATH } = {}) {
  let tool;
  try { tool = JSON.parse(readFileSync(settingsPath, 'utf8'))?.rebuild; } catch { tool = undefined; }
  const raw = String(env?.[AUTO_REFRESH_MODE_ENV] ?? '').trim();
  const okMode = (v) => AUTO_REFRESH_MODES.includes(v);
  try {
    const r = cascadePolicy('rebuild', tool, {
      env,
      standard: { autoRefresh: { mode: 'off' } },
      envValues: { autoRefresh: raw ? { mode: raw } : undefined },
      valid: { autoRefresh: (v) => okMode(v) || (v && typeof v === 'object' && okMode(v.mode)) },
    });
    const mode = r.value?.autoRefresh?.mode;
    const source = r.sources?.['autoRefresh.mode'] ?? r.sources?.autoRefresh ?? 'standard';
    return { mode: okMode(mode) ? mode : 'off', source };
  } catch {
    return { mode: 'off', source: 'standard' };
  }
}

// ── pure hunk logic ────────────────────────────────────────────────────────────────────────────────────────────

const SUBSTANTIVE = (l) => /[A-Za-z0-9]/.test(l) && l.trim().length >= 10;
const TRIVIAL = (l) => !/[A-Za-z0-9]/.test(l);
const count = (arr, x) => arr.reduce((k, y) => k + (y === x ? 1 : 0), 0);

/** Does `hay` contain `needle` as a contiguous run? */
export function containsRun(hay, needle) {
  if (needle.length === 0) return true;
  outer: for (let i = 0; i + needle.length <= hay.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/**
 * PURE: the change base → side as LCS line edits: the lines removed from base, and the RUNS of lines added (each run
 * contiguous in `side`). Null when the hunk is too large to diff safely (fail closed).
 * @returns {{removed:string[], runs:string[][]}|null}
 */
export function lineChange(base, side) {
  const n = base.length;
  const m = side.length;
  if (n * m > 4_000_000) return null;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = base[i] === side[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const removed = [];
  const runs = [];
  let run = null;
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && base[i] === side[j]) { run = null; i += 1; j += 1; } else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) {
      if (!run) { run = []; runs.push(run); }
      run.push(side[j]);
      j += 1;
    } else { removed.push(base[i]); i += 1; }
  }
  return { removed, runs };
}

/**
 * PURE: is `change` (base → this side) already carried by the OTHER side? Every removed line must be gone from the other
 * side's hunk (multiset), and every added run must be covered, piece by piece (greedy longest prefix), by a contiguous run
 * in the other side's hunk or — for a piece holding at least one substantive line — in a run the other side's history
 * added to this file. A piece made only of punctuation lines is never accepted from history alone.
 */
export function carriedBy(change, { base, other, otherHistoryRuns = [] }) {
  if (!change) return false;
  for (const r of new Set(change.removed)) {
    if (count(other, r) > count(base, r) - count(change.removed, r)) return false;
  }
  for (const run of change.runs) {
    let p = 0;
    while (p < run.length) {
      let best = 0;
      for (let q = run.length; q > p; q -= 1) {
        const piece = run.slice(p, q);
        if (containsRun(other, piece)) { best = q - p; break; }
        if (piece.some(SUBSTANTIVE) && !piece.every(TRIVIAL) && otherHistoryRuns.some((h) => containsRun(h, piece))) { best = q - p; break; }
      }
      if (best === 0) return false;
      p += best;
    }
  }
  return true;
}

const NUM_FACT_RE = /["']?([A-Za-z_$][\w$-]*)["']?\s*[:=]\s*(-?\d[\d_]*(?:\.\d+)?)(?![\w.])/;
/** A line holding a comparison (`<`, `<=`, `>`, `>=`, `==`, `===`, `!=`, `!==`; arrows `=>` are not comparisons). */
const CMP_LINE_RE = /(<=|>=|===|!==|==|!=|<|>)/;
const ARROW_RE = /=>/g;
const DOC_FACT_RE = /`([\w.$-]+)`[^.\n`]{0,60}?\b(?:defaults? to|is capped at|capped at|upper bound of|bound of|is|=)\s*`?(-?\d[\d_]*)/i;

/** PURE: the guard facts in a block of lines — every line holding a numeric setting (`name: 3`, `"name": 3`,
 *  `name = 30 * 60_000`), a documented numeric default ("`name` defaults to 1") or a comparison. Round-4 audit: a fact is
 *  the WHOLE normalized line, never just the first literal or a truncated operand — `30 * 60_000` and `30 * 600_000`, or
 *  `a < limit` and `a < limit * 3`, are different guards, so any edit to such a line counts as a different guard. */
export function guardFacts(lines) {
  const facts = new Set();
  for (const l of lines) {
    const norm = l.trim().replace(/\s+/g, ' ');
    if (!norm) continue;
    if (NUM_FACT_RE.test(l) || DOC_FACT_RE.test(l)) facts.add(`num:${norm}`);
    if (CMP_LINE_RE.test(l.replace(ARROW_RE, ''))) facts.add(`cmp:${norm}`);
  }
  return facts;
}

/** PURE: the guard facts the dropped side carries that the kept side does not (empty = the keep is not weaker). */
export function guardDiff(kept, dropped) {
  const k = guardFacts(kept);
  return [...guardFacts(dropped)].filter((f) => !k.has(f));
}

const MARKER_RE = /^(<{7}|\|{7}|={7}|>{7})( |$)/;

/**
 * PURE: parse `git merge-file -p --diff3 -L overlay -L base -L main` output into text and conflict segments.
 * @returns {Array<{text:string[]}|{ours:string[], base:string[], theirs:string[], line:number}>|null}
 */
export function parseDiff3(text) {
  const lines = String(text).split('\n');
  const segs = [];
  let cur = { text: [] };
  let state = 'text';
  let hunk = null;
  for (let idx = 0; idx < lines.length; idx += 1) {
    const l = lines[idx];
    if (state === 'text' && l === '<<<<<<< overlay') {
      segs.push(cur);
      hunk = { ours: [], base: [], theirs: [], line: idx + 1 };
      state = 'ours';
    } else if (state === 'ours' && l === '||||||| base') state = 'base';
    else if (state === 'base' && l === '=======') state = 'theirs';
    else if (state === 'theirs' && l === '>>>>>>> main') {
      segs.push(hunk);
      cur = { text: [] };
      state = 'text';
    } else if (state === 'text') cur.text.push(l);
    else if (MARKER_RE.test(l)) return null; // nested / unexpected marker: never guess
    else hunk[state].push(l);
  }
  if (state !== 'text') return null;
  segs.push(cur);
  return segs;
}

/**
 * PURE: resolve every conflict hunk of one file by the containment rule + guard diff.
 * @param {{diff3:string, overlayRuns:string[][], mainRuns:string[][], docsConfig?:boolean, patchIdCarried?:boolean}} o
 * @returns {{ok:boolean, text?:string, hunks:Array<{line:number, to?:'main'|'overlay', why?:string}>}}
 */
export function resolveFileHunks({ diff3, overlayRuns = [], mainRuns = [], docsConfig = false, patchIdCarried = false }) {
  const segs = parseDiff3(diff3);
  if (!segs) return { ok: false, hunks: [{ line: 0, why: 'unparseable-conflict-markers' }] };
  // merge-tree said this file conflicts: output without a conflict hunk (a killed or failed merge-file) is never a resolution.
  if (!segs.some((x) => !x.text)) return { ok: false, hunks: [{ line: 0, why: 'merge-file-no-conflict-output' }] };
  const out = [];
  const hunks = [];
  let ok = true;
  for (const s of segs) {
    if (s.text) { out.push(...s.text); continue; }
    let to = null;
    let why = 'neither-side-carries-the-other';
    if (docsConfig) {
      if (patchIdCarried) to = 'main';
      else why = 'docs-config-needs-patch-id-match';
    } else {
      const ov = lineChange(s.base, s.ours);
      const mn = lineChange(s.base, s.theirs);
      if (!ov || !mn) why = 'hunk-too-large';
      else if (carriedBy(ov, { base: s.base, other: s.theirs, otherHistoryRuns: mainRuns })) to = 'main';
      else if (carriedBy(mn, { base: s.base, other: s.ours, otherHistoryRuns: overlayRuns })) to = 'overlay';
    }
    if (to) {
      const kept = to === 'main' ? s.theirs : s.ours;
      const dropped = to === 'main' ? s.ours : s.theirs;
      const weaker = guardDiff(kept, dropped);
      if (weaker.length > 0) { to = null; why = `guard-diff: ${weaker.slice(0, 4).join(', ')}`; }
      else { out.push(...kept); hunks.push({ line: s.line, to }); continue; }
    }
    ok = false;
    hunks.push({ line: s.line, why });
    out.push(...s.ours); // placeholder only — an unresolved file is never written
  }
  return ok ? { ok: true, text: out.join('\n'), hunks } : { ok: false, hunks };
}

// ── git IO ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** A git runner that also passes `input` (stdin) and extra env through to `run`. */
function gitIO({ run, cwd, env }) {
  return (args, { input, env: extra } = {}) => run(args, {
    cwd, timeout: 120_000, killSignal: 'SIGKILL', env: { ...env, ...REBUILD_IDENTITY_ENV, ...(extra || {}) }, ...(input !== undefined ? { input } : {}),
  });
}

/** The overlays one daemon build merged (its rebuild-committed `merge overlay <ref>` commits above `mainSha`). */
export function overlaysMergedBy(git, build, mainSha) {
  const log = git(['log', '--first-parent', '-n', '400', '--format=%P%x09%ce%x09%s', build, '--not', mainSha]);
  if (log.status !== 0) return null;
  const merged = [];
  for (const l of String(log.stdout ?? '').split('\n').filter(Boolean)) {
    const [parents, committer, ...rest] = l.split('\t');
    const hit = rest.join('\t').match(/^daemon-rebuild: merge overlay (\S+) (?:\(PR #(\d+)\) )?onto /);
    if (!hit || committer !== REBUILD_COMMITTER || parents.split(' ').length !== 2) continue;
    merged.push({ ref: hit[1], pr: hit[2] != null ? Number(hit[2]) : null, sha: parents.split(' ')[1] });
  }
  return merged;
}

const prKey = (pr) => (pr == null || pr === '' ? null : Number(pr));
/**
 * Identity scoping (edge case 5): the overlays `headSha` carries that are no longer registered on this clone, matched on
 * ref AND PR (a branch name reused by another PR is a different overlay). Null on a git error (fail closed).
 * @param {Iterable<string|{ref:string, pr?:number|null}>} registered
 */
export function unregisteredCarried(git, headSha, mainSha, registered) {
  const merged = overlaysMergedBy(git, headSha, mainSha);
  if (!merged) return null;
  const reg = [...registered].map((r) => (typeof r === 'string' ? { ref: r, pr: null } : { ref: r?.ref, pr: r?.pr ?? null }));
  const gone = merged.filter((m) => !reg.some((r) => r.ref === m.ref && prKey(r.pr) === prKey(m.pr)));
  return { merged, gone: [...new Set(gone.map((m) => (m.pr != null ? `${m.ref} (PR #${m.pr})` : m.ref)))] };
}

/** Runs of lines each non-merge commit in `from --not notIn` added to `path` (`-U0` hunks). Null on a git error. */
function historyRuns(git, from, notIn, path) {
  const r = git(['log', '--no-merges', '-p', '-U0', '--no-color', '--no-ext-diff', '--format=%x01', from, '--not', notIn, '--', path]);
  if (r.status !== 0) return null;
  const runs = [];
  let run = null;
  for (const l of String(r.stdout ?? '').split('\n')) {
    if (l.startsWith('+') && !l.startsWith('+++')) {
      if (!run) { run = []; runs.push(run); }
      run.push(l.slice(1));
    } else run = null;
  }
  return runs;
}

/** Per-file patch-ids of the non-merge commits in `from --not notIn` touching `path`. Null on a git error. */
function filePatchIds(git, from, notIn, path) {
  const revs = git(['rev-list', '--no-merges', from, '--not', notIn, '--', path]);
  if (revs.status !== 0) return null;
  const ids = [];
  for (const c of String(revs.stdout ?? '').split('\n').filter(Boolean)) {
    const d = git(['diff', '--no-color', '--no-ext-diff', `${c}^`, c, '--', path]);
    if (d.status !== 0) return null;
    const p = git(['patch-id', '--stable'], { input: String(d.stdout ?? '') });
    const id = String(p.stdout ?? '').trim().split(/\s+/)[0];
    if (p.status !== 0 || !id) return null;
    ids.push(id);
  }
  return ids;
}

/**
 * `git merge-file --object-id -p --diff3` with the exit SIGNAL kept: the shared runner maps a killed or timed-out
 * child to status 1 (= "one conflict"), so a truncated output could pass as a resolution. Only an un-signalled exit with
 * 1..127 conflicts and no spawn error is accepted.
 */
function mergeFile({ root, env, ours, base, theirs }) {
  const args = ['merge-file', '--object-id', '-p', '--diff3', '-L', 'overlay', '-L', 'base', '-L', 'main', ours, base, theirs];
  const r = spawnSync('git', ['-c', 'gc.auto=0', ...args], {
    cwd: root, env: { ...env, ...REBUILD_IDENTITY_ENV }, encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL', maxBuffer: 256 * 1024 * 1024,
  });
  return { ok: !r.error && r.signal == null && r.status >= 1 && r.status <= 127, stdout: r.stdout ?? '' };
}

/** `<mode> <sha> <stage>\t<path>` lines after merge-tree's tree line → {path → {1,2,3: {mode, sha}}}. */
function conflictStages(stdout) {
  const files = new Map();
  for (const l of String(stdout ?? '').split('\n').slice(1)) {
    const m = l.match(/^(\d{6}) ([0-9a-f]{40}) ([123])\t(.+)$/);
    if (!m) continue;
    if (!files.has(m[4])) files.set(m[4], {});
    files.get(m[4])[m[3]] = { mode: m[1], sha: m[2] };
  }
  return files;
}

/** Test files in `sha`'s tree that cover the given source files (same stem in an `__tests__` dir), capped. */
export function touchedTests(git, sha, files) {
  const ls = git(['ls-tree', '-r', '--name-only', sha]);
  if (ls.status !== 0 || !String(ls.stdout ?? '').trim()) return null;
  const all = String(ls.stdout ?? '').split('\n').filter((p) => /\/__tests__\/[^/]+\.test\.m?[jt]s$/.test(p));
  const out = new Set();
  for (const f of files) {
    if (/\/__tests__\/[^/]+\.test\.m?[jt]s$/.test(f)) { if (all.includes(f)) out.add(f); continue; }
    if (DOCS_CONFIG_RE.test(f)) continue;
    const stem = posix.basename(f).replace(/\.[^.]+$/, '');
    for (const t of all) {
      const b = posix.basename(t);
      if (b.startsWith(`${stem}.test.`) || b.startsWith(`${stem}-`)) out.add(t);
    }
  }
  return [...out].sort(); // round-3 audit: never truncated — every covering test runs
}

/**
 * IO (object DB only): build the refresh candidate = merge(last-good HEAD, origin/main) under the containment rule.
 * Never touches the clone's working tree, index or refs (a throwaway GIT_INDEX_FILE under the OS temp dir).
 * @param {{run:Function, root:string, env?:object, headSha:string, mainSha:string, registeredRefs:Iterable<string>}} o
 * @returns {{verdict:'clean'|'needs-human', candidate:string|null, headSha:string, mainSha:string, carried:string[],
 *   files:Array<{path:string, resolution:string, hunks?:object[]}>, unresolved:Array<{path:string, why:string, hunks?:object[]}>,
 *   tests:string[], reason?:string}}
 */
export function buildRefreshCandidate({
  run, root, env = process.env, headSha, mainSha, registeredRefs,
}) {
  const git = gitIO({ run, cwd: root, env });
  const base = {
    verdict: 'needs-human', candidate: null, headSha, mainSha, carried: [], files: [], unresolved: [], tests: [],
  };
  const fail = (reason, extra = {}) => ({ ...base, ...extra, reason });
  if (!FULL_SHA_RE.test(String(headSha)) || !FULL_SHA_RE.test(String(mainSha))) return fail('bad-input');
  // Identity scoping (edge case 5): the candidate may only carry overlays still registered on THIS clone.
  const scope = unregisteredCarried(git, headSha, mainSha, registeredRefs);
  if (!scope) return fail('git-failed: log');
  const carried = [...new Set(scope.merged.map((m) => m.ref))];
  if (scope.gone.length > 0) return fail(`overlay-no-longer-registered: ${scope.gone.join(', ')}`, { carried });
  base.carried = carried;

  const mt = git(['merge-tree', '--write-tree', '--no-messages', headSha, mainSha]);
  const mergedTree = String(mt.stdout ?? '').split('\n')[0].trim();
  if ((mt.status !== 0 && mt.status !== 1) || !FULL_SHA_RE.test(mergedTree)) return fail('git-failed: merge-tree');
  const stages = mt.status === 1 ? conflictStages(mt.stdout) : new Map();
  if (mt.status === 1 && stages.size === 0) return fail('merge-tree-conflict-without-content-stages');

  const files = [];
  const unresolved = [];
  const resolvedBlobs = [];
  for (const [path, st] of stages) {
    if (!st[1] || !st[2] || !st[3]) { unresolved.push({ path, why: 'add-delete-or-rename-conflict' }); continue; }
    if (st[2].mode !== st[3].mode || st[2].mode === '160000' || st[2].mode === '120000') { unresolved.push({ path, why: 'mode-or-link-conflict' }); continue; }
    const docsConfig = DOCS_CONFIG_RE.test(path);
    let patchIdCarried = false;
    if (docsConfig) {
      const ov = filePatchIds(git, headSha, mainSha, path);
      const mn = filePatchIds(git, mainSha, headSha, path);
      if (!ov || !mn) { unresolved.push({ path, why: 'git-failed: patch-id' }); continue; }
      patchIdCarried = ov.length > 0 && ov.every((id) => mn.includes(id));
    }
    const mf = mergeFile({ root, env, ours: st[2].sha, base: st[1].sha, theirs: st[3].sha });
    if (!mf.ok || String(mf.stdout ?? '').includes('\u0000')) { unresolved.push({ path, why: 'merge-file-failed-or-binary' }); continue; }
    // Content that already looks like a conflict marker in any side is never parsed (it could be mistaken for one).
    const sides = [st[1].sha, st[2].sha, st[3].sha].map((s) => git(['cat-file', 'blob', s]));
    if (sides.some((s) => s.status !== 0) || sides.some((s) => String(s.stdout ?? '').split('\n').some((l) => MARKER_RE.test(l)))) {
      unresolved.push({ path, why: 'marker-like-content' });
      continue;
    }
    const overlayRuns = docsConfig ? [] : historyRuns(git, headSha, mainSha, path);
    const mainRuns = docsConfig ? [] : historyRuns(git, mainSha, headSha, path);
    if (!overlayRuns || !mainRuns) { unresolved.push({ path, why: 'git-failed: history' }); continue; }
    const r = resolveFileHunks({
      diff3: String(mf.stdout ?? ''), overlayRuns, mainRuns, docsConfig, patchIdCarried,
    });
    if (!r.ok) { unresolved.push({ path, why: r.hunks.find((h) => h.why)?.why ?? 'unresolved', hunks: r.hunks }); continue; }
    if (r.text.split('\n').some((l) => MARKER_RE.test(l))) { unresolved.push({ path, why: 'markers-left' }); continue; }
    const tos = new Set(r.hunks.map((h) => h.to));
    files.push({ path, resolution: tos.size === 1 ? [...tos][0] : 'mixed', hunks: r.hunks });
    resolvedBlobs.push({ path, mode: st[2].mode, text: r.text });
  }
  base.files = files;
  base.unresolved = unresolved;
  base.tests = touchedTests(git, mainSha, [...stages.keys()]) ?? [];
  if (unresolved.length > 0) return { ...base, reason: `unresolved: ${unresolved.map((u) => u.path).join(', ')}` };

  let tree = mergedTree;
  if (resolvedBlobs.length > 0) {
    const tmp = mkdtempSync(join(tmpdir(), 'we-auto-refresh-'));
    try {
      const idxEnv = { GIT_INDEX_FILE: join(tmp, 'index') };
      if (git(['read-tree', mergedTree], { env: idxEnv }).status !== 0) return fail('git-failed: read-tree');
      for (const b of resolvedBlobs) {
        const h = git(['hash-object', '-w', '--stdin'], { input: b.text });
        const blob = String(h.stdout ?? '').trim();
        if (h.status !== 0 || !FULL_SHA_RE.test(blob)) return fail('git-failed: hash-object');
        if (git(['update-index', '--cacheinfo', `${b.mode},${blob},${b.path}`], { env: idxEnv }).status !== 0) return fail('git-failed: update-index');
      }
      const w = git(['write-tree'], { env: idxEnv });
      tree = String(w.stdout ?? '').trim();
      if (w.status !== 0 || !FULL_SHA_RE.test(tree)) return fail('git-failed: write-tree');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  const summary = files.map((f) => `${f.path}→${f.resolution}`).join(', ');
  const message = `daemon-rebuild: auto-refresh ${headSha} with main ${mainSha}${summary ? ` (resolved: ${summary})` : ''}`;
  // Round-3/4 audit: the parent dates are read ONCE here, a failed read is a git failure (never a 0 fallback), and the
  // validated values build the commit env directly — the same identity + "later parent's date" rule as rebuildCommitEnv.
  const dates = [];
  for (const sha of [headSha, mainSha]) {
    const d = git(['log', '-1', '--format=%ct', sha]);
    const n = Number(String(d.stdout ?? '').trim());
    if (d.status !== 0 || !Number.isInteger(n) || n <= 0) return fail('git-failed: commit-date');
    dates.push(n);
  }
  const date = `@${Math.max(...dates)} +0000`;
  const ct = git(['commit-tree', tree, '-p', headSha, '-p', mainSha, '-m', message], {
    env: { ...REBUILD_IDENTITY_ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
  const candidate = String(ct.stdout ?? '').trim();
  if (ct.status !== 0 || !FULL_SHA_RE.test(candidate)) return fail('git-failed: commit-tree');
  const brought = git(['diff', '--name-only', '--no-renames', headSha, candidate]);
  if (brought.status !== 0) return fail('git-failed: diff');
  const changed = [...new Set([...stages.keys(), ...String(brought.stdout ?? '').split('\n').filter(Boolean)])];
  const tests = touchedTests(git, candidate, changed);
  if (tests === null) return fail('git-failed: ls-tree');
  // 4. no conflict markers anywhere the refresh changes: a changed file may not carry more marker lines than either parent.
  const markers = markerFiles(git, candidate);
  if (markers === null) return fail('git-failed: marker-scan');
  if (markers.length > 0) return fail(`markers-left: ${markers.join(', ')}`, { files, unresolved: markers.map((p) => ({ path: p, why: 'markers-left' })), tests });
  // 2. WHOLE-FILE guard check (not only the conflict hunks): in every file BOTH sides changed, each guard fact a side
  //    INTRODUCED (absent from the merge base) must survive in the candidate — git's clean merge of the other hunks
  //    included. A side's own change is never silently relaxed by the other side.
  const lost = guardsLost(git, { headSha, mainSha, candidate });
  if (lost === null) return fail('git-failed: guard-check');
  if (lost.length > 0) {
    return fail(`guard-lost: ${lost.map((l) => `${l.path} (${l.facts.slice(0, 3).join(', ')})`).join('; ')}`, {
      files, unresolved: lost.map((l) => ({ path: l.path, why: `guard-lost: ${l.facts.slice(0, 4).join(', ')}` })), tests,
    });
  }
  return {
    ...base, verdict: 'clean', candidate, tests,
  };
}

/** A file's lines at `rev`: [] when the path is absent there, null on any git error (fail closed). */
function readLines(git, rev, p) {
  const ls = git(['ls-tree', rev, '--', p]);
  if (ls.status !== 0) return null;
  if (!String(ls.stdout ?? '').trim()) return [];
  const r = git(['cat-file', 'blob', `${rev}:${p}`]);
  return r.status === 0 ? String(r.stdout ?? '').split('\n') : null;
}

/** OPERATOR RULING (2026-10-20, round-4 finding 2): ANY conflict-marker line ANYWHERE in the candidate tree refuses the
 *  refresh — even one main itself already carries. Returns the files holding one, or null on a git error. */
export function markerFiles(git, candidate) {
  const r = git(['grep', '-I', '-l', '-E', '^(<{7}|[|]{7}|={7}|>{7})( |$)', candidate, '--']);
  if (r.status === 1) return [];
  if (r.status !== 0) return null;
  return String(r.stdout ?? '').split('\n').filter(Boolean).map((l) => l.slice(l.indexOf(':') + 1)).sort();
}

/**
 * Files whose candidate version lost a guard fact either parent holds. Null on a git error.
 * OPERATOR RULING (2026-10-20, round-3 finding 1 — BY DESIGN): for a file the overlay does not touch, MAIN is the
 * authority, exactly as in any normal rebuild (main + overlays): main's own changes there, a relaxed limit included,
 * are taken as-is and never guard-checked. Guard checks apply to every file the overlay changed (merge-base..last-good)
 * whose overlay content differs from main's: there each guard either parent holds must survive in the candidate.
 */
export function guardsLost(git, { headSha, mainSha, candidate }) {
  const mb = git(['merge-base', headSha, mainSha]);
  const baseSha = String(mb.stdout ?? '').trim();
  if (mb.status !== 0 || !FULL_SHA_RE.test(baseSha)) return null;
  const names = (a, b) => {
    const d = git(['diff', '--name-only', '--no-renames', a, b]);
    return d.status === 0 ? String(d.stdout ?? '').split('\n').filter(Boolean) : null;
  };
  const ov = names(baseSha, headSha);
  const mn = names(baseSha, mainSha);
  if (!ov || !mn) return null;
  const blobAt = (rev, p) => {
    const r = git(['ls-tree', rev, '--', p]);
    if (r.status !== 0) return undefined;
    return String(r.stdout ?? '').trim().split(/\s+/)[2] ?? null;
  };
  const out = [];
  for (const p of ov) {
    const hb = blobAt(headSha, p);
    const mbb = blobAt(mainSha, p);
    if (hb === undefined || mbb === undefined) return null;
    if (hb === mbb) continue; // overlay content equals main's: nothing of the overlay's to lose
    if (!mn.includes(p)) {
      // only the overlay changed it: a clean merge keeps the overlay's version — still verified, never assumed
      if (blobAt(candidate, p) === hb) continue;
    }
    const h = readLines(git, headSha, p);
    const m = readLines(git, mainSha, p);
    const c = readLines(git, candidate, p);
    if (!h || !m || !c) return null;
    // Round-2 audit: a guard either PARENT holds (inherited from the base or introduced) must survive in the candidate,
    // whichever side changed it — a deliberate relaxation on one side is a decision for a person, never auto-taken.
    const cf = guardFacts(c);
    const facts = [...new Set([...guardFacts(h), ...guardFacts(m)].filter((f) => !cf.has(f)))];
    if (facts.length > 0) out.push({ path: p, facts });
  }
  return out;
}

// ── record (one build per key, one check per candidate) ────────────────────────────────────────────────────────

export function autoRefreshRecordPath(root, env = process.env) {
  return join(stateDir(env), `${cloneKey(root)}.auto-refresh.json`);
}
export function readAutoRefreshRecord(root, env = process.env) {
  try { return JSON.parse(readFileSync(autoRefreshRecordPath(root, env), 'utf8')); } catch { return null; }
}
function writeAutoRefreshRecord(root, rec, env = process.env) {
  const p = autoRefreshRecordPath(root, env);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(rec, null, 2)}\n`);
  renameSync(tmp, p);
}

const short = (s) => String(s ?? '?').slice(0, 9);
/** PURE: the one-line decision the log carries. */
export function describeBuild(mode, b) {
  const resolved = b.files.map((f) => `${f.path}→${f.resolution}`).join(', ');
  const why = b.verdict === 'clean'
    ? (resolved ? `resolved ${resolved}` : 'merged clean')
    : (b.unresolved.length ? `needs-human: ${b.unresolved.map((u) => `${u.path} (${u.why})`).join('; ')}` : `needs-human: ${b.reason ?? '?'}`);
  return `auto-refresh candidate ${b.candidate ? short(b.candidate) : '(none)'} for ${short(b.headSha)} + main ${short(b.mainSha)}: ${b.verdict}; ${why}; tests ${b.tests.length ? b.tests.join(' ') : 'none'}; mode ${mode}${mode === 'shadow' ? ' — not adopted' : ''}`;
}

/**
 * LOCKED (called from prepareRebuild at the established-overlay hold): build — or reuse the recorded build for this
 * (HEAD, main) pair — log the decision once, and claim the off-lock check when this caller may run it.
 * Never throws: an error reads as needs-human and keeps the hold.
 * @returns {null|{mode:string, source:string, verdict:string, candidate:string|null, checkWanted:boolean, checkDue:boolean,
 *   tests:string[], headSha:string, mainSha:string, message:string}}
 */
export function autoRefreshAtHold({
  run, root, env = process.env, stEnv = env, headSha, mainSha, registeredRefs, alert = () => {}, now = () => Date.now(),
  canCheck = false, modeOf = resolveAutoRefreshMode,
}) {
  let mode;
  let source;
  try { ({ mode, source } = modeOf(env)); } catch { return null; }
  if (mode === 'off') return null;
  const key = `${headSha}:${mainSha}`;
  let rec = readAutoRefreshRecord(root, stEnv);
  if (!rec || rec.key !== key) {
    let built;
    try {
      built = buildRefreshCandidate({ run, root, env, headSha, mainSha, registeredRefs });
    } catch (e) {
      built = {
        verdict: 'needs-human', candidate: null, headSha, mainSha, carried: [], files: [], unresolved: [], tests: [], reason: `error: ${String(e?.message ?? e).split('\n')[0]}`,
      };
    }
    rec = { key, headSha, mainSha, builtAt: new Date(now()).toISOString(), build: built, check: null };
    const message = describeBuild(mode, built);
    alert('auto-refresh-candidate', {
      mode, source, verdict: built.verdict, candidate: built.candidate, headSha, mainSha, carried: built.carried.length,
      files: built.files.map((f) => ({ path: f.path, resolution: f.resolution })), unresolved: built.unresolved.map((u) => ({ path: u.path, why: u.why })),
      tests: built.tests, ...(built.reason ? { reason: built.reason } : {}), message,
    });
    try { writeAutoRefreshRecord(root, rec, stEnv); } catch { /* best-effort: the next tick rebuilds the same candidate */ }
  }
  const b = rec.build;
  // A cached build is re-scoped every tick: an overlay removed since it was built voids it (fail closed).
  if (b.verdict === 'clean') {
    let scope = null;
    try { scope = unregisteredCarried(gitIO({ run, cwd: root, env }), headSha, mainSha, registeredRefs); } catch { scope = null; }
    if (!scope || scope.gone.length > 0) {
      const reason = scope ? `overlay-no-longer-registered: ${scope.gone.join(', ')}` : 'git-failed: log';
      alert('auto-refresh-candidate-voided', { candidate: b.candidate, reason });
      rec.build = { ...b, verdict: 'needs-human', reason };
      try { writeAutoRefreshRecord(root, rec, stEnv); } catch { /* best-effort */ }
      return {
        mode, source, verdict: 'needs-human', candidate: b.candidate, checkWanted: false, checkDue: false, tests: b.tests, headSha, mainSha,
        message: describeBuild(mode, rec.build),
      };
    }
  }
  const claimAge = rec.check?.status === 'running' ? now() - Date.parse(rec.check.startedAt || 0) : 0;
  const promoteAge = rec.check?.promoting ? now() - Date.parse(rec.check.promoting.startedAt || 0) : Infinity;
  // Round-3 audit: ONE smoke + tests per candidate sha. A candidate that already passed in shadow is not checked again
  // when the mode turns on: the recorded pass is REUSED and only the registration step runs (inputs re-verified).
  const promote = mode === 'on' && rec.check?.status === 'passed' && rec.check.candidate === b.candidate
    && rec.check.mode !== 'on' && !rec.check.registered && promoteAge > AUTO_REFRESH_CHECK_CLAIM_MS;
  const checkWanted = b.verdict === 'clean' && !!b.candidate
    && (!rec.check || (rec.check.status === 'running' && claimAge > AUTO_REFRESH_CHECK_CLAIM_MS) || promote);
  let checkDue = false;
  let reuse = null;
  if (checkWanted && canCheck) {
    const by = `${process.pid}@${hostname()}`;
    const startedAt = new Date(now()).toISOString();
    if (promote) { reuse = { smoke: rec.check.smoke, tests: rec.check.tests, testsSummary: rec.check.testsSummary ?? null }; rec.check = { ...rec.check, promoting: { by, startedAt } }; } else rec.check = { status: 'running', mode, candidate: b.candidate, by, startedAt };
    try { writeAutoRefreshRecord(root, rec, stEnv); checkDue = true; } catch { checkDue = false; reuse = null; }
  }
  return {
    mode, source, verdict: b.verdict, candidate: b.candidate, checkWanted, checkDue, ...(reuse ? { reuse } : {}), tests: b.tests, headSha, mainSha,
    message: describeBuild(mode, b),
  };
}

// ── the off-lock check ─────────────────────────────────────────────────────────────────────────────────────────

/** The daemon's live smoke, run exactly once (one token refresh, one `runLiveSmoke`, no retry of any kind). */
export async function singleLiveSmoke({ root, env, changedFiles = null }) {
  const { env: runEnv } = await refreshSmokeGithubEnv({ env });
  const smoke = await runLiveSmoke({ root, env: runEnv, changedFiles });
  if (smoke.disabled) return { verdict: 'fail', attempts: 1, smoke, error: 'smoke gate disabled — not evidence' };
  return { verdict: decideSmokeVerdict(smoke.results) ? 'pass' : 'code', attempts: 1, smoke };
}

/** Default touched-tests runner: vitest on the candidate worktree through the host-wide heavy-admission queue. */
export function runTestsUnderAdmission({ cwd, files, env, timeoutMs = AUTO_REFRESH_TESTS_TIMEOUT_MS }) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [join(cwd, 'scripts', 'readiness', 'heavy-admission.mjs'), 'run', '--', 'npx', 'vitest', 'run', ...files], {
      cwd, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tail = '';
    const keep = (d) => { tail = (tail + d).slice(-4000); };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* gone */ } }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolveRun({ status: 'error', detail: String(e?.message ?? e) }); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const summary = (tail.match(/Tests?\s+[^\n]*\d+ (?:passed|failed)[^\n]*/g) || []).pop() ?? '';
      resolveRun({ status: code === 0 ? 'passed' : 'failed', code: code ?? signal, summary: summary.trim() });
    });
  });
}

/** ON mode: push the checked candidate as a NEW branch (never force) and register it as an overlay with a reason. */
export function registerRefreshedTop({
  run, root, env = process.env, candidate, headSha, mainSha, cloneKind,
}) {
  const git = gitIO({ run, cwd: root, env });
  const ref = `lane/auto-refresh-${String(cloneKind || 'clone').replace(/[^A-Za-z0-9-]/g, '-')}-${candidate.slice(0, 9)}`;
  const existing = git(['ls-remote', '--heads', 'origin', `refs/heads/${ref}`]);
  if (existing.status !== 0) return { ok: false, reason: 'ls-remote-failed' };
  const at = String(existing.stdout ?? '').trim().split(/\s+/)[0];
  if (at && at !== candidate) return { ok: false, reason: `branch ${ref} exists at a different sha` };
  if (!at) {
    const p = git(['push', 'origin', `${candidate}:refs/heads/${ref}`]);
    if (p.status !== 0) return { ok: false, reason: `push-failed: ${String(p.stderr ?? '').trim().split('\n')[0]}` };
  }
  const reason = `auto-refresh (xqz26k1): last-good ${headSha.slice(0, 9)} + main ${mainSha.slice(0, 9)}, smoke + touched tests passed`;
  const before = new Set((readOverlayState(root, { env }).overlays || []).map((o) => o?.ref));
  addOverlay(root, { ref, reason, addedBy: 'daemon-rebuild-auto-refresh' }, { env });
  // Round-2 audit: membership check and registration are not one atomic step, so re-scope AFTER the add: if an overlay
  // the candidate carries was removed in between, the refresh top is removed again (never left carrying it).
  const after = readOverlayState(root, { env });
  const scope = after.corrupt ? null : unregisteredCarried(git, headSha, mainSha, after.overlays || []);
  if (!scope || scope.gone.length > 0) {
    if (!before.has(ref)) removeOverlay(root, ref, { env, why: 'auto-refresh: a carried overlay left during registration' });
    return { ok: false, reason: scope ? `overlay-no-longer-registered: ${scope.gone.join(', ')}` : 'overlay-state-unreadable', rolledBack: !before.has(ref) };
  }
  appendOverlayEvent(root, { kind: 'auto-refresh-registered', ref, reason }, { env });
  return { ok: true, ref };
}

/**
 * UNLOCKED: smoke the claimed candidate on a disposable worktree, run its touched tests, record the verdict, and — only
 * in ON mode, only when everything passed and neither HEAD nor main moved meanwhile — register it. Never throws.
 */
export async function runAutoRefreshCheck({
  root, env = process.env, stEnv = env, run, runSmoke, log = console, now = () => Date.now(), ar,
  runTests = runTestsUnderAdmission, register = registerRefreshedTop,
}) {
  const nowIso = () => new Date(now()).toISOString();
  const alert = (kind, detail) => {
    log?.error?.(`daemon-rebuild: ${kind} ${JSON.stringify(detail)}`);
    try {
      const file = alertsFilePath(root, stEnv);
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `${JSON.stringify({ at: nowIso(), kind, detail })}\n`, 'utf8');
    } catch { /* best-effort */ }
  };
  const git = gitIO({ run, cwd: root, env });
  // Round-2 audit: exactly ONE smoke run per candidate. The daemon's retrying wrapper may re-run the whole smoke (transient,
  // env-timeout, auth paths), so the real default is replaced by one fresh-token `runLiveSmoke`; an injected smoke is used as-is.
  const smokeOnce = !runSmoke || runSmoke === runLiveSmokeWithRetry ? singleLiveSmoke : runSmoke;
  const cloneKind = posix.basename(root.replace(/\\/g, '/')) === 'code'
    ? posix.basename(posix.dirname(root.replace(/\\/g, '/'))) : posix.basename(root);
  const result = { smoke: 'not-run', tests: 'not-run', testsSummary: null, stale: false };
  const path = candidateWorktreePath(root, env, `auto-refresh-${randomBytes(4).toString('hex')}`);
  if (ar.reuse) Object.assign(result, ar.reuse); // the shadow pass of this exact sha: no second smoke or test run
  else try {
    const c = materializeCandidate({ root, sha: ar.candidate, run, env, path });
    if (!c.ok) result.smoke = `worktree-failed: ${c.reason}`;
    else {
      try {
        const smokeEnv = candidateSmokeEnv({ root, env });
        let s;
        try { s = await smokeOnce({ root: c.path, env: smokeEnv, changedFiles: null }); } catch (e) { s = { verdict: 'error', error: String(e?.message ?? e) }; }
        result.smoke = s?.verdict === 'pass' ? 'pass' : `fail${s?.smoke?.results ? `: ${s.smoke.results.filter((x) => !x.ok).map((x) => x.name).join(',')}` : ''}`;
        if (result.smoke === 'pass' && ar.tests.length > 0) {
          const t = await runTests({ cwd: c.path, files: ar.tests, env: smokeEnv });
          result.tests = t.status;
          result.testsSummary = t.summary ?? null;
        } else if (result.smoke === 'pass') result.tests = 'none';
      } finally {
        removeCandidate({ root, path: c.path, run, env });
      }
    }
  } catch (e) {
    result.smoke = `error: ${String(e?.message ?? e).split('\n')[0]}`;
  }
  // Edge case 6: the inputs moved while it was checked — discard (the next hold re-plans from the new pair).
  if (verifyRev(git, 'HEAD') !== ar.headSha || verifyRev(git, 'refs/remotes/origin/main^{commit}') !== ar.mainSha) result.stale = true;
  const passed = result.smoke === 'pass' && ['passed', 'none'].includes(result.tests) && !result.stale;
  let registered = null;
  if (passed && ar.mode === 'on') {
    // Re-scope right before publishing: an overlay removed during the off-lock check must never come back.
    const scope = unregisteredCarried(git, ar.headSha, ar.mainSha, readOverlayState(root, { env }).overlays || []);
    if (!scope || scope.gone.length > 0) registered = { ok: false, reason: scope ? `overlay-no-longer-registered: ${scope.gone.join(', ')}` : 'git-failed: log' };
  }
  if (passed && ar.mode === 'on' && !registered) {
    try { registered = register({ run, root, env, candidate: ar.candidate, headSha: ar.headSha, mainSha: ar.mainSha, cloneKind }); } catch (e) { registered = { ok: false, reason: String(e?.message ?? e) }; }
  }
  const rec = readAutoRefreshRecord(root, stEnv);
  if (rec && rec.key === `${ar.headSha}:${ar.mainSha}`) {
    rec.check = { status: passed ? 'passed' : 'failed', mode: ar.mode, candidate: ar.candidate, ...result, finishedAt: nowIso(), ...(registered ? { registered } : {}) };
    try { writeAutoRefreshRecord(root, rec, stEnv); } catch { /* best-effort */ }
  }
  const verdict = passed ? (ar.mode === 'on' ? (registered?.ok ? 'registered' : 'register-failed') : 'would-adopt') : 'not-adoptable';
  alert('auto-refresh-checked', {
    mode: ar.mode, candidate: ar.candidate, headSha: ar.headSha, mainSha: ar.mainSha, verdict, ...result, tests: ar.tests, testsResult: result.tests,
    ...(registered ? { registered } : {}),
    message: `auto-refresh candidate ${short(ar.candidate)}: ${verdict}; smoke ${result.smoke}; tests ${result.tests}${result.testsSummary ? ` (${result.testsSummary})` : ''}${result.stale ? '; inputs moved while checking — discarded' : ''}; mode ${ar.mode}${ar.mode === 'shadow' ? ' — not adopted' : ''}`,
  });
  return { verdict, ...result, ...(registered ? { registered } : {}) };
}
