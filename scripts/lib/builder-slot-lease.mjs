/** Foreground lease lifecycle shared by direct workers and their owning launcher. */
import { readBuilderSlotSettings } from './builder-slots-settings.mjs';
import { waitForSlot, heartbeatSlot, releaseSlot } from './builder-slots.mjs';

export async function startBuilderLease({ env = process.env, signalProcess = process, kill = (pid, signal) => process.kill(pid, signal), ...o } = {}) {
  const settings = o.settings ?? readBuilderSlotSettings({ env });
  if (env.WE_BUILDER_SLOT_HELD || !settings.enabled) return { ok: true, close() {}, track() {} };
  const slot = await waitForSlot({ ...o, settings, pid: process.pid,
    inFlightRows: o.inFlightRows ?? (async () => (await import('../../skills-src/conveyor/build-dispatch-daemon.mjs')).listBuilderInFlightRows()) });
  if (!slot.ok) return slot;
  let closed = false, stopping = false, closeRequested = false;
  const children = new Set();
  function track(child) {
    children.add(child);
    child.once('close', () => {
      children.delete(child);
      if (closeRequested && !children.size) close();
    });
    return child;
  }
  function terminate(child, signal) {
    try { kill(-child.pid, signal); }
    catch (e) {
      // Children created without a process group still need terminating.
      if (e.code !== 'ESRCH') throw e;
      child.kill(signal);
    }
  }
  const handlers = Object.fromEntries(['SIGINT', 'SIGTERM'].map(signal => [signal, async () => {
    if (stopping) return;
    stopping = true;
    // Keep capacity occupied until every tracked child has actually closed its pipes/exited.
    await Promise.all([...children].map(child => new Promise(resolve => {
      const timer = setTimeout(() => terminate(child, 'SIGKILL'), 5000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      terminate(child, 'SIGTERM');
    })));
    try { close(); } finally { kill(signalProcess.pid, signal); }
  }]));
  const heartbeat = setInterval(() => {
    try { heartbeatSlot(slot.id, { ...o, settings }); }
    catch (e) { console.error(`builder slot heartbeat failed: ${e.message}`); }
  }, settings.ttlMs / 3);
  heartbeat.unref();
  function close() {
    if (closed) return;
    if (children.size) { closeRequested = true; return; }
    closed = true;
    clearInterval(heartbeat);
    signalProcess.removeListener('exit', close);
    for (const [signal, handler] of Object.entries(handlers)) signalProcess.removeListener(signal, handler);
    releaseSlot(slot.id, { ...o, settings });
  }
  signalProcess.on('exit', close);
  for (const [signal, handler] of Object.entries(handlers)) signalProcess.on(signal, handler);
  return { ...slot, close, track };
}
