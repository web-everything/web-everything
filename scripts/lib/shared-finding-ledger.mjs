/** Shared finding context. Pure transformations; persistence and pin verification belong to callers. */
import { createHash } from 'node:crypto';
import { normalizeFindingIdentity, sameFindingIdentity } from './jury-core.mjs';
import { sameFinding } from './ruling-ledger.mjs';
import { FENCED_DATA_RULE, fenceUntrusted } from './mandate-fence.mjs';

/** Lens and line drift do not change the normalized path/claim key. */
export function findingKey(finding) {
  const identity = normalizeFindingIdentity(finding);
  if (!identity) throw new TypeError('Invalid finding');
  return `f-${createHash('sha256').update(JSON.stringify([identity.path, identity.normSummary])).digest('hex')}`;
}

export function emptyLedger() {
  return { entries: [] };
}

function exactMatch(entry, finding) {
  const identity = normalizeFindingIdentity(finding);
  const original = normalizeFindingIdentity(entry.finding);
  return Boolean(identity?.path && original?.path && identity.path === original.path && identity.normSummary === original.normSummary);
}

/** Suppression also needs the same spot: equal quote anchors and cited lines identical when both sides carry them. */
function sameSpot(a, b) {
  const ia = normalizeFindingIdentity(a), ib = normalizeFindingIdentity(b);
  if ((a.quote ?? '') !== (b.quote ?? '') || (ia?.anchor ?? '') !== (ib?.anchor ?? '')) return false;
  // Fail closed: a missing line on either side is not the same spot.
  const pos = (n) => Number.isInteger(n) && n > 0;
  return pos(a.line) && pos(b.line) && a.line === b.line
    && a.verdict === b.verdict && a.impactIfUnfixed === b.impactIfUnfixed
    && (a.failure_scenario ?? '') === (b.failure_scenario ?? '') && (a.reproCommand ?? '') === (b.reproCommand ?? '');
}

const rawClaim = (f) => String(f?.summary ?? '');

/** One predicate for filter AND brief: only a complete, test-pinned, variant-free entry may ever be suppressed. */
function suppressible(entry) {
  return entry?.status === 'test-pinned' && !entry.variants?.length && Boolean(entry.pinningTest)
    && Boolean(entry.finding?.file) && Number.isInteger(entry.finding?.line) && entry.finding.line > 0;
}

function matches(entry, finding, { strict = false } = {}) {
  if (exactMatch(entry, finding)) return !strict || (rawClaim(entry.finding) === rawClaim(finding) && sameSpot(entry.finding, finding));
  if (strict) return false; // suppression needs the same path and the same claim: no anchor-only or fuzzy match
  const identity = normalizeFindingIdentity(finding);
  const original = normalizeFindingIdentity(entry.finding);
  if (sameFindingIdentity(original, identity, { ignoreLens: true })) return true;
  return Boolean(original?.path && identity?.path && sameFinding(
      { ...entry.finding, file: original.path }, { ...finding, file: identity.path }));
}

export function recordFindings(ledger, { source, head, findings }) {
  const next = structuredClone(ledger);
  for (const finding of findings) {
    const entry = next.entries.find(candidate => matches(candidate, finding));
    if (entry) {
      // A merge that is not the exact same claim keeps the incoming wording and reopens the entry: a pin never covers it.
      if (!matches(entry, finding, { strict: true })) {
        (entry.variants ??= []).push(structuredClone(finding));
        Object.assign(entry, { status: 'open', pinningTest: null });
      }
      if (!entry.sources.includes(source)) entry.sources.push(source);
    } else {
      next.entries.push({ key: findingKey(finding), finding: structuredClone(finding),
        sources: [source], status: 'open', pinningTest: null, firstSeenHead: head });
    }
  }
  return next;
}

export function markFixed(ledger, key, { head }) {
  const next = structuredClone(ledger);
  const entry = next.entries.find(candidate => candidate.key === key);
  if (entry) Object.assign(entry, { status: 'fixed', fixedHead: head, pinningTest: null });
  return next;
}

export function pinFinding(ledger, key, pinningTest) {
  const next = structuredClone(ledger);
  const entry = next.entries.find(candidate => candidate.key === key);
  if (entry?.status === 'fixed' && typeof pinningTest?.file === 'string' && pinningTest.file.trim()
    && typeof pinningTest.name === 'string' && pinningTest.name.trim()) {
    Object.assign(entry, { status: 'test-pinned', pinningTest: structuredClone(pinningTest) });
  }
  return next;
}

/** Missing, unreadable or non-boolean proof retains the finding for review. */
export function filterReraises(ledger, findings, { pinStillHolds } = {}) {
  const kept = [], dropped = [];
  for (const finding of findings) {
    const entry = ledger.entries.find(candidate => matches(candidate, finding, { strict: true }));
    let proven = false;
    if (suppressible(entry) && typeof pinStillHolds === 'function') {
      try { proven = pinStillHolds(structuredClone(entry)) === true; } catch { /* Retain on unknown evidence. */ }
    }
    (proven ? dropped : kept).push(finding);
  }
  return { kept, dropped };
}

/** Lists open, fixed-unpinned and test-pinned entries whose pin is not currently proven (a stale pin must not hide a finding). */
export function renderOpenForBrief(ledger, { pinStillHolds } = {}) {
  const holds = (entry) => {
    if (!suppressible(entry) || typeof pinStillHolds !== 'function') return false;
    try { return pinStillHolds(structuredClone(entry)) === true; } catch { return false; }
  };
  const entries = ledger.entries.filter(entry => !holds(entry));
  if (!entries.length) return '';
  const body = entries.map(entry => `key=${entry.key} sources=${entry.sources.join(',')} status=${entry.status}\n`
    + [entry.finding, ...(entry.variants ?? [])].map(f => `${f.file ?? ''}:${f.line ?? ''} ${f.summary}`).join('\n')).join('\n\n');
  return `${FENCED_DATA_RULE}\n\n${fenceUntrusted('findings', `Shared finding ledger DATA:\n${body}`)}`;
}

/** Default off; callers resolve settings and decide whether to supply ledger context. */
export function sharedLedgerEnabled(settings, env = process.env) {
  return env.WE_SHARED_FINDING_LEDGER === 'on' || settings?.review?.sharedFindingLedger?.enabled === true;
}

/** Wrap ledger text as fenced untrusted DATA unless it already is, so a supplied brief cannot carry instructions. */
export function fenceLedgerBrief(text) {
  if (typeof text !== 'string' || !text.trim()) return '';
  const rest = text.startsWith(FENCED_DATA_RULE) ? text.slice(FENCED_DATA_RULE.length).trim() : '';
  const inner = rest.startsWith('<findings>\n') && rest.endsWith('\n</findings>') ? rest.slice(11, -12) : null;
  // Already ours only if re-fencing the inner body is a no-op (every closing-tag spelling was already neutralized).
  const ours = inner !== null && fenceUntrusted('findings', inner) === rest;
  return ours ? text : `${FENCED_DATA_RULE}\n\n${fenceUntrusted('findings', text)}`;
}
