/** Process-tree classification and sampler IO regression probes. */
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parsePsOutput } from '../health-watch-core.mjs';
import { healthDir } from '../health-watch-section.mjs';
import { findUngatedHeavyRuns, summarizeSample, readRecentSamples } from '../heavy-run-ungated.mjs';
const dirs = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'heavy-sample-')); dirs.push(d); return d; };
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const ps = (lines) => parsePsOutput('PID PPID %CPU ELAPSED COMMAND\n' + lines.map(([pid, ppid, command]) => `${pid} ${ppid} 1.0 00:12 ${command}`).join('\n'));
const tree = ps([[10, 1, 'claude'], [11, 10, '/bin/zsh -c npx vitest run x'], [12, 11, 'node /x/node_modules/.bin/vitest run x'], [13, 12, 'node /x/node_modules/vitest/dist/workers/forks.js'], [14, 12, 'vitest run nested']]);
it('reports only the top heavy run and attributes through shell wrappers', () => {
  expect(findUngatedHeavyRuns(tree)).toEqual([expect.objectContaining({ pid: 12, parentPid: 11, parentCommand: tree[1].command, program: 'claude', programPid: 10, programName: 'claude', chain: [tree[1].command, 'claude'] })]);
});
it.each(['node /x/heavy-admission.mjs run -- npx vitest run x', 'node scripts/verify-lane.mjs'])('recognizes gate %s', (command) => {
  expect(findUngatedHeavyRuns(ps([[9, 1, command], [10, 9, 'sh -c npx vitest related x'], [11, 10, 'vitest related x']]))).toEqual([]);
});
it('attributes standards runs to codex and skips package runners', () => {
  const runs = findUngatedHeavyRuns(ps([[10, 1, 'codex'], [11, 10, 'bash -lc node scripts/check-standards.mjs'], [12, 11, 'node scripts/check-standards.mjs --local']]));
  expect(runs[0]).toMatchObject({ pid: 12, programName: 'codex' });
  expect(findUngatedHeavyRuns(ps([[10, 1, 'node scripts/conveyor/review-daemon.mjs'], [11, 10, 'node /x/npm-cli.js exec vitest run'], [12, 11, 'node /x/vitest/vitest.mjs run']]))[0]).toMatchObject({ pid: 11, programName: 'node review-daemon.mjs' });
});
it.each(['grep vitest', 'rg check-standards', 'code vitest', 'node --check scripts/check-standards.mjs', 'npx vitest --version', 'npx vitest --help', 'npx vitest list', 'node /x/vitest/dist/child.js', 'node /x/vitest/dist/workers/forks.js', 'node unrelated.mjs vitest run'])('ignores %s', (command) => {
  expect(findUngatedHeavyRuns(ps([[2, 1, command]]))).toEqual([]);
});
it.each(['npm exec vitest', 'vitest related x', 'node /abs/scripts/check-standards.mjs', 'node /x/node_modules/vitest/vitest.mjs run'])('detects %s', (command) => {
  expect(findUngatedHeavyRuns(ps([[2, 1, command]]))).toHaveLength(1);
});
it('walks cycles safely and supports custom gate matchers', () => {
  const rows = ps([[2, 3, 'vitest run'], [3, 4, 'bash'], [4, 3, 'custom-gate']]);
  expect(findUngatedHeavyRuns(rows)).toHaveLength(1);
  expect(findUngatedHeavyRuns(rows, { gateMatchers: [/custom-gate/] })).toEqual([]);
});
it('bounds chain and sample commands', () => {
  const rows = ps([[2, 3, 'vitest run ' + 'x'.repeat(300)], ...Array.from({ length: 9 }, (_, i) => [i + 3, i + 4, 'bash ' + 'x'.repeat(200)])]);
  const runs = findUngatedHeavyRuns(rows);
  expect(runs[0].chain).toHaveLength(6);
  expect(runs[0].chain.every((c) => c.length <= 160)).toBe(true);
  const sample = summarizeSample(runs, '2026-10-04T00:00:00Z');
  expect(sample).toMatchObject({ at: '2026-10-04T00:00:00Z', count: 1 });
  expect(sample.runs[0].command).toHaveLength(200);
});
it('reads recent valid samples, tolerating missing files and malformed lines', () => {
  const path = join(temp(), 'samples.jsonl');
  const now = Date.parse('2026-10-04T00:10:00Z');
  expect(readRecentSamples(path, { now, windowMs: 60000 })).toEqual([]);
  const recent = { at: '2026-10-04T00:09:00Z', count: 1, runs: [] };
  writeFileSync(path, JSON.stringify({ at: '2026-10-04T00:00:00Z' }) + '\nbad\n' + JSON.stringify(recent) + '\n');
  expect(readRecentSamples(path, { now, windowMs: 60000 })).toEqual([recent]);
});
it('CLI appends one sample, caps history, and loops for a bounded count', () => {
  const root = temp(); const fixture = join(root, 'ps.txt');
  writeFileSync(fixture, 'PID PPID %CPU ELAPSED COMMAND\n10 1 0 00:01 claude\n11 10 1 00:01 vitest run x\n');
  const args = [`--ps-fixture=${fixture}`, `--state-root=${root}`, '--json'];
  const run = (command, extra = []) => execFileSync(process.execPath, ['scripts/conveyor/heavy-run-ungated.mjs', command, ...args, ...extra], { encoding: 'utf8' });
  expect(JSON.parse(run('sample'))).toMatchObject({ count: 1, runs: [{ pid: 11, programName: 'claude', command: 'vitest run x' }] });
  const path = join(healthDir(root), 'heavy-run-samples.jsonl');
  expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(1);
  writeFileSync(path, (JSON.stringify({ at: 'old' }) + '\n').repeat(1440));
  run('sample');
  expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(1440);
  expect(run('loop', ['--count=2', '--interval=0.01']).trim().split('\n')).toHaveLength(2);
});
it('records ps failures without failing the CLI', () => {
  const root = temp();
  const bin = join(root, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'ps'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const sample = JSON.parse(execFileSync(process.execPath, ['scripts/conveyor/heavy-run-ungated.mjs', 'sample', `--state-root=${root}`, '--json'], { encoding: 'utf8', env: { ...process.env, PATH: bin } }));
  expect(sample.error).toBeTruthy();
  expect(JSON.parse(readFileSync(join(healthDir(root), 'heavy-run-samples.jsonl'), 'utf8'))).toEqual(sample);
});
