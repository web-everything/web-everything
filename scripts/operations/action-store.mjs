/** #3383 — Durable resource-scoped attempts. Exclusive creation allocates attempts; locked CAS fences writes. */
import * as nativeFs from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { coordinationPaths, resolveCoordinationRoot } from './coordination-root.mjs';
import { tryLease } from './coordination-lock.mjs';
import { CoordinationUnavailableError, parseResource, assertActionRecord, transitionRecord, milliseconds, withResult, isExpired, LEASE_MS, reconcile as inspect } from './action-record.mjs';
export { CoordinationUnavailableError } from './action-record.mjs';
export function createActionStore({ root = resolveCoordinationRoot(), fs = nativeFs, now = Date.now, leaseMs = LEASE_MS, absenceGraceMs, maxObservedAgeMs = 24 * 60 * 60_000, isPidAlive, wait } = {}) {
  const dir = coordinationPaths(root).actions;
  const io = (path, fn) => { try { return fn(); } catch (e) { throw e instanceof CoordinationUnavailableError ? e : new CoordinationUnavailableError(path, e); } };
  const resourceDir = (r) => join(dir, encodeURIComponent(parseResource(r).resource));
  const pathFor = (r, attempt) => {
    if (!Number.isInteger(attempt) || attempt < 1) throw new TypeError('Invalid attempt');
    return join(resourceDir(r), `attempt-${String(attempt).padStart(6, '0')}.json`);
  };
  const ensure = () => io(dir, () => { fs.mkdirSync(dir, { recursive: true }); return fs.readdirSync(dir); });
  const read = (resource, attempt) => io(pathFor(resource, attempt), () => {
    const record = assertActionRecord(JSON.parse(fs.readFileSync(pathFor(resource, attempt), 'utf8')));
    if (record.attempt !== attempt || record.resource !== parseResource(resource).resource) throw new Error('Action filename/record mismatch');
    return record;
  });
  const attempts = (resource) => io(resourceDir(resource), () => {
    ensure();
    let names;
    try { names = fs.readdirSync(resourceDir(resource)); }
    catch (e) { if (e.code !== 'ENOENT') throw e; fs.readdirSync(dir); return []; }
    if (names.some((n) => !/^attempt-\d+\.json(?:\.lock(?:\.gate(?:\.preparing-[\w-]+)?)?|\.[\w-]+\.tmp)?$/.test(n))) throw new Error('Unrecognized action-store entry');
    const records = names.filter((n) => /^attempt-\d+\.json$/.test(n)).map((n) => read(resource, Number(n.slice(8, -5)))).sort((a, b) => a.attempt - b.attempt);
    if (records.some((r, i) => r.attempt !== i + 1 || (i < records.length - 1 && r.state !== 'terminal'))) throw new Error('Inconsistent action attempt history');
    return records;
  });
  const list = () => ensure().flatMap((name) => {
    return io(join(dir, name), () => {
      const resource = parseResource(decodeURIComponent(name)).resource;
      if (encodeURIComponent(resource) !== name) throw new Error('Noncanonical resource directory');
      return attempts(resource);
    });
  });
  const write = (record) => io(pathFor(record.resource, record.attempt), () => {
    assertActionRecord(record);
    const path = pathFor(record.resource, record.attempt), tmp = `${path}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record)); fs.renameSync(tmp, path); return record;
  });
  const locked = (resource, attempt, fn) => {
    const lock = tryLease({ path: `${pathFor(resource, attempt)}.lock`, owner: { pid: process.pid, host: hostname() }, now, staleMs: 10_000, isPidAlive, fs, wait });
    if (!lock.ok) return { ok: false, reason: 'busy' };
    try { return lock.handle.runIfOwned(() => fn(read(resource, attempt))); } finally { lock.handle.release(); }
  };
  const transition = (resource, attempt, opts) => locked(resource, attempt, (record) => {
    // Public patches cannot replace identity or fencing fields.
    if (Object.keys(opts.patch ?? {}).some((k) => !['handle', 'dispatchingSince', 'outcome', 'evidence'].includes(k))) return { ok: false, reason: 'invalid-patch' };
    const result = transitionRecord(record, opts, now());
    if (result.ok) write(result.record);
    return result;
  });
  const heartbeat = (resource, attempt, token) => locked(resource, attempt, (r) => {
    if (r.ownerToken !== token) return { ok: false, reason: 'owner-lost' };
    if (r.state === 'terminal') return { ok: false, reason: 'terminal' };
    return { ok: true, record: write({ ...r, heartbeatAt: milliseconds(now()), updatedAt: milliseconds(now()), rev: r.rev + 1 }) };
  });
  const reconcile = (record, ports = {}) => {
    // Claim-time reconciliation must use the same postcondition as the tick/CLI for observed work.
    if (record.state === 'observed') return settle(record.resource, record.attempt, {
      postconditionHolds: ports.postconditionHolds, token: record.ownerToken, rev: record.rev,
    });
    return withResult(inspect(record, { now: now(), absenceGraceMs, ...ports }), (result) => {
      if (result.outcome === 'indeterminate') return { ok: false, held: true, reason: 'held:indeterminate', record };
      return locked(record.resource, record.attempt, (current) => {
        if (current.rev !== record.rev || current.ownerToken !== record.ownerToken) return { ok: false, held: true, reason: 'stale-rev', record: current };
        const to = result.outcome === 'effect-found' ? 'observed' : 'terminal';
        // Observed work can only be retired by its postcondition, never by an absence probe.
        if (current.state === 'observed') return { ok: false, held: true, reason: 'held', record: current };
        const next = transitionRecord(current, { token: current.ownerToken, from: current.state, to,
          patch: { owner: ports.owner ?? 'reconciler', ownerToken: randomUUID(), heartbeatAt: milliseconds(now()),
            handle: result.handle ?? current.handle, outcome: to === 'terminal' ? 'abandoned-absent' : null, evidence: { ...current.evidence, reconciliation: result.evidence } } }, now());
        if (next.ok) write(next.record);
        return next;
      });
    });
  };
  const claim = ({ resource, kind, owner, evidence = null, attempt, reconcile: reconcilePort, canClaim }) => {
    if (attempt !== undefined) throw new TypeError('Attempt numbers are allocated by the action store');
    const identity = parseResource(resource);
    const allocate = () => {
      // A corrupt unrelated resource also blocks dispatch. Partial visibility is unsafe.
      list();
      const rows = attempts(identity.resource), latest = rows.at(-1);
      if (latest && latest.state !== 'terminal') {
        if (isExpired(latest, now()) && reconcilePort) {
          const failed = (error) => {
            if (error.code === 'COORDINATION_UNAVAILABLE') throw error;
            return { ok: false, held: true, reason: 'held:indeterminate', record: latest };
          };
          try { return withResult(reconcilePort(latest), (result) => {
            if (result?.ok && result.record?.state === 'terminal') return allocate();
            return { ok: false, held: true, reason: result?.reason ?? 'held', record: result?.record ?? latest };
          }, failed); } catch (error) { return failed(error); }
        }
        return { ok: false, held: true, reason: isExpired(latest, now()) ? 'held:indeterminate' : 'held', record: latest };
      }
      // Recheck terminal admission on every allocation retry, including exclusive-create races.
      if (latest && canClaim && canClaim(latest) !== true) return { ok: false, held: true, reason: 'held', record: latest };
      const at = milliseconds(now());
      const record = { version: 1, ...identity, attempt: (latest?.attempt ?? 0) + 1, kind, state: 'intent', outcome: null,
        owner, ownerToken: randomUUID(), createdAt: at, updatedAt: at, heartbeatAt: at, leaseMs,
        handle: null, dispatchingSince: null, evidence, history: [{ state: 'intent', at, owner }], rev: 1 };
      assertActionRecord(record);
      const path = pathFor(record.resource, record.attempt);
      fs.mkdirSync(resourceDir(record.resource), { recursive: true });
      let fd;
      try { fd = fs.openSync(path, 'wx'); }
      catch (e) { if (e.code === 'EEXIST') return allocate(); throw new CoordinationUnavailableError(path, e); }
      try { io(path, () => { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); }); }
      finally { fs.closeSync(fd); }
      return { ok: true, record };
    };
    return io(dir, allocate);
  };
  const settle = (resource, attempt, { postconditionHolds, token, rev } = {}) => {
    const r = read(resource, attempt);
    if ((token && token !== r.ownerToken) || (rev !== undefined && rev !== r.rev)) return { ok: false, reason: 'owner-lost', record: r };
    if (r.state !== 'observed') return { ok: false, reason: 'wrong-state', record: r };
    const finish = (answer) => {
      const indeterminate = typeof answer !== 'boolean';
      if (answer !== true) return { ok: false, reason: indeterminate ? 'held:indeterminate'
        : milliseconds(now()) - (r.history.find((h) => h.state === 'observed')?.at ?? r.updatedAt) > maxObservedAgeMs ? 'stuck-observed' : 'held', record: r };
      return transition(resource, attempt, { token: r.ownerToken, rev: r.rev, from: 'observed', to: 'terminal', patch: { outcome: 'settled' } });
    };
    let answer;
    try { answer = postconditionHolds(r); } catch { return finish(undefined); }
    // Only reader failures become indeterminate; a failed terminal write must still surface.
    const checked = withResult(answer, (value) => value, () => undefined);
    return withResult(checked, finish);
  };
  return { dir, pathFor, read, attempts, list, claim, transition, heartbeat, reconcile, settle,
    release: (resource, attempt, { token, rev, from = 'intent', outcome = 'not-started' }) => transition(resource, attempt, { token, rev, from, to: 'terminal', patch: { outcome } }) };
}
