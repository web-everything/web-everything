/**
 * Pure audit projection of platform-decisions#review-stringency-classified-outcomes (AU1 PR-A).
 * INERT: no runtime file imports this module yet (a grep test pins that). D2 pre-existing debt counts only with a
 * relationProof bound to {base, head, fingerprint}; the model's `relation` label is never read for D2.
 */
const RELEASE_STAGES = Object.freeze(['prerelease', 'prod']);
import { GUARD_FLOOR, resolveAuditSettings } from '../lib/audit-settings.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL as NodeURL } from 'node:url';

export const FINDING_CLASSES = Object.freeze(['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'E1', 'E2', 'D1', 'D2', 'D3', 'X1', 'X2']);
const scopeKeys = ['file', 'line', 'invariant', 'trigger', 'consequence', 'relation'];
const text = value => typeof value === 'string' && value.trim().length > 0;
export const findingIdentity = f => JSON.stringify([f?.file, f?.invariant]);
/**
 * Full re-check binding: a re-check may keep or downgrade the SAME fingerprint, never another finding.
 * Every evidence column is bound (location, trigger, consequence, card, ruling); only the D1->D3
 * downgrade may restate the trigger (codex-audit.mjs). Interleaving stays unbound: adding one only escalates.
 */
export const findingFingerprint = f => JSON.stringify([f?.id, f?.file, f?.line, f?.invariant, f?.class, f?.relation,
  f?.trigger ?? null, f?.consequence, f?.card ?? null, f?.ruling ?? null, f?.hunkHash ?? null]);
/** Identity a relationProof binds to. Deliberately excludes the model's `relation` label. */
export const proofFingerprint = f => JSON.stringify([f?.id, f?.file, f?.line, f?.invariant, f?.class, f?.trigger ?? null, f?.consequence,
  f?.card ?? null, f?.ruling ?? null, f?.hunkHash ?? null]);
const validProof = (f, proofs, base, head) => text(base) && text(head) && Array.isArray(proofs)
  && proofs.some(p => p && p.ok === true && p.base === base && p.head === head && p.fingerprint === proofFingerprint(f));
const validInterleaving = steps => Array.isArray(steps) && steps.length >= 2 && steps.length <= 32
  && steps.every(step => step && typeof step === 'object' && !Array.isArray(step)
    && ['actor', 'action'].every(k => text(step[k]) && step[k].length <= 1024))
  && new Set(steps.map(step => step.actor.trim())).size >= 2;
export function validFinding(f) {
  return f !== null && typeof f === 'object' && !Array.isArray(f)
    && FINDING_CLASSES.includes(f.class) && ['id', 'file', 'invariant', 'consequence'].every(k => text(f[k]))
    && Number.isSafeInteger(f.line) && f.line > 0
    && (text(f.trigger) || (f.class === 'D1' && Object.hasOwn(f, 'trigger') && (f.trigger === null || f.trigger === '')))
    && ['introduced', 'newly relied on', 'untouched'].includes(f.relation)
    && (!Object.hasOwn(f, 'interleaving') || validInterleaving(f.interleaving));
}

/**
 * Literal globs: * matches within one segment, a run of two or more * spans directories, every other character is
 * literal; a trailing / is a prefix. Matched by a bitset state walk (bit i = "pattern token i is next"), never a
 * backtracking regex (PR #6381: nested `**` made a regex take exponential time). Cost is a few bitset operations
 * per path character; path and pattern lengths are bounded upstream.
 */
function matchesPath(file, pattern) {
  if (pattern.endsWith('/')) return file.startsWith(pattern);
  const lit = new Map(); let star = 0n; let globstar = 0n; let n = 0n;
  for (let i = 0; i < pattern.length; n++) {
    const bit = 1n << n;
    if (pattern[i] !== '*') { lit.set(pattern[i], (lit.get(pattern[i]) ?? 0n) | bit); i++; continue; }
    let j = i; while (pattern[j] === '*') j++;
    if (j - i >= 2) globstar |= bit; else star |= bit;
    i = j;
  }
  const wild = star | globstar;
  // A wildcard may match nothing, so reaching it also reaches the next token. Runs of * are one token, so a
  // wildcard is never followed by another and one shift closes the set.
  const close = s => s | ((s & wild) << 1n);
  let s = close(1n);
  for (let c = 0; c < file.length; c++) {
    const ch = file[c];
    s = close((s & (ch === '/' ? globstar : wild)) | ((s & (lit.get(ch) ?? 0n)) << 1n));
    if (s === 0n) return false;
  }
  return ((s >> n) & 1n) === 1n;
}

const REPO_ROOT = fileURLToPath(new NodeURL('../../', import.meta.url));
const CARD_PATH = /^backlog\/[A-Za-z0-9._-]+\.md$/;
/** Default card reader: the card must exist on origin/main. Any failure is unavailable (null). */
export function readCardFromMain(path) {
  if (typeof path !== 'string' || !CARD_PATH.test(path)) return null;
  const r = spawnSync('git', ['show', `origin/main:${path}`], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 30_000, maxBuffer: 1 << 20 });
  return r.error || r.status !== 0 ? null : r.stdout;
}
/**
 * D2 debt ships only when its card exists on main and its pay-by date has not passed. The pay-by date is
 * read only from that card, never from the model finding. A card due `prod` blocks at prod. Unreadable => false.
 */
function d2Verified(f, releaseStage, { readCard = readCardFromMain, now = Date.now, requireOnMain = true, requirePayBy = true } = {}) {
  try {
    if (typeof f.card !== 'string' || !CARD_PATH.test(f.card)) return false;
    const body = readCard(f.card);
    if (typeof body !== 'string' || !body.trim()) return requireOnMain === false;
    // Any pay-by-looking line (indent, case, spacing, trailing text) must parse strictly, or it fails closed.
    const lines = body.split(/\r\n|[\n\r\p{Zl}\p{Zp}]/u).filter(l => /^\s*must[\s_-]*pay[\s_-]*before\s*:/i.test(l.normalize('NFKC')));
    if (lines.length > 1) return false;
    const due = lines.length ? /^mustPayBefore: *(\S+) *$/.exec(lines[0])?.[1] : undefined;
    if (lines.length && due === undefined) return false;
    if (due === undefined) return requirePayBy === false;
    if (due === 'prod') return releaseStage !== 'prod';
    const when = payByTime(due);
    return Number.isFinite(when) && when > (typeof now === 'function' ? now() : now);
  } catch { return false; }
}
/**
 * A pay-by date is exactly `YYYY-MM-DD` and a real calendar day (UTC midnight). `Date.parse` is not used: it rolls an
 * impossible day into the next month (`2099-02-31` → March 3) and accepts other formats (PR #6381). Anything else is NaN.
 */
function payByTime(due) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(due);
  if (!m) return NaN;
  const [y, mo, d] = m.slice(1).map(Number);
  const t = Date.UTC(y, mo - 1, d); const day = new Date(t);
  return day.getUTCFullYear() === y && day.getUTCMonth() === mo - 1 && day.getUTCDate() === d ? t : NaN;
}
/** Longest reported path matched against globs; a longer one cannot be established and fails closed (bounds glob cost). */
const MAX_PATH = 512;
/** Most globs one list may carry: the built-in floor plus a full settings list and a full env list (audit-settings caps each at 256). */
const MAX_GLOBS = GUARD_FLOOR.length + 512;
/** Repo-relative POSIX form of a reported path, or null when it cannot be established (callers fail closed). */
function pathCandidates(file) {
  if (typeof file !== 'string' || file.length > MAX_PATH || /[\u0000-\u001f]/.test(file) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(file)) return null;
  let path = file.replace(/\\/g, '/');
  if (path.startsWith('/')) {
    if (!path.startsWith(REPO_ROOT.replace(/\\/g, '/'))) return null;
    path = path.slice(REPO_ROOT.length);
  }
  const parts = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (!parts.length) return null; parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.length ? [parts.join('/')] : null;
}
const matchesAny = (file, pattern) => { const c = pathCandidates(file); return c === null || c.some(x => matchesPath(x, pattern)); };

export function computeVerdict(findings, options = {}) {
  // Omitted settings come from the trusted running checkout (strictest on any failure), never from the candidate.
  const trusted = resolveAuditSettings().value;
  const { releaseStage = trusted.releaseStage, raceBlockPaths = trusted.raceBlockPaths, rulings = [],
    guardFloorPaths = trusted.guardFloorPaths, relationProofs = [], base, head } = options;
  // `allow` is never trusted: it resolves to block. Only an explicit `prove` lets proven D2 debt ship.
  const proveD2 = (options.preExistingMode ?? trusted.preExistingMode) === 'prove';
  const result = { verdict: 'NOT WEAKENED', blocks: [], ships: [], cards: [], recheck: [] };
  // Both glob lists are bounded (count and length) so matching cost is bounded; a bad list is invalid input.
  const validGlobs = list => Array.isArray(list) && list.length <= MAX_GLOBS && list.every(p => text(p) && p.length <= 512);
  if (!Array.isArray(findings) || !RELEASE_STAGES.includes(releaseStage)
    || !validGlobs(raceBlockPaths) || !validGlobs(guardFloorPaths) || !Array.isArray(rulings)) {
    result.blocks.push({ class: 'X2', consequence: 'Invalid audit input/settings; request human adjudication' });
  } else for (const input of findings) {
    const f = { ...input };
    if (!validFinding(input)) { result.blocks.push(f); continue; }
    // Only authenticated adapter-supplied rulings confer authority, never model-supplied scope.
    const ruling = rulings.find(r => r && r.id === f.ruling && text(r.id)
      && scopeKeys.every(k => r.scope?.[k] === f[k]));
    if (f.class === 'X1' && ruling) f.class = 'X1';
    else {
      // A failed exemption proves no underlying defect class. Keep it unresolved
      // until the targeted recheck independently classifies the evidence.
      if (f.class === 'X1') {
        result.recheck.push({ ...f, class: 'X2' });
        continue;
      }
      const protectedPath = [...GUARD_FLOOR, ...raceBlockPaths].some(p => matchesAny(f.file, p));
      if (protectedPath && !f.class.startsWith('B')) {
        if (validInterleaving(f.interleaving)) f.class = 'B4';
        else if (f.class !== 'D1') f.class = 'X2';
      }
    }
    if (f.class === 'D1' || f.class === 'X2') { result.recheck.push(f); continue; }
    // D2: never reads f.relation. It ships only in prove mode, with an ok relationProof bound to base+head+fingerprint,
    // and a card on main whose pay-by is current.
    if (f.class === 'D2' && !(proveD2 && validProof(f, relationProofs, base, head) && d2Verified(f, releaseStage, { requireOnMain: trusted.requireOnMain, requirePayBy: trusted.requirePayBy, ...options }))) { result.blocks.push(f); continue; }
    // E findings in guard paths always block; a path that cannot be established blocks too.
    if (f.class.startsWith('E') && [...GUARD_FLOOR, ...guardFloorPaths].some(p => matchesAny(f.file, p))) { result.blocks.push(f); continue; }
    if (f.class.startsWith('B') || (releaseStage === 'prod' && f.class.startsWith('E'))) { result.blocks.push(f); continue; }
    result.ships.push(f);
    result.cards.push({ ...f, ...(f.class === 'E1' ? { outcome: 'expedite', deadlineHours: 72 }
      : f.class === 'D2' ? { outcome: 'debt', mustPayBefore: 'prod', mustExistOnMain: true }
        : f.class === 'E2' ? { outcome: 'debt' }
          : f.class === 'X1' ? { outcome: 'accepted-risk' } : { outcome: 'advisory' }) });
  }
  if (result.blocks.length || result.recheck.length) result.verdict = 'WEAKENED';
  return result;
}
