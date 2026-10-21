/** Durable card admission: exclusive lease, isolated Git objects, remote recovery, atomic membership. */
import { execFileSync } from 'node:child_process';
import {
  closeSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setImmediate } from 'node:timers/promises';
import { mergeMembers, planAdmit } from './card-batch.mjs';
import { automationStateRoot } from '../lib/automation-home.mjs';
import { raisedBySidecarId } from '../lib/card-batch-policy.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
/**
 * Batch state is SHARED by every clone that files cards (review, fix, health, build daemons and lanes): a
 * per-clone directory would give each clone its own idea of the open batch, and two clones would then race the
 * same `lane/card-batch-<kind>-<n>` ref. So it lives in the automation state home, outside every git tree
 * (`WE_CARD_BATCH_STATE_DIR` overrides it).
 */
export function cardBatchStateDir(env = process.env) {
  return env?.WE_CARD_BATCH_STATE_DIR || join(automationStateRoot(env), 'card-batch');
}
const MARKER = 'Card-Batch: ';
export const AI_TRAILER = 'Co-Authored-By: Claude <noreply@anthropic.com>';
const refuse = reason => ({ action: 'refuse', reason });
const readJSON = path => {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const ms = value => value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
const COMMIT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** The lock as found on disk: its lease (null when empty/unparseable) and mtime; undefined when absent. */
function readLock(path) {
  let mtimeMs;
  try { mtimeMs = statSync(path).mtimeMs; } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  try {
    const lease = JSON.parse(readFileSync(path, 'utf8'));
    return { lease: lease && typeof lease === 'object' ? lease : null, mtimeMs };
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    return { lease: null, mtimeMs };
  }
}
/** A lock with no readable expiry (a producer died between creating and writing it) ages out by mtime. */
const lockExpiry = (lock, leaseMs) => Number.isFinite(ms(lock.lease?.expiresAt)) ? ms(lock.lease.expiresAt) : lock.mtimeMs + leaseMs;
/** Token of the lease currently on disk; any unreadable lock reads as nobody's. */
export const tokenOf = path => readLock(path)?.lease?.token;

/** Git runner whose captured output is bounded at 16 MiB; `maxBuffer` follows `...options`, so a caller cannot raise it. */
export const gitIn = (cwd, exec = execFileSync) => (args, options = {}) => exec('git', args, {
  cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...options, maxBuffer: 16 * 1024 * 1024,
  env: { ...process.env, GIT_AUTHOR_NAME: 'Card batch', GIT_AUTHOR_EMAIL: 'card-batch@localhost',
    GIT_COMMITTER_NAME: 'Card batch', GIT_COMMITTER_EMAIL: 'card-batch@localhost',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
});

/** Production GitHub lookup, with a fixed deadline and captured-output limit. */
export const defaultGh = (args, exec = execFileSync) => exec('gh', args, {
  encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
});

/** Recovery cannot disable its per-command deadline or raise gitIn's output limit. */
export const recoveryGitIn = (cwd, exec = execFileSync) => {
  const run = gitIn(cwd, exec);
  return (args, options = {}) => run(args, { ...options, timeout: 30_000 });
};

/** A token prevents a finishing, expired producer from releasing its successor's lease. */
export function acquireLease(path, owner, now, leaseMs, hook) {
  const lease = { owner, expiresAt: now + leaseMs, token: randomUUID() };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      try { writeFileSync(fd, JSON.stringify(lease)); } finally { closeSync(fd); }
      return lease;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const held = readLock(path);
      if (!held) continue;
      if (lockExpiry(held, leaseMs) > now) return null;
      hook?.('before-stale-removal');
      // Rename the lock away so only one contender can claim it, then judge what was actually claimed: if a successor
      // replaced the stale lock first, put the live one back instead of destroying it. The lock is briefly absent in
      // that case; every holder checks its token before writing, so the cost is a spurious `lease-held`, never a
      // second writer.
      const claimed = `${path}.stale-${randomUUID()}`;
      try { renameSync(path, claimed); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      try {
        const taken = readLock(claimed);
        if (taken && lockExpiry(taken, leaseMs) > now) {
          try { linkSync(claimed, path); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        }
      } finally { rmSync(claimed, { force: true }); }
    }
  }
  return null;
}

export function atomicRecord(path, state) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

// Only this module's fresh GitHub read can authorize a completed seal's retirement.
const terminalRetirement = Symbol('fresh terminal PR');

/** Archive before replacing the active slot; caller must own and recheck the existing lease. */
export function retireBatch(statePath, state, { repo, kind, held, terminalPrState, authorization }) {
  if (basename(dirname(statePath)) === 'sealed') return state;
  if (!state.sealFailure && (authorization !== terminalRetirement || !['MERGED', 'CLOSED'].includes(terminalPrState))) {
    throw new Error('batch-sealed');
  }
  if (!held()) throw new Error('lease-held');
  const archiveDir = join(dirname(statePath), 'sealed');
  mkdirSync(archiveDir, { recursive: true });
  const archivePath = join(archiveDir, `${repo.replaceAll('/', '-')}-${state.seq}-${kind}.json`);
  atomicRecord(archivePath, { ...state, kind, repo, ...(terminalPrState ? { terminalPrState } : {}) });
  if (!held()) throw new Error('lease-held');
  const successor = { seq: state.seq, lastSealedState: archivePath };
  atomicRecord(statePath, successor);
  return successor;
}

/** Recover closed batch members from their immutable coordinator commits, never from worktree text.
 * Must refuse on unreadable evidence. Docs/config/data outside top-level cards and raised-by sidecars remain ineligible.
 * No receive endpoint is added: bounded gh/git output, a timed lookup and the lease bound recovery triggers.
 */
function respoolClosed(state, input, stateDir, remote, held) {
  const git = recoveryGitIn(input.laneDir ?? ROOT);
  // A stale origin/main must not cause us to discard or duplicate a member.
  git(['fetch', '--no-tags', remote, 'refs/heads/main']);
  const main = git(['rev-parse', 'FETCH_HEAD^{commit}']).trim();
  git(['fetch', '--no-tags', remote, `refs/heads/${state.batchRef}`]);
  const entries = state.members.map(member => {
    if (!COMMIT_ID.test(member.commitSha) || !/^(?:[a-z0-9]+|rb-[a-z0-9]+-\d+-[a-f0-9]{24})$/.test(member.cardId)
      || member.source?.repo !== input.source.repo) throw new Error('invalid member identity');
    const lines = git(['show', '-s', '--format=%B', member.commitSha]).split('\n').filter(line => line.startsWith(MARKER));
    if (lines.length !== 1) throw new Error('invalid member evidence');
    const data = JSON.parse(lines[0].slice(MARKER.length));
    git(['merge-base', '--is-ancestor', member.commitSha, state.headSha]);
    const changed = git(['diff-tree', '--no-commit-id', '--name-status', '-r', '-z', member.commitSha]).split('\0');
    if (changed.length !== 3 || changed[0] !== 'A' || changed[1] !== data.cardPath) throw new Error('invalid card change');
    if (data.cardId !== member.cardId || data.idemKey !== member.idemKey || data.kind !== input.kind
      || data.source?.repo !== input.source.repo || data.batchRef !== state.batchRef
      // A raised-by sidecar ("also raised" note) is keyed by its own `rb-…` id; a card by its `<id>-` prefix.
      || (raisedBySidecarId(data.cardPath) ? raisedBySidecarId(data.cardPath) !== member.cardId
        : (!/^[a-z0-9]+$/.test(member.cardId) || !/^backlog\/[a-z0-9]+-[a-z0-9-]+\.md$/.test(data.cardPath)
          || !data.cardPath.startsWith(`backlog/${member.cardId}-`)))) throw new Error('invalid member evidence');
    if (git(['ls-tree', main, '--', data.cardPath]).trim()) return null;
    if (!git(['ls-tree', member.commitSha, '--', data.cardPath]).startsWith('100644 blob ')) throw new Error('invalid card mode');
    const bytes = git(['show', `${member.commitSha}:${data.cardPath}`], { encoding: 'buffer' });
    const content = bytes.toString('utf8');
    if (!Buffer.from(content).equals(bytes)) throw new Error('invalid card encoding');
    return { cardId: member.cardId, rel: data.cardPath, content, idemKey: member.idemKey, source: member.source };
  }).filter(Boolean);
  const pending = join(stateDir, 'pending-prevention');
  if (!held()) throw new Error('lease-held');
  mkdirSync(pending, { recursive: true });
  for (const entry of entries) {
    if (!held()) throw new Error('lease-held');
    const path = join(pending, `${entry.cardId}.json`);
    // Exclusive publish preserves another filer's spool. A conflicting entry holds the batch.
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(entry), { flag: 'wx' });
      try { linkSync(temporary, path); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = readJSON(path);
        if (!existing || Object.keys(entry).some(key => JSON.stringify(existing[key]) !== JSON.stringify(entry[key]))) {
          throw new Error('conflicting pending card');
        }
      }
    } finally { rmSync(temporary, { force: true }); }
  }
}

/** A sealed card batch may be retired and replaced only when a fresh GitHub read confirms its PR is MERGED or CLOSED.
 * Retire a terminal sealed generation under the caller's admission lease; unreadable evidence stays held. */
export async function retireTerminalBatch(recorded, input, {
  statePath, stateDir = dirname(statePath), remote = 'origin', gh = defaultGh,
  held: stillHeld, log = line => process.stderr.write(`${line}\n`),
}) {
  if ((!recorded?.sealFailure && recorded?.seal?.step !== 'label-on-green')
    || !recorded?.batchRef || !recorded.sealedAt || !recorded.pr
    || basename(dirname(statePath)) === 'sealed') return refuse('batch-sealed');
  let status = 'UNREADABLE';
  try {
    if (!Number.isSafeInteger(recorded.seq) || recorded.seq < 1 || !COMMIT_ID.test(String(recorded.headSha))
      || !Number.isSafeInteger(Number(recorded.pr)) || Number(recorded.pr) <= 0
      || recorded.repo && recorded.repo !== input.source.repo
      || recorded.kind && recorded.kind !== input.kind
      || recorded.batchRef !== `lane/card-batch-${input.kind}-${recorded.seq}`) throw new Error('invalid batch identity');
    const view = JSON.parse(await gh(['pr', 'view', String(recorded.pr), '--repo', input.source.repo, '--json', 'number,state,headRefName']));
    if (Number(view?.number) === Number(recorded.pr) && view.headRefName === recorded.batchRef
      && ['OPEN', 'CLOSED', 'MERGED'].includes(view.state)) status = view.state;
    if (!stillHeld()) return refuse('lease-held');
    if (status === 'CLOSED') respoolClosed(recorded, input, stateDir, remote, stillHeld);
    if (status === 'MERGED' || status === 'CLOSED') {
      const retired = recorded;
      recorded = retireBatch(statePath, recorded, { repo: input.source.repo, kind: input.kind, held: stillHeld, terminalPrState: status, authorization: terminalRetirement });
      log(`card-batch ${retired.batchRef} PR ${retired.pr} GitHub ${status}: retired${status === 'CLOSED' ? ' and re-spooled' : ''}`);
    } else {
      log(`card-batch ${recorded.batchRef} PR ${recorded.pr} GitHub ${status}: kept sealed and held`);
      return refuse('batch-sealed');
    }
  } catch {
    log(`card-batch ${recorded.batchRef} PR ${recorded.pr} GitHub ${status}: recovery unreadable; kept sealed and held`);
    return refuse('batch-sealed');
  }
  return { action: 'retired', state: recorded };
}

/** Returns admission/dedupe/refusal; injected crashes throw CARD_BATCH_CRASH at the named boundary. */
export async function admitCard(input, {
  stateDir = cardBatchStateDir(), remote = 'origin', clock = Date.now,
  owner = `${process.pid}:${randomUUID()}`, policy, leaseMs = 60_000, crashAt, hook,
  gh = defaultGh,
  log = line => process.stderr.write(`${line}\n`),
} = {}) {
  const now = () => ms(clock());
  const initial = planAdmit({ state: null, input, policy, now: now(), owner });
  if (initial.action === 'refuse') return initial;
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new TypeError('leaseMs must be positive');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.source?.repo ?? '')
    || typeof input.idemKey !== 'string' || !input.idemKey || typeof input.cardId !== 'string' || !input.cardId) {
    throw new TypeError('source.repo, cardId and idemKey are required');
  }
  // Values below reach git as positional argv: a leading `--` would parse as an option (e.g. --upload-pack=<cmd>).
  if (typeof input.baseSha !== 'string' || !COMMIT_ID.test(input.baseSha)) throw new TypeError('baseSha must be a full commit id');
  if (typeof remote !== 'string' || !remote || remote.startsWith('-')) throw new TypeError('remote must not be empty or start with "-"');
  const repoDir = resolve(input.laneDir ?? ROOT);
  const statePath = join(stateDir, `${input.source.repo.replaceAll('/', '-')}-${input.kind}.json`);
  const lockPath = `${statePath}.lock`;
  mkdirSync(stateDir, { recursive: true });
  const lease = acquireLease(lockPath, owner, now(), leaseMs, hook);
  if (!lease) return refuse('lease-held');
  const auditLease = { owner: lease.owner, expiresAt: lease.expiresAt };
  let scratch;
  const stillHeld = () => tokenOf(lockPath) === lease.token && now() < lease.expiresAt;
  const crash = point => {
    hook?.(point);
    if (crashAt === point) {
      const error = new Error(`card batch injected crash: ${point}`);
      error.code = 'CARD_BATCH_CRASH';
      error.point = point;
      throw error;
    }
  };
  try {
    // Permit independent producers to contend even when Git itself is synchronous.
    await setImmediate();
    let recorded = readJSON(statePath);
    if (basename(dirname(statePath)) === 'sealed') return refuse('batch-sealed');
    if (recorded?.batchRef && !COMMIT_ID.test(String(recorded.headSha))) return refuse('head-mismatch');
    // Preserve member retries before retiring their membership. Dedupe still takes the remote-head
    // validation path below; the lockfile, rather than the previous writer's audit lease, is authoritative.
    let plan = planAdmit({ state: recorded && { ...recorded, lease: auditLease }, input, policy, now: now(), owner });
    if (plan.action !== 'dedupe' && recorded?.batchRef && recorded.sealedAt && recorded.pr) {
      const result = await retireTerminalBatch(recorded, input, {
        statePath, stateDir, remote, gh, held: stillHeld, log,
      });
      if (result.action !== 'retired') return result;
      recorded = result.state;
    }
    plan = planAdmit({ state: recorded && { ...recorded, lease: auditLease }, input, policy, now: now(), owner });
    if (plan.action === 'refuse') return plan;
    const seq = recorded?.batchRef ? recorded.seq : (recorded?.seq ?? 0) + 1;
    const ref = `refs/heads/${recorded?.batchRef ?? `lane/card-batch-${input.kind}-${seq}`}`;
    scratch = mkdtempSync(join(tmpdir(), 'card-batch-'));
    const git = gitIn(scratch);
    // Resolve remote aliases in the producer repo; all writes happen in this private repository.
    let target = remote;
    const aliases = git(['remote'], { cwd: repoDir }).trim().split('\n');
    if (aliases.includes(remote)) target = git(['remote', 'get-url', '--push', remote], { cwd: repoDir }).trim();
    if (!isAbsolute(target) && !/^[\w+.-]+:\/\//.test(target) && !/^[^/]+:/.test(target)) target = resolve(repoDir, target);
    if (target.startsWith('-')) throw new TypeError('remote url must not start with "-"');
    git(['init', '--bare', '-q', scratch]);
    git(['fetch', '--no-tags', repoDir, `+${input.baseSha}:refs/card-batch/base`]);
    const baseSha = git(['rev-parse', 'refs/card-batch/base^{commit}']).trim();
    const advertised = git(['ls-remote', '--refs', target, ref]).trim();
    let remoteHead = null;
    if (advertised) {
      git(['fetch', '--no-tags', target, `+${ref}:refs/card-batch/remote`]);
      remoteHead = git(['rev-parse', 'refs/card-batch/remote^{commit}']).trim();
    }
    let state = recorded?.batchRef ? { ...recorded, lease: auditLease } : {
      batchRef: ref.slice('refs/heads/'.length), seq, headSha: baseSha,
      openedAt: new Date(now()).toISOString(), lease: auditLease, members: [],
    };
    let entries = [];
    if (remoteHead && remoteHead !== state.headSha) {
      // Only a continuous suffix of coordinator commits can repair a missing record.
      try {
        git(['merge-base', '--is-ancestor', state.headSha, remoteHead]);
        const commits = git(['rev-list', '--reverse', `${state.headSha}..${remoteHead}`]).trim().split('\n');
        entries = commits.map(commitSha => {
          const parents = git(['show', '-s', '--format=%P', commitSha]).trim().split(' ');
          const message = git(['show', '-s', '--format=%B', commitSha]);
          const lines = message.split('\n').filter(line => line.startsWith(MARKER));
          if (parents.length !== 1 || lines.length !== 1) throw new Error('unrecognized commit');
          const data = JSON.parse(lines[0].slice(MARKER.length));
          const changed = git(['diff-tree', '--no-commit-id', '--name-status', '-r', '-z', commitSha]).split('\0');
          const tree = git(['ls-tree', commitSha, '--', data.cardPath]).trim();
          if (changed.length !== 3 || changed[0] !== 'A' || changed[1] !== data.cardPath
            || !tree.startsWith('100644 blob ') || data.source?.repo !== input.source.repo
            || data.kind !== input.kind || !Number.isFinite(Date.parse(data.admittedAt))) throw new Error('invalid card evidence');
          return { commitSha, parentSha: parents[0], batchRef: data.batchRef, cardPath: data.cardPath,
            member: { cardId: data.cardId, idemKey: data.idemKey, commitSha, source: data.source, admittedAt: data.admittedAt } };
        });
      } catch { return refuse('head-mismatch'); }
    }
    plan = planAdmit({ state, input: { ...input,
      remoteHead: remoteHead ?? (recorded?.batchRef ? null : baseSha), remoteLogEntries: entries,
    }, policy, now: now(), owner });
    const recovered = plan.action === 'reconcile';
    if (recovered) {
      state = plan.state;
      if (!recorded?.batchRef) state.openedAt = entries[0].member.admittedAt;
      plan = planAdmit({ state, input, policy, now: now(), owner });
    }
    if (plan.action === 'refuse') return plan;
    if (!stillHeld()) return refuse('lease-held');
    if (plan.action === 'dedupe') {
      if (recovered) atomicRecord(statePath, state);
      return { ...plan, state };
    }
    // Read bytes without filters; build a tree from exactly one new regular blob.
    const card = resolve(repoDir, input.cardPath);
    if (!lstatSync(card).isFile() || (statSync(card).mode & 0o111)
      || !realpathSync(card).startsWith(`${realpathSync(repoDir)}${sep}`)
      || git(['ls-tree', state.headSha, '--', input.cardPath]).trim()) return refuse('ineligible-change');
    const bytes = readFileSync(card);
    git(['read-tree', state.headSha]);
    const blob = git(['hash-object', '-w', '--stdin'], { input: bytes }).trim();
    git(['update-index', '--add', '--cacheinfo', '100644', blob, input.cardPath]);
    const tree = git(['write-tree']).trim();
    const admittedAt = new Date(now()).toISOString();
    const metadata = { cardPath: input.cardPath, cardId: input.cardId, idemKey: input.idemKey,
      source: input.source, kind: input.kind, batchRef: state.batchRef, admittedAt };
    // The trailer marks the commit as AI-authored, so the drain's AI-generated gate can land the batch PR.
    const message = `Admit card ${JSON.stringify(input.cardId)} (idemKey ${JSON.stringify(input.idemKey)})\n\n${MARKER}${JSON.stringify(metadata)}\n\n${AI_TRAILER}\n`;
    const commitSha = git(['commit-tree', tree, '-p', state.headSha], { input: message }).trim();
    crash('after-commit');
    if (!stillHeld()) return refuse('lease-held');
    try { git(['push', target, `${commitSha}:${ref}`]); }
    catch (error) {
      if (/\[rejected\]|non-fast-forward|fetch first|cannot lock ref/.test(String(error.stderr))) return refuse('ff-reject');
      throw error;
    }
    crash('after-push');
    if (!stillHeld()) return refuse('lease-held');
    const member = { cardId: input.cardId, idemKey: input.idemKey, commitSha, source: input.source, admittedAt };
    state = { ...state, headSha: commitSha, members: mergeMembers(state.members, [member]) };
    atomicRecord(statePath, state);
    crash('after-record');
    return { action: 'admit', batchRef: state.batchRef, member, state };
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    if (tokenOf(lockPath) === lease.token) rmSync(lockPath, { force: true });
  }
}
