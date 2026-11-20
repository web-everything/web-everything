#!/usr/bin/env node
/** Replay static selection against PR diff tests (a related-test proxy, not historical failure evidence).
 * Usage: node scripts/readiness/selection-replay.mjs 7094 ... [--evidence=relative.json]
 * Evidence JSON: { "7094": ["scripts/lib/__tests__/example.test.mjs"] } (failing/related tests).
 * Uses the current tracked tree, not historical PR trees. Missing evidence is labelled incomplete.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildReverseImportGraph, isVitestTestFile, testDepths } from '../lib/related-test-selection.mjs';

export function replaySelections({ records, files, readFile, aliases }) {
  const old = buildReverseImportGraph({ files, readFile, staticEdges: { spawnPath: false, alias: false, literalRead: false } });
  const current = buildReverseImportGraph({ files, readFile, aliases });
  return records.map(({ pr, changedFiles, testFiles, evidenceComplete = false }) => {
    // Changed tests seed themselves at depth zero; they cannot measure missed dependencies.
    if (!evidenceComplete || !Array.isArray(testFiles))
      return { pr, evidenceComplete: false, expectedCount: null, oldMissed: null, newMissed: null };
    const expected = [...new Set(testFiles)];
    const missing = reverse => {
      const selected = testDepths(changedFiles, reverse);
      return expected.filter(test => !selected.has(test));
    };
    return { pr, evidenceComplete, expectedCount: expected.length, oldMissed: missing(old), newMissed: missing(current) };
  });
}

export function runReplayCli(argv, { runGh, runGit, readFile = readFileSync, print = console.log } = {}) {
  const prs = argv.filter(arg => !arg.startsWith('--'));
  if (!prs.length || prs.some(pr => !/^[1-9]\d*$/.test(pr)) || argv.some(arg => arg.startsWith('--') && !arg.startsWith('--evidence=')))
    throw new Error('supply PR numbers and optional --evidence=relative.json');
  const evidencePath = argv.find(arg => arg.startsWith('--evidence='))?.slice(11);
  const evidence = evidencePath ? JSON.parse(readFile(evidencePath, 'utf8')) : {};
  const lines = text => String(text).split(/\r?\n/).filter(Boolean);
  const records = prs.map(pr => {
    const testFiles = evidence[pr];
    if (testFiles !== undefined && (!Array.isArray(testFiles) || testFiles.some(t => typeof t !== 'string' || !isVitestTestFile(t))))
      throw new Error(`invalid test evidence for PR ${pr}`);
    return { pr, changedFiles: lines(runGh(['pr', 'diff', pr, '--name-only'])), testFiles, evidenceComplete: testFiles !== undefined };
  });
  const rows = replaySelections({ records, files: lines(runGit(['ls-files'])), readFile: path => readFile(path, 'utf8') });
  for (const row of rows) print(JSON.stringify(row));
  if (rows.some(row => !row.evidenceComplete)) print('incomplete: miss counts unavailable; supply failing/related test evidence with --evidence. Current-tree replay.');
  return rows;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { runGhSync } = await import('../lib/gh-throttle.mjs');
    runReplayCli(process.argv.slice(2), { runGh: args => runGhSync(args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }),
      runGit: args => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }) });
  } catch (error) { console.error(String(error.message).replace(/[\x00-\x1f\x7f]/g, ' ')); process.exitCode = 1; }
}
