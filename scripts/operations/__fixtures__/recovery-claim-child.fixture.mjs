/** IPC fixture for the real two-process claim tests. Remains alive until killed by its test. */
import { pidStartTime } from '../../lib/pid-alive.mjs';
const [dir, runId, token] = process.argv.slice(2);
const owner = { host: 'fixture-host', namespace: 'pid:[123]', pid: process.pid, procStart: pidStartTime(process.pid) };
process.on('message', async command => {
  if (command === 'identity') { process.send({ owner }); return; }
  if (!['acquire', 'handoff'].includes(command)) return;
  try {
    const { acquireRecoveryClaim, createRecoveryHandoff } = await import('../review-recovery-claim.mjs');
    const result = command === 'acquire' ? await acquireRecoveryClaim({ dir, runId, token, owner })
      : await createRecoveryHandoff({ dir, runId, owner });
    process.send({ ...result, owner });
  } catch (error) { process.send({ error: error.message }); }
});
process.send({ ready: true });
