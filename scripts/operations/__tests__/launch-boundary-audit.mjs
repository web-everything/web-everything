import ts from 'typescript';

const boundaries = new Map([
  ['defaultSpawnAgent', 1], ['execGuardedFixer', 2], ['spawnFixerToCompletion', 2],
  ['spawnAgentToCompletion', 1], ['defaultSpawnCodexAgent', 1],
]);

/** Lexical alias resolution, including imports, binding patterns, assignments and injected defaults.
 * Unknown descriptor expressions fail closed: forwarding wrappers must expose mode/launchGuard explicitly.
 */
export function auditLaunchBoundaries(file, source) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const scopes = new Map();
  const owner = node => {
    for (let n = node; n; n = n.parent) if (ts.isSourceFile(n) || ts.isFunctionLike(n) || ts.isBlock(n)) return n;
    return ast;
  };
  const define = (scope, name, value) => {
    if (!scopes.has(scope)) scopes.set(scope, new Map());
    const bindings = scopes.get(scope);
    bindings.set(name, [...(bindings.get(name) ?? []), value]);
  };
  const lookup = (node, name) => {
    for (let n = node; n; n = n.parent) if (scopes.get(n)?.has(name)) return scopes.get(n).get(name);
    return null;
  };
  const property = node => ts.isPropertyAccessExpression(node) ? node.name.text
    : ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : null;
  const bind = (name, value, scope) => {
    if (ts.isIdentifier(name)) define(scope, name.text, value);
    else if (ts.isObjectBindingPattern(name)) for (const element of name.elements) {
      const key = element.propertyName?.text ?? element.name.text;
      bind(element.name, element.initializer ?? (boundaries.has(key) ? { boundary: key } : null), scope);
    }
  };
  const collect = node => {
    if (ts.isImportSpecifier(node)) define(ast, node.name.text, { boundary: node.propertyName?.text ?? node.name.text });
    if (ts.isVariableDeclaration(node)) bind(node.name, node.initializer, owner(node.parent));
    if (ts.isParameter(node)) bind(node.name, node.initializer, node.parent);
    if (ts.isFunctionDeclaration(node) && node.name) define(owner(node.parent), node.name.text, { boundary: node.name.text });
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
      let scope = owner(node);
      for (let n = node.parent; n; n = n.parent) if (scopes.get(n)?.has(node.left.text)) { scope = n; break; }
      define(scope, node.left.text, node.right);
    }
    ts.forEachChild(node, collect);
  };
  collect(ast);
  const resolve = (node, seen = new Set()) => {
    if (!node || seen.has(node)) return null;
    if (Array.isArray(node)) return node.map(value => resolve(value, new Set(seen))).find(Boolean) ?? null;
    if (node.boundary) return boundaries.has(node.boundary) ? node.boundary : null;
    seen.add(node);
    if (ts.isIdentifier(node)) return resolve(lookup(node, node.text) ?? (boundaries.has(node.text) ? { boundary: node.text } : null), seen);
    const key = property(node);
    if (boundaries.has(key)) return key;
    if (key) {
      const binding = ts.isIdentifier(node.expression) ? lookup(node, node.expression.text) : node.expression;
      const object = Array.isArray(binding) ? binding.find(value => value && ts.isObjectLiteralExpression(value)) : binding;
      if (object && ts.isObjectLiteralExpression(object)) {
        const member = object.properties.find(p => p.name?.text === key);
        return resolve(member?.initializer ?? member?.name, seen);
      }
    }
    if (ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node)) return resolve(node.expression, seen);
    // A default-parameter forwarding lambda is itself an injected spawn boundary.
    if (ts.isArrowFunction(node) && ts.isCallExpression(node.body) && node.parameters.length >= 2) return resolve(node.body.expression, seen);
    return null;
  };
  const shape = (node, seen = new Set()) => {
    if (!node || seen.has(node)) return new Set();
    if (Array.isArray(node)) {
      const alternatives = node.filter(Boolean).map(value => shape(value, new Set(seen)));
      return new Set([...(alternatives[0] ?? [])].filter(key => alternatives.every(keys => keys.has(key))));
    }
    seen.add(node);
    if (ts.isIdentifier(node)) return shape(lookup(node, node.text), seen);
    if (!ts.isObjectLiteralExpression(node)) return new Set();
    const keys = new Set();
    for (const p of node.properties) {
      if (ts.isSpreadAssignment(p)) for (const key of shape(p.expression, seen)) keys.add(key);
      else if (p.name?.text) keys.add(p.name.text);
    }
    return keys;
  };
  const calls = [], references = [], failures = [];
  const visit = node => {
    const target = resolve(node);
    if (target && (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))) {
      const parent = node.parent;
      // A member name is part of its enclosing reference, not another standalone use.
      if (!(ts.isPropertyAccessExpression(parent) && parent.name === node)) {
        references.push(`${target}:${node.getText(ast)}`);
      }
    }
    if (ts.isCallExpression(node)) {
      const target = resolve(node.expression);
      if (target) {
        const site = `${target}:${node.expression.getText(ast)}`;
        calls.push(site);
        const keys = shape(node.arguments[boundaries.get(target)]);
        if (!keys.has('mode') || !keys.has('launchGuard')) failures.push(`${file}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}: ${site} needs explicit mode and launchGuard`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return { calls, references, failures };
}
