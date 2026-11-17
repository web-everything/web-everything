/** Parser-based enforcement of the single agent execution boundary. Used by the structural test. */
import ts from 'typescript';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';

const primitives = /^(?:spawn(?:Sync|Fn|Process|ToCompletion(?:Fn)?)?|exec(?:File(?:Sync)?(?:Throttled)?|Sync|Fn)?|fork|run(?:Fn|Default)?|listing)$/;
const agent = /(?:^|[\s/;'"`|&()])(?:claude|codex)(?=$|[\s;'"`|&()])/;
const shell = /(?:^|\/)(?:ba|z|da|k)?sh$|^(?:cmd|powershell)$/;
export const AGENT_LAUNCH_ALLOWLIST = Object.freeze(['scripts/lib/agent-launch.mjs']);

/** Scan source strings, resolving lexical aliases, constants, defaults and imported bindings with the TS parser. */
export function findAgentLaunches(sources) {
  const files = new Map(Object.entries(sources).map(([name, text]) => [resolve(name), ts.createSourceFile(resolve(name), text, ts.ScriptTarget.Latest, true,
    /\.tsx?$/.test(name) ? ts.ScriptKind.TS : ts.ScriptKind.JS)]));
  const host = {
    getSourceFile: name => files.get(resolve(name)), getDefaultLibFileName: () => '', writeFile() {},
    getCurrentDirectory: () => process.cwd(), getDirectories: () => [], fileExists: name => files.has(resolve(name)),
    readFile: name => files.get(resolve(name))?.text, getCanonicalFileName: n => n, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
  };
  const program = ts.createProgram([...files.keys()], { allowJs: true, noResolve: true, noLib: true }, host);
  const checker = program.getTypeChecker();
  const findings = [];
  const imported = (decl) => {
    let imp = decl;
    while (imp && !ts.isImportDeclaration(imp)) imp = imp.parent;
    if (!imp || !ts.isStringLiteral(imp.moduleSpecifier)) return null;
    const file = files.get(resolve(dirname(imp.getSourceFile().fileName), imp.moduleSpecifier.text));
    const name = decl.propertyName?.text ?? decl.name?.text;
    if (!file) return null;
    let found = null;
    const visit = n => { if ((ts.isVariableDeclaration(n) || ts.isFunctionDeclaration(n)) && n.name?.text === name) found = n; ts.forEachChild(n, visit); };
    visit(file);
    return found;
  };
  const declaration = node => checker.getSymbolAtLocation(node)?.valueDeclaration ?? checker.getSymbolAtLocation(node)?.declarations?.[0];
  function values(node, seen = new Set()) {
    if (!node || seen.has(node)) return [];
    seen = new Set(seen).add(node);
    if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return [node.text];
    if (ts.isIdentifier(node)) return values(declaration(node), seen);
    if (ts.isImportSpecifier(node) || ts.isImportClause(node)) return values(imported(node), seen);
    if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) {
      if (node.initializer) return values(node.initializer, seen);
      if (ts.isBindingElement(node) && ts.isVariableDeclaration(node.parent.parent)) {
        return property(node.parent.parent.initializer, node.propertyName?.text ?? node.name.text, seen);
      }
      return [];
    }
    if (ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node) || ts.isAsExpression(node)) return values(node.expression, seen);
    if (ts.isConditionalExpression(node)) return [...values(node.whenTrue, seen), ...values(node.whenFalse, seen)];
    if (ts.isBinaryExpression(node)) {
      const left = values(node.left, seen), right = values(node.right, seen);
      return node.operatorToken.kind === ts.SyntaxKind.PlusToken ? left.flatMap(l => right.map(r => l + r)) : [...left, ...right];
    }
    if (ts.isTemplateExpression(node)) return [node.head.text + node.templateSpans.map(s => `${values(s.expression, seen)[0] ?? '*'}${s.literal.text}`).join('')];
    if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap(e => values(ts.isSpreadElement(e) ? e.expression : e, seen));
    if (ts.isPropertyAccessExpression(node)) return property(node.expression, node.name.text, seen);
    if (ts.isElementAccessExpression(node)) return values(node.argumentExpression, seen).flatMap(p => property(node.expression, p, seen));
    if (ts.isCallExpression(node)) {
      const d = ts.isIdentifier(node.expression) ? declaration(node.expression) : null;
      // Calls to a local argv/command builder (and Object.freeze) retain its literal command evidence.
      if (node.expression.getText() === 'Object.freeze') return values(node.arguments[0], seen);
      if (d?.body) return returns(d.body).flatMap(r => values(r, seen));
      if ((d && ts.isImportSpecifier(d))) { const target = imported(d); if (target?.body) return returns(target.body).flatMap(r => values(r, seen)); }
    }
    if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return returns(node.body).flatMap(r => values(r, seen));
    return [];
  }
  function returns(body) {
    if (!body) return [];
    if (!ts.isBlock(body)) return [body];
    const out = [];
    const visit = n => { if (ts.isReturnStatement(n)) out.push(n.expression); else if (!ts.isFunctionLike(n)) ts.forEachChild(n, visit); };
    ts.forEachChild(body, visit);
    return out;
  }
  function property(node, name, seen) {
    if (!node || seen.has(node)) return [];
    seen = new Set(seen).add(node);
    if (ts.isIdentifier(node)) return property(declaration(node), name, seen);
    if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) return property(node.initializer, name, seen);
    if (ts.isCallExpression(node)) {
      if (node.expression.getText() === 'Object.freeze') return property(node.arguments[0], name, seen);
      const d = ts.isIdentifier(node.expression) ? declaration(node.expression) : null;
      if (d?.body) return returns(d.body).flatMap(r => property(r, name, seen));
    }
    if (ts.isObjectLiteralExpression(node)) return node.properties.flatMap(p => ts.isSpreadAssignment(p) ? property(p.expression, name, seen)
      : (p.name?.text === name || name === '*') ? values(p.initializer ?? p.name, seen) : []);
    if (ts.isImportSpecifier(node)) return property(imported(node), name, seen);
    if (ts.isArrayLiteralExpression(node) && /^\d+$/.test(name)) return values(node.elements[Number(name)], seen);
    return [];
  }
  function isPrimitive(node, seen = new Set()) {
    if (!node || seen.has(node)) return false;
    seen.add(node);
    if (ts.isPropertyAccessExpression(node)) return primitives.test(node.name.text);
    if (ts.isElementAccessExpression(node)) return values(node.argumentExpression).some(v => primitives.test(v));
    if (ts.isIdentifier(node)) {
      if (primitives.test(node.text)) return true;
      const d = declaration(node);
      if ((d && ts.isImportSpecifier(d))) return primitives.test(d.propertyName?.text ?? d.name.text);
      if (d && (ts.isVariableDeclaration(d) || ts.isParameter(d) || ts.isBindingElement(d))) return isPrimitive(d.initializer, seen);
    }
    return false;
  }
  for (const [name, file] of files) {
    if (AGENT_LAUNCH_ALLOWLIST.includes(relative(process.cwd(), name).split('\\').join('/'))) continue;
    if (file.parseDiagnostics.length) {
      findings.push({ file: name, line: 1, reason: 'unparseable source; cannot establish launch boundary' });
      continue;
    }
    const visit = n => {
      if (ts.isCallExpression(n) && isPrimitive(n.expression)) {
        const command = values(n.arguments[0]);
        const shellCommand = command.some(c => shell.test(c)) && values(n.arguments[1]).some(c => agent.test(c));
        if (command.some(c => agent.test(c)) || shellCommand) findings.push({ file: name,
          line: file.getLineAndCharacterOfPosition(n.getStart()).line + 1, kind: n.expression.getText(file), reason: 'agent execution outside agent-launch.mjs' });
      }
      ts.forEachChild(n, visit);
    };
    visit(file);
  }
  return findings;
}

/** No ignored production subtrees: only test sources and their fixture directories are omitted. */
export function readAgentLaunchTree(root) {
  const sources = {};
  const walk = dir => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, e.name);
      if (e.isDirectory() && !['__tests__', 'node_modules', 'fixtures', '__fixtures__'].includes(e.name)) walk(file);
      else if (e.isFile() && /\.(?:mjs|cjs|js|ts|tsx)$/.test(e.name) && !/\.(?:test|spec)\./.test(e.name)) sources[file] = readFileSync(file, 'utf8');
    }
  };
  for (const dir of ['scripts', 'skills-src']) walk(join(root, dir));
  return sources;
}
