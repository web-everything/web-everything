import { describe, it, expect } from 'vitest';
import { resolvePinnedDiffBasis, sameDiffBasis } from '../lib/pinned-diff-basis.mjs';
import { computeNetDiffText, computeNetDiffPaths, computeNetDiffSignals, verifyNetDiffPair } from '../merge-ai-prs.mjs';
const base = 'a'.repeat(40), head = 'b'.repeat(40), fork = 'c'.repeat(40);
function fixture(overrides = {}) {
  const calls = [];
  const exec = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    expect(opts.env.GIT_NO_REPLACE_OBJECTS).toBe('1');
    expect(opts.env.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(opts.env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    if (args[0] === 'fetch') { if (overrides.fetch) throw Error('offline'); return ''; }
    if (args[0] === 'rev-parse') {
      if (args.at(-1) === 'refs/remotes/origin/main^{commit}') return overrides.base ?? base;
      if (args.at(-1) === 'FETCH_HEAD^{commit}') return overrides.fetched ?? base;
      if (args.at(-1) === `${head}^{commit}`) {
        if (overrides.missingHead) throw Error('missing commit');
        return overrides.head ?? head;
      }
      throw Error('shadow or unexpected ref');
    }
    if (args[0] === 'merge-base') {
      expect(args.slice(-2)).toEqual([overrides.base ?? base, head]);
      if (overrides.unrelated) throw Error('no common ancestor');
      return fork;
    }
    if (args.includes('diff')) return '';
    throw Error('unexpected git read');
  };
  return { exec, calls };
}
describe('one pinned diff basis for every evidence reader', () => {
  it('fetches once and ignores shadow refs using only qualified base and exact head', () => {
    const { exec, calls } = fixture();
    const basis = resolvePinnedDiffBasis({ exec, headSha: head });
    expect(basis).toEqual({ ok: true, baseSha: base, headSha: head, mergeBaseSha: fork, numstat: '' });
    expect(calls.filter(c => c.args[0] === 'fetch')).toHaveLength(1);
    expect(calls[0].args.slice(-2)).toEqual(['+refs/heads/main:refs/remotes/origin/main', head]);
  });
  it('failed fetch refuses cached evidence', () => {
    const { exec, calls } = fixture({ fetch: true });
    expect(resolvePinnedDiffBasis({ exec, headSha: head })).toEqual({ ok: false, reason: 'base-fetch-failed' });
    expect(calls).toHaveLength(1);
  });
  it('a stale FETCH_HEAD refuses a successful transport', () => {
    expect(resolvePinnedDiffBasis({ exec: fixture({ fetched: head }).exec, headSha: head }))
      .toEqual({ ok: false, reason: 'base-fetch-failed' });
  });
  it('unreachable head is unscored', () => {
    const { exec } = fixture({ missingHead: true });
    const basis = resolvePinnedDiffBasis({ exec, headSha: head });
    expect(basis.ok).toBe(false);
    expect(computeNetDiffSignals({ exec, basis }).scored).toBe(false);
  });
  it('a mismatched head is refused', () => {
    expect(resolvePinnedDiffBasis({ exec: fixture({ head: base }).exec, headSha: head }))
      .toEqual({ ok: false, reason: 'head-mismatch' });
  });
  it('replacement ancestry cannot rescue unrelated histories', () => {
    expect(resolvePinnedDiffBasis({ exec: fixture({ unrelated: true }).exec, headSha: head }).ok).toBe(false);
  });
  it('moved base refs cannot change paired reads; the whole basis is stamped and compared', () => {
    const { exec, calls } = fixture();
    const basis = resolvePinnedDiffBasis({ exec, headSha: head });
    const text = computeNetDiffText({ exec, basis });
    const paths = computeNetDiffPaths({ exec, basis });
    expect(text).toMatchObject({ scored: true, baseSha: base, headSha: head, mergeBaseSha: fork });
    expect(paths.basis).toEqual(text.basis);
    expect(() => verifyNetDiffPair({ exec, basis, text, paths })).not.toThrow();
    for (const key of ['baseSha', 'headSha', 'mergeBaseSha']) {
      expect(sameDiffBasis(text, { ...paths, [key]: head === paths[key] ? base : head })).toBe(false);
      expect(() => verifyNetDiffPair({ exec, basis, text, paths: { ...paths, [key]: 'd'.repeat(40) } })).toThrow();
    }
    expect(calls.filter(c => c.args[0] === 'fetch')).toHaveLength(1);
    expect(calls.filter(c => c.args.includes('diff')).every(c => !c.args.some(a => a.includes('refs/')))).toBe(true);
  });
  it('ref-string evidence calls cannot fetch or score', () => {
    const { exec, calls } = fixture();
    expect(computeNetDiffText({ exec, rev: 'main' }).scored).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
