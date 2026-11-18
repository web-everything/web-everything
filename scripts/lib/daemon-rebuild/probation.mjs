/** R986 I1: pure per-daemon probation transitions. Persistence and production wiring are separate.
 * See docs/agent/testing.md, "R986 I1 probation core" for the caller's evidence obligations.
 */
const shaOK = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);
const nameOK = value => typeof value === 'string' && value.trim().length > 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const dateMs = value => typeof value === 'string' ? Date.parse(value) : NaN;
const rosterError = () => new Error('Probation refused: operator must recover the clone roster/adoption evidence');
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));

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

/** The ONE record validator: every transition calls it first and fails closed on any violation.
 * Returns the first violated rule name, or null when the whole probation state is valid at `now`.
 * Rules: exact typed fields (unknown fields rejected), dense unique owed names, finite times
 * at/before `now` and at/after adoption, records only for owed daemons, evidence naming its own
 * daemon and the adopted head, and a unique pid per daemon.
 */
export function validateProbation(p, now) {
  if (!Number.isFinite(now)) return 'now-not-finite';
  if (!exactKeys(p, ['version', 'adoptionId', 'sha', 'provenGood', 'adoptedAt', 'owed', 'records'])) return 'state-fields';
  if (p.version !== 2) return 'version';
  if (!nameOK(p.adoptionId)) return 'adoption-id';
  if (!shaOK(p.sha)) return 'adopted-sha';
  if (p.provenGood !== null && !shaOK(p.provenGood)) return 'proven-good';
  const adopted = dateMs(p.adoptedAt);
  if (!Number.isFinite(adopted) || adopted > now) return 'adopted-at';
  if (!Array.isArray(p.owed)) return 'owed-type';
  const owed = Array.from(p.owed);
  if (!owed.every(nameOK)) return 'owed-names';
  if (new Set(owed).size !== owed.length) return 'owed-duplicate';
  if (!object(p.records)) return 'records-type';
  const pids = new Set();
  for (const [id, rec] of Object.entries(p.records)) {
    if (!owed.includes(id)) return 'record-not-owed';
    if (!exactKeys(rec, ['boot', 'tick'])) return 'record-fields';
    const { boot, tick } = rec;
    if (!exactKeys(boot, ['daemonId', 'pid', 'head', 'startedAt'])) return 'boot-fields';
    if (!exactKeys(tick, ['daemonId', 'pid', 'head', 'lastTickDoneAt'])) return 'tick-fields';
    if (boot.daemonId !== id || tick.daemonId !== id) return 'record-daemon';
    if (!Number.isSafeInteger(boot.pid) || boot.pid <= 0) return 'pid-type';
    if (tick.pid !== boot.pid) return 'pid-mismatch';
    if (pids.has(boot.pid)) return 'pid-shared';
    pids.add(boot.pid);
    if (boot.head !== p.sha || tick.head !== p.sha) return 'record-head';
    const start = dateMs(boot.startedAt), done = dateMs(tick.lastTickDoneAt);
    if (!Number.isFinite(start) || !Number.isFinite(done)) return 'time-type';
    if (start < adopted) return 'start-before-adoption';
    if (done <= start) return 'tick-not-after-boot';
    if (start > now || done > now) return 'time-in-future';
  }
  return null;
}

/** `registered` must be the complete roster for ONE clone, frozen at adoption.
 * `readClosure(daemon, sha)` supplies immutable tree and entry object ID snapshots at both revisions.
 * Unreadable closures owe proof; unreadable/ambiguous rosters refuse adoption, never imply an empty set.
 */
export function freezeProbation({ adoptionId, sha, provenGood, adoptedAt, registered, readClosure } = {}) {
  if (!Array.isArray(registered) || Array.from(registered).some(d => !object(d) || !nameOK(d.id))
    || new Set(Array.from(registered).map(d => d.id)).size !== registered.length) throw rosterError();
  const owed = Array.from(registered).filter(d => closureDiffers(d, provenGood ?? null, sha, readClosure)).map(d => d.id);
  const state = Object.freeze({ version: 2, adoptionId, sha, provenGood: provenGood ?? null, adoptedAt,
    owed: Object.freeze(owed), records: Object.freeze({}) });
  if (validateProbation(state, dateMs(adoptedAt)) !== null) throw rosterError();
  return state;
}

/** The boot and tick must come from this daemon's own process record, independently of siblings.
 * Invalid or non-owed evidence is an identity-preserving no-op. Never consume or narrow `owed`.
 */
export function recordProof(probation, daemonId, evidence, now) {
  if (validateProbation(probation, now) !== null || !probation.owed.includes(daemonId)) return probation;
  const copy = e => (object(e) ? { ...e } : e);
  const next = { ...probation, records: { ...probation.records,
    [daemonId]: { boot: copy(evidence?.boot), tick: copy(evidence?.tick) } } };
  if (validateProbation(next, now) !== null) return probation;
  return Object.freeze({ ...next, records: Object.freeze(Object.fromEntries(
    Object.entries(next.records).map(([id, r]) => [id, Object.freeze({ boot: Object.freeze(r.boot), tick: Object.freeze(r.tick) })]))) });
}

/** Promotion is a caller-owned effect, authorized only by `pass`. Legacy/malformed state cannot pass. */
export function evaluateProbation(probation, now) {
  const violation = validateProbation(probation, now);
  if (violation !== null) return { action: 'pending', reason: `invalid-probation: ${violation}; operator recovery required` };
  const owed = probation.owed.filter(id => !Object.hasOwn(probation.records, id));
  return owed.length ? { action: 'pending', owed } : { action: 'pass' };
}
