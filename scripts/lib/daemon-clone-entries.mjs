/** Clone-specific runtime roots. Throws on unreadable/malformed LaunchAgents evidence;
 * callers must retain the full conflict rather than proceed with narrowed entries. */
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DAEMON_ENTRY_MODULES } from './daemon-boot-smoke.mjs';
import { DAEMON_MANIFEST } from '../../skills-src/conveyor/daemon-manifest.mjs';
import { collectImportClosure } from './import-closure.mjs';
import { collectRunClosure } from './daemon-rebuild/skip-unrelated.mjs';

/** Strict, unwired clone proof. Keep refusal out of the legacy production ESM walker.
 * Reject hints even in comments/strings; this is not the planned inert-source grammar.
 * A refused read uses the collector's ordinary incomplete-evidence fallback. */
export function collectCloneImportClosure({ readFile = path => readFileSync(path, 'utf8'), ...options }) {
  let realRoot;
  try { realRoot = realpathSync(options.root); } catch { return null; }
  // Never accept parsed results from the legacy policy as strict proof. Spawn walks
  // still share raw reads, but each strict traversal validates its own source.
  return collectImportClosure({ ...options, root: realRoot, parsed: new Map(), canonicalize: path => {
    const realPath = realpathSync(path);
    const rel = relative(realRoot, realPath);
    if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
      throw new Error('clone dependency outside clone');
    }
    if ([path, realPath].some(entry => extname(entry) === '.cjs')) {
      throw new Error('unsupported clone dependency syntax');
    }
    return realPath;
  }, readFile: path => {
    const source = readFile(path);
    if (extname(path) === '.cjs' || /\b(?:require|createRequire)\b|\\u/.test(source)) {
      throw new Error('unsupported clone dependency syntax');
    }
    return source;
  } });
}

// Canonicalize both sides of containment, including aliases of a missing entry's
// existing parent. Missing entries still reach closure/smoke's unreadable fallback;
// other filesystem errors must refuse discovery rather than narrow its evidence.
function canonicalArgument(path) {
  const suffix = [];
  for (;;) {
    try { return join(realpathSync(path), ...suffix); }
    catch (error) {
      if (error.code !== 'ENOENT' || dirname(path) === path) throw error;
      suffix.unshift(basename(path));
      path = dirname(path);
    }
  }
}

const NODE_SAFE_FLAGS = new Set(['--no-warnings', '--enable-source-maps', '--trace-warnings']);

export function cloneRuntimeEntries({ root, entries = [], env = process.env,
  launchAgentsDir = join(env.HOME || homedir(), 'Library', 'LaunchAgents'), run = spawnSync,
}) {
  const realRoot = realpathSync(root);
  const inside = path => {
    const rel = relative(realRoot, canonicalArgument(path));
    if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return null;
    // The closure scanner cannot follow require(). Refuse both the supplied path
    // and its canonical target until CommonJS closure coverage is available.
    if ([path, rel].some(entry => extname(entry) === '.cjs')) {
      throw new Error(`CommonJS runtime entry unsupported: ${rel}`);
    }
    return rel;
  };
  const out = new Set();
  const add = entry => {
    const rel = inside(resolve(realRoot, entry));
    if (!rel) throw new Error('runtime entry outside clone');
    out.add(rel);
  };
  for (const entry of [...DAEMON_ENTRY_MODULES, ...entries]) add(entry);
  for (const name of readdirSync(launchAgentsDir).sort()) {
    if (!name.endsWith('.plist')) continue;
    const result = run('plutil', ['-convert', 'json', '-o', '-', '--', join(launchAgentsDir, name)], {
      encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
    });
    if (result.error || result.status !== 0) throw new Error(`LaunchAgents plist unreadable: ${name}`);
    const plist = JSON.parse(result.stdout);
    const args = plist.ProgramArguments;
    if (!Array.isArray(args) || !args.length || args.some(arg => typeof arg !== 'string')) {
      throw new Error(`LaunchAgents ProgramArguments invalid: ${name}`);
    }
    // launchd globbing can select code other than the literal path inspected below.
    // Refuse metacharacters even when quoted/escaped or EnableGlobbing is absent.
    if (args.some(arg => /[*?\[\]{}]/.test(arg))) {
      throw new Error(`LaunchAgents glob argument refused: ${name}`);
    }
    // Fail closed on launchd inputs that can run code this scan cannot see.
    const refuse = why => { throw new Error(`LaunchAgents unsupported dynamic execution refused: ${name}: ${why}`); };
    if (typeof plist.WorkingDirectory !== 'string' || !isAbsolute(plist.WorkingDirectory)
      || canonicalArgument(plist.WorkingDirectory) !== realRoot) refuse('WorkingDirectory must be the clone root');
    if (plist.Program !== undefined && plist.Program !== args[0]) refuse('Program differs from ProgramArguments[0]');
    if (plist.EnvironmentVariables && Object.keys(plist.EnvironmentVariables).some(key => /^NODE_/.test(key))) {
      refuse('NODE_* environment variable');
    }
    const interpreter = basename(args[0] === '/usr/bin/env' ? args[1] ?? '' : args[0]);
    if (interpreter !== 'node' && interpreter !== 'nodejs') refuse(`interpreter ${interpreter}`);
    // Eval flags are node's own only before the script; after it they are script arguments.
    let scriptSeen = false;
    // A known boolean flag consumes no value; unknown flags may consume a script-shaped value.
    for (const [index, arg] of args.entries()) {
      if (isAbsolute(arg) && ['.mjs', '.js'].includes(extname(arg))
        && (!args[index - 1]?.startsWith('-') || NODE_SAFE_FLAGS.has(args[index - 1]))) scriptSeen = true;
      if (!arg.startsWith('-')) {
        const path = resolve(realRoot, arg);
        // Canonicalize even missing paths: only ENOENT may mean absent evidence.
        const rel = inside(path);
        const file = statSync(path, { throwIfNoEntry: false });
        if (rel && file?.isFile()
          && [path, rel].some(entry => !['.mjs', '.js'].includes(extname(entry)))) {
          throw new Error(`LaunchAgents unsupported entrypoint/module argument refused: ${name}: ${arg}`);
        }
        // Node's first positional token is a script even when it has no extension
        // or is missing. Never use existence to decide whether that token is code.
        if (!scriptSeen && index >= (args[0] === '/usr/bin/env' ? 2 : 1)
          && !isAbsolute(arg)) {
          throw new Error(`LaunchAgents unsupported entrypoint/module argument refused: ${name}: ${arg}`);
        }
      }
      // Allowlist, not denylist: before the script, only these inert node flags are accepted.
      if (!scriptSeen && index >= (args[0] === '/usr/bin/env' ? 2 : 1) && arg.startsWith('-')
        && !arg.startsWith('--pass=') && !NODE_SAFE_FLAGS.has(arg) && !/^--(?:repo|path|watch)(?:=|$)/.test(arg)) {
        throw new Error(`LaunchAgents unsupported entrypoint/module argument refused: ${name}: ${arg}`);
      }
      if (isAbsolute(arg) || arg.startsWith('--pass=')) continue;
      if (/^--(?:import|require|(?:experimental-)?loader)(?:=|$)/.test(arg)
        || /^-r/.test(arg)
        || (!scriptSeen && /^(?:--(?:eval|print|input-type)(?:=|$)|-[a-zA-Z]*[ep](?:=|$))/.test(arg))
        || (!arg.startsWith('-')
          && (arg.includes('/') || /^\.{1,2}$/.test(arg) || /\.[a-z][a-z0-9]*$/i.test(arg)))) {
        throw new Error(`LaunchAgents unsupported entrypoint/module argument refused: ${name}: ${arg}`);
      }
    }
    const paths = args.filter(isAbsolute).map(inside).filter(Boolean);
    for (const path of paths) add(path);
    if (paths.some(path => basename(path) === 'pass-daemon.mjs')) {
      const passes = args.filter(arg => arg.startsWith('--pass='));
      const pass = passes.length === 1 ? passes[0].slice('--pass='.length) : null;
      const script = Object.hasOwn(DAEMON_MANIFEST, pass) && DAEMON_MANIFEST[pass].script;
      if (!script) throw new Error(`LaunchAgents pass unknown: ${name}`);
      add(script);
    }
  }
  // Check readable roots separately so a missing sibling cannot mask unsupported
  // source. Missing roots stay in the result for downstream null-closure handling.
  for (const entry of out) {
    if (!statSync(join(realRoot, entry), { throwIfNoEntry: false })) continue;
    const closure = collectRunClosure({ root: realRoot, entries: [entry],
      importClosure: collectCloneImportClosure, stopWhenIncomplete: true });
    if (!closure?.complete) throw new Error(`runtime dependency proof incomplete: ${entry}`);
  }
  return [...out];
}
