/** Durable card admission: exclusive lease, isolated Git objects, remote recovery, atomic membership. */
import { execFileSync } from 'node:child_process';
import {
  closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setImmediate } from 'node:timers/promises';
import { mergeMembers, planAdmit } from './card-batch.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MARKER = 'Card-Batch: ';
const refuse = reason => ({ action: 'refuse', reason });
const readJSON = path => {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const ms = value => value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);

/** A token prevents a finishing, expired producer from releasing its successor's lease. */
function acquireLease(path, owner, now, leaseMs) {
  const lease = { owner, expiresAt: now + leaseMs, token: randomUUID() };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      try { writeFileSync(fd, JSON.stringify(lease)); } finally { closeSync(fd); }
      return lease;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // An empty/partial file belongs to an acquiring producer: fail closed.
      let held;
      try { held = readJSON(path); } catch { return null; }
      if (!held) continue;
      if (!Number.isFinite(ms(held.expiresAt)) || ms(held.expiresAt) > now) return null;
      // Re-read before removing an expired record, in case its owner released it.
      if (readJSON(path)?.token !== held.token) continue;
      try { unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  return null;
}

function atomicRecord(path, state) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

/** Returns admission/dedupe/refusal; injected crashes throw CARD_BATCH_CRASH at the named boundary. */
export async function admitCard(input, {
  stateDir = join(ROOT, '.operations/card-batch'), remote = 'origin', clock = Date.now,
  owner = `${process.pid}:${randomUUID()}`, policy, leaseMs = 60_000, crashAt,
} = {}) {
  const now = () => ms(clock());
  const initial = planAdmit({ state: null, input, policy, now: now(), owner });
  if (initial.action === 'refuse') return initial;
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new TypeError('leaseMs must be positive');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.source?.repo ?? '')
    || typeof input.idemKey !== 'string' || !input.idemKey || typeof input.cardId !== 'string' || !input.cardId) {
    throw new TypeError('source.repo, cardId and idemKey are required');
  }
  const repoDir = resolve(input.laneDir ?? ROOT);
  const statePath = join(stateDir, `${input.source.repo.replaceAll('/', '-')}-${input.kind}.json`);
  const lockPath = `${statePath}.lock`;
  mkdirSync(stateDir, { recursive: true });
  const lease = acquireLease(lockPath, owner, now(), leaseMs);
  if (!lease) return refuse('lease-held');
  const auditLease = { owner: lease.owner, expiresAt: lease.expiresAt };
  let scratch;
  const stillHeld = () => readJSON(lockPath)?.token === lease.token && now() < lease.expiresAt;
  const crash = point => {
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
    const recorded = readJSON(statePath);
    // The lockfile is authoritative. State's lease is the audit snapshot of its last writer.
    let plan = planAdmit({ state: recorded && { ...recorded, lease: auditLease }, input, policy, now: now(), owner });
    if (plan.action === 'refuse') return plan;
    const seq = recorded?.batchRef ? recorded.seq : (recorded?.seq ?? 0) + 1;
    const ref = `refs/heads/${recorded?.batchRef ?? `lane/card-batch-${input.kind}-${seq}`}`;
    scratch = mkdtempSync(join(tmpdir(), 'card-batch-'));
    const git = (args, options = {}) => execFileSync('git', args, {
      cwd: scratch, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...options,
      env: { ...process.env, GIT_AUTHOR_NAME: 'Card batch', GIT_AUTHOR_EMAIL: 'card-batch@localhost',
        GIT_COMMITTER_NAME: 'Card batch', GIT_COMMITTER_EMAIL: 'card-batch@localhost',
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    });
    // Resolve remote aliases in the producer repo; all writes happen in this private repository.
    let target = remote;
    const aliases = git(['remote'], { cwd: repoDir }).trim().split('\n');
    if (aliases.includes(remote)) target = git(['remote', 'get-url', '--push', remote], { cwd: repoDir }).trim();
    if (!isAbsolute(target) && !/^[\w+.-]+:\/\//.test(target) && !/^[^/]+:/.test(target)) target = resolve(repoDir, target);
    git(['init', '--bare', '-q', scratch]);
    git(['fetch', '--no-tags', repoDir, input.baseSha]);
    const baseSha = git(['rev-parse', 'FETCH_HEAD^{commit}']).trim();
    const advertised = git(['ls-remote', '--refs', target, ref]).trim();
    let remoteHead = null;
    if (advertised) {
      git(['fetch', '--no-tags', target, ref]);
      remoteHead = git(['rev-parse', 'FETCH_HEAD^{commit}']).trim();
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
    const message = `Admit card ${JSON.stringify(input.cardId)} (idemKey ${JSON.stringify(input.idemKey)})\n\n${MARKER}${JSON.stringify(metadata)}\n`;
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
    if (readJSON(lockPath)?.token === lease.token) rmSync(lockPath, { force: true });
  }
}
