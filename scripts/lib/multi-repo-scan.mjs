/** Pure source contract scanner. Parsing excludes comments while preserving literal/template contents. */
import ts from 'typescript';

export const SCAN_ROOTS = ['scripts/conveyor', 'scripts/operations', 'skills-src/conveyor', 'scripts/lib'];
export function isScannedFile(file) {
  return SCAN_ROOTS.some((root) => file.startsWith(`${root}/`))
    && /\.(mjs|js|ts)$/.test(file)
    && !/(?:^|\/)(?:__tests__|__fixtures__|node_modules)(?:\/|$)|\.test\./.test(file);
}

export function scanMultiRepo(source) {
  const tree = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const findings = [];
  const printer = ts.createPrinter({ removeComments: true });
  const arrays = [];
  const scopeOf = (node) => {
    let scope = node.parent;
    while (scope && !ts.isBlock(scope) && !ts.isSourceFile(scope) && !ts.isFunctionLike(scope)) scope = scope.parent;
    return scope;
  };
  const resolveArray = (name, node) => {
    for (let scope = node; scope; scope = scope.parent) {
      const binding = arrays.find((entry) => entry.name === name && entry.scope === scope);
      if (binding) return binding.array;
      if (ts.isFunctionLike(scope) && scope.parameters.some((p) => p.name.getText(tree) === name)) return null;
    }
    return null;
  };
  const mutations = new Set();
  const literal = (node) => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
  const flagText = (node) => ts.isTemplateExpression(node) ? node.head.text : literal(node);
  const flag = (value) => typeof value === 'string' && /^(?:--repo(?:=|$)|-R$)/.test(value);
  const hasRepo = (array) => array.elements.some((e) => flag(flagText(e))
    || (ts.isSpreadElement(e) && ts.isIdentifier(e.expression) && /repo/i.test(e.expression.text)));
  const visit = (node, fn) => { fn(node); ts.forEachChild(node, (child) => visit(child, fn)); };
  const add = (node, rule) => findings.push({ rule, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1 });
  visit(tree, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isArrayLiteralExpression(node.initializer)) {
      arrays.push({ name: node.name.text, array: node.initializer, scope: scopeOf(node) });
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression) && ['push', 'splice'].includes(node.expression.name.text)
      && node.arguments.some((arg) => flag(flagText(arg)))) mutations.add(node.expression.expression.text);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isIdentifier(node.left) && ts.isArrayLiteralExpression(node.right)) {
      arrays.push({ name: node.left.text, array: node.right, scope: scopeOf(node) });
      if (node.right.elements.some((e) => ts.isSpreadElement(e) && ts.isIdentifier(e.expression) && e.expression.text === node.left.text)
        && hasRepo(node.right)) mutations.add(node.left.text);
    }
  });
  const explicitApi = (path) => ts.isTemplateExpression(path) && path.head.text === 'repos/'
    && path.templateSpans.some((span, i) => i === 0 && span.expression.getText(tree).trim()
      && !/\{owner\}|\{repo\}/.test(span.expression.getText(tree)));
  // Any array literal that LOOKS like gh argv (`['pr', …]` / `['api', 'repos/…']`) is checked wherever it flows —
  // handing it to an unrecognised helper (`ghRun`, `run`, a returned builder) must not hide a repo-less call.
  const repoInside = (array) => { let found = false; visit(array, (n) => { if (flag(flagText(n))) found = true; }); return found; };
  visit(tree, (node) => {
    if (ts.isArrayLiteralExpression(node)) {
      const [command, path] = node.elements;
      const api = literal(command) === 'api' && path
        && (literal(path)?.startsWith('repos/') || (ts.isTemplateExpression(path) && path.head.text.startsWith('repos/')));
      if (literal(command) === 'pr' || api) {
        let id = null;
        if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) id = node.parent.name.text;
        else if (ts.isBinaryExpression(node.parent) && ts.isIdentifier(node.parent.left)) id = node.parent.left.text;
        if (!hasRepo(node) && !repoInside(node) && !(id && mutations.has(id)) && !(api && explicitApi(path))) add(node, 'implicit-repo');
      }
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      const value = ts.isTemplateExpression(node) ? node.head.text + node.templateSpans.map((span) => '${'
        + printer.printNode(ts.EmitHint.Expression, span.expression, tree) + '}' + span.literal.text).join('') : node.text;
      const slugs = new RegExp('(?:web-everything/' + 'web-everything|frontier-ui/' + 'frontierui|plateauapp/' + 'plateau-app)');
      if (slugs.test(value)) add(node, 'repo-literal');
      // Only shell command strings, not diagnostic prose quoting CLI names.
      let parent = node.parent;
      while (parent && (ts.isBinaryExpression(parent) || ts.isParenthesizedExpression(parent))) parent = parent.parent;
      const shellCall = parent && ts.isCallExpression(parent)
        && /^(?:exec(?:File)?(?:Sync)?(?:Throttled)?|spawn(?:Sync)?|sh|j|run\w*)$/.test(parent.expression.getText(tree).split('.').at(-1));
      const commandValue = parent === node.parent
        && (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isArrayLiteralExpression(parent));
      if (!shellCall && !commandValue) return;
      if (ts.isArrayLiteralExpression(parent) && !/(?:^|[\n;&|])\s*gh\s/.test(value)) return;
      for (const match of value.matchAll(/\bgh\s+(pr\b|api\s+repos\/)[^\n;`&|]*/g)) {
        const command = match[0];
        if (/(?:^|\s)(?:--repo(?:=|\s|$)|-R(?:\s|$))/.test(command)) continue;
        if (match[1].startsWith('api') && /repos\/\$\{\s*[^}\s][^}]*\}\//.test(command)
          && !/(?<!\$)\{owner\}|(?<!\$)\{repo\}/.test(command)) continue;
        add(node, 'implicit-repo');
      }
    }
  });
  return findings;
}

/** Validate metadata separately from IO so malformed and stale exceptions can be tested directly. */
export function validateAllowlist(entries, sources) {
  const errors = [];
  if (!Array.isArray(entries)) return ['allowlist must be a JSON array'];
  const seen = new Set();
  for (const entry of entries) {
    const { file, reason } = entry ?? {};
    if (typeof file !== 'string' || !isScannedFile(file) || file.split('/').includes('..') || !sources.has(file)) {
      errors.push(`${file}: file must exist under a scanned root`);
    }
    if (seen.has(file)) errors.push(`${file}: duplicate file`);
    seen.add(file);
    const words = typeof reason === 'string' ? reason.replace(/[^a-z0-9]+/gi, ' ').toLowerCase().trim() : '';
    const filename = String(file).replace(/[^a-z0-9]+/gi, ' ').toLowerCase();
    if (typeof reason !== 'string' || reason.trim().length < 40 || /\b(todo|n\s*\/\s*a|legacy|because)\b/i.test(reason)
      || words.split(' ').filter((word) => !['this', 'file', 'is', 'for', 'the', 'a', 'an', 'only', 'by', 'design', 'implements', 'checks'].includes(word))
        .every((word) => filename.split(' ').includes(word))) errors.push(`${file}: specific reason required (40+ characters)`);
    if (sources.has(file) && scanMultiRepo(sources.get(file)).length === 0) errors.push(`${file}: remove this entry (no remaining violation)`);
  }
  return errors;
}
