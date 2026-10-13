#!/usr/bin/env node
/** Tracked-text host path ratchet, with injectable IO and an explicit baseline writer. */
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findHostPaths, scanHostPaths } from './lib/host-path-scan.mjs';
import { readGit } from './lib/proc-read.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = 'scripts/settings/host-path-baseline.json';
const decoder = new TextDecoder('utf-8', { fatal: true });
const listTrackedFiles = root => readGit(['ls-files', '-z'], { cwd: root }).split('\0').filter(Boolean);

/** Symlinks are references, not committed file contents. */
function readTrackedFile(path) {
  return lstatSync(path).isSymbolicLink() ? null : readFileSync(path);
}

/** IO callbacks receive the root (listing) and absolute filename (reading). */
function readDocs(root, listFiles, readFile) {
  const docs = [];
  for (const file of listFiles(root)) {
    let raw;
    try { raw = readFile(resolve(root, file)); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (raw == null) continue;
    let content;
    try { content = typeof raw === 'string' ? raw : decoder.decode(raw); }
    catch (error) {
      if (error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA') continue;
      throw error;
    }
    if (!content.includes('\0')) docs.push({ file, content });
  }
  return docs;
}

/** Scan without printing or exiting; defaults exercise the real tracked tree. */
export function runHostPathLint({ root = repoRoot, listFiles = listTrackedFiles, readFile = readTrackedFile, baseline } = {}) {
  const currentBaseline = baseline ?? JSON.parse(readFileSync(resolve(root, baselinePath), 'utf8'));
  return scanHostPaths(readDocs(root, listFiles, readFile), currentBaseline);
}

function main() {
  if (process.argv.includes('--write-baseline')) {
    const files = {};
    const docs = readDocs(repoRoot, listTrackedFiles, readTrackedFile).sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
    for (const { file, content } of docs) {
      const count = findHostPaths(content).length;
      if (count) files[file] = count;
    }
    const baseline = {
      $comment: 'Ratchet baseline of tracked files that still carry a real host home path (operator rule 2026-10-13). May only shrink; scripts/lint-host-paths.mjs fails on any new file, any count increase, and any stale entry. Cleanup card: xovnemq.',
      files,
    };
    writeFileSync(resolve(repoRoot, baselinePath), `${JSON.stringify(baseline, null, 2)}\n`);
    return;
  }
  const { errors } = runHostPathLint();
  for (const { message } of errors) process.stderr.write(`${message}\n`);
  if (errors.length) process.exitCode = 1;
  else {
    const baseline = JSON.parse(readFileSync(resolve(repoRoot, baselinePath), 'utf8'));
    process.stdout.write(`host-path lint: clean (${Object.keys(baseline.files).length} baselined files)\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) {
    process.stderr.write(`host-path lint: ${error.message}\n`);
    process.exitCode = 1;
  }
}
