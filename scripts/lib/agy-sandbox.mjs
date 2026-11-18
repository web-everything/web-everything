import { isAbsolute, join, normalize } from 'node:path';

export const sandboxSecretPaths = home => ['.ssh', '.aws', '.gnupg', '.config/gh',
  'Library/Keychains', '.plateau'].map(p => join(home, p));
const safePath = p => {
  if (typeof p !== 'string' || !isAbsolute(p) || normalize(p) !== p || /["\\\x00-\x1f\x7f-\x9f]/.test(p))
    throw new Error('unsafe sandbox path; use another provider or request operator review');
  return p;
};
const inside = (p, root) => p === root || p.startsWith(`${root}/`);

/** Pure SBPL builder. Inputs are canonical absolute paths resolved by the launcher.
 * deniedPaths lets the launcher resolve secret symlinks; extraDeniedPaths supports isolated probes. */
export function buildSandboxProfile({ cloneDir, privateTempDir, laneDir, homeDir, workspaceOps,
  agyBinDir, workspaceDir = join(homeDir, 'workspace'), deniedPaths = sandboxSecretPaths(homeDir), extraDeniedPaths = [] }) {
  const stateDir = join(homeDir, '.gemini/antigravity-cli');
  const projectsFile = join(homeDir, '.gemini/projects.json');
  const sessionDirs = ['log', 'cache', 'conversations', 'brain', 'crashes', 'presence', 'persistent_terminals', 'implicit']
    .map(p => join(stateDir, p));
  const writable = [cloneDir, privateTempDir, ...sessionDirs, projectsFile];
  const readable = [cloneDir, privateTempDir, stateDir, join(homeDir, '.gemini/config'),
    ...(agyBinDir && inside(agyBinDir, homeDir) ? [agyBinDir] : [])];
  [homeDir, workspaceDir, workspaceOps, laneDir, ...writable, ...readable, ...(agyBinDir ? [agyBinDir] : []), ...deniedPaths, ...extraDeniedPaths].forEach(safePath);
  if (agyBinDir && [workspaceDir, join(homeDir, 'workspace')].some(p => inside(agyBinDir, p) || inside(p, agyBinDir)))
    throw new Error('agy binary overlaps workspace; use another provider or request operator review');
  if (writable.some(p => [workspaceDir, join(homeDir, 'workspace'), laneDir].some(root => inside(p, root) || inside(root, p))))
    throw new Error('sandbox writable path under home/workspace or lane; use another provider or request operator review');
  if (inside(privateTempDir, cloneDir) || inside(cloneDir, privateTempDir))
    throw new Error('sandbox temp must be outside clone; use another provider or request operator review');
  const subpath = p => `(subpath ${JSON.stringify(p)})`;
  const projectsTemp = `^${projectsFile.replace(/[.*+?^${}()|]/g, '[$&]')}[.][^/]*[.]tmp$`;
  const stateFiles = ['conversation_summaries.db', 'conversation_summaries.db-wal', 'conversation_summaries.db-shm',
    'conversation_summaries.db-journal', 'jetbox_summaries_proto.pb', 'jetski_state.pbtxt', 'history.jsonl', 'cli.log'];
  const stateRules = stateFiles.flatMap(name => {
    const file = join(stateDir, name);
    const escaped = file.replace(/[.*+?${}()|]/g, '[$&]'); // char classes: SBPL regex strings do not process backslash escapes
    return [`(literal ${JSON.stringify(file)})`, `(regex #${JSON.stringify(`^${escaped}([.][^/]*)?[.]tmp$`)})`];
  }).join(' ');
  return ['(version 1)', '(allow default)', `(deny file-read* ${subpath(homeDir)})`,
    `(allow file-read* ${readable.map(subpath).join(' ')} (literal ${JSON.stringify(projectsFile)}) (regex #${JSON.stringify(projectsTemp)}))`, '(deny file-write*)',
    `(allow file-write* ${[cloneDir, privateTempDir, ...sessionDirs].map(subpath).join(' ')} ${stateRules} (literal ${JSON.stringify(projectsFile)}) (regex #${JSON.stringify(projectsTemp)}) (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper"))`,
    `(deny file-read* ${[...deniedPaths, workspaceDir, join(homeDir, 'workspace'), workspaceOps, ...extraDeniedPaths].map(subpath).join(' ')})`, ''].join('\n');
}

export function buildSandboxEnv(env, privateTempDir) {
  return { ...Object.fromEntries(Object.entries(env).filter(([key]) =>
    /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_[A-Za-z0-9_]+|TERM)$/.test(key))),
  TMPDIR: privateTempDir, TMP: privateTempDir, TEMP: privateTempDir };
}

export const sandboxedSpawnArgv = (profileFile, argv) => ['sandbox-exec', '-f', profileFile, ...argv];
