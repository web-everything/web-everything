/**
 * @file scripts/conveyor/__tests__/github-app-status.test.mjs
 * @description Unit proof of {@link formatGithubAppStatus} — the pure core of
 *   `we:scripts/conveyor/github-app-status.mjs`, the one-command read that turns the fail-closed App-auth
 *   state (#x8mpubm) from a line in one daemon's log into a plain-language, actionable report.
 */
import { describe, it, expect } from 'vitest';
import { formatGithubAppStatus } from '../github-app-status.mjs';

describe('formatGithubAppStatus — pure, given a status record or null', () => {
  it('no status recorded (never run on this host) says so, distinctly from "not applied"', () => {
    expect(formatGithubAppStatus(null)).toContain('no status recorded yet');
  });

  it('applied:true reports APPLIED, and names when it was last checked', () => {
    const out = formatGithubAppStatus({ applied: true, reason: 'ok', checkedAt: '2026-09-23T13:51:32.000Z' });
    expect(out).toContain('APPLIED');
    expect(out).toContain('2026-09-23T13:51:32.000Z');
    expect(out).not.toContain('NOT APPLIED');
  });

  it('not-configured explains the process never opted in', () => {
    const out = formatGithubAppStatus({ applied: false, reason: 'not-configured', checkedAt: '2026-09-23T13:00:00.000Z' });
    expect(out).toContain('NOT APPLIED');
    expect(out).toContain('has not opted in');
  });

  it('mint-failed explains a transient failure, not a permanent one', () => {
    const out = formatGithubAppStatus({ applied: false, reason: 'mint-failed', checkedAt: '2026-09-23T13:00:00.000Z' });
    expect(out).toContain('mint attempt failed');
  });

  // Live-caught 2026-09-26: a repo-access verification failure (the installation-info read AND the repo
  // listing both failing) used to be indistinguishable from a confirmed gap — this reason and its message
  // say plainly that the mint itself succeeded and nothing was actually confirmed missing.
  it("access-check-failed explains a couldn't-verify outcome, distinctly from a confirmed gap", () => {
    const out = formatGithubAppStatus({ applied: false, reason: 'access-check-failed', checkedAt: '2026-09-26T14:05:00.000Z' });
    expect(out).toContain('NOT APPLIED');
    expect(out).toContain("Couldn't verify");
    expect(out).not.toContain('missing access it needs');
  });

  it('insufficient-access — THE LIVE CASE — names the exact permissions and repos to grant', () => {
    const out = formatGithubAppStatus({
      applied: false,
      reason: 'insufficient-access',
      missingPermissions: ['metadata:read', 'pull_requests:write'],
      missingRepos: ['web-everything/web-everything', 'plateauapp/plateau-app'],
      checkedAt: '2026-09-23T13:51:32.000Z',
    });
    expect(out).toContain('grant repository permissions: metadata:read, pull_requests:write');
    expect(out).toContain('add repositories to the installation: web-everything/web-everything, plateauapp/plateau-app');
  });

  it('insufficient-access with only one of the two gaps omits the other line entirely', () => {
    const out = formatGithubAppStatus({ applied: false, reason: 'insufficient-access', missingPermissions: ['checks:read'], missingRepos: [], checkedAt: '2026-09-23T13:00:00.000Z' });
    expect(out).toContain('grant repository permissions: checks:read');
    expect(out).not.toContain('add repositories to the installation');
  });

  it('an unrecognised reason still renders rather than throwing, naming itself', () => {
    expect(() => formatGithubAppStatus({ applied: false, reason: 'some-future-reason' })).not.toThrow();
    expect(formatGithubAppStatus({ applied: false, reason: 'some-future-reason' })).toContain('some-future-reason');
  });

  it('missing checkedAt omits the "(as of ...)" clause rather than printing "undefined"', () => {
    expect(formatGithubAppStatus({ applied: true, reason: 'ok' })).toBe(
      "github-app-status: APPLIED — gh calls are authenticating as the App installation, not the operator's personal token.",
    );
  });
});

import { formatCallerLines } from '../github-app-status.mjs';

describe('per-caller GitHub App status', () => {
  const callers = [
    { caller: 'review-daemon.mjs', applied: true, reason: 'ok' },
    { caller: 'merge-ai-prs.mjs', applied: false, reason: 'half-configured', missing: ['WE_GITHUB_APP_ID'] },
  ];

  it('omits the caller section when no callers were supplied', () => {
    expect(formatCallerLines(undefined)).toEqual([]);
  });

  it('counts App callers and names the personal caller and its missing configuration', () => {
    const lines = formatCallerLines(callers);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('1/2 on the App installation');
    expect(lines[1]).toContain('PERSONAL: merge-ai-prs.mjs (half-configured — missing WE_GITHUB_APP_ID');
  });

  it('renders callers even when no shared status has been recorded', () => {
    const output = formatGithubAppStatus({ callers });
    expect(output.startsWith('github-app-status: no shared status recorded yet.')).toBe(true);
    expect(output).toContain('1/2 on the App installation');
    expect(output).toContain('PERSONAL: merge-ai-prs.mjs (half-configured — missing WE_GITHUB_APP_ID');
  });
});
