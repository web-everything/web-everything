/** Three-way union of advisory timings, preferring main on concurrent drift. */
import { assertTimingKeys } from '../ci/shard-assign.mjs';
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
    // Validate each side independently, including evidence main later deletes.
    for (const [index, input] of inputs.entries()) {
      for (const [section, values] of Object.entries(input)) {
        if (section === '_doc') {
          if (typeof values !== 'string') throw new Error(`Side ${index}: _doc must be a string`);
          continue;
        }
        if (!object(values)) throw new Error(`Side ${index}: ${section} must be a timing map`);
        // The shared validator knows the canonical suite names; apply it to every section.
        assertTimingKeys({ unit: values });
        for (const [path, seconds] of Object.entries(values)) {
          if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
            throw new Error(`Side ${index}: ${section}/${path} must be finite seconds >= 0`);
          }
        }
      }
    }
    const docs = inputs.map(input => own(input, '_doc')).filter(value => value !== undefined);
    if (docs.some(value => value !== docs[0])) throw new Error('Structural conflict at $/_doc');
    const [baseInput, prInput, mainInput] = inputs;
    for (const [section, values] of Object.entries(baseInput)) {
      if (!object(values) || Object.hasOwn(mainInput, section) || !Object.hasOwn(prInput, section)) continue;
      const pr = prInput[section];
      if (Object.keys(values).length !== Object.keys(pr).length
        || Object.keys(values).some(key => !Object.hasOwn(pr, key) || pr[key] !== values[key])) {
        throw new Error(`Main deleted PR-modified section ${section}; resolve manually`);
      }
    }
    const merge = (b, o, t) => {
      if (!object(t)) return typeof t === 'number' && b !== undefined && t === b && o !== undefined ? o : t;
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
