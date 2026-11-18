/** Coarse capability boundary. Never infer executable values or prove arbitrary callees safe. */
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { isBuiltin } from 'node:module';

// Membership is copied from the pre-capability migration inventory, plus the central launcher.
// It is independent of the fingerprint snapshot: updating fingerprints cannot approve a new file.
export const AGENT_LAUNCH_ALLOWLIST = Object.freeze(JSON.parse(
  readFileSync(join(import.meta.dirname, 'agent-launch-approved.json'), 'utf8')));
const executionBuiltin = /^(?:node:)?(?:child_process|worker_threads|cluster|vm|process|module)(?:\/|$)/;
const capabilityNames = new Set(['process', 'require', 'module', 'eval', 'Function', 'Worker',
  'globalThis', 'global', 'window', 'self', 'Reflect',
  'spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork', 'cp', 'child_process', 'childProcess']);
const primitiveNames = /^(?:spawn(?:Sync)?|exec(?:File(?:Sync)?|Sync)?|fork)$/;
const dataProcessMembers = new Set(['env', 'pid', 'ppid', 'argv', 'execArgv', 'platform', 'arch', 'versions', 'version', 'exitCode']);
const capabilityMembers = new Set(['binding', '_linkedBinding', 'dlopen', 'eval', 'Function', 'Worker', 'constructor']);
// Hash the whole syntax/token tree. Trivia is absent; literal lexemes and ASI structure remain.
// Unlike reprinting or regex stripping, this ignores ONLY formatting/comments, not token edits.
function moduleFingerprint(file) {
  const hash = createHash('sha256');
  const visit = node => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const children = node.getChildren(file);
    hash.update(JSON.stringify([node.kind, children.length ? null : node.getText(file)]));
    hash.update('[');
    for (const child of children) visit(child);
    hash.update(']');
  };
  visit(file);
  return 'module-sha256-v2:' + hash.digest('hex');
}
const portable = name => relative(process.cwd(), name).split('\\').join('/');

/**
 * Inventory every approved module's WHOLE text; report capability-bearing unapproved modules.
 * Module-level granularity deliberately covers all functions, aliases, mutations, callers and
 * surrounding definitions, including new capabilities introduced into a previously benign file.
 * Only the module's own references count; inspected local imports are judged on their own source.
 * Unknown packages/modules are capabilities too: an uninspected dependency cannot prove safety.
 */
export function findAgentLaunches(sources) {
  const files = new Map(Object.entries(sources).map(([name, text]) => [resolve(name),
    ts.createSourceFile(resolve(name), text, ts.ScriptTarget.Latest, true,
      /\.tsx?$/.test(name) ? ts.ScriptKind.TS : ts.ScriptKind.JS)]));
  const approved = new Set(AGENT_LAUNCH_ALLOWLIST);
  const modules = new Map();
  for (const [name, file] of files) {
    const evidence = new Set();
    const specifier = node => {
      if (!node || !ts.isStringLiteralLike(node)) {
        evidence.add('non-literal module specifier');
        return;
      }
      const source = node.text;
      if (isBuiltin(source)) {
        if (executionBuiltin.test(source)) evidence.add(`execution builtin: ${source}`);
      } else if (source.startsWith('.')) {
        // Require exact, inspectable source. No filesystem or package-resolution fallback.
        const target = resolve(dirname(name), source);
        if (!files.has(target)) evidence.add(`uninspected module: ${source}`);
      } else {
        // Covers known exec packages AND any future/unknown execution package, including subpaths.
        evidence.add(`uninspected package: ${source}`);
      }
    };
    const visit = node => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        specifier(node.moduleSpecifier);
      }
      if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        specifier(node.moduleReference.expression);
      }
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
        specifier(node.arguments[0]);
      }
      // References, declarations, aliases and escapes all require the same boundary. Shadowing is
      // intentionally no exemption. Checking origins suffices without tracing their derived values.
      if (ts.isIdentifier(node) && (capabilityNames.has(node.text) || capabilityMembers.has(node.text))
        && !(primitiveNames.test(node.text) && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) {
        // These exact syntax forms expose process data / the CommonJS export slot, not a loader.
        // Taking the container itself or using any other/computed member still requires review.
        const parent = node.parent;
        const dataAccess = ts.isPropertyAccessExpression(parent) && parent.expression === node
          && (node.text === 'process' && dataProcessMembers.has(parent.name.text)
            || node.text === 'module' && parent.name.text === 'exports');
        if (dataAccess) { ts.forEachChild(node, visit); return; }
        // A direct literal require of an inspected/benign module is handled by specifier above;
        // taking require itself (including aliases) is an unrestricted loader capability.
        if (!(node.text === 'require' && ts.isCallExpression(node.parent)
          && node.parent.expression === node && node.parent.arguments.length === 1
          && ts.isStringLiteralLike(node.parent.arguments[0]))) evidence.add(`capability reference: ${node.text}`);
      }
      if (ts.isElementAccessExpression(node)) {
        const key = node.argumentExpression;
        if (key && ts.isStringLiteralLike(key)
          && (capabilityNames.has(key.text) || capabilityMembers.has(key.text))) {
          evidence.add(`capability access: ${key.text}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    modules.set(name, { file, evidence, approved: approved.has(portable(name)) });
  }
  const findings = [];
  for (const [name, entry] of modules) {
    const { file, evidence } = entry;
    // Parse failure can never be inventoried, even inside an approved boundary.
    if (file.parseDiagnostics.length) {
      findings.push({ file: name, line: 1, reason: 'unparseable source; review complete source before approving boundary' });
    } else if (entry.approved || evidence.size) {
      const fingerprint = moduleFingerprint(file);
      findings.push({ file: name, line: 1, kind: 'module', classification: 'unresolved', fingerprint,
        reason: entry.approved ? 'approved boundary inventory; exact module fingerprint required'
          : `execution capability outside approved boundary; use an approved boundary or request review: ${[...evidence].sort().join(', ')}` });
    }
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
