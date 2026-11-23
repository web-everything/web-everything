// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { requiredChecksGreen } from '../deploy-required-checks.mjs';

const workflow = yaml.load(readFileSync(new URL('../../../.github/workflows/deploy.yml', import.meta.url), 'utf8'));
const guard = Object.values(workflow.jobs).flatMap(job => job.steps ?? [])
  .find(step => step.name === 'Refuse an unverified SHA').run;
const collection = guard.match(/\| jq -s '([^']+)'/)[1];
const evaluation = guard.match(/checks_ok=\$\(printf[^\n]+\| jq -r '([^']+)'/)[1];
const script = fileURLToPath(new URL('../deploy-required-checks.mjs', import.meta.url));
const run = (command, args, input) => spawnSync(command, args, {
  input, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
});
const serialize = pages => pages.map(check_runs => JSON.stringify({ check_runs }, null, 2)).join('\n');
const check = (name, conclusion = 'success', started_at = '2026-11-22T10:00:00Z') => ({ name, conclusion, started_at });
const eighty = Array.from({ length: 80 }, (_, index) => check(`test-shard (${index + 1})`));
eighty[0] = check('test');
eighty[65] = check('smoke');
const cases = [
  ['success on page 2 (80 runs, smoke after position 30)', [eighty.slice(0, 30), eighty.slice(30)], true],
  ['pending smoke', [[check('test'), check('smoke', null)]], false],
  ['failed smoke', [[check('test'), check('smoke', 'failure')]], false],
  ['cancelled smoke', [[check('test'), check('smoke', 'cancelled')]], false],
  ['skipped smoke', [[check('test'), check('smoke', 'skipped')]], false],
  ['missing smoke', [[check('test')]], false],
  ['missing test', [[check('smoke')]], false],
  ['green-then-red rerun across pages', [[check('test'), check('smoke')], [check('smoke', 'failure', '2026-11-22T11:00:00Z')]], false],
  ['latest run by started_at regardless of response order', [[check('test'), check('smoke', 'failure', '2026-11-22T11:00:00Z'), check('smoke')]], false],
  ['name drift self / smoke', [[check('test'), check('self / smoke')]], false],
  ['name drift self / test', [[check('self / test'), check('smoke')]], false],
  ['unrelated failures ignored', [[check('test'), check('smoke'), check('self / test', 'failure'), check('test-shard (1)', 'failure')]], true],
  ['empty evidence', [[]], false],
];

describe('deploy required checks', () => {
  it('fetches all complete pages before evaluating (no checkout required)', () => {
    expect(guard).toContain('gh api --paginate "repos/${{ github.repository }}/commits/$DEPLOY_SHA/check-runs?filter=latest&per_page=100"');
    expect(guard.slice(guard.indexOf('got=$('), guard.indexOf('echo "required check-runs'))).not.toContain('--jq');
    expect(requiredChecksGreen(eighty.slice(0, 30))).toBe(false);
  });

  it.each(cases)('%s: helper, CLI and workflow jq agree', (_name, pages, expected) => {
    expect(requiredChecksGreen(pages.flat())).toBe(expected);
    const input = serialize(pages);
    const cli = run(process.execPath, [script], input);
    expect(cli.status, cli.stderr).toBe(0);
    expect(cli.stdout.trim()).toBe(String(expected));
    const collected = run('jq', ['-s', collection], input);
    expect(collected.status, collected.stderr).toBe(0);
    const evaluated = run('jq', ['-r', evaluation], collected.stdout);
    expect(evaluated.status, evaluated.stderr).toBe(0);
    expect(evaluated.stdout.trim()).toBe(String(expected));
  });

  it.each(['', '{}', '{"check_runs":', serialize([[check('test'), check('smoke')]]) + '\n{'])
    ('CLI and workflow refuse unreadable or incomplete evidence: %j', input => {
      const cli = run(process.execPath, [script], input);
      expect(cli.status).not.toBe(0);
      expect(cli.stdout.trim()).toBe('false');
      const collected = run('jq', ['-s', collection], input);
      if (collected.status === 0) {
        expect(run('jq', ['-r', evaluation], collected.stdout).stdout.trim()).toBe('false');
      }
    });
});
