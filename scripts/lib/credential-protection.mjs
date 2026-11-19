/**
 * R1082: lexical content-read boundary, pure and filesystem independent.
 * ls (including -l) is names/metadata only and falls through. Only ssh and ssh-add
 * allow only plain -i/-F path operands and safe options. Redirections
 * and nested commands are checked even inside these allowed commands. Other commands
 * referencing protected paths conservatively deny (including interpreters, archives,
 * copies, transforms, grep/sed/awk and ssh-keygen -y/-f). Exact .env.example,
 * .env.sample and .env.template names pass; .sshfoo and my.ssh are not .ssh.
 * This is a layered lexical guard, not a shell sandbox: computed paths, aliases,
 * symlinks and programs opening unnamed secrets need OS isolation/push scanning.
 */
import { resolve, basename } from 'node:path';

export const DEFAULT_PROTECTED_PATHS = Object.freeze([
  ['~/.ssh', 'SSH private keys and authentication material'],
  ['~/.gnupg', 'GPG private keys'], ['~/.aws', 'AWS credentials'],
  ['~/.docker', 'Docker registry credentials'], ['~/.kube', 'Kubernetes credentials'],
  ['~/.netrc', 'Network login credentials'], ['~/.secrets', 'Local secrets'],
  ['~/.config/gh/hosts.yml', 'GitHub authentication tokens'],
  ['.env*', 'Environment secrets in any directory'],
].map(([path, reason]) => Object.freeze({ path, reason })));
export const DEFAULT_CREDENTIAL_PROTECTION = Object.freeze({
  protectedPaths: DEFAULT_PROTECTED_PATHS, gitleaks: { mode: 'auto' },
  agentBashDecision: 'deny', readOnlyListing: 'pass',
});
export const STRICT_CREDENTIAL_PROTECTION = Object.freeze({ ...DEFAULT_CREDENTIAL_PROTECTION, gitleaks: { mode: 'require' } });
export const validProtectedPaths = value => Array.isArray(value) && value.length > 0
  && value.every(p => p && typeof p.path === 'string' && (p.path === '.env*' || /^~\/[\w./-]+$/.test(p.path))
    && !p.path.split('/').includes('..') && typeof p.reason === 'string' && p.reason.trim());

/** Custom entries extend the built-in floor; they cannot replace it. */
export const withProtectedPathFloor = (entries = []) => [...new Map(
  [...entries, ...DEFAULT_PROTECTED_PATHS].map(entry => [entry.path, entry]),
).values()];

/** PURE reader: an unreadable/invalid file uses strict defaults, never disables protection. */
export function readCredentialProtection(text) {
  try {
    const p = JSON.parse(text);
    if (!validProtectedPaths(p.protectedPaths) || !['auto', 'require', 'off'].includes(p.gitleaks?.mode)
      || p.agentBashDecision !== 'deny' || p.readOnlyListing !== 'pass') return structuredClone(STRICT_CREDENTIAL_PROTECTION);
    return { protectedPaths: withProtectedPathFloor(p.protectedPaths), gitleaks: p.gitleaks, agentBashDecision: 'deny', readOnlyListing: 'pass' };
  } catch { return structuredClone(STRICT_CREDENTIAL_PROTECTION); }
}

const examples = new Set(['.env.example', '.env.sample', '.env.template']);
const expandHome = (s, home) => s.replace(/\$\{HOME\}|\$HOME\b|~(?=\/|$)/g, () => home);
export function classifyProtectedPath(path, { home, repoRoot, protectedPaths = DEFAULT_PROTECTED_PATHS } = {}) {
  if (typeof path !== 'string' || !home || !repoRoot) return { decision: 'pass', path: null, reason: null };
  const full = resolve(repoRoot, expandHome(path, home));
  for (const entry of withProtectedPathFloor(protectedPaths)) {
    if (entry.path === '.env*') {
      const name = basename(full);
      if (name.startsWith('.env') && !examples.has(name)) {
        return { decision: 'deny', path: full, reason: entry.reason };
      }
    } else {
      const root = resolve(expandHome(entry.path, home));
      if (full === root || full.startsWith(`${root}/`)) return { decision: 'deny', path: full, reason: entry.reason };
    }
  }
  return { decision: 'pass', path: null, reason: null };
}

const pass = () => ({ decision: 'pass', path: null, reason: null });
// Decode ANSI-C fragments before removing shell quoting or word escapes. Locale
// quotes use ordinary quote removal; the '$' prefix is not part of the path.
const decodeAnsi = text => text.replace(/\\(x[\da-fA-F]{1,2}|[0-7]{1,3}|u[\da-fA-F]{1,4}|U[\da-fA-F]{1,8}|c[\s\S]|[\s\S])/g, (whole, escape) => {
  const simple = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', "'": "'", '"': '"', '\\': '\\', '?': '?' };
  if (Object.hasOwn(simple, escape)) return simple[escape];
  if (escape[0] === 'c') return String.fromCharCode(escape.charCodeAt(1) & 31);
  if (/^[xuU]/.test(escape)) {
    const point = parseInt(escape.slice(1), 16);
    return point <= 0x10ffff ? String.fromCodePoint(point) : whole;
  }
  if (/^[0-7]/.test(escape)) return String.fromCharCode(parseInt(escape, 8) & 255);
  return whole;
});
const normalizeWord = word => word
  .replace(/\$'((?:\\[\s\S]|[^'\\])*)'/g, (_, body) => decodeAnsi(body))
  .replace(/\$"/g, '"').replace(/\\(.)/gs, '$1').replace(/["']/g, '');
const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Compile a shell glob component. Braces are alternatives; stars never cross '/'.
function globRegex(pattern) {
  let out = '';
  // Unbalanced braces are literal text in a shell, not an alternation.
  const braces = pattern.split('{').length === pattern.split('}').length;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (!braces && (c === '{' || c === '}' || c === ',')) { out += escapeRegex(c); continue; }
    if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else if (c === '[' && pattern.indexOf(']', i + 1) > i + 1) {
      const end = pattern.indexOf(']', i + 1);
      let chars = pattern.slice(i + 1, end);
      if (chars.startsWith('!')) chars = '^' + chars.slice(1);
      out += '[' + chars.replace(/\\/g, '\\\\') + ']'; i = end;
    } else if (c === '{') out += '(?:';
    else if (c === '}') out += ')';
    else if (c === ',') out += '|';
    else out += escapeRegex(c);
  }
  return new RegExp(`^(?:${out})$`);
}
// Conservative: could this glob basename match some name starting with ".env"? Walks the first four
// pattern characters against ".env"; a star or brace is treated as a possible match (fail closed).
function envPrefixPossible(name) {
  const target = '.env';
  let i = 0;
  for (let t = 0; t < target.length; t++) {
    const c = name[i];
    if (c === undefined) return false;
    if (c === '*') { if (i === 0) return false; return true; } // a leading star is covered by the witness names above
    if (c === '{') return name.includes('}', i);
    if (c === '?') { i++; continue; }
    if (c === '[') {
      const end = name.indexOf(']', i + 1);
      if (end < 0) return false;
      try { if (!new RegExp(`^${'[' + name.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']'}$`).test(target[t])) return false; } catch { return true; }
      i = end + 1; continue;
    }
    if (c !== target[t]) return false;
    i++;
  }
  return !examples.has(name);
}
function patternHit(word, options) {
  if (word === '{}') return pass(); // find's placeholder, not a glob
  const full = resolve(options.repoRoot, expandHome(word, options.home));
  if (!/[*?\[{]/.test(full)) return classifyProtectedPath(word, options);
  const parts = full.split('/');
  try {
    for (const entry of withProtectedPathFloor(options.protectedPaths)) {
      if (entry.path === '.env*') {
        const name = parts.at(-1);
        const regex = globRegex(name);
        // Include the pattern's literal suffix to witness arbitrary .env variants.
        const suffix = name.replace(/[*?\[\]{}!,]/g, '');
        if (['.env', '.env.local', `.env${suffix}`].some(v => !examples.has(v) && regex.test(v)) || envPrefixPossible(name)) {
          return { decision: 'deny', path: full, reason: entry.reason };
        }
      } else {
        const root = resolve(expandHome(entry.path, options.home));
        const roots = root.split('/');
        if (parts.slice(0, roots.length).every((part, i) => globRegex(part).test(roots[i]))) {
          return { decision: 'deny', path: root, reason: entry.reason };
        }
      }
    }
  } catch {
    return { decision: 'deny', path: full, reason: 'Unparseable path pattern; use an explicit path and retry' };
  }
  return pass();
}
// Only concrete protected paths participate: .env* remains a basename rule,
// rather than making every directory a forbidden recursive source.
function ancestorHit(word, options) {
  const full = resolve(options.repoRoot, expandHome(word, options.home));
  for (const entry of withProtectedPathFloor(options.protectedPaths)) {
    if (entry.path === '.env*') continue;
    const root = resolve(expandHome(entry.path, options.home));
    if (root === full || root.startsWith(full.endsWith('/') ? full : `${full}/`)) {
      return { decision: 'deny', path: full,
        reason: `Recursive access can reach ${root}: ${entry.reason}; use explicit non-protected subpaths` };
    }
  }
  return pass();
}

function recursiveAncestorHit(words, options) {
  const name = basename(words[0] ?? '');
  let args = words.slice(1);
  const search = ['grep', 'egrep', 'fgrep', 'rg', 'ag'].includes(name);
  const recursive = new Set(['tar', 'zip', '7z', '7za', '7zr', 'cp', 'rsync', 'scp', 'rg', 'ag', 'cpio', 'ditto', 'pax', 'mv']);
  if (['grep', 'egrep', 'fgrep'].includes(name)) {
    if (!args.some(w => w === '--recursive' || /^-[^-]*[rR]/.test(w))) return pass();
  } else if (name === 'find') {
    if (!args.some(w => /^-(?:exec|execdir|ok|okdir|fprint.*|fls)$/.test(w))) return pass();
    while (['-H', '-L', '-P'].includes(args[0])) args.shift();
    // Expressions are not search roots (in particular, the -fprint destination).
    args = args.slice(0, args.findIndex(w => w.startsWith('-') || w === '!') >>> 0);
  } else if (name === 'git') {
    const subcommand = args.findIndex(w => ['add', 'commit'].includes(w));
    if (subcommand < 0) return pass();
    args = args.slice(subcommand + 1);
  } else if (!recursive.has(name)) return pass();

  let repoRoot = options.repoRoot;
  let literal = false;
  let grepPattern = search;
  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    if (!literal && word === '--') { literal = true; continue; }
    if (!literal && ['tar', 'zip'].includes(name)
      && (word === '-C' || word === '--directory' || word.startsWith('--directory=') || word.startsWith('-C'))) {
      const dir = word === '-C' || word === '--directory' ? args[++i]
        : word.startsWith('--directory=') ? word.slice(12) : word.slice(2);
      if (!dir) return { decision: 'deny', path: word, reason: 'Missing archive directory; use an explicit directory and retry' };
      repoRoot = resolve(repoRoot, expandHome(dir, options.home));
      continue;
    }
    if (!literal && search && ['-e', '--regexp', '-f', '--file'].includes(word)) {
      i++; grepPattern = false; continue;
    }
    if (!literal && search && /^(?:--(?:regexp|file)=|-[ef].+)/.test(word)) {
      grepPattern = false; continue;
    }
    if (!literal && name === 'git' && ['-m', '--message', '-F', '--file'].includes(word)) { i++; continue; }
    if (!literal && word.startsWith('-')) continue;
    if (grepPattern) { grepPattern = false; continue; }
    // Remote scp/rsync operands are conservatively checked as path operands too.
    const operand = ['scp', 'rsync'].includes(name) && word.includes(':') ? word.slice(word.indexOf(':') + 1) : word;
    if (!operand) continue;
    const hit = ancestorHit(operand, { ...options, repoRoot });
    if (hit.decision === 'deny') return hit;
  }
  return pass();
}

export function classifyBashCommand(command, options = {}) {
  if (typeof command !== 'string') return pass();
  // Preserve quoted/escaped whitespace in operands before shell quote removal.
  for (const segment of command.replace(/\\\n/g, '').split(/&&|\|\||[;|\n()`]/)) {
    const words = (segment.match(/(?:\$?'(?:\\.|[^'\\])*'|\$?"(?:\\.|[^"\\])*"|\\[\s\S]|[^\s"'\\])+/g) ?? []).map(normalizeWord);
    while (/^[\w]+=.*/.test(words[0]) || ['command', 'builtin', 'exec', 'sudo', 'env'].includes(words[0])) words.shift();
    const hit = recursiveAncestorHit(words, options);
    if (hit.decision === 'deny') return hit;
  }
  // Retain substitutions for the SSH check; normalize adjacent shell fragments
  // before tokenization so escaping cannot conceal a protected directory.
  const text = normalizeWord(command.replace(/\\\n/g, ''));
  const references = segment => {
    const expanded = expandHome(segment, options.home ?? '');
    for (const entry of withProtectedPathFloor(options.protectedPaths)) {
      if (entry.path === '.env*' || !/\s/.test(options.home ?? '')) continue;
      const root = expandHome(entry.path, options.home ?? '');
      if (new RegExp(`(^|[\\s=:(,<>])${escapeRegex(root)}(?=$|[/\\s*?;|<>()},:])`).test(expanded)) {
        return { decision: 'deny', path: root, reason: entry.reason };
      }
    }
    // Keep braces and brackets within glob words, including brace commas.
    const words = segment.split(/[\s;&|<>()=:+`]+/).filter(Boolean);
    for (const word of words) {
      const hit = patternHit(word.replace(/^@/, ''), options);
      if (hit.decision === 'deny') return hit;
    }
    return pass();
  };
  // Examine each SSH segment before splitting nested shell constructs.
  for (const segment of text.split(/&&|\|\||[;|\n]/)) {
    const words = segment.trim().split(/\s+/);
    while (/^[\w]+=.*/.test(words[0]) || ['command', 'builtin', 'exec', 'sudo', 'env'].includes(words[0])) words.shift();
    if (!['ssh', 'ssh-add'].includes(basename(words[0] ?? ''))) continue;
    const refuse = () => ({ decision: 'deny', path: 'ssh', reason: 'Unsafe SSH arguments; use plain -i/-F operands and safe options' });
    if (/ProxyCommand|LocalCommand/i.test(segment) || /`|\$\(|<\(|>\(/.test(segment)) return refuse();
    const safe = new Set(['stricthostkeychecking', 'batchmode', 'connecttimeout', 'userknownhostsfile', 'identityfile', 'port', 'user']);
    for (let i = 1; i < words.length; i++) {
      const word = words[i];
      if (word === '-i' || word === '-F') {
        const operand = words[++i];
        if (!operand || operand.startsWith('-') || /[*?\[{}<>`]/.test(operand)) return refuse();
        continue;
      }
      if (word === '-o' || word.startsWith('-o')) {
        const value = word === '-o' ? words[++i] : word.slice(2);
        if (!value || !safe.has(value.split('=')[0].toLowerCase())) return refuse();
        if (!value.includes('=')) {
          const operand = words[++i];
          if (!operand || references(operand).decision === 'deny') return refuse();
        }
        if (references(value).decision === 'deny') return refuse();
        continue;
      }
      if (references(word).decision === 'deny') return refuse();
    }
  }
  for (const m of text.matchAll(/[<>]+\s*([^\s;&|<>()]+)/g)) {
    const hit = references(m[1]);
    if (hit.decision === 'deny') return hit;
  }
  // Split every nested command boundary, including backticks exposed by removing
  // escape layers. No outer metadata/SSH exemption can hide a substitution body.
  for (const segment of text.split(/&&|\|\||[;|\n()`]/)) {
    const words = segment.trim().split(/\s+/);
    while (/^[\w]+=.*/.test(words[0]) || ['command', 'builtin', 'exec', 'sudo', 'env'].includes(words[0])) words.shift();
    if (['ls', 'ssh', 'ssh-add'].includes(basename(words[0] ?? ''))) continue;
    const hit = references(segment);
    if (hit.decision === 'deny') return hit;
  }
  return pass();
}
