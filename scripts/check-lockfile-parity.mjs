#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function packageMap(lock, label) {
  if (!lock || !lock.packages || typeof lock.packages !== 'object' || Array.isArray(lock.packages)) {
    throw new Error(label + ': missing packages map');
  }
  return lock.packages;
}

function add(map, name, version) {
  if (!name || typeof version !== 'string' || !version) throw new Error('Invalid package name/version');
  if (!map.has(name)) map.set(name, new Set());
  map.get(name).add(version);
}

/**
 * Require pnpm versions to be npm-pinned and retain every npm name, ignoring placement and peer contexts, AND
 * require every pnpm package to carry registry integrity that npm's lock vouches for (one of npm's
 * space-separated hashes for that name@version). A pnpm entry with no integrity, or any other resolution
 * (tarball, git, directory), is `unverified`; both kinds fail parity, which only ever routes a lane to npm ci.
 * No IO.
 */
export function compareLockfiles(npmLock, pnpmLock) {
  const npm = new Map();
  const pnpm = new Map();
  const npmIntegrity = new Map(); // name@version → Set of hashes
  for (const [path, entry] of Object.entries(packageMap(npmLock, 'npm'))) {
    if (path === '') continue;
    if (!entry || typeof entry !== 'object') throw new Error('Invalid npm package: ' + path);
    if (entry.link === true) continue;
    const name = entry.name || path.split('node_modules/').at(-1);
    add(npm, name, entry.version);
    const id = name + '@' + entry.version;
    if (!npmIntegrity.has(id)) npmIntegrity.set(id, new Set());
    for (const token of String(entry.integrity ?? '').split(/\s+/)) if (token) npmIntegrity.get(id).add(token);
  }
  const integrityMismatches = new Set();
  const unverified = new Set();
  for (const [key, value] of Object.entries(packageMap(pnpmLock, 'pnpm'))) {
    const base = key.split('(')[0];
    const separator = base.lastIndexOf('@');
    if (separator <= 0 || separator === base.length - 1) {
      throw new Error('Invalid pnpm package key: ' + key);
    }
    add(pnpm, base.slice(0, separator), base.slice(separator + 1));
    const integrity = value && typeof value === 'object' && !value.unverified ? value.integrity : undefined;
    if (typeof integrity !== 'string' || !integrity) unverified.add(base);
    else if (npmIntegrity.has(base) && !npmIntegrity.get(base).has(integrity)) integrityMismatches.add(base);
  }
  const onlyInNpm = [];
  const onlyInPnpm = [];
  const npmOnlyExtraVersions = [];
  const versionDisagreements = [];
  for (const name of [...new Set([...npm.keys(), ...pnpm.keys()])].sort()) {
    const a = [...(npm.get(name) || [])].sort();
    const b = [...(pnpm.get(name) || [])].sort();
    const npmExtras = a.filter(v => !b.includes(v)).map(v => name + '@' + v);
    (b.length ? npmOnlyExtraVersions : onlyInNpm).push(...npmExtras);
    const unpinned = b.filter(v => !a.includes(v));
    onlyInPnpm.push(...unpinned.map(v => name + '@' + v));
    if (a.length && unpinned.length) {
      versionDisagreements.push({ name, npm: a, pnpm: b });
    }
  }
  return { ok: !onlyInNpm.length && !onlyInPnpm.length && !integrityMismatches.size && !unverified.size,
    onlyInNpm, onlyInPnpm, versionDisagreements, npmOnlyExtraVersions,
    integrityMismatches: [...integrityMismatches].sort(), unverified: [...unverified].sort() };
}

// Read only pnpm's block-map layout, not general YAML. This runs BEFORE deps install.
function readPnpmProject(source) {
  const documents = source.split(/^---\s*(?:#.*)?$/m).map(text => {
    const doc = { project: false, environment: false, snapshots: false };
    let section;
    let current; // the package entry whose metadata lines follow
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*(?:#.*)?$/.test(line) || /^\.\.\.\s*$/.test(line)) continue;
      if (/^\S/.test(line)) {
        current = undefined;
        const header = /^([\w-]+):(?:\s|$)/.exec(line);
        section = header?.[1];
        if (section === 'snapshots') doc.snapshots = true;
        if (section === 'packages') {
          if (doc.packages || !/^packages:\s*(?:\{\})?\s*(?:#.*)?$/.test(line)) {
            throw new Error('pnpm: invalid packages map');
          }
          doc.packages = Object.create(null);
        }
        continue;
      }
      if (section === 'importers') {
        if (/^ {4}(?:dependencies|devDependencies|optionalDependencies|specifiers):/.test(line)) {
          doc.project = true;
        }
        if (/^ {4}(?:packageManagerDependencies|configDependencies):/.test(line)) {
          doc.environment = true;
        }
      }
      if (section !== 'packages') continue;
      if (/^ {4}/.test(line)) { // package metadata: only `resolution` matters
        if (!current || !/^ {4}resolution:/.test(line)) continue;
        // Only the one-line registry form is verified; any other shape (tarball, git, directory, multi-line,
        // a second resolution line) marks the package unverified.
        const resolution = /^ {4}resolution:\s*\{\s*integrity:\s*([^\s,{}]+)\s*\}\s*(?:#.*)?$/.exec(line);
        if (resolution && current.integrity === undefined && !current.unverified) current.integrity = resolution[1];
        else current.unverified = true;
        continue;
      }
      const entry = /^ {2}(?:'((?:[^']|'')+)'|([^\s'"].*?)):\s*(?:\{\})?\s*(?:#.*)?$/.exec(line);
      if (!entry) throw new Error('pnpm: invalid package entry: ' + line.trim());
      const key = entry[1] === undefined ? entry[2] : entry[1].replace(/''/g, "'");
      if (Object.hasOwn(doc.packages, key)) throw new Error('pnpm: duplicate package: ' + key);
      current = doc.packages[key] = {};
    }
    return doc;
  });
  // The environment document can also contain snapshots; exclude it first.
  const candidates = documents.filter(doc => !doc.environment && (doc.packages || doc.project || doc.snapshots));
  return candidates.find(doc => doc.project) || candidates.find(doc => doc.snapshots) || candidates.at(-1);
}

export function readLockfileParity(dir) {
  const project = readPnpmProject(readFileSync(resolve(dir, 'pnpm-lock.yaml'), 'utf8'));
  if (!project) throw new Error('pnpm: missing project lockfile');
  return compareLockfiles(
    JSON.parse(readFileSync(resolve(dir, 'package-lock.json'), 'utf8')),
    project,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = readLockfileParity(process.cwd());
    if (result.npmOnlyExtraVersions.length) {
      console.log('npm-only extra versions (informational):\n  ' + result.npmOnlyExtraVersions.join('\n  '));
    }
    if (result.ok) console.log('Lockfile parity: npm and pnpm package sets agree');
    else {
      for (const [label, entries] of [
        ['only-in-npm', result.onlyInNpm], ['only-in-pnpm', result.onlyInPnpm],
        ['version disagreements', result.versionDisagreements.map(
          row => row.name + ': npm=' + row.npm.join(',') + ' pnpm=' + row.pnpm.join(','))],
        ['integrity mismatches (pnpm hash not in npm lock)', result.integrityMismatches],
        ['unverified (no registry integrity in pnpm lock)', result.unverified],
      ]) {
        if (entries.length) console.error(label + ':\n  ' + entries.join('\n  '));
      }
      process.exitCode = 1;
    }
  } catch (error) {
    console.error('Lockfile parity: ' + error.message);
    process.exitCode = 1;
  }
}
