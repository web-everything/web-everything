/** Fail closed before a tool runs from a checkout whose static dependencies are stale. */
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readPlatformPreferences, resolveCascade, formatCascadeSourcesLine } from './policy-cascade.mjs';
import { readDeclaredSettings } from './settings-files.mjs';
import { laneGitConfigArgs } from './lane-git-hardening.mjs';
import { checkoutRootFor, guardedPoolRoot } from './lane-pool-paths.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const validators = { threshold: nonnegative, mode: value => ['refuse', 'reexec'].includes(value) };
const GIT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 4 * 1024 * 1024;
const recovery = 'Update the tool checkout from origin/main and retry; check Git connectivity/settings if evidence is unavailable.';

/** Settings: staleToolGuard.{threshold,mode}, standard → platform → tool → environment.
 * Feature files under scripts/settings are discovered by readDeclaredSettings, without a registry.
 * Invalid/unreadable layers refuse instead of silently weakening the guard.
 */
export function resolveStaleToolSettings({ env = process.env, settings, platform, log = console.error } = {}) {
  if (platform === undefined) {
    const { prefs, errors } = readPlatformPreferences({ env });
    if (errors.length) throw new Error(`Unreadable staleToolGuard platform settings: ${errors.join('; ')}`);
    platform = prefs.staleToolGuard;
  }
  if (settings === undefined) {
    const declared = readDeclaredSettings();
    if (declared.errors.length || declared.duplicates.length) throw new Error('Unreadable or duplicate declared settings');
    settings = declared.settings.staleToolGuard;
  }
  const rawThreshold = env.WE_TOOL_STALE_THRESHOLD;
  const envValues = {
    threshold: rawThreshold === undefined ? undefined : /^\d+$/.test(rawThreshold) ? Number(rawThreshold) : NaN,
    mode: env.WE_TOOL_STALE_MODE,
  };
  for (const [name, layer] of [['platform', platform], ['tool', settings], ['env', envValues]]) {
    if (layer === undefined) continue;
    if (!layer || typeof layer !== 'object' || Array.isArray(layer)) throw new Error(`Invalid staleToolGuard ${name} settings`);
    for (const [key, valid] of Object.entries(validators)) {
      if (layer[key] !== undefined && !valid(layer[key])) throw new Error(`Invalid staleToolGuard ${name}.${key}`);
    }
  }
  const result = resolveCascade({ standard: { threshold: 5, mode: 'refuse' }, platform, tool: settings,
    envValues, valid: validators });
  log(formatCascadeSourcesLine('staleToolGuard', result));
  return result.value;
}

export function evaluateStaleness({ behind, threshold, changedPaths, depPaths }) {
  if (!nonnegative(behind) || !nonnegative(threshold) || !Array.isArray(changedPaths)
    || changedPaths.some(path => typeof path !== 'string') || !(depPaths instanceof Set)) {
    return { action: 'stale', behind, reason: 'unknown' };
  }
  return { action: behind > threshold && changedPaths.some(path => depPaths.has(path)) ? 'stale' : 'ok', behind };
}

function within(root, path) {
  const name = relative(root, path);
  if (!name || name === '..' || name.startsWith(`..${sep}`) || isAbsolute(name)) throw new Error('Tool dependency escapes checkout');
  return name.split(sep).join('/');
}

/** Static declarations and top-level awaited relative imports (the guarded bootstrap's dependencies).
 * Unawaited/lazy imports remain outside this eager closure. Parse rather than matching comments or strings.
 * TypeScript is an existing declared dev dependency. Missing parser/dependencies refuse the run.
 */
export async function importClosure(entry, { root = ROOT, readFile = path => readFileSync(path, 'utf8') } = {}) {
  const { default: ts } = await import('typescript');
  const files = new Set();
  const pending = [resolve(entry)];
  while (pending.length) {
    const path = pending.pop();
    const name = within(root, path);
    if (files.has(name)) continue;
    files.add(name);
    const source = String(await readFile(path));
    if (path.endsWith('.json')) { JSON.parse(source); continue; }
    const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    if (ast.parseDiagnostics.length) throw new Error(`Cannot parse dependency ${name}`);
    const include = spec => {
      if (spec && ts.isStringLiteral(spec) && /^\.\.?\//.test(spec.text)) {
        pending.push(fileURLToPath(new URL(spec.text, pathToFileURL(path))));
      }
    };
    for (const node of ast.statements) {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) include(node.moduleSpecifier);
      // Only eager module-level awaits: following every dynamic import would also read optional/lazy code.
      const expressions = ts.isVariableStatement(node)
        ? node.declarationList.declarations.map(declaration => declaration.initializer)
        : ts.isExpressionStatement(node) ? [node.expression] : [];
      for (const expression of expressions) {
        if (!expression || !ts.isAwaitExpression(expression)) continue;
        const call = expression.expression;
        if (ts.isCallExpression(call) && call.expression.kind === ts.SyntaxKind.ImportKeyword) include(call.arguments[0]);
      }
    }
  }
  return files;
}

function checkoutRoot(entry) {
  let path = dirname(resolve(entry));
  while (!existsSync(join(path, '.git'))) {
    const parent = dirname(path);
    if (parent === path) throw new Error('Cannot locate tool checkout');
    path = parent;
  }
  return path;
}

/** Returns undefined to continue, or the fresh child's exit status. All unknown evidence throws. */
export async function guardToolCheckout({ entry, root, exec = spawnSync, env = process.env, settings, log = console.error } = {}) {
  if (env.WE_TOOL_FRESH_REEXEC === '1') return;
  try {
    if (typeof entry !== 'string' || !entry) throw new Error('Missing tool entry');
    entry = resolve(entry);
    root = resolve(root ?? checkoutRoot(entry));
    const name = within(root, entry);
    const policy = resolveStaleToolSettings({ env, settings, log });
    // No inherited Git repository, executable, config or transport context may redirect this guard.
    const cleanEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_')));
    // Support HTTPS and SSH origins while keeping executable helpers and local transports denied.
    const gitEnv = { ...cleanEnv, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: 'https:ssh' };
    const git = (args, cwd = root) => {
      const result = exec('git', ['-C', cwd, ...laneGitConfigArgs(),
        '-c', 'protocol.ext.allow=never', '-c', 'protocol.allow=never',
        '-c', 'protocol.https.allow=always', '-c', 'protocol.ssh.allow=always', '-c', 'protocol.file.allow=never',
        ...args], { cwd, env: gitEnv,
        encoding: 'utf8', timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: MAX_BUFFER, shell: false });
      if (result?.error || result?.status !== 0 || typeof result.stdout !== 'string') {
        throw new Error(`Git ${args[0]} failed or exceeded its ${GIT_TIMEOUT_MS}ms / ${MAX_BUFFER}-byte bound`);
      }
      return result.stdout;
    };
    git(['fetch', '--upload-pack=git-upload-pack', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
    const count = git(['rev-list', '--count', 'HEAD..origin/main']).trim();
    const behind = /^\d+$/.test(count) ? Number(count) : NaN;
    if (!nonnegative(behind)) throw new Error('Unknown or oversized upstream commit count');
    // NUL avoids Git's quoted filename output and preserves whitespace in real paths.
    const diff = git(['diff', '--no-ext-diff', '--no-textconv', '--name-only', '--no-renames', '-z', 'HEAD', 'origin/main', '--']);
    const changedPaths = diff.includes('\0') ? diff.split('\0').filter(Boolean) : diff.split('\n').filter(Boolean);
    let depPaths;
    try { depPaths = await importClosure(entry, { root }); } catch (error) {
      // A dependency missing here while behind origin/main was most likely added upstream: report staleness, not an opaque read error.
      if (behind > policy.threshold) throw new Error(`stale tool checkout (${behind} behind): dependency unreadable (${String(error?.code ?? error?.message).slice(0, 80)})`);
      throw error;
    }
    if (evaluateStaleness({ behind, threshold: policy.threshold, changedPaths, depPaths }).action === 'ok') return;
    if (policy.mode === 'refuse') throw new Error(`stale tool checkout (${behind} behind)`);
    // Resolve both roots while the script still lives in the original checkout. A non-Git cwd
    // falls back to that checkout, just as lane-pool's normal bootstrap does.
    let cwdTopLevel;
    try { cwdTopLevel = git(['rev-parse', '--show-toplevel'], process.cwd()).trim(); } catch { /* non-Git cwd */ }
    const originalCheckout = checkoutRootFor({ cwdTopLevel, scriptCheckout: root, cwd: process.cwd() });
    const poolRoot = guardedPoolRoot(originalCheckout, env);
    if (!env.TMPDIR && !process.env.TMPDIR) throw new Error('Reexec requires a task-local TMPDIR');
    const scratch = mkdtempSync(join(env.TMPDIR || process.env.TMPDIR, 'fresh-tool-'));
    const worktree = join(scratch, 'checkout');
    let added = false;
    try {
      git(['worktree', 'add', '--detach', worktree, 'origin/main']);
      added = true;
      symlinkSync(join(root, 'node_modules'), join(worktree, 'node_modules'), 'junction');
      const child = exec(process.execPath, [join(worktree, name), ...process.argv.slice(2)], {
        cwd: process.cwd(), env: { ...cleanEnv,
          WE_TOOL_FRESH_REEXEC: '1', WE_TOOL_ORIGINAL_CHECKOUT: originalCheckout,
          LANE_POOL_ROOT: poolRoot }, stdio: 'inherit', shell: false,
      });
      if (child?.error || !Number.isInteger(child?.status) || child.status < 0 || child.status > 255) {
        throw new Error('Fresh tool failed to launch or terminated without an exit status');
      }
      return child.status;
    } finally {
      try {
        if (added || existsSync(worktree)) git(['worktree', 'remove', '--force', worktree]);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }
  } catch (error) {
    throw new Error(`${error.message}. ${recovery}`, { cause: error });
  }
}
