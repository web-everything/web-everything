/** Local, wake-only hand-off. The daemon re-reads GitHub and retains all dispatch gates. */
import { mkdirSync, readFileSync, writeFileSync, renameSync, watch, watchFile, unwatchFile } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
export const fixHandoffDir = () => process.env.WE_FIX_HANDOFF_DIR || join(homedir(), '.claude', 'conveyor', 'fix-handoff');
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
export function createFixHandoffSleep({ dir = fixHandoffDir() } = {}) {
  mkdirSync(dir, { recursive: true });
  let seen = read(dir);
  return ms => new Promise(resolve => {
    let timer, watcher;
    const file = join(dir, 'wake');
    const finish = reason => { clearTimeout(timer); unwatchFile(file, check); try { watcher?.close(); } catch { /* already closed */ } resolve(reason); };
    const check = () => { const value = read(dir); if (value !== seen) { seen = value; finish('handoff'); } };
    // Event-driven wake first (immediate, even on a loaded host); the 1s stat poll stays as the fallback where fs.watch is unavailable.
    try { watcher = watch(dir, check); watcher.on('error', () => {}); } catch { /* poll only */ }
    watchFile(file, { interval: 1000 }, check);
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
