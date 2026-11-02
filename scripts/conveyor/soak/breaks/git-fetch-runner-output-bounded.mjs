/**
 * PR #6169 centralised daemon fetches in git-fetch-fresh.mjs. Its captured Git
 * output must stay bounded, including stderr from remote hooks, and a failed
 * call must leave the caller able to retry. Exercise the production default
 * runner, rather than injecting fetchFresh's run function (which bypasses its
 * subprocess options).
 *
 * A private Node worker substitutes only the Git executable with a local output
 * producer. Node still enforces the production timeout/maxBuffer/stdio options.
 * The worker isolates the builtin-module substitution from other soak tests.
 * No Git command, network access, or repository metadata write is performed.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');
const HELPER = 'scripts/lib/git-fetch-fresh.mjs';
const LIMIT = 16 * 1024 * 1024;

const PRODUCER = `
  const { writeSync } = require('node:fs');
  const mode = process.argv[1];
  const chunk = Buffer.alloc(64 * 1024, 'x');
  const count = mode === 'small' ? 32 : 288;
  if (mode === 'exit') process.exit(7);
  for (let i = 0; i < count; i++) {
    if (mode !== 'stderr') writeSync(1, chunk);
    if (mode !== 'stdout') writeSync(2, chunk);
  }
`;
const WORKER = `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const originalExec = childProcess.execFileSync;
let mode = 'small';
const calls = [];
const producer = ${JSON.stringify(PRODUCER)};
childProcess.execFileSync = (file, args, options) => {
  if (file !== 'git' || args[0] !== 'fetch') throw new Error('unexpected subprocess');
  calls.push({ args, timeout: options.timeout, maxBuffer: options.maxBuffer, stdio: options.stdio });
  return originalExec(process.execPath, ['-e', producer, mode], options);
};
syncBuiltinESMExports();
const { fetchFresh } = await import(process.argv[2]);
// A non-repository cwd deliberately prevents all tracking-ref and stamp IO.
const options = { cwd: process.argv[3], stampDir: process.argv[3], maxAgeMs: 60000 };
const samples = [];
for (const stream of ['stdout', 'stderr', 'both']) {
  for (let attempt = 0; attempt < 2; attempt++) {
    mode = stream;
    try {
      fetchFresh(options);
      samples.push({ stream, attempt, accepted: true });
    } catch (error) {
      samples.push({ stream, attempt, code: error.code,
        bytes: Buffer.byteLength(error.stdout ?? '') + Buffer.byteLength(error.stderr ?? '') });
    }
  }
  mode = 'small';
  samples.push({ stream, recovered: fetchFresh(options).fetched });
}
mode = 'exit';
let exitStatus;
try { fetchFresh(options); } catch (error) { exitStatus = error.status; }
mode = 'small';
const recoveredAfterExit = fetchFresh(options).fetched;
process.stdout.write(JSON.stringify({ calls, samples, exitStatus, recoveredAfterExit }));
`;

export default {
  id: 'git-fetch-runner-output-bounded',
  title: 'captured fetch output stays bounded and callers can recover after output overflow',
  card: 'PR #6169',
  fixedBy: { sha: 'b14fc73bab97f689ba199d3355b79d99e5ed5c26', where: 'lane/perf-fetch-fresh', paths: [HELPER] },
  fixPresent(root) {
    try { return /maxBuffer:\s*16\s*\*\s*1024\s*\*\s*1024/.test(readFileSync(join(root, HELPER), 'utf8')); }
    catch { return false; }
  },
  async run({ root = ROOT, log = () => {} } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'soak-fetch-output-'));
    const violations = [];
    const check = (ok, invariant, detail) => { if (!ok) violations.push({ invariant, detail }); };
    try {
      const worker = join(dir, 'worker.mjs');
      writeFileSync(worker, WORKER);
      const result = JSON.parse(execFileSync(process.execPath, [worker, pathToFileURL(join(root, HELPER)).href, dir], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, maxBuffer: 1024 * 1024,
      }));
      check(result.calls.length === 11, 'retry', 'expected every failed call and recovery to reach the runner');
      for (const call of result.calls) {
        check(call.maxBuffer === LIMIT && call.timeout === 120000 &&
          JSON.stringify(call.stdio) === JSON.stringify(['ignore', 'pipe', 'pipe']),
        'runner-bounds', 'a Git child did not receive the production output and time bounds');
        check(JSON.stringify(call.args) === JSON.stringify(['fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main']),
          'fetch-scope', 'the runner changed the narrow fetch argv');
      }
      for (const stream of ['stdout', 'stderr', 'both']) {
        const failures = result.samples.filter(s => s.stream === stream && 'attempt' in s);
        check(failures.length === 2 && failures.every(s => s.code === 'ENOBUFS' && s.bytes > 0 && s.bytes <= LIMIT + 256 * 1024),
          'output-overflow', `${stream}: oversized output was accepted or failed without bounded output evidence`);
        check(result.samples.some(s => s.stream === stream && s.recovered === true),
          'recovery', `${stream}: a later fetch with 2 MiB per stream could not recover`);
      }
      check(result.exitStatus === 7 && result.recoveredAfterExit === true,
        'git-failure', 'a normal Git failure was swallowed or prevented a subsequent fetch');
      log(`fetch output replay: ${result.calls.length} calls, ${violations.length} violations`);
      return { violations };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  judge(report) {
    return report.violations.map(v => `[${v.invariant}] ${v.detail}`);
  },
};
