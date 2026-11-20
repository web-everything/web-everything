/**
 * pr-merge-gate.mjs — the ONE place a `gh pr merge` to `main` may originate (#2290).
 *
 * INVARIANT: the drain is the SOLE writer to `main`. Every route that used to merge inline — `/pr`
 * (`pr-land.mjs`), `/finish` (`lane-resume.mjs`), `/merge` + `/drain` (`merge-ai-prs.mjs`) — now shells out
 * through THIS module, and only `caller === 'drain'` is allowed to actually merge. `/pr` and `/finish` instead
 * enqueue (label `ready-to-merge`) and trigger a single-couple drain pass, so a single serialized writer is the
 * only place that can safely assign the next NNN (the prerequisite for JIT numbering).
 *
 * BREAK-GLASS: an emergency unbreak-main can bypass the gate with `WE_MERGE_BREAK_GLASS=1` — a documented,
 * off-the-normal-path admin override that writes a LOUD audit line to stderr every time it is used, so a
 * non-drain merge is never silent.
 */
import { execFileSync } from 'node:child_process';
import { posix } from 'node:path';
import { configDefaults } from 'vitest/config';
import ts from 'typescript';
import micromatch from 'micromatch';
import { liveSuiteFiles, parseHermeticSettings, SETTINGS_PATH } from './hermetic-tests.mjs';

/** The `gh pr merge` method flag (default `--merge` = the --no-ff history the drain wants). Pure. */
export function mergeMethodFlag(method) {
  switch (method) {
    case 'squash': return '--squash';
    case 'rebase': return '--rebase';
    case 'merge':
    default: return '--merge';
  }
}

/** Build the `gh pr merge` argv the gate shells — mirrors the merge-ai-prs inline call exactly:
 *  `pr merge <n> [--repo <slug>] --<method> [--delete-branch] [--match-head-commit <sha>]`. `repo` null → the cwd
 *  repo (no --repo). `deleteBranch` defaults to true; false omits --delete-branch, leaving default argv
 *  byte-identical. `matchHeadCommit` null/empty → the flag is omitted (byte-identical to before this option
 *  existed — every pre-existing caller/test is unaffected). Pure.
 *
 * xvzc4v4 (merge-safety review, bug 1) — `--match-head-commit` is `gh`'s own guard against merging a commit
 * OTHER than the one just reviewed: the merge decision (labels, CI, mergeability) is read once at a pass's
 * START, but the actual `gh pr merge` call can run minutes later at the end of a serial cascade. A push, or a
 * `review:changes` a reviewer adds, in that window was previously invisible — the merge landed whatever head
 * happened to be live at merge time, not the one the decision was actually made about. Passing the head SHA
 * this same pass just re-confirmed makes `gh` itself refuse the merge (a real, server-side race check) if the
 * PR's head moved again between that re-confirmation and this exact call.
 */
export function buildGateMergeArgs({ pr, repo = null, method = 'merge', matchHeadCommit = null, deleteBranch = true }) {
  return ['pr', 'merge', String(pr), ...(repo ? ['--repo', repo] : []), mergeMethodFlag(method), ...(deleteBranch ? ['--delete-branch'] : []),
    ...(matchHeadCommit ? ['--match-head-commit', String(matchHeadCommit)] : [])];
}

/** Preserve the branch when any stacked PR failed to retarget. Pure. */
export function decideDeleteBranch({ retarget } = {}) {
  return !(retarget && Array.isArray(retarget.failed) && retarget.failed.length > 0);
}

/** Is the emergency break-glass override armed? (`WE_MERGE_BREAK_GLASS=1`.) */
function breakGlassArmed(env = process.env) {
  return env && env.WE_MERGE_BREAK_GLASS === '1';
}

/**
 * #2324 — every PR that lands must carry a non-empty description: PR #206 merged with an EMPTY body even
 * though `we:skills-src/pr/SKILL.md` already says a `--body-file` is required and `pr-land.mjs` never drops
 * a body — the rule existed as skill prose, never as an enforced gate. Shared here (not duplicated in
 * `pr-land.mjs` and `merge-ai-prs.mjs`) so BOTH land paths — the producer (`pr-land.mjs`, gates before
 * labelling) and the label lander (`merge-ai-prs.mjs`'s `classifyPr`, gates before merging) — refuse the
 * same class of bodyless PR the same way. Pure: true iff `body` has non-whitespace content.
 */
export function hasNonEmptyBody(body) {
  return typeof body === 'string' && body.trim().length > 0;
}

// ── Anti-test-gaming gate (#2440, slice C of epic #2410) ─────────────────────────────────────────────────
// The convergence loop lands a couple on a GREEN required check. A peer could manufacture that green by
// GAMING the tests rather than fixing the code: delete a failing test, `.skip`/`.only` it away, or shrink the
// case set so the surviving suite no longer covers the bug. Those are DETERMINISTIC, diff-visible tamper forms
// — this gate scans the PR's net diff for them and REFUSES the auto-land (the drain parks the couple
// `review:human`, so a human clears a genuine test removal rather than a script guessing intent).
//
// SCOPE (honest): this catches only what a DIFF proves — a removed/skipped/deleted test. True line-coverage %
// needs a coverage artifact the drain does not have, so "coverage drops" is enforced here in its diff-visible
// proxy (test cases / files removed net). The JUDGMENT half — does a logic fix carry a test that FAILS on the
// pre-change behaviour, is an edited assertion subtly weakened — is not script-decidable; it is the independent
// validator's explicit mandate (`buildValidatorMandate` in `review-core.mjs`), not this gate.

/** A test file: a `__tests__/` dir member, or a `*.test.*` / `*.spec.*` module (the repo's test convention). Pure. */
export function isTestPath(path) {
  return /(^|\/)__tests__\/|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(String(path || ''));
}

// A `.skip`/`.only` (or an `xit(`/`xdescribe(`/`fit(`/`fdescribe(`) marker — the two ways a test is disabled or
// narrowed-to so a failing sibling never runs. Anchored to the real test callees so it can't false-positive on
// ordinary code: `.skip`/`.only` count only on `it`/`test`/`describe` (never a variable named `context`/`suite`),
// and the bare Jasmine-style globals must be an invocation NOT preceded by a `.` or word char — so `model.fit(`,
// `fitAffineCost(`, and `object-fit` never match. `.todo` is deliberately NOT here: it marks an unwritten test,
// it does not hide a failing one. After `skip`/`only` we accept any of three tails so the parameterized and
// line-wrapped forms can't slip past (#2669): the plain `(` CALL (`it.skip('…')`); a `.each` chain
// (`it.skip.each([…])(…)` / `it.only.each\`…\``), which the old `\(`-only anchor let bypass the gate; and
// end-of-line (`it.skip` with its `(` wrapped to the next line — the diff is scanned per-line so the `(` isn't
// on this one). `skipSomething(` / `.only` mid-identifier still can't match (the tail must be `(`, `.each`, or EOL).
const SKIP_FOCUS_MARKER_RE = /\b(?:it|test|describe)\s*\.\s*(?:skip|only)\s*(?:\.\s*each\b|\(|$)|(?<![.\w])(?:xit|xdescribe|xtest|fit|fdescribe)\s*\(/;
// A test-case opener with a string title — `it('…'`, `test("…"` — used to COUNT cases so a net removal is
// detectable. The string-title requirement keeps a bare identifier named `test` from counting, and the leading
// `(?<![.\w])` (not preceded by a `.` or word char) keeps the `.test('literal')` METHOD-CALL form — an
// `expect(RE.test('sample')).toBe(true)` assertion in a `*.test.mjs` file — from counting as a case opener, so
// consolidating such assertions can't net a phantom removal that mis-parks the couple (#2669).
const TEST_CASE_OPENER_RE = /(?<![.\w])(?:it|test)\s*(?:\.\s*\w+\s*)?\(\s*['"`]/;

/**
 * A plain JS/TS source file — the only kind whose lines `stripStringsAndComments` may reason about. `.jsx`/`.tsx`
 * are deliberately EXCLUDED: JSX text (`<p>don't</p>`) is not JS-tokenised, so its apostrophes would pair as
 * string delimiters and could blank out a real marker; they are scanned raw. Pure.
 */
export function isStrippableTestPath(path) {
  return /\.[cm]?[jt]s$/.test(String(path || ''));
}

/**
 * Blank string contents and comments out of ONE added line so a skip/only marker that only appears inside a
 * fixture string or a comment (`"it.skip('x', …)"`, `// xit(`) stops counting (#5945, live #4717). Pure; it only
 * deletes characters, never evals or builds a regex from the input. Quotes are kept (`it.skip('x')` →
 * `it.skip('')` is still a marker).
 *
 * A per-added-line scan cannot know the lexical context the line starts in, so it fails closed to the ORIGINAL
 * line (scanned raw) whenever it cannot be sure: any backtick (a closer of a template opened on an earlier
 * line, or interpolation), an unterminated quote, a `/` that is not `//` or `/*` (a possible regex literal or
 * division), an unclosed block comment, a block-comment closer (`*` + `/`) with no opener on the line, or a `${`
 * (interpolation inside a template body). `scanTestTampering` also scans the line after a backslash-continued
 * line raw. Still a documented residual (card N1): a line that starts mid-block-comment, mid-template or
 * mid-continued-string whose opener is NOT visible on this line or the previous added line.
 * @param {string} line
 * @returns {string}
 */
export function stripStringsAndComments(line) {
  const s = String(line ?? '');
  if (s.includes('`') || s.includes('${')) return s;
  // A `*/` with no `/*` before it closes a block comment opened on an earlier line: the line starts INSIDE a
  // comment, so an apostrophe in that tail could pair with a later quote and swallow the real code after `*/`.
  const closer = s.indexOf('*/');
  if (closer !== -1 && (s.indexOf('/*') === -1 || s.indexOf('/*') > closer)) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < s.length && s[j] !== ch) j += s[j] === '\\' ? 2 : 1;
      if (j >= s.length) return s; // unterminated quote — unknown context, scan raw
      out += ch + ch;
      i = j;
    } else if (ch === '/') {
      if (s[i + 1] === '/') break; // line comment — drop the rest
      if (s[i + 1] !== '*') return s; // possible regex literal or division — scan raw
      const end = s.indexOf('*/', i + 2);
      if (end === -1) return s; // unclosed block comment — scan raw
      i = end + 1;
    } else out += ch;
  }
  return out;
}

/**
 * Parse a unified `git diff` into per-file added/removed CONTENT lines + a `deleted` flag. Pure. Only the diff
 * BODY matters here (not exact line numbers), so this is intentionally minimal: it keys files off the
 * `diff --git a/… b/…` header, notes `deleted file mode`, and buckets `+`/`-` content lines (skipping the
 * `+++`/`---` file headers and `@@` hunk markers). Good enough to detect test tampering; not a general patch lib.
 * @param {string} diffText
 * @returns {Array<{path:string|null, deleted:boolean, added:string[], removed:string[]}>}
 */
export function parseUnifiedDiff(diffText) {
  const files = [];
  let cur = null;
  for (const raw of String(diffText || '').split('\n')) {
    if (raw.startsWith('diff --git ')) {
      const m = raw.match(/ b\/(.+)$/);
      cur = { path: m ? m[1] : null, deleted: false, added: [], removed: [] };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (raw.startsWith('deleted file mode')) { cur.deleted = true; continue; }
    if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('@@')) continue; // headers/hunk markers, not content
    if (raw.startsWith('+')) cur.added.push(raw.slice(1));
    else if (raw.startsWith('-')) cur.removed.push(raw.slice(1));
  }
  return files;
}

/**
 * Scan a PR's net diff for DETERMINISTIC test-gaming — the tamper forms a diff proves. Pure. For each TEST file
 * in the diff it flags:
 *   - `test-file-removed`  — the whole test file was deleted.
 *   - `test-skipped`       — a `.skip`/`.only` (or `xit`/`fit`/…) marker was ADDED (a live test disabled/narrowed).
 *   - `tests-removed`      — net test CASES removed, excluding unambiguous, body-preserving moves in this diff.
 * Returns `{ tampered, findings, reasons }`, mirroring the manifest-tamper shape the drain's land loop already
 * consumes, so wiring it is a drop-in park. A clean diff (no test file, or only ADDED tests) → `tampered:false`.
 * @param {{diffText?:string, scored?:boolean, readFile?:(path:string, side:'base'|'head')=>string}} o  the two-tree net diff TEXT (`computeNetDiffText`, merge-ai-prs.mjs).
 * @returns {{tampered:boolean, findings:Array<{path:string,kind:string,detail:string}>, reasons:string[]}}
 */
export function scanTestTampering({ diffText = '', scored = true, readFile } = {}) {
  if (!scored || typeof diffText !== 'string' || !diffText.trim() || !/^diff --git /m.test(diffText)) {
    const detail = 'diff evidence is empty, unscored or unresolved; human review of full diff required';
    return { tampered: true, findings: [{ path: '(diff)', kind: 'test-evidence-unavailable', detail }],
      reasons: [`test-evidence-unavailable: ${detail}`] };
  }
  const findings = [];
  const files = parseUnifiedDiff(diffText);
  // Move evidence is deliberately stricter than ordinary same-file churn: complete parseable hunks,
  // static describe/title paths and identical complete callbacks and registration context (formatting/comments may differ).
  // Unknown evidence receives no credit: the existing HOLD asks a human to review the full diff.
  const records = { removed: new Map(), added: new Map() };
  let oversized = String(diffText).length > 1024 * 1024;
  let evidenceLimit = '1 MiB';
  const changedPaths = [...String(diffText).matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)].flatMap((m) => [m[1], m[2]]);
  let complete = !oversized && typeof readFile === 'function' && !changedPaths.some((path) =>
    /(?:^|\/)vitest[.-]|hermetic[^/]*settings|(?:^|\/)package\.json$|^\.github\/workflows\//.test(path));
  let include = [], exclude = [];
  try {
    // Parse data only. Never execute reviewed config; unknown spreads/expressions retain HOLD.
    const config = readFile('vitest.config.ts', 'head');
    if (typeof config !== 'string') throw new Error('unreadable config');
    if (config.length > 1024 * 1024) { oversized = true; throw new Error('oversized config'); }
    const tree = ts.createSourceFile('vitest.config.ts', config, ts.ScriptTarget.Latest, true);
    if (tree.parseDiagnostics.length) throw new Error('invalid config');
    const exports = tree.statements.filter(ts.isExportAssignment);
    if (exports.length !== 1 || exports[0].isExportEquals) throw new Error('unknown config export');
    let root = exports[0].expression;
    if (ts.isCallExpression(root) && root.expression.getText(tree) === 'defineConfig' && root.arguments.length === 1) root = root.arguments[0];
    if (!ts.isObjectLiteralExpression(root) || root.properties.some(ts.isSpreadAssignment)) throw new Error('dynamic config export');
    const tests = root.properties.filter((n) => ts.isPropertyAssignment(n) && n.name.getText(tree) === 'test');
    const test = tests.length === 1 ? tests[0].initializer : null;
    if (!test || !ts.isObjectLiteralExpression(test) || test.properties.some(ts.isSpreadAssignment)) throw new Error('missing or dynamic test config');
    const property = (name) => test.properties.filter((n) => ts.isPropertyAssignment(n) && n.name.getText(tree) === name);
    const globs = (name) => {
      const props = property(name);
      if (props.length !== 1 || !ts.isArrayLiteralExpression(props[0].initializer)) throw new Error('unknown globs');
      return props[0].initializer.elements.flatMap((n) => {
        if (ts.isStringLiteralLike(n)) return [n.text];
        if (name === 'exclude' && ts.isSpreadElement(n)) {
          if (n.expression.getText(tree) === 'configDefaults.exclude') return configDefaults.exclude;
          if (n.expression.getText(tree) === 'LIVE_SUITE') return liveSuiteFiles(parseHermeticSettings(readFile(SETTINGS_PATH, 'head')));
        }
        throw new Error('dynamic glob');
      });
    };
    include = globs('include'); exclude = [...configDefaults.exclude, ...globs('exclude')];
    // Every literal setup path, including conditional branches, is sensitive.
    const setup = new Set();
    function setupPaths(n, seen = new Set()) {
      if (ts.isStringLiteralLike(n)) { setup.add(posix.normalize(n.text)); return; }
      if (ts.isArrayLiteralExpression(n)) { for (const e of n.elements) setupPaths(e, seen); return; }
      if (ts.isSpreadElement(n) || ts.isParenthesizedExpression(n)) { setupPaths(n.expression, seen); return; }
      if (ts.isConditionalExpression(n)) { setupPaths(n.whenTrue, seen); setupPaths(n.whenFalse, seen); return; }
      if (ts.isIdentifier(n) && !seen.has(n.text)) {
        const declarations = [];
        function findDeclaration(node) {
          if (ts.isVariableDeclaration(node) && node.name.getText(tree) === n.text && node.initializer) declarations.push(node.initializer);
          ts.forEachChild(node, findDeclaration);
        }
        findDeclaration(tree);
        if (declarations.length === 1) { setupPaths(declarations[0], new Set([...seen, n.text])); return; }
      }
      throw new Error('unknown setup path');
    }
    for (const name of ['setupFiles', 'globalSetup']) for (const p of property(name)) setupPaths(p.initializer);
    if (changedPaths.some((p) => setup.has(p))) complete = false;
  } catch { complete = false; }
  const counts = { removed: new Map(), added: new Map() };
  const environments = { removed: new Map(), added: new Map() };
  const registrationPattern = /(?<![.\w])(?:it|test)\s*(?:\.\s*\w+\s*)*(?:\(|`)/;
  const printer = ts.createPrinter({ removeComments: true });
  const print = (n, tree) => printer.printNode(ts.EmitHint.Unspecified, n, tree);
  const signature = (fn, tree) => {
    const empty = ts.factory.createBlock([], true);
    const declaration = ts.isArrowFunction(fn)
      ? ts.factory.updateArrowFunction(fn, fn.modifiers, fn.typeParameters, fn.parameters, fn.type, fn.equalsGreaterThanToken, empty)
      : ts.factory.updateFunctionExpression(fn, fn.modifiers, fn.asteriskToken, fn.name, fn.typeParameters, fn.parameters, fn.type, empty);
    return print(declaration, tree);
  };
  const protectedNames = new Set(['it', 'test', 'describe', 'expect', 'vi']);
  const normalize = (s) => s.replace(/\s+/g, ' ').trim();
  const remember = (side, key, value) => {
    if (!records[side].has(key)) records[side].set(key, []);
    records[side].get(key).push(value);
  };
  const staticTitle = (node) => {
    if (node && ts.isStringLiteralLike(node)) return node.text;
    if (node && ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = staticTitle(node.left), right = staticTitle(node.right);
      if (left !== null && right !== null) return left + right;
    }
    return null;
  };
  function staticData(node) {
    if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) ||
        [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind)) return true;
    if (ts.isPrefixUnaryExpression(node) && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken].includes(node.operator))
      return ts.isNumericLiteral(node.operand);
    if (ts.isArrayLiteralExpression(node)) return node.elements.every(staticData);
    return ts.isObjectLiteralExpression(node) && node.properties.every((p) => ts.isPropertyAssignment(p) &&
      !ts.isComputedPropertyName(p.name) && staticData(p.initializer));
  }
  function collect(path, lines, side) {
    if (!lines.length) return;
    const text = lines.map((l) => l.text).join('\n');
    const tree = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    if (tree.parseDiagnostics.length) { complete = false; return; }
    const changed = new Set();
    let offset = 0;
    for (const line of lines) {
      if (line.changed) changed.add(offset);
      offset += line.text.length + 1;
    }
    // Reject protected bindings, except an inert, test-local const named `it` needed by #7140.
    let bindingsSafe = true;
    function binding(name) {
      if (ts.isIdentifier(name) && protectedNames.has(name.text)) bindingsSafe = false;
      else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name))
        for (const e of name.elements) if (ts.isBindingElement(e)) binding(e.name);
    }
    function bindings(n) {
      if (ts.isImportDeclaration(n)) {
        const c = n.importClause;
        if (c?.name) binding(c.name);
        if (c?.namedBindings && ts.isNamespaceImport(c.namedBindings)) binding(c.namedBindings.name);
        if (c?.namedBindings && ts.isNamedImports(c.namedBindings)) for (const e of c.namedBindings.elements) {
          if (protectedNames.has(e.name.text) && !(n.moduleSpecifier.text === 'vitest' &&
              (!e.propertyName || e.propertyName.text === e.name.text))) bindingsSafe = false;
        }
      } else if (ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n) ||
          ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n) || ts.isFunctionExpression(n)) {
        if (n.name) {
          let inertDataIt = false;
          if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'it' &&
              (n.parent.flags & ts.NodeFlags.Const)) {
            let fn = n.parent;
            while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
            if (fn && ts.isCallExpression(fn.parent) && /^(?:it|test)$/.test(fn.parent.expression.getText(tree))) {
              inertDataIt = true;
              const reads = (node) => {
                if (ts.isIdentifier(node) && node.text === 'it' && node !== n.name &&
                    !(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node &&
                      !['skip', 'only', 'each'].includes(node.parent.name.text) &&
                      !(ts.isCallExpression(node.parent.parent) && node.parent.parent.expression === node.parent))) inertDataIt = false;
                ts.forEachChild(node, reads);
              };
              reads(fn.body);
            }
          }
          if (!inertDataIt) binding(n.name);
        }
      }
      if ((ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
          ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
            [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(n.operator))) {
        const target = ts.isBinaryExpression(n) ? n.left : n.operand;
        function writes(n) {
          if (ts.isIdentifier(n) && protectedNames.has(n.text)) bindingsSafe = false;
          ts.forEachChild(n, writes);
        }
        writes(target);
      }
      ts.forEachChild(n, bindings);
    }
    bindings(tree);
    function unsafe(n) {
      if (ts.isCallExpression(n) && (/(?:^|\.)skip$|^vi\.hoisted$/.test(n.expression.getText(tree)) ||
          /^(?:Object\.(?:assign|defineProperty|defineProperties)|Reflect\.set)$/.test(n.expression.getText(tree)) &&
          n.arguments.some((a) => /^(?:globalThis|global|window)$/.test(a.getText(tree))))) bindingsSafe = false;
      if (ts.isElementAccessExpression(n) && /^(?:globalThis|global|window)$/.test(n.expression.getText(tree))) bindingsSafe = false;
      ts.forEachChild(n, unsafe);
    }
    unsafe(tree);
    function hiddenHook(n) {
      if (ts.isCallExpression(n) && /^(?:beforeEach|afterEach|beforeAll|afterAll|onTestFinished|vi\.(?:mock|hoisted|setConfig))$/.test(n.expression.getText(tree)) &&
          !ts.isExpressionStatement(n.parent)) bindingsSafe = false;
      ts.forEachChild(n, hiddenHook);
    }
    hiddenHook(tree);
    // The destination may only reuse statements already present in the source pre-image.
    // Token text preserves literal/module bytes; only trivia and comments are discarded.
    const literals = new Map();
    function literalRanges(n) {
      if (ts.isLiteralExpression(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
        literals.set(n.getStart(tree), n.end);
        if (registrationPattern.test(n.getText(tree)) &&
            (ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n))) complete = false;
      }
      ts.forEachChild(n, literalRanges);
    }
    literalRanges(tree);
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
    const tokens = [], directives = [];
    for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
      const start = scanner.getTokenPos();
      if (literals.has(start)) {
        const end = literals.get(start);
        tokens.push({ start, text: text.slice(start, end) });
        scanner.setTextPos(end);
      } else if (kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia) {
        // Treat all @ directives conservatively, including Vitest environment/options comments.
        if (/@[\w-]+/.test(scanner.getTokenText())) directives.push(normalize(scanner.getTokenText()));
      } else if (kind > ts.SyntaxKind.LastTriviaToken) tokens.push({ start, text: scanner.getTokenText() });
    }
    const statements = tree.statements.filter((n) => !(ts.isExpressionStatement(n) &&
      ts.isCallExpression(n.expression) && /^(?:describe|it|test)(?:\.|$)/.test(n.expression.expression.getText(tree))))
      .map((n) => tokens.filter((t) => t.start >= n.getStart(tree) && t.start < n.end).map((t) => t.text).join(' '));
    environments[side].set(path, { statements, directives: directives.join('\n') });
    function effects(container) {
      return container.statements.filter((n) => {
        // Initializers execute in order, including const initializers with side effects.
        if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n) || ts.isFunctionDeclaration(n)) return false;
        return !(ts.isExpressionStatement(n) && ts.isCallExpression(n.expression) &&
          /^(?:it|test|describe)(?:\.|$)/.test(n.expression.expression.getText(tree)));
      }).map((n) => print(n, tree));
    }
    function hasSuiteExit(node) {
      // Returns/throws in test callbacks or helper functions do not exit the enclosing suite.
      if (ts.isFunctionLike(node)) return false;
      if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) return true;
      return !!ts.forEachChild(node, hasSuiteExit);
    }
    function visit(node, parents = [], disabled = false, container = tree, context = effects(tree)) {
      // Count even unsupported registrations before refusing their evidence. Otherwise an
      // unknown title/table could disappear from removal accounting beside a valid move.
      if (ts.isCallExpression(node) && /^(?:it|test)\b/.test(node.expression.getText(tree))) {
        const start = tree.getLineStarts()[tree.getLineAndCharacterOfPosition(node.getStart(tree)).line];
        if (changed.has(start)) counts[side].set(path, (counts[side].get(path) || 0) + 1);
      }
      // Parameterized moves require a static table and the complete expression to match.
      const parameterized = ts.isCallExpression(node) && ts.isCallExpression(node.expression) &&
        /^(?:it|test)\.each$/.test(node.expression.expression.getText(tree));
      if (ts.isCallExpression(node) && (parameterized || /^(?:describe|it|test)(?:\.(?:skip|todo|only))?$/.test(node.expression.getText(tree)))) {
        if (!ts.isExpressionStatement(node.parent) || node.parent.parent !== container) { complete = false; return; }
        if (parameterized && (node.expression.arguments.length !== 1 ||
            !ts.isArrayLiteralExpression(node.expression.arguments[0]) || !staticData(node.expression.arguments[0]))) { complete = false; return; }
        const callee = node.expression.getText(tree);
        const [title, fn] = node.arguments;
        const titleText = staticTitle(title);
        if (titleText === null || !fn ||
            !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) { complete = false; return; }
        const key = [...parents, normalize(titleText)];
        // Calling a generator returns an iterator without running its assertions (or suite setup).
        const blocked = disabled || !bindingsSafe || !!fn.asteriskToken || (!parameterized && callee.includes('.')) || node.arguments.length !== 2 ||
          (parameterized && node.expression.arguments.length !== 1);
        if (callee.startsWith('describe')) {
          // Direct nesting alone does not prove registration: a prior (even conditional)
          // exit can leave declarations unreachable. Refuse credit throughout such a suite.
          const suiteBlocked = blocked || hasSuiteExit(fn.body);
          ts.forEachChild(fn.body, (child) => visit(child, [...key, signature(fn, tree)], suiteBlocked, fn.body, [...context, ...effects(fn.body)]));
          return;
        }
        const start = tree.getLineStarts()[tree.getLineAndCharacterOfPosition(node.getStart(tree)).line];
        // Compare parsed statements, not whitespace-stripped tokens: `return\nexpect(...)`
        // skips the assertion even though it has the same tokens as `return expect(...)`.
        const body = (parameterized ? print(node.expression, tree) : callee) + signature(fn, tree) + print(fn.body, tree);
        let assertions = 0;
        let trivial = false;
        function assertion(n) {
          if (ts.isCallExpression(n) && n.expression.getText(tree) === 'expect') {
            assertions++;
            const arg = n.arguments[0];
            if (!arg || ts.isLiteralExpression(arg) || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword,
              ts.SyntaxKind.NullKeyword].includes(arg.kind)) trivial = true;
          }
          ts.forEachChild(n, assertion);
        }
        assertion(fn.body);
        remember(side, JSON.stringify(key), { path, changed: changed.has(start),
          // Text/order equality does not make arbitrary relocated effects safe: e.g.
          // import.meta.url can select a different implementation in the destination.
          body, context: context.join('\n'), valid: !blocked && context.every((s) =>
            /^(?:beforeEach|afterEach|beforeAll|afterAll)\(/.test(s) || /^vi\.(?:mock|setConfig)\(/.test(s) ||
            /^process\.env\.WE_BOARD_NOW = NOW;?$/.test(s) || /^(?:const|let|var)\s/.test(s)) &&
            assertions > 0 && !trivial });
        return;
      }
      if (ts.isCallExpression(node) && /^(?:describe|it|test)\b/.test(node.expression.getText(tree))) {
        complete = false; // e.g. .each / computed titles: cannot prove unique case identity
        return;
      }
      ts.forEachChild(node, (child) => visit(child, parents, disabled, container, context));
    }
    visit(tree);
  }
  if (typeof readFile === 'function') {
    // Resolve both complete trees, but mark only changed opener lines as spendable.
    // Unchanged cases still participate in identity collision detection.
    let file = null, oldLine = 0, newLine = 0;
    const evidence = [];
    for (const line of String(diffText).split('\n')) {
      if (line.startsWith('diff --git ')) {
        const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
        file = match ? { base: match[1], head: match[2], absent: {}, baseLines: new Map(), headLines: new Map() } : null;
        if (file) evidence.push(file);
        else complete = false;
      } else if (file) {
        if (line === '--- /dev/null') file.absent.base = true;
        else if (line === '+++ /dev/null') file.absent.head = true;
        else if (line.startsWith('--- ') || line.startsWith('+++ ')) continue;
        else if (line.startsWith('@@')) {
          const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
          if (!match) { complete = false; continue; }
          oldLine = Number(match[1]); newLine = Number(match[2]);
        } else if (line.startsWith('-')) file.baseLines.set(oldLine++, line.slice(1));
        else if (line.startsWith('+')) file.headLines.set(newLine++, line.slice(1));
        else if (line.startsWith(' ')) { oldLine++; newLine++; }
      }
    }
    let evidenceSize = String(diffText).length;
    for (const f of evidence) {
      if (!complete || !isTestPath(f.head)) continue;
      try {
        for (const [side, bucket] of [['base', 'removed'], ['head', 'added']]) {
          const text = f.absent[side] ? '' : readFile(f[side], side);
          if (typeof text !== 'string') throw new Error('unreadable full file');
          evidenceSize += text.length;
          if (evidenceSize > 1024 * 1024) { oversized = true; throw new Error('oversized full-file evidence'); }
          const sourceLines = text.split('\n');
          for (const [number, expected] of f[`${side}Lines`]) {
            if (sourceLines[number - 1] !== expected) throw new Error('diff/tree mismatch');
          }
          collect(f.head, sourceLines.map((text, i) => ({ text, changed: f[`${side}Lines`].has(i + 1) })), bucket);
        }
      } catch { complete = false; } // No partial credit: retain the human HOLD on any failed read/parse.
    }
  }
  // A rejected move still owes an exact removal accounting: unrelated local additions
  // cannot erase it merely because no destination qualified for a credit.
  const moveSources = new Set();
  for (const [key, removed] of records.removed) {
    const destinations = new Set((records.added.get(key) || []).filter((r) => r.changed).map((r) => r.path));
    for (const a of removed) if (a.changed && (destinations.size > 1 ||
        destinations.size === 1 && !destinations.has(a.path))) moveSources.add(a.path);
  }
  const credits = new Map();
  if (complete && records.removed.size && records.added.size) {
    try {
      // Only credit destinations selected by the checked-in unit config. Integration-only / scheduled
      // suites conservatively retain HOLD; a filename alone is not evidence CI executes it.
      for (const [key, removed] of records.removed) {
        const added = records.added.get(key);
        if (removed.length !== 1 || added?.length !== 1) continue;
        const [a] = removed, [b] = added;
        if (!a.changed || !b.changed || a.path === b.path || !a.valid || !b.valid || a.body !== b.body || a.context !== b.context) continue;
        const source = environments.removed.get(a.path), destination = environments.added.get(b.path);
        if (!source || !destination || source.directives !== destination.directives ||
            destination.statements.some((statement) => !source.statements.includes(statement))) continue;
        if (!isTestPath(b.path) || /(^|\/)(?:node_modules|\.git|dist|coverage)(\/|$)/.test(b.path) ||
            !micromatch.isMatch(b.path, include) || micromatch.isMatch(b.path, exclude)) continue;
        credits.set(a.path, (credits.get(a.path) || 0) + 1);
      }
    } catch { /* Unreadable/unknown config: no move credits; retain human HOLD. */ }
  }
  const retained = new Map();
  if (complete && moveSources.size) {
    // Once moves are paired, only the same case identity can cancel a local removal.
    // Otherwise an unrelated addition can spend a second cancellation on a genuinely deleted case.
    for (const [key, removed] of records.removed) {
      const added = records.added.get(key);
      if (removed.length !== 1 || added?.length !== 1) continue;
      const [a] = removed, [b] = added;
      if (a.changed && b.changed && a.path === b.path && a.valid && b.valid && a.body === b.body && a.context === b.context) retained.set(a.path, (retained.get(a.path) || 0) + 1);
    }
  }
  for (const f of files) {
    if (!f.path || !isTestPath(f.path)) continue;
    if (f.deleted) {
      findings.push({ path: f.path, kind: 'test-file-removed', detail: 'a test file was deleted' });
      continue; // a delete has no surviving markers/cases to also flag
    }
    const jsFile = isStrippableTestPath(f.path); // non-JS files under __tests__/ are scanned raw (#5945 A4)
    // A line ending in an odd run of backslashes continues a quoted string onto the next added line, which then
    // starts INSIDE that string — so the line after one is scanned raw. (A continuation whose opener is an
    // unchanged context line outside the hunk's added lines is the documented residual, N1.)
    const skipAdds = f.added.filter((l, i) => {
      const continued = i > 0 && /(?<!\\)(?:\\\\)*\\$/.test(f.added[i - 1]);
      return SKIP_FOCUS_MARKER_RE.test(jsFile && !continued ? stripStringsAndComments(l) : l);
    }).length;
    if (skipAdds) findings.push({ path: f.path, kind: 'test-skipped', detail: `${skipAdds} skip/only marker(s) added` });
    const removedCases = f.removed.filter((l) => TEST_CASE_OPENER_RE.test(l)).length;
    const addedCases = f.added.filter((l) => TEST_CASE_OPENER_RE.test(l)).length;
    // Failed/oversized/non-static evidence cannot be cleared by balancing added lines.
    // Credits are spendable only against the declarations of their own source file.
    const netRemoved = !complete
      ? Math.max(removedCases, counts.removed.get(f.path) || 0, f.removed.filter((l) => registrationPattern.test(l)).length)
      : moveSources.size
        ? (counts.removed.get(f.path) || 0) - (retained.get(f.path) || 0) - (credits.get(f.path) || 0)
        : removedCases - addedCases;
    if (netRemoved > 0) findings.push({ path: f.path, kind: 'tests-removed', detail: `net ${netRemoved} test case(s) removed${oversized ? `; move evidence exceeds ${evidenceLimit}: human review of full diff required` : !complete ? '; incomplete or non-static move evidence: human review of full diff required' : ''}` });
  }
  const reasons = findings.map((x) => `${x.kind}: ${x.path} (${x.detail})`);
  return { tampered: findings.length > 0, findings, reasons };
}

/**
 * Is this PR's test-gaming signal (at least partly) INHERITED from an already-escalated stacked base, rather
 * than genuinely new to this PR? Live shape (web-everything/web-everything#2766/#2767, 2026-09-26): #2767 is opened
 * on top of #2766's own branch; #2766 rewrites its "property 4" tests (legitimately, per its own PR), and
 * because #2767 is stacked on it, `scanTestTampering` sees that SAME diff as part of #2767's own net diff too
 * and trips the identical `tests-removed` finding — a human reviewing #2767 cold has no way to know the
 * finding is #2766's, not #2767's own.
 *
 * PURE, and deliberately LABEL-AGNOSTIC — this module never imports `review-escalation.mjs`'s label helpers
 * (see the file header: it is the ONE place a `gh pr merge` may originate, kept free of that concern), so the
 * caller decides `baseAlreadyEscalated` itself (e.g. `hasReviewLabel(basePr.labels, REVIEW_LABELS.human)`) and
 * hands it in as a plain boolean.
 * @param {{findings?: Array<{path: string}>, baseFiles?: string[]|null, baseAlreadyEscalated?: boolean}} o -
 *   `findings` is THIS PR's own `scanTestTampering(...).findings`; `baseFiles` is the stacked base PR's own
 *   changed-file set (best-effort — whatever the caller already fetched this pass, never a new `gh` call
 *   here); `baseAlreadyEscalated` is whether the base PR is ITSELF already carrying `review:human`.
 * @returns {{sharedPaths: string[]}|null} the finding paths this PR shares with the base's own changed files,
 *   or `null` when there is no stacked-and-already-escalated base, or none of this PR's findings trace to it
 */
export function describeStackedTestGamingOrigin({ findings = [], baseFiles = null, baseAlreadyEscalated = false } = {}) {
  if (!baseAlreadyEscalated || !Array.isArray(baseFiles) || !baseFiles.length) return null;
  const baseSet = new Set(baseFiles);
  const sharedPaths = [...new Set(
    (Array.isArray(findings) ? findings : []).map((f) => f && f.path).filter((p) => p && baseSet.has(p)),
  )];
  return sharedPaths.length ? { sharedPaths } : null;
}

/**
 * Assert this caller MAY write to main, WITHOUT shelling a merge (used by non-gh write-to-main intents such as
 * pr-land's `--fallback-git` local `git merge`). `caller === 'drain'` always passes. Any other route THROWS
 * unless break-glass is armed — in which case it passes and emits the loud audit line. Returns
 * `{ breakGlass:boolean }`.
 * @param {{caller:string, pr?:(number|string|null), repo?:(string|null), env?:object, log?:{write:Function}}} o
 */
export function assertMayMerge({ caller, pr = null, repo = null, env = process.env, log = process.stderr } = {}) {
  if (caller === 'drain') return { breakGlass: false };
  if (!breakGlassArmed(env)) {
    throw new Error(
      `pr-merge-gate: only the drain may merge to main (route ${caller} is not the drain). ` +
      `Enqueue + trigger a drain pass instead. Break-glass: WE_MERGE_BREAK_GLASS=1 (logged).`,
    );
  }
  log.write(`pr-merge-gate: BREAK-GLASS merge by route=${caller} pr=${pr} repo=${repo || 'cwd'} — off the normal path\n`);
  return { breakGlass: true };
}

/**
 * The SOLE `gh pr merge` shell-out. Asserts the caller is the drain (or break-glass), then runs
 * `gh pr merge …`. Returns whatever `exec` returns (the merge-ai-prs inline call ignored the result and relied
 * on a throw for failure — preserved: the default `exec` is `execFileSync`, which throws on a non-zero gh exit).
 * `exec` is injectable so the gate is unit-testable without shelling gh.
 * @param {{pr:(number|string), repo?:(string|null), method?:string, matchHeadCommit?:(string|null), deleteBranch?:boolean, caller:string,
 *          exec?:Function, env?:object, log?:{write:Function}}} o
 */
export function mergePr({ pr, repo = null, method = 'merge', matchHeadCommit = null, deleteBranch = true, caller, exec = execFileSync, env = process.env, log = process.stderr } = {}) {
  assertMayMerge({ caller, pr, repo, env, log });
  return exec('gh', buildGateMergeArgs({ pr, repo, method, matchHeadCommit, deleteBranch }), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// ── #3383 — retarget a stacked PR BEFORE its base branch is deleted ────────────────────────────────────
//
// `mergePr` above defaults to merging with `--delete-branch` (also true if the repo has auto-delete-on-merge
// enabled). Left alone, a merge that deletes `headRef` orphans any OPEN PR whose OWN base is `headRef`
// (a PR stacked on top of the one landing now) — and GitHub's behaviour on a deleted base is to CLOSE
// that PR, never to retarget it. The #2578 incident: an approved, unmerged, entirely unrelated PR
// (`lane/x3ecgta-…`, based on `lane/3681-…`) was silently killed the instant `lane/3681-…`'s own PR
// (#2549) merged and its branch was deleted. The fix is to do the retarget FIRST, while the base branch
// still exists to retarget FROM — GitHub refuses both `pr edit --base` and reopen once a PR is closed by
// a vanished base (verified live during #2578's recovery), so this must run strictly before the merge.

/** The `gh pr list` argv that finds every OPEN PR stacked on `headRef` (i.e. its base). Scoped by
 *  `--base`, so this is a narrow, cheap listing — never a full-repo open-PR fan-out. Pure. */
export function buildStackedPrListArgs({ repo = null, headRef }) {
  return ['pr', 'list', '--state', 'open', '--base', String(headRef), ...(repo ? ['--repo', repo] : []), '--json', 'number,baseRefName'];
}

/** The `gh pr edit --base` argv that retargets ONE stacked PR onto `base` (the repo's default branch).
 *  Pure. */
export function buildRetargetArgs({ pr, repo = null, base }) {
  return ['pr', 'edit', String(pr), ...(repo ? ['--repo', repo] : []), '--base', String(base)];
}

/** gh pr list's default --limit (buildStackedPrListArgs passes none): a listing this long may be truncated. */
export const STACKED_PR_LIST_PAGE = 30;

/**
 * Retarget every OPEN PR based on `headRef` onto `defaultBranch`, BEFORE `headRef` is deleted by the merge
 * that is about to happen. Best-effort throughout, by design: a `gh` miss here (listing or an individual
 * edit) must never block the merge itself — the merge landing is the invariant that matters, and a missed
 * retarget is still recoverable by hand (or the #3383 recovery sweep for a PR GitHub already closed),
 * while a merge blocked on this side-effect is not. `exec` is injectable so this is unit-testable without
 * shelling `gh`.
 * @param {{repo?:(string|null), headRef:string, defaultBranch:string, exec?:Function, onRetarget?:Function, onFailed?:Function}} o
 * xym8nt4 — `listed` says whether the listing is COMPLETE evidence of what is stacked: false when it threw, was not an
 * array, may be truncated (a full default `gh pr list` page) or had a row without a number. The drain ignores it (the
 * merge must still land); a caller that would orphan a child by closing `headRef` (card-group source close) refuses.
 * @returns {{retargeted:number[], failed:number[], listed:boolean}}
 */
export function retargetStackedPrs({ repo = null, headRef, defaultBranch, exec = execFileSync, onRetarget = () => {}, onFailed = () => {} } = {}) {
  const retargeted = [];
  const failed = [];
  let stacked;
  try {
    const out = exec('gh', buildStackedPrListArgs({ repo, headRef }), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    stacked = JSON.parse(String(out || '[]').trim() || '[]');
  } catch { return { retargeted, failed, listed: false }; } // listing miss — nothing to safely act on, never blocks the merge
  if (!Array.isArray(stacked)) return { retargeted, failed, listed: false };
  let listed = stacked.length < STACKED_PR_LIST_PAGE;
  for (const s of stacked) {
    const num = s && s.number;
    if (num == null) { listed = false; continue; }
    try {
      exec('gh', buildRetargetArgs({ pr: num, repo, base: defaultBranch }), { stdio: ['ignore', 'ignore', 'pipe'] });
      retargeted.push(num);
      onRetarget(num);
    } catch {
      failed.push(num);
      onFailed(num);
    }
  }
  return { retargeted, failed, listed };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// LEDGER GATE (plan slice I1 of #verdict-ledger-pr-state-store). PURE. NOT CALLED BY THE LIVE MERGE PATH.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The accepted `mergeGate.reviewAuthority` values. Mirrors `PLATFORM_MERGE_GATE_DEFAULTS` in config/platformDefaults.ts (a test pins it). */
export const REVIEW_AUTHORITIES = Object.freeze(['labels', 'both', 'ledger']);
export const DEFAULT_REVIEW_AUTHORITY = 'labels';

/**
 * Would the ledger let this PR merge? Pure; never throws.
 *   - `labels`: today's behaviour EXACTLY. The ledger is not consulted (not even if unreadable); the label answer stands.
 *   - `both`:   clears only when the labels AND the ledger clear. Strictly tighter than `labels`.
 *   - `ledger`: the label input is dropped (a loosening; the statute gates moving the setting here).
 *   - any other value is treated as `both` (the stricter reading), never as `ledger`.
 * An unreadable ledger (`folded` / `derived` null, `folded.unreadable`, a `ledger-unreadable` hold, or `derived.holds`
 * present but not an array) DEFERS with a reason; unreadable is a hold, never "empty". An otherwise-clearing result also
 * DEFERS (`ledger-head-unverifiable`) unless the live head is a non-empty string and, for a verdict-backed clearance, the
 * verdict's coverage head is a non-empty string equal to it. The one exception: a derived review exemption (no current
 * verdict) needs only the usable live head — `derivePrState` already validated it against that head.
 *
 * @param {object} o
 * @param {object|null} o.folded The PR's folded ledger entry (`foldVerdictLedger(...).get(pr)`), or null/`{unreadable:true}`.
 * @param {object|null} o.derived `derivePrState(...)` output ({clears, holds}), or null.
 * @param {{sha?:string}|string|null} [o.head] The live head; a bearing verdict covering a different sha does not clear.
 * @param {boolean} o.labelsClear What the label gate says today.
 * @param {string} [o.authority] `mergeGate.reviewAuthority`.
 * @returns {{clear:boolean, defer:boolean, authority:string, reason:string}}
 */
export function decideLedgerGate({ folded = null, derived = null, head = null, labelsClear = false, authority = DEFAULT_REVIEW_AUTHORITY } = {}) {
  if (authority === 'labels') {
    return { clear: labelsClear === true, defer: false, authority, reason: labelsClear === true ? 'labels clear (ledger not consulted)' : 'labels hold' };
  }
  const mode = authority === 'ledger' ? 'ledger' : 'both';
  const ledger = ledgerVerdict({ folded, derived, head });
  if (ledger.defer) return { clear: false, defer: true, authority: mode, reason: ledger.reason };
  if (mode === 'both' && labelsClear !== true) return { clear: false, defer: false, authority: mode, reason: 'labels hold' };
  return { clear: ledger.clear, defer: false, authority: mode, reason: ledger.reason };
}

const nonEmptyString = (v) => typeof v === 'string' && v.length > 0;

function ledgerVerdict({ folded, derived, head }) {
  // `holds` is evidence: undefined keeps the empty default, any other non-array (null, string, object, number) is unreadable.
  const holds = derived?.holds === undefined ? [] : derived?.holds;
  const unreadable = !folded || !derived || folded.unreadable === true || derived.unreadable === true
    || !Array.isArray(holds) || holds.some(h => h?.code === 'ledger-unreadable');
  if (unreadable) return { clear: false, defer: true, reason: 'ledger-unreadable: deferring, an unreadable ledger is a hold' };
  if (holds.length) return { clear: false, defer: false, reason: `ledger holds: ${holds.map(h => h?.code ?? 'unknown').join(', ')}` };
  const exempt = !folded.current && derived.reviewExempt === true;
  if ((folded.clears !== true && !exempt) || derived.clears !== true) return { clear: false, defer: false, reason: 'ledger does not clear' };
  // A clearance needs a usable live head; a verdict-backed one also needs the verdict's coverage head. Reasons are fixed
  // text: a malformed value is never echoed. A valid review exemption has no verdict, so no coverage to require.
  const sha = typeof head === 'string' ? head : head?.sha;
  const covered = folded.current?.coverage?.headSha;
  if (!nonEmptyString(sha) || (!exempt && !nonEmptyString(covered))) {
    return { clear: false, defer: true, reason: 'ledger-head-unverifiable: deferring, the live head or the verdict coverage head is missing' };
  }
  if (!exempt && sha !== covered) return { clear: false, defer: false, reason: `ledger clearance covers ${covered}, head is ${sha}` };
  return { clear: true, defer: false, reason: exempt ? 'ledger clears (review-exempt at this head)' : 'ledger clears' };
}
