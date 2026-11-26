import ts from 'typescript';

/** Inspect JS/TS producers and shell commands in briefs without executing repository code.
 * Unknown argument objects or spreads after head fail closed; dynamic head values are
 * checked by the unconditional runtime validator before any comment can be posted.
 */
export function inspectStandDownPosters(path, text) {
  const missing = [];
  let callers = 0;
  const record = (valid, line) => {
    callers++;
    if (!valid) missing.push(`${path}:${line}`);
  };
  const command = (value, line) => {
    // Match invocations, not references to the module or commands without a PR argument.
    for (const match of value.replace(/\\\r?\n/g, ' ').matchAll(/stand-down\.mjs["'`]?\s+([^\n`]+)/g)) {
      if (!/^(?:\d|\{\{|\$\{|<pr>|--reason)/.test(match[1])) continue;
      const head = /--head=("[^"]+"|'[^']+'|[^\s`]+)/.exec(match[1])?.[1];
      record(Boolean(head && !/^(?:undefined|null|""|'')$/.test(head)), line);
    }
  };
  if (path.endsWith('.md')) {
    command(text, 1);
    return { callers, missing };
  }
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const aliases = new Set(['buildStandDownComment']);
  const declarations = new Map();
  const walk = (node, fn) => { fn(node); ts.forEachChild(node, child => walk(child, fn)); };
  walk(source, node => {
    if (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === 'buildStandDownComment') aliases.add(node.name.text);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (node.parent.flags & ts.NodeFlags.Const)) declarations.set(node.name.text, node.initializer);
  });
  const isBuilder = node => ts.isIdentifier(node) ? aliases.has(node.text)
    : ts.isPropertyAccessExpression(node) && node.name.text === 'buildStandDownComment'
      || ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === 'buildStandDownComment';
  // Resolve chains of imported/local aliases and destructured namespace members.
  for (let pass = 0; pass <= declarations.size; pass++) {
    for (const [name, value] of declarations) if (isBuilder(value)) aliases.add(name);
  }
  walk(source, node => {
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)) {
      for (const entry of node.name.elements) if ((entry.propertyName ?? entry.name).getText(source) === 'buildStandDownComment' && ts.isIdentifier(entry.name)) aliases.add(entry.name.text);
    }
  });
  for (let pass = 0; pass <= declarations.size; pass++) {
    for (const [name, value] of declarations) if (isBuilder(value)) aliases.add(name);
  }
  const valueIsHead = (value, seen = new Set()) => {
    if (!value || value.kind === ts.SyntaxKind.NullKeyword) return false;
    if (ts.isIdentifier(value)) {
      if (['undefined', 'NaN'].includes(value.text)) return false;
      if (declarations.has(value.text) && !seen.has(value.text)) return valueIsHead(declarations.get(value.text), new Set([...seen, value.text]));
      return true;
    }
    if (ts.isStringLiteralLike(value)) return /^[a-f0-9]{40}$/i.test(value.text) && value.text.length === 40;
    if (ts.isNumericLiteral(value) || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(value.kind)) return false;
    if (ts.isCallExpression(value) && ts.isPropertyAccessExpression(value.expression)
      && value.expression.name.text === 'repeat' && ts.isStringLiteralLike(value.expression.expression)
      && ts.isNumericLiteral(value.arguments[0])) {
      const count = Number(value.arguments[0].text);
      return count <= 40 && /^[a-f0-9]{40}$/i.test(value.expression.expression.text.repeat(count));
    }
    return true;
  };
  const objectHead = (arg, seen = new Set()) => {
    if (arg && ts.isIdentifier(arg) && declarations.has(arg.text) && !seen.has(arg.text)) return objectHead(declarations.get(arg.text), new Set([...seen, arg.text]));
    if (!arg || !ts.isObjectLiteralExpression(arg)) return false;
    let valid = false;
    for (const property of arg.properties) {
      // A later spread can overwrite a previously valid head, including with undefined.
      if (ts.isSpreadAssignment(property)) valid = objectHead(property.expression, seen);
      else if (property.name && (property.name.text ?? property.name.getText(source)) === 'head') {
        valid = ts.isPropertyAssignment(property) ? valueIsHead(property.initializer) : ts.isShorthandPropertyAssignment(property) && valueIsHead(property.name);
      }
    }
    return valid;
  };
  walk(source, node => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    if (ts.isCallExpression(node) && isBuilder(node.expression)) record(objectHead(node.arguments[0]), line);
    if (ts.isArrayLiteralExpression(node) && node.elements[0] && /stand-down\.mjs/.test(node.elements[0].getText(source)) && node.elements[1] && (!ts.isStringLiteralLike(node.elements[1]) || /^\d+$/.test(node.elements[1].text)) && (ts.isCallExpression(node.elements[0]) || /^['"`][^\s]+stand-down\.mjs['"`]$/.test(node.elements[0].getText(source)))) {
      // The script path may itself be join(ROOT, 'scripts', 'conveyor', 'stand-down.mjs').
      const head = node.elements.find(e => /^['"`]--head=/.test(e.getText(source)));
      record(Boolean(head && !/^['"]--head=(?:undefined|null)?['"]$/.test(head.getText(source))), line);
    }
    if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) command(node.getText(source).slice(1, -1).replace(/\\`/g, '`'), line);
  });
  return { callers, missing };
}

export function requireStandDownPosters(results) {
  if (!results.some(r => r.callers > 0)) throw new Error('no stand-down callers recognized; inventory is incomplete');
  return results.flatMap(r => r.missing);
}
