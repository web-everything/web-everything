// Detached process-group leader: keeps the juror bounded even if its caller receives SIGKILL.
import { spawn } from 'node:child_process';

const [parent, deadline, cli, ...argv] = process.argv.slice(2);
const killGroup = () => {
  try { process.kill(-process.pid, 'SIGKILL'); }
  catch { process.exit(1); }
};
const timer = setTimeout(killGroup, Math.max(1, Number(deadline) - Date.now()));
// keepalive-helper-ok: watches the caller, bounded by the hard deadline and cleared on juror close
const poll = setInterval(() => {
  try { process.kill(Number(parent), 0); }
  catch (error) { if (error.code === 'ESRCH') killGroup(); }
}, 2000);
const cleanup = () => { clearTimeout(timer); clearInterval(poll); };
const child = spawn(cli, argv, { stdio: 'inherit' });
child.on('error', (error) => {
  cleanup();
  process.stderr.write(`judge-spawn: \`${cli}\` failed to run: ${error.message}\n`);
  process.exitCode = 1;
});
child.on('close', (code, signal) => {
  cleanup();
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
