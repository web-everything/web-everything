import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize } from 'node:path';

// Exactly what agy needs for state writes; extend only with measured evidence.
export const AGY_STATE_WRITE_DIRS = ['.gemini/antigravity-cli/log'];
// Keep production unavailable until real deny-default spawn probes pass outside a nested sandbox.
// No setting or environment override may bypass that proof gate.
export const AGY_BUILD_CONFINEMENT = Object.freeze({
  mode: 'unavailable',
  reason: 'antigravity build refused: confinement unavailable: deny-default live sandbox proof is pending; use another provider or request operator review',
});
export function assertAgyBuildConfinement() {
  if (AGY_BUILD_CONFINEMENT.mode !== 'sandboxed') throw new Error(AGY_BUILD_CONFINEMENT.reason);
}
export const sandboxSecretPaths = home => ['.ssh', '.aws', '.gnupg', '.netrc', '.secrets', '.config/gh',
  'Library/Keychains', '.plateau'].map(p => join(home, p));
const safePath = p => {
  if (typeof p !== 'string' || !isAbsolute(p) || normalize(p) !== p || /["\\\x00-\x1f\x7f-\x9f]/.test(p))
    throw new Error('unsafe sandbox path; use another provider or request operator review');
  return p;
};
const inside = (p, root) => p === root || p.startsWith(`${root}/`);

/** Deny-default SBPL. No Mach/XPC, socket, network or general exec grants.
 * Inputs are canonical absolute paths resolved by the launcher; secret denies stay last.
 * No process-fork, sysctl-read or mach-lookup exceptions without Sandbox violation-log evidence.
 * deniedPaths lets the launcher resolve secret symlinks; extraDeniedPaths supports isolated probes. */
export function buildSandboxProfile({ transcriptDir, cloneDir, privateTempDir, laneDir, homeDir, workspaceOps,
  agyBinDir, homebrewPrefix, workspaceDir = join(homeDir, 'workspace'), deniedPaths = sandboxSecretPaths(homeDir), extraDeniedPaths = [],
  executables = { node: realpathSync(process.execPath), git: '/usr/bin/git' } }) {
  if (!executables || Array.isArray(executables) || typeof executables !== 'object'
    || !Object.keys(executables).length
    || Object.entries(executables).some(([name, path]) => !['node', 'npm', 'git', 'agy'].includes(name) || path === '/'))
    throw new Error('invalid sandbox executable policy; use another provider or request operator review');
  Object.values(executables).forEach(safePath);
  const stateDirs = AGY_STATE_WRITE_DIRS.map(p => join(homeDir, p));
  const writable = [cloneDir, privateTempDir, ...stateDirs];
  const binaryRoots = [...new Set([agyBinDir, homebrewPrefix,
    ...Object.values(executables).map(dirname),
    ...Object.values(executables).map(p => p.match(/^(.*)\/(?:Cellar|Caskroom)\//)?.[1]),
  ].filter(Boolean))];
  safePath(transcriptDir);
  [homeDir, workspaceDir, workspaceOps, laneDir, ...writable, ...binaryRoots, ...deniedPaths, ...extraDeniedPaths].forEach(safePath);
  if ([...writable, workspaceDir, join(homeDir, 'workspace'), laneDir]
    .some(p => inside(transcriptDir, p) || inside(p, transcriptDir)))
    throw new Error('transcript directory overlaps sandbox writable roots/workspace/lane; use another provider or request operator review');
  if (binaryRoots.some(bin => [workspaceDir, join(homeDir, 'workspace')].some(p => inside(bin, p) || inside(p, bin))))
    throw new Error('agy binary overlaps workspace; use another provider or request operator review');
  if ([cloneDir, privateTempDir].some(p => inside(p, join(homeDir, '.gemini')) || inside(join(homeDir, '.gemini'), p)))
    throw new Error('sandbox path overlaps real agy state');
  if (writable.some(p => [workspaceDir, join(homeDir, 'workspace'), laneDir].some(root => inside(p, root) || inside(root, p))))
    throw new Error('sandbox writable path under home/workspace or lane; use another provider or request operator review');
  if (inside(privateTempDir, cloneDir) || inside(cloneDir, privateTempDir))
    throw new Error('sandbox temp must be outside clone; use another provider or request operator review');
  const subpath = p => `(subpath ${JSON.stringify(p)})`;
  const ancestors = [...new Set([cloneDir, privateTempDir, join(homeDir, '.gemini'), ...binaryRoots,
    ...Object.values(executables)].flatMap(p => {
    const out = []; for (let d = dirname(p); d !== '/' && d !== '.'; d = dirname(d)) out.push(d); return out;
  }))];
  // Measured by bisecting a real sandbox-exec node run (SIGABRT without them): node needs to read the root
  // directory entry itself, fork for child spawns and read sysctls. No mach/network/signal grants were needed.
  return ['(version 1)', '(deny default)', '(deny network*)', '(deny file-write*)',
    '(allow process-fork)', '(allow sysctl-read)',
    ...Object.values(executables).map(p => `(allow process-exec (literal ${JSON.stringify(p)}))`),
    `(allow file-write* ${writable.map(subpath).join(' ')} (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper"))`,
    `(deny file-read* ${subpath(homeDir)})`,
    `(allow file-read* ${[cloneDir, privateTempDir, join(homeDir, '.gemini'), ...binaryRoots,
      '/usr', '/bin', '/System', '/Library', '/private/var/db', '/private/preboot/Cryptexes/OS',
      '/dev/null', '/dev/urandom', '/dev/random', '/dev/dtracehelper'].map(subpath).join(' ')})`,
    '(allow file-read* (literal "/"))',
    // Measured: realpath of any script/cwd lstat()s every ancestor (EPERM on /private otherwise). Metadata of the
    // ancestor directories only, never their contents.
    `(allow file-read-metadata ${ancestors.map(p => `(literal ${JSON.stringify(p)})`).join(' ')})`,
    `(deny file-read* ${[...deniedPaths, workspaceDir, join(homeDir, 'workspace'), workspaceOps, ...extraDeniedPaths].map(subpath).join(' ')})`,
    '(deny file-read* (regex #"/\\.env[^/]*$"))', ''].join('\n');
}

export function buildSandboxEnv(env, privateTempDir, homeDir) {
  return { ...Object.fromEntries(Object.entries(env).filter(([key]) =>
    /^(PATH|USER|LOGNAME|SHELL|LANG|LC_[A-Za-z0-9_]+|TERM)$/.test(key))),
  HOME: safePath(homeDir), TMPDIR: privateTempDir, TMP: privateTempDir, TEMP: privateTempDir };
}

export const sandboxedSpawnArgv = (profileFile, argv) => ['sandbox-exec', '-f', profileFile, ...argv];
