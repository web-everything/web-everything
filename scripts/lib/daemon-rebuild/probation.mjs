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

/** The sole external-data boundary. Capture the data graph before invoking accessors,
 * memoizing aliases so each enumerable getter is consumed once, regardless of key order.
 * Unlike JSON serialization,
 * retain undefined/NaN for validation and never execute toJSON. Reject functions and cycles.
 * Adoption's injected readClosure callback is the only non-data value, captured separately.
 * Reading (including invoking a closure reader), copying and freezing all share one catch.
 */
function sanitize(read, callbackKey) {
  try {
    const input = read(), copies = new WeakMap(), getters = [];
    let callback, properties = 0;
    const copy = value => {
      if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
        throw new TypeError('Non-data probation input');
      }
      if (value === null || typeof value !== 'object') return value;
      if (copies.has(value)) return copies.get(value);
      const array = Array.isArray(value);
      const length = array ? Object.getOwnPropertyDescriptor(value, 'length').value : 0;
      const ownKeys = array ? null : Object.keys(value);
      properties += array ? length : ownKeys.length;
      // Also bounds a getter that keeps returning fresh objects with more getters.
      if (properties > 100_000) throw new RangeError('Probation input exceeds copy limit');
      const result = array ? new Array(length) : {};
      copies.set(value, result);
      const keys = array ? Array.from({ length }, (_, i) => String(i)) : ownKeys;
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        const save = child => {
          if (value === input && key === callbackKey) callback = child;
          else Object.defineProperty(result, key, { value: copy(child), enumerable: true });
        };
        if (descriptor && !Object.hasOwn(descriptor, 'value')) {
          getters.push(() => save(descriptor.get?.call(value)));
        } else save(descriptor?.value);
      }
      return result;
    };
    const data = copy(input);
    // Accessor results can themselves contain getters; drain the same queue once per getter.
    for (let i = 0; i < getters.length; i++) getters[i]();
    const active = new WeakSet(), frozen = new WeakSet();
    const freeze = value => {
      if (value === null || typeof value !== 'object') return;
      if (active.has(value)) throw new TypeError('Cyclic probation input');
      if (frozen.has(value)) return;
      active.add(value);
      Object.values(value).forEach(freeze);
      active.delete(value);
      frozen.add(value);
      Object.freeze(value);
    };
    freeze(data);
    return { data, callback };
  } catch { return null; }
}

function readClosureFiles(readClosure, daemon, sha) {
  const value = sanitize(() => readClosure(daemon, sha))?.data;
  if (!object(value)) return null;
  const { complete, files } = value;
  if (complete !== true || !object(files)) return null;
  return Object.keys(files).length > 0 && Object.values(files).every(shaOK) ? files : null;
}

function closureDiffers(daemon, from, to, readClosure) {
  if (!shaOK(from)) return true;
  const before = readClosureFiles(readClosure, daemon, from);
  const after = readClosureFiles(readClosure, daemon, to);
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
  const { adoptionId, sha, provenGood, adoptedAt, registered: roster } = input.data ?? {};
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
  const next = Object.freeze({ ...base, records: Object.freeze({ ...base.records,
    [daemonId]: Object.freeze({ boot: proof?.boot, tick: proof?.tick }) }) });
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
