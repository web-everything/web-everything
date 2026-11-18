import ts from 'typescript';

/** AST-light guard: inspect call arguments, never comments, documentation or shell examples. */
export function findUnpinnedDiffReads(source, file = 'source.mjs') {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const failures = [];
  const report = (node, reason) => failures.push(`${file}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1}: ${reason}`);
  const nameOf = node => ts.isIdentifier(node) ? node.text : ts.isPropertyAccessExpression(node) ? node.name.text : '';
  const walk = node => {
    if (ts.isCallExpression(node)) {
      const name = nameOf(node.expression);
      if (/^(?:computeNetDiff(?:Text|Paths|ChangedFiles|Signals)|resolveNetDiffBasis)$/.test(name)) {
        const options = node.arguments[0];
        if (!options || !ts.isObjectLiteralExpression(options) ||
            !options.properties.some(p => nameOf(p.name ?? p) === 'basis') ||
            options.properties.some(p => ['rev', 'base', 'pinRev', 'fetchExtraRefs'].includes(nameOf(p.name ?? p)))) {
          report(node, `${name} evidence must take a basis object`);
        }
      }
      if (/^(?:computeNetDiff.*|resolveNetDiffBasis)ForDisplay$/.test(name)) report(node, 'display reader cannot supply gate evidence');
      for (const arg of node.arguments) {
        if (!ts.isArrayLiteralExpression(arg)) continue;
        const command = arg.elements[0];
        if (!command || !ts.isStringLiteral(command) || !['diff', 'log'].includes(command.text)) continue;
        if (command.text === 'log' && !arg.elements.some(e => ts.isStringLiteral(e) && ['-p', '--patch'].includes(e.text))) continue;
        // Mutable literal revisions and ranges cannot be evidence. Working-tree diffs
        // with no revisions are outside this two-tree contract.
        const stop = arg.elements.findIndex(e => ts.isStringLiteral(e) && e.text === '--');
        for (const element of arg.elements.slice(1, stop < 0 ? undefined : stop)) {
          if (ts.isStringLiteral(element) && /^(?:origin\/|refs\/(?:heads|remotes|tags)\/|main$|master$)|\.\.\./.test(element.text)) report(element, 'git evidence uses a mutable ref string');
          if (ts.isTemplateExpression(element) && /(?:origin\/|refs\/(?:heads|remotes|tags)\/|\.\.\.)/.test(element.getText(tree))) report(element, 'git evidence uses a mutable ref range');
        }
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(tree);
  return failures;
}
