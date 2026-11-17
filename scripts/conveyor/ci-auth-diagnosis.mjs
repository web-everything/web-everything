/** Read-only, attempt-scoped CI credential evidence; never reads credential values. */
import yaml from 'js-yaml';
import { runGhSync } from '../lib/gh-throttle.mjs';

const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^[a-f0-9]{40}$/i;
const SECRET = /^[A-Za-z_][A-Za-z0-9_]*$/;
const positive = (n) => Number.isSafeInteger(Number(n)) && Number(n) > 0;
const timestamp = (s) => typeof s === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(s) && Number.isFinite(Date.parse(s));
const label = (s) => String(s ?? '').replace(/[\r\n\t`<>\[\]\\]/g, ' ').slice(0, 180);
const unavailable = (detail) => ({ status: 'unavailable', detail });

function verifiedRun({ repo, runId, attempt, headSha, run }) {
  return SLUG.test(repo) && SHA.test(headSha) && positive(runId) && positive(attempt)
    && run?.id === Number(runId) && run.run_attempt === Number(attempt)
    && run.repository?.full_name?.toLowerCase() === repo.toLowerCase() && SHA.test(run.head_sha)
    && (run.head_sha.toLowerCase() === headSha.toLowerCase()
      || (run.event === 'pull_request' && run.pull_requests?.some((p) => p.head?.sha?.toLowerCase() === headSha.toLowerCase()
        && p.base?.repo?.full_name?.toLowerCase() === repo.toLowerCase())));
}

// Enumerate only finite literal matrices. Expressions, include/exclude and reusable jobs fail closed.
function jobNames(id, definition) {
  const name = definition.name ?? id;
  if (typeof name !== 'string') return [];
  if (!definition.strategy?.matrix) return name.includes('${{') ? [] : [name];
  const matrix = definition.strategy.matrix;
  if (!matrix || typeof matrix !== 'object' || matrix.include || matrix.exclude) return [];
  let rows = [{}];
  for (const [key, values] of Object.entries(matrix)) {
    if (!Array.isArray(values) || !values.length || values.some((v) => !['string', 'number', 'boolean'].includes(typeof v))
      || rows.length * values.length > 100) return [];
    rows = rows.flatMap((row) => values.map((v) => ({ ...row, [key]: v })));
  }
  return rows.map((row) => {
    if (!definition.name) return `${id} (${Object.values(row).join(', ')})`;
    return name.replace(/\$\{\{\s*matrix\.([\w-]+)\s*\}\}/g, (all, key) => Object.hasOwn(row, key) ? String(row[key]) : all);
  }).filter((n) => !n.includes('${{'));
}

/** Pure evidence -> allowlisted diagnosis. Logs and workflow text never leave this boundary. */
export function diagnoseCiAuth(evidence = {}) {
  try {
    if (!verifiedRun(evidence)) return unavailable('Run repository, attempt or examined-head association is unavailable or mismatched.');
    const { repo, runId, attempt, run, jobs, logs, workflow, secrets, observedAt } = evidence;
    if (run.head_sha.toLowerCase() !== evidence.headSha.toLowerCase()
      && (evidence.workflowCommit?.sha !== run.head_sha || evidence.workflowCommit?.parents?.length !== 2
        || !evidence.workflowCommit.parents.some((p) => p.sha === evidence.headSha))) {
      return unavailable('Run merge revision does not establish the examined PR head; PR association alone is insufficient.');
    }
    const base = { repo, runId: Number(runId), attempt: Number(attempt), revision: evidence.workflowRevision ?? run.head_sha };
    const unresolved = (detail, extra = {}) => ({ ...base, status: 'unresolved', detail, ...extra });
    if (!Array.isArray(jobs) || jobs.length > 100) return unresolved('Job evidence is unavailable or exceeds the bounded job limit.');
    const failed = jobs.filter((j) => j.conclusion === 'failure');
    if (!failed.length) return unresolved('No failed job is available for this attempt.');
    if (failed.some((j) => j.run_id !== Number(runId) || j.run_attempt !== Number(attempt) || j.head_sha !== run.head_sha)) {
      return unresolved('Job revision or attempt does not match the run.');
    }
    const candidates = [];
    for (const job of failed) {
      if (!Array.isArray(job.steps) || typeof logs?.[job.id] !== 'string') return unresolved('Failed-step logs are unavailable.');
      for (const step of job.steps.filter((s) => s.conclusion === 'failure')) {
        if (job.steps.filter((s) => s.name === step.name).length !== 1) return unresolved('Repeated step labels within a job make log attribution ambiguous.');
        const lines = logs[job.id].split('\n').filter((line) => {
          const parts = line.split('\t');
          return parts[0] === job.name && parts[1] === step.name;
        });
        if (!lines.length) return unresolved('Failed-step logs could not be correlated to the job and step.');
        if (lines.some((line) => /bad credentials|authentication failed|\bHTTP\s*401\b/i.test(line.split('\t').slice(2).join('\t')))) {
          candidates.push({ job, step });
        }
      }
    }
    if (!candidates.length) return unresolved('No authentication failure identified in failed-step logs.');
    if (candidates.length > 1) {
      const diagnoses = candidates.map(({ job, step }) => diagnoseCiAuth({ ...evidence, jobs: [{ ...job, steps: [step] }] }));
      const first = diagnoses[0];
      const failures = diagnoses.map((d) => ({ job: d.job, jobKey: d.jobKey, step: d.step, secret: d.secret }));
      if (first.secret && diagnoses.every((d) => d.secret === first.secret && d.status === first.status)) {
        return { ...first, failures };
      }
      return unresolved('Multiple authentication failures have ambiguous or different credential references; no single rotation target.', { failures });
    }
    const { job, step } = candidates[0];
    const context = { job: label(job.name), step: label(step.name) };
    const doc = yaml.safeLoad(workflow, { schema: yaml.JSON_SCHEMA });
    const definitions = Object.entries(doc?.jobs ?? {}).filter(([id, def]) => def && jobNames(id, def).includes(job.name));
    if (definitions.length !== 1) return unresolved('Workflow job is unmatchable or ambiguous (including dynamic/reusable jobs).', context);
    const [jobKey, def] = definitions[0];
    context.jobKey = label(jobKey);
    if (def.uses || def.environment) return unresolved('Reusable workflow or environment secret ownership is unresolved.', context);
    // Actions inserts "Set up job" as step 1. Check BOTH ordinal and label, never first-name-match.
    const source = def.steps?.[step.number - 2];
    if (!source || source.name !== step.name || !/^actions\/checkout@[\w./-]+$/.test(source.uses ?? '')) {
      return unresolved('Failed step cannot be matched to a direct checkout definition.', context);
    }
    const token = source.with?.token;
    const match = typeof token === 'string' && /^\$\{\{\s*secrets(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\2\s*\])\s*\}\}$/.exec(token);
    if (!match) return unresolved('Checkout token is not a single literal secret reference (dynamic or multiple candidates).', context);
    const secret = match[1] ?? match[3];
    const entries = Array.isArray(secrets) ? secrets.filter((s) => s?.name === secret) : [];
    const repositorySecret = entries.length === 1;
    return { ...base, ...context, status: repositorySecret ? 'resolved' : 'unresolved', secret, repositorySecret,
      updatedAt: repositorySecret && timestamp(entries[0].updatedAt) ? entries[0].updatedAt : null,
      observedAt: timestamp(observedAt) ? observedAt : null,
      detail: repositorySecret ? 'Credential referenced by the failed step; authentication failure does not establish expiry.'
        : 'Repository secret metadata unavailable or no exact entry; organization/repository ownership unresolved. Absence does not establish a missing secret.' };
  } catch {
    return unavailable('Workflow or response evidence is malformed or unavailable.');
  }
}

// Default checkout only: an explicit ref/repository override cannot establish the run's workflow revision.
function sourceCheckoutRevisions(workflow, jobs, logs, repo) {
  const doc = yaml.safeLoad(workflow, { schema: yaml.JSON_SCHEMA });
  const revisions = new Set();
  for (const job of jobs.filter((j) => j.conclusion === 'failure')) {
    const definitions = Object.entries(doc?.jobs ?? {}).filter(([id, def]) => def && jobNames(id, def).includes(job.name));
    if (definitions.length !== 1) continue;
    const def = definitions[0][1];
    for (const [i, step] of (def.steps ?? []).entries()) {
      if (!/^actions\/checkout@[\w./-]+$/.test(step.uses ?? '') || step.with?.ref
        || (step.with?.repository && step.with.repository !== repo)) continue;
      const actual = job.steps?.find((s) => s.number === i + 2 && s.conclusion === 'success');
      if (!actual || (step.name && step.name !== actual.name)) continue;
      const lines = String(logs[job.id] ?? '').split('\n').map((l) => l.split('\t'))
        .filter((parts) => parts[0] === job.name && parts[1] === actual.name)
        .map((parts) => parts.slice(2).join('\t').replace(/^\d{4}-\d\d-\d\dT\S+\s+/, ''));
      for (let n = 0; n < lines.length - 1; n++) {
        if (/^\[command\].*\bgit log -1 --format=(?:%H|['"]%H['"])$/.test(lines[n]) && SHA.test(lines[n + 1].trim())) revisions.add(lines[n + 1].trim());
      }
    }
  }
  return [...revisions];
}

/** Bounded, read-only collection. Reader takes gh argument arrays; command errors are never emitted. */
export function collectCiAuthDiagnosis(input = {}, { read = runGhSync, now = () => new Date().toISOString() } = {}) {
  const { repo, runId, attempt, headSha } = input;
  if (!SLUG.test(repo) || !positive(runId) || !positive(attempt) || !SHA.test(headSha)) return unavailable('Explicit repository, run, attempt and examined head are required.');
  const options = { encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    throttle: { maxAttempts: 1, acquireTimeoutMs: 1000, caller: 'ci-auth-diagnosis' } };
  const get = (args) => read(args, options);
  const json = (args) => JSON.parse(get(args));
  try {
    const root = `repos/${repo}`;
    const run = json(['api', `${root}/actions/runs/${runId}/attempts/${attempt}`]);
    if (!verifiedRun({ ...input, run })) return unavailable('Run repository, attempt or examined-head association is unavailable or mismatched.');
    if (!/^\.github\/workflows\/[\w.-]+\.ya?ml$/.test(run.path ?? '')) return unavailable('Executed workflow path is unavailable or reusable.');
    const listing = json(['api', `${root}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`]);
    if (!Array.isArray(listing.jobs) || listing.total_count !== listing.jobs.length || listing.jobs.length > 100) return unavailable('Job list is incomplete or malformed.');
    const jobs = listing.jobs;
    const failed = jobs.filter((j) => j.conclusion === 'failure');
    if (failed.length > 8) return unavailable('Failed jobs exceed the bounded diagnostic limit (8).');
    const logs = {};
    for (const job of failed) {
      if (!positive(job.id)) return unavailable('Job identifier is malformed.');
      try { logs[job.id] = get(['run', 'view', String(runId), '--repo', repo, '--attempt', String(attempt), '--job', String(job.id), '--log']); }
      catch { /* Partial evidence is explained by the formatter. */ }
    }
    const file = json(['api', `${root}/contents/${run.path}?ref=${run.head_sha}`]);
    if (file.encoding !== 'base64' || typeof file.content !== 'string') return unavailable('Executed workflow content is unavailable.');
    let workflow = Buffer.from(file.content, 'base64').toString('utf8');
    let workflowRevision = run.head_sha;
    let workflowCommit;
    if (run.head_sha.toLowerCase() !== headSha.toLowerCase()) {
      workflowCommit = json(['api', `${root}/git/commits/${run.head_sha}`]);
      if (workflowCommit.sha !== run.head_sha || !Array.isArray(workflowCommit.parents) || workflowCommit.parents.length !== 2
        || !workflowCommit.parents.some((p) => p.sha === headSha)) return unavailable('Run merge revision does not establish the examined PR head.');
    }
    // PR run.head_sha may name the PR head while Actions executes the synthetic merge.
    // Recover the default source checkout's exact commit from its successful log, verify
    // its parents through GitHub, then read the workflow at THAT immutable revision.
    if (run.event === 'pull_request' && run.head_sha.toLowerCase() === headSha.toLowerCase()) {
      const revisions = sourceCheckoutRevisions(workflow, jobs, logs, repo);
      if (revisions.length !== 1) return unavailable('Executed PR merge revision unavailable or ambiguous in source-checkout evidence.');
      workflowRevision = revisions[0];
      const commit = json(['api', `${root}/git/commits/${workflowRevision}`]);
      if (commit.sha !== workflowRevision || !Array.isArray(commit.parents) || commit.parents.length !== 2
        || !commit.parents.some((p) => p.sha === headSha)) return unavailable('Executed merge revision does not establish the examined PR head.');
      const executed = json(['api', `${root}/contents/${run.path}?ref=${workflowRevision}`]);
      if (executed.encoding !== 'base64' || typeof executed.content !== 'string') return unavailable('Executed merge workflow is unavailable.');
      workflow = Buffer.from(executed.content, 'base64').toString('utf8');
      const confirmed = sourceCheckoutRevisions(workflow, jobs, logs, repo);
      if (confirmed.length !== 1 || confirmed[0] !== workflowRevision) return unavailable('Executed workflow does not confirm the source-checkout evidence.');
    }
    let secrets;
    let observedAt;
    try {
      secrets = json(['secret', 'list', '--repo', repo, '--json', 'name,updatedAt']);
      observedAt = now();
    } catch { /* Never copy command errors, which can contain credentials. */ }
    return diagnoseCiAuth({ ...input, run, jobs, logs, workflow, workflowRevision, workflowCommit, secrets, observedAt });
  } catch {
    return unavailable('GitHub evidence unavailable (read denied, timeout, throttling refusal or malformed response).');
  }
}

/** Human-readable appendix; no logs, unrelated fields or raw command errors. */
export function renderCiAuthDiagnosis(d = {}) {
  const lines = ['CI authentication evidence'];
  if (SLUG.test(d.repo)) lines.push(`Consuming repository: ${d.repo}`);
  if (positive(d.runId) && positive(d.attempt)) lines.push(`Run/attempt: ${d.runId}/${d.attempt}`);
  if (SHA.test(d.revision)) lines.push(`Workflow revision: ${d.revision}`);
  if (d.job) lines.push(`Failed job: ${label(d.job)}${d.jobKey ? ` (workflow job ${label(d.jobKey)})` : ''}`);
  if (d.step) lines.push(`Failed step: ${label(d.step)}`);
  if (SECRET.test(d.secret ?? '')) lines.push(`Credential referenced by the failed step: ${d.secret}`);
  if (d.secret) lines.push(`Repository secret last updated: ${timestamp(d.updatedAt) ? d.updatedAt : 'unavailable'}. Metadata observed now: ${timestamp(d.observedAt) ? d.observedAt : 'unavailable'}; not incident-time metadata.`);
  for (const failure of d.failures ?? []) {
    lines.push(`Correlated failure: ${label(failure.job)} / ${label(failure.step)}${SECRET.test(failure.secret ?? '') ? ` → ${failure.secret}` : ' → unresolved'}`);
  }
  if (d.detail) lines.push(`Diagnostic: ${label(d.detail)}`);
  if (d.status === 'resolved' && d.repositorySecret === true && SLUG.test(d.repo) && SECRET.test(d.secret ?? '')) {
    lines.push(`Operator rotation command (prompts for replacement; not executed):\n\`gh secret set ${d.secret} --repo ${d.repo}\``);
  }
  return lines.join('\n');
}
