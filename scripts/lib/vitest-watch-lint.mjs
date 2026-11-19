/** Static invocation lint; comments, documentation strings and test fixtures are not executable sites. */
import ts from 'typescript';
import { parseSegments, shellTokens, heredocScan, commandSubstitutionBodies } from '../guard-bash.mjs';

/** Inspect shell commands, including queue wrappers and nested shells. */
export function vitestWatchCommands(command, depth = 0) {
  if (depth > 8 || command.length > 1024 * 1024) return ['command exceeds lint bound; inspect manually'];
  const findings = [];
  const inspect = words => {
    while (/^[A-Za-z_][\w]*=/.test(words[0] || '')) words.shift();
    const base = value => (value || '').split('/').at(-1);
    let head = base(words.shift());
    if (head === 'env') { while (words[0]?.startsWith('-') || /^[A-Za-z_]\w*=/.test(words[0] || '')) words.shift(); return inspect(words); }
    if (['npx', 'npm', 'pnpm', 'yarn', 'bun'].includes(head)) {
      if (head === 'npm' && !['exec', 'x'].includes(words[0])) return;
      if (['exec', 'x', 'dlx'].includes(words[0])) words.shift();
      while (words[0]?.startsWith('-')) words.shift();
      head = base(words.shift());
    }
    if (['sh', 'bash', 'zsh'].includes(head)) {
      const index = words.findIndex(w => /^-[^-]*c/.test(w));
      if (index >= 0 && words[index + 1]) findings.push(...vitestWatchCommands(words[index + 1], depth + 1));
      return;
    }
    if (head === 'node' || head === 'nodejs') { while (words[0]?.startsWith('-')) words.shift(); head = base(words.shift()); }
    if (head === 'heavy-admission.mjs') { const index = words.indexOf('--'); if (index >= 0) inspect(words.slice(index + 1)); return; }
    if (!/^vitest(?:@[^/]+|\.mjs)?$/.test(head || '') && !(head === 'cli.js' && command.includes('vitest/dist/cli.js'))) return;
    const args = words.slice(0, words.indexOf('--') < 0 ? undefined : words.indexOf('--'));
    if (!args.some(w => ['run', '--run', '--watch=false'].includes(w)) || args.some(w => ['--watch', '--watch=true', '-w'].includes(w))) findings.push(command);
  };
  const code = heredocScan(command).text;
  for (const segment of parseSegments(code).segments) inspect(shellTokens(segment).filter(t => !t.op).map(t => t.text));
  for (const body of commandSubstitutionBodies(code)) findings.push(...vitestWatchCommands(body, depth + 1));
  return findings;
}

/** Inspect only process/wrapper call arguments, resolving literal variables and argv arrays. */
export function findVitestWatchInvocations(source, filename = 'scripts/source.mjs') {
  if (typeof source !== 'string') return [{ line: 1, reason: 'unreadable invocation source' }];
  if (filename.endsWith('.sh')) return vitestWatchCommands(source).map(reason => ({ line: 1, reason }));
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (file.parseDiagnostics.length) return [{ line: 1, reason: 'unparseable invocation source' }];
  // The TypeScript binder models block/function scope, parameters, hoisting and
  // shadowing. No disk/module resolution is needed to resolve local symbols.
  const program = ts.createProgram([filename], { allowJs: true, noLib: true, noResolve: true }, {
    getSourceFile: name => name === filename ? file : undefined,
    getDefaultLibFileName: () => '', writeFile: () => {}, getCurrentDirectory: () => '',
    getDirectories: () => [], fileExists: name => name === filename,
    readFile: name => name === filename ? source : undefined,
    getCanonicalFileName: name => name, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
  });
  const checker = program.getTypeChecker();
  const binding = node => ts.isIdentifier(node) ? checker.getSymbolAtLocation(node) : undefined;
  const initializer = symbol => {
    const declarations = symbol?.declarations;
    return declarations?.length === 1 && ts.isVariableDeclaration(declarations[0]) ? declarations[0].initializer : undefined;
  };
  const walk = (node, fn) => { fn(node); ts.forEachChild(node, child => walk(child, fn)); };
  const mutated = new Set();
  function invalidate(node, seen = new Set()) {
    if (!node || seen.has(node)) return;
    seen.add(node);
    if (ts.isIdentifier(node)) {
      const symbol = binding(node);
      if (symbol) { mutated.add(symbol); invalidate(initializer(symbol), seen); }
    } else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isParenthesizedExpression(node)) {
      invalidate(node.expression, seen);
    } else if (ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node)) {
      ts.forEachChild(node, child => invalidate(child, seen));
    } else if (ts.isSpreadElement(node)) invalidate(node.expression, seen);
    else if (ts.isPropertyAssignment(node)) invalidate(node.initializer, seen);
    else if (ts.isShorthandPropertyAssignment(node)) invalidate(node.name, seen);
  }
  const invocationName = node => ts.isIdentifier(node.expression) ? node.expression.text : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : '';
  const processCall = name => /^(?:spawn(?:Sync)?|exec(?:File)?(?:Sync)?|fork|admittedArgv|runUnderAdmission)$/.test(name);
  walk(file, node => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) invalidate(node.left);
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) invalidate(node.operand);
    if (ts.isDeleteExpression(node)) invalidate(node.expression);
    if (ts.isForOfStatement(node) || ts.isForInStatement(node)) invalidate(node.initializer);
    if (ts.isCallExpression(node)) {
      // Any method may mutate its receiver. Escaping argv to an unknown call is
      // equally unprovable. Invalidation follows aliases back to their source.
      if (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression)) invalidate(node.expression.expression);
      if (!processCall(invocationName(node))) for (const arg of node.arguments) invalidate(arg);
    }
  });
  function value(node, seen = new Set()) {
    if (!node || seen.has(node)) return null;
    seen = new Set([...seen, node]);
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isIdentifier(node)) { const symbol = binding(node); return mutated.has(symbol) ? null : value(initializer(symbol), seen); }
    if (ts.isParenthesizedExpression(node)) return value(node.expression, seen);
    if (ts.isArrayLiteralExpression(node)) {
      const result = [];
      for (const element of node.elements) {
        const v = value(ts.isSpreadElement(element) ? element.expression : element, seen);
        if (v === null || (ts.isSpreadElement(element) && !Array.isArray(v))) return null;
        result.push(...(Array.isArray(v) ? v : [v]));
      }
      return result;
    }
    if (ts.isTemplateExpression(node)) {
      let result = node.head.text;
      for (const span of node.templateSpans) {
        const v = value(span.expression, seen);
        if (typeof v !== 'string') return null;
        result += v + span.literal.text;
      }
      return result;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = value(node.left, seen), right = value(node.right, seen);
      return typeof left === 'string' && typeof right === 'string' ? left + right : null;
    }
    return null;
  }
  const findings = [];
  const quote = word => "'" + String(word).replaceAll("'", "'\\''") + "'";
  walk(file, node => {
    if (!ts.isCallExpression(node)) return;
    const name = invocationName(node);
    if (!processCall(name)) return;
    const first = value(node.arguments[0]);
    let command = typeof first === 'string' ? first : null;
    const args = value(node.arguments[1]);
    if (command && Array.isArray(args)) command = [command, ...args].map(quote).join(' ');
    if (name === 'runUnderAdmission' && ts.isObjectLiteralExpression(node.arguments[0])) {
      const prop = node.arguments[0].properties.find(p => p.name?.getText(file) === 'command');
      command = value(prop?.initializer);
    }
    if (typeof command !== 'string' || (node.arguments[1] && !/^exec(?:Sync)?$/.test(name) && !Array.isArray(args))) {
      findings.push({ line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, reason: 'unresolved process invocation; cannot exclude Vitest watch mode' });
      return;
    }
    for (const reason of vitestWatchCommands(command)) findings.push({ line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, reason });
  });
  return findings;
}
