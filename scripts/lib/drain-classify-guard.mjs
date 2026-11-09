import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';
import { promisify } from 'node:util';

const READ_ONLY_TOOLS = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'sort', 'uniq', 'sleep', 'date', 'uname', 'hostname',
  'which', 'stat', 'pwd', 'true', 'false', 'ps', 'pgrep', 'sysctl', 'vm_stat', 'uptime', 'id', 'whoami', 'df', 'basename', 'dirname']);

/** A command seam guard, not a sandbox for executing untrusted programs. */
export function isMutatingGhCall(cmd, args = []) {
  const name = basename(String(cmd));
  const a = args.map(String);
  if (['sh', 'bash', 'zsh', 'env'].includes(name)) {
    if (name === 'env') {
      let i = 0;
      while (/^[A-Za-z_][A-Za-z_0-9]*=/.test(a[i] || '')) i++;
      // Options can unset the guard or alter command parsing. Refuse those wrappers.
      if (!a[i] || a[i].startsWith('-')) return true;
      return isMutatingGhCall(a[i], a.slice(i + 1));
    }
    // A shell can run anything: refuse every shell wrapper (fail closed). Callers must use argv.
    return true;
  }
  if (name === 'git') {
    // Global options can install aliases/helpers: only the direct read forms are admitted.
    // Fetch only updates local object/ref storage (never the remote): admit it for plain remote + refspec args,
    // refusing helper-executing options and any destination outside refs/remotes/.
    if (a[0] === 'fetch') {
      const okOpts = new Set(['--quiet', '-q', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules']);
      return a.slice(1).some(arg => arg.startsWith('-') ? !(okOpts.has(arg) || /^--depth=\d+$/.test(arg)) :
        (arg.includes(':') && !/^\+?[\w./-]*:refs\/remotes\/[\w./-]+$/.test(arg)) || arg.includes('..') || arg.startsWith('ext::'));
    }
    // Read-only metadata forms the gh shim and drain use (remote URLs, config reads, ref listings).
    if (a[0] === 'remote') return !(a.length === 1 || (a[1] === '-v' && a.length === 2) || (a[1] === 'get-url' && a.length <= 4 && !a.includes('--push-all')));
    if (a[0] === 'config') return !['--get', '--get-all', '--get-regexp', '--list', '-l'].includes(a.find(x => x.startsWith('-')) || '') || a.some(x => /^--(?:unset|add|replace|edit|set)/.test(x));
    if (a[0] === 'branch') return !(a.length === 1 || ['--show-current', '--list', '-l', '-a', '-r', '-v', '-vv', '--contains'].includes(a[1]));
    if (['symbolic-ref', 'rev-list', 'for-each-ref', 'show-ref', 'describe', 'name-rev', 'ls-remote'].includes(a[0])) {
      return a[0] === 'symbolic-ref' && a.some(x => x === '-d' || x === '--delete' || (!x.startsWith('-') && a.filter(y => !y.startsWith('-')).length > 2));
    }
    if (!['rev-parse', 'status', 'diff', 'show', 'log', 'ls-tree', 'merge-base', 'ls-files', 'cat-file'].includes(a[0])) return true;
    // Diff-producing commands can execute configured helpers even without an
    // explicit enabling flag. Require the protections first, before options that
    // could consume them as values or a pathspec separator could hide them.
    // The drain's own reads are `diff --numstat ...` (stat only, no content/driver) and
    // `diff --no-ext-diff --end-of-options ...`; textconv commands exist only in local trusted git config.
    if (['diff', 'show', 'log'].includes(a[0])) {
      const head = a.slice(1, a.findIndex((x, i) => i > 0 && (x === '--' || x === '--end-of-options')) > 0 ? a.findIndex((x, i) => i > 0 && (x === '--' || x === '--end-of-options')) : a.length);
      const statOnly = a[0] === 'diff' && head.some(x => ['--numstat', '--name-only', '--name-status', '--shortstat', '--stat'].includes(x));
      const both = head.includes('--no-ext-diff') && head.includes('--no-textconv');
      // `diff` is admitted here because the wrapper injects --no-ext-diff --no-textconv (see hardenGitArgs).
      // Only `diff` gets the relaxed forms (the drain's own calls); show/log keep requiring both protections.
      if (!statOnly && !(a[0] === 'diff' ? head.includes('--no-ext-diff') : both)) return true;
    }
    // Read commands can still write files or invoke external programs. Git accepts
    // unambiguous long-option abbreviations, so reject their prefixes as well.
    const unsafe = ['--output', '--ext-diff', '--textconv', '--filters', '--open-files-in-pager', '--exec'];
    return a.slice(1).some(arg => {
      const flag = arg.split('=', 1)[0];
      if (arg === '--no-ext-diff' || arg === '--no-textconv') return false;
      // Repeated negation can re-enable an option; refuse it and abbreviations.
      const normalized = flag.replace(/^--(?:no-)+/, '--');
      return normalized.startsWith('--') && normalized.length > 2 && unsafe.some(option => option.startsWith(normalized));
    });
  }
  if (name === 'node' || cmd === process.execPath) {
    // The gh-throttle wrapper is how the drain reaches gh: judge its argv as the gh call it forwards.
    const i = a.findIndex(x => basename(x) === 'gh-throttle.mjs');
    if (i >= 0) return isMutatingGhCall('gh', a.slice(i + 1));
    // Other node children are guarded too: installGuard() propagates the preload through NODE_OPTIONS.
    return /(?:enqueue|refresh|numbering|number-at-birth)/i.test(a.join(' '));
  }
  // Fail closed: only an explicit allowlist of read-only utilities may run; everything else is refused.
  if (name !== 'gh') return !READ_ONLY_TOOLS.has(name) || /(?:enqueue|refresh|numbering|number-at-birth)/i.test(a.join(' '));
  if (a[0] === 'api') {
    let method = null;
    let fields = false;
    for (let i = 1; i < a.length; i++) {
      const arg = a[i];
      if (arg === '-X' || arg === '--method') {
        const m = a[++i];
        if (m !== 'GET') return true;
        method = m;
      } else if (/^(?:-X|--method=)/.test(arg)) {
        const m = arg.replace(/^(?:-X|--method=)/, '');
        if (m !== 'GET') return true;
        method = m;
      }
      if (/^(?:-[fF]|--(?:raw-)?field(?:=|$)|--input(?:=|$))/.test(arg)) fields = true;
    }
    // GraphQL is POST even for reads: admit it only when the query document is a plain query (no mutation/subscription
    // anywhere in it) and any method override is absent. Anything unparseable fails closed.
    if (a.includes('graphql')) {
      if (method !== null) return true;
      const q = a.map((x, i) => (/^(?:-[fF]|--(?:raw-)?field)$/.test(a[i - 1] || '') ? x : /^(?:-[fF]|--(?:raw-)?field)=/.test(x) ? x.replace(/^[^=]*=/, '') : null))
        .filter(x => typeof x === 'string' && x.startsWith('query=')).map(x => x.slice(6));
      if (q.length !== 1 || a.some(x => /^--input(?:=|$)/.test(x))) return true;
      return !/^\s*(?:query\b|\{)/.test(q[0]) || /\b(?:mutation|subscription)\b/i.test(q[0]);
    }
    return fields && method !== 'GET';
  }
  const reads = { pr: ['view', 'list', 'diff', 'checks'], repo: ['view'], run: ['list', 'view'], auth: ['status'] };
  return !reads[a[0]]?.includes(a[1]) || a.includes('--web');
}

/** Returns argv with the protections a caller omitted: every admitted `git diff` runs with --no-ext-diff --no-textconv. */
export function hardenGitArgs(cmd, args) {
  if (basename(String(cmd)) !== 'git' || !Array.isArray(args) || args[0] !== 'diff') return args;
  const extra = ['--no-ext-diff', '--no-textconv'].filter(f => !args.includes(f));
  return extra.length ? ['diff', ...extra, ...args.slice(1)] : args;
}

function assertRead(cmd, args, shell = false) {
  // Shell strings are admitted only as a single simple argv command. Compound syntax fails closed.
  if (shell) {
    const text = [cmd, ...(Array.isArray(args) ? args : [])].join(' ');
    if (/[;&|<>`$()\n\r\\'"]/.test(text)) throw new Error('DRAIN_CLASSIFY_ONLY: shell command refused; use read-only argv');
    const words = text.trim().split(/\s+/);
    cmd = words.shift(); args = words;
    if (basename(String(cmd)) === 'git' && args[0] === 'diff' && !(args.includes('--no-ext-diff') && args.includes('--no-textconv'))) {
      throw new Error('DRAIN_CLASSIFY_ONLY: shell git diff must carry --no-ext-diff --no-textconv');
    }
  }
  if (isMutatingGhCall(cmd, Array.isArray(args) ? args : [])) {
    throw new Error(`DRAIN_CLASSIFY_ONLY: mutating or unknown command refused (${String([cmd, ...(Array.isArray(args) ? args : [])].join(' ')).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 120)}); use the local drain`);
  }
}

let installed = false;
export function installGuard() {
  if (installed) return;
  installed = true;
  // Every node child inherits the guard, so a forwarded gh-throttle / script child cannot escape it.
  const preload = `--import=${import.meta.url}`;
  if (!String(process.env.NODE_OPTIONS || '').includes(preload)) process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ''} ${preload}`.trim();
  for (const key of ['execFile', 'execFileSync', 'spawn', 'spawnSync', 'exec', 'execSync']) {
    const original = childProcess[key];
    const check = argv => {
      const options = Array.isArray(argv[1]) ? argv[2] : argv[1];
      assertRead(argv[0], argv[1], key === 'exec' || key === 'execSync' || !!options?.shell);
    };
    const harden = (argv, phase) => {
      if (phase === 'post' && Array.isArray(argv[1]) && !(key === 'exec' || key === 'execSync')) argv[1] = hardenGitArgs(argv[0], argv[1]);
      // exec/execSync take one command string (already restricted to a single simple command by assertRead).
      if (phase === 'pre' && (key === 'exec' || key === 'execSync') && typeof argv[0] === 'string') {
        const m = /^(\s*(?:\S*\/)?git\s+diff)(\s|$)/.exec(argv[0]);
        if (m) {
          const words = argv[0].trim().split(/\s+/).slice(2);
          // Same admission rule as the argv form: only a diff that already asks for --no-ext-diff (or is stat-only) is
          // completed with the missing protections; anything else is left untouched and refused by assertRead.
          const statOnly = words.some(x => ['--numstat', '--name-only', '--name-status', '--shortstat', '--stat'].includes(x));
          const extra = (statOnly || words.includes('--no-ext-diff') ? ['--no-ext-diff', '--no-textconv'] : []).filter(f => !words.includes(f));
          if (extra.length) argv[0] = `${m[1]} ${extra.join(' ')}${argv[0].slice(m[1].length)}`;
        }
      }
      return argv;
    };
    const wrapped = function (...argv) { harden(argv, 'pre'); check(argv); harden(argv, 'post'); return Reflect.apply(original, this, argv); };
    if (original[promisify.custom]) {
      wrapped[promisify.custom] = function (...argv) { harden(argv, 'pre'); check(argv); harden(argv, 'post'); return Reflect.apply(original[promisify.custom], this, argv); };
    }
    childProcess[key] = wrapped;
  }
  syncBuiltinESMExports();
}

if (process.env.DRAIN_CLASSIFY_ONLY === '1') installGuard();
