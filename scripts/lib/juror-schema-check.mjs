/**
 * Strict synchronous juror schema subset; no coercion, defaults, refs or async work.
 * Keywords: type, properties, required, enum, items (single schema), additionalProperties.
 * Audited caller extensions: minLength (targeted check), maxLength (estimates/sample),
 * maxItems and anyOf (coroner sample). Annotations: description, title, $schema,
 * $id (worker-result). All other keywords throw while checking the entire schema,
 * including unused properties and unselected anyOf branches, before any verdict.
 */
import { isDeepStrictEqual } from 'node:util';

const types = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const keywords = new Set(['type', 'properties', 'required', 'enum', 'items', 'additionalProperties',
  'minLength', 'maxLength', 'maxItems', 'anyOf', 'description', 'title', '$schema', '$id']);
const annotations = new Set(['description', 'title', '$schema', '$id']);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);

export class JurorSchemaError extends Error {
  constructor(keyword) {
    // Never copy oversized or control-bearing schema text into an operator message.
    const name = /^[a-zA-Z$][a-zA-Z0-9$]*$/.test(keyword) && keyword.length <= 64
      ? keyword : '<redacted keyword>';
    super(`unsupported or invalid keyword ${name}`);
  }
}

const matchesType = (v, type) => {
  if (type === 'null') return v === null;
  if (type === 'object') return object(v);
  if (type === 'array') return Array.isArray(v);
  if (type === 'number') return typeof v === 'number' && Number.isFinite(v);
  if (type === 'integer') return Number.isInteger(v);
  return typeof v === type;
};

/** Compile only the documented subset. Returns a boolean checker with bounded errors. */
export function compileJurorSchema(schema) {
  const active = new Set();
  function compile(s) {
    if (!object(s) || active.has(s)) throw new JurorSchemaError('schema');
    active.add(s);
    const bad = key => { throw new JurorSchemaError(key); };
    for (const [key, value] of Object.entries(s)) {
      if (!keywords.has(key)) bad(key);
      if (annotations.has(key) && typeof value !== 'string') bad(key);
    }
    const has = key => Object.hasOwn(s, key);
    const ts = has('type') ? (Array.isArray(s.type) ? s.type : [s.type]) : null;
    if (ts && (!ts.length || ts.some(t => !types.has(t)) || new Set(ts).size !== ts.length)) bad('type');
    if (has('required') && (!Array.isArray(s.required) || s.required.some(k => typeof k !== 'string')
      || new Set(s.required).size !== s.required.length)) bad('required');
    if (has('enum') && (!Array.isArray(s.enum) || !s.enum.length)) bad('enum');
    for (const key of ['minLength', 'maxLength', 'maxItems']) {
      if (has(key) && (!Number.isSafeInteger(s[key]) || s[key] < 0)) bad(key);
    }
    if (has('properties') && !object(s.properties)) bad('properties');
    const props = new Map(Object.entries(s.properties ?? {}).map(([k, child]) => [k, compile(child)]));
    const items = has('items') ? compile(s.items) : null;
    const extra = has('additionalProperties') && typeof s.additionalProperties !== 'boolean'
      ? compile(s.additionalProperties) : s.additionalProperties;
    if (has('anyOf') && (!Array.isArray(s.anyOf) || !s.anyOf.length)) bad('anyOf');
    const branches = s.anyOf?.map(compile);
    active.delete(s);
    return v => {
      if (ts && !ts.some(t => matchesType(v, t))) return 'type';
      if (has('enum') && !s.enum.some(e => isDeepStrictEqual(e, v))) return 'enum';
      if (branches && !branches.some(check => check(v) === null)) return 'anyOf';
      if (typeof v === 'string') {
        const length = [...v].length;
        if (has('minLength') && length < s.minLength) return 'minLength';
        if (has('maxLength') && length > s.maxLength) return 'maxLength';
      }
      if (Array.isArray(v)) {
        if (has('maxItems') && v.length > s.maxItems) return 'maxItems';
        if (items) for (const item of v) { const error = items(item); if (error) return error; }
      }
      if (object(v)) {
        if (s.required?.some(k => !Object.hasOwn(v, k))) return 'required';
        for (const key of Object.keys(v)) {
          const check = props.get(key);
          if (!check && extra === false) return 'additionalProperties';
          const error = check ? check(v[key]) : typeof extra === 'function' ? extra(v[key]) : null;
          if (error) return error;
        }
      }
      return null;
    };
  }
  const check = compile(schema);
  const validate = value => {
    const keyword = check(value);
    validate.errors = keyword ? [{ schemaPath: `#/${keyword}`, message: `violates ${keyword}` }] : null;
    return keyword === null;
  };
  return validate;
}
