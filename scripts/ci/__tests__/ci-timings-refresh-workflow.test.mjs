// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';

const workflow = yaml.load(readFileSync(new URL('../../../.github/workflows/ci-timings-refresh.yml', import.meta.url), 'utf8'));
const steps = workflow.jobs.refresh.steps;
const download = steps.find(step => step.run?.includes('refresh-timings.mjs --run=latest'));
const publish = steps.find(step => step.run?.includes('gh pr create'));
const mint = steps.find(step => step.id === 'publication-token');
const branch = steps.find(step => step.id === 'branch');
const LS_REMOTE = 'git ls-remote --heads origin refs/heads/ci/refresh-test-timings';
// Create-only: an empty lease expectation means the remote ref must not exist (checked server-side too).
const PUSH = 'git push --force-with-lease=refs/heads/ci/refresh-test-timings: origin HEAD:refs/heads/ci/refresh-test-timings';

describe('CI timing refresh workflow permissions and publication', () => {
  it('grants github.token only read scopes: actions to download artifacts, contents to check out', () => {
    expect(download.env.GH_TOKEN).toBe('${{ github.token }}');
    expect(workflow.jobs.refresh.permissions).toBeUndefined();
    expect(workflow.permissions).toEqual({ actions: 'read', contents: 'read' });
  });

  it('schedules a weekly refresh and allows a manual run', () => {
    expect(workflow.on.schedule).toHaveLength(1);
    expect(workflow.on.schedule[0].cron).toMatch(/^\d+ \d+ \* \* [0-6]$/);
    expect(workflow.on).toHaveProperty('workflow_dispatch');
  });

  it('mints a publication App token scoped to the current repository with contents and PR write access', () => {
    expect(mint.uses).toBe('actions/create-github-app-token@v2');
    expect(mint.with).toEqual({
      'app-id': '${{ vars.WE_APP_ID }}',
      'private-key': '${{ secrets.WE_APP_PRIVATE_KEY }}',
      owner: '${{ github.repository_owner }}',
      repositories: '${{ github.event.repository.name }}',
      'permission-contents': 'write',
      'permission-pull-requests': 'write',
    });
    expect(steps.indexOf(mint)).toBeLessThan(steps.indexOf(publish));
  });

  it('uses the App token for both git push and PR creation so their events trigger required CI', () => {
    const checkout = steps.find(step => step.uses?.startsWith('actions/checkout@'));
    expect(checkout.with['persist-credentials']).toBe(false);
    expect(publish.env.GH_TOKEN).toBe('${{ steps.publication-token.outputs.token }}');
    expect(publish.run).toContain('gh auth setup-git --hostname github.com');
    expect(publish.run.indexOf('gh auth setup-git')).toBeLessThan(publish.run.indexOf('git push'));
    expect(publish.run).toContain(PUSH);
    expect(publish.run).toContain('gh pr create --base main --head ci/refresh-test-timings');
  });

  it('fails closed without an App token rather than falling back to workflow-trigger-suppressing github.token', () => {
    expect(mint.if).toBe("steps.timings.outputs.changed == 'true'");
    expect(publish.if).toBe(mint.if);
    expect(publish['continue-on-error']).toBeUndefined();
    expect(mint['continue-on-error']).toBeUndefined();
    expect(publish.env.GH_TOKEN).not.toMatch(/github\.token|GITHUB_TOKEN|\|\|/);
    expect(steps.find(step => step.id === 'timings').run).toContain('git diff --quiet -- scripts/ci/test-timings.json');
  });
});

describe('CI timing refresh workflow never overwrites an existing refresh branch', () => {
  it('checks for the branch right after checkout and gates every later step on its absence', () => {
    expect(steps.indexOf(branch)).toBe(1);
    expect(branch.run).toContain(LS_REMOTE);
    expect(branch.run).toMatch(/if \[ -n "\$refs" \]; then[\s\S]*echo "exists=true" >> "\$GITHUB_OUTPUT"[\s\S]*else\s+echo "exists=false" >> "\$GITHUB_OUTPUT"/);
    const timings = steps.find(step => step.id === 'timings');
    for (const step of steps.slice(2)) {
      // Publication steps hang off `timings`, which itself only runs when the branch is absent.
      const gate = step === mint || step === publish ? "steps.timings.outputs.changed == 'true'" : "steps.branch.outputs.exists == 'false'";
      expect(step.if, step.name ?? step.uses).toBe(gate);
    }
    expect(steps.indexOf(timings)).toBeLessThan(steps.indexOf(mint));
  });

  it('rechecks the branch before publishing and skips when it appeared', () => {
    const recheck = publish.run.indexOf(LS_REMOTE);
    expect(recheck).toBeGreaterThan(-1);
    expect(recheck).toBeLessThan(publish.run.indexOf('git switch -c'));
    expect(publish.run.slice(recheck)).toMatch(/^git ls-remote[^\n]*\n\s*if \[ -n "\$refs" \]; then\n[^\n]*\n\s*exit 0\n\s*fi/);
  });

  it('pushes create-only, never with --force, -f or a + refspec', () => {
    const pushes = publish.run.split('\n').map(line => line.trim()).filter(line => line.startsWith('git push'));
    expect(pushes).toEqual([PUSH]);
    expect(publish.run).not.toMatch(/\s(?:--force|-f)(?:\s|$)|\s\+\S*:/);
  });

  it('the push refuses a branch created after the final check, even as a fast-forward, and leaves it unchanged', () => {
    const root = mkdtempSync(join(tmpdir(), 'timings-push-'));
    // Hermetic: no host git config or hooks.
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    const git = (cwd, ...args) => {
      const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, env, encoding: 'utf8', timeout: 15_000 });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    const push = cwd => spawnSync('bash', ['-c', PUSH], { cwd, env, encoding: 'utf8', timeout: 15_000 });
    try {
      const remote = join(root, 'remote.git');
      const work = join(root, 'work');
      git(root, 'init', '--bare', '-q', remote);
      git(root, 'init', '-q', work);
      git(work, 'remote', 'add', 'origin', remote);
      writeFileSync(join(work, 'f'), '1');
      git(work, 'add', 'f');
      git(work, 'commit', '-qm', 'base');
      const ancestor = git(work, 'rev-parse', 'HEAD');
      // Another actor creates the branch at an ancestor between the recheck and the push.
      git(work, 'push', '-q', 'origin', 'HEAD:refs/heads/ci/refresh-test-timings');
      writeFileSync(join(work, 'f'), '2');
      git(work, 'commit', '-qam', 'refresh');
      const raced = push(work);
      expect(raced.status).not.toBe(0);
      expect(git(remote, 'rev-parse', 'refs/heads/ci/refresh-test-timings')).toBe(ancestor);
      // With the branch absent, the same command creates it.
      git(work, 'push', '-q', 'origin', ':refs/heads/ci/refresh-test-timings');
      expect(push(work).status).toBe(0);
      expect(git(remote, 'rev-parse', 'refs/heads/ci/refresh-test-timings')).toBe(git(work, 'rev-parse', 'HEAD'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
