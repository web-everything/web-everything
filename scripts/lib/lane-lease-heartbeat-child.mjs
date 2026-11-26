/** Independent renewal clock: survives a parent blocked in synchronous gates. */
import { renewLaneLeaseOnce } from './lane-lease-heartbeat.mjs';
const { targets, caller, period, parentPid } = JSON.parse(process.argv[2]);
let failures = 0;
let lost = false;
let workers = [];
process.on('message', message => {
  if (Array.isArray(message?.workers)) workers = message.workers.filter(pid => Number.isInteger(pid) && pid > 0);
});
const signalWorkers = signal => {
  for (const pid of workers) { try { process.kill(-pid, signal); } catch { /* exited */ } }
};
const parentAlive = () => {
  if (process.ppid !== parentPid) return false;
  try { process.kill(parentPid, 0); return true; } catch { return false; }
};
const timer = setInterval(() => {
  // Once loss is declared, finish worker escalation even if the parent exits first.
  if (lost) return;
  if (!parentAlive()) process.exit(0);
  const ok = targets.every(t => renewLaneLeaseOnce({ cwd: t.cwd, owner: t.owner, caller }));
  failures = ok ? 0 : failures + 1;
  if (failures < 3) return;
  lost = true;
  console.error('lane-lease-heartbeat: ownership renewal failed; terminating worker. Acquire/adopt a lane before retrying; recover an abandoned mutation lock only after confirming no writer remains.');
  // Arm cleanup before notification: onLost may exit the parent immediately.
  setTimeout(() => {
    signalWorkers('SIGKILL');
    if (parentAlive()) { try { process.kill(parentPid, 'SIGKILL'); } catch { /* exited */ } }
    process.exit(1);
  }, 2000);
  try { process.send?.('lost', () => {}); } catch { /* parent already disconnected; cleanup remains armed */ }
  signalWorkers('SIGTERM');
  // Signal from here: the parent's event loop may be blocked in a gate.
  try { process.kill(parentPid, 'SIGTERM'); } catch { /* parent exited; worker escalation still must finish */ }
}, period);
process.on('disconnect', () => { if (!lost) process.exit(0); });
process.on('SIGTERM', () => { if (!lost) { clearInterval(timer); process.exit(0); } });
process.send?.('ready');
