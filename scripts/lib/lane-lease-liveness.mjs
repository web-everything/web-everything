/**
 * @file lane-lease-liveness.mjs (RS-7179-2) — is any live process still working inside a lane?
 *
 * A lease can go ttl-stale while its agent is still running (a long gate, a Codex run). The lease `pid` is the
 * short-lived `acquire` CLI, so it says nothing; the trustworthy signal is a live process whose cwd is inside
 * the lane directory. `applyReclaimSafety` moves such lanes from `reap` to `keep`.
 * Unknown (the probe throws or lsof is absent) is NOT a reason to refuse: a host without lsof keeps today's
 * ttl behaviour. IO is injected (`listCwds`, `isAlive`) so tests need no real process.
 */
import { execFileSync } from 'node:child_process';
import { sep } from 'node:path';

/** Parse `lsof -d cwd -Fpn` output into `[{pid, cwd}]`; anything that is not a `p<pid>`/`n<path>` line is ignored. */
export function parseLsofCwd(out) {
  const rows = [];
  let pid = null;
  for (const line of String(out ?? '').split('\n')) {
    if (/^p\d+$/.test(line)) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid != null && line.length > 1) rows.push({ pid, cwd: line.slice(1) });
  }
  return rows;
}

const defaultListCwds = () => {
  let out = '';
  try {
    out = execFileSync('lsof', ['-d', 'cwd', '-Fpn'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    if (e && typeof e.stdout === 'string' && e.stdout) out = e.stdout; // lsof exits 1 when some rows were unreadable
    else throw e;
  }
  return parseLsofCwd(out);
};

const defaultIsAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return !!e && e.code === 'EPERM'; }
};

/** Pids with a cwd inside `dir` (never ours), or `null` when the probe fails. */
export function liveCwdPids(dir, { listCwds = defaultListCwds, isAlive = defaultIsAlive, selfPids = [process.pid, process.ppid] } = {}) {
  if (!dir || typeof dir !== 'string') return [];
  const root = dir.replace(/[\\/]+$/, '');
  try {
    const pids = [];
    for (const { pid, cwd } of listCwds()) {
      if (selfPids.includes(pid) || pids.includes(pid)) continue;
      if ((cwd === root || cwd.startsWith(root + sep)) && isAlive(pid)) pids.push(pid);
    }
    return pids;
  } catch { return null; }
}

/** Move every reap candidate with a live cwd process into `keep` (reason `live-cwd:<pid>`). Pure over its inputs. */
export function applyReclaimSafety({ reap, keep }, io = {}) {
  const stillReap = [];
  const kept = [...keep];
  for (const c of reap) {
    const pids = liveCwdPids(c.dir, io);
    if (pids && pids.length) kept.push({ ...c, reason: `live-cwd:${pids[0]}`, wouldHaveBeen: c.reason });
    else stillReap.push(c);
  }
  return { reap: stillReap, keep: kept };
}
