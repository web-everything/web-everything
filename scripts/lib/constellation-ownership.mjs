import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const destinations = Object.freeze([
  'standard-def', 'everstandards-conformance', 'longshore', 'plateau', 'repo-local', 'data-by-topic',
]);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// Deliberately small glob language: no implicit basename matching, negation or braces.
function globRegex(glob) {
  if (typeof glob !== 'string' || !glob || glob.startsWith('/') ||
      glob.split('/').some(part => part === '..' || part === '.') || /[\\\x00-\x1f\x7f{}\[\]!]/.test(glob)) {
    throw new Error('Invalid repository path glob');
  }
  let source = '^';
  for (let i = 0; i < glob.length; i++) {
    if (glob[i] === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { source += '(?:.*/)?'; i++; }
      else source += '.*';
    } else if (glob[i] === '*') source += '[^/]*';
    else if (glob[i] === '?') source += '[^/]';
    else source += glob[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(source + '$');
}

/** Pure classifier; validates every overlap in the supplied inventory, even shadowed ones. */
export function classify(paths, map) {
  if (map?.order !== 'first-match') throw new Error('Map order must be first-match');
  if (!Array.isArray(map.rules)) throw new Error('Map rules must be an array');
  const rules = map.rules.map(rule => {
    if (!destinations.includes(rule.destination)) throw new Error('Unknown destination');
    if (rule.original !== undefined && !destinations.includes(rule.original)) throw new Error('Unknown original destination');
    if (rule.override !== undefined && typeof rule.override !== 'boolean') throw new Error('Invalid override');
    return { ...rule, regex: globRegex(rule.glob) };
  });
  if (!Array.isArray(paths)) throw new Error('Paths must be an array');
  const seen = new Set();
  const files = paths.map(path => {
    if (typeof path !== 'string' || !path || path.startsWith('/') ||
        path.split('/').some(part => !part || part === '.' || part === '..') || /[\\\x00-\x1f\x7f]/.test(path)) {
      throw new Error('Invalid repository path');
    }
    if (seen.has(path)) throw new Error(`Duplicate path: ${path}`);
    seen.add(path);
    const matches = rules.filter(rule => rule.regex.test(path));
    if (!matches.length) throw new Error(`Unclassified path: ${path}; add an ownership rule before retrying`);
    for (let i = 0; i < matches.length; i++) {
      for (let j = i + 1; j < matches.length; j++) {
        if (matches[i].destination !== matches[j].destination && matches[i].override !== true) {
          throw new Error(`Double-classified path: ${path} (${matches[i].glob}, ${matches[j].glob}); declare the earlier override or narrow its glob`);
        }
      }
    }
    const { destination, original } = matches[0];
    return { path, destination, ...(original === undefined ? {} : { original }) };
  });
  return {
    files,
    reclassified: files.filter(file => file.original !== undefined && file.original !== file.destination)
      .map(({ path, original, destination }) => ({ path, original, destination })),
  };
}

/** Keep unique index paths still present, including dangling symlinks and unmerged index entries. */
export function existingTrackedPaths(paths) {
  // ls-files repeats a path for each unmerged stage; ownership counts working-tree leaves.
  return [...new Set(paths)].filter(path => {
    try {
      lstatSync(resolve(root, path));
      return true;
    } catch (error) {
      // A removed parent, or one replaced by a file, also removes its index children.
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
      throw error;
    }
  });
}

function readTracked(path) {
  const filename = resolve(root, path);
  const stat = lstatSync(filename);
  if (stat.isSymbolicLink()) return Buffer.from(readlinkSync(filename));
  if (!stat.isFile()) throw new Error(`Cannot count non-file: ${path}`);
  return readFileSync(filename);
}

/** Count working-tree contents, including symlink text without following its target. */
export function totals(files, readContent = readTracked) {
  const result = Object.fromEntries(destinations.map(destination => [destination, { files: 0, lines: 0 }]));
  for (const { path, destination } of files) {
    if (!Object.hasOwn(result, destination)) throw new Error('Unknown destination in totals');
    const content = Buffer.from(readContent(path));
    const entry = result[destination];
    entry.files++;
    if (content.includes(0)) continue;
    for (const byte of content) if (byte === 10) entry.lines++;
    if (content.length && content[content.length - 1] !== 10) entry.lines++;
  }
  return result;
}

function main(args) {
  if (args[0] !== 'classify' || args.length > 2 || (args[1] !== undefined && args[1] !== '--json')) {
    throw new Error('Usage: node scripts/lib/constellation-ownership.mjs classify [--json]');
  }
  const map = JSON.parse(readFileSync(resolve(root, 'config/constellation-ownership.json'), 'utf8'));
  const paths = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    .split('\0').filter(Boolean);
  const result = classify(existingTrackedPaths(paths), map);
  result.totals = totals(result.files);
  if (args[1] === '--json') process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else {
    for (const [destination, count] of Object.entries(result.totals)) {
      process.stdout.write(`${destination}: ${count.files} files, ${count.lines} lines\n`);
    }
    process.stdout.write('reclassified:\n' + JSON.stringify(result.reclassified, null, 2) + '\n');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    // JSON quoting keeps any filename/control text inert in terminal diagnostics.
    process.stderr.write(JSON.stringify(error.message) + '\n');
    process.exitCode = 1;
  }
}
