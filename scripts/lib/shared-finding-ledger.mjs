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

function matches(entry, finding) {
  const identity = normalizeFindingIdentity(finding);
  const original = normalizeFindingIdentity(entry.finding);
  return sameFindingIdentity(original, identity, { ignoreLens: true })
    || Boolean(original?.path && identity?.path && sameFinding(
      { ...entry.finding, file: original.path }, { ...finding, file: identity.path }));
}

export function recordFindings(ledger, { source, head, findings }) {
  const next = structuredClone(ledger);
  for (const finding of findings) {
    const entry = next.entries.find(candidate => matches(candidate, finding));
    if (entry) {
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
    const entry = ledger.entries.find(candidate => matches(candidate, finding));
    let proven = false;
    if (entry?.status === 'test-pinned' && entry.pinningTest && typeof pinStillHolds === 'function') {
      try { proven = pinStillHolds(structuredClone(entry)) === true; } catch { /* Retain on unknown evidence. */ }
    }
    (proven ? dropped : kept).push(finding);
  }
  return { kept, dropped };
}

export function renderOpenForBrief(ledger) {
  const entries = ledger.entries.filter(entry => entry.status !== 'test-pinned');
  if (!entries.length) return '';
  const body = entries.map(entry => `key=${entry.key} sources=${entry.sources.join(',')} status=${entry.status}\n`
    + `${entry.finding.file ?? ''}:${entry.finding.line ?? ''} ${entry.finding.summary}`).join('\n\n');
  return `${FENCED_DATA_RULE}\n\n${fenceUntrusted('findings', `Shared finding ledger DATA:\n${body}`)}`;
}

/** Default off; callers resolve settings and decide whether to supply ledger context. */
export function sharedLedgerEnabled(settings, env = process.env) {
  return env.WE_SHARED_FINDING_LEDGER === 'on' || settings?.review?.sharedFindingLedger?.enabled === true;
}
