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

function main(argv) {
  const sep = argv.indexOf('--');
  const timeoutArg = argv.slice(0, sep < 0 ? argv.length : sep).find((a) => a.startsWith('--timeout-ms='));
  const timeoutMs = Number(timeoutArg?.slice('--timeout-ms='.length));
  const cmd = sep < 0 ? [] : argv.slice(sep + 1);
  if (!cmd.length || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    process.stderr.write('usage: git-bounded.mjs --timeout-ms=N -- git <args…>\n');
    process.exit(2);
  }
  const child = spawn(cmd[0], cmd.slice(1), { stdio: ['ignore', 'inherit', 'inherit'], detached: true });
  const startPpid = process.ppid;
  let timedOut = false;
  const stop = (code) => { killGroup(child.pid); process.exit(code); };
  const timer = setTimeout(() => { timedOut = true; process.stderr.write(`git-bounded: timed out after ${timeoutMs}ms; killing process group\n`); stop(124); }, timeoutMs);
  const watch = setInterval(() => { if (process.ppid !== startPpid) stop(143); }, 2_000);
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => stop(143));
  child.on('error', (e) => { process.stderr.write(`git-bounded: ${e.message}\n`); stop(127); });
  child.on('exit', (code, signal) => {
    clearTimeout(timer); clearInterval(watch);
    // Reap any grandchild the finished command left behind in its group.
    if (!timedOut) killGroup(child.pid);
    process.exit(code ?? (signal ? 128 : 1));
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
