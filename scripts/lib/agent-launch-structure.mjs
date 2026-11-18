/** Parser-based enforcement of the single agent execution boundary. Used by the structural test. */
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';

const primitives = /^(?:spawn(?:Sync|Fn|Process|ToCompletion(?:Fn)?)?|exec(?:File(?:Sync)?(?:Throttled)?|Sync|Fn)?|fork|run(?:Fn|Default)?|listing)$/;
const agent = /(?:^|[^\w-])(?:claude|codex)(?=$|[^\w-])/;
const wrapper = /(?:^|[/\\])(?:(?:ba|z|da|k)?sh|cmd|powershell|env|nohup|command|exec|xargs|sudo|time|nice|setsid|stdbuf|arch|caffeinate|node|npx|npm|pnpm|yarn|bun)$/;
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
  function exported(file, name, seen = new Set()) {
    const key = `${file.fileName}:${name}`;
    if (seen.has(key)) return null;
    seen.add(key);
    for (const statement of file.statements) {
      if (name === 'default' && ts.isExportAssignment(statement)) return statement.expression;
      if (name === 'default' && ts.isFunctionDeclaration(statement)
        && statement.modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword)) return statement;
      if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        const specifier = statement.exportClause.elements.find(e => e.name.text === name);
        if (!specifier) continue;
        const original = specifier.propertyName?.text ?? specifier.name.text;
        if (!statement.moduleSpecifier) {
          if (original !== name) return exported(file, original, seen);
          continue;
        }
        const target = files.get(resolve(dirname(file.fileName), statement.moduleSpecifier.text));
        return target ? exported(target, original, seen)
          : primitives.test(original) ? ts.factory.createIdentifier(original) : null;
      }
    }
    for (const statement of file.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement;
      if (ts.isVariableStatement(statement)) {
        const found = statement.declarationList.declarations.find(d => d.name?.text === name);
        if (found) return found;
      }
      if (ts.isImportDeclaration(statement)) {
        const clause = statement.importClause;
        if (clause?.name?.text === name) return clause;
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          const found = clause.namedBindings.elements.find(e => e.name.text === name);
          if (found) return found;
        }
      }
    }
    return null;
  }
  const imported = (decl, member) => {
    let imp = decl;
    while (imp && !ts.isImportDeclaration(imp)) imp = imp.parent;
    if (!imp || !ts.isStringLiteral(imp.moduleSpecifier)) return null;
    const file = files.get(resolve(dirname(imp.getSourceFile().fileName), imp.moduleSpecifier.text));
    const name = member ?? (ts.isImportClause(decl) ? 'default' : decl.propertyName?.text ?? decl.name?.text);
    if (!file) return null;
    return exported(file, name);
  };
  const declaration = node => {
    const symbol = node.parent && ts.isShorthandPropertyAssignment(node.parent)
      ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node);
    return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  };
  function importedMember(receiver, member, seen = new Set()) {
    if (!receiver || seen.has(receiver)) return null;
    seen.add(receiver);
    if (ts.isIdentifier(receiver)) {
      const d = declaration(receiver);
      if (d && ts.isNamespaceImport(d)) return imported(d, member);
      if (d && ts.isImportClause(d)) return importedMember(imported(d), member, seen);
      if (d && ts.isVariableDeclaration(d)) return importedMember(d.initializer, member, seen);
    }
    if (ts.isObjectLiteralExpression(receiver)) {
      const property = receiver.properties.find(p => p.name?.text === member);
      return property && ts.isShorthandPropertyAssignment(property) ? property.name : property?.initializer;
    }
    return null;
  }
  // This is a may-execute analysis: a mutable binding retains every primitive it can ever hold,
  // regardless of source order, control flow, or a later safe assignment. Key by lexical declaration.
  const assignments = new Map(), bindingWrites = new Map();
  for (const file of files.values()) {
    const visit = node => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        if (ts.isIdentifier(node.left)) {
          const binding = declaration(node.left);
          if (binding) assignments.set(binding, [...(assignments.get(binding) ?? []), node.right]);
        }
        const record = left => {
          if (ts.isIdentifier(left)) {
            const binding = declaration(left);
            if (binding) bindingWrites.set(binding, [...(bindingWrites.get(binding) ?? []), node]);
          }
          ts.forEachChild(left, record);
        };
        record(node.left);
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
    if (ts.isConditionalExpression(node)) return [node.whenTrue, node.whenFalse].some(n => isPrimitive(n, new Set(seen), false));
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) {
      return [node.left, node.right].some(n => isPrimitive(n, new Set(seen), false));
    }
    if (ts.isCallExpression(node)) return isPrimitive(node.expression, seen, allowDynamic);
    if (ts.isPropertyAccessExpression(node)) {
      // Method derivation needs a known primitive, not an arbitrary computed logger/callback.
      if (/^(?:bind|call|apply)$/.test(node.name.text)) return isPrimitive(node.expression, seen, false);
      let receiver = node.expression;
      if (ts.isIdentifier(receiver)) { const d = declaration(receiver); receiver = d?.parent.flags & ts.NodeFlags.Const ? d.initializer : null; }
      if (receiver && (ts.isRegularExpressionLiteral(receiver) || (ts.isNewExpression(receiver) && receiver.expression.getText() === 'RegExp'))) return false;
      return primitives.test(node.name.text) || isPrimitive(importedMember(node.expression, node.name.text), seen, allowDynamic);
    }
    if (ts.isElementAccessExpression(node)) return values(node.argumentExpression).some(v => (v == null && allowDynamic) || primitives.test(v)
      || (v != null && isPrimitive(importedMember(node.expression, v), new Set(seen), allowDynamic))
      || (/^(?:bind|call|apply)$/.test(v) && isPrimitive(node.expression, new Set(seen), false)));
    if (ts.isIdentifier(node)) {
      if (primitives.test(node.text)) return true;
      const d = declaration(node);
      // Assignment taint needs primitive provenance, as method derivation does above: an arbitrary
      // runtime-selected callback is not evidence that this binding holds an execution primitive.
      if (assignments.get(d)?.some(n => isPrimitive(n, new Set(seen), false))) return true;
      if (d && ts.isImportSpecifier(d)) return primitives.test(d.propertyName?.text ?? d.name.text) || isPrimitive(imported(d), seen, allowDynamic);
      if (d && ts.isImportClause(d)) return isPrimitive(imported(d), seen, allowDynamic);
      if (d && ts.isBindingElement(d)) return isPrimitive(d.initializer, seen, allowDynamic) || isPrimitive(bindingExpression(d), seen, allowDynamic);
      if (d && (ts.isVariableDeclaration(d) || ts.isParameter(d))) return isPrimitive(d.initializer, seen, allowDynamic);
    }
    if (ts.isVariableDeclaration(node)) return isPrimitive(node.initializer, seen, allowDynamic);
    if (ts.isImportSpecifier(node)) return primitives.test(node.propertyName?.text ?? node.name.text) || isPrimitive(imported(node), seen, allowDynamic);
    if (ts.isImportClause(node)) return isPrimitive(imported(node), seen, allowDynamic);
    return false;
  }
  // A mutable/unresolved value still has a definition. Pin its source, every possible assignment,
  // and transitive initializer dependencies rather than granting an exemption to the call text alone.
  function bindingEvidence(args) {
    const evidence = [], seen = new Set(), visitedNodes = new Set();
    const visitTarget = target => {
      if (!target || visitedNodes.has(target)) return;
      if (target.pos >= 0) evidence.push([relative(process.cwd(), target.getSourceFile().fileName).split('\\').join('/'),
        'import-target', target.getText()]);
      visit(target);
    };
    const visit = node => {
      if (visitedNodes.has(node)) return;
      visitedNodes.add(node);
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const members = ts.isPropertyAccessExpression(node) ? [node.name.text] : values(node.argumentExpression);
        for (const member of members) {
          const target = member != null && importedMember(node.expression, member);
          visitTarget(target);
        }
      }
      if (ts.isIdentifier(node)) {
        const d = declaration(node);
        if (d && !seen.has(d) && (ts.isVariableDeclaration(d) || ts.isParameter(d) || ts.isBindingElement(d)
          || ts.isImportSpecifier(d) || ts.isImportClause(d) || ts.isNamespaceImport(d) || ts.isFunctionDeclaration(d))) {
          seen.add(d);
          let owner = d;
          while (ts.isBindingElement(owner)) owner = owner.parent.parent;
          if (ts.isImportSpecifier(d) || ts.isImportClause(d) || ts.isNamespaceImport(d)) {
            while (owner.parent && !ts.isImportDeclaration(owner)) owner = owner.parent;
          }
          const writes = bindingWrites.get(d) ?? [];
          evidence.push([relative(process.cwd(), d.getSourceFile().fileName).split('\\').join('/'),
            d.name?.getText(), owner.getText(), writes.map(n => n.getText())]);
          if (owner.initializer) visit(owner.initializer);
          for (const write of writes) visit(write.right);
          if (ts.isImportSpecifier(d) || ts.isImportClause(d)) {
            visitTarget(imported(d));
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    for (const arg of args) visit(arg);
    return evidence;
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
        const argumentsEvidence = n.arguments.flatMap(a => values(a));
        const wrapped = (dynamicMember || command.some(c => wrapper.test(c))) && values(n.arguments[1]).includes(null);
        const definitions = bindingEvidence(n.arguments);
        if (unresolved || argumentsEvidence.some(c => c != null && agent.test(c)) || wrapped) findings.push({ file: name,
          line: file.getLineAndCharacterOfPosition(n.getStart()).line + 1, kind: n.expression.getText(file),
          classification: unresolved ? 'unresolved' : 'resolved',
          // Hash the complete definition/assignment text to keep the checked-in migration table small.
          fingerprint: JSON.stringify([command, values(n.arguments[1]), ...n.arguments.map(a => a.getText(file)),
            ...(definitions.length ? [`bindings-sha256:${createHash('sha256').update(JSON.stringify(definitions)).digest('hex')}`] : [])]),
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
