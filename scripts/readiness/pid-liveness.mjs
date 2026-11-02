import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';

const readProcStat = pid => process.platform === 'linux' ? readFileSync(`/proc/${pid}/stat`, 'utf8') : null;

/** PID reuse never proves ownership. Only ESRCH or a terminal Linux state proves death. */
export function probePidLiveness(pid, selfPid, readStat = readProcStat) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === selfPid) return 'unknown';
  try { process.kill(pid, 0); }
  catch (error) { return error?.code === 'ESRCH' ? 'dead' : 'unknown'; }
  try {
    const stat = readStat(pid);
    // comm may contain spaces and parentheses; state follows its LAST closing paren.
    if (typeof stat === 'string' && stat.lastIndexOf(')') >= 0
      && /^\s+[ZX](?:\s|$)/.test(stat.slice(stat.lastIndexOf(')') + 1))) return 'dead';
  } catch { /* Unreadable /proc evidence cannot prove death. */ }
  return 'alive';
}

/** Process birth time on macOS/Linux. Unknown or unreadable evidence never proves PID reuse. */
export function probePidStartMs(pid, exec = execFileSync) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const output = exec('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 1000, maxBuffer: 4096,
    });
    const started = Date.parse(output.trim());
    return Number.isFinite(started) ? started : null;
  } catch { return null; }
}
