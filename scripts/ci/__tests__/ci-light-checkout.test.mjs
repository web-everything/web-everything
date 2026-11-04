// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import yaml from 'js-yaml';

const raw = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const { jobs } = yaml.load(raw);
const fetchMain = 'git fetch --no-tags --filter=blob:none --depth=1000000 origin +refs/heads/main:refs/remotes/origin/main';
// Historical full-history WE checkouts; `test` is intentionally gone from this roster.
const historyJobs = ['changes', 'standards', 'integration', 'daemon-soak-scope'];

describe('ci.yml shallow checkouts with blobless main history', () => {
  it('only unit test-shard and soak-shard use full history for live-git tests and quarantine ancestry', () => {
    expect(raw.match(/fetch-depth:\s*0\b/g)).toHaveLength(2);
    for (const [name, path] of [['test-shard', 'web-everything'], ['soak-shard', undefined]]) {
      const c = jobs[name].steps.find((s) => s.uses?.startsWith('actions/checkout@') && s.with?.path === path);
      expect(c.with['fetch-depth'], name).toBe(0);
    }
  });

  it.each(historyJobs)('%s retains its history-dependent checkout at depth 50', (name) => {
    const checkouts = jobs[name].steps.filter((s) => s.uses?.startsWith('actions/checkout@') && !s.with?.repository);
    expect(checkouts).toHaveLength(1);
    expect(checkouts[0].with['fetch-depth']).toBe(50);
  });

  it('every depth-50 checkout immediately fetches blobless main in the checkout directory', () => {
    for (const [name, job] of Object.entries(jobs)) {
      for (const [index, step] of (job.steps ?? []).entries()) {
        if (!step.uses?.startsWith('actions/checkout@') || step.with?.['fetch-depth'] !== 50) continue;
        const next = job.steps[index + 1];
        if (name === 'changes') {
          expect(job.steps.some((s) => s.name === 'Fetch main history (blobless)')).toBe(false);
          expect(next.run).toMatch(/git fetch --no-tags --filter=blob:none --depth=1000000 origin ['"]?\+refs\/heads\/main:refs\/remotes\/origin\/main['"]?/);
        } else {
          expect(next.name, name).toBe('Fetch main history (blobless)');
          expect(next.run.trim(), name).toBe(fetchMain);
          expect(next['working-directory']).toBe(step.with?.path);
          expect(next.if).toBe(step.if);
        }
      }
    }
  });

  it('depth-50 checkout plus the documented deep main fetch preserves the real merge base (local Git only)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-light-checkout-'));
    const origin = join(dir, 'origin');
    const checkout = join(dir, 'checkout');
    const git = (cwd, args, input) => execFileSync('git', args, {
      cwd, input, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
        GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' },
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    try {
      mkdirSync(origin);
      git(origin, ['init', '--bare', '-q']);
      git(origin, ['config', 'uploadpack.allowFilter', 'true']);
      const tree = git(origin, ['mktree'], '');
      const commit = (parent, message) => git(origin, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message]);
      let base;
      for (let i = 0; i < 55; i++) base = commit(base, `common ${i}`);
      const feature = commit(base, 'feature');
      let main = base;
      for (let i = 0; i < 55; i++) main = commit(main, `main ${i}`);
      git(origin, ['update-ref', 'refs/heads/main', main]);
      git(origin, ['update-ref', 'refs/heads/feature', feature]);
      git(dir, ['clone', '-q', '--no-tags', '--depth=50', '--branch=feature', '--single-branch', pathToFileURL(origin).href, checkout]);
      expect(git(checkout, ['rev-parse', '--is-shallow-repository'])).toBe('true');
      // The ref is absent before the additional fetch, so this cannot pass on clone defaults alone.
      expect(() => git(checkout, ['rev-parse', '--verify', 'origin/main'])).toThrow();
      git(checkout, fetchMain.split(' ').slice(1));
      expect(git(checkout, ['rev-parse', 'origin/main'])).toBe(main);
      expect(git(checkout, ['merge-base', 'origin/main', 'HEAD'])).toBe(base);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe('test-selection-measure lives in its own workflow (R523)', () => {
  const own = yaml.load(readFileSync(new URL('../../../.github/workflows/test-selection-measure.yml', import.meta.url), 'utf8'));
  const job = own.jobs['test-selection-measure'];

  it('is gone from ci.yml and no ci.yml job needs it', () => {
    expect(jobs['test-selection-measure']).toBeUndefined();
    for (const j of Object.values(jobs)) expect([j.needs ?? []].flat()).not.toContain('test-selection-measure');
  });

  it('has its own concurrency group, never cancels, and stays non-gating and gated by the repo var', () => {
    expect(own.concurrency.group).toMatch(/^test-selection-measure-/);
    expect(own.concurrency.group).not.toMatch(/^ci-/);
    expect(Object.keys(own.on).sort()).toEqual(['merge_group', 'pull_request', 'push', 'workflow_dispatch']);
    expect(job['continue-on-error']).toBe(true);
    expect(job['timeout-minutes']).toBe(30);
    expect(job.if).toContain("vars.WE_MEASURE_TEST_SELECTION == '1'");
  });

  it('bounds the shadow suite steps below the job timeout so they fail soft', () => {
    for (const n of ['Shadow full-suite run (json report)', 'Shadow integration-suite run (json report)']) {
      const s = job.steps.find((x) => x.name === n);
      expect(s['timeout-minutes']).toBeLessThan(30);
      expect(s['continue-on-error']).toBe(true);
    }
  });

  it('keeps the shallow checkout plus blobless main fetch', () => {
    const i = job.steps.findIndex((s) => s.uses?.startsWith('actions/checkout@') && !s.with?.repository);
    expect(job.steps[i].with['fetch-depth']).toBe(50);
    expect(job.steps[i + 1].name).toBe('Fetch main history (blobless)');
    expect(job.steps[i + 1].run).toBe(fetchMain);
    expect(job.steps[i + 1]['working-directory']).toBe('web-everything');
    expect(job.steps[i + 1].if).toBeUndefined();
  });

  it('records the false-green sample only when the shadow report exists', () => {
    const rec = job.steps.find((s) => s.name === 'Record false-green signal (#2681)');
    // Pin the whole expression: a `|| always()` / `|| true` tail would record after a failed validation.
    expect(String(rec.if).replace(/^\$\{\{\s*|\s*\}\}$/g, '').trim()).toBe("steps.report.outcome == 'success'");
    expect(job.steps.find((s) => s.id === 'report')['continue-on-error']).toBe(true);
  });

  describe('Validate shadow report runs its real command against vitest JSON fixtures', () => {
    const steps = job.steps;
    const vIdx = steps.findIndex((s) => s.name === 'Validate shadow report');
    const v = steps[vIdx];
    const valid = (status) => JSON.stringify({ numTotalTests: 1, testResults: [{ name: '/w/a.test.mjs', status, assertionResults: [] }] });
    // Run the step's own `run` text exactly as GitHub's default bash shell does, in a scratch working directory.
    const exitOf = (fixture) => {
      const dir = mkdtempSync(join(tmpdir(), 'validate-shadow-report-'));
      try {
        if (fixture !== undefined) writeFileSync(join(dir, 'vitest-full.json'), fixture);
        execFileSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', v.run], {
          cwd: dir, stdio: 'pipe', timeout: 10_000, maxBuffer: 1024 * 1024,
          env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` },
        });
        return 0;
      } catch (e) {
        if (typeof e.status !== 'number') throw e;
        return e.status;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    it('is the step the record step keys on, runs before it in the same directory, on the default shell', () => {
      expect(v.id).toBe('report');
      expect(v.shell).toBeUndefined();
      const rIdx = steps.findIndex((s) => s.name === 'Record false-green signal (#2681)');
      expect(vIdx).toBeGreaterThan(-1);
      expect(vIdx).toBeLessThan(rIdx);
      expect(v['working-directory']).toBe(steps[rIdx]['working-directory']);
      expect(steps[rIdx].run).toContain('--vitest-json=vitest-full.json');
    });

    it.each([
      ['a missing report', undefined],
      ['an empty file', ''],
      ['truncated JSON', '{"testResults":[{"name":"a.test.mjs","sta'],
      ['JSON null', 'null'],
      ['an empty object', '{}'],
      ['a non-array testResults', '{"testResults":{"name":"a.test.mjs","status":"passed"}}'],
      ['an empty testResults', '{"testResults":[]}'],
      ['an unknown file status', valid('skipped')],
      ['a missing file status', '{"testResults":[{"name":"a.test.mjs"}]}'],
      ['an empty file name', '{"testResults":[{"name":"","status":"passed"}]}'],
      ['a non-string file name', '{"testResults":[{"name":7,"status":"passed"}]}'],
      ['one bad entry among good ones', '{"testResults":[{"name":"a.test.mjs","status":"passed"},{"name":"b.test.mjs","status":"pending"}]}'],
    ])('fails closed on %s', (_label, fixture) => {
      expect(exitOf(fixture)).not.toBe(0);
    });

    it.each(['passed', 'failed'])('accepts a well-formed report whose files %s', (status) => {
      expect(exitOf(valid(status))).toBe(0);
    });
  });
});
