import { describe, expect, it, vi } from 'vitest';
import { ghRepoSlug } from '../../lib/constellation-repos.mjs';
import { describeDispatchFailure } from '../../lib/describe-spawn-failure.mjs';
import { postRulingNotice, dispatchFix, classifyEnvFaultRefusals } from '../reconcile-fix-dispatch.mjs';
import { H1, H2 } from './ruling-fixtures.mjs';

const ruling = { head: H2, matches: [{ finding: { file: 'policy/pointer.md', line: 12, summary: 's' },
  ruling: 'block: pointer files must be listed', priorHead: H1, misses: 1 }] };

describe('ghRepoSlug', () => {
  it.each([
    ['we', 'web-everything/web-everything'],
    ['frontierui', 'frontier-ui/frontierui'],
    ['plateau-app', 'plateauapp/plateau-app'],
    ['web-everything/web-everything', 'web-everything/web-everything'],
    ['another-owner/another-repo', 'another-owner/another-repo'],
    ['chalbert/webeverything', 'web-everything/web-everything'],
    ['chalbert/frontierui', 'frontier-ui/frontierui'],
  ])('resolves %s to %s', (input, expected) => {
    expect(ghRepoSlug(input)).toBe(expected);
  });

  it.each(['unknown', '', null, undefined, 42, {}, '/repo', 'owner/', 'host/owner/repo', 'owner/repo name'])
    ('rejects invalid repo %j', (input) => {
      expect(() => ghRepoSlug(input)).toThrow(/OWNER\/REPO/);
    });
});

describe('ruling notice gh boundary', () => {
  it.each([
    ['we', 'web-everything/web-everything'],
    ['another-owner/another-repo', 'another-owner/another-repo'],
    ['chalbert/webeverything', 'web-everything/web-everything'],
  ])('posts %s using slug %s', (repo, slug) => {
    const exec = vi.fn();
    expect(postRulingNotice({ repo, pr: 3794, ruling, exec })).toBe(true);
    expect(exec).toHaveBeenCalledTimes(1);
    const [command, argv] = exec.mock.calls[0];
    expect(command).toBe('gh');
    expect(argv.slice(0, 5)).toEqual(['pr', 'comment', '3794', '--repo', slug]);
    expect(argv).not.toContain('we');
  });

  it('releases the claim and classifies a failed notice as an environment fault before spawning', () => {
    const failure = Object.assign(new Error('Command failed: gh pr comment'), {
      status: 1, stderr: 'expected the "[HOST/]OWNER/REPO" format, got "we"',
    });
    const postNotice = vi.fn(() => { throw failure; });
    const releaseClaim = vi.fn();
    const spawnAgent = vi.fn();
    let err;
    try {
      dispatchFix({ itemNum: null, pr: 3794, laneRef: 'lane/x', scope: ['we:x'], lane: 3, rulingNotAddressed: ruling }, {
        root: '/repo',
        readBrief: () => '{{PR_NUM}} {{ITEM_NUM}} {{LANE}} {{SESSION_SLUG}} {{SCOPE}} {{LANE_REF}}',
        readFixClaim: () => null, acquireClaim: () => ({ ok: true }), claimOwner: 'test-dispatcher',
        releaseClaim, postNotice, spawnAgent,
      });
    } catch (e) { err = e; }
    expect(postNotice).toHaveBeenCalledWith({ repo: 'we', pr: 3794, ruling });
    expect(releaseClaim).toHaveBeenCalledTimes(1);
    expect(releaseClaim).toHaveBeenCalledWith({ repo: 'we', pr: 3794, kind: 'fix', owner: 'test-dispatcher', lockRoot: undefined });
    expect(spawnAgent).not.toHaveBeenCalled();
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('dispatch-env-fault: ruling notice post failed for PR #3794 (gh pr comment --repo web-everything/web-everything): gh comment failed (exit 1): expected the "[HOST/]OWNER/REPO" format, got "we"');
    expect(err).not.toHaveProperty('status');
    expect(err).not.toHaveProperty('stderr');
    const why = describeDispatchFailure(err);
    expect(why).toBe(err.message);
    expect(classifyEnvFaultRefusals([{ kind: 'dispatch-failed', why }]))
      .toEqual([{ kind: 'dispatch-env-fault', why }]);
  });
});
