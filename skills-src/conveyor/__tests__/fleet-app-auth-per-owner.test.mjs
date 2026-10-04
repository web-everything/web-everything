/**
 * Every fleet daemon touches more than one org, so none may pin ONE installation's token as GH_TOKEN.
 * Live 2026-10-04: the fix-dispatch daemon logged `gh: Could not resolve to a Repository with the name
 * 'plateauapp/plateau-app'` with the web-everything token pinned (the review daemon had the same bug, #3909).
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const seen = [];
vi.mock('../../../scripts/lib/github-app-auth-env.mjs', async (orig) => {
  const actual = await orig();
  return { ...actual, withGithubAppAuth: (effects, opts) => { seen.push(opts); return effects; } };
});

const { FLEET_APP_AUTH_OPTS } = await import('../../../scripts/lib/github-app-auth-env.mjs');
const { FIX_DISPATCH_APP_AUTH_OPTS } = await import('../reconcile-fix-dispatch-daemon.mjs');
const { REVIEW_DAEMON_APP_AUTH_OPTS } = await import('../review-daemon.mjs');
const { wireSelfSyncAndAppAuth } = await import('../runner.mjs');

const HERE = dirname(fileURLToPath(import.meta.url));

describe('fleet daemons use per-owner App auth', () => {
  it('the shared options are per-owner', () => {
    expect(FLEET_APP_AUTH_OPTS.perOwner).toBe(true);
  });
  it('fix-dispatch and review daemons use the shared options', () => {
    expect(FIX_DISPATCH_APP_AUTH_OPTS).toBe(FLEET_APP_AUTH_OPTS);
    expect(REVIEW_DAEMON_APP_AUTH_OPTS).toBe(FLEET_APP_AUTH_OPTS);
  });
  it('runner/build-dispatch wiring defaults to per-owner', () => {
    seen.length = 0;
    wireSelfSyncAndAppAuth({ tickOnce: () => {}, root: '/x', onRestart: () => {} });
    expect(seen[0]?.perOwner).toBe(true);
  });
  it.each(['review-daemon.mjs', 'reconcile-fix-dispatch-daemon.mjs', 'pass-daemon.mjs', 'runner.mjs'])(
    '%s never calls App auth without the shared per-owner options', (file) => {
      const src = readFileSync(join(HERE, '..', file), 'utf8');
      const calls = src.split('\n').filter((l) => /(withGithubAppAuth|ensureFreshGithubAppEnv)\(/.test(l)
        && !/^\s*(\*|\/\/|import|export function)/.test(l));
      for (const line of calls) {
        expect(line, line.trim()).toMatch(/APP_AUTH_OPTS|authOpts\)/);
      }
    });
});
