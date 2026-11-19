import yaml from 'js-yaml';

export const SCHEMA = 'drain-verdict/2';
// The dry-run cannot reproduce the drain's persisted baseline or live couple cascade.
export const LOCAL_ONLY = Object.freeze(['red-main-freeze', 'card-group', 'manifest-baseline', 'couple-whole', 'test-gaming-scan']);
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

// PAT excludes only PATH: a bare `_PAT` substring also refuses GITHUB_PATH / *_PATH, which every runner step sets.
export const forbiddenCredential = name => /PRIVATE_KEY|APP_ID|SECRET|(?:^|_)PAT(?!H)/i.test(name) ||
  (/_TOKEN$/i.test(name) && !['GITHUB_TOKEN', 'GH_TOKEN'].includes(name));

/** Audit parsed structure and raw text: comments and expressions also carry credential references. */
const ACTIONS = Object.freeze([
  'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683',
  'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
]);

// The whole workflow is pinned: any parsed difference (container, services, paths, new keys, ...) is refused.
const EXPECTED_WORKFLOW = Object.freeze({
  name: 'drain-verdict',
  on: { workflow_dispatch: { inputs: { pr: { description: 'PR number to classify', required: true, type: 'number' } } },
    schedule: [{ cron: '*/10 * * * *' }] },
  permissions: { contents: 'read', 'pull-requests': 'read', checks: 'read', statuses: 'read' },
  concurrency: { group: 'drain-verdict', 'cancel-in-progress': false },
  env: { GITHUB_TOKEN: '${{ github.token }}' },
  jobs: { classify: { 'runs-on': 'ubuntu-latest', 'timeout-minutes': 30, steps: [
    { uses: ACTIONS[0], with: { ref: 'main', 'persist-credentials': false } },
    { name: 'Install dependencies', run: 'npm ci --ignore-scripts --no-audit --no-fund' },
    { name: 'Classify', env: { REQUESTED_PR: '${{ inputs.pr }}' }, run: 'node scripts/drain-classify-only.mjs --batch --verdict-dir=verdicts' },
    { uses: ACTIONS[1], if: 'always()', with: { name: 'drain-verdicts', path: 'verdicts/*.json', 'retention-days': 1, 'if-no-files-found': 'ignore' } },
  ] } },
});

const stable = v => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x));

export function auditWorkflow(yamlText) {
  const problems = [];
  if (typeof yamlText !== 'string') return { ok: false, problems: ['workflow must be YAML text'] };
  if (/\bsecrets\s*(?:\.|\[)/i.test(yamlText)) problems.push('secret reference');
  let doc;
  try { doc = yaml.safeLoad(yamlText); } catch { return { ok: false, problems: [...problems, 'invalid YAML'] }; }
  if (!record(doc)) return { ok: false, problems: [...problems, 'missing workflow'] };
  // Exactly these four scopes, each read: the dry-run must see PRs, code and the required check's runs/statuses.
  const READ_SCOPES = ['contents', 'pull-requests', 'checks', 'statuses'];
  const permissions = value => exact(value, READ_SCOPES) && READ_SCOPES.every(scope => value[scope] === 'read');
  if (!permissions(doc.permissions)) problems.push('expected explicit read-only permissions');
  if (!exact(doc.on, ['schedule', 'workflow_dispatch'])) problems.push('only schedule and dispatch triggers allowed');
  if (doc.name !== 'drain-verdict') problems.push('unexpected workflow name');
  const walk = value => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!record(value)) return;
    if (Object.hasOwn(value, 'permissions') && !permissions(value.permissions)) problems.push('unsafe permissions');
    if (Object.hasOwn(value, 'defaults')) problems.push('defaults (inherited shell) not allowed');
    if (Object.hasOwn(value, 'shell')) problems.push('shell override not allowed');
    if (Object.hasOwn(value, 'continue-on-error')) problems.push('continue-on-error would suppress failures');
    if (Object.hasOwn(value, 'env')) {
      // Only these exact variables may be set: anything else (NODE_OPTIONS, NODE_PATH, GH_TOKEN, ...) can inject code or credentials.
      const okEnv = value === doc ? { GITHUB_TOKEN: '${{ github.token }}' }
        : Object.hasOwn(value, 'run') ? { REQUESTED_PR: '${{ inputs.pr }}' } : {};
      if (!record(value.env)) problems.push('invalid environment');
      else for (const [name, token] of Object.entries(value.env)) {
        if (okEnv[name] !== token) problems.push('environment variable not allowed');
      }
    }
    if (Object.hasOwn(value, 'uses')) {
      if (!ACTIONS.includes(value.uses)) problems.push('action must be one of the audited pinned actions');
      if (/app-token/i.test(value.uses)) problems.push('App token action forbidden');
      const allowed = /^actions\/upload-artifact@/.test(value.uses) ? ['name', 'path', 'retention-days', 'if-no-files-found'] :
        /^actions\/checkout@/.test(value.uses) ? ['ref', 'persist-credentials'] : [];
      for (const key of Object.keys(record(value.with) ? value.with : {})) {
        if (!allowed.includes(key) || /token|key|secret/i.test(key.replace(/^persist-credentials$/, ''))) problems.push('action input not allowed');
      }
      if (/^actions\/upload-artifact@/.test(value.uses) && value.with?.['if-no-files-found'] !== 'ignore') problems.push('artifact upload must ignore no files');
      if (/^actions\/checkout@/.test(value.uses) &&
          (!exact(value.with, ['ref', 'persist-credentials']) || value.with.ref !== 'main' ||
           value.with['persist-credentials'] !== false)) problems.push('unsafe checkout');
    }
    Object.values(value).forEach(walk);
  };
  walk(doc);
  // The loop, counting and exit code live in the tested --batch mode; the workflow may only run that exact command.
  const steps = Object.values(record(doc.jobs) ? doc.jobs : {}).flatMap(job => (record(job) && Array.isArray(job.steps) ? job.steps : []));
  const RUNS = ['npm ci --ignore-scripts --no-audit --no-fund', 'node scripts/drain-classify-only.mjs --batch --verdict-dir=verdicts'];
  const runs = steps.filter(st => Object.hasOwn(st ?? {}, 'run'));
  const classify = runs.filter(st => st.run === RUNS[1]);
  if (runs.length !== 2 || runs[0].run !== RUNS[0] || runs[1].run !== RUNS[1] || classify.length !== 1 ||
      runs.some(st => Object.hasOwn(st, 'if') || Object.hasOwn(st, 'shell') || Object.hasOwn(st, 'continue-on-error')) ||
      !exact(classify[0].env, ['REQUESTED_PR']) || classify[0].env.REQUESTED_PR !== '${{ inputs.pr }}') {
    problems.push('run steps must be exactly the pinned commands');
  }
  const up = steps.filter(st => /^actions\/upload-artifact@/.test(st?.uses ?? ''));
  if (up.length !== 1 || up[0].if !== 'always()' || steps.some(st => Object.hasOwn(st ?? {}, 'if') && st !== up[0]) ||
      Object.values(record(doc.jobs) ? doc.jobs : {}).some(job => Object.hasOwn(job ?? {}, 'if'))) {
    problems.push('only the artifact upload may be conditional');
  }
  const jobs = record(doc.jobs) ? Object.values(doc.jobs) : [];
  if (jobs.length !== 1 || !jobs.every(job => record(job) && Number.isFinite(job['timeout-minutes']) &&
      job['timeout-minutes'] > 0 && Array.isArray(job.steps) && job.steps.some(step => /^actions\/checkout@/.test(step.uses)))) {
    problems.push('expected one bounded job with checkout');
  }
  if (stable(doc) !== stable(EXPECTED_WORKFLOW)) problems.push('workflow differs from the pinned shape');
  return { ok: problems.length === 0, problems };
}
