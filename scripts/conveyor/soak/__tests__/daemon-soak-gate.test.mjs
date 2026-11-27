/**
 * The required `daemon-soak` aggregator's gate step (`.github/workflows/ci.yml`) must fail CLOSED. GitHub job
 * conclusions can't be exercised from a clone, so this test lifts the step's real shell script out of ci.yml,
 * substitutes the `${{ needs.* }}` expressions the runner would, and runs it with bash. Guards the PR #2770
 * review finding: a crashed `daemon-soak-scope` leaves `outputs.run` empty, which must NOT read as "no daemon
 * code touched".
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { REPO_ROOT } from '../shard-files.mjs';
import * as postmerge from '../soak-scope.mjs';

const CI_YML = join(REPO_ROOT, '.github', 'workflows', 'ci.yml');

/** The `run: |` body of the `daemon-soak` job's "Gate on shard results" step, de-indented. */
function gateScript() {
  const lines = readFileSync(CI_YML, 'utf8').split('\n');
  const jobAt = lines.findIndex((l) => l === '  daemon-soak:');
  if (jobAt < 0) throw new Error('ci.yml: no `daemon-soak` job');
  const nextJob = lines.findIndex((l, i) => i > jobAt && /^  [\w-]+:\s*$/.test(l));
  const jobEnd = nextJob < 0 ? lines.length : nextJob;
  const stepAt = lines.findIndex((l, i) => i > jobAt && i < jobEnd && /^\s+- name: Gate on shard results$/.test(l));
  if (stepAt < 0) throw new Error('ci.yml: `daemon-soak` has no "Gate on shard results" step');
  const runAt = lines.findIndex((l, i) => i > stepAt && i < jobEnd && /^\s+run: \|$/.test(l));
  if (runAt < 0) throw new Error('ci.yml: "Gate on shard results" step has no `run: |` block');
  const indent = lines[runAt + 1].match(/^\s*/)[0];
  const body = [];
  for (let i = runAt + 1; i < lines.length && (lines[i].startsWith(indent) || lines[i].trim() === ''); i += 1) {
    body.push(lines[i].slice(indent.length));
  }
  return body.join('\n');
}

function runGate({ scopeResult, run, shardResult, event = 'merge_group', shards }) {
  const values = {
    'github.event_name': event,
    'needs.daemon-soak-scope.result': scopeResult,
    'needs.daemon-soak-scope.outputs.run': run,
    'needs.daemon-soak-scope.outputs.shards': shards ?? (run === 'false' ? '[1]' : '[1,2,3,4,5,6,7,8]'),
    'needs.soak-shard.result': shardResult,
  };
  const script = gateScript().replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_, expr) => {
    if (!(expr in values)) throw new Error(`gate script reads an unmodelled expression: ${expr}`);
    return values[expr];
  });
  return spawnSync('bash', ['-e', '-c', script], { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '/dev/null' } }).status;
}

describe('daemon-soak aggregator gate (ci.yml) fails closed', () => {
  // R1068: soak shards run only in merge_group / main push / dispatch; on a pull_request the aggregator succeeds.
  it('passes on pull_request with no shards, whatever the scope says', () => {
    for (const run of ['', 'false', 'true']) {
      for (const scopeResult of ['success', 'failure', 'skipped']) {
        expect(runGate({ event: 'pull_request', scopeResult, run, shardResult: 'skipped' })).toBe(0);
      }
    }
  });

  it('fails on push / dispatch when scope says run=false (soak may not be skipped)', () => {
    for (const event of ['push', 'workflow_dispatch']) {
      expect(runGate({ event, scopeResult: 'success', run: 'false', shardResult: 'success' }), event).not.toBe(0);
    }
  });

  // CI-SOAK-SCOPE-MQ: the merge queue may skip shards 2-8 on a docs-only change, but shard 1 must still pass.
  it('merge_group with run=false passes only when shard 1 succeeded', () => {
    expect(runGate({ event: 'merge_group', scopeResult: 'success', run: 'false', shardResult: 'success' })).toBe(0);
    for (const shardResult of ['skipped', 'failure', 'cancelled', '']) {
      expect(runGate({ event: 'merge_group', scopeResult: 'success', run: 'false', shardResult }), shardResult).not.toBe(0);
    }
  });

  it('fails when the shards output disagrees with run (run=true with [1], run=false with other shards)', () => {
    expect(runGate({ scopeResult: 'success', run: 'true', shards: '[1]', shardResult: 'success' })).not.toBe(0);
    expect(runGate({ scopeResult: 'success', run: 'false', shards: '[2]', shardResult: 'success' })).not.toBe(0);
    expect(runGate({ scopeResult: 'success', run: 'false', shards: '', shardResult: 'success' })).not.toBe(0);
  });

  it('the shard matrix is decided by the scope job: shard 1 always, shards 2-8 only on run=true or any error', () => {
    const yml = readFileSync(CI_YML, 'utf8');
    expect(yml).toContain('shard: ${{ fromJSON(needs.daemon-soak-scope.outputs.shards) }}');
    expect(yml).toContain("echo 'shards=[1]' >> \"$GITHUB_OUTPUT\"");
    expect(yml).toContain('trap ');
    // The shard total is fixed at 8: strategy.job-total would be 1 when only shard 1 runs.
    expect(yml).not.toMatch(/--shard=\$\{\{ matrix\.shard \}\}\/\$\{\{ strategy\.job-total \}\}.*soak-shard/);
    expect(yml).toContain('npm run test:soak:shard -- --shard=${{ matrix.shard }}/8');
  });

  it('fails in merge_group when the shards are skipped, failed, cancelled or timed out', () => {
    for (const shardResult of ['skipped', 'failure', 'cancelled', '']) {
      expect(runGate({ event: 'merge_group', scopeResult: 'success', run: 'true', shardResult }), shardResult).not.toBe(0);
    }
  });

  it('the soak-shard job never runs on a pull_request', () => {
    expect(jobIf('soak-shard')).toMatch(/github\.event_name != 'pull_request'/);
  });

  it('passes when scope said run and every shard succeeded', () => {
    expect(runGate({ scopeResult: 'success', run: 'true', shardResult: 'success' })).toBe(0);
  });

  it('fails when scope said run and a shard failed, was skipped, or was cancelled', () => {
    expect(runGate({ scopeResult: 'success', run: 'true', shardResult: 'failure' })).not.toBe(0);
    expect(runGate({ scopeResult: 'success', run: 'true', shardResult: 'skipped' })).not.toBe(0);
    expect(runGate({ scopeResult: 'success', run: 'true', shardResult: 'cancelled' })).not.toBe(0);
  });

  it('rejects a failed scope job with an absent run output (no false green)', () => {
    expect(runGate({ scopeResult: 'failure', run: '', shardResult: 'skipped' })).not.toBe(0);
  });

  it('rejects any non-success scope result, whatever its output says', () => {
    for (const scopeResult of ['failure', 'cancelled', 'skipped']) {
      for (const run of ['', 'false', 'true']) {
        expect(runGate({ scopeResult, run, shardResult: 'skipped' }), `${scopeResult}/${run || '<empty>'}`).not.toBe(0);
      }
    }
  });

  it('rejects a successful scope job that somehow emitted no run output', () => {
    expect(runGate({ scopeResult: 'success', run: '', shardResult: 'skipped' })).not.toBe(0);
  });
});

/** The `if:` line of a top-level ci.yml job. */
function jobIf(job) {
  const lines = readFileSync(CI_YML, 'utf8').split('\n');
  const at = lines.findIndex((l) => l === `  ${job}:`);
  if (at < 0) throw new Error(`ci.yml: no \`${job}\` job`);
  const next = lines.findIndex((l, i) => i > at && /^  [\w-]+:\s*$/.test(l));
  const hit = lines.slice(at + 1, next < 0 ? undefined : next).find((l) => /^    if: /.test(l));
  return hit ? hit.trim() : null;
}

// soak-main-red (2026-09-26): the soak ran on PRs only, so a regression that landed on main never turned main
// red — it showed up as a red `daemon-soak` on every unrelated daemon PR instead. It must run on main pushes.
describe('daemon-soak runs on main pushes, not only on PRs', () => {
  it('the scope job and the required aggregator both fire on a push to main', () => {
    for (const job of ['daemon-soak-scope', 'daemon-soak']) {
      const cond = jobIf(job);
      expect(cond, job).toMatch(/github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
      expect(cond, job).toMatch(/github\.event_name == 'pull_request'/);
    }
  });

  it('on push / dispatch the scope step always says run all 8 (no path filter on main); only merge_group is scoped', () => {
    const yml = readFileSync(CI_YML, 'utf8');
    expect(yml).toContain(`if [ "\${{ github.event_name }}" != "pull_request" ] && [ "\${{ github.event_name }}" != "merge_group" ]; then`);
    expect(yml).toContain(`echo "run=true" >> "$GITHUB_OUTPUT"; echo 'shards=[1,2,3,4,5,6,7,8]' >> "$GITHUB_OUTPUT"; exit 0`);
  });
});

// All release evidence is injected. No git, GitHub, clock, cwd, lanes or host state is read.
const mergedSha = 'a'.repeat(40);
const nextSha = 'b'.repeat(40);
const releaseRepo = 'fixture/project';
const receiptName = 'postmerge-soak-v1';
function releaseFixture() {
  const workflow = { id: 100, check_suite_id: 200, run_attempt: 1,
    head_sha: mergedSha, head_branch: 'main', event: 'push',
    repository: { full_name: releaseRepo }, head_repository: { full_name: releaseRepo },
    path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success' };
  const checks = ['test', 'smoke', 'daemon-soak', receiptName].map((name, i) => ({
    id: 300 + i, name, head_sha: mergedSha, app: { id: 15368 },
    check_suite: { id: 200 }, status: 'completed', conclusion: 'success',
    details_url: `https://github.com/${releaseRepo}/actions/runs/100/job/${400 + i}`,
  }));
  const jobs = [receiptName, ...Array.from({ length: 8 }, (_, i) => `soak-shard (${i + 1})`)]
    .map((name, i) => ({ id: 400 + i, name, head_sha: mergedSha,
      run_id: 100, run_attempt: 1, status: 'completed', conclusion: 'success' }));
  const state = { head: mergedSha, workflows: [workflow], checks, jobs };
  const calls = [];
  const request = async (route, args) => {
    calls.push({ route, args });
    if (route.endsWith('/git/ref/heads/main')) return { status: 200, data: { object: { sha: state.head } } };
    const key = route.endsWith('/check-runs') ? 'checks' : route.endsWith('/jobs') ? 'jobs' : 'workflows';
    const field = { checks: 'check_runs', jobs: 'jobs', workflows: 'workflow_runs' }[key];
    const rows = state[key];
    return { status: 200, data: { total_count: rows.length, [field]: rows.slice((args.page - 1) * 100, args.page * 100) } };
  };
  return { state, calls, request, input: { repo: releaseRepo, sha: mergedSha, now: () => 1000, request } };
}

describe('SOAK-POSTMERGE release hold', () => {
  it('merged head cannot release until its postmerge soak succeeds', async () => {
    const f = releaseFixture();
    f.state.checks.at(-1).status = 'queued';
    f.state.checks.at(-1).conclusion = null;
    expect((await postmerge.postmergeReleaseGate(f.input)).ok).toBe(false);
    f.state.checks.at(-1).status = 'completed';
    f.state.checks.at(-1).conclusion = 'success';
    expect((await postmerge.postmergeReleaseGate(f.input)).ok).toBe(true);
  });

  it('selects full soak only for merged main or an explicit main diagnostic; PR and queue keep fast checks', () => {
    for (const event of ['pull_request', 'merge_group']) {
      expect(postmerge.soakGatePhase({ event, ref: 'refs/heads/main' })).toBe('premerge');
    }
    for (const event of ['push', 'workflow_dispatch']) {
      expect(postmerge.soakGatePhase({ event, ref: 'refs/heads/main' })).toBe('postmerge');
    }
    expect(postmerge.soakGatePhase({ event: 'push', ref: 'refs/heads/other' })).toBe('refuse');
    expect(postmerge.soakGatePhase({})).toBe('refuse');
  });

  it('the receipt producer requires the full suite, exact run and a bounded attempt', () => {
    const input = { event: 'push', ref: 'refs/heads/main', sha: mergedSha, runId: 100, attempt: 1,
      scopeResult: 'success', run: 'true', shards: '[1,2,3,4,5,6,7,8]', shardResult: 'success', aggregateResult: 'success' };
    expect(postmerge.postmergeReceiptGate(input).ok).toBe(true);
    for (const patch of [
      { event: 'workflow_dispatch' }, { event: 'merge_group' }, { sha: 'short' }, { runId: null },
      { attempt: 3 }, { attempt: 0 }, { shards: '[1]' }, { run: 'false' },
      { scopeResult: 'failure' }, { shardResult: 'cancelled' }, { aggregateResult: 'skipped' },
    ]) expect(postmerge.postmergeReceiptGate({ ...input, ...patch }).ok, JSON.stringify(patch)).toBe(false);
  });

  it.each(['failure', 'cancelled', 'timed_out', 'skipped', null])('%s soak keeps the release held with an owner and recovery', async conclusion => {
    const f = releaseFixture();
    f.state.jobs[1].conclusion = conclusion;
    const result = await postmerge.postmergeReleaseGate(f.input);
    expect(result).toMatchObject({ ok: false, owner: 'repository-maintainers' });
    expect(result.reason).toBeTruthy();
    expect(result.recovery).toContain('rerun');
  });

  it.each(['checks', 'jobs', 'workflows'])('missing %s is a hold, including a process crash before publication', async key => {
    const f = releaseFixture();
    f.state[key] = [];
    expect((await postmerge.postmergeReleaseGate(f.input)).ok).toBe(false);
  });

  it.each([
    ['forged App with the same name', f => { f.state.checks.at(-1).app.id = 7; }],
    ['wrong workflow', f => { f.state.workflows[0].path = '.github/workflows/other.yml'; }],
    ['old suite version', f => { f.state.checks.at(-1).name = 'postmerge-soak-v0'; }],
    ['wrong head', f => { f.state.checks.at(-1).head_sha = nextSha; }],
    ['replayed suite', f => { f.state.checks.at(-1).check_suite.id = 201; }],
    ['PR workflow', f => { f.state.workflows[0].event = 'pull_request'; }],
    ['fork producer', f => { f.state.workflows[0].head_repository.full_name = 'fork/project'; }],
    ['replayed attempt', f => { f.state.jobs[0].run_attempt = 2; }],
    ['unbound job', f => { delete f.state.jobs[0].run_id; }],
    ['unbounded reruns', f => { f.state.workflows[0].run_attempt = 3; }],
    ['invalid run id', f => { delete f.state.workflows[0].id; }],
    ['duplicate check id', f => { f.state.checks.push({ ...f.state.checks.at(-1) }); }],
    ['duplicate job', f => { f.state.jobs.push({ ...f.state.jobs[0] }); }],
    ['active repair child', f => { f.state.jobs.push({ ...f.state.jobs[0], id: 499, name: 'repair', status: 'in_progress', conclusion: null }); }],
    ['malformed extra evidence', f => { f.state.checks.push(null); }],
  ])('%s cannot clear the hold', async (_name, change) => {
    const f = releaseFixture();
    change(f);
    expect((await postmerge.postmergeReleaseGate(f.input)).ok).toBe(false);
  });

  it('a bounded second attempt succeeds only with fresh attempt-bound jobs', async () => {
    const f = releaseFixture();
    f.state.workflows[0].run_attempt = 2;
    expect((await postmerge.postmergeReleaseGate(f.input)).ok).toBe(false);
    f.state.jobs.forEach(job => { job.run_attempt = 2; });
    expect((await postmerge.postmergeReleaseGate(f.input)).ok).toBe(true);
  });

  it('orders by authoritative ids even with absent, invalid or tied timestamps; a newer pending run holds', async () => {
    const f = releaseFixture();
    f.state.checks.forEach(check => { check.started_at = 'invalid'; });
    expect((await postmerge.postmergeReleaseGate(f.input)).ok).toBe(true);
    f.state.workflows.push({ ...f.state.workflows[0], id: 101, status: 'queued', conclusion: null });
    expect((await postmerge.postmergeReleaseGate(f.input)).ok).toBe(false);
  });

  it('two fast merges retain the old receipt without releasing the untested head', async () => {
    const f = releaseFixture();
    f.state.head = nextSha;
    expect((await postmerge.postmergeReleaseGate(f.input)).ok).toBe(false);
    expect((await postmerge.postmergeReleaseGate({ ...f.input, sha: nextSha })).ok).toBe(false);
    expect(f.state.checks.at(-1).head_sha).toBe(mergedSha);
  });

  it('re-reads evidence and main at the action boundary; an injected hold or head movement stops release', async () => {
    for (const moved of [false, true]) {
      const f = releaseFixture();
      let heads = 0;
      const request = async (route, args) => {
        if (route.endsWith('/git/ref/heads/main') && ++heads === 2) {
          if (moved) f.state.head = nextSha;
          else f.state.checks.at(-1).conclusion = 'failure';
        }
        return f.request(route, args);
      };
      expect((await postmerge.postmergeReleaseGate({ ...f.input, request })).ok).toBe(false);
    }
  });

  it('a main move during the final job read still refuses release', async () => {
    const f = releaseFixture();
    let jobs = 0;
    const request = async (route, args) => {
      const result = await f.request(route, args);
      if (route.endsWith('/jobs') && ++jobs === 2) f.state.head = nextSha;
      return result;
    };
    expect((await postmerge.postmergeReleaseGate({ ...f.input, request })).ok).toBe(false);
  });

  it('a hung reader times out to a named hold and aborts its request', async () => {
    vi.useFakeTimers();
    try {
      const f = releaseFixture();
      let signal;
      const pending = postmerge.postmergeReleaseGate({ ...f.input, request: (_route, args) => {
        signal = args.request.signal;
        return new Promise(() => {});
      } });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await pending).toMatchObject({ ok: false, reason: expect.stringContaining('postmerge-request-timeout') });
      expect(signal.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('a request completing after the overall deadline cannot clear the hold', async () => {
    const f = releaseFixture();
    let elapsed = 0;
    let jobs = 0;
    const request = async (route, args) => {
      const response = await f.request(route, args);
      if (route.endsWith('/jobs') && ++jobs === 2) elapsed = 60_001;
      return response;
    };
    expect((await postmerge.postmergeReleaseGate({ ...f.input, now: () => elapsed, request })).ok).toBe(false);
  });

  it.each(['throw', 'malformed', 'oversized', 'incomplete', 'clock'])('%s evidence holds visibly without any write or fallback', async kind => {
    const f = releaseFixture();
    const request = async (route, args) => {
      if (kind === 'throw') throw new Error('injected read failure');
      if (kind === 'malformed') return { status: 200, data: null };
      if (kind === 'oversized') return { status: 200, data: { total_count: 301, workflow_runs: [] } };
      if (kind === 'incomplete' && route.endsWith('/runs')) return { status: 200, data: { total_count: 2, workflow_runs: [] } };
      return f.request(route, args);
    };
    const result = await postmerge.postmergeReleaseGate({ ...f.input, request,
      now: kind === 'clock' ? () => NaN : f.input.now });
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
    expect(result.recovery).toBeTruthy();
    expect(f.calls.every(call => call.route.startsWith('GET '))).toBe(true);
    expect(f.calls.length).toBeLessThanOrEqual(24);
  });
});
