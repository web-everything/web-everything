/** R986 S2a-1b: report-only probation IO. No result from here authorizes any lifecycle decision. */
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, realpathSync } from 'node:fs';
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
import { collectImportClosure } from '../import-closure.mjs';
import { parseImportSpecifiers } from '../route-import-graph.mjs';

export const probationPath = (root, env = process.env) => join(stateDir(env), `${cloneKey(root)}.probation.json`);
const invalid = reason => ({ status: 'invalid', action: 'pending', reason: `${reason}; operator recovery required` });
const canonical = p => realpathSync(p);

/** Launchd labels distinguish multiple services running the same entry on ONE clone. Unknown roster throws. */
export function registeredDaemons(root, { env = process.env, exec = execFileSync, readdir = readdirSync } = {}) {
  const dir = env.WE_LAUNCH_AGENTS_DIR || join(homedir(), 'Library', 'LaunchAgents');
  let incomplete = false;
  const clones = resolveDaemonClones({ env, exec, launchAgentsDir: dir,
    readdir: p => readdir(p), onIncomplete: () => { incomplete = true; } });
  if (incomplete) throw new Error('daemon roster incomplete; inspect launchd registrations');
  const clone = clones.find(c => canonical(c.path) === canonical(root));
  if (!clone?.labels.length) throw new Error('daemon roster unknown; inspect launchd registrations');
  return clone.labels.map(id => {
    const plist = readPlistAsJson(join(dir, `${id}.plist`), { exec });
    const argv = plist?.ProgramArguments;
    if (!Array.isArray(argv) || argv.some(a => typeof a !== 'string')) throw new Error('daemon argv unreadable');
    const index = argv.findIndex(a => /\.(?:mjs|cjs|js)$/.test(a));
    if (index < 0) throw new Error('daemon entry unknown; inspect launchd registration');
    const entry = relative(root, resolve(plist.WorkingDirectory, argv[index]));
    if (!entry || entry.startsWith('..') || isAbsolute(entry)) throw new Error('daemon entry outside clone');
    return { id, entry, args: argv.slice(index + 1) };
  });
}

/** Read only immutable Git objects. Unknown dynamic/package imports conservatively owe proof. */
export function readClosure(root, daemon, sha) {
  try {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(sha)) return { complete: false };
    const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 5000,
      maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    const blobs = new Map(git(['ls-tree', '-rz', '--full-tree', sha]).split('\0').filter(Boolean).map(row => {
      const [meta, file] = row.split('\t');
      const [mode, type, blob] = meta.split(' ');
      return [file, type === 'blob' && mode !== '120000' ? blob : null];
    }));
    const rel = p => relative(root, p);
    const exists = p => Boolean(blobs.get(rel(p)));
    const source = p => git(['cat-file', 'blob', blobs.get(rel(p))]);
    let unresolved = false;
    const closure = collectImportClosure({ root, entries: [daemon.entry], exists, readFile: p => {
      const text = source(p);
      for (const spec of parseImportSpecifiers(text)) {
        if (!spec.startsWith('.')) { if (!spec.startsWith('node:')) unresolved = true; continue; }
        const base = resolve(dirname(p), spec);
        if (![base, `${base}.mjs`, `${base}.js`, `${base}.cjs`, `${base}/index.mjs`, `${base}/index.js`].some(exists)) unresolved = true;
      }
      return text;
    } });
    if (!closure?.complete || unresolved || closure.bareDeps) return { complete: false };
    return { complete: true, files: Object.fromEntries([...closure.files].map(p => [p, blobs.get(p)])) };
  } catch { return { complete: false }; } // Includes Git/output bounds: operator can inspect imports; all daemons owe proof.
}

function readRecord(root, env, now) {
  try {
    const record = JSON.parse(readFileSync(probationPath(root, env), 'utf8'));
    const error = validateProbation(record, now);
    return error ? { error } : { record };
  } catch { return { error: 'probation unreadable' }; }
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
    if (prior.record?.adoptionId === adoptionId) return report(prior.record, now());
    const record = freezeProbation({ adoptionId, sha: adopted.head, provenGood: previous?.head ?? null,
      adoptedAt: adopted.at, registered: registered ?? registeredDaemons(root, { env }), readClosure: closure });
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
      const result = await withWriteLock(root, fn, { ...lockOpts,
        ...(env.WE_DAEMON_CLONE_LOCK_ROOT ? { lockRoot: env.WE_DAEMON_CLONE_LOCK_ROOT } : {}),
        owner: `${hostname()}:${process.pid}:probation:${randomUUID()}` });
      const value = result.ok ? result.value : invalid(`probation lock refused: ${result.reason}`);
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
