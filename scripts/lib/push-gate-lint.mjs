/**
 * NON-CLAIMS: This lint is a tripwire for honest accidental pushes only.
 * Deliberate evasion (dynamic or concatenated command strings, executable variables,
 * reassigned aliases, dynamic imports, .call(), shell escapes such as g\it pu\sh,
 * unlisted git global flags, and call identity beyond the pinned per-file count)
 * is NOT caught. The security boundary is the S1 gate (scripts/lib/authorized-push.mjs)
 * plus S6's shell refusal. authorized-push.mjs is exempt because it is the gate itself.
 * Inspect syntax only, never execute the source.
 */
import ts from 'typescript';

const SPAWNS = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);
const GLOBAL_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env',
  '--exec-path', '--bare', '--no-pager', '--paginate', '--no-replace-objects', '--literal-pathspecs',
  '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--no-optional-locks']);
// Treat hyphen-prefixed tokens as flags, never optional values: letting both
// consume them creates exponentially many partitions. A bare '-' remains a value.
const SHELL_PUSH = /\bgit\s+(?:-\S+\s+(?:(?:[^\s-]\S*|-)\s+)?)*push\b/g;
const CHILD_PROCESS = new Set(['node:child_process', 'child_process']);

/** Paths come from git ls-files; reject paths outside the tracked scripts shape. */
export function isLintedScript(path) {
  return typeof path === 'string' && /^scripts\/(?:[^/]+\/)*[^/]+\.(?:mjs|js|cjs|ts|mts|cts)$/.test(path)
    && !path.includes('\\')
    && !path.split('/').some(part => ['.', '..', '__tests__'].includes(part))
    && !/\.(?:test|spec)\.(?:mjs|js|cjs|ts|mts|cts)$/.test(path.split('/').at(-1))
    && path !== 'scripts/lib/authorized-push.mjs';
}

/** One site per shell match or argv call; unreadable or unparsable evidence requires manual inspection. */
export function findRawPushes(source, filename = 'scripts/source.mjs') {
  if (typeof source !== 'string') throw new Error(`${filename}: unreadable source; inspect manually`);
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true,
    /\.(?:ts|mts|cts)$/.test(filename) ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  if (file.parseDiagnostics.length) throw new Error(`${filename}: parse error; inspect manually`);
  const sites = [], bindings = new Set(), namespaces = new Set();
  const nameOf = node => ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text
    : ts.isPropertyAccessExpression(node) ? node.name.text
      : ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : '';
  const requiredModule = node => ts.isCallExpression(node) && nameOf(node.expression) === 'require'
    && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])
    && CHILD_PROCESS.has(node.arguments[0].text);
  const collect = node => {
    if (ts.isImportDeclaration(node) && CHILD_PROCESS.has(node.moduleSpecifier.text)) {
      const clause = node.importClause;
      if (clause?.name) namespaces.add(clause.name.text);
      const named = clause?.namedBindings;
      if (named && ts.isNamespaceImport(named)) namespaces.add(named.name.text);
      if (named && ts.isNamedImports(named)) for (const binding of named.elements) {
        if (SPAWNS.has((binding.propertyName || binding.name).text)) bindings.add(binding.name.text);
      }
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (requiredModule(node.initializer)) {
        if (ts.isIdentifier(node.name)) namespaces.add(node.name.text);
        if (ts.isObjectBindingPattern(node.name)) for (const binding of node.name.elements) {
          if (SPAWNS.has(nameOf(binding.propertyName || binding.name))) bindings.add(nameOf(binding.name));
        }
      } else if ((ts.isPropertyAccessExpression(node.initializer) || ts.isElementAccessExpression(node.initializer))
        && requiredModule(node.initializer.expression) && SPAWNS.has(nameOf(node.initializer))) {
        bindings.add(nameOf(node.name));
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(file);
  const staticText = node => {
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map(span => span.literal.text)].join('${}');
    return undefined;
  };
  const shellKind = text => {
    const words = text.replace(/["']/g, '');
    const count = [...words.matchAll(SHELL_PUSH)].length;
    if (count) return { kind: 'shell', count };
    if (/\bgit\s+/.test(words) && words.includes('${}')) return { kind: 'unresolved', count: 1 };
  };
  const scanArgs = elements => {
    for (let i = 0; i < elements.length; i++) {
      const node = elements[i], text = staticText(node);
      const shell = text === undefined ? undefined : shellKind(text);
      if (shell) return shell;
      if (ts.isStringLiteralLike(node) && text === 'push') {
        const previous = i ? staticText(elements[i - 1]) : undefined;
        if (!previous?.startsWith('-') || GLOBAL_FLAGS.has(previous)
          || /^(?:--[\w-]+=|-C.|-c.)/.test(previous)) return { kind: 'argv', count: 1 };
      }
      if (ts.isArrayLiteralExpression(node)) {
        const kind = scanArgs(node.elements);
        if (kind) return kind;
      }
    }
  };
  const fullyStatic = node => ts.isStringLiteralLike(node)
    || (ts.isArrayLiteralExpression(node) && node.elements.every(fullyStatic));
  const visit = node => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression, name = nameOf(callee);
      const bound = bindings.has(name) || ((ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))
        && namespaces.has(nameOf(callee.expression)) && SPAWNS.has(name));
      if (bound || SPAWNS.has(name) || /^(git|run|sh)/i.test(name)) {
        let kind = scanArgs(node.arguments);
        const gitCommand = node.arguments[0] && staticText(node.arguments[0]) === 'git';
        // Process options are not argv. A git helper may also accept a trailing options object.
        const argv = gitCommand ? Array.from(node.arguments).slice(1, 2)
          : Array.from(node.arguments).filter(arg => !ts.isObjectLiteralExpression(arg));
        if ((gitCommand || /git/i.test(name)) && !argv.every(fullyStatic)) kind = { kind: 'unresolved', count: kind?.count || 1 };
        if (kind) for (let i = 0; i < kind.count; i++) {
          sites.push({ line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, kind: kind.kind });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return sites;
}
