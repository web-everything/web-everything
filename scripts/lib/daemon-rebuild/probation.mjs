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

// Only called on owned JSON data, never on external objects or accessors.
function freezeData(value) {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freezeData);
    Object.freeze(value);
  }
  return value;
}

/** The single input boundary. Serialize depth-first BEFORE reading any sibling field.
 * A reader thunk keeps both IO and getter exceptions inside this boundary. The only
 * callable dependency is freezeProbation's root readClosure; it is captured once,
 * excluded from state, and its results go through this same boundary on each call.
 * Preserve undefined as null so unknown fields and sparse entries cannot disappear.
 * Functions elsewhere and cycles refuse the whole input instead of dropping evidence.
 */
function sanitize(read, callbackKey) {
  try {
    const input = read();
    let callback;
    const data = JSON.parse(JSON.stringify(input, function (key, value) {
      if (callbackKey && this === input && key === callbackKey) {
        callback = value;
        return null;
      }
      if (typeof value === 'function' || typeof value === 'symbol') throw new TypeError('Non-data input');
      return value === undefined ? null : value;
    }));
    return { data: freezeData(data), callback };
  } catch { return null; }
}

function readClosureFiles(daemon, sha, readClosure) {
  const value = sanitize(() => readClosure(daemon, sha))?.data;
  if (!object(value)) return null;
  const { complete, files } = value;
  if (complete !== true || !object(files)) return null;
  return Object.keys(files).length > 0 && Object.values(files).every(shaOK) ? files : null;
}

function closureDiffers(daemon, from, to, readClosure) {
  if (!shaOK(from)) return true;
  const before = readClosureFiles(daemon, from, readClosure);
  const after = readClosureFiles(daemon, to, readClosure);
  if (!before || !after) return true;
  const paths = Object.keys(before);
  return paths.length !== Object.keys(after).length
    || paths.some(path => !Object.hasOwn(after, path) || before[path] !== after[path]);
}

/** The ONE record validator: every transition calls it first and fails closed on any violation.
 * Returns the first violated rule name, or null when the whole probation state is valid at `now`.
 * Rules: exact typed fields (unknown fields rejected), dense unique owed names, finite times
 * at/before `now` and at/after adoption, records only for owed daemons, evidence naming its own
 * daemon and the adopted head, and a unique pid per daemon.
 */
export function validateProbation(p, now) {
  const input = sanitize(() => p);
  return checkSnapshot(input?.data, now);
}

function checkSnapshot(p, now) {
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
 * `readClosure(daemon, sha)` supplies complete repo-relative path -> Git blob maps at both revisions.
 * Unreadable closures owe proof; unreadable/ambiguous rosters refuse adoption, never imply an empty set.
 */
export function freezeProbation(options = {}) {
  const input = sanitize(() => options, 'readClosure');
  if (!input) return options;
  if (!object(input.data)) throw rosterError();
  const { adoptionId, sha, provenGood, adoptedAt, registered: roster } = input.data;
  if (!Array.isArray(roster) || roster.some(d => !object(d) || !nameOK(d.id))
    || new Set(roster.map(d => d.id)).size !== roster.length) throw rosterError();
  const owed = roster.filter(d => closureDiffers(d, provenGood ?? null, sha, input.callback)).map(d => d.id);
  const state = Object.freeze({ version: 2, adoptionId, sha, provenGood: provenGood ?? null, adoptedAt,
    owed: Object.freeze(owed), records: Object.freeze({}) });
  if (checkSnapshot(state, dateMs(adoptedAt)) !== null) throw rosterError();
  return state;
}

/** The boot and tick must come from this daemon's own process record, independently of siblings.
 * Invalid or non-owed evidence is an identity-preserving no-op. Never consume or narrow `owed`.
 */
export function recordProof(probation, daemonId, evidence, now) {
  const input = sanitize(() => ({ probation, evidence }));
  if (!input) return probation;
  const { probation: base, evidence: proof } = input.data;
  if (checkSnapshot(base, now) !== null || !base.owed.includes(daemonId)) return probation;
  // A successful transition returns a fresh deep-frozen state sharing nothing with its input.
  const next = freezeData({ ...base, records: { ...base.records,
    [daemonId]: { boot: proof?.boot, tick: proof?.tick } } });
  return checkSnapshot(next, now) === null ? next : probation;
}

/** Promotion is a caller-owned effect, authorized only by `pass`. Legacy/malformed state cannot pass. */
export function evaluateProbation(probation, now) {
  const input = sanitize(() => probation);
  const s = input?.data;
  const violation = checkSnapshot(s, now);
  if (violation !== null) return { action: 'pending', reason: `invalid-probation: ${violation}; operator recovery required` };
  const owed = s.owed.filter(id => !Object.hasOwn(s.records, id));
  return owed.length ? { action: 'pending', owed: [...owed] } : { action: 'pass' };
}
