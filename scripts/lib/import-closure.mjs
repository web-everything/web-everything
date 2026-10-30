/**
 * @file scripts/lib/import-closure.mjs
 * @description #4044 — a script's STATIC import closure (relative `import`/`export … from`/literal `import('…')`),
 *   so the daemon machinery can tell whether a tree move touched code a given process or check actually runs:
 *   `daemon-self-sync.mjs` (restart only when the daemon's own imports changed) and `daemon-live-smoke.mjs`
 *   (re-run a tree-code check only when the code it exercises changed since the last live-verified build).
 *   Its own module so both can import it without a cycle (self-sync already imports the smoke).
 */

import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve as resolvePath, relative, isAbsolute, basename } from 'node:path';
import ts from 'typescript';

const JSON_LITERAL_RE = /['"`]([^'"`\n]*\.json)['"`]/g;
export const PARSEABLE_CODE_RE = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
export const MAX_SPAWN_HOPS = 64;
const literal = node => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));
const callName = node => ts.isIdentifier(node) ? node.text
  : ts.isPropertyAccessExpression(node) ? node.name.text
    : ts.isElementAccessExpression(node) && literal(node.argumentExpression) ? node.argumentExpression.text : null;
const LAUNCH_NAMES = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];
const READ_NAMES = ['readFile', 'readFileSync', 'open', 'openSync', 'readdir', 'readdirSync'];
const CAPABILITY_MODULES = new Set(['fs', 'fs/promises', 'child_process', 'worker_threads', 'module', 'vm']);
const capabilityModule = spec => CAPABILITY_MODULES.has(spec.replace(/^node:/, ''))
  ? spec.replace(/^node:/, '') : null;

// A loader capability's reach is opaque as soon as it is referenced, before aliases,
// destructuring or inherited process settings can hide the eventual execution edge.
// Strict scoping refuses the whole closure; the legacy walks remain independent.
const OPAQUE_LOADER_NAMES = new Set(['module', 'createRequire', 'eval', 'Function', 'mainModule',
  '_load', '_resolveFilename', 'getBuiltinModule', 'binding', '_linkedBinding', 'dlopen',
  'loadEnvFile', 'execArgv', 'NODE_OPTIONS']);
const opaqueLoaderReference = node => (ts.isIdentifier(node) && OPAQUE_LOADER_NAMES.has(node.text))
  || (literal(node) && (OPAQUE_LOADER_NAMES.has(node.text)
    || /--(?:require|import|loader|experimental-loader)\b/.test(node.text)))
  || (ts.isNewExpression(node) && callName(node.expression) === 'Function');
const opaqueLoaderSpecifier = spec => /^(?:(?:data|file|https?):|(?:node:)?(?:module|vm|test)$)/i.test(spec);

// Comments in loader arguments are deliberately outside the exclusion proof grammar.
// Use syntax tokens, not per-loader regular expressions (comment-like string data is safe).
function loaderHasComments(source, node) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard,
    source, undefined, node.expression.end, node.end - node.expression.end);
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) return true;
  }
  return false;
}

// Provenance is rooted in module bindings, never in an enumeration of their exports.
// An escaped binding is already unknown at its source: aliases, destructuring, callbacks,
// spreads and computed members need no optimistic downstream alias inference.
function moduleCapabilities(tree, resolveLaunch) {
  const bindings = new Map(), declarations = new Set();
  let complete = true, opaqueReads = false;
  const filesystem = module => module === 'fs' || module === 'fs/promises';
  const bind = (identifier, module, member = null) => {
    bindings.set(identifier.text, { module, member });
    declarations.add(identifier);
  };
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement) || !literal(statement.moduleSpecifier)) continue;
    const module = capabilityModule(statement.moduleSpecifier.text);
    if (!module) continue;
    // All filesystem exports may select repository content, including future exports.
    // Preserve the existing opaque-read fallback even if the binding escapes this file.
    if (filesystem(module)) opaqueReads = true;
    const clause = statement.importClause;
    if (clause?.name) bind(clause.name, module);
    if (clause?.namedBindings) {
      if (ts.isNamespaceImport(clause.namedBindings)) bind(clause.namedBindings.name, module);
      else for (const binding of clause.namedBindings.elements) {
        bind(binding.name, module, (binding.propertyName || binding.name).text);
        if (binding.propertyName) declarations.add(binding.propertyName);
      }
    }
  }
  const visit = node => {
    // require/import-equals, re-exports and dynamic imports are also module origins.
    const spec = ts.isCallExpression(node)
      && (callName(node.expression) === 'require' || node.expression.kind === ts.SyntaxKind.ImportKeyword)
      ? node.arguments[0]
      : ts.isExternalModuleReference(node) ? node.expression
        : ts.isExportDeclaration(node) ? node.moduleSpecifier : null;
    const module = literal(spec) && capabilityModule(spec.text);
    if (module) {
      if (filesystem(module)) opaqueReads = true;
      else complete = false; // The resulting namespace/resolver can escape arbitrarily.
    }
    if (ts.isIdentifier(node) && !declarations.has(node) && bindings.has(node.text)) {
      const origin = bindings.get(node.text);
      if (!filesystem(origin.module)) {
        let target = node, member = origin.member;
        const parent = node.parent;
        if (member === null && ((ts.isPropertyAccessExpression(parent) && parent.expression === node)
          || (ts.isElementAccessExpression(parent) && parent.expression === node && literal(parent.argumentExpression)))) {
          target = parent;
          member = callName(parent);
        }
        // This is the only positively modeled operation. Unknown exports and every
        // other use (including constructors) refuse; unknown exports are never harmless.
        const call = target.parent;
        if (!(origin.module === 'child_process' && LAUNCH_NAMES.includes(member)
          && ts.isCallExpression(call) && call.expression === target
          && knownLaunch(call, member, resolveLaunch))) complete = false;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return { complete, opaqueReads };
}

function nonShellOptions(options) {
  if (!options) return true;
  if (!ts.isObjectLiteralExpression(options)) return false;
  // Unknown keys, spreads, accessors and inherited options cannot prove shell interpretation absent.
  return options.properties.every(property => ts.isPropertyAssignment(property)
    && (ts.isIdentifier(property.name) || literal(property.name))
    && property.name.text !== '__proto__'
    // Preloads are executable edges, even when the primary script is literal.
    // A cwd override can select a different worker than the snapshot decoy, even
    // when literal. Retain the full conflict until launch directories are modeled.
    && !['execArgv', 'env', 'execPath', 'cwd'].includes(property.name.text)
    && (property.name.text !== 'shell' || property.initializer.kind === ts.SyntaxKind.FalseKeyword));
}

// Only literal argv without shell interpretation have statically known launch targets.
// Other patterns retain the full conflict; callers can use the full-merge/manual-rebase path.
function knownLaunch(node, name, resolveLaunch) {
  // exec always uses a shell; its command string is outside this scanner's grammar.
  if (name === 'exec' || name === 'execSync') return false;
  if (!nonShellOptions(node.arguments[2])) return false;
  const [command, args] = node.arguments;
  const nodeExecutable = command && ts.isPropertyAccessExpression(command)
    && command.expression.getText() === 'process' && command.name.text === 'execPath';
  if (!literal(command) && !nodeExecutable) return false;
  if (name === 'fork') {
    if (!literal(command) || !PARSEABLE_CODE_RE.test(command.text)) return false;
  } else if (!nodeExecutable && command.text !== 'node') return false;
  if (args && (!ts.isArrayLiteralExpression(args) || !args.elements.every(literal)
    || args.elements.some(arg => /[$`]/.test(arg.text)))) return false;
  return name === 'fork' ? resolveLaunch(command.text)
    : args?.elements.length > 0 && PARSEABLE_CODE_RE.test(args.elements[0].text)
      && resolveLaunch(args.elements[0].text);
}

// Parse the grammar: comments and line terminators are legal between `import`
// and `(`. A literal prefix of a computed argument is not a known dependency.
function importSpecs(file, source, strict, resolveLaunch, legacyRequires = false) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, strict);
  const specs = [];
  const requires = [];
  // Raw text keeps comment references; decoded literals keep escaped filenames and template parts.
  const references = [source];
  const launches = new Map(LAUNCH_NAMES.map(name => [name, name]));
  const reads = new Set(READ_NAMES);
  const factories = new Set(['createRequire']);
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings
      || !ts.isNamedImports(statement.importClause.namedBindings)) continue;
    for (const binding of statement.importClause.namedBindings.elements) {
      const name = (binding.propertyName || binding.name).text;
      if (LAUNCH_NAMES.includes(name)) launches.set(binding.name.text, name);
      if (READ_NAMES.includes(name)) reads.add(binding.name.text);
      if (name === 'createRequire') factories.add(binding.name.text);
    }
  }
  const capabilities = strict ? moduleCapabilities(tree, resolveLaunch) : { complete: true, opaqueReads: false };
  let opaqueReads = capabilities.opaqueReads;
  let complete = tree.parseDiagnostics.length === 0 && capabilities.complete;
  const visit = node => {
    if (strict && opaqueLoaderReference(node)) complete = false;
    if (strict && (ts.isStringLiteralLike(node) || ts.isTemplateHead(node)
      || ts.isTemplateMiddle(node) || ts.isTemplateTail(node))) references.push(node.text);
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specs.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node)) {
      const name = callName(node.expression);
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword || ((strict || legacyRequires) && name === 'require')) {
        if (strict && loaderHasComments(source, node)) opaqueReads = true;
        const target = node.arguments[0];
        if (literal(target)) (name === 'require' ? requires : specs).push(target.text);
        else complete = false;
      }
      if (strict) {
        if (factories.has(name) || (launches.has(name) && !knownLaunch(node, launches.get(name), resolveLaunch))) complete = false;
        if (ts.isElementAccessExpression(node.expression) && !literal(node.expression.argumentExpression)) complete = false;
        // A computed runtime read can select code as well as Markdown/JSON. Keep every candidate.
        if (reads.has(name)) opaqueReads = true;
      }
    }
    // References can escape through aliases, destructuring or callbacks before they are called.
    // Retain every runtime candidate as soon as a read capability is referenced.
    if (strict && reads.has(callName(node))) opaqueReads = true;
    if (strict && ts.isElementAccessExpression(node) && launches.has(callName(node))) {
      if (!(ts.isCallExpression(node.parent) && node.parent.expression === node)) complete = false;
    }
    if (strict && ts.isIdentifier(node) && node.text === 'require'
      && !(ts.isCallExpression(node.parent) && node.parent.expression === node)) {
      complete = false; // require aliases/resolvers are not statically walked.
    }
    if (strict && ts.isIdentifier(node)) {
      if (node.text === 'createRequire') complete = false; // Includes destructured/aliased factories.
      if (launches.has(node.text) && !ts.isImportSpecifier(node.parent)) {
        const target = ts.isPropertyAccessExpression(node.parent) && node.parent.name === node ? node.parent : node;
        if (!(ts.isCallExpression(target.parent) && target.parent.expression === target)) complete = false;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return { specs, requires, complete, referenceText: references.join('\n'), opaqueReads };
}

function resolveRelativeSpec(fromFile, spec, exists) {
  const base = resolvePath(dirname(fromFile), spec);
  for (const cand of [base, `${base}.mjs`, `${base}.js`, `${base}.cjs`, `${base}/index.mjs`, `${base}/index.js`]) {
    if (exists(cand)) return cand;
  }
  return null;
}

// Strict evidence is a union, not a guess at Node's preferred extension/condition.
// Keep the legacy resolver above unchanged for independent compatibility checks.
function resolveRelativeCandidates(fromFile, spec, { root, exists, readFile }) {
  const targets = new Set(), active = new Set(), resolved = new Map();
  const extensions = ['', '.mjs', '.js', '.cjs', '.json', '.node', '.ts', '.mts', '.cts', '.tsx', '.jsx'];
  let complete = true;
  const inside = path => !relative(root, path).startsWith('..') && !isAbsolute(relative(root, path));
  const walk = base => {
    if (!inside(base) || active.has(base)) { complete = false; return false; }
    if (resolved.has(base)) return resolved.get(base);
    active.add(base);
    // Resolution succeeds even when another index/main/exports edge already added the file.
    let found = false;
    for (const suffix of extensions) {
      const candidate = `${base}${suffix}`;
      if (exists(candidate)) { targets.add(candidate); found = true; }
      const index = resolvePath(base, `index${suffix}`);
      if (exists(index)) { targets.add(index); found = true; }
    }
    const manifest = resolvePath(base, 'package.json');
    if (exists(manifest)) {
      try {
        const pkg = JSON.parse(readFile(manifest));
        if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) throw new Error('invalid manifest');
        const packageTarget = target => {
          // Null disables a condition; other unknown target syntax cannot prove a closure.
          if (target === null) return;
          if (typeof target === 'string') {
            // URL resolution decodes manifest targets. Union both spellings so raw
            // CommonJS paths and their dependencies remain protected as well.
            for (const spelling of new Set([target, decodeURIComponent(target)])) {
              if (!spelling || /[*?#\\\r\n\t]/.test(spelling) || isAbsolute(spelling)) { complete = false; continue; }
              const path = resolvePath(base, spelling);
              if (!inside(path)) { complete = false; continue; }
              if (walk(path)) found = true;
            }
          } else if (Array.isArray(target)) target.forEach(packageTarget);
          else if (target && typeof target === 'object') Object.values(target).forEach(packageTarget);
          else complete = false;
        };
        if (Object.hasOwn(pkg, 'main')) {
          if (typeof pkg.main !== 'string') complete = false;
          else packageTarget(pkg.main);
        }
        if (Object.hasOwn(pkg, 'exports')) packageTarget(pkg.exports);
      } catch { complete = false; }
    }
    active.delete(base);
    resolved.set(base, found);
    if (!found) complete = false;
    return found;
  };
  walk(resolvePath(dirname(fromFile), spec));
  return { targets: [...targets], complete };
}

// Bare dependencies can be tracked source, including nested node_modules. Union all
// in-tree ancestor candidates rather than assuming packages live outside the snapshot.
function resolvePackageCandidates(fromFile, spec, options) {
  const { root, exists } = options;
  const parts = spec.split('/'), count = spec.startsWith('@') ? 2 : 1;
  const targets = new Set();
  let complete = true;
  if (parts.some(part => !part || part === '.' || part === '..' || part.includes('\\'))) {
    return { targets: [], complete: false };
  }
  for (let dir = dirname(fromFile); ; dir = dirname(dir)) {
    const base = resolvePath(dir, 'node_modules', ...parts.slice(0, count));
    const bases = parts.length > count ? [base, resolvePath(base, ...parts.slice(count))] : [base];
    for (const candidate of bases) {
      const result = resolveRelativeCandidates(fromFile, relative(dirname(fromFile), candidate), options);
      // No tracked evidence is an external dependency, preserving the existing policy.
      // A present manifest must be understood even when none of its targets resolve.
      if (result.targets.length || exists(resolvePath(candidate, 'package.json'))) {
        for (const target of result.targets) targets.add(target);
        complete &&= result.complete;
      }
    }
    if (dir === root) break;
  }
  return { targets: [...targets], complete };
}

/**
 * The daemon's STATIC import closure, walked from its entry file(s) over relative `import`/`export … from`/
 * literal `import('…')` specifiers. Returns repo-relative paths. `complete:false` when a closure file has a
 * NON-literal dynamic `import(expr)` in code (its target can't be known statically) — the caller then falls back
 * to "any code file changed". `bareDeps` = some file imports a package (a `package*.json` change is relevant).
 * `jsonNames` = basenames of `.json` string literals in closure files (a config read at runtime by name).
 * By default never throws: an unreadable entry returns `null` (the caller's conservative fallback).
 * Opt-in `maxFiles` throws CLOSURE_TOO_LARGE; `strict` also walks literal CommonJS require,
 * rejects unresolved loads/launches, shell execution, unproven shell options and unsupported source types,
 * bounds non-import depth to MAX_SPAWN_HOPS,
 * and records reference text for scope scans. An incomplete closure retains the full conflict for manual rebase.
 * `followNonImports:false` returns require/launch targets without walking them; the run-closure scanner
 * combines them with all other non-import references before applying its single shared hop bound.
 * `strictExtensions:false` preserves the legacy parser and import walk: `strict` still rejects
 * unresolved relative, package-self and # imports, without the newer load/launch/reference checks.
 * `legacyRequires:true` additionally walks literal require edges with single-target resolution,
 * independently of all strict extensions, for pre-candidate-union compatibility evidence.
 * `parsed` may be shared across walks of the SAME tree snapshot (e.g. successive spawned-script hops).
 * It must be discarded before walking a changed tree or changing strict/strictExtensions/legacyRequires;
 * by default every invocation gets a fresh cache.
 * @param {{root:string, entries:string[], readFile?:(p:string)=>string, exists?:(p:string)=>boolean, parsed?:Map}} o
 * @returns {{files:Set<string>, complete:boolean, bareDeps:boolean, jsonNames:Set<string>}|null}
 */
export function collectImportClosure({
  root, entries, readFile = (p) => readFileSync(p, 'utf8'),
  exists = (p) => { try { return statSync(p).isFile(); } catch { return false; } },
  parsed = new Map(), maxFiles = Infinity, strict = false, strictExtensions = true, followNonImports = true,
  legacyRequires = false,
}) {
  const extended = strict && strictExtensions;
  const absRoot = resolvePath(root);
  // Shared dependencies occur on many edges. Cache probes for this tree snapshot only;
  // a later invocation must observe added/deleted files, including prior misses.
  const presence = new Map();
  const existsOnce = (path) => {
    if (!presence.has(path)) presence.set(path, exists(path));
    return presence.get(path);
  };
  const starts = (entries || []).filter(Boolean).map((e) => (isAbsolute(e) ? e : resolvePath(absRoot, e)))
    .filter((e) => !relative(absRoot, e).startsWith('..') && existsOnce(e));
  if (!starts.length) return null;
  const seen = new Set();
  const jsonNames = new Set();
  const referenceTexts = new Map();
  const nonImportTargets = new Set();
  let opaqueReads = false;
  let complete = true;
  let bareDeps = false;
  let packageName;
  if (strict) {
    try { packageName = JSON.parse(readFile(resolvePath(absRoot, 'package.json'))).name; } catch { /* no readable package name */ }
  }
  let stack = [...starts];
  let nonImports = [];
  let nonImportDepth = 0;
  while (stack.length || nonImports.length) {
    // Exhaust imports at this depth before following require/launch edges: imports cost zero hops.
    // First visits therefore use the fewest non-import edges, including shared targets/cycles.
    if (!stack.length) {
      stack = nonImports;
      nonImports = [];
      nonImportDepth++;
    }
    const file = stack.pop();
    if (seen.has(file)) continue;
    if ((extended || legacyRequires) && nonImportDepth > MAX_SPAWN_HOPS) {
      complete = false;
      continue;
    }
    seen.add(file);
    if (seen.size > maxFiles) {
      const error = new Error('closure-too-large');
      error.code = 'CLOSURE_TOO_LARGE';
      throw error;
    }
    let info = parsed.get(file);
    if (!info) {
      info = { imports: [], nonImports: [], jsonNames: new Set(), complete: true, bareDeps: false };
      if (extended && !PARSEABLE_CODE_RE.test(file)) info.complete = false;
      let src;
      try { src = readFile(file); } catch { info.complete = false; }
      if (src !== undefined) {
        let imports;
        const resolveLaunch = spec => {
          // Home aliases and absolute paths are outside the snapshot's resolution evidence.
          if (isAbsolute(spec) || spec.startsWith('~')) return false;
          const targets = [resolvePath(dirname(file), spec), resolvePath(absRoot, spec)]
            .filter(path => !relative(absRoot, path).startsWith('..') && existsOnce(path));
          info.nonImports.push(...targets);
          return targets.length > 0;
        };
        try { imports = importSpecs(file, src, extended, resolveLaunch, legacyRequires); }
        catch { imports = { specs: [], complete: false }; } // Parser limits retain the conservative fallback.
        info.complete &&= imports.complete;
        info.referenceText = imports.referenceText;
        info.opaqueReads = imports.opaqueReads;
        for (const [specs, targets] of [[imports.specs, info.imports], [imports.requires || [], info.nonImports]]) {
          for (const spec of specs) {
            if (extended && (opaqueLoaderSpecifier(spec) || /[%?#\\\r\n\t]/.test(spec))) {
              // URL syntax can select a different file than the raw filesystem spelling.
              // Refuse before relative/package routing, even when a raw-path decoy exists.
              // Retain every file through closure-incomplete; legacy walks stay independent.
              info.complete = false;
            } else if (spec.startsWith('./') || spec.startsWith('../')
              || (extended && (spec === '.' || spec === '..'))) {
              if (extended) {
                const candidates = resolveRelativeCandidates(file, spec, { root: absRoot, exists: existsOnce, readFile });
                targets.push(...candidates.targets);
                info.complete &&= candidates.complete;
              } else {
                const hit = resolveRelativeSpec(file, spec, existsOnce);
                if (hit && !relative(absRoot, hit).startsWith('..')) targets.push(hit);
                else if (strict) info.complete = false;
              }
            } else if (strict && ((extended && isAbsolute(spec)) || spec.startsWith('#')
              || (typeof packageName === 'string' && packageName.length > 0
                && (spec === packageName || spec.startsWith(`${packageName}/`))))) {
              info.complete = false;
            } else if (!spec.startsWith('node:') && /^[@a-z]/i.test(spec) && !/\s/.test(spec)) {
              info.bareDeps = true;
              if (extended) {
                const candidates = resolvePackageCandidates(file, spec, { root: absRoot, exists: existsOnce, readFile });
                targets.push(...candidates.targets);
                info.complete &&= candidates.complete;
              }
            }
          }
        }
        for (const m of src.matchAll(JSON_LITERAL_RE)) info.jsonNames.add(basename(m[1]));
      }
      parsed.set(file, info);
    }
    stack.push(...info.imports);
    if (followNonImports) nonImports.push(...info.nonImports);
    else for (const target of info.nonImports) nonImportTargets.add(relative(absRoot, target));
    if (extended && info.referenceText !== undefined) referenceTexts.set(relative(absRoot, file), info.referenceText);
    opaqueReads ||= info.opaqueReads;
    for (const name of info.jsonNames) jsonNames.add(name);
    complete &&= info.complete;
    bareDeps ||= info.bareDeps;
  }
  return { files: new Set([...seen].map((f) => relative(absRoot, f))), complete, bareDeps, jsonNames,
    ...(extended ? { referenceTexts, opaqueReads } : {}),
    ...((extended || legacyRequires) && !followNonImports ? { nonImportTargets } : {}) };
}


const PACKAGE_MANIFEST_RE = /(^|\/)package(-lock)?\.json$/;

/**
 * PURE: the changed files that fall inside `closure` — a closure member, a `package*.json` when the closure
 * imports any package, or a `.json` whose basename a closure file names as a literal. `null` when the answer is
 * unknowable (no diff, or an incomplete/unknown closure) — every caller treats that as "touched".
 * @param {{closure:ReturnType<typeof collectImportClosure>, changedFiles:string[]|null}} o
 * @returns {string[]|null}
 */
export function closureHits({ closure, changedFiles }) {
  if (!Array.isArray(changedFiles) || !closure || !closure.complete) return null;
  return changedFiles.filter((f) => closure.files.has(f)
    || (closure.bareDeps && PACKAGE_MANIFEST_RE.test(f))
    || (f.endsWith('.json') && closure.jsonNames.has(basename(f))));
}
