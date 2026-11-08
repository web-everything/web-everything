/** Append-only per-repository card numbers (#6121). Readers fail closed; shadow callers may warn. */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { withNumberingLock } from '../readiness/drain-lock.mjs';
import { HASH_RE } from '../backlog/id.mjs';
import { resolveCardNumbering } from './policy-cascade.mjs';
import { assertPushRef, readFromTransportBranch, stageOnTransportBranch, verifySignedTransportCommit } from './git-transport-branch.mjs';
export const CARD_LEDGER_BRANCH = 'ops/card-numbers';
export const CARD_LEDGER_REF = 'refs/heads/ops/card-numbers';
export const CARD_LEDGER_TRUST_PATH = 'scripts/settings/card-ledger-trust.json';
export const CARD_LEDGER_MAX_BYTES = 8 * 1024 * 1024;
export const CARD_LEDGER_HISTORY_BUDGET = 256;
const sha = s => typeof s === 'string' && /^[a-f0-9]{40}$/.test(s) && s.length === 40;
const hash = s => createHash('sha256').update(s).digest('hex');
const validId = s => typeof s === 'string' && s.length === 7 && HASH_RE.test(s);
const validNum = n => Number.isInteger(n) && n > 0 && n < 100000;
const validCap = n => Number.isSafeInteger(n) && n > 0 && n <= 64 * 1024 * 1024;
const failure = e => String(e?.message || e).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 500);
export function cardLedgerPath(repo) {
  if (typeof repo !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(repo) || repo.endsWith('\n')) throw new Error('invalid card ledger repo');
  return `card-numbers/${repo}.jsonl`;
}
export function cardLedgerBase({ env = process.env, base } = {}) {
  if (base) { if (base !== 'origin/main' && !sha(base)) throw new Error('invalid trusted ledger base'); return base; }
  if (env.GITHUB_EVENT_NAME === 'merge_group') {
    // GITHUB_EVENT_PATH is the authoritative merge_group payload, never the checked tree.
    if (!env.GITHUB_EVENT_PATH) throw new Error('missing merge_group base evidence');
    const event = JSON.parse(readEvent(env.GITHUB_EVENT_PATH));
    if (!sha(event?.merge_group?.base_sha)) throw new Error('invalid merge_group base sha');
    return event.merge_group.base_sha;
  }
  return 'origin/main';
}
const readEvent = path => readFileSync(path, 'utf8');
function defaultRun(args, opts = {}) {
  if (args.includes('verify-commit')) {
    const r = spawnSync('git', args, { encoding: 'utf8', timeout: 15000, maxBuffer: 65536, ...opts });
    if (r.error || r.status !== 0) throw new Error('commit signature verification failed');
    return r.stdout + r.stderr;
  }
  return execFileSync('git', args, { encoding: 'utf8', stdio: 'pipe', timeout: 15000, maxBuffer: 65536, ...opts });
}
/** Resolve immutable blob size first; never full-buffer an oversized file. */
export function sizedCardLedgerRun({ maxBytes = CARD_LEDGER_MAX_BYTES, exec = defaultRun } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024) throw new Error('invalid ledger read cap');
  return (args, opts = {}) => {
    if (args[0] !== 'show' || args.length !== 2) return exec(args, { maxBuffer: 65536, timeout: 15000, ...opts });
    const oid = String(exec(['rev-parse', '--verify', args[1]], opts)).trim();
    if (!sha(oid)) throw new Error('missing ledger blob');
    const size = Number(String(exec(['cat-file', '-s', oid], opts)).trim());
    if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) throw new Error(`ledger exceeds read cap ${maxBytes}; raise readMaxBytes after review`);
    const text = String(exec(['cat-file', 'blob', oid], { ...opts, maxBuffer: Math.min(size + 1, maxBytes + 1) }));
    if (Buffer.byteLength(text) !== size) throw new Error('truncated ledger blob');
    return text;
  };
}
function validRow(r) {
  return r && typeof r === 'object' && !Array.isArray(r)
    && Object.keys(r).sort().join(',') === 'at,by,id,kind,num,pr'
    && validId(r.id) && validNum(r.num) && r.by === 'drain'
    && ['assign', 'seed', 'shadow'].includes(r.kind)
    && (r.pr === null || (Number.isSafeInteger(r.pr) && r.pr > 0))
    && typeof r.at === 'string' && /^\d{4}-\d\d-\d\dT/.test(r.at) && Number.isFinite(Date.parse(r.at));
}
function decode(text, maxBytes) {
  const rows = [], errors = [];
  if (typeof text !== 'string') return { rows, errors: ['missing ledger'] };
  if (Buffer.byteLength(text) > maxBytes) return { rows, errors: ['ledger exceeds read cap; raise readMaxBytes after review'] };
  const parts = text.split('\n');
  if (parts.pop() !== '') errors.push('partial final ledger line');
  for (const [i, line] of parts.entries()) {
    try { const row = JSON.parse(line); if (!validRow(row)) throw new Error(); rows.push(row); }
    catch { errors.push(`invalid ledger row ${i + 1}`); }
  }
  return { rows, errors };
}
function indexRows(rows, errors = [], burned = new Set()) {
  const byId = new Map(), byNum = new Map(), conflicts = [];
  for (const r of rows) {
    if ((byId.has(r.id) && byId.get(r.id) !== r.num) || (byNum.has(r.num) && byNum.get(r.num) !== r.id)) {
      conflicts.push({ id: r.id, num: r.num }); continue;
    }
    byId.set(r.id, r.num); byNum.set(r.num, r.id);
  }
  for (const n of byNum.keys()) burned.delete(n);
  return { byId, byNum, conflicts, readable: !errors.length && !conflicts.length, errors, burned };
}
export function parseCardLedger(text, { maxBytes = CARD_LEDGER_MAX_BYTES } = {}) {
  const { rows, errors } = decode(text, maxBytes);
  return { ...indexRows(rows, errors), text };
}
function validateTrust(root) {
  if (!root || !Array.isArray(root.allowedSigners) || !root.allowedSigners.length || !Array.isArray(root.quarantine)) throw new Error('missing or invalid ledger trust root; review signing bootstrap on main');
  const keys = new Set();
  for (const s of root.allowedSigners) {
    if (!s || (typeof s.key !== 'string' || /[\r\n]/.test(s.key) || !/^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/]+={0,3}(?: [\x20-\x7e]+)?$/.test(s.key)) || !/^SHA256:[A-Za-z0-9+/]+$/.test(s.fingerprint)
      || (s.revoked !== undefined && typeof s.revoked !== 'boolean') || keys.has(s.fingerprint)) throw new Error('invalid allowed signer');
    keys.add(s.fingerprint);
  }
  if (root.checkpoint !== undefined && (!sha(root.checkpoint?.commit) || !/^[a-f0-9]{64}$/.test(root.checkpoint?.fileSha256))) throw new Error('invalid ledger checkpoint');
  if (root.checkpoint) {
    const { quarantinedLines, quarantinedCommits } = root.checkpoint;
    const legacy = quarantinedLines === undefined && quarantinedCommits === undefined;
    if (legacy && root.quarantine.length) throw new Error('checkpoint lacks quarantine metadata; rebuild reviewed checkpoint from earlier history');
    if (!legacy && (!Array.isArray(quarantinedLines) || !Array.isArray(quarantinedCommits)
      || quarantinedLines.some((n, i) => !Number.isSafeInteger(n) || n < 1 || (i > 0 && n <= quarantinedLines[i - 1]))
      || quarantinedCommits.some(c => !sha(c)) || new Set(quarantinedCommits).size !== quarantinedCommits.length
      || (quarantinedLines.length > 0 && quarantinedCommits.length === 0))) throw new Error('invalid checkpoint quarantine metadata; rebuild reviewed checkpoint');
  }
  const seen = new Set();
  for (const q of root.quarantine) {
    if (!sha(q?.commit) || typeof q.reason !== 'string' || !q.reason.trim() || typeof q.approval !== 'string' || !q.approval.trim() || seen.has(q.commit)) throw new Error('invalid ledger quarantine');
    seen.add(q.commit);
  }
  return root;
}
/** Authentication is conditional on ledgerAuth=signed. No downstream reader consumes this yet. */
export function readCardLedger(o = {}) {
  const { repo, board = process.cwd(), env = process.env, verify = verifySignedTransportCommit } = o;
  const path = cardLedgerPath(repo);
  const policy = resolveCardNumbering({ env });
  const auth = o.ledgerAuth ?? policy.value.ledgerAuth;
  const maxBytes = o.maxBytes ?? policy.value.readMaxBytes;
  const historyBudget = o.historyBudget ?? policy.value.historyBudget;
  const run = o.run || sizedCardLedgerRun({ maxBytes });
  const opts = { cwd: board, maxBuffer: maxBytes + 1, timeout: 15000 };
  const trusted = [], errors = [], burned = new Set(), quarantinedLines = [], quarantinedCommits = new Set();
  let text, trust;
  try {
    if (!validCap(maxBytes)) throw new Error('invalid ledger read cap');
    if (!['none', 'signed'].includes(auth)) throw new Error('invalid ledgerAuth');
    if (!Number.isSafeInteger(historyBudget) || historyBudget < 1 || historyBudget > 4096) throw new Error('invalid history budget');
    text = Object.hasOwn(o, 'existing') ? o.existing : readFromTransportBranch({ board, branch: CARD_LEDGER_BRANCH, paths: [path], run, env, fresh: true })[path];
    if (text === null || text === undefined) throw new Error('missing ledger');
    if (Buffer.byteLength(text) > maxBytes) throw new Error('ledger exceeds read cap');
    if (auth === 'none') return parseCardLedger(text, { maxBytes });
    if (text && !text.endsWith('\n')) errors.push('partial final ledger line');
    const base = cardLedgerBase(o);
    trust = validateTrust(JSON.parse(run(['show', `${base}:${CARD_LEDGER_TRUST_PATH}`], opts)));
    if (String(run(['rev-parse', '--is-shallow-repository'], opts)).trim() !== 'false') throw new Error('missing/shallow introducing history');
    const tip = o.tip || `origin/${CARD_LEDGER_BRANCH}`;
    let previous = '';
    if (trust.checkpoint) {
      run(['merge-base', '--is-ancestor', trust.checkpoint.commit, tip], opts);
      previous = String(run(['show', `${trust.checkpoint.commit}:${path}`], opts));
      if (hash(previous) !== trust.checkpoint.fileSha256) throw new Error('checkpoint hash mismatch');
      const excluded = new Set(trust.checkpoint.quarantinedLines || []);
      const parts = previous.split('\n');
      if (parts.pop() !== '') throw new Error('partial final checkpoint line');
      if ([...excluded].some(n => n > parts.length)) throw new Error('checkpoint quarantine line outside file; rebuild reviewed checkpoint');
      const retained = [], removed = [];
      parts.forEach((line, i) => (excluded.has(i + 1) ? removed : retained).push(line + '\n'));
      for (const row of decode(removed.join(''), maxBytes).rows) burned.add(row.num);
      const parsed = decode(retained.join(''), maxBytes); errors.push(...parsed.errors); trusted.push(...parsed.rows);
      quarantinedLines.push(...excluded);
      for (const commit of trust.checkpoint.quarantinedCommits || []) quarantinedCommits.add(commit);
    }
    const range = trust.checkpoint ? `${trust.checkpoint.commit}..${tip}` : tip;
    const commits = String(run(['rev-list', '--full-history', '--topo-order', '--parents', `--max-count=${historyBudget + 1}`, range, '--', path], { ...opts, maxBuffer: (historyBudget + 1) * 128 })).trim().split('\n').filter(Boolean).reverse();
    if (commits.length > historyBudget) throw new Error('ledger history budget exceeded; advance reviewed checkpoint');
    for (const entry of commits) {
      const [commit, ...parents] = entry.split(' ');
      if (parents.length > 1) throw new Error('merged ledger history requires reviewed checkpoint');
      if (!sha(commit)) throw new Error('missing introducing history');
      const next = String(run(['show', `${commit}:${path}`], opts));
      if (!next.startsWith(previous)) throw new Error('append-only violation: ledger row removal/replacement');
      // Per-commit parsing must see the same physical lines as the checkpoint/whole-file reader:
      // an append onto a partial line would be judged apart from the bytes it completes.
      if (previous && !previous.endsWith('\n')) throw new Error('ledger commit boundary splits a row; rebuild reviewed checkpoint from earlier history');
      const firstLine = previous.split('\n').length;
      const added = next.slice(previous.length); previous = next;
      const parsed = decode(added, maxBytes);
      if (trust.quarantine.some(q => q.commit === commit)) {
        quarantinedCommits.add(commit);
        const count = added.split('\n').length - 1;
        for (let i = 0; i < count; i++) quarantinedLines.push(firstLine + i);
        for (const row of parsed.rows) burned.add(row.num);
        continue;
      }
      errors.push(...parsed.errors);
      try {
        const allowedSigners = trust.allowedSigners.filter(s => !s.revoked);
        const fingerprint = verify({ run: o.run ? run : undefined, cwd: board, commit, allowedSigners });
        if (!allowedSigners.some(s => s.fingerprint === fingerprint)) throw new Error('untrusted or revoked signer');
        trusted.push(...parsed.rows);
      } catch (e) { errors.push(`${commit}: ${failure(e)}`); }
    }
    if (previous !== text) throw new Error('missing introducing history or tip mismatch');
    if (trust.checkpoint && trust.quarantine.some(q => !quarantinedCommits.has(q.commit))) {
      throw new Error('quarantined introducer hidden by checkpoint; rebuild reviewed checkpoint from earlier history');
    }
  } catch (e) { errors.push(failure(e)); }
  return { ...indexRows(trusted, errors, burned), text, trust, quarantinedLines, quarantinedCommits: [...quarantinedCommits] };
}
export function numericCardFloor(files) {
  let max = 0;
  for (const file of files) { const m = /^backlog\/(\d{1,5})-[^/]+\.md$/.exec(file); if (m) max = Math.max(max, Number(m[1])); }
  return max;
}
function locked(o, fn) {
  if (o.lockHeld) return fn();
  const result = (o.lock || withNumberingLock)(fn, { runUnlockedOnContention: false });
  if (!result.ran) throw new Error('numbering mutex refused; retry next pass');
  return result.result;
}
function requireReadable(state) {
  if (!state?.readable) throw new Error(`unreadable card ledger: ${state?.errors?.join('; ') || 'conflicts'}; repair ledger or advance reviewed checkpoint`);
}
/** Public fixed-row append (seed/shadow); allocation is always computed in content on the fetched tip. */
export function appendCardLedgerRows(o = {}) {
  const { repo, board = process.cwd(), rows = [], stage = stageOnTransportBranch, readLedger = readCardLedger,
    branch = CARD_LEDGER_BRANCH, attempts = 4, env = process.env } = o;
  assertPushRef(branch, CARD_LEDGER_REF); const path = cardLedgerPath(repo);
  const policy = resolveCardNumbering({ env }).value;
  const ledgerAuth = o.ledgerAuth ?? policy.ledgerAuth;
  const maxBytes = o.maxBytes ?? policy.readMaxBytes;
  if (!validCap(maxBytes)) throw new Error('invalid ledger read cap');
  if (!['none', 'signed'].includes(ledgerAuth)) throw new Error('invalid ledgerAuth');
  if (ledgerAuth === 'signed' && !o.sign?.keyPath) throw new Error('signed ledger requires signing key; provision key and review trust root on main');
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 8) throw new Error('invalid append attempt bound');
  for (const row of rows) if (!validRow(row)) throw new Error('invalid card ledger row');
  return locked(o, () => {
    let signing;
    if (ledgerAuth === 'signed') {
      const run = o.run || sizedCardLedgerRun({ maxBytes });
      const root = validateTrust(JSON.parse(run(['show', `${cardLedgerBase(o)}:${CARD_LEDGER_TRUST_PATH}`], { cwd: board })));
      const allowedSigners = root.allowedSigners.filter(s => !s.revoked);
      if (!allowedSigners.length) throw new Error('no active signing key; review trust root on main');
      signing = { keyPath: o.sign.keyPath, allowedSigners };
    }
    let last;
    for (let attempt = 0; attempt < attempts; attempt++) {
      let proposed = [];
      try {
        stage({ board, branch, allowRef: CARD_LEDGER_REF, createIfAbsent: true,
          readMaxBytes: maxBytes,
          ...(ledgerAuth === 'signed' ? { sign: signing } : {}),
          message: `drain: append card numbers (${repo})`, files: [{ path, content: ({ existing, wt }) => {
            const state = ledgerAuth === 'signed' && existing !== null
              ? readLedger({ ...o, board: wt || board, existing, tip: 'HEAD', ledgerAuth })
              : parseCardLedger(existing ?? '', { maxBytes });
            requireReadable(state);
            proposed = o.allocate ? o.allocate(state) : rows;
            const extra = [];
            for (const row of proposed) {
              if (!validRow(row)) throw new Error('invalid allocated row');
              if (state.byId.has(row.id)) { if (state.byId.get(row.id) !== row.num) throw new Error('ledger identity conflict'); continue; }
              if (state.byNum.has(row.num) || state.burned.has(row.num)) throw new Error('ledger number conflict');
              state.byId.set(row.id, row.num); state.byNum.set(row.num, row.id); extra.push(row);
            }
            const content = (existing ?? '') + extra.map(r => JSON.stringify(r) + '\n').join('');
            if (Buffer.byteLength(content, 'utf8') > maxBytes) {
              throw new Error(`card ledger append exceeds read cap ${maxBytes}; raise readMaxBytes after review before retrying`);
            }
            return content;
          } }] });
        const confirmed = readLedger({ ...o, ledgerAuth }); requireReadable(confirmed);
        for (const row of proposed) if (confirmed.byId.get(row.id) !== row.num) throw new Error('ledger push not confirmed by fresh read-back');
        return new Map(proposed.map(row => [row.id, confirmed.byId.get(row.id)]));
      } catch (e) {
        last = e;
        if (!/non-fast-forward|fetch first|\[rejected\]/i.test(String(e?.stderr || '') + e.message)) throw e;
      }
    }
    throw new Error(`card ledger append exhausted ${attempts} attempts; retry after refreshing ops/card-numbers: ${failure(last)}`);
  });
}
export function assignCardNumbers(o = {}) {
  const { ids = [], floor = 0, pr = null, now = () => new Date().toISOString(), readLedger = readCardLedger } = o;
  if (ids.some(id => !validId(id)) || !Number.isSafeInteger(floor) || floor < 0 || floor >= 100000) throw new Error('invalid card assignment');
  return locked(o, () => {
    const initial = readLedger(o); requireReadable(initial);
    if (ids.every(id => initial.byId.has(id))) return new Map(ids.map(id => [id, initial.byId.get(id)]));
    // A caller's floor may include reservations; numeric filenames remain an independent lower bound.
    const numericFiles = o.numericFiles
      ?? String((o.run || defaultRun)(['ls-tree', '-r', '--name-only', 'origin/main', '--', 'backlog/'], { cwd: o.board || process.cwd() })).split(/\r?\n/);
    const minimum = Math.max(floor, numericCardFloor(numericFiles));
    return appendCardLedgerRows({ ...o, lockHeld: true, allocate: state => {
      let next = minimum;
      for (const num of state.byNum.keys()) next = Math.max(next, num);
      return [...new Set(ids)].map(id => {
        let num = state.byId.get(id);
        if (!num) { do { num = ++next; } while (state.burned.has(num)); }
        if (!validNum(num)) throw new Error('card number range exhausted; operator review required');
        return { id, num, pr, at: now(), by: 'drain', kind: 'assign' };
      });
    } });
  });
}
