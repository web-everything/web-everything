/** Parser-based enforcement of the single agent execution boundary. Used by the structural test. */
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { isBuiltin } from 'node:module';
import { agentShellEvidence } from './agent-launch.mjs';

const primitives = /^(?:spawn(?:Sync|Fn|Process|ToCompletion(?:Fn)?)?|exec(?:File(?:Sync)?(?:Throttled)?|Sync|Fn)?|fork|run(?:Fn|Default)?|listing)$/;
const agent = /(?:^|[^\w-])(?:claude|codex)(?=$|[^\w-])/;
const wrapper = /(?:^|[/\\])(?:(?:ba|z|da|k)?sh|cmd|powershell|env|nohup|command|exec|xargs|sudo|time|nice|setsid|stdbuf|arch|caffeinate|node|npx|npm|pnpm|yarn|bun)$/;
const executionModule = /^(?:execa|cross-spawn|shelljs|zx|node-pty|tinyexec|nano-spawn|foreground-child|@npmcli\/promise-spawn)(?:\/|$)/;
const executionBuiltin = /^(?:node:)?(?:child_process|worker_threads|cluster|vm|process)(?:\/|$)/;
const benignModule = name => typeof name === 'string' && isBuiltin(name) && !executionBuiltin.test(name);
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
        return target ? exported(target, original, seen) : specifier;
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
  const childProcess = /^(?:node:)?child_process$/;
  const functionNode = n => n && (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n)
    || ts.isArrowFunction(n) || ts.isMethodDeclaration(n));
  function importSource(decl) {
    while (decl && !ts.isImportDeclaration(decl)) decl = decl.parent;
    return decl?.moduleSpecifier?.text;
  }
  function unwrap(node) {
    while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
      || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node))) node = node.expression;
    return node;
  }
  function processNamespace(node, seen = new Set(), literalOnly = false) {
    node = unwrap(node);
    if (!node || seen.has(node)) return false;
    seen.add(node);
    if (ts.isIdentifier(node)) {
      const d = declaration(node);
      if (!d || literalOnly && bindingWrites.has(d)) return false;
      if (ts.isImportClause(d) || ts.isNamespaceImport(d)) return childProcess.test(importSource(d))
        && (!literalOnly || ts.isNamespaceImport(d));
      if (ts.isVariableDeclaration(d)) return processNamespace(d.initializer, seen, literalOnly);
    }
    return !literalOnly && ts.isCallExpression(node) && node.expression.getText() === 'require'
      && !declaration(node.expression) && childProcess.test(node.arguments[0]?.text);
  }
  // This predicate identifies literal primitive REFERENCES, not arbitrary callables with matching
  // names. Everything else must prove it is unrelated below; uncertainty never becomes clearance.
  function isPrimitive(node, seen = new Set()) {
    node = unwrap(node);
    if (!node || seen.has(node)) return false;
    seen = new Set(seen).add(node);
    if (ts.isIdentifier(node)) {
      const d = declaration(node);
      if (!d) return false;
      if (assignments.get(d)?.some(n => isPrimitive(n, seen))) return true;
      return isPrimitive(d, seen);
    }
    if (ts.isConditionalExpression(node)) return [node.whenTrue, node.whenFalse].some(n => isPrimitive(n, seen));
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) return [node.left, node.right].some(n => isPrimitive(n, seen));
    if (ts.isExportSpecifier(node)) {
      const module = node.parent.parent.moduleSpecifier?.text;
      return childProcess.test(module) && primitives.test(node.propertyName?.text ?? node.name.text);
    }
    if (ts.isImportSpecifier(node)) {
      const target = imported(node);
      return target ? isPrimitive(target, seen)
        : childProcess.test(importSource(node)) && primitives.test(node.propertyName?.text ?? node.name.text);
    }
    if (ts.isImportClause(node)) return isPrimitive(imported(node), seen);
    if (ts.isBindingElement(node)) return isPrimitive(node.initializer, seen) || isPrimitive(bindingExpression(node), seen);
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) return isPrimitive(node.initializer, seen);
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const members = ts.isPropertyAccessExpression(node) ? [node.name.text] : values(node.argumentExpression);
      return members.some(member => member != null && (/^(?:bind|call|apply)$/.test(member) && isPrimitive(node.expression, seen)
        || processNamespace(node.expression) && primitives.test(member)
        || isPrimitive(importedMember(node.expression, member), seen)));
    }
    return false;
  }
  function literalPrimitive(node, seen = new Set()) {
    node = unwrap(node);
    if (!node || seen.has(node)) return false;
    seen = new Set(seen).add(node);
    if (ts.isIdentifier(node)) {
      const d = declaration(node);
      if (!d) return false;
      if (bindingWrites.has(d)) return false;
      if (ts.isImportSpecifier(d)) {
        const name = d.propertyName?.text ?? d.name.text;
        return childProcess.test(importSource(d)) && primitives.test(name) && name;
      }
      if (ts.isVariableDeclaration(d)) return literalPrimitive(d.initializer, seen);
      if (ts.isBindingElement(d)) return literalPrimitive(bindingExpression(d), seen);
      return false;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const members = ts.isPropertyAccessExpression(node) ? [node.name.text] : values(node.argumentExpression);
      return processNamespace(node.expression, new Set(), true) && members.length === 1 && members[0] != null
        && primitives.test(members[0]) && members[0];
    }
    return false;
  }
  const unrelatedCaches = [new Map(), new Map()];
  const safeGlobals = new Set(['console', 'Math', 'JSON', 'Object', 'Array', 'String', 'Number',
    'Boolean', 'Date', 'RegExp', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Buffer']);
  function valueReference(n) {
    const p = n.parent;
    if (!p) return true;
    if ((ts.isPropertyAccessExpression(p) && p.name === n) || ((ts.isPropertyAssignment(p)
      || ts.isMethodDeclaration(p)) && p.name === n && !ts.isComputedPropertyName(n))) return false;
    if ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p)
      || functionNode(p) || ts.isClassDeclaration(p)) && p.name === n) return false;
    return !ts.isImportSpecifier(p) && !ts.isImportClause(p) && !ts.isNamespaceImport(p)
      && !ts.isExportSpecifier(p) && !ts.isLabeledStatement(p);
  }
  // Structural proof, deliberately conservative: opaque parameters, call results, cycles, shared
  // object members and unmodelled syntax require review. No alias-enumeration escape hatch.
  function unrelated(node, seen = new Set(), agentArguments = false) {
    node = unwrap(node);
    if (!node || seen.has(node)) return false;
    const unrelatedCache = unrelatedCaches[Number(agentArguments)];
    if (unrelatedCache.has(node)) return unrelatedCache.get(node);
    seen = new Set(seen).add(node);
    let safe = false;
    if (isPrimitive(node)) return false;
    if (ts.isIdentifier(node)) {
      const d = declaration(node);
      safe = d ? unrelated(d, seen, agentArguments) : safeGlobals.has(node.text);
      if (assignments.has(d)) safe &&= assignments.get(d).every(n => unrelated(n, seen, agentArguments));
      if (bindingWrites.has(d) && !assignments.has(d)) safe = false;
    } else if (ts.isExportSpecifier(node)) {
      const source = node.parent.parent.moduleSpecifier?.text;
      safe = benignModule(source) || !agentArguments && !childProcess.test(source) && !executionModule.test(source);
    } else if (ts.isImportSpecifier(node) || ts.isImportClause(node) || ts.isNamespaceImport(node)) {
      const target = imported(node);
      // Only benign builtins prove an unresolved import cannot launch an agent. Other imports
      // require review with agent arguments; process-exec modules require review for any args.
      const source = importSource(node);
      safe = target ? unrelated(target, seen, agentArguments)
        : benignModule(source) || !agentArguments && !childProcess.test(source) && !executionModule.test(source);
    } else if (ts.isVariableDeclaration(node)) {
      safe = unrelated(node.initializer, seen, agentArguments) && (assignments.get(node) ?? []).every(n => unrelated(n, seen, agentArguments))
        && !(bindingWrites.get(node)?.some(n => !ts.isIdentifier(n.left)));
    } else if (ts.isBindingElement(node)) {
      safe = unrelated(bindingExpression(node, true), seen, agentArguments);
    } else if (functionNode(node)) {
      safe = true;
      const inspect = n => {
        if (!safe) return;
        if (ts.isCallExpression(n) && !unrelatedCall(n, seen, agentArguments)) safe = false;
        if ((ts.isIdentifier(n) || ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n))
          && valueReference(n) && isPrimitive(n)) safe = false;
        ts.forEachChild(n, inspect);
      };
      if (node.body) inspect(node.body); else safe = false;
    } else if (ts.isConditionalExpression(node)) {
      safe = unrelated(node.whenTrue, seen, agentArguments) && unrelated(node.whenFalse, seen, agentArguments);
    } else if (ts.isBinaryExpression(node) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) {
      safe = unrelated(node.left, seen, agentArguments) && unrelated(node.right, seen, agentArguments);
    } else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const members = ts.isPropertyAccessExpression(node) ? [node.name.text] : values(node.argumentExpression);
      safe = !members.includes(null) && members.every(member => {
        const target = importedMember(node.expression, member);
        return target ? unrelated(target, seen, agentArguments) : unrelated(node.expression, seen, agentArguments);
      });
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)
      && node.expression.text === 'RegExp' && !declaration(node.expression)) safe = true;
    else if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) || ts.isRegularExpressionLiteral(node)) safe = true;
    // Cache completed proofs only; encountering a recursive dependency returns unknown above.
    // No provisional safe assumption can escape a cycle.
    unrelatedCache.set(node, safe);
    return safe;
  }
  function unrelatedCall(node, seen = new Set(), agentArguments = false) {
    // Resolve the callee first. Benign/inspected APIs need no argument expansion; only a binding
    // whose proof depends on the absence of agent words needs command evidence.
    return unrelated(node.expression, seen) && (unrelated(node.expression, seen, true)
      || !(agentArguments || hasAgentArguments(node.arguments)));
  }
  function hasAgentArguments(args) {
    const seen = new Set();
    const visit = node => {
      node = unwrap(node);
      if (!node || seen.has(node)) return false;
      seen.add(node);
      // Argument evidence follows values, not arbitrary referenced function/type bodies.
      if (functionNode(node) || ts.isParameter(node)) return false;
      if (values(node).some(value => value != null && agent.test(agentShellEvidence(value).unquoted))) return true;
      if (ts.isIdentifier(node)) return visit(declaration(node));
      if (ts.isImportSpecifier(node) || ts.isImportClause(node)) return visit(imported(node));
      if (ts.isVariableDeclaration(node)) return visit(node.initializer);
      if (ts.isObjectLiteralExpression(node)) return node.properties.some(visit);
      if (ts.isPropertyAssignment(node)) return visit(node.initializer);
      if (ts.isShorthandPropertyAssignment(node)) return visit(node.name);
      if (ts.isArrayLiteralExpression(node)) return node.elements.some(visit);
      if (ts.isSpreadAssignment(node) || ts.isSpreadElement(node)) return visit(node.expression);
      if (ts.isConditionalExpression(node)) return visit(node.whenTrue) || visit(node.whenFalse);
      if (ts.isBinaryExpression(node)) return visit(node.left) || visit(node.right);
      if (ts.isTemplateExpression(node)) return node.templateSpans.some(span => visit(span.expression));
      if (ts.isCallExpression(node)) return node.arguments.some(visit);
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const members = ts.isPropertyAccessExpression(node) ? [node.name.text] : values(node.argumentExpression);
        return members.some(member => member != null && visit(importedMember(node.expression, member)));
      }
      return false;
    };
    return args.some(visit);
  }
  function literalOptions(node, seen = new Set()) {
    node = unwrap(node);
    if (!node || seen.has(node)) return null;
    seen.add(node);
    if (ts.isIdentifier(node)) return literalOptions(declaration(node), seen);
    if (ts.isVariableDeclaration(node)) return node.parent.flags & ts.NodeFlags.Const && !bindingWrites.has(node)
      ? literalOptions(node.initializer, seen) : null;
    return node;
  }
  function mayUseShell(args) {
    const second = literalOptions(args[1]);
    const option = args[2] ?? (second && ts.isArrayLiteralExpression(second) ? undefined : args[1]);
    if (!option) return false;
    const object = literalOptions(option);
    if (!object || !ts.isObjectLiteralExpression(object)) return true;
    // Spreads/computed keys/accessors can override shell:false. Unknown evidence is shell-capable.
    if (object.properties.some(p => !ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)
      || p.name && ts.isComputedPropertyName(p.name))) return true;
    const shell = object.properties.findLast(p => p.name?.text === 'shell');
    return shell ? shell.initializer?.kind !== ts.SyntaxKind.FalseKeyword : false;
  }
  function approvedWrapper(node) {
    node = unwrap(node);
    if (!node || !ts.isIdentifier(node)) return false;
    const d = declaration(node);
    return d && ts.isImportSpecifier(d) && ['launchAgent', 'launchAgentToCompletion'].includes(d.propertyName?.text ?? d.name.text)
      && AGENT_LAUNCH_ALLOWLIST.includes(relative(process.cwd(), resolve(dirname(d.getSourceFile().fileName), importSource(d))).split('\\').join('/'))
      && !bindingWrites.has(d);
  }
  // A mutable/unresolved value still has a definition. Pin its source, every possible assignment,
  // and transitive initializer dependencies rather than granting an exemption to the call text alone.
  function bindingEvidence(args, followFunctionBodies = true) {
    const evidence = [], seen = new Set(), visitedNodes = new Set();
    const visitTarget = target => {
      if (!target || visitedNodes.has(target)) return;
      if (target.pos >= 0) evidence.push([relative(process.cwd(), target.getSourceFile().fileName).split('\\').join('/'),
        'import-target', target.getText()]);
      if (followFunctionBodies || !functionNode(target)) visit(target);
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
    const report = (n, args, reason, potential = false) => {
      const callee = ts.isCallExpression(n) ? n.expression : n;
      // Opaque callees cannot establish executable values. Preserve their exact input text and
      // definitions without expanding arbitrary builders into a combinatorial value set.
      const command = potential ? [null] : values(args[0]);
      const argv = potential ? [null] : values(args[1]);
      const unresolved = potential || !command.length || command.includes(null);
      const definitions = [...(potential ? bindingEvidence([callee], false) : []), ...bindingEvidence(args)];
      findings.push({ file: name, line: file.getLineAndCharacterOfPosition(n.getStart()).line + 1,
        kind: callee.getText(file), classification: unresolved ? 'unresolved' : 'resolved',
        fingerprint: JSON.stringify([command, argv, ...args.map(a => a.getText(file)),
          ...(potential ? [`callee:${callee.getText(file)}`] : []),
          ...(definitions.length ? [`bindings-sha256:${createHash('sha256').update(JSON.stringify(definitions)).digest('hex')}`] : [])]), reason });
    };
    const visit = n => {
      if (ts.isCallExpression(n) && !approvedWrapper(n.expression)) {
        const primitiveName = literalPrimitive(n.expression);
        if (primitiveName) {
          const command = values(n.arguments[0]);
          const unresolved = !command.length || command.includes(null);
          const argumentsEvidence = n.arguments.flatMap(a => values(a));
          const wrapped = command.some(c => wrapper.test(c)) && values(n.arguments[1]).includes(null);
          // Inspect shell text even if quote concatenation hides the agent name. Keep literal argv
          // opaque to shell syntax: e.g. a glob in a direct git argument is only data.
          const shellOption = mayUseShell(n.arguments);
          const shellText = /^(?:exec|execSync|execFn)$/.test(primitiveName) || shellOption
            || argumentsEvidence.some(c => c != null && /(?:^|[/\\])(?:ba|z|da|k)?sh$/.test(c))
            || command.some(c => c != null && /\s|[;|&'"`$]/.test(c));
          const hiddenShell = shellText && argumentsEvidence.some(c => {
            if (c == null) return false;
            const { unquoted, ambiguous } = agentShellEvidence(c);
            return agent.test(unquoted) || ambiguous;
          });
          if (unresolved || argumentsEvidence.some(c => c != null && agent.test(c)) || wrapped || hiddenShell) {
            report(n, n.arguments, unresolved ? 'unresolved command; cannot establish launch boundary' : 'agent execution outside agent-launch.mjs');
          }
        } else if (!unrelatedCall(n)) {
          report(n, n.arguments, 'potential execution through an opaque callee; use a literal approved launch binding', true);
        }
      }
      if ((ts.isIdentifier(n) || ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n))
        && valueReference(n) && isPrimitive(n)) {
        let parent = n.parent, ref = n;
        while (parent && (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent)
          || ts.isNonNullExpression(parent) || ts.isTypeAssertionExpression(parent))) { ref = parent; parent = parent.parent; }
        // The boundary may receive a primitive as its second argument; every other escape is a finding.
        const direct = parent && ts.isCallExpression(parent) && (parent.expression === ref
          || approvedWrapper(parent.expression) && parent.arguments[1] === ref);
        const memberReceiver = parent && (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === ref;
        if (!direct && !memberReceiver) report(n, [n], 'execution primitive reference escapes a direct launch; use the approved boundary', true);
      }
      if (ts.isBindingElement(n) && isPrimitive(n)) {
        report(n, [n], 'execution primitive reference stored by destructuring; use the approved boundary', true);
      }
      // Export specifiers are declarations syntactically, but export their value at runtime.
      if (ts.isExportDeclaration(n) && n.exportClause && ts.isNamedExports(n.exportClause)) {
        for (const spec of n.exportClause.elements) {
          const target = exported(file, spec.name.text);
          if (isPrimitive(target)) report(spec, [spec], 'exported execution primitive reference', true);
        }
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
