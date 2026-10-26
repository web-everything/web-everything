// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

const workflow = yaml.load(readFileSync(new URL('../../../.github/workflows/ci-timings-refresh.yml', import.meta.url), 'utf8'));
const steps = workflow.jobs.refresh.steps;
const download = steps.find(step => step.run?.includes('refresh-timings.mjs --run=latest'));
const publish = steps.find(step => step.run?.includes('gh pr create'));
const mint = steps.find(step => step.id === 'publication-token');

describe('CI timing refresh workflow permissions and publication', () => {
  it('grants actions: read to github.token for downloading CI timing artifacts', () => {
    expect(download.env.GH_TOKEN).toBe('${{ github.token }}');
    const permissions = workflow.jobs.refresh.permissions ?? workflow.permissions;
    expect(permissions.actions).toBe('read');
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
    expect(publish.run).toContain('git push origin HEAD:refs/heads/ci/refresh-test-timings');
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
