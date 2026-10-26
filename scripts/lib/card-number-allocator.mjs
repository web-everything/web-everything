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
import { HASH_RE, isNum } from '../backlog/id.mjs';
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
const numericIds = (paths) => paths.flatMap((p) => {
  const m = p.match(/^(?:backlog\/)?(\d+)-[^/]+\.md$/);
  if (m && (!Number.isSafeInteger(Number(m[1])) || Number(m[1]) > 99999)) throw Error('card number exhausted');
  return m ? [Number(m[1])] : [];
});
const maximum = (ids) => ids.reduce((max, n) => Number.isSafeInteger(n) ? Math.max(max, n) : max, 0);
const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// Permanent claims can contain two refs for every number through 99999. Even
// with 64-byte SHA-256 hex OIDs this is under 19 MiB; leave bounded headroom.
// This also fits a canonical backlog of 99999 filesystem-length card names.
const NUMBERING_EVIDENCE_MAX_BYTES = 32 * 1024 * 1024;
// Empty is a complete empty listing; any nonempty listing must end in a newline.
function readRefs(output) {
  const text = String(output);
  if (Buffer.byteLength(text) > NUMBERING_EVIDENCE_MAX_BYTES) throw Error('oversized remote ref listing');
  if (text && !text.endsWith('\n')) throw Error('truncated remote ref listing');
  const refs = new Map();
  for (const line of text.split('\n').filter(Boolean)) {
    const m = line.match(/^([0-9a-f]{40}|[0-9a-f]{64})\t(refs\/(?:number-reservations\/[0-9]+|card-ids\/x[0-9a-z]{6}))$/);
    if (!m || refs.has(m[2])) throw Error('invalid remote ref listing');
    if (m[2].startsWith('refs/number-reservations/')) {
      const num = m[2].split('/').at(-1);
      if (!isNum(num) || Number(num) < 1 || String(Number(num)).padStart(3, '0') !== num)
        throw Error('invalid reservation number');
    }
    refs.set(m[2], m[1]);
  }
  return refs;
}

function readRemoteRefs(git, remote = 'origin') {
  return readRefs(git(['ls-remote', remote, 'refs/number-reservations/*', 'refs/card-ids/*'],
    { maxBuffer: NUMBERING_EVIDENCE_MAX_BYTES }));
}

/** Read complete canonical paths and immutable claims; shared by every numeric writer.
 * Leave tracking refs alone by default: a caller may already have merged their trees.
 * Deferred numbering explicitly refreshes tracking before its separate bornAs reads.
 */
export function readNumberingEvidence(git, remote = 'origin', { refreshTracking = false } = {}) {
  let main;
  const snapshotRef = `refs/tmp/numbering-${process.pid}-${randomUUID()}`;
  try {
    try {
      // Neither FETCH_HEAD nor a tracking ref is private to this reader. Keep
      // the fetched tree pinned until ls-tree finishes, even across interleaved
      // reads. An empty refmap disables opportunistic tracking-ref updates.
      git(['fetch', '--no-tags', '--no-write-fetch-head', '--refmap=', remote,
        `refs/heads/main:${snapshotRef}`,
        ...(refreshTracking ? [`main:refs/remotes/${remote}/main`] : [])]);
      const paths = String(git(['ls-tree', '-r', '--name-only', '-z', snapshotRef, '--', 'backlog/'],
        { maxBuffer: NUMBERING_EVIDENCE_MAX_BYTES }));
      if (Buffer.byteLength(paths) > NUMBERING_EVIDENCE_MAX_BYTES) throw Error('oversized backlog tree');
      if (paths && !paths.endsWith('\0')) throw Error('truncated backlog tree');
      main = numericIds(paths.split('\0').filter(Boolean));
    } finally {
      git(['update-ref', '-d', snapshotRef]);
    }
  } catch (e) { throw Error(`${remote}/main high-water mark unavailable: ${e.message}`); }
  const refs = readRemoteRefs(git, remote);
  return { main, refs };
}

/** Atomic reservation also used for deferred numbering, independently of the birth setting.
 * No host mutex/state here: the remote create-only transaction arbitrates across hosts.
 */
export function reserveCardNumber({ id, git, minimum = 1, dryRun = false, now = Date.now,
  heartbeat = () => {}, evidence }) {
  if (typeof id !== 'string' || !HASH_RE.test(id)) throw Error('invalid card id: expected HASH_RE');
  evidence ??= readNumberingEvidence(git);
  const { main } = evidence;
  const scan = () => readRemoteRefs(git);
  const idRef = `refs/card-ids/${id}`;
  const replay = (refs) => {
    const oid = refs.get(idRef);
    if (!oid) return null;
    git(['fetch', '--no-tags', 'origin', oid]);
    const raw = String(git(['cat-file', 'blob', oid], { maxBuffer: 4096 }));
    if (!raw.endsWith('\n') || raw.length > 4096) throw Error('truncated or oversized card-id blob');
    const claim = JSON.parse(raw);
    if (!claim || Object.keys(claim).sort().join(',') !== 'id,num,owner,timestamp' || claim.id !== id
      || typeof claim.num !== 'string' || !isNum(claim.num)
      || Number(claim.num) < 1 || String(Number(claim.num)).padStart(3, '0') !== claim.num
      || typeof claim.owner !== 'string' || !claim.owner || typeof claim.timestamp !== 'string'
      || !Number.isFinite(Date.parse(claim.timestamp))
      || refs.get(`refs/number-reservations/${claim.num}`) !== oid) throw Error('invalid card-id reservation');
    return claim.num;
  };
  let refs = evidence.refs;
  const existing = replay(refs);
  if (existing) return existing;
  let candidate = Math.max(minimum, maximum([...main,
    ...[...refs.keys()].filter((r) => r.startsWith('refs/number-reservations/')).map((r) => Number(r.split('/').at(-1)))]) + 1);
  const timestamp = new Date(now()).toISOString();
  const owner = `${hostname()}:${process.pid}:${randomUUID()}`;
  for (let attempt = 0; attempt < 100; attempt++, candidate++) {
    if (!Number.isSafeInteger(candidate) || candidate < 1 || !isNum(String(candidate))) throw Error('card number exhausted');
    const num = String(candidate).padStart(3, '0');
    if (dryRun) return num;
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
    return num;
  }
  throw Error('remote reservation contention exhausted');
}

/** Healers plan gaps below a durable frontier and must claim them before applying the plan.
 * A repository with no remote is local-only; unreadable/configured remotes never degrade to that case.
 */
export function collisionNumberingConstraints(git, remote = 'origin') {
  const remotes = String(git(['remote'])).trim().split('\n').filter(Boolean);
  if (!remotes.length) return {};
  if (!remotes.includes(remote)) throw Error(`number reservation remote ${remote} unavailable`);
  const { main, refs } = readNumberingEvidence(git, remote);
  const reservedNums = [...refs.keys()].filter((r) => r.startsWith('refs/number-reservations/')).map((r) => r.split('/').at(-1));
  return { reservedNums, canonicalNums: main.map(String), ceiling: maximum([...main, ...reservedNums.map(Number)]), reservationRemote: remote };
}

/** Claim every heal target before rewriting anything. Even a stale birth allocator or another
 * healer must lose the create-only race. A failed/crashed heal burns its claims; it never frees them.
 * Legacy heals have no birth identity, so these claims deliberately create no card-ids alias.
 */
export function reserveCollisionNumbers(plan, git, remote) {
  if (!remote || !plan.collisions.length) return;
  const nums = plan.collisions.map((move) => move.newNum);
  if (new Set(nums).size !== nums.length || nums.some((num) => !isNum(num) || Number(num) < 1
    || String(Number(num)).padStart(3, '0') !== num)) throw Error('invalid collision reservation numbers');
  const blob = String(git(['hash-object', '-w', '--stdin'], { input: JSON.stringify({
    kind: 'collision-heal', moves: plan.collisions, owner: `${hostname()}:${process.pid}:${randomUUID()}`,
    timestamp: new Date().toISOString(),
  }) + '\n' })).trim();
  if (!OID_RE.test(blob)) throw Error('invalid reservation object id');
  const refs = nums.map((num) => `refs/number-reservations/${num}`);
  git(['push', '--atomic', ...refs.map((ref) => `--force-with-lease=${ref}:`), remote, ...refs.map((ref) => `${blob}:${ref}`)]);
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
      const local = numericIds(readdirSync(backlogDir));
      const evidence = readNumberingEvidence(git);
      const num = reserveCardNumber({ id, git, now, heartbeat, evidence,
        minimum: maximum([...local, ...entries.map((e) => Number(e.num)), Number(state.highest || 0)]) + 1 });
      if (evidence.refs.has(`refs/card-ids/${id}`)) return { ok: true, num, source: settings.source };
      const reservations = entries.filter((e) => !evidence.main.includes(Number(e.num))
        && Date.parse(e.timestamp) >= now() - 14 * 86400_000);
      if (!reservations.some((e) => e.id === id)) reservations.push({ num: Number(num), id, timestamp: new Date(now()).toISOString() });
      const temp = `${statePath}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify({ highest: Math.max(Number(state.highest || 0), Number(num)), reservations }, null, 2) + '\n', { mode: 0o600 });
      renameSync(temp, statePath);
      return { ok: true, num, source: settings.source };
    }, { lockRoot, waitMs, pollMs: 25, runUnlockedOnContention: false });
    return locked.ran ? locked.result : { ok: false, required: settings.value.remote === 'required',
      reason: `numbering lock unavailable: ${locked.reason}` };
  } catch (e) { return { ok: false, required: settings.value.remote === 'required', reason: e.message }; }
}
