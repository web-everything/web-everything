/**
 * Card numbers at birth — design note.
 * Statute: docs/agent/platform-decisions.md#backlog-ids-numbered-before-publish
 * (#3732): the producer numbers before publish. This moves allocation to the
 * earliest point, creation; the drain's clash check still verifies uniqueness
 * where main is written and remains unchanged.
 * Share withNumberingLock's host-wide numbering lock so birth and existing
 * numbering serialize across clones. Never run unlocked; wait only briefly.
 * Under it, reserve above local cards, origin/main, host reservations and
 * remote reservation refs. Persist host reservations before releasing the lock.
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
import { execFileSync } from 'node:child_process';
import { withNumberingLock } from '../readiness/drain-lock.mjs';
import { readSettings } from './settings-files.mjs';

/** Feature-file settings with an explicit, loggable source. */
export function loadNumberAtBirthSettings({ file = readSettings(), env = process.env } = {}) {
  const configured = file?.numberAtBirth;
  const value = { enabled: 'on', remote: 'best-effort' };
  let source = 'default';
  if (['on', 'off'].includes(configured?.enabled)) {
    value.enabled = configured.enabled;
    source = 'settings file';
  }
  if (['best-effort', 'required'].includes(configured?.remote)) value.remote = configured.remote;
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
  cwd = process.cwd(), backlogDir = join(cwd, 'backlog'), settings = loadNumberAtBirthSettings(),
  statePath = join(homedir(), '.claude', 'card-number-reservations.json'),
  lockRoot, waitMs = 2000, log = console.warn, now = Date.now,
  git = (args, options = {}) => execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, ...options,
  }),
} = {}) {
  log(`number-at-birth: ${settings.value.enabled} (${settings.source}), remote=${settings.value.remote}`);
  if (settings.value.enabled === 'off') return { ok: false, reason: 'number-at-birth disabled' };
  try {
    const locked = withNumberingLock((heartbeat) => {
      mkdirSync(dirname(statePath), { recursive: true });
      let state = { highest: 0, reservations: [] };
      try { state = JSON.parse(readFileSync(statePath, 'utf8')); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      const entries = Array.isArray(state) ? state : state.reservations;
      if (!Array.isArray(entries) || entries.some((e) => !e || !Number.isSafeInteger(Number(e.num))
        || Number(e.num) < 1 || !Number.isFinite(Date.parse(e.timestamp)))
        || (!Array.isArray(state) && (!Number.isSafeInteger(state.highest) || state.highest < 0))) {
        throw new Error('invalid reservation state');
      }
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
      let candidate = maximum([...local, ...main, ...entries.map((e) => Number(e.num)), Number(state.highest || 0), ...remote]) + 1;
      const timestamp = new Date(now()).toISOString();
      const owner = `${hostname()}:${process.pid}:${randomUUID()}`;
      const persist = (num) => {
        const reservations = entries.filter((e) => !main.includes(Number(e.num))
          && Date.parse(e.timestamp) >= now() - 14 * 86400_000);
        reservations.push({ num, owner, timestamp });
        const temp = `${statePath}.${process.pid}.tmp`;
        writeFileSync(temp, JSON.stringify({ highest: num, reservations }, null, 2) + '\n', { mode: 0o600 });
        renameSync(temp, statePath);
      };
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
        persist(candidate);
        if (!remoteAvailable) log(`number-at-birth: host-only reservation ${num}; remote unavailable (best-effort)`);
        return { ok: true, num, source: settings.source };
      }
      throw new Error('remote reservation contention exhausted');
    }, { lockRoot, waitMs, pollMs: 25, runUnlockedOnContention: false });
    return locked.ran ? locked.result : { ok: false, reason: `numbering lock unavailable: ${locked.reason}` };
  } catch (e) { return { ok: false, reason: e.message }; }
}
