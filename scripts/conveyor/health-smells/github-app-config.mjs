/**
 * GitHub App auth NOT applied for one daemon/pass (operator ruling 2026-10-09 ~21:20 ET: every daemon uses the App
 * installation; `github.auth` policy, `we:scripts/lib/github-auth-policy.mjs`).
 *
 * Live-caught 2026-10-09: the drain's launchd plist pinned an App installation and key but no `WE_GITHUB_APP_ID`,
 * so App login was silently skipped and the drain ran on the operator's PERSONAL login — whose shared rate limit
 * then broke the drain's check at 13:21Z. The shared `status.json` is last-writer-wins, so every other daemon's
 * `ok` hid it. Each `ensureFreshGithubAppEnv` call now also writes a PER-CALLER file
 * (`~/.claude/github-app-token/callers/<caller>.json`), which `readGithubAppStatus` attaches as `appStatus.callers`.
 * One subject per caller whose last refresh did not apply the App: `half-configured`, `not-configured` (a daemon
 * with no App config at all), `mint-failed`, `insufficient-access`, `shim-failed`, ... A `policy-personal` caller is
 * a deliberate choice and is never a breach.
 *
 * Only evaluated when the App token cache exists on this host (`appToken.present`): a fixture tick stubs that probe
 * to `{present:false}`, so a test never reads the machine's real caller files through it.
 *
 * Deterministic diagnosis + alert, medium: the daemon still works (on the personal login), so this does NOT inhibit
 * agent dispatch the way `github-app-token` does.
 */
export default {
  id: 'github-app-config',
  scope: 'host',
  cadence: 'every-tick',
  probes: ['appToken'],
  openAfter: 1,
  closeAfter: 2,
  severity: 'medium',
  action: 'alert',
  diagnose: { command: 'node', args: ['scripts/conveyor/github-app-status.mjs'], timeoutMs: 15_000 },
  recommendationHint: 'A daemon is running on the operator\'s personal GitHub login instead of the App installation.',
  evaluate({ appToken, appStatus }) {
    if (!appToken || !appToken.present) return [];
    const callers = Array.isArray(appStatus?.callers) ? appStatus.callers : [];
    return callers
      .filter((c) => c && typeof c.caller === 'string' && c.reason !== 'policy-personal')
      .map((c) => {
        const breach = !c.applied;
        const missing = [...(c.missing ?? []), ...(c.keyUnreadable ? ['a readable private key'] : [])];
        const why = c.reason === 'half-configured'
          ? `App auth is half-configured (missing ${missing.join(', ') || '?'})`
          : c.reason === 'not-configured'
            ? 'no WE_GITHUB_APP_* config at all, but App login is the default for daemons'
            : `App token refresh did not apply (${c.reason})`;
        return {
          subject: c.caller,
          breach,
          measure: { applied: !!c.applied, reason: c.reason ?? null, missing, checkedAt: c.checkedAt ?? null },
          summary: breach ? `${c.caller}: on the PERSONAL login — ${why}.` : `${c.caller}: on the App installation.`,
          recommendation: breach
            ? (c.reason === 'half-configured' || c.reason === 'not-configured'
              ? `Add the missing WE_GITHUB_APP_* value(s) to ${c.caller}'s launchd plist (values from another com.we.* plist), then reload it: launchctl bootout + launchctl bootstrap (kickstart does not reload env).`
              : `Run \`node scripts/conveyor/github-app-status.mjs\`; if only this caller fails, reload its daemon (it may be running stale in-memory code).`)
            : 'ok',
        };
      });
  },
};
