/** Static tripwire. Runtime launchAgent validation carries the security weight. */
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';

export const AGENT_LAUNCH_ALLOWLIST = Object.freeze(JSON.parse(
  readFileSync(join(import.meta.dirname, 'agent-launch-approved.json'), 'utf8')));
export const AGENT_LAUNCH_CAPABILITY_BASELINE = Object.freeze(JSON.parse(
  readFileSync(join(import.meta.dirname, 'agent-launch-capability-baseline.json'), 'utf8')).paths);
const moduleSource = name => /\.(?:mjs|cjs|js|mts|cts|ts)$/.test(name);
const shellSource = name => /\.(?:sh|bash)$/.test(name);
const excluded = name => /(?:^|[/\\])(?:__tests__|tests|fixtures|__fixtures__|test-fixtures|node_modules|\.git)(?:[/\\]|$)/.test(name)
  || /\.(?:test|spec)\./.test(name);
const portable = (name, root = process.cwd()) => relative(root, resolve(name)).replaceAll('\\', '/');
const executionModule = /^(?:(?:node:)?(?:child_process|worker_threads|cluster|vm|inspector|repl|module|v8|wasi|process)|execa|cross-spawn|shelljs|zx|node-pty|tinyexec|nano-spawn|foreground-child|@npmcli\/promise-spawn)(?:\/|$)/;
const primitive = /^(?:spawn(?:Sync)?|exec(?:File(?:Sync)?|Sync)?|fork)$/;
const launchName = /^(?:spawn\w*|exec\w*|launch\w*|run(?:Fn|Sync|Async|Command|DiagnosedStep)?|command|complete)$/i;
const parse = (name, text) => ts.createSourceFile(resolve(name), text, ts.ScriptTarget.Latest, true,
  /\.(?:mts|cts|ts)$/.test(name) ? ts.ScriptKind.TS : ts.ScriptKind.JS);
const walk = (node, visit) => { visit(node); ts.forEachChild(node, child => { walk(child, visit); }); };

// Hash the whole syntax/token tree. Trivia is absent; literal lexemes and ASI structure remain.
// Unlike reprinting or regex stripping, this ignores ONLY formatting/comments, not token edits.
function moduleFingerprint(owner) {
  const file = owner.getSourceFile();
  const hash = createHash('sha256');
  const visit = node => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const children = node.getChildren(file);
    hash.update(JSON.stringify([node.kind, children.length ? null : node.getText(file)]));
    hash.update('[');
    for (const child of children) visit(child);
    hash.update(']');
  };
  visit(owner);
  return 'module-sha256-v2:' + hash.digest('hex');
}

/** Import-only snapshot: existing capability is NOT approval to launch an agent. */
export function findCapabilityImporters(sources, root = process.cwd()) {
  const paths = [];
  for (const [name, text] of Object.entries(sources)) {
    if (!moduleSource(name) || excluded(name)) continue;
    const file = parse(name, text);
    if (file.parseDiagnostics.length) throw new Error(`unparseable source: ${portable(name, root)}; repair source or request scanner support`);
    let capability = false;
    const inspect = source => {
      if (source && ts.isStringLiteralLike(source) && executionModule.test(source.text)) capability = true;
    };
    walk(file, node => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) inspect(node.moduleSpecifier);
      if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) inspect(node.moduleReference.expression);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || ts.isIdentifier(node.expression) && node.expression.text === 'require')) inspect(node.arguments[0]);
    });
    if (capability) paths.push(portable(name, root));
  }
  return paths.sort();
}

export function findNewCapabilityFiles(sources, baseline = AGENT_LAUNCH_CAPABILITY_BASELINE, reviewed = AGENT_LAUNCH_ALLOWLIST, root = process.cwd()) {
  return findCapabilityImporters(sources, root).filter(path => !baseline.includes(path) && !reviewed.includes(path))
    .map(file => ({ file, reason: 'new child_process-class importer: add it to the capability baseline in review if it does not launch agents, or to agent-launch-approved.json if it does' }));
}

/** Shell command positions only; documentation, comments and ordinary argv are not launches. */
export function scriptAgentCommand(text) {
  const agent = /^(?:[^\s]*[/\\])?(?:claude|codex)$/;
  // Preserve quoted words as one token; recognise nested shell commands without evaluating them.
  const tokens = text.match(/#[^\n]*|(?:[^\s;|&()'"\\]|\\.|'[^']*'|"(?:\\.|[^"\\])*")+|[\n;|&()]/g) ?? [];
  let command = true, shell = false;
  for (const raw of tokens) {
    if (raw.startsWith('#')) continue;
    if (/^[\n;|&()]$/.test(raw)) { command = true; shell = false; continue; }
    const word = raw.replace(/['"\\]/g, '');
    if (shell && /^-[a-z]*c[a-z]*$/.test(word)) { command = true; shell = false; continue; }
    if (command) {
      if (/\s/.test(word) && /^['"]/.test(raw) && scriptAgentCommand(word)) return true;
      if (/^(?:[A-Za-z_][A-Za-z0-9_]*=.*|env|command|exec|nohup|sudo|then|do|else|!|timeout|\d+)$/.test(word)) continue;
      if (agent.test(word)) return true;
      shell = /^(?:.*\/)?(?:sh|bash|zsh)$/.test(word);
      command = /^(?:npx|pnpm|npm|exec)$/.test(word);
    } else if (shell && scriptAgentCommand(word)) return true;
  }
  return false;
}

/** Find command-position agent words and the local launcher helpers used by those calls.
 * This deliberately does not attempt to prove arbitrary JavaScript safe.
 */
export function findAgentLaunches(sources) {
  const files = new Map(Object.entries(sources).filter(([name]) => moduleSource(name) && !excluded(name))
    .map(([name, text]) => [resolve(name), parse(name, text)]));
  const program = ts.createProgram([...files.keys()], { allowJs: true, noLib: true, types: [],
    target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext }, {
    getSourceFile: name => files.get(resolve(name)), getDefaultLibFileName: () => '', writeFile() {},
    getCurrentDirectory: () => process.cwd(), getDirectories: () => [], readFile: name => files.get(resolve(name))?.text,
    fileExists: name => files.has(resolve(name)), getCanonicalFileName: name => name,
    useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
    resolveModuleNames: (names, containing) => names.map(source => {
      const target = resolve(dirname(containing), source);
      return source.startsWith('.') && files.has(target) ? { resolvedFileName: target,
        extension: /\.(?:mts|cts|ts)$/.test(target) ? ts.Extension.Ts : ts.Extension.Js } : undefined;
    }),
  });
  const checker = program.getTypeChecker();
  const symbol = node => {
    let result = checker.getSymbolAtLocation(node);
    if (result?.flags & ts.SymbolFlags.Alias) {
      const target = checker.getAliasedSymbol(result);
      if (target?.declarations?.length) result = target;
    }
    return result;
  };
  const values = (node, seen = new Set()) => {
    if (!node || seen.has(node)) return [];
    seen = new Set(seen).add(node);
    if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return [node.text];
    if (ts.isTemplateExpression(node)) return [node.head.text];
    if (ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node) || ts.isAsExpression(node)) return values(node.expression, seen);
    if (ts.isArrayLiteralExpression(node)) return values(node.elements[0], seen);
    if (ts.isConditionalExpression(node)) return [...values(node.whenTrue, seen), ...values(node.whenFalse, seen)];
    if (ts.isBinaryExpression(node)) {
      const left = values(node.left, seen), right = values(node.right, seen);
      return node.operatorToken.kind === ts.SyntaxKind.PlusToken
        ? left.flatMap(a => right.map(b => a + b)) : [...left, ...right];
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const key = ts.isPropertyAccessExpression(node) ? node.name.text : values(node.argumentExpression, seen)[0];
      const declarations = symbol(node.expression)?.declarations ?? [];
      for (const declaration of declarations) {
        const init = declaration.initializer;
        if (init && ts.isObjectLiteralExpression(init)) {
          const property = init.properties.find(p => p.name?.getText().replace(/['"]/g, '') === key);
          if (property) return values(property.initializer, seen);
        }
        if (init && ts.isArrayLiteralExpression(init) && /^\d+$/.test(key)) return values(init.elements[Number(key)], seen);
      }
    }
    if (ts.isCallExpression(node)) {
      const name = node.expression.getText();
      if (/\b(?:join|resolve)$/.test(name)) return values(node.arguments.at(-1), seen);
      const result = [];
      for (const declaration of symbol(node.expression)?.declarations ?? []) {
        if (declaration.body) walk(declaration.body, child => { if (ts.isReturnStatement(child)) result.push(...values(child.expression, seen)); });
      }
      return result;
    }
    return (symbol(node)?.declarations ?? []).flatMap(d => values(d.initializer, seen));
  };
  const targetFunctions = node => (symbol(node)?.declarations ?? []).flatMap(d => {
    if (ts.isFunctionLike(d) && d.body) return [d];
    return d.initializer && ts.isFunctionLike(d.initializer) ? [d.initializer] : [];
  });
  const assignments = new Map();
  for (const file of files.values()) walk(file, node => {
    if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
    const binding = symbol(node.left);
    if (!binding) return;
    if (!assignments.has(binding)) assignments.set(binding, []);
    assignments.get(binding).push(node.right);
  });
  const launcherHelpers = new Set();
  const isLauncher = (node, seen = new Set()) => {
    if (!node || seen.has(node)) return false;
    seen = new Set(seen).add(node);
    const name = ts.isPropertyAccessExpression(node) ? node.name.text
      : ts.isIdentifier(node) ? node.text : '';
    if (launchName.test(name)) return true;
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === 'require'
        && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])
        && executionModule.test(node.arguments[0].text)) return true;
      return isLauncher(node.expression, seen);
    }
    if (ts.isPropertyAccessExpression(node) && isLauncher(node.expression, seen)) return true;
    if (ts.isPropertyAccessExpression(node) && /^(?:bind|call|apply)$/.test(name)) return isLauncher(node.expression, seen);
    if (ts.isElementAccessExpression(node) && values(node.argumentExpression).some(key => primitive.test(key))) return true;
    if ((assignments.get(symbol(node)) ?? []).some(value => isLauncher(value, seen))) return true;
    return (symbol(node)?.declarations ?? []).some(d => {
      if (d.initializer && !ts.isFunctionLike(d.initializer) && isLauncher(d.initializer, seen)) return true;
      if (ts.isImportSpecifier(d)) return primitive.test((d.propertyName ?? d.name).text);
      if (ts.isBindingElement(d)) {
        if (d.propertyName && primitive.test(d.propertyName.getText())) return true;
        if (d.parent.parent.initializer && isLauncher(d.parent.parent.initializer, seen)) return true;
      }
      if (ts.isImportClause(d) || ts.isNamespaceImport(d)) {
        const declaration = ts.isImportClause(d) ? d.parent : d.parent.parent;
        if (ts.isImportDeclaration(declaration) && ts.isStringLiteralLike(declaration.moduleSpecifier)
          && executionModule.test(declaration.moduleSpecifier.text)) return true;
      }
      return targetFunctions(node).some(fn => launcherHelpers.has(fn));
    });
  };
  const invokeWalk = (node, visit) => {
    if (ts.isFunctionLike(node) && ts.isReturnStatement(node.parent)) return;
    visit(node); ts.forEachChild(node, child => { invokeWalk(child, visit); });
  };
  const users = new Map(), pendingHelpers = [];
  for (const file of files.values()) walk(file, fn => {
    if (!ts.isFunctionLike(fn) || !fn.body) return;
    let direct = false;
    invokeWalk(fn.body, node => {
      if (!ts.isCallExpression(node)) return;
      if (isLauncher(node.expression)) direct = true;
      for (const target of targetFunctions(node.expression)) {
        if (!users.has(target)) users.set(target, new Set());
        users.get(target).add(fn);
      }
    });
    if (direct) { launcherHelpers.add(fn); pendingHelpers.push(fn); }
  });
  for (let index = 0; index < pendingHelpers.length; index++) {
    for (const user of users.get(pendingHelpers[index]) ?? []) if (!launcherHelpers.has(user)) {
      launcherHelpers.add(user); pendingHelpers.push(user);
    }
  }
  const findings = new Map(), moduleHashes = new Map();
  const add = (node, reason) => {
    const file = node.getSourceFile();
    // Pin the outer function: nested callbacks must not hide edits to captured arguments/defaults.
    let owner = node;
    for (let parent = node; parent && !ts.isSourceFile(parent); parent = parent.parent) {
      if (ts.isFunctionLike(parent) && parent.body) owner = parent;
    }
    if (!ts.isFunctionLike(owner)) owner = file;
    const label = ts.isSourceFile(owner) ? '<module>' : owner.name?.getText(file)
      ?? (ts.isVariableDeclaration(owner.parent) ? owner.parent.name.getText(file) : '<anonymous>');
    const key = `${file.fileName}:${owner.pos}`;
    if (!moduleHashes.has(file)) moduleHashes.set(file, moduleFingerprint(file));
    findings.set(key, { file: file.fileName, function: label, kind: ts.isSourceFile(owner) ? 'module' : 'function',
      line: file.getLineAndCharacterOfPosition(owner.getStart(file)).line + 1,
      fingerprint: moduleFingerprint(owner), moduleFingerprint: moduleHashes.get(file), reason });
  };
  const agent = command => /^(?:[^\s]*[/\\])?(?:claude|codex)(?:\s|$)/.test(command.replace(/['"\\]/g, ''));
  for (const file of files.values()) {
    if (file.parseDiagnostics.length) throw new Error(`unparseable source: ${portable(file.fileName)}; repair source or request scanner support`);
    // These are the runtime's exported agent-specific launcher entry points, even before migration of callers.
    if (portable(file.fileName) === 'scripts/lib/agent-launch.mjs') {
      for (const node of file.statements) if (ts.isFunctionDeclaration(node)
        && ['launchAgent', 'launchAgentToCompletion'].includes(node.name?.text)) add(node, 'agent runtime launcher export');
    }
    walk(file, node => {
      if (!ts.isCallExpression(node) || !isLauncher(node.expression)) return;
      const name = node.expression.getText();
      const offset = /\blaunchAgent$/.test(name) ? 2 : /\blaunchAgentToCompletion$/.test(name) ? 1 : 0;
      const commands = values(node.arguments[offset]);
      const argNode = node.arguments[offset + 1];
      const argv = argNode && ts.isArrayLiteralExpression(argNode)
        ? argNode.elements.flatMap(element => values(element)) : values(argNode);
      const hit = commands.some(command => agent(command)
        || /^(?:.*\/)?(?:sh|bash|zsh)$/.test(command) && argv.some(scriptAgentCommand)
        || /^(?:npx|npm|pnpm|env)$/.test(command) && scriptAgentCommand([command, ...argv].join(' '))
        || /exec/i.test(name) && scriptAgentCommand(command));
      if (!hit) return;
      add(node, 'agent CLI command outside approved boundary; review launcher inventory');
      const pending = [...targetFunctions(node.expression)], visited = new Set();
      // Fingerprint local helper implementations, following their launch calls to the OS boundary.
      for (let index = 0; index < pending.length; index++) {
        const helper = pending[index];
        if (visited.has(helper)) continue;
        visited.add(helper);
        add(helper, 'launcher helper used for agent CLI');
        walk(helper, child => {
          if (ts.isCallExpression(child) && isLauncher(child.expression)) pending.push(...targetFunctions(child.expression));
        });
      }
    });
  }
  for (const [name, text] of Object.entries(sources)) {
    if (excluded(name) || !shellSource(name) || !scriptAgentCommand(text)) continue;
    findings.set(resolve(name), { file: resolve(name), function: '<script>', kind: 'script', line: 1,
      fingerprint: 'script-sha256-v1:' + createHash('sha256').update(text).digest('hex'),
      reason: 'agent CLI command outside approved boundary; review launcher inventory' });
  }
  return [...findings.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** Only owned source roots; test/fixture sources never enter either inventory. */
export function readAgentLaunchTree(root) {
  const sources = {}, ancestors = new Set();
  const visit = dir => {
    const real = realpathSync(dir);
    if (ancestors.has(real)) throw new Error(`cyclic source directory: ${dir}; review source tree`);
    ancestors.add(real);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (excluded(file)) continue;
      const info = entry.isSymbolicLink() ? statSync(file) : entry;
      if (info.isDirectory()) visit(file);
      else if (info.isFile() && (moduleSource(file) || shellSource(file))) sources[file] = readFileSync(file, 'utf8');
    }
    ancestors.delete(real);
  };
  for (const dir of ['scripts', 'skills-src', '.claude/skills']) visit(join(root, dir));
  return sources;
}
