/** Restart stateless clone-backed samplers after adoption; all host IO has injectable seams. */
import { readdirSync, realpathSync } from 'node:fs';
import fsAsync from 'node:fs/promises';
import childProcess from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { cascadePolicy } from './policy-cascade.mjs';
import { lockDirFor, makeLockEntry } from '../readiness/file-locks.mjs';
import { readRebuildState } from './daemon-rebuild/state.mjs';

const commandOptions = { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 };
const expand = p => resolve(p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);
const message = e => String(e?.message ?? e);
const safeLog = (log, line) => { try { (typeof log === 'function' ? log : log?.error?.bind(log))?.(line.replace(/[\x00-\x1f\x7f]/g, ' ')); } catch { /* logging cannot fail a tick */ } };
const readHostPlist = path => JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', path], commandOptions));
const runHost = (command, argv) => new Promise((ok, fail) => childProcess.execFile(command, argv, commandOptions,
  (error, stdout, stderr) => error ? fail(error) : ok({ stdout, stderr, status: 0 })));
const readHostPlistAsync = async path => JSON.parse((await runHost('plutil', ['-convert', 'json', '-o', '-', path])).stdout);
const launchHost = argv => runHost('launchctl', argv);
const printHost = argv => execFileSync('launchctl', argv, commandOptions);
const userId = () => process.getuid();

// Unknown interpreter options cannot establish a script position: an option's value
// might be a data path. Recognized options with operands consume those operands.
// Returns { owners, unknownAt }: unknownAt is the index of an option that could not be
// classified (it may or may not take a separate operand), or null. The caller must not
// treat that as "not the clone" when a later argument is a clone path.
// `cwd` is the service's explicit absolute working directory (or null): relative script
// paths resolve against it, exactly as launchd would run them. Without one they stay
// unproven (the service's default cwd is not this process's cwd).
const place = (arg, cwd, exe) => isPathArg(arg) ? expand(arg)
  : cwd && !arg.startsWith('-') && !arg.startsWith('+') && (!exe || arg.includes('/')) ? resolve(cwd, arg) : arg;
// Command wrappers that exec their first non-option, non-assignment operand. `env` is the
// common launchd one; the rest are the same shape. An option we cannot classify is reported
// as unknownAt so the caller flags a following clone path instead of silently excluding it.
const INTERPRETER = /^(?:node|nodejs|python(?:\d+(?:\.\d+)*)?|pypy\d*|bash|sh|zsh|dash|ksh|ruby|perl)$/;
// Wrappers whose options we parse precisely, and wrappers we only know by name (their
// options and positional operands vary too much to enumerate: `timeout 10 node x`, `sudo -u me node x`).
const WRAPPERS = /^(?:env|nohup|exec|command|time|nice|arch|caffeinate)$/;
const LOOSE_WRAPPERS = /^(?:taskpolicy|sudo|xcrun|timeout|gtimeout|sandbox-exec|setsid|chroot|runuser|doas|stdbuf|ionice|chrt)$/;
const isCommand = arg => { const n = basename(arg).toLowerCase(); return INTERPRETER.test(n) || WRAPPERS.test(n) || LOOSE_WRAPPERS.test(n); };
const MAX_WRAPPER_DEPTH = 16;
// Shell-style split for `env -S`: whitespace separates, single quotes are literal, double quotes honour
// \" \\ \$ \` escapes, a backslash outside quotes escapes the next character. null = unparsable.
function shellSplit(value) {
  const tokens = []; let cur = '', has = false, quote = null;
  for (let i = 0; i < value.length; i += 1) {
    const c = value[i];
    // env -S expands ${VAR} itself; the value is unknown here, so the real program/script cannot be resolved.
    if (c === '$' && value[i + 1] === '{' && quote !== "'") return null;
    if (quote === "'") { if (c === "'") quote = null; else cur += c; continue; }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' && i + 1 < value.length && '"\\$`'.includes(value[i + 1])) { cur += value[i + 1]; i += 1; }
      else cur += c;
      continue;
    }
    if (/\s/.test(c)) { if (has) { tokens.push(cur); cur = ''; has = false; } continue; }
    if (c === "'" || c === '"') { quote = c; has = true; continue; }
    // env -S gives \_ \c \n \t ... special meaning (separator / stop / control char): not modelled, so unsupported.
    if (c === '\\') { if (i + 1 >= value.length || /[_cntrfv]/.test(value[i + 1])) return null; cur += value[i + 1]; i += 1; has = true; continue; }
    cur += c; has = true;
  }
  if (quote) return null;
  if (has) tokens.push(cur);
  return tokens;
}
// A wrapper option we cannot classify may carry an operand, so the program position is unknown.
// Resume at the next argument that names an interpreter or another wrapper; failing that, report
// the option as unknown with an UNBOUNDED scan (`wide`): the 2-operand window used for interpreter
// options assumes "option, operand, script" and would miss a script behind a wrapper's own operands.
function unwrap(args, start, cwd, depth) {
  if (depth > MAX_WRAPPER_DEPTH) throw new Error(`Too many nested command wrappers (more than ${MAX_WRAPPER_DEPTH}): cannot tell what the service runs`);
  const name = basename(args[start]).toLowerCase(), loose = LOOSE_WRAPPERS.test(name);
  const owners = [place(args[start], cwd, true)];
  let a = args, i = start + 1;
  const resume = () => { const j = a.findIndex((x, k) => k > i && isCommand(x)); return j; };
  const unknown = at => ({ owners, unknownAt: at, wide: true, args: a, cwd });
  const dir = v => cwd ? resolve(cwd, v) : isAbsolute(v) ? v : null;
  while (i < a.length) {
    const arg = a[i];
    if (loose) {
      // Options and positional operands (duration, user, profile) are not enumerable: resume at the
      // first later argument that names an interpreter or wrapper, else scan everything after the wrapper.
      const j = a.findIndex((x, k) => k >= i && isCommand(x));
      // The wrapper's own first operand may itself be the program (`sudo -u me /clone/bin/sampler`,
      // `timeout 10 /clone/bin/sampler --runner node`): a path-like operand that is not an option value
      // is an executable candidate even when an interpreter-named word appears later as plain data.
      // Before a later interpreter, an operand right after an option is more likely that option's value
      // (`sandbox-exec -f profile node x`); with no interpreter at all it is the best program candidate.
      // A dash-word before a path may be a boolean flag (`sudo -E /clone/bin/x`, `timeout --foreground`) or take
      // this path as its value (`sandbox-exec -f profile`): we cannot tell, so such an operand is an AMBIGUOUS
      // owner (claimed, never dropped) and the scan still resumes at the interpreter. Env assignments are not programs.
      let program = -1;
      const ambiguous = [];
      for (let k = i; k < (j < 0 ? a.length : j); k += 1) {
        const x = a[k];
        if (x === '--' || x.startsWith('-') || x.startsWith('+') || /^[A-Za-z_]\w*=/.test(x) || !(isPathArg(x) || x.includes('/'))) continue;
        if (j >= 0 && k > start + 1 && a[k - 1].startsWith('-') && a[k - 1] !== '--') { ambiguous.push(a[k]); continue; }
        program = k;
        break;
      }
      owners.push(...ambiguous.map(x => place(x, cwd, true)));
      if (program >= 0) {
        // The first path-like operand is the program; later interpreter-named words are its data.
        // Its own arguments are unknown, so a clone path among them is flagged, never silently ignored.
        owners.push(place(a[program], cwd, true));
        return unknown(start + 1);
      }
      if (j < 0) return unknown(start + 1);
      i = j; break;
    }
    if (arg === '--') { i += 1; break; }
    if (name === 'env' && /^[A-Za-z_]\w*=/.test(arg)) {
      // `env NODE_OPTIONS=--require …` preloads code into the node it launches, same as the plist environment.
      const nodeOptions = /^NODE_OPTIONS=([^]*)$/.exec(arg);
      if (nodeOptions) {
        const preloads = nodeOptionPreloads(nodeOptions[1]);
        if (preloads === null) throw new Error('Unsupported NODE_OPTIONS string (unterminated quote or escape): cannot tell whether the service preloads code from the clone');
        owners.push(...preloads.map(v => preloadOwner(v, cwd)));
      }
      i += 1; continue;
    }
    // env -S "prog args": one argv entry that env splits itself; expand it so the real program is seen.
    if (name === 'env' && (/^-S./.test(arg) || arg === '-S' || arg === '--split-string' || arg.startsWith('--split-string='))) {
      const attached = /^-S./.test(arg) ? arg.slice(2) : arg.startsWith('--split-string=') ? arg.slice(15) : null;
      const value = attached ?? a[i + 1];
      if (value === undefined) return unknown(i);
      const tokens = shellSplit(value);
      // An unparsable string (unterminated quote, trailing backslash) hides what runs: surface it, never skip it.
      if (tokens === null) throw new Error(`Unsupported env -S string (unterminated quote or escape): cannot tell whether the service runs code from the clone`);
      a = [...a.slice(0, i), ...tokens, ...a.slice(i + (attached === null ? 2 : 1))];
      continue;
    }
    if (name === 'env' && (arg === '-u' || arg === '--unset')) { i += 2; continue; }
    if (name === 'env' && (arg === '-C' || arg === '--chdir' || arg.startsWith('--chdir='))) {
      const v = arg.startsWith('--chdir=') ? arg.slice(8) : a[i + 1];
      if (v === undefined) return unknown(i);
      cwd = dir(v);
      i += arg.startsWith('--chdir=') ? 1 : 2; continue;
    }
    if (name === 'env' && /^(?:-[i0v]+|--unset=.*|--ignore-environment|--null|--debug)$/.test(arg)) { i += 1; continue; }
    if ((name === 'nice' && (arg === '-n' || arg === '--adjustment')) || (name === 'arch' && arg === '-arch')) { i += 2; continue; }
    if ((name === 'nice' && /^(?:-\d+|-n\d+|--adjustment=.*)$/.test(arg)) || (name === 'time' && /^-[lp]+$/.test(arg))
      || (name === 'arch' && /^-(?:arm64e?|x86_64h?|i386|32|64)$/.test(arg))
      || (name === 'caffeinate' && /^-[dimsu]+$/.test(arg)) || (name === 'command' && arg === '-p')) { i += 1; continue; }
    if (arg.startsWith('-') || arg.startsWith('+')) {
      const j = resume();
      if (j < 0) return unknown(i);
      i = j; break;
    }
    break;
  }
  if (i >= a.length) {
    // A loose wrapper with no recognizable command: any later path might be the program.
    return loose && start + 1 < a.length ? unknown(start + 1) : { owners, unknownAt: null, args: a, cwd };
  }
  const inner = codeArguments(a, i, cwd, depth + 1);
  return { owners: [...owners, ...inner.owners], unknownAt: inner.unknownAt, wide: inner.wide, args: inner.args, cwd: inner.cwd };
}
function codeArguments(args, start = 0, cwd = null, depth = 0) {
  const executable = args[start], name = basename(executable).toLowerCase();
  if (WRAPPERS.test(name) || LOOSE_WRAPPERS.test(name)) {
    const wrapped = unwrap(args, start, cwd, depth);
    return { ...wrapped, cwd: wrapped.cwd ?? cwd };
  }
  const result = { owners: [place(executable, cwd, true)], unknownAt: null, cwd, args };
  if (!INTERPRETER.test(name)) return result;
  // In a shell `-e` is errexit (a flag), not "evaluate the next argument"; `-c` is the inline-program option.
  const shell = /^(?:bash|sh|zsh|dash|ksh)$/.test(name), rubyPerl = /^(?:ruby|perl)$/.test(name);
  const noScript = new Set(shell ? ['-c', '--command'] : ['-e', '--eval', '-p', '--print', '-c', '-m', '--command']);
  // Only options that take a SEPARATE operand belong here. Python's -O/-OO are operand-free
  // optimisation flags: listing them would swallow the script path and hide the service.
  // Ruby/perl `-I dir` takes a directory operand (python's -I is the operand-free isolate flag).
  const operand = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '--conditions', '-W', '-X',
    ...(rubyPerl ? ['-I'] : [])]);
  const PRELOAD = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader']);
  // Operand-free short flags (python -B -E -I -O -P -R -S -b -d -i -q -s -u -v -x; ruby/perl -w -v), alone or combined.
  const flag = /^(?:--(?:trace-warnings|no-warnings|no-deprecation|trace-deprecation|throw-deprecation|pending-deprecation|expose-gc|use-strict|harmony|preserve-symlinks|preserve-symlinks-main|abort-on-uncaught-exception|enable-source-maps|experimental-strip-types|noprofile|norc)|-[uBbEIsSOivxdqRPw]+)$/;
  for (let i = start + 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') { result.owners.push(...args.slice(i + 1, i + 2).map(a => place(a, cwd, false))); return result; }
    // An attached `-Wvalue` / `-Xvalue` (value may contain a "c", e.g. -Wignore::DeprecationWarning) is a
    // complete option: check it before the combined-`-c` detector below.
    if (/^-[WX]./.test(arg) || rubyPerl && /^-I./.test(arg)) continue;
    if (noScript.has(arg) || (shell ? /^-[A-Za-z]*c[A-Za-z]*$/ : /^-[^-]*c/).test(arg) || /^(?:--eval|--print)=/.test(arg)) return result;
    // Preload options run the named module before the entry script, so their value is code the service
    // executes: it is an owner (a clone-backed bootstrap makes the service clone-backed), not skipped data.
    const attachedPreload = /^--(?:require|import|loader|experimental-loader)=(.+)$/.exec(arg);
    if (attachedPreload) { result.owners.push(preloadOwner(attachedPreload[1], cwd)); continue; }
    // `-r` takes an operand (a preload) only for node/ruby. In a shell it is the operand-free restricted-mode flag,
    // so the following argument is the script and must stay in view; elsewhere it falls through to the flag/unknown paths.
    if (operand.has(arg) && (arg !== '-r' || /^(?:node|nodejs|ruby)$/.test(name))) {
      if (PRELOAD.has(arg) && args[i + 1] !== undefined) result.owners.push(preloadOwner(args[i + 1], cwd));
      i += 1; continue;
    }
    if (arg.startsWith('-') || arg.startsWith('+')) {
      // `--name=value` carries its value attached, so it can never consume the next argument
      // (covers --max-old-space-size=N, --stack-size=N and the other V8/Node valued options).
      // `-Wignore` / `-Xdev` carry their value attached too, so they never consume the next argument.
      // Shell flags that take no operand (-e -u -x -eu ...); -o/-O/-c are deliberately absent.
      if (flag.test(arg) || /^--[A-Za-z][\w-]*=/.test(arg) || shell && /^-[efhilnrstuvxBCEHPT]+$/.test(arg)) continue;
      result.unknownAt = i;
      return result;
    }
    result.owners.push(place(arg, cwd, false));
    return result;
  }
  return result;
}

// A preload operand may be a file: URL (`--import file:///clone/x.mjs`); normalise it to the path it names.
function preloadOwner(value, cwd) {
  if (value.startsWith('file://')) { try { return fileURLToPath(value); } catch { return value; } }
  return place(value, cwd, false);
}
// NODE_OPTIONS preloads run in every node process the service starts, whatever its argv looks like.
// Returns the preload operands found (separate and attached forms); an unparsable string yields null.
function nodeOptionPreloads(value) {
  const tokens = shellSplit(value);
  if (tokens === null) return null;
  const out = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const attached = /^--(?:require|import|loader|experimental-loader)=(.+)$/.exec(tokens[i]);
    if (attached) out.push(attached[1]);
    else if (/^(?:-r|--require|--import|--loader|--experimental-loader)$/.test(tokens[i]) && tokens[i + 1] !== undefined) { out.push(tokens[i + 1]); i += 1; }
  }
  return out;
}

const inside = (path, root) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
const isPathArg = arg => isAbsolute(arg) || arg === '~' || arg.startsWith('~/');
// Canonical form of a path that may not exist: resolve the deepest existing ancestor and
// re-append the rest. Only "missing" errors fall through; anything else fails closed.
const missing = e => e?.code === 'ENOENT' || e?.code === 'ENOTDIR';
function canonicalSync(path, realpath) {
  try { return realpath(path); }
  catch (e) {
    const parent = dirname(path);
    if (!missing(e) || parent === path) { if (missing(e)) return path; throw e; }
    return join(canonicalSync(parent, realpath), basename(path));
  }
}
async function canonicalAsync(path, realpath) {
  try { return await realpath(path); }
  catch (e) {
    const parent = dirname(path);
    if (!missing(e) || parent === path) { if (missing(e)) return path; throw e; }
    return join(await canonicalAsync(parent, realpath), basename(path));
  }
}

function devServer(args) {
  const names = args.map(arg => basename(arg).toLowerCase().replace(/\.(?:[cm]?js|cmd|exe)$/, '').replace(/^npm-cli$/, 'npm'));
  if (names.some(name => /^(?:vite|webpack-dev(?:-server)?|storybook|serve|live-server|parcel)$/.test(name))) return true;
  return names.some((name, i) => {
    const tail = args.slice(i + 1);
    if (/^(?:npm|npx|yarn|pnpm|bun|next|nuxt|astro|wrangler|ng)$/.test(name)
      && tail.some(arg => !arg.startsWith('-') && /^(?:dev|start|serve)$/.test(arg))) return true;
    if (/^python(?:\d+(?:\.\d+)*)?$/.test(name)
      && tail.some((arg, j) => arg === '-mhttp.server' || arg === '-m' && tail[j + 1] === 'http.server')) return true;
    if (name === 'php' && tail.some(arg => /^-S/.test(arg))) return true;
    if (name === 'rollup' && tail.some(arg => /^-w|^--watch(?:=|$)/.test(arg))) return true;
    return name === 'esbuild' && tail.some(arg => /^--serve(?:=|$)/.test(arg));
  }) || args.some(arg => /(?:^|[\s/\\])(?:vite|webpack-dev(?:-server)?)(?=\s|$)|(?:^|\s)npm\s+(?:run\s+dev|start)(?=\s|$)/i.test(arg));
}

function assertActive(signal) {
  if (signal?.aborted) throw new Error('service restart cancelled: inspect LaunchAgents before retrying');
}

// Parse only: which absolute paths hold the service's executable/script, and which paths
// follow an option we could not classify. Ownership is decided by `decide`.
function parsePlist(p, { selfLabel, plistPath }) {
  if (!p || typeof p.Label !== 'string' || !p.Label.trim()) throw new Error('Invalid Label');
  const hasProgram = Object.hasOwn(p, 'Program');
  if (hasProgram && (typeof p.Program !== 'string' || !p.Program.trim())) throw new Error('Invalid Program');
  const argv = p.ProgramArguments === undefined && hasProgram ? [p.Program] : p.ProgramArguments;
  if (!Array.isArray(argv) || !argv.length || !argv.every(x => typeof x === 'string')) throw new Error('Invalid ProgramArguments');
  if (p.Label === selfLabel) return null;
  // Program is authoritative when present; argv[0] may be an arbitrary display name.
  const args = hasProgram ? [p.Program, ...argv.slice(1)] : argv;
  // An external interpreter can still execute a clone-backed script; parse its
  // effective argv while keeping Program authoritative over the displayed argv[0].
  // Only an explicit absolute/home-relative WorkingDirectory can anchor relative script paths.
  const wd = typeof p.WorkingDirectory === 'string' && isPathArg(p.WorkingDirectory) ? expand(p.WorkingDirectory) : null;
  const { owners, unknownAt, cwd, wide, args: effective } = codeArguments(args, 0, wd);
  const nodeOptions = p.EnvironmentVariables?.NODE_OPTIONS;
  if (typeof nodeOptions === 'string' && nodeOptions.trim()) {
    const preloads = nodeOptionPreloads(nodeOptions);
    // An unparsable NODE_OPTIONS hides what node preloads: surface it, never skip it.
    if (preloads === null) throw new Error('Unsupported NODE_OPTIONS string (unterminated quote or escape): cannot tell whether the service preloads code from the clone');
    owners.push(...preloads.map(v => preloadOwner(v, wd)));
  }
  // Bare executables, flags and relative paths belong to the service's context,
  // not this process's cwd. Only absolute/home-relative paths, or paths resolved against
  // the service's own explicit WorkingDirectory, prove ownership.
  // The policy check (dev servers) must see the EFFECTIVE argv: `env -S "node .../next dev"` is one string in
  // the plist, so the original args alone would let a dev server through as a restartable sampler.
  return { label: p.Label, plistPath, args: [...new Set([...args, ...effective])], unknownOption: unknownAt === null ? null : effective[unknownAt],
    paths: owners.filter(isPathArg).map(expand),
    // After an unknown interpreter option the script is the first non-option argument, or the second
    // when that option consumed an operand; later arguments are script data, not code. After an
    // unknown WRAPPER option the program position is unbounded, so every later path is a candidate.
    // Relative candidates resolve only when they carry a "/" (a bare word may be a program name or operand).
    unknownPaths: unknownAt === null ? []
      : effective.slice(unknownAt + 1).filter(a => !a.startsWith('-') && !a.startsWith('+')).slice(0, wide ? Infinity : 2)
        .map(a => place(a, cwd ?? wd, true)).filter(isPathArg).map(expand) };
}

// Lexical prefix OR same location after resolving symlinks/aliases (/var vs /private/var).
function decide(parsed, { root, canonRoot, canon }) {
  if (!parsed) return null;
  // canon() returns null when a path cannot be resolved (permission, loop): that path is
  // unrelated evidence we cannot link to the clone, so it does not flag the service.
  const owned = paths => paths.some(path => inside(path, root) || (canon(path) !== null && inside(canon(path), canonRoot)));
  if (owned(parsed.paths)) return { label: parsed.label, plistPath: parsed.plistPath, args: parsed.args };
  // An unclassifiable option hides the script position: if a clone path follows it, say so
  // instead of silently excluding the service from restart and stale detection.
  if (parsed.unknownOption !== null && owned(parsed.unknownPaths)) {
    throw new Error(`Unrecognized interpreter option ${parsed.unknownOption}: cannot tell whether the service runs code from the clone`);
  }
  return null;
}

// The adoption hook uses this asynchronous path: no synchronous directory reads or
// plutil subprocesses run on its tick. Public discovery/staleness APIs remain synchronous.
async function scanAsync({ cloneRoot, agentsDir = join(homedir(), 'Library', 'LaunchAgents'),
  readPlist = readHostPlistAsync, listPlists = dir => fsAsync.readdir(dir), selfLabel = null, signal,
  realpath = fsAsync.realpath }) {
  const matches = [], unreadable = [];
  let files;
  try { files = await listPlists(agentsDir); }
  catch (error) { return { matches, unreadable: [{ plistPath: agentsDir, error: message(error) }] }; }
  const root = expand(cloneRoot);
  let canonRoot;
  try { canonRoot = await canonicalAsync(root, realpath); }
  catch (error) { return { matches, unreadable: [{ plistPath: root, error: message(error) }] }; }
  for (const file of files) {
    assertActive(signal);
    if (!file.endsWith('.plist')) continue;
    const plistPath = resolve(agentsDir, file);
    try {
      const parsed = parsePlist(await readPlist(plistPath), { selfLabel, plistPath });
      const resolved = new Map();
      // Same laziness as the sync scan: only paths the lexical check did not already claim.
      for (const path of parsed ? [...parsed.paths, ...parsed.unknownPaths] : []) {
        if (inside(path, root)) continue;
        resolved.set(path, await canonicalAsync(path, realpath).catch(() => null));
      }
      const match = decide(parsed, { root, canonRoot, canon: path => resolved.get(path) ?? null });
      if (match) matches.push(match);
    } catch (error) { unreadable.push({ plistPath, error: message(error) }); }
  }
  return { matches, unreadable };
}

function scan({ cloneRoot, agentsDir = join(homedir(), 'Library', 'LaunchAgents'), readPlist = readHostPlist,
  listPlists = readdirSync, selfLabel = null, realpath = realpathSync }) {
  const matches = [], unreadable = [];
  let files;
  try { files = listPlists(agentsDir); } catch (error) { return { matches, unreadable: [{ plistPath: agentsDir, error: message(error) }] }; }
  const root = expand(cloneRoot);
  let canonRoot;
  try { canonRoot = canonicalSync(root, realpath); }
  catch (error) { return { matches, unreadable: [{ plistPath: root, error: message(error) }] }; }
  for (const file of files) {
    if (!file.endsWith('.plist')) continue;
    const plistPath = resolve(agentsDir, file);
    try {
      const match = decide(parsePlist(readPlist(plistPath), { selfLabel, plistPath }),
        { root, canonRoot, canon: path => { try { return canonicalSync(path, realpath); } catch { return null; } } });
      if (match) matches.push(match);
    } catch (error) { unreadable.push({ plistPath, error: message(error) }); }
  }
  return { matches, unreadable };
}

export function findServicesRunningFromClone(options) {
  const { matches, unreadable } = scan(options);
  return { matches: matches.map(({ label, plistPath }) => ({ label, plistPath })), unreadable };
}

// Per-label files survive adopting-daemon exits. Unknown/corrupt state refuses the restart.
const diskState = {
  path: label => join(homedir(), '.claude', 'launchd-code-restart', `${encodeURIComponent(label)}.json`),
  async get(label) {
    try { return JSON.parse(await fsAsync.readFile(this.path(label), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return undefined; throw e; }
  },
  async set(label, value) {
    const path = this.path(label), temp = `${path}.${process.pid}.tmp`;
    await fsAsync.mkdir(join(homedir(), '.claude', 'launchd-code-restart'), { recursive: true });
    await fsAsync.writeFile(temp, JSON.stringify(value)); await fsAsync.rename(temp, path);
  },
  // Labels whose restart was skipped by the cooldown and still owed: [{ label, at, sha, pendingSha }].
  // Cheap (one small directory listing) so every tick can ask; unreadable entries are ignored here and
  // surface through the normal `get` path when that label is next adopted.
  async pending() {
    const dir = join(homedir(), '.claude', 'launchd-code-restart');
    let files;
    try { files = await fsAsync.readdir(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    const out = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const state = JSON.parse(await fsAsync.readFile(join(dir, file), 'utf8'));
        // A marker we cannot act on (no cooldown anchor / sha) would spam every tick: ignore it here.
        if (typeof state?.pendingSha === 'string' && state.pendingSha && Number.isFinite(state.at)
          && typeof state.sha === 'string' && state.sha) out.push({ label: decodeURIComponent(file.slice(0, -5)), ...state });
      } catch { /* not a pending marker we can read */ }
    }
    return out;
  },
};
// Use the shared lock identity/entry format, with async exclusive mkdir so a slow
// filesystem cannot block the adopter's timeout. Never steal or expire a held lock:
// a paused holder can resume and still kickstart. An abandoned marker requires an
// operator to inspect its owner and remove it only after confirming that owner exited.
const diskLocks = {
  async acquire(label) {
    const root = join(homedir(), '.claude', 'launchd-code-restart', 'locks');
    const dir = lockDirFor(root, `launchd-code-restart:${label}`);
    await fsAsync.mkdir(root, { recursive: true });
    try { await fsAsync.mkdir(dir); }
    catch (error) { if (error.code === 'EEXIST') return null; throw error; }
    const entry = makeLockEntry(`launchd-code-restart:${process.pid}`, label, new Date().toISOString(), process.pid);
    // A failed metadata write leaves the exclusive marker in place, failing closed.
    await fsAsync.writeFile(join(dir, 'lock.json'), JSON.stringify(entry), { flag: 'wx' });
    return async () => { await fsAsync.rm(dir, { recursive: true }); };
  },
};
const inFlight = new Set();
const glob = (label, pattern) => pattern.endsWith('*') ? label.startsWith(pattern.slice(0, -1)) : label === pattern;
const patterns = value => Array.isArray(value) && value.every(x => typeof x === 'string' && /^(?:[^*]+\*?|\*)$/.test(x));
const defaults = { enabled: true, allow: ['com.we.*', 'com.webeverything.*'], deny: [],
  // Namespace membership alone does not establish that a service is stateless.
  approvedStatelessLabels: ['com.we.resource-sampler'], minIntervalMs: 600_000 };

// One policy for both restart and stale detection, so detection never alerts on a service
// that policy intentionally leaves alone (dev servers, non-allowed or non-approved writers).
function resolveRestartPolicy({ settings, platform, env, envValues, log }) {
  const values = envValues ?? {
    enabled: env.WE_DAEMON_SERVICE_RESTART_ENABLED === undefined ? undefined
      : ({ true: true, false: false, '1': true, '0': false })[env.WE_DAEMON_SERVICE_RESTART_ENABLED],
    minIntervalMs: env.WE_DAEMON_SERVICE_RESTART_MIN_INTERVAL_MS === undefined ? undefined : Number(env.WE_DAEMON_SERVICE_RESTART_MIN_INTERVAL_MS),
  };
  return cascadePolicy('daemon.serviceRestart', settings, { standard: defaults, platform, env, envValues: values,
    valid: { enabled: v => typeof v === 'boolean', allow: patterns, deny: patterns,
      approvedStatelessLabels: v => Array.isArray(v) && v.every(x => typeof x === 'string' && x.length > 0 && !x.includes('*')),
      minIntervalMs: v => Number.isFinite(v) && v >= 0 }, log: line => safeLog(log, line) });
}
// Why policy never restarts this service (null when it is restartable). Independent of `enabled`.
const neverRestartReason = (label, args, p) =>
  /dev|vite|storybook|playground|npm-start/i.test(label) || devServer(args) ? 'built-in-never'
  : p.deny.some(x => glob(label, x)) ? 'denied'
  : !p.allow.some(x => glob(label, x)) ? 'not-allowed'
  : !p.approvedStatelessLabels.includes(label) ? 'stateless-approval-required' : null;

export async function restartServicesForClone({ settings, platform, env = process.env, envValues,
  launchctl = launchHost, uid = userId, log = console, now = Date.now, stateStore = diskState, lockStore = diskLocks,
  adoptedSha: adoptedShaOpt, signal, pendingOnly = false, ...options } = {}) {
  const result = { restarted: [], skipped: [], flagged: [], errors: [] };
  let source = 'unresolved';
  let adoptedSha = adoptedShaOpt;
  // pendingOnly (later ticks): retry only the labels whose restart a cooldown deferred. Each owes the sha it
  // was deferred for; nothing is scanned when none is owed, and a label that no longer qualifies is cleared.
  let owed = null;
  // Clear an owed marker without rolling back a restart another process recorded since we listed it:
  // re-read first and only write when the marker we listed is still the one on disk.
  // The read-then-write must not interleave with a restart recording newer state, so it runs under the
  // label lock: callers already holding it pass `held`; others take it here and, if it is busy, leave the
  // marker in place (still owed; the next tick retries).
  const settle = async (label, previous, held = false) => {
    let release = null;
    if (!held) {
      release = await lockStore.acquire(label);
      if (release === null) return;
      if (typeof release !== 'function') throw new Error('unreadable restart lock acquisition result');
    }
    try {
      const fresh = await stateStore.get(label);
      if (fresh && fresh.pendingSha !== undefined && fresh.pendingSha === previous.pendingSha && fresh.at === previous.at) await stateStore.set(label, { at: fresh.at, sha: fresh.sha });
    } finally {
      if (release) await release();
    }
  };
  const report = (kind, service, reason) => {
    const entry = { ...service, reason };
    result[kind].push(entry);
    safeLog(log, `daemon.serviceRestart ${kind} ${service.label ?? service.plistPath ?? '?'}: ${reason} (source ${source})`);
  };
  try {
    // State is keyed by label, shared by every clone's daemon: a marker belongs to the clone that deferred it.
    if (pendingOnly) {
      owed = new Map(((await stateStore.pending?.()) ?? []).filter(x => x.pendingRoot === options.cloneRoot).map(x => [x.label, x]));
      if (!owed.size) return result;
    }
    const policy = resolveRestartPolicy({ settings, platform, env, envValues, log });
    source = JSON.stringify({ values: policy.value, sources: policy.sources });
    if (owed) {
      // Inside the cooldown there is nothing to do: skip the plist scan (one plutil per plist) until one is due.
      const current = now();
      owed = new Map([...owed].filter(([, x]) => !(current - x.at < policy.value.minIntervalMs)));
      if (!owed.size) return result;
    }
    const { matches, unreadable } = await scanAsync({ ...options, signal });
    if (!pendingOnly) for (const bad of unreadable) report('flagged', bad, 'plist-unreadable: inspect and repair plist before restarting');
    const p = policy.value;
    const seen = new Set();
    for (const { args, ...service } of matches) {
      const { label } = service;
      if (owed && !owed.has(label)) continue;
      seen.add(label);
      // A deferred restart owes the sha it was deferred for, not the (possibly absent) current adoption.
      if (owed) adoptedSha = owed.get(label).pendingSha;
      let reason = !p.enabled ? 'disabled' : neverRestartReason(label, args, p);
      if (reason) {
        if (owed) { try { await settle(label, owed.get(label)); } catch (error) { report('errors', service, message(error)); } continue; }
        report('skipped', service, reason); continue;
      }
      if (inFlight.has(label)) { report('skipped', service, 'restart-in-flight'); continue; }
      inFlight.add(label);
      let phase = 'lock', releaseLock;
      try {
        assertActive(signal);
        releaseLock = await lockStore.acquire(label);
        if (releaseLock === null) {
          if (owed) continue; // still owed; the next tick retries without repeating the lock alarm
          report('skipped', service, 'restart-lock-held');
          report('flagged', service, 'restart-lock-held: inspect the lock owner if contention persists; remove an abandoned marker only after confirming its owner exited');
          continue;
        }
        if (typeof releaseLock !== 'function') throw new Error('unreadable restart lock acquisition result');
        assertActive(signal);
        phase = 'state';
        const previous = await stateStore.get(label), at = now();
        if (!Number.isFinite(at)) throw new Error('unreadable clock');
        if (previous !== undefined && (!previous || typeof previous !== 'object' || Array.isArray(previous)
          || !Number.isFinite(previous.at) || previous.at < 0 || typeof previous.sha !== 'string' || !previous.sha.trim())) {
          throw new Error('unreadable restart state: inspect persisted state');
        }
        // An owed retry was planned from a listing made before the lock: trust only what is on disk now.
        // Cleared, taken by another clone, or replaced by a newer sha => follow the marker, never the listing.
        if (owed) {
          if (!previous || previous.pendingSha === undefined || previous.pendingRoot !== options.cloneRoot) continue;
          adoptedSha = previous.pendingSha;
        }
        if (typeof adoptedSha !== 'string' || !adoptedSha.trim()) throw new Error('unknown adopted sha: inspect rebuild state');
        reason = previous && adoptedSha && previous.sha === adoptedSha ? 'same-adopted-sha'
          : previous && at - previous.at < p.minIntervalMs ? 'debounced' : null;
        if (reason === 'debounced') {
          // Remember the restart we owe: a later tick retries it once the cooldown has passed.
          // A newer adoption simply replaces the owed sha; a successful restart clears it.
          if (!owed) await stateStore.set(label, { ...previous, pendingSha: adoptedSha, pendingRoot: options.cloneRoot });
          if (!owed) report('skipped', service, reason);
          continue;
        }
        if (reason) {
          // Already running the adopted sha (e.g. A, B deferred, then back to A): nothing is owed any more.
          if (previous.pendingSha !== undefined) await settle(label, previous, true);
          if (!owed) report('skipped', service, reason);
          continue;
        }
        const id = typeof uid === 'function' ? uid() : uid;
        if (!Number.isInteger(id) || id < 0) throw new Error('unreadable uid');
        // Record intent BEFORE kickstart: process death or launchctl failure must not
        // erase the cooldown. A failed write refuses the restart and requires inspection.
        await stateStore.set(label, { at, sha: adoptedSha });
        phase = 'launch';
        assertActive(signal);
        // No mid-write signal exists. kickstart -k is the operator's proven operation for
        // these stateless samplers; exact stateless approval plus the allowlist safeguards writers.
        const answer = await launchctl(['kickstart', '-k', `gui/${id}/${label}`]);
        if (answer?.error || answer?.status != null && answer.status !== 0 || answer?.code != null && answer.code !== 0) throw new Error(message(answer.error ?? answer.stderr ?? 'launchctl failed'));
        report('restarted', service, 'kickstart -k');
      } catch (error) {
        if (phase === 'lock') report('flagged', service, `restart-lock-failed: inspect the per-label lock and its owner before retrying; ${message(error)}`);
        if (phase === 'state') report('flagged', service, `restart-state-failed: inspect persisted state before retrying; ${message(error)}`);
        report('errors', service, phase === 'launch' ? `${message(error)}; intent retained, inspect service before retrying` : message(error));
      }
      finally {
        try { if (typeof releaseLock === 'function') await releaseLock(); }
        catch (error) {
          report('flagged', service, `restart-lock-release-failed: inspect lock ownership before removing the marker; ${message(error)}`);
          report('errors', service, message(error));
        }
        inFlight.delete(label);
      }
    }
    // An owed label whose plist is gone (or no longer clone-backed) has nothing to restart: stop retrying it.
    // Unreadable plists could be the owed service, so absence only counts as evidence on a clean scan.
    if (owed && unreadable.length === 0) for (const [label, state] of owed) {
      if (!seen.has(label)) { try { await settle(label, state); } catch (error) { report('errors', { label }, message(error)); } }
    }
  } catch (error) { report('errors', {}, message(error)); }
  return result;
}

function processStart(label, { launchctl, uid, ps }) {
  let printed;
  try { printed = launchctl(['print', `gui/${typeof uid === 'function' ? uid() : uid}/${label}`]); }
  catch (e) {
    if (/could not find service/i.test(String(e.stderr ?? e.message))) return null;
    throw e;
  }
  if (printed?.status && printed.status !== 0) throw new Error('launchctl print failed');
  const output = typeof printed === 'string' ? printed : printed?.stdout;
  if (typeof output !== 'string') throw new Error('unreadable launchctl print');
  const pid = output.match(/\bpid\s*=\s*(\d+)/)?.[1];
  if (!pid) {
    if (/state\s*=\s*(?:not running|waiting|exited)/i.test(output)) return null;
    throw new Error('unknown launchctl process state');
  }
  const start = Date.parse(ps(['-o', 'lstart=', '-p', pid]).trim());
  if (!Number.isFinite(start)) throw new Error('unreadable process start');
  return start;
}

/** null process start means positively not running; unknown evidence is flagged.
 * onFreshService reports positive clean evidence so health episodes can close without treating absence as clean. */
export function findStaleCodeServices({ readProcessStartMs = processStart, onFreshService = () => {},
  readAdoptedAtMs = root => Date.parse(readRebuildState(root)?.adopted?.at ?? ''),
  launchctl = printHost, uid = userId, ps = argv => execFileSync('ps', argv, commandOptions),
  settings, platform, env = process.env, envValues, log, ...options } = {}) {
  const { matches, unreadable } = scan(options);
  const flagged = unreadable.map(x => ({ label: null, ...x, reason: 'plist-unreadable' }));
  // Same policy as the restart path; an unreadable policy fails closed into an unreadable flag.
  let p = null, policyError = null;
  try { p = resolveRestartPolicy({ settings, platform, env, envValues, log }).value; } catch (error) { policyError = error; }
  for (const { args, ...service } of matches) {
    try {
      if (policyError) throw policyError;
      // Services policy never restarts are neither stale nor fresh evidence: stay silent.
      if (neverRestartReason(service.label, args, p)) continue;
      const start = readProcessStartMs(service.label, { launchctl, uid, ps });
      if (start === null) { onFreshService(service); continue; }
      if (!Number.isFinite(start)) throw new Error('unreadable process start');
      const adopted = readAdoptedAtMs(options.cloneRoot);
      if (!Number.isFinite(adopted)) { flagged.push({ ...service, reason: 'adoption-unreadable' }); continue; }
      if (start < Math.floor(adopted / 1000) * 1000) flagged.push({ ...service, reason: 'stale-code', processStartMs: start, adoptedAtMs: adopted });
      else onFreshService(service);
    } catch (error) { flagged.push({ ...service, reason: 'process-unreadable', error: message(error) }); }
  }
  return flagged;
}
