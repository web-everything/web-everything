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
  const bindings = new Map();
  const walk = (node, fn) => { fn(node); ts.forEachChild(node, child => walk(child, fn)); };
  walk(file, node => { if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) bindings.set(node.name.text, node.initializer); });
  function value(node, seen = new Set()) {
    if (!node || seen.has(node)) return null;
    seen = new Set([...seen, node]);
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isIdentifier(node)) return value(bindings.get(node.text), seen);
    if (ts.isParenthesizedExpression(node)) return value(node.expression, seen);
    if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap(element => {
      const v = value(ts.isSpreadElement(element) ? element.expression : element, seen);
      return v === null ? ['__dynamic__'] : v;
    });
    if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map(span => `${value(span.expression, seen) ?? '__dynamic__'}${span.literal.text}`).join('');
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
    const name = ts.isIdentifier(node.expression) ? node.expression.text : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : '';
    if (!/^(?:spawn(?:Sync)?|exec(?:File)?(?:Sync)?|fork|admittedArgv|runUnderAdmission)$/.test(name)) return;
    const first = value(node.arguments[0]);
    let command = typeof first === 'string' ? first : null;
    const args = value(node.arguments[1]);
    if (command && Array.isArray(args)) command = [command, ...args].map(quote).join(' ');
    if (name === 'runUnderAdmission' && ts.isObjectLiteralExpression(node.arguments[0])) {
      const prop = node.arguments[0].properties.find(p => p.name?.getText(file) === 'command');
      command = value(prop?.initializer);
    }
    if (typeof command !== 'string') return;
    for (const reason of vitestWatchCommands(command)) findings.push({ line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, reason });
  });
  return findings;
}
