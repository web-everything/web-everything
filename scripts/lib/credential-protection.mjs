/**
 * R1082: lexical content-read boundary, pure and filesystem independent.
 * ls (including -l) is names/metadata only and falls through. Only ssh and ssh-add
 * bypass argument checks (ssh remote command paths belong to the remote). Redirections
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
const expandHome = (s, home) => s.replace(/\$\{HOME\}|\$HOME\b|~(?=\/)/g, () => home);
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
export function classifyBashCommand(command, options = {}) {
  if (typeof command !== 'string') return pass();
  // Quotes may occur within a shell word (~/'.ssh'/id) or an interpreter string.
  // Removing them is conservative: quoted literal references can also deny.
  const text = command.replace(/\\\n/g, '').replace(/["'`]/g, '');
  const references = segment => {
    const expanded = expandHome(segment, options.home ?? '');
    // Preserve a HOME containing spaces: shell quoting was stripped above, but the
    // complete expanded prefix is still present. Require real path boundaries.
    for (const entry of withProtectedPathFloor(options.protectedPaths)) {
      if (entry.path === '.env*') continue;
      const root = expandHome(entry.path, options.home ?? '');
      const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(^|[\\s=:(,<>])${escaped}(?=$|[/\\s*?;|<>()},:])`).test(expanded)) {
        return { decision: 'deny', path: root, reason: entry.reason };
      }
    }
    // Interpreter source punctuation and shell metacharacters delimit path literals.
    const words = expanded.split(/[\s;&|<>(){},=:+]+/).filter(Boolean);
    for (const word of words) {
      const hit = classifyProtectedPath(word.replace(/^@/, ''), options);
      if (hit.decision === 'deny') return hit;
    }
    return pass();
  };
  // Redirect targets remain protected even on otherwise exempt commands.
  for (const m of text.matchAll(/[<>]+\s*([^\s;&|<>()]+)/g)) {
    const hit = references(m[1]);
    if (hit.decision === 'deny') return hit;
  }
  // Splitting parentheses also exposes $(cat ...) inside otherwise allowed commands.
  for (const segment of text.split(/&&|\|\||[;|\n()]/)) {
    const words = segment.trim().split(/\s+/);
    while (/^[\w]+=.*/.test(words[0]) || ['command', 'builtin', 'exec', 'sudo', 'env'].includes(words[0])) words.shift();
    const executable = basename(words[0] ?? '');
    if (['ls', 'ssh', 'ssh-add'].includes(executable)) continue;
    const hit = references(segment);
    if (hit.decision === 'deny') return hit;
  }
  return pass();
}
