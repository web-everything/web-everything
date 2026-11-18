/** Parser-based enforcement of the single agent execution boundary. Used by the structural test. */
import ts from 'typescript';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';

const primitives = /^(?:spawn(?:Sync|Fn|Process|ToCompletion(?:Fn)?)?|exec(?:File(?:Sync)?(?:Throttled)?|Sync|Fn)?|fork|run(?:Fn|Default)?|listing)$/;
const agent = /(?:^|[\s/\\;'"`|&()])(?:claude|codex)(?=$|[\s;'"`|&()])/;
const wrapper = /(?:^|[/\\])(?:(?:ba|z|da|k)?sh|cmd|powershell|env|nohup|command|exec|xargs|sudo|time|nice|setsid|stdbuf|arch|caffeinate|node)$/;
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
  // This is a may-execute analysis: a mutable binding retains every primitive it can ever hold,
  // regardless of source order, control flow, or a later safe assignment. Key by lexical declaration.
  const assignments = new Map();
  for (const file of files.values()) {
    const visit = node => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && ts.isIdentifier(node.left)) {
        const binding = declaration(node.left);
        if (binding) assignments.set(binding, [...(assignments.get(binding) ?? []), node.right]);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  function bindingExpression(binding, literal = false) {
    const keys = [];
    let owner = binding;
    while (ts.isBindingElement(owner)) {
      keys.unshift(owner.propertyName?.text ?? owner.name.text);
      owner = owner.parent.parent;
    }
    if (!owner.initializer || keys.some(k => k == null) || (literal && (!ts.isVariableDeclaration(owner) || !(owner.parent.flags & ts.NodeFlags.Const)))) return null;
    // Only inline object literals prove a destructured value; shared objects may mutate.
    return keys.reduce((source, key) => literal
      ? source && ts.isObjectLiteralExpression(source) && !source.properties.some(ts.isSpreadAssignment)
        ? source.properties.find(p => p.name?.text === key)?.initializer : null
      : ts.factory.createElementAccessExpression(source, ts.factory.createStringLiteral(key)), owner.initializer);
  }
  function values(node, seen = new Set()) {
    if (!node || seen.has(node)) return [null];
    seen = new Set(seen).add(node);
    if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return [node.text];
    if (ts.isIdentifier(node)) return values(declaration(node), seen);
    if (ts.isImportSpecifier(node) || ts.isImportClause(node)) return values(imported(node), seen);
    // Initializers/defaults do not prove the runtime value of mutable bindings or parameters.
    if (ts.isParameter(node)) return [null];
    if (ts.isVariableDeclaration(node)) return node.parent.flags & ts.NodeFlags.Const ? values(node.initializer, seen) : [null];
    if (ts.isBindingElement(node)) return values(bindingExpression(node, true), seen);
    if (ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node) || ts.isAsExpression(node)) return values(node.expression, seen);
    if (ts.isConditionalExpression(node)) return [...values(node.whenTrue, seen), ...values(node.whenFalse, seen)];
    if (ts.isBinaryExpression(node)) {
      const left = values(node.left, seen), right = values(node.right, seen);
      return node.operatorToken.kind === ts.SyntaxKind.PlusToken ? left.flatMap(l => right.map(r => l == null || r == null ? null : l + r)) : [...left, ...right];
    }
    if (ts.isTemplateExpression(node)) return node.templateSpans.reduce((out, s) => out.flatMap(prefix => values(s.expression, seen)
      .map(v => prefix == null || v == null ? null : prefix + v + s.literal.text)), [node.head.text]);
    if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap(e => values(ts.isSpreadElement(e) ? e.expression : e, seen));
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return [null];
    if (ts.isCallExpression(node)) {
      const d = ts.isIdentifier(node.expression) ? declaration(node.expression) : null;
      // Calls to a local argv/command builder (and Object.freeze) retain its literal command evidence.
      if (node.expression.getText() === 'Object.freeze') return values(node.arguments[0], seen);
      if (d?.body) return returns(d.body).flatMap(r => values(r, seen));
      if ((d && ts.isImportSpecifier(d))) { const target = imported(d); if (target?.body) return returns(target.body).flatMap(r => values(r, seen)); }
    }
    if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return returns(node.body).flatMap(r => values(r, seen));
    return [null];
  }
  function returns(body) {
    if (!body) return [];
    if (!ts.isBlock(body)) return [body];
    const out = [];
    const visit = n => { if (ts.isReturnStatement(n)) out.push(n.expression); else if (!ts.isFunctionLike(n)) ts.forEachChild(n, visit); };
    ts.forEachChild(body, visit);
    return out;
  }
  function isPrimitive(node, seen = new Set(), allowDynamic = true) {
    if (!node || seen.has(node)) return false;
    seen.add(node);
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) return isPrimitive(node.expression, seen, allowDynamic);
    if (ts.isCallExpression(node)) return isPrimitive(node.expression, seen, allowDynamic);
    if (ts.isPropertyAccessExpression(node)) {
      // Method derivation needs a known primitive, not an arbitrary computed logger/callback.
      if (/^(?:bind|call|apply)$/.test(node.name.text)) return isPrimitive(node.expression, seen, false);
      let receiver = node.expression;
      if (ts.isIdentifier(receiver)) { const d = declaration(receiver); receiver = d?.parent.flags & ts.NodeFlags.Const ? d.initializer : null; }
      if (receiver && (ts.isRegularExpressionLiteral(receiver) || (ts.isNewExpression(receiver) && receiver.expression.getText() === 'RegExp'))) return false;
      return primitives.test(node.name.text);
    }
    if (ts.isElementAccessExpression(node)) return values(node.argumentExpression).some(v => (v == null && allowDynamic) || primitives.test(v)
      || (/^(?:bind|call|apply)$/.test(v) && isPrimitive(node.expression, new Set(seen), false)));
    if (ts.isIdentifier(node)) {
      if (primitives.test(node.text)) return true;
      const d = declaration(node);
      // Assignment taint needs primitive provenance, as method derivation does above: an arbitrary
      // runtime-selected callback is not evidence that this binding holds an execution primitive.
      if (assignments.get(d)?.some(n => isPrimitive(n, new Set(seen), false))) return true;
      if ((d && ts.isImportSpecifier(d))) return primitives.test(d.propertyName?.text ?? d.name.text);
      if (d && ts.isBindingElement(d)) return isPrimitive(d.initializer, seen, allowDynamic) || isPrimitive(bindingExpression(d), seen, allowDynamic);
      if (d && (ts.isVariableDeclaration(d) || ts.isParameter(d))) return isPrimitive(d.initializer, seen, allowDynamic);
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
        const unresolved = !command.length || command.includes(null);
        const dynamicMember = ts.isElementAccessExpression(n.expression) && values(n.expression.argumentExpression).includes(null);
        const wrapped = (dynamicMember || command.some(c => wrapper.test(c))) && values(n.arguments[1]).some(c => c == null || agent.test(c));
        if (unresolved || command.some(c => agent.test(c)) || wrapped) findings.push({ file: name,
          line: file.getLineAndCharacterOfPosition(n.getStart()).line + 1, kind: n.expression.getText(file),
          classification: unresolved ? 'unresolved' : 'resolved',
          fingerprint: JSON.stringify([command, values(n.arguments[1]), ...n.arguments.slice(0, 2).map(a => a.getText(file))]),
          reason: unresolved ? 'unresolved command; cannot establish launch boundary' : 'agent execution outside agent-launch.mjs' });
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
