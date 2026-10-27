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
const PUBLICATION_GATE = "steps.branch.outputs.exists == 'true' || steps.timings.outputs.changed == 'true'";

// Execute the workflow's actual shell with stateful Git/GitHub doubles; never touch a checkout or network.
function publicationProbe({ exists = false, open = false, failCreate = false, failLookup = false, appears = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'timings-publication-'));
  const output = join(root, 'output');
  const prelude = `
    exists=${Number(exists)}
    open=${Number(open)}
    git() {
      case "$1" in
        ls-remote) if [ "$exists" = 1 ]; then echo 'abc refs/heads/ci/refresh-test-timings'; fi ;;
        diff) return 1 ;;
        push) echo PUSH; exists=1 ;;
        switch|config|add|commit) echo "WRITE $*" ;;
        *) echo "Unexpected git call: $*" >&2; return 99 ;;
      esac
    }
    gh() {
      case "$1 $2" in
        'auth setup-git') : ;;
        'pr list')
          echo 'LOOKUP' >&2
          if [ "\${FAIL_LOOKUP:-0}" = 1 ]; then return 1; fi
          echo "$open" ;;
        'pr create')
          echo CREATE
          if [ "\${FAIL_CREATE:-0}" = 1 ]; then return 1; fi
          open=1 ;;
        *) echo "Unexpected gh call: $*" >&2; return 99 ;;
      esac
    }
  `;
  const evaluate = (condition, outputs) => condition.split(' || ').some(term => {
    const match = /^steps\.(branch|timings)\.outputs\.(exists|changed) == '(true|false)'$/.exec(term);
    if (!match) throw new Error(`Unsupported workflow condition: ${condition}`);
    return outputs[match[1]]?.[match[2]] === match[3];
  });
  try {
    // A first attempt fails after pushing; a second attempt starts with that retained remote state.
    const first = failCreate ? spawnSync('bash', ['-e', '-c', `${prelude}\n${publish.run}`], {
      encoding: 'utf8', timeout: 5_000,
      env: { ...process.env, FAIL_CREATE: String(Number(failCreate)), FAIL_LOOKUP: String(Number(failLookup)) },
    }) : null;
    const retained = exists || Boolean(first?.stdout.includes('PUSH'));
    const check = spawnSync('bash', ['-e', '-c', `${prelude}\nexists=${Number(retained)}\n${branch.run}`], {
      encoding: 'utf8', timeout: 5_000, env: { ...process.env, GITHUB_OUTPUT: output },
    });
    expect(check.status, check.stderr).toBe(0);
    const outputs = { branch: Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map(line => line.split('='))), timings: {} };
    const timings = steps.find(step => step.id === 'timings');
    const refreshed = evaluate(timings.if, outputs);
    if (refreshed) outputs.timings.changed = 'true';
    const token = evaluate(mint.if, outputs);
    const second = evaluate(publish.if, outputs)
      ? spawnSync('bash', ['-e', '-c', `${prelude}\nexists=${Number(retained || appears)}\n${publish.run}`], {
        encoding: 'utf8', timeout: 5_000,
        env: { ...process.env, FAIL_CREATE: '0', FAIL_LOOKUP: String(Number(failLookup)) },
      })
      : { status: 0, stdout: '', stderr: '' };
    return { first, second, refreshed, token };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('CI timing refresh publication recovery', () => {
  it('recovers after a successful push followed by failed PR creation without rewriting the branch', () => {
    const { first, second, refreshed, token } = publicationProbe({ failCreate: true });
    expect(first.status).not.toBe(0);
    expect(first.stdout).toContain('PUSH');
    expect(first.stdout).toContain('CREATE');
    expect(refreshed).toBe(false);
    expect(token).toBe(true);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain('CREATE');
    expect(second.stdout).not.toMatch(/PUSH|WRITE/);
  });

  it('preserves an existing branch and avoids duplicate creation when its PR is open', () => {
    const { second, refreshed } = publicationProbe({ exists: true, open: true });
    expect(refreshed).toBe(false);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stderr).toContain('LOOKUP');
    expect(second.stdout).not.toMatch(/CREATE|PUSH|WRITE/);
  });

  it('fails closed when the open PR lookup fails', () => {
    const { second } = publicationProbe({ exists: true, failLookup: true });
    expect(second.status).not.toBe(0);
    expect(second.stdout).not.toMatch(/CREATE|PUSH|WRITE/);
  });

  it('resumes PR creation when the branch appears during refresh without rewriting it', () => {
    const { second, refreshed } = publicationProbe({ appears: true });
    expect(refreshed).toBe(true);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain('CREATE');
    expect(second.stdout).not.toMatch(/PUSH|WRITE/);
  });

  it('still pushes fresh timings and creates a PR when the branch is absent', () => {
    const { second } = publicationProbe();
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain('PUSH');
    expect(second.stdout).toContain('CREATE');
  });
});

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
    expect(mint.if).toBe(PUBLICATION_GATE);
    expect(publish.if).toBe(mint.if);
    expect(publish['continue-on-error']).toBeUndefined();
    expect(mint['continue-on-error']).toBeUndefined();
    expect(publish.env.GH_TOKEN).not.toMatch(/github\.token|GITHUB_TOKEN|\|\|/);
    expect(steps.find(step => step.id === 'timings').run).toContain('git diff --quiet -- scripts/ci/test-timings.json');
  });
});

describe('CI timing refresh workflow never overwrites an existing refresh branch', () => {
  it('checks for the branch after checkout, skips refresh when it exists, and still permits publication recovery', () => {
    expect(steps.indexOf(branch)).toBe(1);
    expect(branch.run).toContain(LS_REMOTE);
    expect(branch.run).toMatch(/if \[ -n "\$refs" \]; then[\s\S]*echo "exists=true" >> "\$GITHUB_OUTPUT"[\s\S]*else\s+echo "exists=false" >> "\$GITHUB_OUTPUT"/);
    const timings = steps.find(step => step.id === 'timings');
    for (const step of steps.slice(2)) {
      const gate = step === mint || step === publish ? PUBLICATION_GATE : "steps.branch.outputs.exists == 'false'";
      expect(step.if, step.name ?? step.uses).toBe(gate);
    }
    expect(steps.indexOf(timings)).toBeLessThan(steps.indexOf(mint));
  });

  it('rechecks the branch and keeps all branch writes inside the absent-branch guard', () => {
    const recheck = publish.run.indexOf(LS_REMOTE);
    expect(recheck).toBeGreaterThan(-1);
    expect(recheck).toBeLessThan(publish.run.indexOf('git switch -c'));
    const beforeLookup = publish.run.split('open_prs=$(gh pr list')[0];
    expect(beforeLookup).toMatch(/if \[ -z "\$refs" \]; then[\s\S]*git switch -c[\s\S]*git push[^\n]*\nfi/);
    expect(publish.run).toContain("gh pr list --head ci/refresh-test-timings --state open --json number --jq 'length'");
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
