// Detached process-group leader: keeps the juror bounded even if its caller receives SIGKILL.
import { spawn } from 'node:child_process';

const [parent, deadline, cli, ...argv] = process.argv.slice(2);
const killGroup = () => {
  try { process.kill(-process.pid, 'SIGKILL'); }
  catch (error) { process.exit(error.code === 'ESRCH' ? 0 : 1); }
};
setTimeout(killGroup, Math.max(1, Number(deadline) - Date.now()));
// keepalive-helper-ok: watches the caller until group SIGKILL, bounded by the hard deadline
setInterval(() => {
  try { process.kill(Number(parent), 0); }
  catch (error) { if (error.code === 'ESRCH') killGroup(); }
}, 2000);
// Own the output pipes so `close` includes descendants retaining either writer.
// With inherited fds Node reports close as soon as the direct juror exits, which
// would disarm the deadline while a grandchild still holds judgeSpawn's pipes open.
const child = spawn(cli, argv, { stdio: ['inherit', 'pipe', 'pipe'] });
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.on('error', (error) => {
  process.stderr.write(`judge-spawn: \`${cli}\` failed to run: ${error.message}\n`);
});
// Closed pipes do not prove that descendants with ignored stdio have exited.
// Empty writes queue behind all forwarded bytes, including the spawn error above.
// Keep the watchdogs armed while both destination streams drain, then kill our
// entire group (including this supervisor) before disarming anything.
child.on('close', async () => {
  await Promise.all([process.stdout, process.stderr].map(stream =>
    new Promise(resolve => stream.write('', resolve))));
  killGroup();
});
