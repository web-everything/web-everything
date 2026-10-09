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
 *      and config files ({@link isGateFile}). A change to the gate itself is never trusted to judge itself;
 *   2. a changed code file sits under a directory-discovered fixture root (`hitsGlobEdge`): those edges are not
 *      imports, so the import graph cannot see them;
 *   3. main changed a file the PR also changed;
 *   4. a file main changed reaches a file the PR changed (imports followed transitively, through unchanged modules,
 *      read at the main tip), or a file the PR changed reaches a file main changed (read at the PR head). Through the
 *      repo's own import parser (we:scripts/lib/related-test-selection.mjs, the same one the local gate's test
 *      selection uses). NOT covered, by design: a third unchanged file that imports both sides (shared importer) and
 *      data read through `fs` rather than imported (other than declared settings, rule 1) — filed as card x0e6tik;
 *   5. an import list could not be read, or a closure is larger than {@link MAX_CLOSURE_FILES} — fail closed.
 *   Main changes under `nonCodePaths` (docs, backlog cards) never count, as in `any-code`.
 *
 * IO ({@link readAffectedFacts}): reads file contents with `git show <sha>:<path>` in the drain's own clone,
 *   fetching the two commits from `origin` when absent. A clone that cannot produce them (another repo, offline)
 *   fails closed: affected.
 */
import { execFileSync } from 'node:child_process';
import { isGraphSourceFile, resolvedImportsOf } from './related-test-selection.mjs';
import { hitsGlobEdge, isLocalFullSuiteTrigger } from '../readiness/test-selection.mjs';

/** `any-code`: today's middle ground — any main code change re-tests. `affected`: only a change that can reach the PR. */
export const RETEST_MODES = Object.freeze(['any-code', 'affected']);
export const DEFAULT_RETEST_MODE = 'affected';
/** More changed files than this on either side ⇒ do not walk them; re-test (bounded IO, fail closed). */
export const MAX_GRAPH_FILES = 400;
/** A forward import closure that visits more files than this is not walked to the end; re-test (bounded IO, fail closed). */
export const MAX_CLOSURE_FILES = 1500;
/** Wall-clock budget for one PR's graph reads (one `git show` spawn per file, ~20 ms each); past it, re-test. */
export const MAX_GRAPH_MS = 25_000;

/** The gate itself: a change here always re-tests (operator constraint). Repo-relative path patterns. */
export const GATE_PATTERNS = Object.freeze([
  /^scripts\/merge-ai-prs\.mjs$/,
  /^scripts\/lib\/merge-(queue|freshness)[\w-]*\.mjs$/,
  /^scripts\/lib\/related-test-selection\.mjs$/,
  /^scripts\/readiness\/test-selection\.mjs$/,
  /^scripts\/ci\//,
  /^scripts\/settings\//, // declared settings (merge-queue rules, …) are read as data, not imported: no edge shows it
  /^\.github\//,
  /^\.githooks\//,
]);

/** PURE. Is this path part of the merge gate or the test infrastructure? */
export function isGateFile(path) {
  const p = String(path ?? '');
  if (!p) return true;
  return GATE_PATTERNS.some((re) => re.test(p)) || isLocalFullSuiteTrigger(p);
}

const isNonCode = (file, patterns) => patterns.some((p) => (p.endsWith('/') ? file.startsWith(p) : file === p));

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
export function decideAffected({ prFiles = [], mainFiles = [], nonCodePaths = ['backlog/', 'docs/'], importsOf }) {
  const pr = [...new Set(prFiles.filter(Boolean))];
  const prSet = new Set(pr);
  const mainCode = [...new Set(mainFiles.filter(Boolean))].filter((f) => !isNonCode(f, nonCodePaths));
  const done = (affected, reasons) => ({ affected, reasons, mainCodeFiles: mainCode.length });
  if (!mainCode.length) return done(false, ['main-gained-no-code']);
  const gate = [...mainCode, ...pr].find(isGateFile);
  if (gate) return done(true, [`gate-touched:${gate}`]);
  const glob = [...mainCode, ...pr.filter((f) => !isNonCode(f, nonCodePaths))].find(hitsGlobEdge);
  if (glob) return done(true, [`glob-edge:${glob}`]);
  const same = mainCode.find((f) => prSet.has(f));
  if (same) return done(true, [`same-file:${same}`]);
  if (mainCode.length > MAX_GRAPH_FILES || pr.length > MAX_GRAPH_FILES) return done(true, ['too-many-files']);
  // Targets include main's docs/backlog files too: a PR file that imports one is coupled to it. Only ROOTS skip non-code.
  const mainSet = new Set(mainFiles.filter(Boolean));
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
  return done(false, ['main-delta-unaffected']);
}

function gitRunner(root) {
  return (args, opts = {}) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: 60_000, ...opts });
}

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
export function readAffectedFacts({ root = process.cwd(), num = null, headSha, tipSha, prFiles, mainFiles, nonCodePaths, git = gitRunner(root), budgetMs = MAX_GRAPH_MS }) {
  const t0 = Date.now();
  const out = (r) => ({ ...r, ms: Date.now() - t0 });
  // Cheap first: no IO when the pure rule already answers without the graph.
  const pre = decideAffected({ prFiles, mainFiles, nonCodePaths, importsOf: () => [] });
  if (pre.affected || pre.reasons[0] === 'main-gained-no-code') return out(pre);
  if (!headSha || !tipSha) return out({ ...pre, affected: true, reasons: ['shas-unknown'] });
  try {
    const missing = [headSha, tipSha].filter((s) => !hasCommit(git, s));
    if (missing.length) {
      try { git(['fetch', '--quiet', '--no-tags', 'origin', ...missing]); } catch { /* try the PR ref below */ }
      if (num && !hasCommit(git, headSha)) { try { git(['fetch', '--quiet', '--no-tags', 'origin', `refs/pull/${Number(num)}/head`]); } catch { /* checked below */ } }
      const still = [headSha, tipSha].filter((s) => !hasCommit(git, s));
      if (still.length) return out({ ...pre, affected: true, reasons: [`commits-unavailable:${still.map((s) => s.slice(0, 9)).join(',')}`] });
    }
    const fileSet = new Set(String(git(['ls-tree', '-r', '--name-only', tipSha])).split('\n').filter(Boolean));
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
    return out(decideAffected({ prFiles, mainFiles, nonCodePaths, importsOf }));
  } catch (e) {
    return out({ ...pre, affected: true, reasons: [`graph-read-failed:${String(e?.message ?? e).split('\n')[0].slice(0, 120)}`] });
  }
}
