/**
 * @file scripts/operations/daemons-render-io.mjs
 * @description File effects and CLI for rendering daemon plists; installed plists are read-only.
 */
import { execFileSync } from 'node:child_process';
import { constants, closeSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { diffPlists, renderAll, validateTable } from './daemons-render.mjs';

const TABLE = join(dirname(fileURLToPath(import.meta.url)), '../settings/daemon-tasks.json');

export function readTable(path = TABLE) {
  return validateTable(JSON.parse(readFileSync(path, 'utf8')));
}

function filename(value) {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[/\\\x00-\x1f\x7f]/.test(value)) throw new Error('unsafe plist filename');
  return value;
}

// Resolve existing ancestors too, so a not-yet-created directory beneath a symlink is protected.
function physical(path) {
  try { return realpathSync(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(physical(parent), basename(path));
  }
}

const inside = (path, root) => { const suffix = relative(root, path); return !suffix || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`)); };

/** Render artifacts only; refuse the installed directory, its descendants, and symlink aliases. */
export function writeOutDir(out, files, { home = process.env.HOME } = {}) {
  if (!home || !out) throw new Error('output directory and host home are required');
  const target = resolve(out);
  // Always protect the actual HOME, even when --host-home selects a different rendering overlay.
  for (const root of new Set([home, process.env.HOME].filter(Boolean))) {
    const installed = resolve(root, 'Library/LaunchAgents');
    if (inside(target, installed) || inside(physical(target), physical(installed))) throw new Error('refusing output inside Library/LaunchAgents; choose a scratch output directory');
  }
  for (const file of files) {
    filename(file.file);
    if (file.file !== `${file.label}.plist` || typeof file.xml !== 'string') throw new Error('invalid rendered file');
  }
  mkdirSync(target, { recursive: true });
  for (const file of files) {
    // Exclusive creation also refuses existing file symlinks and hardlinks; use a fresh output directory.
    const fd = openSync(join(target, file.file), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try { writeFileSync(fd, file.xml, 'utf8'); } finally { closeSync(fd); }
  }
}

/** Read-only plutil conversion. Unreadable/malformed evidence propagates to the caller. */
export function readInstalled(label, { home = process.env.HOME, exec = execFileSync } = {}) {
  filename(label);
  if (!home) throw new Error('host home is required');
  return JSON.parse(exec('plutil', ['-convert', 'json', '-o', '-', join(home, 'Library/LaunchAgents', `${label}.plist`)], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
  }));
}

const terminal = value => value.replace(/[\x00-\x1f\x7f-\x9f]/g, '');

/** CLI argv excludes node and script. PATH is an explicit portable default, never ambient PATH. */
export function main(argv, { log = console.log, installedReader = readInstalled } = {}) {
  const options = {};
  for (const arg of argv) {
    if (arg === '--dry-run' && !options.dryRun) { options.dryRun = true; continue; }
    const match = /^--(out|host-home|node)=(.+)$/.exec(arg);
    if (!match || Object.hasOwn(options, match[1])) throw new Error('unknown, duplicate or incomplete option; use --out=<dir> or --dry-run, with --host-home=<dir> and --node=<path>');
    options[match[1]] = match[2];
  }
  if (Boolean(options.out) === Boolean(options.dryRun)) throw new Error('choose exactly one of --out=<dir> or --dry-run');
  const home = options['host-home'] ?? process.env.HOME;
  const nodePath = options.node ?? process.execPath;
  if (!home || !isAbsolute(home) || !isAbsolute(nodePath)) throw new Error('host home and node must be absolute paths');
  const host = { home, nodePath, path: `${dirname(nodePath)}:/usr/bin:/bin:/usr/sbin:/sbin` };
  const files = renderAll(readTable(), host);
  if (options.out) writeOutDir(options.out, files, { home });
  let incomplete = false;
  for (const file of files) {
    if (options.dryRun) {
      try {
        const differences = diffPlists(file.xml, installedReader(file.label, { home }));
        log(`${terminal(file.file)}: differences: ${differences.map(terminal).join(', ') || 'none'}`);
      } catch {
        incomplete = true;
        log(`${terminal(file.file)}: installed evidence unreadable; inspect this installed plist and rerun --dry-run`);
      }
    } else log(`${terminal(file.file)}: rendered`);
    if (file.pendingHostEnv.length) log(`${terminal(file.file)}: pendingHostEnv: ${file.pendingHostEnv.join(', ')}`);
  }
  if (incomplete) throw new Error('dry-run incomplete: installed evidence could not be compared');
  log(`${files.length} plists ${options.dryRun ? 'compared' : 'rendered'}`);
  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); }
  catch {
    // Filesystem/plutil errors can contain host paths or environment values; keep CLI output relative.
    console.error(`${basename(fileURLToPath(import.meta.url))}: failed; check options, table, output permissions or installed evidence`);
    process.exitCode = 1;
  }
}
