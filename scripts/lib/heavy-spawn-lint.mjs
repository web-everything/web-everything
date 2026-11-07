/** Static admission lint for literal heavy child_process commands. No code is executed. */
import ts from 'typescript';
import { canonicalCommand, commandSubstitutionBodies, parseSegments, shellTokens, ungatedHeavyRunKind } from '../guard-bash.mjs';

const SPAWNS = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

/** Inspect executable positions only; arguments to ordinary programs are data. */
function heavyCommand(command, depth = 0) {
  if (depth > 8) return true; // fail closed on implausibly deep nesting
  // A shell expands `$( … )` / backticks before running the outer command, so their bodies are executed too.
  // Array arguments arrive single-quoted (see quote()), where nothing expands.
  if (commandSubstitutionBodies(command).some(body => heavyCommand(body, depth + 1))) return true;
  return parseSegments(command).segments.some(segment => {
    // The Bash guard's own classifier first: package test scripts (`npm test`, `npm --prefix . test`, `pnpm t`),
    // `node --test`, vitest and check-standards heads. The checks below add playwright and `sh -c` bodies.
    if (ungatedHeavyRunKind(segment)) return true;
    const words = shellTokens(canonicalCommand(segment)).filter(word => !word.op).map(word => word.text);
    let [program, ...args] = words;
    if (/^(?:ba|da|z|k)?sh$/.test(program || '')) {
      const at = args.findIndex(arg => /^-[a-z]*c[a-z]*$/.test(arg));
      return at >= 0 && !!args[at + 1] && heavyCommand(args[at + 1], depth + 1);
    }
    if (/^(?:npm|pnpm|yarn|bun)$/.test(program || '')) {
      if (['exec', 'x'].includes(args[0])) args.shift();
      else if (program === 'npm') return false;
      if (args[0] === '--') args.shift();
      [program, ...args] = args;
    }
    if (program === 'node') {
      while (args[0]?.startsWith('-') && args[0] !== '--') {
        const flag = args.shift();
        if (/^(?:--check|-c|--eval|-e|--print|-p|--version|-v|--help|-h)(?:=|$)/.test(flag)) return false;
        if (/^(?:--require|-r|--import|--loader|--experimental-loader|--title|--env-file|--max-old-space-size)$/.test(flag)) args.shift();
      }
      if (args[0] === '--') args.shift();
      [program, ...args] = args;
      if (!/(?:^|\/)(?:vitest(?:\.mjs)?|check-standards\.mjs)$|(?:^|\/)vitest\/dist\/cli\.js$/.test(program || '')) return false;
      if (/(?:^|\/)vitest\/dist\/cli\.js$/.test(program)) program = 'vitest';
    }
    program = program?.replace(/^.*\//, '');
    return /^(?:vitest(?:@\S*)?|vitest\.mjs|playwright(?:@\S*)?|check-standards(?:\.mjs)?)$/.test(program || '')
      && !args.some(arg => /^(?:--version|-v|--help|-h)$/.test(arg));
  });
}

export function findUngatedHeavySpawns(source, filename = 'source.mjs') {
  if (typeof source !== 'string') return [{ filename, line: 1, reason: 'Unreadable source; inspect manually before clearing admission lint' }];
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (file.parseDiagnostics.length) return [{ filename, line: 1, reason: 'Unreadable syntax; inspect manually before clearing admission lint' }];
  const bindings = new Map(), namespaces = new Set(), admission = new Map(), scopes = new Map();
  const scopeOf = node => {
    let scope = node.parent;
    while (scope && !ts.isBlock(scope) && !ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
    return scope;
  };
  const valueOf = node => {
    for (let scope = node.parent; scope; scope = scope.parent) {
      const values = scopes.get(scope);
      if (values?.has(node.text)) return values.get(node.text);
    }
  };
  const walk = (node, fn) => { fn(node); ts.forEachChild(node, child => walk(child, fn)); };
  walk(file, node => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const mod = node.moduleSpecifier.text;
      const named = node.importClause?.namedBindings;
      if (/^(?:node:)?child_process$/.test(mod)) {
        if (node.importClause?.name) namespaces.add(node.importClause.name.text);
        if (named && ts.isNamespaceImport(named)) namespaces.add(named.name.text);
        if (named && ts.isNamedImports(named)) for (const e of named.elements) {
          if (SPAWNS.has((e.propertyName || e.name).text)) bindings.set(e.name.text, (e.propertyName || e.name).text);
        }
      }
      if (/(?:^|\/)readiness\/heavy-admission\.mjs$/.test(mod) && named && ts.isNamedImports(named)) {
        for (const e of named.elements) if (['runUnderAdmission', 'admittedArgv'].includes((e.propertyName || e.name).text)) admission.set(e.name.text, (e.propertyName || e.name).text);
      }
    }
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && ts.isIdentifier(node.name)) {
      const scope = scopeOf(node);
      if (!scopes.has(scope)) scopes.set(scope, new Map());
      scopes.get(scope).set(node.name.text, node.initializer ?? null);
    }
  });
  walk(file, node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)) {
      const init = node.initializer;
      if (ts.isIdentifier(init.expression) && init.expression.text === 'promisify' && init.arguments[0] && ts.isIdentifier(init.arguments[0]) && bindings.has(init.arguments[0].text)) {
        bindings.set(node.name.text, bindings.get(init.arguments[0].text));
      }
    }
  });
  const helperCall = (node, name) => ts.isCallExpression(node) && ts.isIdentifier(node.expression)
    && admission.get(node.expression.text) === name && valueOf(node.expression) === undefined;
  const resolveValue = (node, seen = new Set()) => {
    if (!node || seen.has(node)) return undefined;
    if (ts.isParenthesizedExpression(node)) return resolveValue(node.expression, new Set([...seen, node]));
    if (!ts.isIdentifier(node)) return node;
    return resolveValue(valueOf(node), new Set([...seen, node]));
  };
  const admittedField = (node, name) => {
    const field = resolveValue(node);
    if (!field || !ts.isPropertyAccessExpression(field) || field.name.text !== name) return undefined;
    const origin = resolveValue(field.expression);
    return origin && helperCall(origin, 'admittedArgv') ? origin : undefined;
  };
  const inAdmissionCallback = node => {
    // Only the inline `exec` callback executes under the slot; sibling calls and
    // callbacks for other options are not evidence of admission for this spawn.
    for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
      if (!ts.isArrowFunction(ancestor) && !ts.isFunctionExpression(ancestor)) continue;
      const property = ancestor.parent;
      if (!ts.isPropertyAssignment(property) || property.initializer !== ancestor
        || !['exec'].includes(property.name.text)) continue;
      const object = property.parent, call = object.parent;
      if (ts.isObjectLiteralExpression(object) && ts.isCallExpression(call)
        && call.arguments[0] === object && helperCall(call, 'runUnderAdmission')) return true;
    }
    return false;
  };
  const literals = (node, seen = new Set()) => {
    if (!node) return '';
    if (ts.isStringLiteralLike(node) || [ts.SyntaxKind.TemplateHead, ts.SyntaxKind.TemplateMiddle, ts.SyntaxKind.TemplateTail].includes(node.kind)) return node.text;
    if (ts.isPropertyAccessExpression(node)) return literals(node.expression, seen);
    if (ts.isIdentifier(node)) {
      const value = valueOf(node);
      if (value && !seen.has(value)) return literals(value, new Set([...seen, value]));
      return '';
    }
    let text = '';
    ts.forEachChild(node, child => { text += ' ' + literals(child, seen); });
    return text;
  };
  const hits = [], spawns = [];
  walk(file, node => {
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    const spawn = ts.isIdentifier(callee) ? bindings.has(callee.text)
      : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
        && namespaces.has(callee.expression.text) && SPAWNS.has(callee.name.text);
    if (!spawn) return;
    spawns.push(node);
  });
  // Bind each real comment to exactly one call, including harmless/admitted calls.
  const allowed = new Set();
  const positions = spawns.map(node => ({ node, ...file.getLineAndCharacterOfPosition(node.getStart(file)) }));
  source.split(/\r?\n/).forEach((text, line) => {
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
    for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
      if (token !== ts.SyntaxKind.SingleLineCommentTrivia || !/^\/\/ heavy-admission-allow:\s*\S/.test(scanner.getTokenText())) continue;
      const start = scanner.getTokenPos();
      const standalone = !text.slice(0, start).trim();
      const owner = standalone ? positions.find(pos => pos.line === line + 1)
        : positions.filter(pos => pos.line === line && pos.character < start).at(-1);
      if (owner) allowed.add(owner.node);
    }
  });
  for (const node of spawns) {
    const callee = node.expression;
    const origin = admittedField(node.arguments[0], 'file');
    if ((origin && origin === admittedField(node.arguments[1], 'args')) || inAdmissionCallback(node)) continue;
    const method = ts.isIdentifier(callee) ? bindings.get(callee.text) : callee.name.text;
    // `process.execPath` (or `process.argv0`) is the running Node binary: spawnSync(process.execPath, ['--test', …]).
    const nodeBinary = (() => {
      const file = resolveValue(node.arguments[0]);
      return file && ts.isPropertyAccessExpression(file) && ts.isIdentifier(file.expression)
        && file.expression.text === 'process' && ['execPath', 'argv0'].includes(file.name.text);
    })();
    let command = nodeBinary ? 'node' : literals(node.arguments[0]).trim();
    const args = resolveValue(node.arguments[1]);
    if (!/^exec(?:Sync)?$/.test(method) && args && ts.isArrayLiteralExpression(args)) {
      command += ' ' + args.elements.map(arg => quote(literals(arg).trim())).join(' ');
    }
    if (!heavyCommand(command)) continue;
    const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line;
    if (allowed.has(node)) continue;
    hits.push({ filename, line: line + 1, reason: 'Heavy spawn requires runUnderAdmission/admittedArgv or a justified inline allowance' });
  }
  return hits;
}
