import { readFileSync, writeFileSync, renameSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { acquireLockDir, releaseLockDir } from '../readiness/file-locks.mjs';

const identityValid = ({ repo, pr, head }) => typeof repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(repo)
  && Number.isInteger(pr) && pr > 0 && /^[a-f0-9]{40}$/.test(head);
const keyFor = ({ repo, pr, head, kind }) => JSON.stringify([repo, pr, head, kind]);
function checkState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)
    || Object.values(state).some(value => value !== true)) throw new Error('MQ ledger corrupt; operator inspection required');
}
/** Transactions never reclaim a held lock. A crashed transaction requires operator inspection. */
export function mqFailureLedgerStorage(root = resolveCoordinationRoot(), { readFile = readFileSync } = {}) {
  const dir = join(root, 'mq-failure-recovery'), file = join(dir, 'ledger.json');
  return { atomicUpdate(update) {
    mkdirSync(dir, { recursive: true });
    const lockRoot = join(dir, 'locks'), resource = 'ledger';
    if (!acquireLockDir(lockRoot, resource, { owner: randomUUID(), pid: process.pid, heartbeatAt: new Date().toISOString() }))
      throw new Error('MQ ledger busy; retry next pass or inspect orphaned lock');
    try {
      let state = {};
      try {
        if (statSync(file).size > 8 * 1024 * 1024) throw new Error('MQ ledger oversized; operator inspection required');
        state = JSON.parse(readFile(file, 'utf8'));
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      checkState(state);
      const next = update(state);
      checkState(next.state);
      const bytes = JSON.stringify(next.state);
      if (Buffer.byteLength(bytes) > 8 * 1024 * 1024) throw new Error('MQ ledger oversized; operator inspection required');
      const temp = join(dir, `ledger-${randomUUID()}.json`);
      writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 });
      renameSync(temp, file);
      return next.result;
    } finally { releaseLockDir(lockRoot, resource); }
  } };
}
/** The injected adapter serializes transactions and persists before returning their result. */
export function createMqFailureLedger({ io = mqFailureLedgerStorage() } = {}) {
  const transaction = (identity, update) => {
    try {
      if (!identityValid(identity)) throw new TypeError('MQ ledger requires repo/PR/full head identity');
      return io.atomicUpdate(state => { checkState(state); return update(state); });
    } catch (error) { return Promise.reject(error); }
  };
  return {
    claim(identity) {
      if (!['route', 'refresh'].includes(identity.kind)) return Promise.reject(new TypeError('Unknown MQ ledger claim kind'));
      return transaction(identity, state => {
        const key = keyFor(identity);
        if (state[key]) return { state, result: { claimed: false, note: identity.kind === 'refresh'
          ? 'Already refreshed; operator inspection required' : 'Already routed this head' } };
        return { state: { ...state, [key]: true }, result: { claimed: true } };
      });
    },
    // Separate from attempt consumption: a failed mechanical attempt still owes an ordinary fixer.
    recordFixFallback(identity) {
      return transaction(identity, state => ({ state: { ...state,
        [keyFor({ ...identity, kind: 'fix-fallback' })]: true }, result: { recorded: true } }));
    },
    readFixFallback(identity) {
      return transaction(identity, state => ({ state,
        result: state[keyFor({ ...identity, kind: 'fix-fallback' })] === true }));
    },
    recordRefresh(identity) {
      if (!identityValid({ ...identity, head: identity.newHead })) return Promise.reject(new TypeError('Unknown refreshed successor'));
      return transaction(identity, state => ({ state: { ...state,
        [keyFor({ ...identity, kind: 'refresh' })]: true,
        [keyFor({ ...identity, head: identity.newHead, kind: 'refresh' })]: true,
        // Marks the successor as a head this ledger itself produced, so a later failure of it can reach the fixer.
        [keyFor({ ...identity, head: identity.newHead, kind: 'refresh-successor' })]: true }, result: { recorded: true } }));
    },
    readRefreshSuccessor(identity) {
      return transaction(identity, state => ({ state,
        result: state[keyFor({ ...identity, kind: 'refresh-successor' })] === true }));
    },
  };
}
