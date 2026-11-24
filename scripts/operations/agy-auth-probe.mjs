import { spawn as nodeSpawn, execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, relative } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

// Accept a plain reply; empty output, diagnostics, and machine/terminal garbage are not auth evidence.
export function classifyAgyProbe({ stdout = '', stderr = '', exitCode, timedOut } = {}) {
  if (/sign[ -]?in|auth|not logged in/i.test(`${stdout}\n${stderr}`)) return 'signed-out';
  const text = String(stdout).trim().toLowerCase().replace(/\p{P}/gu, '');
  return exitCode === 0 && !timedOut && /^ok(?:\s|$)/.test(text) ? 'signed-in' : 'unreadable';
}
const timestamp = value => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
export function agyAuthOff(record, now = Date.now(), periodMs = 15 * 60000) {
  if (typeof record === 'string') { try { record = JSON.parse(record); } catch { return true; } }
  const at = timestamp(record?.lastProbeAt);
  return record?.state !== 'on' || !Number.isFinite(at) || !Number.isFinite(now)
    || !Number.isFinite(periodMs) || periodMs <= 0 || at > now || now - at > 2 * periodMs;
}
export function reduceAuthState(prev, classification, now, periodMs = 15 * 60000) {
  const good = classification === 'signed-in';
  const fresh = !agyAuthOff({ ...prev, state: 'on' }, now, periodMs);
  const goodStreak = good ? Math.min(2, (fresh && Number.isInteger(prev?.goodStreak) ? Math.max(0, prev.goodStreak) : 0) + 1) : 0;
  const state = good && ((fresh && prev?.state === 'on') || goodStreak >= 2) ? 'on' : 'off';
  const cardNeeded = !good && (prev?.state !== 'off' || !prev?.outageId);
  return { state, goodStreak, lastProbeAt: now,
    outageId: state === 'on' ? null : cardNeeded ? String(now) : prev?.outageId ?? null, cardNeeded };
}
const title = 'agy signed out: sign in to agy on the Studio';
export function fileCard({ title, outageId }, exec = execFileSync) {
  exec(process.execPath, ['scripts/operations/run.mjs', 'file-item', `--title=${title}`,
    '--kind=task', '--workItem=task', '--queue=false',
    `--notDuplicateReason=New authentication outage ${outageId}; a previous sign-in action does not resolve this outage.`,
    `--digest=agy is unavailable (outage ${outageId}). Sign in to agy on the Studio; two successful probes restore routing.`],
  { cwd: resolve(dirname(fileURLToPath(import.meta.url)), '../..'), stdio: 'ignore', timeout: 45000, maxBuffer: 65536 });
}
export async function runProbe({ spawn = nodeSpawn, statePath = join(homedir(), '.plateau', 'agy-auth-state.json'),
  lockDir = join(dirname(statePath), 'agy-auth-probe.lock'), now = Date.now, fileCard: publish = fileCard } = {}) {
  const base = dirname(resolve(statePath)), lock = resolve(lockDir), rel = relative(base, lock);
  if (!rel || rel.startsWith('..') || lock === resolve(statePath)) throw new Error('probe lock must be under the state directory');
  await fs.mkdir(base, { recursive: true });
  try { await fs.mkdir(lock); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let owner;
    try { owner = JSON.parse(await fs.readFile(join(lock, 'owner.json'), 'utf8')); } catch { /* legacy/incomplete lock: use age */ }
    const at = Number.isFinite(owner?.timestamp) ? owner.timestamp : (await fs.stat(lock)).mtimeMs;
    let dead = false;
    if (Number.isInteger(owner?.pid) && owner.pid > 0) {
      try { process.kill(owner.pid, 0); } catch (error) { dead = error.code === 'ESRCH'; }
    }
    if (!dead && now() - at <= 5 * 60000) return { skipped: true };
    await fs.rm(lock, { recursive: true, force: true });
    try { await fs.mkdir(lock); } catch (error) { if (error.code === 'EEXIST') return { skipped: true }; throw error; }
  }
  const temporary = `${statePath}.${randomUUID()}.tmp`;
  const save = async record => {
    await fs.writeFile(temporary, JSON.stringify(record) + '\n', { mode: 0o600 }); await fs.rename(temporary, statePath);
  };
  try {
    await fs.writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, timestamp: now() }), { mode: 0o600 });
    let prev;
    try { prev = JSON.parse(await fs.readFile(statePath, 'utf8')); } catch { /* missing/unreadable is unavailable */ }
    const result = await new Promise(done => {
      let child, timer, settled = false, stdout = '', stderr = '', size = 0;
      const finish = value => { if (settled) return; settled = true; clearTimeout(timer); done(value); };
      const stop = value => { finish(value); child?.kill('SIGKILL'); };
      try {
        child = spawn('agy', ['-p', 'reply with the single word ok', '--print-timeout', '30s'], { stdio: ['ignore', 'pipe', 'pipe'] });
        timer = setTimeout(() => stop({ timedOut: true }), 45000);
        const receive = channel => chunk => {
          if (settled) return;
          size += Buffer.byteLength(chunk);
          if (size > 65536) return stop({}); // Escalate through the same operator card; retain no raw output.
          if (channel === 'out') stdout += chunk; else stderr += chunk;
        };
        child.stdout.on('data', receive('out')); child.stderr.on('data', receive('err'));
        child.once('error', () => finish({}));
        child.once('close', exitCode => finish({ stdout, stderr, exitCode }));
      } catch { stop({}); }
    });
    const record = reduceAuthState(prev, classifyAgyProbe(result), now());
    const sameOutage = record.outageId && record.outageId === prev?.outageId;
    record.cardPending = Boolean(sameOutage && prev?.cardPending);
    // Historical records with cardNeeded=false have already filed their card.
    record.cardFiled = Boolean(sameOutage && (prev?.cardFiled || (prev?.cardFiled === undefined && prev?.cardNeeded === false)));
    record.cardNeeded ||= record.state === 'off' && prev?.cardNeeded === true;
    const shouldPublish = record.cardNeeded && !record.cardFiled && !record.cardPending;
    if (shouldPublish) record.cardPending = true;
    await save(record);
    if (shouldPublish) {
      await publish({ title, outageId: record.outageId });
      record.cardPending = false; record.cardFiled = true; record.cardNeeded = false;
      await save(record);
    }
    return record;
  } finally { await fs.unlink(temporary).catch(() => {}); await fs.rm(lock, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runProbe().then(record => console.log(record.skipped ? 'agy auth probe skipped: lock held' : `agy auth: ${record.state}`))
    .catch(() => { console.error('agy auth probe failed; check state storage and file-item on the Studio; inspect cardPending before retrying publication'); process.exitCode = 1; });
}
