/** A loop timeout kills the parent while a detached label grandchild awaits publication. */
import { fork } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const [role, dir, body] = process.argv.slice(2);
if (role === 'loop') {
  const child = fork(fileURLToPath(import.meta.url), ['label', dir, body], {
    detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  child.once('message', () => process.send({ ready: true, orphanPid: child.pid }));
} else {
  const deadline = setTimeout(() => process.exit(1), 15_000);
  const poll = setInterval(() => {
    if (!existsSync(join(dir, 'publish'))) return;
    writeFileSync(join(dir, 'comment.json'), body);
    clearInterval(poll); clearTimeout(deadline); process.exit(0);
  }, 20);
  // Disconnect on parent SIGKILL must not stop the outstanding sink operation.
  process.on('disconnect', () => {});
  process.send({ ready: true });
}
