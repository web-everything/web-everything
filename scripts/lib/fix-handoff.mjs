/** Local, wake-only hand-off. The daemon re-reads GitHub and retains all dispatch gates. */
import { mkdirSync, readFileSync, writeFileSync, renameSync, watchFile, unwatchFile } from 'node:fs';
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
    let timer;
    const file = join(dir, 'wake');
    const finish = reason => { clearTimeout(timer); unwatchFile(file, check); resolve(reason); };
    const check = () => { const value = read(dir); if (value !== seen) { seen = value; finish('handoff'); } };
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
