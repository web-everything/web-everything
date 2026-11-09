import yaml from 'js-yaml';

export const SCHEMA = 'drain-verdict/2';
export const LOCAL_ONLY = Object.freeze(['red-main-freeze', 'card-group']);
const fields = ['schema', 'repo', 'pr', 'headSha', 'mainSha', 'computedAt', 'decision', 'localOnly', 'provenance'];
const provenanceFields = ['runId', 'event', 'ref', 'workflow'];
const record = value => value !== null && typeof value === 'object' &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value, keys) => record(value) && Reflect.ownKeys(value).length === keys.length &&
  keys.every(key => Object.hasOwn(value, key));
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);
const repo = value => typeof value === 'string' && /^[\w.-]+\/[\w.-]+$/.test(value);
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const trustedProvenance = value => exact(value, provenanceFields) &&
  typeof value.runId === 'string' && /^[1-9]\d*$/.test(value.runId) &&
  ['schedule', 'workflow_dispatch'].includes(value.event) &&
  value.ref === 'refs/heads/main' && value.workflow === 'drain-verdict';

export function verify(verdict, live, { now = Date.now(), maxAgeMinutes = 10 } = {}) {
  const fail = reason => ({ ok: false, reason });
  if (!exact(verdict, fields)) return fail('invalid verdict keys');
  if (verdict.schema !== SCHEMA || !repo(verdict.repo) || !Number.isSafeInteger(verdict.pr) || verdict.pr < 1 ||
      !sha(verdict.headSha) || !sha(verdict.mainSha) || !['enqueue', 'local'].includes(verdict.decision)) {
    return fail('invalid verdict identity or decision');
  }
  if (!exact(verdict.localOnly, LOCAL_ONLY) || LOCAL_ONLY.some(id => verdict.localOnly[id] !== 'unknown')) {
    return fail('local-only gates must remain unknown');
  }
  if (!trustedProvenance(verdict.provenance) || !trustedProvenance(live?.provenance) ||
      provenanceFields.some(key => verdict.provenance[key] !== live.provenance[key])) return fail('untrusted provenance');
  if (['repo', 'pr', 'headSha', 'mainSha'].some(key => verdict[key] !== live?.[key])) return fail('live identity changed');
  if (!iso(verdict.computedAt) || !Number.isFinite(now) || !Number.isFinite(maxAgeMinutes) || maxAgeMinutes <= 0 ||
      now < Date.parse(verdict.computedAt) || now - Date.parse(verdict.computedAt) > maxAgeMinutes * 60_000) {
    return fail('invalid or stale timestamp');
  }
  return { ok: true };
}

export function build(inputs) {
  if (!record(inputs)) throw new TypeError('verdict inputs must be a record');
  const verdict = Object.fromEntries(fields.map(key => [key, inputs[key]]));
  verdict.schema = SCHEMA;
  verdict.localOnly = Object.fromEntries(LOCAL_ONLY.map(id => [id, 'unknown']));
  if (record(inputs.provenance)) verdict.provenance = { ...inputs.provenance };
  const checked = verify(verdict, inputs, { now: Date.parse(inputs.computedAt) });
  if (!checked.ok) throw new TypeError(checked.reason);
  return verdict;
}

export const forbiddenCredential = name => /PRIVATE_KEY|APP_ID|SECRET|_PAT/i.test(name) ||
  (/_TOKEN$/i.test(name) && !['GITHUB_TOKEN', 'GH_TOKEN'].includes(name));

/** Audit parsed structure and raw text: comments and expressions also carry credential references. */
export function auditWorkflow(yamlText) {
  const problems = [];
  if (typeof yamlText !== 'string') return { ok: false, problems: ['workflow must be YAML text'] };
  if (/\bsecrets\s*(?:\.|\[)/i.test(yamlText)) problems.push('secret reference');
  let doc;
  try { doc = yaml.safeLoad(yamlText); } catch { return { ok: false, problems: [...problems, 'invalid YAML'] }; }
  if (!record(doc)) return { ok: false, problems: [...problems, 'missing workflow'] };
  const permissions = value => exact(value, ['contents', 'pull-requests']) &&
    value.contents === 'read' && value['pull-requests'] === 'read';
  if (!permissions(doc.permissions)) problems.push('expected explicit read-only permissions');
  if (!exact(doc.on, ['schedule', 'workflow_dispatch'])) problems.push('only schedule and dispatch triggers allowed');
  if (doc.name !== 'drain-verdict') problems.push('unexpected workflow name');
  const walk = value => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!record(value)) return;
    if (Object.hasOwn(value, 'permissions') && !permissions(value.permissions)) problems.push('unsafe permissions');
    if (Object.hasOwn(value, 'env')) {
      if (!record(value.env)) problems.push('invalid environment');
      else for (const [name, token] of Object.entries(value.env)) {
        if (forbiddenCredential(name) || (['GITHUB_TOKEN', 'GH_TOKEN'].includes(name) && token !== '${{ github.token }}')) {
          problems.push('unsafe credential environment');
        }
      }
    }
    if (Object.hasOwn(value, 'uses')) {
      if (typeof value.uses !== 'string' || !/^[\w./-]+@[a-f0-9]{40}$/i.test(value.uses)) problems.push('action must be SHA pinned');
      if (/app-token/i.test(value.uses)) problems.push('App token action forbidden');
      if (/^actions\/checkout@/.test(value.uses) &&
          (value.with?.ref !== 'main' || value.with?.['persist-credentials'] !== false)) problems.push('unsafe checkout');
    }
    Object.values(value).forEach(walk);
  };
  walk(doc);
  const jobs = record(doc.jobs) ? Object.values(doc.jobs) : [];
  if (jobs.length !== 1 || !jobs.every(job => record(job) && Number.isFinite(job['timeout-minutes']) &&
      job['timeout-minutes'] > 0 && Array.isArray(job.steps) && job.steps.some(step => /^actions\/checkout@/.test(step.uses)))) {
    problems.push('expected one bounded job with checkout');
  }
  return { ok: problems.length === 0, problems };
}
