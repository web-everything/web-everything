/** Local, wake-only hand-off. The daemon re-reads GitHub and retains all dispatch gates. */
import { mkdirSync, readFileSync, writeFileSync, renameSync, watch, watchFile, unwatchFile } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
export const fixHandoffDir = () => process.env.WE_FIX_HANDOFF_DIR || join(homedir(), '.claude', 'conveyor', 'fix-handoff');
export const verifyHandoffDir = () => process.env.WE_VERIFY_HANDOFF_DIR || join(homedir(), '.claude', 'conveyor', 'verify-handoff');
/** Best-effort wake only: the running marker remains the verification authority. */
export function signalVerifyRequest({ dir = verifyHandoffDir(), log = console.error } = {}) {
  try {
    mkdirSync(dir, { recursive: true });
    const temp = join(dir, `${randomUUID()}.tmp`);
    writeFileSync(temp, JSON.stringify({ nonce: randomUUID() }));
    renameSync(temp, join(dir, 'wake'));
    return true;
  } catch (e) {
    try { log(`verify-handoff: signal failed: ${e.message}`); } catch { /* logging must not fail the request */ }
    return false;
  }
}
const read = dir => { try { return readFileSync(join(dir, 'wake'), 'utf8'); } catch { return ''; } };
export function signalFixDispatch({ repo, pr, label }, { dir = fixHandoffDir(), log = console.error } = {}) {
  if (!['review:changes', 'ci:failed', 'status:ci-red'].includes(label)) return false;
  try {
    mkdirSync(dir, { recursive: true });
    const temp = join(dir, `${randomUUID()}.tmp`);
    writeFileSync(temp, JSON.stringify({ repo, pr, label, nonce: randomUUID() }));
    renameSync(temp, join(dir, 'wake'));
    return true;
  } catch (e) { log(`fix-handoff: signal failed: ${e.message}`); return false; }
}
export function createFixHandoffSleep({ dir = fixHandoffDir(), statPollMs = 1000, watchDir = watch, failOnWatchError = false } = {}) {
  mkdirSync(dir, { recursive: true });
  let seen = read(dir);
  return ms => new Promise((resolve, reject) => {
    let timer, watcher, settled = false;
    const file = join(dir, 'wake');
    const finish = (reason, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unwatchFile(file, check);
      try { watcher?.close(); } catch { /* already closed */ }
      if (error) reject(error); else resolve(reason);
    };
    const check = () => { const value = read(dir); if (value !== seen) { seen = value; finish('handoff'); } };
    const watchError = error => { if (failOnWatchError) finish(null, error); };
    // Event-driven wake first; the stat poll (1s by default) stays as the fallback where fs.watch is unavailable.
    try { watcher = watchDir(dir, check); watcher.on('error', watchError); } catch (error) { watchError(error); }
    if (settled) return;
    watchFile(file, { interval: statPollMs }, check);
    timer = setTimeout(() => finish('interval'), ms);
    check(); // watch before read: includes events that arrived during the preceding tick
  });
}

export function createFixHandoffProbe({ dir = fixHandoffDir() } = {}) {
  let seen = read(dir);
  return () => { const next = read(dir); const changed = next !== seen; seen = next; return changed; };
}
/** Call from a label writer, after its existing CI classification. No second classifier. */
export function writeLabelWithHandoff({ write, repo, pr, label }, signal = signalFixDispatch) {
  const result = write();
  signal({ repo, pr, label });
  return result;
}
