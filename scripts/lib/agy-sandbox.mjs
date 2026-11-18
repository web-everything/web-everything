import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';

export const sandboxSecretPaths = home => ['.ssh', '.aws', '.gnupg', '.config/gh',
  'Library/Keychains', '.plateau'].map(p => join(home, p));
const safePath = p => {
  if (typeof p !== 'string' || !isAbsolute(p) || normalize(p) !== p || /["\\\x00-\x1f\x7f-\x9f]/.test(p))
    throw new Error('unsafe sandbox path; use another provider or request operator review');
  return p;
};
const inside = (p, root) => p === root || p.startsWith(`${root}/`);

/** Seed clone-only trust and only agy's own login; never inherit host settings or MCP config. */
export function preparePrivateAgyHome(homeDir, privateHomeDir, cloneDir) {
  let login;
  try {
    const fd = openSync(join(homeDir, '.gemini/antigravity-cli/antigravity-oauth-token'), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('invalid agy login file');
      // One extra byte detects growth without allowing an unbounded read.
      const buffer = Buffer.alloc(stat.size + 1);
      let size = 0, count;
      while (size < buffer.length && (count = readSync(fd, buffer, size, buffer.length - size, null)) > 0) size += count;
      if (size !== stat.size) throw new Error('agy login size changed');
      login = buffer.subarray(0, size);
    } finally { closeSync(fd); }
    const stateDir = join(privateHomeDir, '.gemini/antigravity-cli');
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(stateDir, 'antigravity-oauth-token'), login, { mode: 0o600, flag: 'wx' });
  } catch {
    throw new Error('agy login unavailable; use another provider or request operator review');
  }
  try {
    const stateDir = join(privateHomeDir, '.gemini/antigravity-cli');
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(stateDir, 'settings.json'), JSON.stringify({ trustedWorkspaces: [cloneDir] }), { mode: 0o600, flag: 'wx' });
  } catch {
    throw new Error('private agy settings preparation failed; use another provider or request operator review');
  }
}

/** Pure SBPL builder. Inputs are canonical absolute paths resolved by the launcher.
 * deniedPaths lets the launcher resolve secret symlinks; extraDeniedPaths supports isolated probes. */
export function buildSandboxProfile({ transcriptDir, cloneDir, privateTempDir, laneDir, homeDir, privateHomeDir, workspaceOps, osTempBase,
  agyBinDir, homebrewPrefix, workspaceDir = join(homeDir, 'workspace'), deniedPaths = sandboxSecretPaths(homeDir), extraDeniedPaths = [] }) {
  const privateState = join(privateHomeDir, '.gemini');
  const writable = [cloneDir, privateTempDir, privateState];
  safePath(osTempBase);
  safePath(transcriptDir);
  const readDenied = ['/Users', '/Volumes', '/private/tmp', '/tmp',
    inside(osTempBase, '/private/var/folders') ? '/private/var/folders' : osTempBase, homeDir];
  const binaryRoots = [agyBinDir, homebrewPrefix].filter(Boolean);
  const readable = [cloneDir, privateTempDir, privateHomeDir, ...binaryRoots];
  readDenied.forEach(safePath);
  [homeDir, workspaceDir, workspaceOps, laneDir, ...writable, ...readable, ...(agyBinDir ? [agyBinDir] : []), ...deniedPaths, ...extraDeniedPaths].forEach(safePath);
  if ([...writable, privateHomeDir, workspaceDir, join(homeDir, 'workspace'), laneDir]
    .some(p => inside(transcriptDir, p) || inside(p, transcriptDir)))
    throw new Error('transcript directory overlaps sandbox writable roots/home/workspace/lane; use another provider or request operator review');
  if (binaryRoots.some(bin => [workspaceDir, join(homeDir, 'workspace')].some(p => inside(bin, p) || inside(p, bin))))
    throw new Error('agy binary overlaps workspace; use another provider or request operator review');
  if (binaryRoots.some(p => inside(p, join(homeDir, '.gemini')) || inside(join(homeDir, '.gemini'), p)))
    throw new Error('agy binary overlaps real state');
  if ([...writable, privateHomeDir].some(p => inside(p, join(homeDir, '.gemini')) || inside(join(homeDir, '.gemini'), p)))
    throw new Error('sandbox path overlaps real agy state');
  if ([cloneDir, laneDir, workspaceDir, join(homeDir, 'workspace')].some(p => inside(privateHomeDir, p) || inside(p, privateHomeDir)))
    throw new Error('private home overlaps clone, lane or workspace');
  if (writable.some(p => [workspaceDir, join(homeDir, 'workspace'), laneDir].some(root => inside(p, root) || inside(root, p))))
    throw new Error('sandbox writable path under home/workspace or lane; use another provider or request operator review');
  if (inside(privateTempDir, cloneDir) || inside(cloneDir, privateTempDir))
    throw new Error('sandbox temp must be outside clone; use another provider or request operator review');
  const subpath = p => `(subpath ${JSON.stringify(p)})`;
  return ['(version 1)', '(allow default)', ...readDenied.map(p => `(deny file-read* ${subpath(p)})`),
    `(allow file-read* ${readable.map(subpath).join(' ')})`, '(deny file-write*)',
    `(allow file-write* ${writable.map(subpath).join(' ')} (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper"))`,
    `(deny file-read* ${[...deniedPaths, workspaceDir, join(homeDir, 'workspace'), workspaceOps, ...extraDeniedPaths].map(subpath).join(' ')})`, ''].join('\n');
}

export function buildSandboxEnv(env, privateTempDir, privateHomeDir) {
  return { ...Object.fromEntries(Object.entries(env).filter(([key]) =>
    /^(PATH|USER|LOGNAME|SHELL|LANG|LC_[A-Za-z0-9_]+|TERM)$/.test(key))),
  HOME: safePath(privateHomeDir), TMPDIR: privateTempDir, TMP: privateTempDir, TEMP: privateTempDir };
}

export const sandboxedSpawnArgv = (profileFile, argv) => ['sandbox-exec', '-f', profileFile, ...argv];
