import { lstatSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MIB = 1024 * 1024;

export function findOversizedAssets(dir, limitBytes = 24 * MIB) {
  if (!Number.isFinite(limitBytes) || limitBytes <= 0) {
    throw new Error('Asset size limit must be a positive finite number of bytes');
  }
  const root = resolve(dir);
  if (!lstatSync(root).isDirectory()) throw new Error(`Not a directory: ${dir}`);
  const oversized = [];
  function walk(directory) {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) {
        if (stat.size > limitBytes) oversized.push({ path: relative(root, path), bytes: stat.size });
      } else {
        throw new Error(`Cannot verify non-regular asset: ${relative(root, path)}`);
      }
    }
  }
  walk(root);
  return oversized.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
}

export function main(argv = process.argv.slice(2)) {
  try {
    let dir = '_site';
    let hasDir = false;
    let limitMiB = 24;
    for (const arg of argv) {
      if (arg.startsWith('--limit-mib=')) {
        limitMiB = Number(arg.slice('--limit-mib='.length));
      } else if (!arg.startsWith('--') && !hasDir) {
        dir = arg;
        hasDir = true;
      } else {
        throw new Error(`Unexpected argument: ${arg}`);
      }
    }
    const oversized = findOversizedAssets(dir, limitMiB * MIB);
    if (oversized.length === 0) return 0;
    for (const { path, bytes } of oversized) {
      console.error(`${path}: ${(bytes / MIB).toFixed(6)} MiB (guard limit: ${limitMiB} MiB)`);
    }
    console.error('Cloudflare Workers assets cap is 25 MiB. Reduce or remove the oversized assets before deploying.');
    return 1;
  } catch (error) {
    console.error(`Asset size guard could not verify assets: ${error.message}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}
