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
const VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env']);
const GLOBAL_FLAGS = new Set(['--bare', '--no-pager', '--paginate', '--no-replace-objects', '--literal-pathspecs',
  '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--no-optional-locks']);
const CHILD_PROCESS = new Set(['node:child_process', 'child_process']);
const isGitBinary = text => typeof text === 'string' && /(?:^|[/\\])git(?:\.exe)?$/i.test(text);
const isShellBinary = text => typeof text === 'string' && /(?:^|[/\\])(?:sh|bash|zsh|dash)$/.test(text);
const isCommandFlag = text => typeof text === 'string' && /^-[a-z]*c[a-z]*$/.test(text);

// Consume Git's global options, then inspect only the subcommand (never its operands).
function classifyArgv(words) {
  const unresolved = { kind: 'unresolved', count: 1 };
  if (words.some(word => word === undefined || word.includes('${}'))) return unresolved;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (['--version', '-v', '--help', '-h', '--exec-path', '--html-path', '--man-path', '--info-path'].includes(word)) return;
    if (VALUE_FLAGS.has(word)) {
      if (++i === words.length) return unresolved;
    } else if (GLOBAL_FLAGS.has(word) || /^(?:--[\w-]+=|-C.|-c.)/.test(word)) continue;
    else if (word.startsWith('-')) return unresolved;
    else return word === 'push' ? { kind: 'argv', count: 1 } : undefined;
  }
  return words.length ? unresolved : undefined;
}

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
  const sites = [], bindings = new Map(), namespaces = new Set();
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
        const original = (binding.propertyName || binding.name).text;
        if (SPAWNS.has(original)) bindings.set(binding.name.text, original);
      }
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (requiredModule(node.initializer)) {
        if (ts.isIdentifier(node.name)) namespaces.add(node.name.text);
        if (ts.isObjectBindingPattern(node.name)) for (const binding of node.name.elements) {
          const original = nameOf(binding.propertyName || binding.name);
          if (SPAWNS.has(original)) bindings.set(nameOf(binding.name), original);
        }
      } else if ((ts.isPropertyAccessExpression(node.initializer) || ts.isElementAccessExpression(node.initializer))
        && requiredModule(node.initializer.expression) && SPAWNS.has(nameOf(node.initializer))) {
        bindings.set(nameOf(node.name), nameOf(node.initializer));
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
    // Keep quoted words intact so flags consume one value, including spaces or separators.
    const tokens = text.match(/(?:'[^']*'|"(?:\\.|[^"\\])*"|\\[^\r\n]|[^\s"'\\;&|()])+|[;&|()\r\n]+/g) || [];
    let command = [], count = 0, unresolved = false;
    const inspect = () => {
      const words = command.map(word => word.replace(/'([^']*)'|"([^"]*)"/g, (_, single, double) => single ?? double));
      let kind;
      if (isGitBinary(words[0])) kind = classifyArgv(words.slice(1));
      else if (isShellBinary(words[0])) {
        const flag = words.findIndex(isCommandFlag);
        if (flag >= 0 && words[flag + 1] !== undefined) kind = shellKind(words[flag + 1]);
      }
      if (kind) { count += kind.count; unresolved ||= kind.kind === 'unresolved'; }
    };
    for (const token of tokens) {
      if (/^[;&|()\r\n]+$/.test(token)) { inspect(); command = []; }
      else command.push(token);
    }
    inspect();
    if (count) return { kind: unresolved ? 'unresolved' : 'shell', count };
  };
  const argvWords = elements => Array.from(elements).flatMap(node => ts.isArrayLiteralExpression(node)
    ? argvWords(node.elements) : [ts.isStringLiteralLike(node) ? node.text : undefined]);
  const helperArgs = elements => Array.from(elements).flatMap(node => {
    if (!ts.isObjectLiteralExpression(node)) return [node];
    const named = name => Array.from(node.properties).filter(prop => !ts.isSpreadAssignment(prop)
      && nameOf(ts.isComputedPropertyName(prop.name) ? prop.name.expression : prop.name) === name).at(-1);
    const executable = named('file');
    if (executable && ts.isPropertyAssignment(executable) && ts.isStringLiteralLike(executable.initializer)
      && !isGitBinary(executable.initializer.text)) return [];
    const property = named('args');
    if (!property) return []; // Ordinary helper options are not a Git argv object.
    // An object spread or unknown key could replace args; require manual inspection.
    if (node.properties.some(prop => ts.isSpreadAssignment(prop)
      || (ts.isComputedPropertyName(prop.name) && !ts.isStringLiteralLike(prop.name.expression)))) return [node];
    return [ts.isPropertyAssignment(property) ? property.initializer : property];
  });
  const scanShellArgs = elements => {
    for (const node of elements) {
      const text = staticText(node);
      const kind = text === undefined ? undefined : shellKind(text);
      if (kind) return kind;
    }
  };
  const visit = node => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression, name = nameOf(callee);
      const bound = bindings.has(name) || ((ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))
        && namespaces.has(nameOf(callee.expression)) && SPAWNS.has(name));
      if (bound || SPAWNS.has(name) || /^(git|run|sh)/i.test(name)) {
        const args = Array.from(node.arguments), executable = args[0] && staticText(args[0]);
        const processKind = bindings.get(name) || (SPAWNS.has(name) ? name : undefined);
        let kind;
        if (isGitBinary(executable)) kind = classifyArgv(argvWords(args.slice(1, 2)));
        else if (isShellBinary(executable) && args[1] && ts.isArrayLiteralExpression(args[1])) {
          const words = args[1].elements, flag = words.findIndex(word => isCommandFlag(staticText(word)));
          if (flag >= 0) kind = scanShellArgs(Array.from(words).slice(flag + 1, flag + 2));
        } else {
          // Only command strings are shell programs; an argv element containing push is inert.
          if (!processKind || processKind === 'exec' || processKind === 'execSync') kind = scanShellArgs(args.slice(0, 1));
          if (!kind && !processKind && /git/i.test(name)) kind = classifyArgv(argvWords(helperArgs(args)));
          // Existing run/runWt wrappers take Git argv as their first argument. Their
          // dynamic operands do not change a statically identified push subcommand.
          else if (!kind && /^run/i.test(name) && args[0] && ts.isArrayLiteralExpression(args[0])) {
            const candidate = classifyArgv(argvWords([args[0]]).map(word => word ?? ''));
            if (candidate?.kind === 'argv') kind = candidate;
          }
        }
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
