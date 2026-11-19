import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Exercise the production timer wiring without booting the CLI, auth, or clone IO.
const source = readFileSync(resolve('skills-src/conveyor/review-daemon.mjs'), 'utf8');
const timerSource = source.slice(source.indexOf('  let drainBusy = false;'), source.indexOf('  let stoppedReason;'));

describe('review daemon independent queue timer', () => {
  it('routes every drain through self-sync outside App auth, honoring skipped ticks and restart options', async () => {
    let timer, guardedTick, syncOptions;
    let blocked = true;
    const drain = vi.fn();
    const authTick = vi.fn(async () => guardedTick());
    const authOptions = { perOwner: true };
    const withGithubAppAuth = vi.fn(effects => {
      guardedTick = effects.tickOnce;
      return { tickOnce: authTick };
    });
    const withSelfSync = vi.fn((effects, options) => {
      syncOptions = options;
      return { tickOnce: () => blocked ? { skipped: true } : effects.tickOnce() };
    });
    const restart = vi.fn(), staleRefusal = vi.fn();
    const install = new Function('withSelfSync', 'withGithubAppAuth', 'cliRedTeamQueueDrain',
      'REVIEW_DAEMON_APP_AUTH_OPTS', 'selfRoot', 'restartOntoNewCode', 'hasStaleMainRefusal',
      'setInterval', 'process', 'console', 'stopping', timerSource);
    install(withSelfSync, withGithubAppAuth, drain, authOptions, 'fixture-clone', restart, staleRefusal,
      (callback, ms) => { timer = callback; expect(ms).toBe(60_000); }, { env: {} }, { error: vi.fn() }, false);

    expect(withSelfSync).toHaveBeenCalledTimes(1);
    expect(withGithubAppAuth).toHaveBeenCalledWith({ tickOnce: guardedTick }, authOptions);
    expect(syncOptions).toEqual({ root: 'fixture-clone', onRestart: restart, hasStaleRefusal: staleRefusal });
    await timer();
    expect(authTick).not.toHaveBeenCalled();
    expect(drain).not.toHaveBeenCalled();
    blocked = false;
    await timer();
    expect(authTick).toHaveBeenCalledTimes(1);
    expect(drain).toHaveBeenCalledTimes(1);
  });
});
