import { createHash } from 'node:crypto';
import schemas from '../flow-engine/reference/schemas.json' with { type: 'json' };
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { makeRules, DEF_RULES } from '../flow-engine/reference/definition-rules.mjs';
import { flowRules } from '../flow-engine/reference/legacy-rules.mjs';

export const version = 'FlowEngine/v0';
// RFC 8785: ECMAScript number/string serialization, UTF-16 property ordering, I-JSON only.
export function canonicalJSON(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value === 'string' && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${Array.from(value, canonicalJSON).join(',')}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) return `{${Object.keys(value).sort().map(k => `${canonicalJSON(k)}:${canonicalJSON(value[k])}`).join(',')}}`;
  throw Error('Definition/projection must be I-JSON');
}
export const digest = value => createHash('sha256').update(canonicalJSON(value)).digest('hex');
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validator = name => ajv.compile({ $defs: schemas.$defs, ...schemas[name] });
const validateDefinition = validator('definition');
// v0 has no keys: require an explicit v0.1 key declaration extension, never invent keys.
const legacySchema = structuredClone(schemas);
const legacyRoot = legacySchema.$defs[legacySchema.legacy.$ref.split('/').pop()];
const root = schemas.$defs[schemas.definition.$ref.split('/').pop()];
legacyRoot.properties.flowType = { type: 'string', format: 'uri' }; // design §1.4 removes the pin
legacyRoot.properties.keys = root.properties.keys;
legacyRoot.required.push('keys');
const legacyState = legacySchema.$defs[legacyRoot.properties.states.additionalProperties.$ref.split('/').pop()];
const state = schemas.$defs[root.properties.states.additionalProperties.$ref.split('/').pop()];
legacyState.properties.key = state.properties.key;
const validateLegacy = ajv.compile({ $defs: legacySchema.$defs, ...legacySchema.legacy });
const loaded = new WeakSet();
const freeze = x => { if (x && typeof x === 'object') { Object.values(x).forEach(freeze); Object.freeze(x); } return x; };
export function assertFlow(flow) {
  if (!loaded.has(flow) || digest(flow.definition) !== flow.digest) throw Error('Flow must carry its loaded definition digest');
}
export function load(definition) {
  const def = JSON.parse(canonicalJSON(definition)), sha256 = digest(def), features = [];
  const scan = (v, path = '') => {
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      if (['timeout', 'deadline', 'timers', 'after'].includes(k)) features.push(['timers', `${path}/${k}`]);
      if (['compensation', 'compensations', 'compensate'].includes(k)) features.push(['compensation', `${path}/${k}`]);
      if ((k === 'kind' && x === 'compound') || (k === 'states' && path)) features.push(['nested-states', `${path}/${k}`]);
      if ((k === 'where' && x === 'subflow') || ['subflow', 'subflows'].includes(k) || (k === 'flow' && path.endsWith('/invoke'))) features.push(['sub-flows', `${path}/${k}`]);
      scan(x, `${path}/${k}`);
    }
  };
  scan(def);
  if (features.length) {
    const lossReport = { reportType: 'https://everstandards.dev/core/plug/loss-report/v0.1',
      adapter: { id: 'flow-v0-interim', version }, source: { format: def.flowType ?? 'unknown', version: '0.1' },
      target: { format: version, version: '0' }, sourceDigest: { sha256 }, status: 'unsupported',
      diagnostics: features.map(([feature, sourcePath]) => ({ feature, sourcePath, disposition: 'lost', severity: 'task', required: true, note: 'Refused; use a capable FlowEngine implementation or remove this feature before loading.' })),
      requiredPlugs: [], assumptions: [], provenance: { producedAt: '1970-01-01T00:00:00Z', producer: 'urn:flow-v0-interim:load' } };
    throw Object.assign(Error(`Unsupported features: ${features.map(x => x[0]).join(', ')}`), { lossReport });
  }
  const modern = def.flowType === 'https://everstandards.dev/flow/definition/v0.1';
  const validate = modern ? validateDefinition : validateLegacy;
  if (!validate(def)) throw Error(`FLOW-DEF-001/FLOW-DL-001: ${ajv.errorsText(validate.errors)}`);
  if (Object.values(def.states).some(s => !['compute', 'judge', 'confirm', 'effect', 'invoke', 'final'].includes(s.kind))) throw Error('Out-of-subset node kind');
  const rules = makeRules();
  const mapped = modern ? def : { ...def, states: Object.fromEntries(Object.entries(def.states).map(([n, s]) => [n, { ...s, kind: s.kind === 'invoke' ? 'judge' : s.kind }])) };
  const problems = modern ? DEF_RULES.flatMap(n => rules[n](def)) : [
    ...['targetsResolve', 'outcomesRouted', 'reachableAndLive', 'humanTask', 'retryBounded'].flatMap(n => flowRules[n](def)),
    ...['keysDeclared', 'visitInKeyOnCycle', 'noExpressions'].flatMap(n => rules[n](mapped)),
  ];
  for (const [name, s] of Object.entries(def.states)) {
    if (s.kind !== 'final' && !s.key) problems.push(`${name}: FLOW-DEF-009 missing key`);
    for (const t of s.on ?? []) if (!t.event || !t.route || (!!t.guard !== !!t.outcome)) problems.push(`${name}: incomplete routed event`);
    if (s.kind === 'confirm' && (!s.confirm.excludes.includes('author') || !s.confirm.excludes.includes('preparers') || s.on.some(t => !t.guard))) problems.push(`${name}: FLOW-DL-009 approval must be guarded and exclude author/preparers`);
  }
  if (problems.length) throw Error(problems.join('; '));
  const flow = freeze({ definition: def, digest: sha256 });
  loaded.add(flow);
  return flow;
}
