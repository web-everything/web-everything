#!/usr/bin/env node
/**
 * @file scripts/lib/git-bounded.mjs
 *
 * Run a git command in its OWN process group and kill the whole group on timeout, on a stop signal, or when the
 * parent that started it disappears. `execFileSync({ timeout })` only kills the direct child: a timed-out
 * `git fetch` left its `git index-pack` grandchild running (6 orphans used ~300% CPU for up to 34 min, 2026-11-01).
 *
 * Library: `boundedGitCommand(args, timeoutMs)` -> `{ file, args }` to hand to an exec call.
 * CLI:     `node git-bounded.mjs --timeout-ms=N -- git <args…>`; exits with the child's status (124 on timeout).
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const BOUNDED_GIT_GRACE_MS = 5_000;

/** The exec target for a bounded git call. The outer exec timeout should be `timeoutMs + BOUNDED_GIT_GRACE_MS`. */
export function boundedGitCommand(gitArgs, timeoutMs) {
  return { file: process.execPath, args: [fileURLToPath(import.meta.url), `--timeout-ms=${Math.max(1, Math.floor(timeoutMs))}`, '--', 'git', ...gitArgs] };
}

/** Kill every process in the child's group (negative pid); falls back to the child alone. */
export function killGroup(pid, signal = 'SIGKILL') {
  try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch { /* already gone */ } }
}

/**
 * Two levels, so that NO single kill orphans git: the supervisor (this process, in the caller's group) starts a LEADER in a
 * new process group; the leader runs git in that group and kills the whole group when its own parent (the supervisor)
 * disappears, on timeout, or on a stop signal. The supervisor forwards timeout/stop to the leader and watches ITS parent.
 */
function parse(argv) {
  const sep = argv.indexOf('--');
  const timeoutArg = argv.slice(0, sep < 0 ? argv.length : sep).find((a) => a.startsWith('--timeout-ms='));
  const timeoutMs = Number(timeoutArg?.slice('--timeout-ms='.length));
  const cmd = sep < 0 ? [] : argv.slice(sep + 1);
  if (!cmd.length || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    process.stderr.write('usage: git-bounded.mjs --timeout-ms=N -- git <args…>\n');
    process.exit(2);
  }
  return { timeoutMs, cmd };
}

function leader(argv) {
  const { timeoutMs, cmd } = parse(argv);
  const parentPid = Number((argv.find((a) => a.startsWith('--parent=')) || '').slice(9)) || process.ppid; // the supervisor, even if it died before this ran
  const child = spawn(cmd[0], cmd.slice(1), { stdio: ['ignore', 'inherit', 'inherit'] }); // same group as this leader
  // The leader is in the group it must kill: a detached reaper kills the group a moment after the leader has exited with
  // its real status, so the supervisor still reads a meaningful code.
  const reapGroup = () => spawn('sh', ['-c', `sleep 0.3; kill -9 -- -${process.pid} 2>/dev/null`], { detached: true, stdio: 'ignore' }).unref();
  const stop = (code) => { reapGroup(); process.exit(code); };
  setTimeout(() => { process.stderr.write(`git-bounded: timed out after ${timeoutMs}ms; killing process group\n`); stop(124); }, timeoutMs);
  if (process.ppid !== parentPid) return stop(143);
  setInterval(() => { if (process.ppid !== parentPid) stop(143); }, 1_000);
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => stop(143));
  child.on('error', (e) => { process.stderr.write(`git-bounded: ${e.message}\n`); stop(127); });
  child.on('exit', (code, signal) => {
    // Reap any descendant the finished command left in the group, then report its status.
    reapGroup();
    process.exit(code ?? (signal ? 128 : 1));
  });
}

function main(argv) {
  if (argv[0] === '--leader') return leader(argv.slice(1));
  const { timeoutMs, cmd } = parse(argv);
  const startPpid = process.ppid;
  const lead = spawn(process.execPath, [fileURLToPath(import.meta.url), '--leader', `--parent=${process.pid}`, `--timeout-ms=${timeoutMs}`, '--', ...cmd],
    { stdio: ['ignore', 'inherit', 'inherit'], detached: true });
  const stop = (code) => { killGroup(lead.pid); process.exit(code); };
  setInterval(() => { if (process.ppid !== startPpid) stop(143); }, 1_000);
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => stop(143));
  lead.on('error', (e) => { process.stderr.write(`git-bounded: ${e.message}\n`); stop(127); });
  lead.on('exit', (code, signal) => process.exit(code ?? (signal ? 128 : 1)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
