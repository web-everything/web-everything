import { describe, it, expect } from 'vitest';
import { readMergeFreshnessFacts, readMergeFreshnessFactsAsync } from '../lib/merge-queue-hook.mjs';

const reply = args => {
  const path = args[1];
  if (path.includes('check-runs')) return JSON.stringify([{ check_runs: [] }]);
  if (path.includes('/branches/')) return JSON.stringify({ sha: 'tip' });
  if (path.includes('/compare/')) return JSON.stringify({ base: 'base', ahead: 0, files: [], n: 0 });
  return JSON.stringify([[{ filename: 'docs/test.md' }]]);
};
describe('async cascade freshness facts', () => {
  it('matches the synchronous collector and awaits the dependent compare read', async () => {
    const options = { repo: 'o/r', num: 1, headSha: 'head', retest: { mode: 'any-code' } };
    const calls = [];
    const result = await readMergeFreshnessFactsAsync({ ...options, gh: async args => {
      await Promise.resolve(); calls.push(args); return reply(args);
    } });
    expect(result).toEqual(readMergeFreshnessFacts({ ...options, gh: reply }));
    expect(calls).toHaveLength(4);
    expect(calls[2][1]).toContain('head...tip');
  });
  it('fails closed (filesComplete=false) when the PR-files response is not an array', async () => {
    const options = { repo: 'o/r', num: 1, headSha: 'head', retest: { mode: 'any-code' } };
    const bad = args => (args[1].includes('/files') ? JSON.stringify({ message: 'oops' }) : reply(args));
    expect((await readMergeFreshnessFactsAsync({ ...options, gh: async args => bad(args) })).pr.filesComplete).toBe(false);
    expect(readMergeFreshnessFacts({ ...options, gh: bad }).pr.filesComplete).toBe(false);
  });
  it.each(['failed', 'unreadable'])('re-reads required checks on the same head and main tip after a pass becomes %s', async state => {
    let checkReads = 0;
    const options = { repo: 'o/r', num: 1, headSha: 'head', retest: { mode: 'any-code' }, gh: async args => {
      if (!args[1].includes('check-runs')) return reply(args);
      checkReads++;
      if (checkReads > 1 && state === 'unreadable') throw Error('unreadable');
      return JSON.stringify([{ check_runs: [{ id: checkReads, head_sha: 'head', status: 'completed',
        conclusion: checkReads === 1 ? 'success' : 'failure' }] }]);
    } };
    const before = await readMergeFreshnessFactsAsync(options);
    const after = await readMergeFreshnessFactsAsync(options);
    expect(before.pr.requiredCheck.state).toBe('passed');
    expect(after.main.tipSha).toBe(before.main.tipSha);
    expect(checkReads).toBe(2);
    if (state === 'failed') expect(after.pr.requiredCheck.state).toBe('failed');
    else {
      expect(after.pr.requiredCheck).toBeNull();
      expect(after.errors).toEqual(['check-runs: unreadable']);
    }
  });
  it('fails closed on rejected, empty and malformed GitHub replies', async () => {
    for (const gh of [async () => { throw Error('unreadable'); }, async () => '', async () => '{bad']) {
      const result = await readMergeFreshnessFactsAsync({ repo: 'o/r', num: 1, headSha: 'head', gh, retest: { mode: 'any-code' } });
      expect(result.errors).toHaveLength(3);
      expect(result.pr.filesComplete).toBe(false);
      expect(result.pr.requiredCheck).toBeNull();
      expect(result.main.complete).toBe(false);
    }
  });
});
