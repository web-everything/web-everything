/**
 * Card numbers at birth — design note.
 * Statute: docs/agent/platform-decisions.md#backlog-ids-numbered-before-publish
 * ("producer-at-pr-open"): numbering at creation satisfies this with a durable
 * id->number record; the drain's clash check still verifies uniqueness
 * where main is written and remains unchanged.
 * Share withNumberingLock's host-wide numbering lock so birth and existing
 * numbering serialize across clones. Never run unlocked; wait only briefly.
 * Under it, reserve above local cards, origin/main, host reservations and
 * remote reservation refs. Persist host reservations before releasing the lock.
 * Keep the small host id->number map forever so replay survives reservation pruning.
 * An id->number binding is immutable. Every replay verifies ownership and card
 * availability; any doubt fails closed in both modes. Missing claims heal create-only.
 * Remote refs are immutable claims: create-only pushes of owner/time blobs,
 * never force. A rejected claim is skipped; required remote outages fail closed.
 * Best-effort remote outages retain host safety and are logged explicitly.
 * Any allocation failure returns ok:false, letting producers use legacy hashes.
 * Numeric cards retain a fresh hash solely as bornAs; their references use NNN.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { readGit } from './proc-read.mjs';
import { withNumberingLock } from '../readiness/drain-lock.mjs';
import { isHash } from '../backlog/id.mjs';
import { readSettings } from './settings-files.mjs';

/** Feature-file settings with an explicit, loggable source. */
export function loadNumberAtBirthSettings({ file = readSettings(), env = process.env } = {}) {
  const configured = file?.backlog?.cardNumbering;
  const value = { enabled: 'on', remote: 'required' };
  let source = 'default';
  if (['on', 'off'].includes(configured?.atBirth)) {
    value.enabled = configured.atBirth;
    source = 'settings file';
  }
  if (['best-effort', 'required'].includes(configured?.atBirthRemote)) {
    value.remote = configured.atBirthRemote;
    source = 'settings file';
  }
  if (['on', 'off'].includes(env.WE_NUMBER_AT_BIRTH)) {
    value.enabled = env.WE_NUMBER_AT_BIRTH;
    source = 'env WE_NUMBER_AT_BIRTH';
  }
  return { value, source };
}

const numericIds = (paths) => String(paths).split('\n').flatMap((p) => {
  const m = p.match(/^(?:backlog\/)?(\d+)-[^/]+\.md$/);
  return m ? [Number(m[1])] : [];
});
const remoteIds = (output) => String(output).split('\n').flatMap((line) => {
  const m = line.match(/\srefs\/number-reservations\/(\d+)$/);
  return m ? [Number(m[1])] : [];
});
const maximum = (ids) => ids.reduce((max, n) => Number.isSafeInteger(n) ? Math.max(max, n) : max, 0);

/** Synchronous IO boundary; all exceptions fail closed to the producer's hash path. */
export function allocateCardNumber({
  id, cwd = process.cwd(), backlogDir = join(cwd, 'backlog'), settings,
  statePath = join(homedir(), '.claude', 'card-number-reservations.json'),
  lockRoot, waitMs = 2000, log = () => {}, now = Date.now,
  git = (args, options = {}) => readGit(args, {
    cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, ...options,
  }),
} = {}) {
  try {
    settings ??= loadNumberAtBirthSettings();
    log(`backlog.cardNumbering.atBirth: ${settings.value.enabled} (${settings.source}), remote=${settings.value.remote}`);
    if (!isHash(id)) return { ok: false, reason: 'invalid birth id' };
    if (settings.value.enabled === 'off') return { ok: false, reason: 'number-at-birth disabled' };
    const locked = withNumberingLock((heartbeat) => {
      mkdirSync(dirname(statePath), { recursive: true });
      let state = { highest: 0, reservations: [] };
      try { state = JSON.parse(readFileSync(statePath, 'utf8')); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      let entries = Array.isArray(state) ? state : state.reservations;
      if (!Array.isArray(entries) || entries.some((e) => !e || !Number.isSafeInteger(Number(e.num))
        || Number(e.num) < 1 || !Number.isFinite(Date.parse(e.timestamp)))
        || (!Array.isArray(state) && (!Number.isSafeInteger(state.highest) || state.highest < 0))) {
        throw new Error('invalid reservation state');
      }
      const ids = state.ids === undefined ? {} : state.ids;
      const validNum = (num) => /^\d+$/.test(String(num)) && Number.isSafeInteger(Number(num)) && Number(num) > 0;
      const format = (num) => String(Number(num)).padStart(3, '0');
      if (!ids || typeof ids !== 'object' || Array.isArray(ids)
        || Object.entries(ids).some(([key, num]) => !isHash(key) || !validNum(num))
        || new Set(Object.values(ids).map(Number)).size !== Object.keys(ids).length) {
        throw new Error('invalid id mapping state');
      }
      const bind = (num) => {
        if ((ids[id] !== undefined && Number(ids[id]) !== Number(num))
          || Object.entries(ids).some(([key, value]) => key !== id && Number(value) === Number(num))) {
          throw new Error('conflicting id mapping');
        }
        ids[id] = format(num);
      };
      const local = numericIds(readdirSync(backlogDir).join('\n'));
      try { git(['fetch', 'origin', 'main:refs/remotes/origin/main']); } catch { /* cached main remains usable */ }
      heartbeat();
      let main = [];
      try { main = numericIds(git(['ls-tree', '-r', '--name-only', 'origin/main', '--', 'backlog/'])); }
      catch { log('number-at-birth: origin/main unavailable; using local cards and reservations'); }
      let remote = [];
      let remoteAvailable = true;
      try { remote = remoteIds(git(['ls-remote', 'origin', 'refs/number-reservations/*'])); }
      catch (e) {
        if (settings.value.remote === 'required') throw new Error(`remote reservations unreachable: ${e.message}`);
        remoteAvailable = false;
      }
      // Fetch the object explicitly: ls-remote only advertises its oid, not its contents.
      const readRemoteBlob = (ref) => {
        const lines = String(git(['ls-remote', 'origin', ref])).trim().split('\n');
        const match = lines.map((line) => line.split(/\s+/)).find(([, name]) => name === ref);
        if (!match) return null;
        git(['fetch', 'origin', ref]);
        const blob = JSON.parse(git(['cat-file', 'blob', match[0]]));
        if (!blob || typeof blob !== 'object' || Array.isArray(blob)) throw new Error('invalid remote record');
        return blob;
      };
      const readRemoteId = () => {
        const row = readRemoteBlob(`refs/card-ids/${id}`);
        if (row === null) return null;
        if (!row || row.id !== id || !validNum(row.num) || row.source !== 'birth'
          || typeof row.by !== 'string' || !row.by.trim() || !Number.isFinite(Date.parse(row.at))) {
          throw new Error('invalid remote id record');
        }
        return { ...row, num: format(row.num) };
      };
      let candidate = maximum([...local, ...main, ...entries.map((e) => Number(e.num)),
        ...Object.values(ids).map(Number), Number(state.highest || 0), ...remote]) + 1;
      const timestamp = new Date(now()).toISOString();
      const owner = `${hostname()}:${process.pid}:${randomUUID()}`;
      const persist = (num, reserve = true, reservationOwner = owner, hostOnly = false) => {
        const reservations = entries.filter((e) => !main.includes(Number(e.num))
          && Date.parse(e.timestamp) >= now() - 14 * 86400_000
          && (!reserve || Number(e.num) !== Number(num)));
        if (reserve) reservations.push({ num, owner: reservationOwner, timestamp, hostOnly });
        const temp = `${statePath}.${process.pid}.tmp`;
        const saved = { highest: maximum([Number(state.highest || 0), num, ...Object.values(ids).map(Number)]), reservations, ids };
        writeFileSync(temp, JSON.stringify(saved, null, 2) + '\n', { mode: 0o600 });
        renameSync(temp, statePath);
        state = saved;
        entries = reservations;
      };
      const replay = (num, record = null) => {
        num = format(num);
        // Validate the immutable binding before any remote or host mutation.
        if ((ids[id] !== undefined && Number(ids[id]) !== Number(num))
          || Object.entries(ids).some(([key, value]) => key !== id && Number(value) === Number(num))) {
          throw new Error('conflicting id mapping');
        }
        if (local.includes(Number(num)) || main.includes(Number(num))) {
          throw new Error(`card number ${num} is already used locally or on origin/main`);
        }
        const claims = entries.filter((e) => Number(e.num) === Number(num));
        if (claims.length > 1) throw new Error('conflicting host reservations');
        const claim = claims[0];
        if (!remoteAvailable) {
          // Only explicitly host-only bindings with no recorded remote evidence may
          // replay offline in best-effort mode. Legacy/unmarked bindings fail closed.
          if (claim?.hostOnly !== true || settings.value.remote !== 'best-effort') {
            throw new Error('remote unavailable to verify replay');
          }
          bind(num);
          persist(Number(num), true, claim.owner, true);
          return { ok: true, num, replayed: true, source: settings.source };
        }
        const claimOwner = claim?.owner ?? record?.by;
        if (typeof claimOwner !== 'string' || !claimOwner.trim()
          || (record && record.by !== claimOwner)) throw new Error('conflicting or missing allocation owner');
        let reservation = readRemoteBlob(`refs/number-reservations/${num}`);
        if (reservation === null) {
          const blob = String(git(['hash-object', '-w', '--stdin'], {
            input: JSON.stringify({ owner: claimOwner, timestamp, num }),
          })).trim();
          // Failure to create is doubt, even if a competing claim now exists.
          git(['push', 'origin', `${blob}:refs/number-reservations/${num}`]);
          reservation = readRemoteBlob(`refs/number-reservations/${num}`);
        }
        if (!reservation || reservation.owner !== claimOwner || !validNum(reservation.num)
          || Number(reservation.num) !== Number(num)
          || (reservation.id !== undefined && reservation.id !== id)) {
          throw new Error(`remote reservation ${num} belongs to another owner/id or is malformed`);
        }
        if (!record) {
          const recorded = publishId(num, claimOwner);
          if (recorded && (recorded.num !== num || recorded.by !== claimOwner)) {
            throw new Error('conflicting remote id record');
          }
        }
        bind(num);
        persist(Number(num), true, claimOwner);
        return { ok: true, num, replayed: true, source: settings.source };
      };
      const publishId = (num, by = owner) => {
        try {
          const row = { id, num, by, at: timestamp, source: 'birth' };
          const blob = String(git(['hash-object', '-w', '--stdin'], { input: JSON.stringify(row) })).trim();
          git(['push', 'origin', `${blob}:refs/card-ids/${id}`]);
        } catch (e) {
          log(`number-at-birth: burned reservation ${num}; id record push failed`);
          const recorded = readRemoteId();
          if (recorded !== null) return recorded;
          throw new Error(`remote id record failed: ${e.message}`);
        }
        return null;
      };
      if (remoteAvailable && ids[id] !== undefined) {
        const claim = entries.find((e) => Number(e.num) === Number(ids[id]));
        // Retire the offline exception before probing: even a failed reconnect
        // can reveal remote evidence or create a claim before a later IO failure.
        if (claim?.hostOnly === true) persist(Number(ids[id]), true, claim.owner);
      }
      if (remoteAvailable) {
        const recorded = readRemoteId();
        if (recorded !== null) return replay(recorded.num, recorded);
      }
      if (ids[id] !== undefined) return replay(ids[id]);
      // Bound adversarial contention; never hand back a speculative number.
      for (let attempt = 0; attempt < 100; attempt++, candidate++) {
        if (!Number.isSafeInteger(candidate)) throw new Error('card number exhausted');
        const num = String(candidate).padStart(3, '0');
        if (remoteAvailable) {
          try {
            const blob = String(git(['hash-object', '-w', '--stdin'], { input: JSON.stringify({ owner, timestamp, num }) })).trim();
            git(['push', 'origin', `${blob}:refs/number-reservations/${num}`]);
          } catch (e) {
            // Normal pushes cannot replace a blob ref. Confirm a clash before retrying;
            // an unconfirmed failure is an outage, never permission to steal the ref.
            let taken;
            try { taken = remoteIds(git(['ls-remote', 'origin', 'refs/number-reservations/*'])); }
            catch { taken = null; }
            if (taken?.includes(candidate)) { candidate = Math.max(candidate, maximum(taken)); heartbeat(); continue; }
            if (settings.value.remote === 'required') throw new Error(`remote reservation failed: ${e.message}`);
            remoteAvailable = false;
          }
        }
        // Save the claim even if the following id publication fails: it is a burned gap.
        persist(candidate, true, owner, !remoteAvailable);
        if (remoteAvailable) {
          const recorded = publishId(num);
          if (recorded !== null) return replay(recorded.num, recorded);
        }
        bind(num);
        persist(candidate, false);
        if (!remoteAvailable) log(`number-at-birth: host-only reservation ${num}; remote unavailable (best-effort)`);
        return { ok: true, num, source: settings.source };
      }
      throw new Error('remote reservation contention exhausted');
    }, { lockRoot, waitMs, pollMs: 25, runUnlockedOnContention: false });
    return locked.ran ? locked.result : { ok: false, reason: `numbering lock unavailable: ${locked.reason}` };
  } catch (e) { return { ok: false, reason: e.message }; }
}
