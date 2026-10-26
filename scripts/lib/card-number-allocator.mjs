/**
 * Birth numbering shares the drain mutex and burns gaps on failed publication.
 * Remote number + card-id blob refs are claimed atomically, create-only.
 * Unknown/incomplete remote evidence falls back to hashes; required mode refuses.
 * Statute: docs/agent/platform-decisions.md#backlog-ids-numbered-before-publish
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { withNumberingLock } from '../readiness/drain-lock.mjs';
import { HASH_RE } from '../backlog/id.mjs';
import { readSettings } from './settings-files.mjs';
import { platformPreference, resolveCascade, formatCascadeSourcesLine } from './policy-cascade.mjs';

export function loadNumberAtBirthSettings({ file = readSettings(), env = process.env,
  platform = platformPreference('backlog', { env }) } = {}) {
  const settings = resolveCascade({
    standard: { enabled: 'on', remote: 'best-effort' },
    platform: { enabled: platform?.cardNumbering?.numberAtBirth?.enabled, remote: platform?.cardNumbering?.remote },
    tool: { enabled: file?.backlog?.cardNumbering?.numberAtBirth?.enabled, remote: file?.backlog?.cardNumbering?.remote },
    envValues: { enabled: env.WE_NUMBER_AT_BIRTH, remote: env.WE_CARD_NUMBERING_REMOTE },
    valid: { enabled: (v) => ['on', 'off'].includes(v), remote: (v) => ['best-effort', 'required'].includes(v) },
  });
  return { ...settings, source: formatCascadeSourcesLine('backlog.cardNumbering', settings) };
}
const numericIds = (paths) => String(paths).split('\n').flatMap((p) => {
  const m = p.match(/^(?:backlog\/)?(\d+)-[^/]+\.md$/);
  return m ? [Number(m[1])] : [];
});
const maximum = (ids) => ids.reduce((max, n) => Number.isSafeInteger(n) ? Math.max(max, n) : max, 0);
const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// Empty is a complete empty listing; any nonempty listing must end in a newline.
function readRefs(output) {
  const text = String(output);
  if (text.length > 1024 * 1024) throw Error('oversized remote ref listing');
  if (text && !text.endsWith('\n')) throw Error('truncated remote ref listing');
  const refs = new Map();
  for (const line of text.split('\n').filter(Boolean)) {
    const m = line.match(/^([0-9a-f]{40}|[0-9a-f]{64})\t(refs\/(?:number-reservations\/[0-9]+|card-ids\/x[0-9a-z]{6}))$/);
    if (!m || refs.has(m[2])) throw Error('invalid remote ref listing');
    refs.set(m[2], m[1]);
  }
  return refs;
}

export function allocateCardNumber({
  id, cwd = process.cwd(), backlogDir = join(cwd, 'backlog'), settings = loadNumberAtBirthSettings(),
  statePath = join(homedir(), '.claude', 'card-number-reservations.json'),
  lockRoot, waitMs = 2000, log = console.warn, now = Date.now,
  git = (args, options = {}) => execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, ...options,
  }),
} = {}) {
  log(`number-at-birth: ${settings.value.enabled} (${settings.source}), remote=${settings.value.remote}`);
  if (settings.value.enabled === 'off') return { ok: false, reason: 'number-at-birth disabled' };
  try {
    if (typeof id !== 'string' || !HASH_RE.test(id)) throw Error('invalid card id: expected HASH_RE');
    const locked = withNumberingLock((heartbeat) => {
      mkdirSync(dirname(statePath), { recursive: true });
      let state = { highest: 0, reservations: [] };
      try { state = JSON.parse(readFileSync(statePath, 'utf8')); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      const entries = Array.isArray(state) ? state : state?.reservations;
      if (!Array.isArray(entries) || entries.some((e) => !e || !Number.isSafeInteger(Number(e.num))
        || Number(e.num) < 1 || !Number.isFinite(Date.parse(e.timestamp)))
        || (!Array.isArray(state) && (!Number.isSafeInteger(state.highest) || state.highest < 0))) {
        throw Error('invalid reservation state');
      }
      const local = numericIds(readdirSync(backlogDir).join('\n'));
      let main;
      try {
        git(['fetch', 'origin', 'main:refs/remotes/origin/main']);
        const paths = String(git(['ls-tree', '-r', '--name-only', 'origin/main', '--', 'backlog/']));
        if (paths && !paths.endsWith('\n')) throw Error('truncated backlog tree');
        main = numericIds(paths);
      } catch (e) { throw Error(`origin/main high-water mark unavailable: ${e.message}`); }
      const scan = () => readRefs(git(['ls-remote', 'origin', 'refs/number-reservations/*', 'refs/card-ids/*']));
      const idRef = `refs/card-ids/${id}`;
      const replay = (refs) => {
        const oid = refs.get(idRef);
        if (!oid) return null;
        git(['fetch', '--no-tags', 'origin', oid]);
        const raw = String(git(['cat-file', 'blob', oid], { maxBuffer: 4096 }));
        if (!raw.endsWith('\n') || raw.length > 4096) throw Error('truncated or oversized card-id blob');
        const claim = JSON.parse(raw);
        if (!claim || Object.keys(claim).sort().join(',') !== 'id,num,owner,timestamp' || claim.id !== id
          || typeof claim.num !== 'string' || !/^[0-9]{3,}$/.test(claim.num)
          || !Number.isSafeInteger(Number(claim.num)) || Number(claim.num) < 1
          || String(Number(claim.num)).padStart(3, '0') !== claim.num
          || typeof claim.owner !== 'string' || !claim.owner || typeof claim.timestamp !== 'string'
          || !Number.isFinite(Date.parse(claim.timestamp))
          || refs.get(`refs/number-reservations/${claim.num}`) !== oid) throw Error('invalid card-id reservation');
        return { ok: true, num: claim.num, source: settings.source };
      };
      let refs = scan();
      const existing = replay(refs);
      if (existing) return existing;
      let candidate = maximum([...local, ...main, ...entries.map((e) => Number(e.num)), Number(state.highest || 0),
        ...[...refs.keys()].filter((r) => r.startsWith('refs/number-reservations/')).map((r) => Number(r.split('/').at(-1)))]) + 1;
      const timestamp = new Date(now()).toISOString();
      const owner = `${hostname()}:${process.pid}:${randomUUID()}`;
      for (let attempt = 0; attempt < 100; attempt++, candidate++) {
        if (!Number.isSafeInteger(candidate)) throw Error('card number exhausted');
        const num = String(candidate).padStart(3, '0');
        const numRef = `refs/number-reservations/${num}`;
        const blob = String(git(['hash-object', '-w', '--stdin'], { input: JSON.stringify({ id, num, owner, timestamp }) + '\n' })).trim();
        if (!OID_RE.test(blob)) throw Error('invalid reservation object id');
        try {
          git(['push', '--atomic', `--force-with-lease=${numRef}:`, `--force-with-lease=${idRef}:`,
            'origin', `${blob}:${numRef}`, `${blob}:${idRef}`]);
        } catch (e) {
          refs = scan();
          const won = replay(refs);
          if (won) return won;
          if (!refs.has(numRef)) throw e;
          heartbeat();
          continue;
        }
        const reservations = entries.filter((e) => !main.includes(Number(e.num))
          && Date.parse(e.timestamp) >= now() - 14 * 86400_000);
        reservations.push({ num: candidate, id, owner, timestamp });
        const temp = `${statePath}.${process.pid}.tmp`;
        writeFileSync(temp, JSON.stringify({ highest: candidate, reservations }, null, 2) + '\n', { mode: 0o600 });
        renameSync(temp, statePath);
        return { ok: true, num, source: settings.source };
      }
      throw Error('remote reservation contention exhausted');
    }, { lockRoot, waitMs, pollMs: 25, runUnlockedOnContention: false });
    return locked.ran ? locked.result : { ok: false, required: settings.value.remote === 'required',
      reason: `numbering lock unavailable: ${locked.reason}` };
  } catch (e) { return { ok: false, required: settings.value.remote === 'required', reason: e.message }; }
}
