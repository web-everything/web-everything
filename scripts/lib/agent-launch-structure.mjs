/** Coarse capability boundary. Never infer executable values or prove arbitrary callees safe. */
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { isBuiltin } from 'node:module';

// Membership starts with the pre-capability migration inventory and reviewed existing callers.
// It is independent of the fingerprint snapshot: updating fingerprints cannot approve a new file.
export const AGENT_LAUNCH_ALLOWLIST = Object.freeze(JSON.parse(
  readFileSync(join(import.meta.dirname, 'agent-launch-approved.json'), 'utf8')));
const executionBuiltin = /^(?:node:)?(?:child_process|worker_threads|cluster|vm|inspector|repl|module|v8|wasi|process)(?:\/|$)/;
const capabilityNames = new Set(['process', 'require', 'module', 'eval', 'Function', 'AsyncFunction', 'GeneratorFunction', 'AsyncGeneratorFunction', 'Worker',
  'globalThis', 'global', 'window', 'self', 'Reflect',
  'spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork', 'cp', 'child_process', 'childProcess']);
const primitiveNames = /^(?:spawn(?:Sync)?|exec(?:File(?:Sync)?|Sync)?|fork)$/;
const dataProcessMembers = new Set(['env', 'pid', 'ppid', 'argv', 'execArgv', 'platform', 'arch', 'versions', 'version', 'exitCode']);
const capabilityMembers = new Set(['binding', '_linkedBinding', 'dlopen', 'eval', 'Function', 'AsyncFunction',
  'GeneratorFunction', 'AsyncGeneratorFunction', 'Worker', 'constructor', '__proto__', 'prototype']);

// Without evaluating arbitrary code, only literal keys can rule out constructor/prototype access.
// Apply the same rule to direct evidence and exported bindings in the dependency graph.
function capabilityAccess(node) {
  if (!ts.isElementAccessExpression(node)) return false;
  const key = node.argumentExpression;
  return !key || !(ts.isStringLiteralLike(key) || ts.isNumericLiteral(key))
    || capabilityNames.has(key.text) || capabilityMembers.has(key.text);
}
// Hash the whole syntax/token tree. Trivia is absent; literal lexemes and ASI structure remain.
// Unlike reprinting or regex stripping, this ignores ONLY formatting/comments, not token edits.
function moduleFingerprint(file) {
  const hash = createHash('sha256');
  const visit = node => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const children = node.getChildren(file);
    hash.update(JSON.stringify([node.kind, children.length ? null : node.getText(file)]));
    hash.update('[');
    for (const child of children) visit(child);
    hash.update(']');
  };
  visit(file);
  return 'module-sha256-v2:' + hash.digest('hex');
}
const portable = name => relative(process.cwd(), name).split('\\').join('/');

function dataReference(node) {
  const parent = node.parent;
  return ts.isIdentifier(node) && ts.isPropertyAccessExpression(parent) && parent.expression === node
    && (node.text === 'process' && dataProcessMembers.has(parent.name.text)
      || node.text === 'module' && parent.name.text === 'exports');
}

function capabilityReference(node) {
  if (!ts.isIdentifier(node) || !capabilityNames.has(node.text) && !capabilityMembers.has(node.text)) return false;
  const parent = node.parent;
  if (primitiveNames.test(node.text) && ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (dataReference(node)) return false;
  return !(node.text === 'require' && ts.isCallExpression(parent) && parent.expression === node
    && parent.arguments.length === 1 && ts.isStringLiteralLike(parent.arguments[0]));
}

/**
 * A monotone dependency graph, not an executable-value evaluator. A binding inherits every
 * capability in its definition, assignments and referenced bindings (including returned closures
 * and containers). The TypeScript binder resolves lexical names, imports and re-exports without
 * executing source or loading anything outside the supplied tree. Cycles reach a fixed point.
 */
function launcherReferences(files) {
  const program = ts.createProgram([...files.keys()], {
    allowJs: true, noLib: true, types: [], target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext,
  }, {
    getSourceFile: name => files.get(resolve(name)), getDefaultLibFileName: () => '',
    writeFile() {}, getCurrentDirectory: () => process.cwd(), getDirectories: () => [],
    fileExists: name => files.has(resolve(name)), readFile: name => files.get(resolve(name))?.text,
    getCanonicalFileName: name => name, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
    resolveModuleNames: (names, containing) => names.map(source => {
      const target = resolve(dirname(containing), source);
      return source.startsWith('.') && files.has(target) ? { resolvedFileName: target,
        extension: /\.tsx?$/.test(target) ? ts.Extension.Ts : /\.mjs$/.test(target) ? ts.Extension.Mjs : ts.Extension.Js } : undefined;
    }),
  });
  const checker = program.getTypeChecker();
  const graph = new Map(), references = new Map(), calls = new Map(), evidence = new Map();
  const commonJS = new Map();
  const commonJSExports = file => {
    if (commonJS.has(file)) return commonJS.get(file);
    const slots = new Map();
    commonJS.set(file, slots);
    const memberPath = node => ts.isIdentifier(node) ? node.text
      : ts.isPropertyAccessExpression(node) ? `${memberPath(node.expression)}.${node.name.text}`
        : ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression)
          ? `${memberPath(node.expression)}.${node.argumentExpression.text}` : '';
    const visit = node => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const path = memberPath(node.left);
        const add = name => {
          if (!slots.has(name)) slots.set(name, { name, flags: 0 });
          link(record(slots.get(name)), record(node));
        };
        if (path === 'module.exports') {
          add('default');
          if (ts.isObjectLiteralExpression(node.right)) for (const property of node.right.properties) {
            if (property.name && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name))) add(property.name.text);
          }
        } else if (/^(?:module\.exports|exports)\.[^.]+$/.test(path)) add(path.split('.').at(-1));
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    return slots;
  };
  const exportsOf = symbol => [...checker.getExportsOfModule(symbol),
    ...(symbol.exports?.has('export=') ? [symbol.exports.get('export=')] : []),
    ...symbol.declarations.filter(ts.isSourceFile).flatMap(file => [...commonJSExports(file).values()])];
  const canonical = symbol => {
    if (symbol?.kind != null) return symbol; // synthetic expression/declaration graph vertex
    if (!symbol || !(symbol.flags & ts.SymbolFlags.Alias)) return symbol;
    const target = checker.getAliasedSymbol(symbol);
    // Unresolved aliases must retain their own identity, not TS's shared "unknown" symbol.
    return target?.declarations?.length ? target : symbol;
  };
  const record = symbol => {
    symbol = canonical(symbol);
    if (!symbol) return undefined;
    if (!graph.has(symbol)) {
      const entry = { symbol, dependencies: new Set(), users: new Set(), tainted: false };
      graph.set(symbol, entry);
      if (symbol.declarations?.some(ts.isSourceFile)) {
        for (const exported of exportsOf(symbol)) entry.dependencies.add(record(exported));
        if (symbol.declarations.some(d => d.parseDiagnostics?.length)) entry.tainted = true;
      }
    }
    return graph.get(symbol);
  };
  const boundary = symbol => canonical(symbol)?.declarations?.some(d => ts.isFunctionDeclaration(d)
    && d.name?.text === 'launchAgent' && portable(d.getSourceFile().fileName) === 'scripts/lib/agent-launch.mjs');
  const symbolAt = node => canonical(checker.getSymbolAtLocation(node));
  const namespace = node => symbolAt(node)?.declarations?.some(ts.isSourceFile);
  const link = (owner, dependency) => { if (owner && dependency) owner.dependencies.add(dependency); };
  const exportedSymbol = (file, name) => {
    const commonJS = commonJSExports(file).get(name);
    if (commonJS) return commonJS;
    const symbol = checker.getSymbolAtLocation(file);
    if (!symbol) return undefined;
    return checker.getExportsOfModule(symbol).find(s => s.name === name);
  };
  const hasAgentWord = node => {
    if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node))
      && /(?:^|[^\w])(?:claude|codex)(?=$|[^\w])/i.test(node.text.replace(/['"`\\]/g, ''))) return true;
    return !!ts.forEachChild(node, hasAgentWord);
  };
  for (const [name, file] of files) {
    const refs = new Set(), agentCalls = [], reasons = new Set();
    references.set(name, refs); calls.set(name, agentCalls); evidence.set(name, reasons);
    const moduleSymbol = checker.getSymbolAtLocation(file);
    const moduleExports = () => moduleSymbol ? exportsOf(moduleSymbol) : [];
    const addReference = (symbol, owner) => {
      const dependency = record(symbol);
      if (dependency) { refs.add(dependency); link(owner, dependency); }
    };
    const moduleTarget = source => source && ts.isStringLiteralLike(source) && source.text.startsWith('.')
      ? files.get(resolve(dirname(name), source.text)) : undefined;
    const unsafeSource = source => !source || !ts.isStringLiteralLike(source)
      || (isBuiltin(source.text) ? executionBuiltin.test(source.text) : !moduleTarget(source));
    const visit = (node, owner) => {
      // Import aliases are resolved by the binder; opaque dependencies seed those bindings.
      if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) {
        const source = ts.isImportDeclaration(node) ? node.moduleSpecifier : node.moduleReference.expression;
        const bindings = ts.isImportDeclaration(node) ? [node.importClause?.name,
          ...(node.importClause?.namedBindings ? ts.isNamespaceImport(node.importClause.namedBindings)
            ? [node.importClause.namedBindings.name] : node.importClause.namedBindings.elements.map(e => e.name) : [])] : [node.name];
        for (const binding of bindings.filter(Boolean)) {
          const entry = record(symbolAt(binding));
          if (!entry) continue;
          const target = moduleTarget(source);
          if (unsafeSource(source)) entry.tainted = true;
          else if (target && entry.symbol.flags & ts.SymbolFlags.Alias) {
            const importedName = ts.isImportSpecifier(binding.parent) ? (binding.parent.propertyName ?? binding).text : 'default';
            const exported = exportedSymbol(target, importedName);
            if (exported) link(entry, record(exported));
            else entry.tainted = true;
          }
          // Merely declaring a namespace does not take its container; named imports do reference exports.
          if (!ts.isNamespaceImport(binding.parent)) refs.add(entry);
        }
        return;
      }
      if (ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier) {
          const target = moduleTarget(node.moduleSpecifier);
          if (target?.parseDiagnostics.length || unsafeSource(node.moduleSpecifier)) {
            for (const exported of moduleExports()) record(exported).tainted = true;
            if (!node.exportClause && moduleSymbol) record(moduleSymbol).tainted = true;
          }
          if (!node.exportClause && target) addReference(checker.getSymbolAtLocation(target), owner);
        }
        if (node.exportClause) for (const element of ts.isNamedExports(node.exportClause) ? node.exportClause.elements : [node.exportClause]) {
          const symbol = symbolAt(element.name);
          addReference(symbol, owner);
          if (!node.moduleSpecifier && ts.isExportSpecifier(element)) {
            const target = record(checker.getExportSpecifierLocalTargetSymbol(element));
            if (target) link(record(symbol), target);
            else if (record(symbol)) record(symbol).tainted = true;
          }
          const target = node.moduleSpecifier && moduleTarget(node.moduleSpecifier);
          if (target && ts.isExportSpecifier(element)) {
            const exported = exportedSymbol(target, (element.propertyName ?? element.name).text);
            if (exported) link(record(symbol), record(exported));
            else if (record(symbol)) record(symbol).tainted = true;
          }
        }
        return;
      }
      const declaration = ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassDeclaration(node)
        || ts.isClassExpression(node) || ts.isVariableDeclaration(node) || ts.isParameter(node)
        || ts.isBindingElement(node) || ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node)
        || ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node);
      if (declaration || ts.isExportAssignment(node)) {
        const symbol = node.name && checker.getSymbolAtLocation(node.name)
          || (ts.isExportAssignment(node) || node.modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword)
            ? moduleExports().find(s => s.name === 'default') : undefined);
        const destructured = node.name && (ts.isObjectBindingPattern(node.name) || ts.isArrayBindingPattern(node.name));
        const next = record(symbol ?? (destructured ? node : undefined));
        if (destructured) {
          const bindings = pattern => {
            if (ts.isIdentifier(pattern)) link(record(symbolAt(pattern)), next);
            else for (const element of pattern.elements) if (element.name) bindings(element.name);
          };
          bindings(node.name);
        }
        if (next) { link(owner, next); owner = next; }
        if (ts.isShorthandPropertyAssignment(node)) addReference(checker.getShorthandAssignmentValueSymbol(node), owner);
      }
      if (ts.isBinaryExpression(node) && ts.isAssignmentOperator(node.operatorToken.kind)) {
        const assignment = record(node);
        const writes = left => {
          if (ts.isIdentifier(left)) {
            if (!dataReference(left)) link(record(symbolAt(left)), assignment);
          } else if (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) writes(left.expression);
          else if (ts.isPropertyAssignment(left)) writes(left.initializer);
          else if (ts.isShorthandPropertyAssignment(left)) writes(left.name);
          else if (ts.isBinaryExpression(left)) writes(left.left);
          else if (ts.isObjectLiteralExpression(left)) left.properties.forEach(writes);
          else if (ts.isArrayLiteralExpression(left)) left.elements.forEach(writes);
          else if (ts.isParenthesizedExpression(left) || ts.isSpreadAssignment(left) || ts.isSpreadElement(left)) writes(left.expression);
        };
        writes(node.left);
        link(owner, assignment); owner = assignment;
      }
      if (capabilityReference(node) || capabilityAccess(node)) {
        if (owner) owner.tainted = true;
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        if (node.arguments?.some(hasAgentWord)) agentCalls.push(node.expression);
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require') {
          const source = node.arguments?.[0], target = source && moduleTarget(source);
          if (target) addReference(checker.getSymbolAtLocation(target), owner);
          else if (unsafeSource(source) && owner) owner.tainted = true;
        }
        // A method can retain its arguments in its receiver (push/set/custom registration).
        if (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression)) {
          let receiver = node.expression.expression;
          while (ts.isPropertyAccessExpression(receiver) || ts.isElementAccessExpression(receiver)) receiver = receiver.expression;
          if (ts.isIdentifier(receiver) && !dataReference(receiver)) {
            const target = record(symbolAt(receiver));
            if (target?.symbol.declarations?.some(d => ts.isVariableDeclaration(d) || ts.isParameter(d))) {
              const call = record(node);
              link(target, call); link(owner, call); owner = call;
            }
          }
        }
      }
      if (ts.isIdentifier(node)) {
        const parent = node.parent;
        const isName = parent.name === node && (ts.isDeclaration(parent) && !ts.isShorthandPropertyAssignment(parent));
        const selectedNamespace = ts.isPropertyAccessExpression(parent) && parent.expression === node
          && namespace(node) && symbolAt(parent.name);
        const data = dataReference(node) || ts.isPropertyAccessExpression(parent) && parent.name === node && dataReference(parent.expression);
        if (!isName && !selectedNamespace && !data) addReference(symbolAt(node), owner);
        // Property names select exports too; ordinary declaration names are not value references.
        if (ts.isPropertyAccessExpression(parent) && parent.name === node && !data) addReference(symbolAt(node), owner);
      }
      if (ts.isElementAccessExpression(node) && namespace(node.expression) && ts.isStringLiteralLike(node.argumentExpression)) {
        const exported = checker.getExportsOfModule(symbolAt(node.expression)).find(s => s.name === node.argumentExpression.text);
        if (exported) addReference(exported, owner);
      }
      ts.forEachChild(node, child => visit(child, owner));
    };
    visit(file, undefined);
    // CommonJS exports and malformed modules have no reliably complete ESM binding evidence.
    if (file.parseDiagnostics.length || /\b(?:module\s*\.\s*exports|exports\s*[.\[])/.test(file.text)) {
      for (const exported of moduleExports()) {
        const entry = record(exported);
        for (const ref of refs) link(entry, ref);
        if (file.parseDiagnostics.length) entry.tainted = true;
      }
    }
  }
  const pending = [];
  for (const entry of graph.values()) {
    for (const dependency of entry.dependencies) dependency?.users.add(entry);
    if (entry.tainted) pending.push(entry);
  }
  for (let i = 0; i < pending.length; i++) for (const user of pending[i].users) {
    if (!user.tainted) { user.tainted = true; pending.push(user); }
  }
  for (const [name, refs] of references) {
    for (const ref of refs) if (ref.tainted && !boundary(ref.symbol)) evidence.get(name).add(`launcher export reference: ${ref.symbol.name}`);
    for (const callee of calls.get(name)) if (!boundary(symbolAt(callee))) evidence.get(name).add('agent-word argument outside launchAgent');
  }
  return evidence;
}

/**
 * Inventory every approved module's WHOLE text; report capability-bearing unapproved modules.
 * Module-level granularity deliberately covers all functions, aliases, mutations, callers and
 * surrounding definitions, including new capabilities introduced into a previously benign file.
 * Local launcher exports propagate capabilities to their callers across the complete import graph.
 * Unknown packages/modules are capabilities too: an uninspected dependency cannot prove safety.
 */
export function findAgentLaunches(sources) {
  const files = new Map(Object.entries(sources).map(([name, text]) => [resolve(name),
    ts.createSourceFile(resolve(name), text, ts.ScriptTarget.Latest, true,
      /\.tsx?$/.test(name) ? ts.ScriptKind.TS : ts.ScriptKind.JS)]));
  const approved = new Set(AGENT_LAUNCH_ALLOWLIST);
  const callerEvidence = launcherReferences(files);
  const modules = new Map();
  for (const [name, file] of files) {
    const evidence = callerEvidence.get(name);
    const specifier = node => {
      if (!node || !ts.isStringLiteralLike(node)) {
        evidence.add('non-literal module specifier');
        return;
      }
      const source = node.text;
      if (isBuiltin(source)) {
        if (executionBuiltin.test(source)) evidence.add(`execution builtin: ${source}`);
      } else if (source.startsWith('.')) {
        // Require exact, inspectable source. No filesystem or package-resolution fallback.
        const target = resolve(dirname(name), source);
        if (!files.has(target)) evidence.add(`uninspected module: ${source}`);
      } else {
        // Covers known exec packages AND any future/unknown execution package, including subpaths.
        evidence.add(`uninspected package: ${source}`);
      }
    };
    const visit = node => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        specifier(node.moduleSpecifier);
      }
      if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        specifier(node.moduleReference.expression);
      }
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
        specifier(node.arguments[0]);
      }
      // References, declarations, aliases and escapes all require the same boundary.
      if (capabilityReference(node)) evidence.add(`capability reference: ${node.text}`);
      if (capabilityAccess(node)) evidence.add('capability access: computed or execution member');
      ts.forEachChild(node, visit);
    };
    visit(file);
    modules.set(name, { file, evidence, approved: approved.has(portable(name)) });
  }
  const findings = [];
  for (const [name, entry] of modules) {
    const { file, evidence } = entry;
    // Parse failure can never be inventoried, even inside an approved boundary.
    if (file.parseDiagnostics.length) {
      findings.push({ file: name, line: 1, reason: 'unparseable source; review complete source before approving boundary' });
    } else if (entry.approved || evidence.size) {
      const fingerprint = moduleFingerprint(file);
      findings.push({ file: name, line: 1, kind: 'module', classification: 'unresolved', fingerprint,
        reason: entry.approved ? 'approved boundary inventory; exact module fingerprint required'
          : `execution capability outside approved boundary; use an approved boundary or request review: ${[...evidence].sort().join(', ')}` });
    }
  }
  return findings;
}

/** No ignored production subtrees: only test sources and their fixture directories are omitted. */
export function readAgentLaunchTree(root) {
  const sources = {};
  const walk = dir => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, e.name);
      if (e.isDirectory() && !['__tests__', 'node_modules', 'fixtures', '__fixtures__'].includes(e.name)) walk(file);
      else if (e.isFile() && /\.(?:mjs|cjs|js|ts|tsx)$/.test(e.name) && !/\.(?:test|spec)\./.test(e.name)) sources[file] = readFileSync(file, 'utf8');
    }
  };
  for (const dir of ['scripts', 'skills-src']) walk(join(root, dir));
  return sources;
}
