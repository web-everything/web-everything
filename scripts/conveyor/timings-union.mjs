/** Main-first union of advisory timings; never merge arbitrary JSON structures. */
export const TIMINGS_PATH = 'scripts/ci/test-timings.json';
const object = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const own = (value, key) => object(value) && Object.hasOwn(value, key) ? value[key] : undefined;

/** PURE: JSON text in, formatted JSON text out; malformed or incompatible evidence refuses. */
export function unionTimings({ base, ours, theirs }) {
  try {
    const parse = (text, side, optional = false) => {
      if (optional && (text === undefined || text === '')) return {};
      if (typeof text !== 'string') throw new Error(`${side}: expected JSON text`);
      try { return JSON.parse(text); } catch { throw new Error(`${side}: invalid JSON`); }
    };
    const inputs = [parse(base, 'base', true), parse(ours, 'ours'), parse(theirs, 'theirs')];
    if (!inputs.every(object)) throw new Error('Root must be a plain object');
    // Validate all evidence, including paths main deleted, before discarding any PR data.
    const validate = (values, path) => {
      const present = values.filter(v => v !== undefined);
      if (present.some(v => v === null || Array.isArray(v))) throw new Error(`Structural conflict at ${path}`);
      const kind = v => object(v) ? 'object' : typeof v;
      if (present.some(v => kind(v) !== kind(present[0]))) throw new Error(`Type mismatch at ${path}`);
      if (object(present[0])) {
        for (const key of new Set(present.flatMap(v => Object.keys(v)))) {
          validate(values.map(v => own(v, key)), `${path}/${key}`);
        }
      } else if (present.every(v => typeof v === 'number' && Number.isFinite(v))) {
        // Timing drift is advisory: main's number wins.
      } else if (present.every(v => typeof v === 'string' && v === present[0])) {
        // Preserve identical metadata such as _doc.
      } else throw new Error(`Structural conflict at ${path}`);
    };
    validate(inputs, '$');
    const merge = (b, o, t) => {
      if (!object(t)) return t;
      const keys = Object.keys(t);
      const added = object(o) ? Object.keys(o).filter(key => !Object.hasOwn(t, key) && !Object.hasOwn(b ?? {}, key)) : [];
      const sorted = keys.every((key, i) => i === 0 || keys[i - 1] <= key);
      const mergedKeys = [...keys, ...added];
      if (added.length && sorted) mergedKeys.sort();
      return Object.fromEntries(mergedKeys.map(key => [key, Object.hasOwn(t, key)
        ? merge(own(b, key), own(o, key), t[key]) : o[key]]));
    };
    return { ok: true, text: JSON.stringify(merge(...inputs), null, 1) + '\n' };
  } catch (error) { return { ok: false, reason: error.message }; }
}
