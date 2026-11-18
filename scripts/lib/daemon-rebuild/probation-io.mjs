/** R986 S2a-1b: report-only probation IO. No result from here authorizes any lifecycle decision. */
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, realpathSync, lstatSync } from 'node:fs';
import { join, dirname, relative, resolve, isAbsolute } from 'node:path';
import { homedir, hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { freezeProbation, recordProof, evaluateProbation, validateProbation } from './probation.mjs';
import { stateDir } from './state.mjs';
import { cloneKey } from '../daemon-overlays.mjs';
import { withWriteLock } from '../daemon-clone-lock.mjs';
import { resolveDaemonClones } from '../daemon-clones.mjs';
import { readPlistAsJson } from '../../operations/daemon-status-io.mjs';

export const probationPath = (root, env = process.env) => join(stateDir(env), `${cloneKey(root)}.probation.json`);
const invalid = reason => ({ status: 'invalid', action: 'pending', reason: `${reason}; operator recovery required` });
const canonical = p => realpathSync(p);

/** Launchd labels distinguish multiple services running the same entry on ONE clone. Unknown roster throws. */
export function registeredDaemons(root, { env = process.env, exec = execFileSync, readdir = readdirSync } = {}) {
  const dir = env.WE_LAUNCH_AGENTS_DIR || join(homedir(), 'Library', 'LaunchAgents');
  let incomplete = false;
  const clones = resolveDaemonClones({ env, exec, launchAgentsDir: dir,
    readdir: p => {
      const entries = readdir(p);
      if (new Set(entries).size !== entries.length) incomplete = true;
      return entries;
    }, onIncomplete: () => { incomplete = true; } });
  if (incomplete) throw new Error('daemon roster incomplete; inspect launchd registrations');
  const cloneRoot = canonical(root);
  const labels = new Set(clones.filter(c => canonical(c.path) === cloneRoot).flatMap(c => c.labels));
  if (!labels.size) throw new Error('daemon roster unknown; inspect launchd registrations');
  return [...labels].map(id => {
    const plist = readPlistAsJson(join(dir, `${id}.plist`), { exec });
    if (plist?.Label !== id || canonical(plist.WorkingDirectory) !== cloneRoot)
      throw new Error('daemon roster identity ambiguous; inspect launchd registrations');
    const argv = plist?.ProgramArguments;
    if (!Array.isArray(argv) || argv.some(a => typeof a !== 'string')) throw new Error('daemon argv unreadable');
    const index = argv.findIndex(a => /\.(?:mjs|cjs|js)$/.test(a));
    if (index < 0) throw new Error('daemon entry unknown; inspect launchd registration');
    const entry = relative(cloneRoot, resolve(canonical(plist.WorkingDirectory), argv[index]));
    if (!entry || entry.startsWith('..') || isAbsolute(entry)) throw new Error('daemon entry outside clone');
    return { id, entry, args: argv.slice(index + 1) };
  });
}

/** Every tracked change owes proof; inspect Git evidence when a snapshot is incomplete. */
export function readClosure(root, daemon, sha) {
  try {
    const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
    if (typeof sha !== 'string' || !oid.test(sha)) return { complete: false };
    const entry = daemon.entry;
    if (typeof entry !== 'string' || !entry || isAbsolute(entry) ||
        entry.split('/').some(p => !p || p === '.' || p === '..')) return { complete: false };
    const git = args => execFileSync('git', args, {
      cwd: root, encoding: 'utf8', timeout: 5000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const tree = git(['rev-parse', `${sha}^{tree}`]).trim();
    const blob = /^(?:100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\0$/i.exec(
      git(['ls-tree', '-z', '--full-tree', '--format=%(objectmode) %(objecttype) %(objectname)', sha, '--', `:(literal)${entry}`]));
    return oid.test(tree) && blob
      ? { complete: true, files: { '.tree': tree, [entry]: blob[1] } } : { complete: false };
  } catch { return { complete: false }; }
}

function readRecord(root, env, now) {
  let present = false;
  try {
    lstatSync(probationPath(root, env));
    present = true;
    const record = JSON.parse(readFileSync(probationPath(root, env), 'utf8'));
    const error = validateProbation(record, now);
    return error ? { error } : { record };
  } catch (e) { return { error: 'probation unreadable', absent: !present && e.code === 'ENOENT' }; }
}
function writeRecord(root, env, record) {
  const file = probationPath(root, env), tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(tmp, JSON.stringify(record) + '\n');
  renameSync(tmp, file);
}
function report(record, now) {
  const result = evaluateProbation(record, now);
  return { status: 'valid', ...result, reason: result.reason || (result.action === 'pass' ? 'all owed proofs recorded' : 'owed daemon proof pending') };
}

/** Caller MUST already hold withWriteLock(root). Used by both locked rebuild adoption paths. */
export function observeAdoptionLocked({ root, env = process.env, now = Date.now, log = console,
  registered, readClosure: closure = (d, sha) => readClosure(root, d, sha) }, previous, adopted) {
  try {
    if (!adopted?.head || (previous?.head === adopted.head && previous?.at === adopted.at)) return;
    const adoptionId = `${adopted.head}:${adopted.at}`;
    const prior = readRecord(root, env, now()); // Even a superseded record is validated before use.
    if (prior.error && !prior.absent) return invalid(prior.error);
    if (prior.record?.adoptionId === adoptionId) return report(prior.record, now());
    const outstanding = prior.record && evaluateProbation(prior.record, now());
    const pending = outstanding?.action === 'pending';
    const frozen = freezeProbation({ adoptionId, sha: adopted.head,
      provenGood: pending ? prior.record.provenGood : previous?.head ?? null,
      adoptedAt: adopted.at, registered: registered ?? registeredDaemons(root, { env }), readClosure: closure });
    // Old proofs name the old SHA: carry only the debt, never its evidence.
    const record = { ...frozen, owed: [...new Set([...frozen.owed, ...(pending ? outstanding.owed : [])])] };
    writeRecord(root, env, record);
    const result = report(record, now());
    log?.error?.(`daemon-probation: ${JSON.stringify(result)}`);
    return result;
  } catch (e) {
    try { writeRecord(root, env, null); } catch { /* An unreadable file remains invalid. */ }
    const result = invalid(`probation freeze failed: ${e.message}`);
    log?.error?.(`daemon-probation: ${JSON.stringify(result)}`);
    return result;
  }
}

/** All public reads/mutations serialize with clone writers. Results are telemetry only. */
export function createProbationObserver(options) {
  const { root, env = process.env, now = Date.now, log = console, lockOpts = {} } = options;
  const locked = async fn => {
    try {
      let result, attempts = 0;
      do {
        if (attempts) await new Promise(resolve => setTimeout(resolve, 10 * attempts));
        attempts++;
        result = await withWriteLock(root, fn, { ...lockOpts,
          ...(env.WE_DAEMON_CLONE_LOCK_ROOT ? { lockRoot: env.WE_DAEMON_CLONE_LOCK_ROOT } : {}),
          owner: `${hostname()}:${process.pid}:probation:${randomUUID()}` });
      } while (!result.ok && ['concurrent-mover', 'busy'].includes(result.reason) && attempts < 5);
      const value = result.ok ? result.value : invalid(`probation lock refused: ${result.reason} after ${attempts} attempts`);
      log?.error?.(`daemon-probation: ${JSON.stringify(value)}`);
      return value;
    } catch (e) { const value = invalid(e.message); log?.error?.(`daemon-probation: ${JSON.stringify(value)}`); return value; }
  };
  const status = () => { const p = readRecord(root, env, now()); return p.error ? invalid(p.error) : report(p.record, now()); };
  return {
    status: () => locked(status),
    adopt: (previous, adopted) => locked(() => observeAdoptionLocked(options, previous, adopted) ?? status()),
    proof: own => locked(() => {
      const p = readRecord(root, env, now());
      if (p.error) return invalid(p.error);
      const { daemonId, pid, bootHead, tickHead, startedAt, lastTickDoneAt } = own;
      const next = recordProof(p.record, daemonId, {
        boot: { daemonId, pid, head: bootHead, startedAt }, tick: { daemonId, pid, head: tickHead, lastTickDoneAt },
      }, now());
      if (next !== p.record) writeRecord(root, env, next);
      return report(next, now());
    }),
  };
}

/** Resolve THIS process, never a sibling selected by entry alone when registrations share an entry. */
export function ownDaemonId(root, entry, { env = process.env, argv = process.argv, registered } = {}) {
  const roster = registered ?? registeredDaemons(root, { env });
  const rel = relative(root, resolve(root, entry));
  const service = roster.some(d => d.id === env.XPC_SERVICE_NAME) ? env.XPC_SERVICE_NAME : null;
  const matches = roster.filter(d => d.entry === rel && (service ? service === d.id
    : d.args?.length === argv.slice(2).length && d.args.every((a, i) => a === argv[i + 2])));
  return matches.length === 1 ? matches[0].id : null;
}
