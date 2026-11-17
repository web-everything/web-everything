/** Install before dynamically importing the review graph: setup/import failures need terminal evidence too. */
// Built-ins only: a missing/broken dependency anywhere in the review graph must not disable this backstop.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const completionDir = () => process.env.OPERATION_COMPLETIONS_DIR || join(ROOT, '.operations', 'completions');
const completionFingerprint = rec => createHash('sha256').update(JSON.stringify(rec ?? null)).digest('hex');
function atomicRecord(record, path) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record)}\n`);
  renameSync(tmp, path);
}
function readCompletion(session) {
  try { return JSON.parse(readFileSync(join(completionDir(), `${session}.json`), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
// Emergency v1 is accepted by every completion reader. Normal exits retain the shared writer's v2 envelope.
function writeCrashCompletion({ session, pr, classified }) {
  const at = new Date().toISOString();
  atomicRecord({ v: 1, session, kind: 'review', pr: String(pr), item: null, sessionId: null, pid: process.pid,
    status: 'done', outcome: classified.outcome, verdict: null, runId: null,
    label: String(classified.label ?? 'process exited without an outcome').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 500),
    startedAt: at, updatedAt: at }, join(completionDir(), `${session}.json`));
}

export function installReviewJobExitHandlers({ session, pr, repo, redTeamOnly = false,
  host = process, read = readCompletion, terminal = writeCrashCompletion,
  receipt = record => atomicRecord(record, join(process.env.OPERATION_REVIEW_JOBS_DIR || join(ROOT, '.operations', 'review-jobs'), '.terminal', `${record.slug}.json`)),
} = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(session ?? '')) throw Error('review job launcher requires a valid session slug');
  let baseline;
  try { baseline = completionFingerprint(read(session)); } catch { baseline = completionFingerprint(null); }
  let finished = false;
  const finish = (label, out = null) => {
    if (finished) return;
    // A refused duplicate owns no job and must never overwrite its live owner's completion.
    if (out?.refused) { finished = true; return; }
    const classified = out ?? { outcome: 'blocked-on-infra', label };
    let current;
    try { current = read(session); } catch { current = null; }
    const done = current?.status === 'done' && completionFingerprint(current) !== baseline;
    if (!redTeamOnly && !done) terminal({ session, pr, repo, classified });
    receipt({ slug: session, pr, repo, pid: host.pid, status: 'done', outcome: classified.outcome,
      label: classified.label || label, updatedAt: new Date().toISOString() });
    finished = true;
  };
  const safeFinish = (label, out) => {
    try { finish(label, out); }
    catch (error) { host.stderr.write(`review-job: terminal record failed: ${String(error?.message ?? error).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 500)}\n`); host.exitCode = 1; }
  };
  const onExit = code => safeFinish(`process exit ${code} without a clean outcome`);
  const onException = error => { safeFinish(`uncaught exception: ${String(error?.message ?? error).slice(0, 400)}`); host.exit(1); };
  const onRejection = error => { safeFinish(`unhandled rejection: ${String(error?.message ?? error).slice(0, 400)}`); host.exit(1); };
  const onTerm = () => { safeFinish('signal SIGTERM'); host.exit(143); };
  const onInt = () => { safeFinish('signal SIGINT'); host.exit(130); };
  for (const [event, handler] of Object.entries({ exit: onExit, uncaughtException: onException,
    unhandledRejection: onRejection, SIGTERM: onTerm, SIGINT: onInt })) host.once(event, handler);
  return { finish: safeFinish };
}
