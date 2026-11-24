/** Static raw-push boundary: inspect syntax only, never execute the source. */
import ts from 'typescript';

const SPAWNS = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);
const GLOBAL_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env',
  '--exec-path', '--bare', '--no-pager', '--paginate', '--no-replace-objects', '--literal-pathspecs',
  '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--no-optional-locks']);
const SHELL_PUSH = /\bgit\s+(?:-\S+\s+(?:\S+\s+)?)*push\b/;

/** Paths come from git ls-files; reject paths outside the tracked scripts shape. */
export function isLintedScript(path) {
  return typeof path === 'string' && /^scripts\/(?:[^/]+\/)*[^/]+\.mjs$/.test(path)
    && !path.includes('\\')
    && !path.split('/').some(part => ['.', '..', '__tests__'].includes(part))
    && !path.endsWith('.test.mjs') && path !== 'scripts/lib/authorized-push.mjs';
}

/** One site per matching call; line numbers are one-based. Invalid source refuses clearance. */
export function findRawPushes(source, filename = 'scripts/source.mjs') {
  if (typeof source !== 'string') return [{ line: 1, kind: 'unreadable-source' }];
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (file.parseDiagnostics.length) return [{ line: 1, kind: 'invalid-syntax' }];
  const sites = [];
  const staticText = node => {
    if (ts.isStringLiteralLike(node)) return node.text;
    // Keep interpolation boundaries: dynamic values cannot fabricate static command text.
    if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map(span => span.literal.text)].join('${}');
    return undefined;
  };
  const scanArgs = elements => {
    for (let i = 0; i < elements.length; i++) {
      const node = elements[i], text = staticText(node);
      if (text !== undefined && SHELL_PUSH.test(text)) return 'shell';
      if (ts.isStringLiteral(node) && text === 'push') {
        const previous = i ? staticText(elements[i - 1]) : undefined;
        if (!previous?.startsWith('-') || GLOBAL_FLAGS.has(previous)) return 'argv';
      }
      if (ts.isArrayLiteralExpression(node)) {
        const kind = scanArgs(node.elements);
        if (kind) return kind;
      }
    }
  };
  const visit = node => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text
        : ts.isPropertyAccessExpression(callee) ? callee.name.text
          : ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression) ? callee.argumentExpression.text : '';
      if (SPAWNS.has(name) || /^(git|run|sh)/i.test(name)) {
        const kind = scanArgs(node.arguments);
        if (kind) sites.push({ line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, kind });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return sites;
}
