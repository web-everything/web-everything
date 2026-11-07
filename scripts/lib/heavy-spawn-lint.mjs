/** Static admission lint for literal heavy child_process commands. No code is executed. */
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { canonicalCommand, commandSubstitutionBodies, parseSegments, shellCString, shellTokens, ungatedHeavyRunKind } from '../guard-bash.mjs';

const SPAWNS = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

// Bounds on command-substitution extraction; past either one the command fails closed (treated as heavy).
const SUBSTITUTION_MAX_CHARS = 16384;
const SUBSTITUTION_MAX_BODIES = 64;

/** This repository's package scripts, or null when package.json cannot be read (callers then fail closed). */
let repoScripts;
function packageScripts() {
  if (repoScripts !== undefined) return repoScripts;
  try {
    const scripts = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).scripts;
    repoScripts = scripts && typeof scripts === 'object' ? scripts : null;
  } catch { repoScripts = null; }
  return repoScripts;
}

const RUNNER_OPTS_WITH_VALUE = new Set(['--prefix', '-C', '--dir', '--cwd', '--workspace', '-w', '--filter', '-F',
  '--loglevel', '--userconfig', '--globalconfig', '--registry', '--cache', '--script-shell', '--reporter']);
/** The package script a runner head starts (`npm run x`, `npm run-script x`, `pnpm x`, `yarn x`, `bun run x`), or null. */
function packageScriptName(words) {
  const runner = (words[0] || '').replace(/^.*\//, '').replace(/@.*$/, '');
  if (!/^(?:npm|pnpm|yarn|bun)$/.test(runner)) return null;
  let i = 1;
  const skipFlags = () => { while (words[i]?.startsWith('-') && words[i] !== '--') i += RUNNER_OPTS_WITH_VALUE.has(words[i]) ? 2 : 1; };
  skipFlags();
  if (['run', 'run-script', 'rum', 'urn'].includes(words[i])) { i += 1; skipFlags(); return words[i] ?? null; }
  return runner === 'npm' ? null : words[i] ?? null; // pnpm/yarn/bun also run a script named bare
}

/** Inspect executable positions only; arguments to ordinary programs are data.
 *  `substitutions` is true only for text a shell parses: a substitution body (the extractor already returned its
 *  nested bodies, so re-extracting them would grow combinatorially) and plain argv (nothing expands) skip it.
 *  `scripts` is the package script table a `npm run <name>` resolves through (null: unreadable, fail closed). */
function heavyCommand(command, { depth = 0, substitutions = true, scripts = packageScripts() } = {}) {
  if (depth > 8) return true; // fail closed on implausibly deep nesting
  const inner = (text, subs = true) => heavyCommand(text, { depth: depth + 1, substitutions: subs, scripts });
  // A shell expands `$( … )` / backticks before running the outer command, so their bodies are executed too.
  if (substitutions) {
    if (command.length > SUBSTITUTION_MAX_CHARS) return true;
    // Openers bound the body count from above; checking them first keeps a deep nest off the quadratic extractor.
    if ((command.match(/\$\(|`/g) || []).length > SUBSTITUTION_MAX_BODIES * 4) return true;
    let bodies;
    try { bodies = commandSubstitutionBodies(command); } catch { return true; } // stack overflow on a pathological nest
    if (bodies.length > SUBSTITUTION_MAX_BODIES) return true;
    if (bodies.some(body => inner(body, false))) return true;
  }
  return parseSegments(command).segments.some(segment => {
    // The Bash guard's own classifier first: package test scripts (`npm test`, `npm --prefix . test`, `pnpm t`),
    // `node --test`, vitest and check-standards heads. The checks below add playwright and `sh -c` bodies.
    if (ungatedHeavyRunKind(segment)) return true;
    // `sh -c "…"` as the inner shell receives it (escaped quotes resolved, any nesting depth).
    const shellC = shellCString(segment);
    if (shellC) return inner(shellC.text);
    const words = shellTokens(canonicalCommand(segment)).filter(word => !word.op).map(word => word.text);
    // Any package script whose own body is an unqueued heavy run (`npm run test:bun:scripts` → `npx bun test`).
    const script = packageScriptName(words);
    if (script !== null) {
      if (scripts && typeof scripts[script] === 'string' && inner(scripts[script])) return true;
      if (!scripts && /^(?:test|t|tst)(?::|$)/.test(script) && script !== 'test:unit') return true;
    }
    let [program, ...args] = words;
    if (/^(?:ba|da|z|k)?sh$/.test(program || '')) return false; // a script file, not a `-c` string
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

/** `scripts` overrides the package script table (tests); by default this repository's package.json is read. */
export function findUngatedHeavySpawns(source, filename = 'source.mjs', { scripts = packageScripts() } = {}) {
  if (typeof source !== 'string') return [{ filename, line: 1, reason: 'Unreadable source; inspect manually before clearing admission lint' }];
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (file.parseDiagnostics.length) return [{ filename, line: 1, reason: 'Unreadable syntax; inspect manually before clearing admission lint' }];
  const bindings = new Map(), namespaces = new Set(), admission = new Map(), scopes = new Map();
  const processNames = new Set(['process']), processBinaryNames = new Set();
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
      // `import process from 'node:process'`, `import * as p from 'process'`, `import { execPath } from 'node:process'`.
      if (/^(?:node:)?process$/.test(mod)) {
        if (node.importClause?.name) processNames.add(node.importClause.name.text);
        if (named && ts.isNamespaceImport(named)) processNames.add(named.name.text);
        if (named && ts.isNamedImports(named)) for (const e of named.elements) {
          if (['execPath', 'argv0'].includes((e.propertyName || e.name).text)) processBinaryNames.add(e.name.text);
        }
      }
      if (/(?:^|\/)readiness\/heavy-admission\.mjs$/.test(mod) && named && ts.isNamedImports(named)) {
        for (const e of named.elements) if (['runUnderAdmission', 'admittedArgv'].includes((e.propertyName || e.name).text)) admission.set(e.name.text, (e.propertyName || e.name).text);
      }
    }
    // A destructured name (`const { execPath } = process`) is bound to its BindingElement.
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) && ts.isIdentifier(node.name)) {
      const scope = scopeOf(node);
      if (!scopes.has(scope)) scopes.set(scope, new Map());
      scopes.get(scope).set(node.name.text, ts.isBindingElement(node) ? node : node.initializer ?? null);
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
  // The running Node binary, however it is spelled: `process.execPath`, `process['argv0']`, `process.argv[0]`,
  // `globalThis.process.execPath`, an alias of one, or `const { execPath } = process`.
  const keyOf = node => (node && (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) ? node.text : undefined);
  const memberOf = node => (ts.isPropertyAccessExpression(node) ? node.name.text
    : ts.isElementAccessExpression(node) ? keyOf(node.argumentExpression) : undefined);
  const isProcess = (node, seen) => {
    if (!node || seen.has(node)) return false;
    seen.add(node);
    if (ts.isParenthesizedExpression(node)) return isProcess(node.expression, seen);
    if (ts.isIdentifier(node)) {
      const value = valueOf(node);
      return value === undefined ? processNames.has(node.text) : !!value && isProcess(value, seen);
    }
    return memberOf(node) === 'process' && ts.isIdentifier(node.expression) && node.expression.text === 'globalThis';
  };
  const NODE_BINARY_KEYS = ['execPath', 'argv0'];
  const nodeBinary = (node, seen = new Set()) => {
    if (!node || seen.has(node)) return false;
    seen.add(node);
    if (ts.isParenthesizedExpression(node)) return nodeBinary(node.expression, seen);
    if (ts.isIdentifier(node)) {
      const value = valueOf(node);
      return value === undefined ? processBinaryNames.has(node.text) : !!value && nodeBinary(value, seen);
    }
    if (ts.isBindingElement(node)) {
      const pattern = node.parent, declaration = pattern?.parent;
      return ts.isObjectBindingPattern(pattern) && NODE_BINARY_KEYS.includes(keyOf(node.propertyName || node.name))
        && ts.isVariableDeclaration(declaration) && isProcess(declaration.initializer, seen);
    }
    if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return false;
    const member = memberOf(node);
    if (NODE_BINARY_KEYS.includes(member)) return isProcess(node.expression, seen);
    return member === '0' && memberOf(node.expression) === 'argv' && isProcess(node.expression.expression, seen);
  };
  const literals = (node, seen = new Set()) => {
    if (!node) return '';
    if (nodeBinary(node)) return 'node';
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
    // `literals` spells the running Node binary (`process.execPath`, …) as `node`.
    let command = literals(node.arguments[0]).trim();
    const args = resolveValue(node.arguments[1]);
    // exec/execSync always run a shell; spawn/execFile do with a truthy `shell` option, joining argv unquoted.
    const options = node.arguments.slice(1, 3).map(arg => resolveValue(arg)).find(arg => arg && ts.isObjectLiteralExpression(arg));
    const shellOption = options?.properties.some(prop => ts.isPropertyAssignment(prop) && keyOf(prop.name) === 'shell'
      && prop.initializer.kind !== ts.SyntaxKind.FalseKeyword && !(ts.isStringLiteralLike(prop.initializer) && !prop.initializer.text));
    const shell = /^exec(?:Sync)?$/.test(method) || (method !== 'fork' && !!shellOption);
    if (!/^exec(?:Sync)?$/.test(method) && args && ts.isArrayLiteralExpression(args)) {
      // A spread of a resolvable array literal contributes its elements, not one joined word.
      const flat = (elements, seen) => elements.flatMap(el => {
        if (!ts.isSpreadElement(el)) return [el];
        const spread = resolveValue(el.expression);
        return spread && ts.isArrayLiteralExpression(spread) && !seen.has(spread) ? flat(spread.elements, new Set([...seen, spread])) : [el];
      });
      command += ' ' + flat(args.elements, new Set([args])).map(arg => (shell ? literals(arg).trim() : quote(literals(arg).trim()))).join(' ');
    }
    // Plain argv reaches no shell, so its words are data: no substitution scan and no substitution bounds.
    if (!heavyCommand(command, { substitutions: shell, scripts })) continue;
    const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line;
    if (allowed.has(node)) continue;
    hits.push({ filename, line: line + 1, reason: 'Heavy spawn requires runUnderAdmission/admittedArgv or a justified inline allowance' });
  }
  return hits;
}
