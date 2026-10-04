import { describe, it, expect } from 'vitest';
import { collectCiAuthDiagnosis, diagnoseCiAuth, renderCiAuthDiagnosis } from '../ci-auth-diagnosis.mjs';

const repo = 'web-everything/web-everything';
const headSha = 'a'.repeat(40);
const revision = 'b'.repeat(40);
const input = { repo, headSha, runId: 36632379377, attempt: 1 };
const workflow = `jobs:
  build:
    steps:
      - name: Checkout FUI (sibling)
        uses: actions/checkout@v4
        with:
          repository: frontier-ui/frontierui
          token: \${{ secrets.FUI_READ_TOKEN }}
`;
function fixture() {
  return { ...input, workflowCommit: { sha: revision, parents: [{ sha: headSha }, { sha: 'c'.repeat(40) }] }, run: { id: input.runId, run_attempt: 1, repository: { full_name: repo }, head_sha: revision,
    event: 'pull_request', pull_requests: [{ head: { sha: headSha }, base: { repo: { full_name: repo } } }], path: '.github/workflows/ci.yml' },
  jobs: [{ id: 42, run_id: input.runId, run_attempt: 1, head_sha: revision, name: 'build', conclusion: 'failure',
    steps: [{ number: 2, name: 'Checkout FUI (sibling)', conclusion: 'failure' }] }], workflow,
  logs: { 42: 'build\tCheckout FUI (sibling)\t2026-09-29T21:20:00Z ##[error]Bad credentials' },
  secrets: [{ name: 'FUI_READ_TOKEN', updatedAt: '2026-09-30T00:00:00Z' }], observedAt: '2026-10-01T00:00:00Z' };
}

it('incident-shaped regression identifies the consuming repo, never the checkout destination', () => {
  const body = renderCiAuthDiagnosis(diagnoseCiAuth(fixture()));
  expect(body).toContain('Checkout FUI (sibling)');
  expect(body).toContain('gh secret set FUI_READ_TOKEN --repo web-everything/web-everything');
  expect(body).toContain('2026-09-30T00:00:00Z');
  expect(body).toContain('observed now');
  expect(body).not.toContain('--repo frontier-ui/frontierui');
  expect(body).not.toContain('expired');
});

const rendered = (e) => renderCiAuthDiagnosis(diagnoseCiAuth(e));
const noRotation = (e, detail) => {
  const body = rendered(e);
  expect(body).not.toContain('gh secret set');
  if (detail) expect(body).toContain(detail);
  return body;
};

describe('deterministic attribution', () => {
  it.each(["secrets['FUI_READ_TOKEN']", 'secrets["FUI_READ_TOKEN"]'])('supports literal brackets: %s', (ref) => {
    const e = fixture(); e.workflow = e.workflow.replace('secrets.FUI_READ_TOKEN', ref);
    expect(rendered(e)).toContain('gh secret set FUI_READ_TOKEN --repo web-everything/web-everything');
  });
  it('does not choose the first identically named step in another job', () => {
    const e = fixture();
    e.workflow = e.workflow.replace('  build:', '  unrelated:\n    steps:\n      - name: Checkout FUI (sibling)\n        uses: actions/checkout@v4\n        with:\n          token: ${{ secrets.WRONG }}\n  build:');
    expect(rendered(e)).toContain('gh secret set FUI_READ_TOKEN');
    expect(rendered(e)).not.toContain('WRONG');
  });
  it('matches step ordinal as well as name', () => {
    const e = fixture(); e.jobs[0].steps[0].number = 3;
    noRotation(e, 'cannot be matched');
  });
  it('resolves finite matrix job instances', () => {
    const e = fixture(); e.workflow = e.workflow.replace('    steps:', '    strategy:\n      matrix:\n        shard: [1, 2]\n    steps:');
    e.jobs[0].name = 'build (2)'; e.logs[42] = e.logs[42].replace(/^build/, 'build (2)');
    expect(rendered(e)).toContain('gh secret set FUI_READ_TOKEN');
  });
  it('resolves explicitly named finite matrix instances', () => {
    const e = fixture(); e.workflow = e.workflow.replace('    steps:', '    name: suite ${{ matrix.shard }}\n    strategy:\n      matrix:\n        shard: [1, 2]\n    steps:');
    e.jobs[0].name = 'suite 2'; e.logs[42] = e.logs[42].replace(/^build/, 'suite 2');
    expect(rendered(e)).toContain('gh secret set FUI_READ_TOKEN');
  });
  it.each(['repo', 'head', 'attempt', 'job-attempt', 'job-head', 'pr-base'])('refuses mismatched %s', (field) => {
    const e = fixture();
    if (field === 'repo') e.run.repository.full_name = 'frontier-ui/frontierui';
    if (field === 'head') e.headSha = 'c'.repeat(40);
    if (field === 'attempt') e.run.run_attempt = 2;
    if (field === 'job-attempt') e.jobs[0].run_attempt = 2;
    if (field === 'job-head') e.jobs[0].head_sha = 'c'.repeat(40);
    if (field === 'pr-base') e.run.pull_requests[0].base.repo.full_name = 'other/repo';
    noRotation(e);
  });
  it('allows multiple failed steps when only one has authentication evidence', () => {
    const e = fixture(); e.jobs[0].steps.push({ number: 3, name: 'cleanup', conclusion: 'failure' });
    e.logs[42] += '\nbuild\tcleanup\t##[error]Disk full';
    expect(rendered(e)).toContain('gh secret set FUI_READ_TOKEN');
    e.logs[42] += '\nbuild\tcleanup\t##[error]Bad credentials';
    noRotation(e, 'Multiple authentication failures');
  });
});

describe('partial evidence never guesses ownership or leaks irrelevant data', () => {
  it.each(['dynamic', 'multiple', 'environment', 'reusable', 'unmatchable', 'matrix-expression', 'non-auth', 'no-logs', 'malformed', 'no-entry', 'denied'])('%s', (kind) => {
    const e = fixture();
    if (kind === 'dynamic') e.workflow = e.workflow.replace('secrets.FUI_READ_TOKEN', 'secrets[inputs.key]');
    if (kind === 'multiple') e.workflow = e.workflow.replace('secrets.FUI_READ_TOKEN', 'secrets.FUI_READ_TOKEN || secrets.OTHER');
    if (kind === 'environment') e.workflow = e.workflow.replace('    steps:', '    environment: production\n    steps:');
    if (kind === 'reusable') e.workflow = 'jobs:\n  build:\n    uses: org/repo/.github/workflows/reuse.yml@main';
    if (kind === 'unmatchable') e.workflow = e.workflow.replace('  build:', '  other:');
    if (kind === 'matrix-expression') e.workflow = e.workflow.replace('    steps:', '    strategy:\n      matrix: ${{ fromJSON(inputs.matrix) }}\n    steps:');
    if (kind === 'non-auth') e.logs[42] = e.logs[42].replace('Bad credentials', 'Disk full');
    if (kind === 'no-logs') delete e.logs[42];
    if (kind === 'malformed') e.workflow = '{ invalid yaml';
    if (kind === 'no-entry') e.secrets = [];
    if (kind === 'denied') delete e.secrets;
    e.run.irrelevant = 'CANARY_SECRET_VALUE';
    e.secrets?.push({ name: 'UNRELATED', value: 'CANARY_SECRET_VALUE' });
    e.logs[42] = (e.logs[42] ?? '') + '\nunrelated\tstep\tCANARY_SECRET_VALUE';
    expect(noRotation(e)).not.toContain('CANARY_SECRET_VALUE');
    if (['denied', 'no-entry'].includes(kind)) expect(rendered(e)).toContain('FUI_READ_TOKEN');
  });
  it('does not infer an update date from an unrelated secret or a malformed timestamp', () => {
    const e = fixture(); e.secrets[0].updatedAt = 'CANARY_SECRET_VALUE';
    expect(rendered(e)).toContain('last updated: unavailable');
    expect(rendered(e)).not.toContain('CANARY_SECRET_VALUE');
  });
});

function reader(e, calls, failAt) {
  return (args, options) => {
    calls.push(args);
    expect(options.timeout).toBe(15000);
    expect(options.throttle.maxAttempts).toBe(1);
    if (args[0] === failAt) throw new Error('CANARY_SECRET_VALUE');
    if (args[0] === 'secret') return JSON.stringify(e.secrets);
    if (args[0] === 'run') return e.logs[args[args.indexOf('--job') + 1]];
    if (args[1].includes('/git/commits/')) return JSON.stringify(e.workflowCommit);
    if (args[1].includes('/jobs?')) return JSON.stringify({ total_count: e.jobs.length, jobs: e.jobs });
    if (args[1].includes('/contents/')) return JSON.stringify({ encoding: 'base64', content: Buffer.from(e.workflow).toString('base64') });
    return JSON.stringify(e.run);
  };
}

describe('read-only collection bounds and failure isolation', () => {
  it('reads the executed revision instead of any local workflow, with exact attempt and repo', () => {
    const e = fixture(), calls = [];
    const result = collectCiAuthDiagnosis(input, { read: reader(e, calls), now: () => e.observedAt });
    expect(result.status).toBe('resolved');
    expect(calls).toContainEqual(['api', `repos/${repo}/contents/.github/workflows/ci.yml?ref=${revision}`]);
    expect(calls).toContainEqual(['run', 'view', String(input.runId), '--repo', repo, '--attempt', '1', '--job', '42', '--log']);
    expect(calls).toContainEqual(['secret', 'list', '--repo', repo, '--json', 'name,updatedAt']);
    expect(calls).toHaveLength(6);
  });
  it.each(['timeout', 'throttling refusal', 'malformed response'])('returns bounded unavailable on %s', (kind) => {
    const result = collectCiAuthDiagnosis(input, { read: () => {
      if (kind === 'malformed response') return 'CANARY_SECRET_VALUE';
      throw new Error(`${kind}: CANARY_SECRET_VALUE`);
    } });
    expect(result.status).toBe('unavailable');
    expect(JSON.stringify(result)).not.toContain('CANARY_SECRET_VALUE');
  });
  it.each(['secret', 'run'])('retains truthful partial evidence when %s read fails', (failAt) => {
    const calls = [], e = fixture();
    const d = collectCiAuthDiagnosis(input, { read: reader(e, calls, failAt) });
    expect(renderCiAuthDiagnosis(d)).not.toContain('gh secret set');
    expect(JSON.stringify(d)).not.toContain('CANARY_SECRET_VALUE');
    if (failAt === 'secret') expect(d.secret).toBe('FUI_READ_TOKEN');
    if (failAt === 'run') expect(d.detail).toContain('logs are unavailable');
  });
  it('refuses incomplete job pagination and excessive failed jobs', () => {
    const e = fixture();
    const read = reader(e, []);
    const d = collectCiAuthDiagnosis(input, { read: (args, opts) => args[1]?.includes('/jobs?') ? '{"jobs":[],"total_count":101}' : read(args, opts) });
    expect(d.detail).toContain('incomplete');
    e.jobs = Array.from({ length: 9 }, () => e.jobs[0]);
    expect(collectCiAuthDiagnosis(input, { read: reader(e, []) }).detail).toContain('limit');
  });
  it('does no reads with missing explicit context, and stops at a run mismatch', () => {
    const calls = [], e = fixture();
    collectCiAuthDiagnosis({ ...input, repo: undefined }, { read: reader(e, calls) });
    expect(calls).toHaveLength(0);
    e.run.run_attempt = 2;
    collectCiAuthDiagnosis(input, { read: reader(e, calls) });
    expect(calls).toHaveLength(1);
  });
  it('repeated synthetic replay is stable and never retains a previous secret across calls (50 passes)', () => {
    for (let i = 0; i < 50; i++) {
      const e = fixture();
      if (i % 2) e.secrets = [];
      const d = collectCiAuthDiagnosis(input, { read: reader(e, []), now: () => e.observedAt });
      expect(renderCiAuthDiagnosis(d).includes('gh secret set')).toBe(i % 2 === 0);
    }
  });
});

it('multiple failing jobs produce one rotation target only when all references agree', () => {
  const e = fixture();
  e.workflow += e.workflow.slice('jobs:\n'.length).replace('  build:', '  smoke:');
  e.jobs.push({ ...e.jobs[0], id: 43, name: 'smoke' });
  e.logs[43] = e.logs[42].replace(/^build/, 'smoke');
  expect(rendered(e)).toContain('gh secret set FUI_READ_TOKEN');
  expect(diagnoseCiAuth(e).failures).toHaveLength(2);
  e.workflow = e.workflow.replace(/FUI_READ_TOKEN(?=[^]*$)/, 'OTHER');
  noRotation(e, 'different credential references');
});

it('does not conflate two workflow jobs with the same displayed name', () => {
  const e = fixture();
  e.workflow += e.workflow.slice('jobs:\n'.length).replace('  build:', '  other:\n    name: build');
  noRotation(e, 'ambiguous');
});

describe('PR head versus executed merge workflow', () => {
  function mergeFixture() {
    const e = fixture();
    e.run.head_sha = headSha;
    e.jobs[0].head_sha = headSha;
    e.jobs[0].steps[0].number = 3;
    e.jobs[0].steps.unshift({ name: 'Checkout WE', number: 2, conclusion: 'success' });
    e.workflow = e.workflow.replace('    steps:', '    steps:\n      - name: Checkout WE\n        uses: actions/checkout@v4');
    e.logs[42] += `\nbuild\tCheckout WE\t2026-09-29T21:20:00Z [command]/usr/bin/git log -1 --format='%H'\nbuild\tCheckout WE\t2026-09-29T21:20:00Z ${revision}`;
    return e;
  }
  function mergeReader(e, calls, parents = [headSha, 'c'.repeat(40)]) {
    const read = reader(e, calls);
    return (args, opts) => {
      if (args[1]?.includes('/git/commits/')) {
        calls.push(args);
        return JSON.stringify({ sha: revision, parents: parents.map((sha) => ({ sha })) });
      }
      return read(args, opts);
    };
  }
  it('verifies merge parents and fetches the executed workflow rather than the reported PR head', () => {
    const e = mergeFixture(), calls = [];
    const read = mergeReader(e, calls);
    const d = collectCiAuthDiagnosis(input, { now: () => e.observedAt, read: (args, opts) => {
      const out = read(args, opts);
      // Only the final workflow revision has the correct credential; the provisional head is not evidence.
      if (args[1]?.endsWith(`?ref=${headSha}`)) return JSON.stringify({ encoding: 'base64', content: Buffer.from(e.workflow.replace('FUI_READ_TOKEN', 'WRONG_HEAD_SECRET')).toString('base64') });
      return out;
    } });
    expect(d.revision).toBe(revision);
    expect(d.status).toBe('resolved');
    expect(d.secret).toBe('FUI_READ_TOKEN');
    expect(calls).toContainEqual(['api', `repos/${repo}/git/commits/${revision}`]);
    expect(calls).toContainEqual(['api', `repos/${repo}/contents/.github/workflows/ci.yml?ref=${revision}`]);
  });
  it('unverifiable merge parents, overridden checkout refs and missing merge logs never guess', () => {
    const e = mergeFixture();
    expect(collectCiAuthDiagnosis(input, { read: mergeReader(e, [], ['d'.repeat(40), 'c'.repeat(40)]) }).status).toBe('unavailable');
    e.workflow = e.workflow.replace('      - name: Checkout WE', '      - with:\n          ref: main\n        name: Checkout WE');
    expect(collectCiAuthDiagnosis(input, { read: mergeReader(e, []) }).status).toBe('unavailable');
    delete e.logs[42];
    expect(collectCiAuthDiagnosis(input, { read: mergeReader(e, []) }).status).toBe('unavailable');
  });
});

it('repeated step labels within one job cannot borrow authentication logs from another step', () => {
  const e = fixture();
  e.jobs[0].steps.push({ ...e.jobs[0].steps[0], number: 3, conclusion: 'success' });
  noRotation(e, 'log attribution ambiguous');
});

it('malformed bracket quotes cannot establish a secret reference', () => {
  const e = fixture();
  e.workflow = e.workflow.replace('secrets.FUI_READ_TOKEN', `secrets['FUI_READ_TOKEN"]`);
  noRotation(e, 'not a single literal');
});

it('a PR association cannot relabel an older run as a newly pushed head without merge-parent evidence', () => {
  const e = fixture();
  e.workflowCommit.parents = [{ sha: 'd'.repeat(40) }, { sha: 'c'.repeat(40) }];
  noRotation(e, 'PR association alone is insufficient');
  const d = collectCiAuthDiagnosis(input, { read: reader(e, []) });
  expect(d.status).toBe('unavailable');
  expect(renderCiAuthDiagnosis(d)).not.toContain('gh secret set');
});
