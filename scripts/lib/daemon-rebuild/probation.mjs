/** R986 I1: pure per-daemon probation transitions. Persistence and production wiring are separate.
 * See docs/agent/testing.md, "R986 I1 probation core" for the caller's evidence obligations.
 */
const shaOK = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);
const nameOK = value => typeof value === 'string' && value.trim().length > 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const dateMs = value => typeof value === 'string' ? Date.parse(value) : NaN;
const rosterError = () => new Error('Probation refused: operator must recover the clone roster/adoption evidence');

function knownClosure(value) {
  return object(value) && value.complete === true && object(value.files)
    && Object.keys(value.files).length > 0 && Object.values(value.files).every(shaOK);
}

function closureDiffers(daemon, from, to, readClosure) {
  if (!shaOK(from)) return true;
  try {
    const before = readClosure(daemon, from), after = readClosure(daemon, to);
    if (!knownClosure(before) || !knownClosure(after)) return true;
    const paths = Object.keys(before.files);
    return paths.length !== Object.keys(after.files).length
      || paths.some(path => !Object.hasOwn(after.files, path) || before.files[path] !== after.files[path]);
  } catch { return true; }
}

/** `registered` must be the complete roster for ONE clone, frozen at adoption.
 * `readClosure(daemon, sha)` supplies complete repo-relative path -> Git blob maps at both revisions.
 * Unreadable closures owe proof; unreadable/ambiguous rosters refuse adoption, never imply an empty set.
 */
export function freezeProbation({ adoptionId, sha, provenGood, adoptedAt, registered, readClosure } = {}) {
  if (!nameOK(adoptionId) || !shaOK(sha) || !Number.isFinite(dateMs(adoptedAt))
    || (provenGood != null && !shaOK(provenGood)) || !Array.isArray(registered)
    || registered.some(d => !object(d) || !nameOK(d.id))
    || new Set(registered.map(d => d.id)).size !== registered.length) throw rosterError();
  const owed = registered.filter(d => closureDiffers(d, provenGood, sha, readClosure)).map(d => d.id);
  return Object.freeze({ version: 2, adoptionId, sha, provenGood: provenGood ?? null, adoptedAt,
    owed: Object.freeze(owed), records: Object.freeze({}) });
}

function validState(p) {
  return object(p) && p.version === 2 && nameOK(p.adoptionId) && shaOK(p.sha)
    && Number.isFinite(dateMs(p.adoptedAt)) && Array.isArray(p.owed)
    && p.owed.every(nameOK) && new Set(p.owed).size === p.owed.length && object(p.records);
}

function validProof(p, daemonId, evidence, now) {
  const boot = evidence?.boot, tick = evidence?.tick;
  const start = dateMs(boot?.startedAt), done = dateMs(tick?.lastTickDoneAt);
  return Number.isFinite(now) && object(boot) && object(tick)
    && boot.daemonId === daemonId && tick.daemonId === daemonId
    && Number.isSafeInteger(boot.pid) && boot.pid > 0 && tick.pid === boot.pid
    && boot.head === p.sha && tick.head === p.sha
    && start >= dateMs(p.adoptedAt) && done > start && done <= now + 60_000;
}

/** The boot and tick must come from this daemon's own process record, independently of siblings.
 * Invalid or non-owed evidence is an identity-preserving no-op. Never consume or narrow `owed`.
 */
export function recordProof(probation, daemonId, evidence, now) {
  if (!validState(probation) || !probation.owed.includes(daemonId)
    || !validProof(probation, daemonId, evidence, now)) return probation;
  const record = Object.freeze({
    boot: Object.freeze({ ...evidence.boot }), tick: Object.freeze({ ...evidence.tick }),
  });
  return Object.freeze({ ...probation,
    records: Object.freeze({ ...probation.records, [daemonId]: record }),
  });
}

/** Promotion is a caller-owned effect, authorized only by `pass`. Legacy/malformed state cannot pass. */
export function evaluateProbation(probation, now) {
  if (!validState(probation) || !Number.isFinite(now)) {
    return { action: 'pending', reason: 'invalid-probation: operator recovery required' };
  }
  const owed = probation.owed.filter(id => !Object.hasOwn(probation.records, id)
    || !validProof(probation, id, probation.records[id], now));
  return owed.length ? { action: 'pending', owed } : { action: 'pass' };
}
