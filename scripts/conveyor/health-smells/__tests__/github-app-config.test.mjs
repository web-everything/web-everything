import { describe, it, expect } from 'vitest';
import githubAppConfig from '../github-app-config.mjs';

describe('github-app-config smell', () => {
  const callers = [
    { caller: 'review-daemon.mjs', applied: true, reason: 'ok' },
    { caller: 'merge-ai-prs.mjs', applied: false, reason: 'half-configured', missing: ['WE_GITHUB_APP_ID'] },
    { caller: 'personal.mjs', applied: false, reason: 'policy-personal' },
  ];

  it('does not evaluate callers when the host has no App token cache', () => {
    expect(githubAppConfig.evaluate({ appToken: { present: false }, appStatus: { callers } })).toEqual([]);
  });

  it('reports applied and half-configured callers, skipping explicit personal policy', () => {
    const results = githubAppConfig.evaluate({ appToken: { present: true }, appStatus: { callers } });
    expect(results.map(({ subject, breach }) => ({ subject, breach }))).toEqual([
      { subject: 'review-daemon.mjs', breach: false },
      { subject: 'merge-ai-prs.mjs', breach: true },
    ]);
    expect(results[1].summary).toContain('PERSONAL');
    expect(results[1].summary).toContain('WE_GITHUB_APP_ID');
    expect(results[1].recommendation).toContain('bootout');
  });

  it('alerts on a mint failure with a daemon reload recommendation', () => {
    const results = githubAppConfig.evaluate({
      appToken: { present: true },
      appStatus: { callers: [{ caller: 'mint-failure.mjs', applied: false, reason: 'mint-failed' }] },
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ subject: 'mint-failure.mjs', breach: true });
    expect(results[0].recommendation).toContain('reload');
  });

  it('is a medium-severity alert', () => {
    expect(githubAppConfig).toMatchObject({ id: 'github-app-config', severity: 'medium', action: 'alert' });
  });
});
