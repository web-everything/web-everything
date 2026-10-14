/**
 * The required `daemon-soak` aggregator's gate step (`.github/workflows/ci.yml`) must fail CLOSED. GitHub job
 * conclusions can't be exercised from a clone, so this test lifts the step's real shell script out of ci.yml,
 * substitutes the `${{ needs.* }}` expressions the runner would, and runs it with bash. Guards the PR #2770
 * review finding: a crashed `daemon-soak-scope` leaves `outputs.run` empty, which must NOT read as "no daemon
 * code touched".
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { REPO_ROOT } from '../shard-files.mjs';

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

function runGate({ scopeResult, run, shardResult }) {
  const values = {
    'needs.daemon-soak-scope.result': scopeResult,
    'needs.daemon-soak-scope.outputs.run': run,
    'needs.soak-shard.result': shardResult,
  };
  const script = gateScript().replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_, expr) => {
    if (!(expr in values)) throw new Error(`gate script reads an unmodelled expression: ${expr}`);
    return values[expr];
  });
  return spawnSync('bash', ['-e', '-c', script], { encoding: 'utf8' }).status;
}

describe('daemon-soak aggregator gate (ci.yml) fails closed', () => {
  it('passes when scope succeeded and found no daemon code (shards skipped)', () => {
    expect(runGate({ scopeResult: 'success', run: 'false', shardResult: 'skipped' })).toBe(0);
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

  it('on a non-PR event the scope step always says run (no path filter on main)', () => {
    const yml = readFileSync(CI_YML, 'utf8');
    expect(yml).toContain(`if [ "\${{ github.event_name }}" != "pull_request" ]; then echo "run=true" >> "$GITHUB_OUTPUT"; exit 0; fi`);
  });
});
