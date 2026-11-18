import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Parsing discards comments without confusing comment-like bytes in strings or regular expressions.
function checkGitProcessSites(source, module) {
  const file = ts.createSourceFile(module, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (file.parseDiagnostics.length) throw Error('unparseable source');
  const violations = [];
  let runnerSites = 0, ghSites = 0;
  function visit(node, owner) {
    if (ts.isFunctionDeclaration(node)) owner = node.name?.text;
    if (ts.isCallExpression(node)) {
      const callee = ts.isIdentifier(node.expression) ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : '';
      const first = node.arguments[0];
      const command = first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) ? first.text : '';
      const processCall = /^(exec|execFile|execFileSync|execSync|spawn|spawnSync|run)$/.test(callee);
      // Regex.exec is a text parser; a literal git command still catches child_process.exec.
      const parserCall = callee === 'exec' && ts.isPropertyAccessExpression(node.expression) && !/^git(?:\s|$)/.test(command);
      if (processCall && !parserCall) {
        if (module === 'numbering-carry.mjs' && owner === 'numberingGitRunner'
          && callee === 'run' && command === 'git') runnerSites++;
        else if (module === 'human-only-enqueue-license.mjs' && callee === 'exec' && command === 'gh'
          && node.arguments[1]?.getText(file) === "['pr', 'view', String(pr), '--repo', repo, '--json', 'headRefOid,labels']") ghSites++;
        else violations.push(node.getText(file));
      }
    }
    ts.forEachChild(node, child => visit(child, owner));
  }
  visit(file);
  return { violations, runnerSites, ghSites };
}

describe('hardened Git runner structural boundary', () => {
  it.each(['numbering-carry.mjs', 'human-only-enqueue-license.mjs'])('allows only the owned process sites in %s', module => {
    const source = readFileSync(`scripts/lib/${module}`, 'utf8');
    expect(checkGitProcessSites(source, module)).toEqual({ violations: [],
      runnerSites: module === 'numbering-carry.mjs' ? 1 : 0,
      ghSites: module === 'human-only-enqueue-license.mjs' ? 1 : 0 });
  });
  it.each(['exec', 'execFileSync', 'spawn', 'spawnSync', 'execSync', 'run'])('detects an inline %s bypass despite comments', callee => {
    for (const module of ['numbering-carry.mjs', 'human-only-enqueue-license.mjs']) {
      const sample = `// run('git', []) is only a comment\nfunction proveNumberingWithRunner() { ${callee}(/* hidden */ 'git', ['cat-file']); }`;
      expect(checkGitProcessSites(sample, module).violations).toHaveLength(1);
    }
  });
  it('rejects a second runner bypass and ignores comments and regex parsing', () => {
    const sample = `function numberingGitRunner() { run('git', []); }
      /* execFileSync('git', []) */
      function proveNumberingOnlyMove() { /git/.exec('subject'); execFileSync('git', []); }`;
    expect(checkGitProcessSites(sample, 'numbering-carry.mjs')).toMatchObject({ runnerSites: 1,
      violations: ["execFileSync('git', [])"] });
  });
});
