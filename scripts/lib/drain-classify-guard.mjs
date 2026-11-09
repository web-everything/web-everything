import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';
import { promisify } from 'node:util';

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
    return a.some(s => /\b(?:gh|git|enqueue|refresh|numbering)\b/.test(s));
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
  if (name !== 'gh') return /(?:enqueue|refresh|numbering|number-at-birth)/i.test([cmd, ...a].join(' '));
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
    // GraphQL uses POST even for queries. No GraphQL exception in this slice.
    if (a.includes('graphql')) return true;
    return fields && method !== 'GET';
  }
  const reads = { pr: ['view', 'list', 'diff', 'checks'], repo: ['view'], run: ['list', 'view'], auth: ['status'] };
  return !reads[a[0]]?.includes(a[1]) || a.includes('--web');
}

function assertRead(cmd, args, shell = false) {
  // Shell strings are admitted only as a single simple argv command. Compound syntax fails closed.
  if (shell) {
    const text = [cmd, ...(Array.isArray(args) ? args : [])].join(' ');
    if (/[;&|<>`$()\n\r\\'"]/.test(text)) throw new Error('DRAIN_CLASSIFY_ONLY: shell command refused; use read-only argv');
    const words = text.trim().split(/\s+/);
    cmd = words.shift(); args = words;
  }
  if (isMutatingGhCall(cmd, Array.isArray(args) ? args : [])) {
    throw new Error(`DRAIN_CLASSIFY_ONLY: mutating or unknown command refused (${String([cmd, ...(Array.isArray(args) ? args : [])].join(' ')).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 120)}); use the local drain`);
  }
}

let installed = false;
export function installGuard() {
  if (installed) return;
  installed = true;
  for (const key of ['execFile', 'execFileSync', 'spawn', 'spawnSync', 'exec', 'execSync']) {
    const original = childProcess[key];
    const check = argv => {
      const options = Array.isArray(argv[1]) ? argv[2] : argv[1];
      assertRead(argv[0], argv[1], key === 'exec' || key === 'execSync' || !!options?.shell);
    };
    const wrapped = function (...argv) { check(argv); return Reflect.apply(original, this, argv); };
    if (original[promisify.custom]) {
      wrapped[promisify.custom] = function (...argv) { check(argv); return Reflect.apply(original[promisify.custom], this, argv); };
    }
    childProcess[key] = wrapped;
  }
  syncBuiltinESMExports();
}

if (process.env.DRAIN_CLASSIFY_ONLY === '1') installGuard();
