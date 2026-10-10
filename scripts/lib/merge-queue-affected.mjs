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
 *   computed path — card x0e6tik.
 *   Changes under `nonCodePaths` (docs, backlog cards) never count, as in `any-code`.
 *
 * IO ({@link readAffectedFacts}): reads file contents with `git show <sha>:<path>` in the drain's own clone,
 *   fetching the two commits from `origin` when absent. Rule 5 reads the whole tip tree in ONE `git cat-file --batch`
 *   spawn, once per tip sha (shared by every PR judged against that tip), and only when rules 1-4 left the PR open. A clone that cannot produce them (another repo, offline)
 *   fails closed: affected.
 */
import { execFileSync } from 'node:child_process';
import { isGraphSourceFile, relativeSpecifierBases, resolvedImportsOf, specifierBasesResolvingTo } from './related-test-selection.mjs';
import { hitsGlobEdge, isLocalFullSuiteTrigger, isTestFile } from '../readiness/test-selection.mjs';

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
  /^scripts\/settings\//, // declared settings (merge-queue rules, …) are read as data, not imported: no edge shows it
  /^\.github\//,
  /^\.githooks\//,
]);

/** Root-level vitest entry files (`vitest.config.ts`, `vitest.setup.ts`, `vitest.globalSetup.mjs`, `vitest.<suite>.config.ts`, …): loaded for every test file, imported by none. */
const TEST_INFRA_ENTRY_RE = /^vitest\.[\w.-]+\.(?:ts|mts|js|mjs|cjs)$/;

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
export function decideAffected({ prFiles = [], mainFiles = [], nonCodePaths = ['backlog/', 'docs/'], importsOf, importersOf }) {
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
export function readAffectedFacts({ root = process.cwd(), num = null, headSha, tipSha, prFiles, mainFiles, nonCodePaths, git: injectedGit, budgetMs = MAX_GRAPH_MS, maxReverseFiles = MAX_REVERSE_FILES, tipGraphCache }) {
  const git = injectedGit ?? gitRunner(root);
  // The real runner shares tip graphs across PRs of one drain pass; an injected git (a test's fake tree) never does.
  const cache = tipGraphCache ?? (injectedGit ? new Map() : SHARED_TIP_GRAPHS);
  const t0 = Date.now();
  const out = (r) => ({ ...r, ms: Date.now() - t0 });
  // Cheap first: no IO when the pure rule already answers without the graph.
  const pre = decideAffected({ prFiles, mainFiles, nonCodePaths, importsOf: () => [], importersOf: () => [] });
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
    const verdict = decideAffected({ prFiles, mainFiles, nonCodePaths, importsOf, importersOf });
    return out(graphFailure ? { ...verdict, affected: true, reasons: [graphFailure] } : verdict);
  } catch (e) {
    return out({ ...pre, affected: true, reasons: [`graph-read-failed:${String(e?.message ?? e).split('\n')[0].slice(0, 120)}`] });
  }
}
