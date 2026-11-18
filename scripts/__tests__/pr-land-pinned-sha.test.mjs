import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { computeNetDiffText, computeNetDiffPaths, computeNetDiffChangedFiles, computeNetDiffSignals, resolveNetDiffBasis, readNetDiffAtHead, readDrainNetDiffSignals } from '../merge-ai-prs.mjs';
import { requireScoredNetDiff } from '../pr-land.mjs';
import { fetchTestGamingDiffEvidence } from '../conveyor/convert-advisory-dispatch.mjs';
import { scanDrainTestTampering } from '../merge-ai-prs.mjs';
import { shouldReparkForTestTampering } from '../lib/review-escalation.mjs';
import { resolveNetDiff } from '../fetch-parked.mjs';

describe('pr-land pinned SHA evidence', () => {
  let root, base, head, calls;
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const exec = (cmd, args, opts) => {
    calls.push({ args, opts });
    if (args[0] === 'fetch') return ''; // Simulated successful transport.
    if (args.at(-1) === 'FETCH_HEAD^{commit}') return base;
    return execFileSync(cmd, args, { ...opts, cwd: root });
  };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pr-land-pinned-'));
    calls = [];
    git('init', '--quiet');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    writeFileSync(join(root, 'guard.test.mjs'), "it('guards', () => expect(true).toBe(true));\n");
    git('add', '.'); git('commit', '--quiet', '-m', 'base');
    base = git('rev-parse', 'HEAD');
    git('rm', '--quiet', 'guard.test.mjs'); git('commit', '--quiet', '-m', 'remove guard');
    head = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/main', base);
    git('update-ref', 'refs/remotes/origin/lane/x', base);
    git('update-ref', `refs/remotes/origin/${head}`, base);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it.each(['transport failed', 'ETIMEDOUT'])('failed base fetch refuses a cached base containing the candidate: %s', message => {
    git('update-ref', 'refs/remotes/origin/main', head);
    expect(git('diff', '--name-only', 'refs/remotes/origin/main', head)).toBe('');
    const failed = (cmd, args, opts) => {
      if (args[0] === 'fetch') throw Object.assign(new Error(message), { code: message });
      return exec(cmd, args, opts);
    };
    const options = { exec: failed, rev: head, pinRev: true };
    expect(resolveNetDiffBasis(options)).toEqual({ ok: false, reason: 'base-fetch-failed',
      requestedFor: { remote: 'origin', base: 'main', rev: head } });
    for (const read of [computeNetDiffText, computeNetDiffPaths, computeNetDiffChangedFiles]) {
      expect(read(options)).toMatchObject({ scored: false, reason: 'base-fetch-failed' });
    }
    const sig = computeNetDiffSignals(options);
    expect(sig).toMatchObject({ scored: false, diffHunks: null, netDiffText: { scored: false, reason: 'base-fetch-failed' } });
    expect(() => requireScoredNetDiff(sig, head)).toThrow(/unscored/);
    const drain = readDrainNetDiffSignals({ exec: failed, headSha: head });
    expect(drain.scored).toBe(false);
    const gaming = scanDrainTestTampering(drain.netDiffText);
    expect(shouldReparkForTestTampering({ tampered: gaming.tampered, netDiffScored: drain.scored })).toBe(true);
    expect(resolveNetDiff({ exec: failed, headRef: 'lane/x', headRefOid: head }).basis).toBe('three-dot');
    expect(fetchTestGamingDiffEvidence({ exec: failed, rev: head, paths: ['guard.test.mjs'] }))
      .toMatchObject({ scored: false, reason: 'base-fetch-failed' });
  });

  it.each(['mismatched', 'unreadable', 'empty'])('successful fetch with %s fetched tip refuses stale tracking evidence', kind => {
    git('update-ref', 'refs/remotes/origin/main', head);
    const read = (cmd, args, opts) => {
      if (args.at(-1) === 'FETCH_HEAD^{commit}') {
        if (kind === 'unreadable') throw new Error('missing FETCH_HEAD');
        return kind === 'empty' ? '' : base;
      }
      return exec(cmd, args, opts);
    };
    const sig = computeNetDiffSignals({ exec: read, rev: head });
    expect(sig.netDiffText).toMatchObject({ scored: false, reason: 'base-fetch-failed' });
    expect(() => requireScoredNetDiff(sig, head)).toThrow(/unscored/);
  });

  it('moved ref and origin/SHA collision cannot clear another head', () => {
    const sig = computeNetDiffSignals({ exec, rev: head, fetchExtraRefs: ['lane/x'], pinRev: true });
    expect(requireScoredNetDiff(sig, head)).toBe(sig);
    expect(sig.changedFiles).toEqual(['guard.test.mjs']);
    expect(sig.netDiffText.text).toContain('-it(');
    expect(() => requireScoredNetDiff(sig, base)).toThrow(/unscored/);
    for (const { args, opts } of calls.filter(c => c.args[0] !== 'fetch')) {
      expect(args.join(' ')).not.toContain(`origin/${head}`);
      expect(args.join(' ')).not.toContain('lane/x');
      expect(opts.env.GIT_NO_REPLACE_OBJECTS).toBe('1');
    }
  });

  it('replacement objects cannot fabricate a fork point for unrelated history', () => {
    git('checkout', '--quiet', '--orphan', 'unrelated');
    writeFileSync(join(root, 'other'), 'other\n');
    git('add', '.'); git('commit', '--quiet', '-m', 'unrelated');
    const unrelated = git('rev-parse', 'HEAD');
    git('replace', unrelated, head);
    expect(git('merge-base', 'origin/main', unrelated)).toBe(base); // proves the hostile fork exists
    const sig = computeNetDiffSignals({ exec, rev: unrelated, pinRev: true });
    expect(sig.scored).toBe(false);
    expect(() => requireScoredNetDiff(sig, unrelated)).toThrow(/Repair the checkout/);
  });

  it.each([undefined, false])('all SHA readers pin even with pinRev=%s', pinRev => {
    const opts = { exec, rev: head, ...(pinRev === undefined ? {} : { pinRev }) };
    expect(resolveNetDiffBasis(opts)).toMatchObject({ ok: true, candidate: head, revSha: head });
    expect(computeNetDiffText(opts)).toMatchObject({ scored: true, revSha: head });
    expect(computeNetDiffPaths(opts)).toMatchObject({ scored: true, revSha: head, paths: ['guard.test.mjs'] });
    expect(computeNetDiffChangedFiles(opts)).toMatchObject({ scored: true, changedFiles: ['guard.test.mjs'] });
    expect(computeNetDiffSignals(opts)).toMatchObject({ scored: true, revSha: head });
  });

  it('64-hex defaults and explicit false cannot select origin/SHA candidates', () => {
    const sha = 'a'.repeat(64), fork = 'b'.repeat(64);
    const read = (cmd, args, opts) => {
      expect(opts.env.GIT_NO_REPLACE_OBJECTS).toBe('1');
      expect(args.join(' ')).not.toContain(`origin/${sha}`);
      if (args[0] === 'fetch') return '';
      if (args[0] === 'rev-parse') return sha;
      if (args[0] === 'merge-base') return fork;
      if (args.includes('diff')) return '';
      throw new Error('unexpected read');
    };
    for (const pinRev of [undefined, false]) {
      const sig = computeNetDiffSignals({ exec: read, rev: sha, pinRev });
      expect(requireScoredNetDiff(sig, sha)).toBe(sig);
    }
  });

  it('an old unpinned shared basis cannot be relabelled as pinned evidence', () => {
    const basis = resolveNetDiffBasis({ exec, rev: 'lane/x', pinRev: false });
    expect(basis.ok).toBe(true);
    const opts = { exec, rev: 'lane/x', basis, pinRev: true };
    for (const read of [computeNetDiffText, computeNetDiffPaths, computeNetDiffChangedFiles]) {
      expect(read(opts)).toMatchObject({ scored: false, reason: 'basis-mismatch' });
    }
  });


  it.each(['missing', 'mutable'])('a shared basis with a %s base pin cannot grant clearance', kind => {
    const basis = resolveNetDiffBasis({ exec, rev: head, pinRev: true });
    expect(basis).toMatchObject({ ok: true, baseRef: base, baseSha: base });
    if (kind === 'missing') delete basis.baseSha;
    else basis.baseRef = 'origin/main';
    for (const read of [computeNetDiffText, computeNetDiffPaths, computeNetDiffChangedFiles]) {
      expect(read({ exec, rev: head, basis, pinRev: true })).toMatchObject({ scored: false, reason: 'basis-mismatch' });
    }
  });

  it('mixed-case SHA readers bind canonical full identities to the requested commit', () => {
    const mixed = head.toUpperCase();
    const sig = computeNetDiffSignals({ exec, rev: mixed });
    expect(requireScoredNetDiff(sig, mixed)).toBe(sig);
    expect(readNetDiffAtHead({ exec, headSha: mixed })).toMatchObject({ scored: true, rev: head, revSha: head });
    expect(readDrainNetDiffSignals({ exec, headSha: mixed })).toMatchObject({ scored: true, revSha: head });
  });

  it.each(['abbreviated', 'origin display'])('ambiguous %s revs stay unscored unless they name an explicit branch', kind => {
    const rev = kind === 'abbreviated' ? head.slice(0, 12) : 'origin/lane/head';
    git('update-ref', 'refs/remotes/origin/lane/head', head);
    const ambiguous = computeNetDiffSignals({ exec, rev, pinRev: true });
    expect(ambiguous.scored).toBe(false);
    expect(() => requireScoredNetDiff(ambiguous, head)).toThrow(/unscored/);
    const sig = computeNetDiffSignals({ exec, rev: 'lane/head', pinRev: true });
    expect(requireScoredNetDiff(sig, head)).toBe(sig);
    expect(sig.changedFiles).toEqual(['guard.test.mjs']);
    expect(sig.netDiffText.rev).toBe(head);
  });

  it.each(['abbreviated', 'mixed-case'])('fetch-parked binds a %s head to its verified full SHA', kind => {
    git('update-ref', 'refs/remotes/origin/lane/head', head);
    const headRefOid = kind === 'abbreviated' ? head.slice(0, 12) : head.toUpperCase();
    const online = (cmd, args, opts) => args[0] === 'fetch' ? '' : exec(cmd, args, opts);
    expect(resolveNetDiff({ exec: online, headRef: 'lane/head', headRefOid })).toMatchObject({
      basis: 'net', paths: ['guard.test.mjs'],
    });
  });


  it('a real rename retains both deleted and added paths under hardened diff defaults', () => {
    git('checkout', '--quiet', base);
    git('mv', 'guard.test.mjs', 'renamed.test.mjs');
    git('commit', '--quiet', '-m', 'rename guard');
    const renamed = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/lane/renamed', renamed);
    const online = (cmd, args, opts) => args[0] === 'fetch' ? '' : exec(cmd, args, opts);
    expect(resolveNetDiff({ exec: online, headRef: 'lane/renamed', headRefOid: renamed })).toMatchObject({
      basis: 'net', paths: ['guard.test.mjs', 'renamed.test.mjs'],
    });
  });

  it.each([41, 63])('a malformed %s-hex fork point refuses scoring', length => {
    const read = (cmd, args, opts) => args[0] === 'merge-base' ? 'b'.repeat(length) : exec(cmd, args, opts);
    const sig = computeNetDiffSignals({ exec: read, rev: head });
    expect(sig.scored).toBe(false);
    expect(() => requireScoredNetDiff(sig, head)).toThrow(/Repair the checkout/);
  });

  it('missing head and dishonest resolved identity refuse scoring', () => {
    for (const read of [exec, (cmd, args, opts) => args[0] === 'rev-parse' ? base : exec(cmd, args, opts)]) {
      const sig = computeNetDiffSignals({ exec: read, rev: 'f'.repeat(40), pinRev: true });
      expect(sig.scored).toBe(false);
      expect(sig.netDiffText.scored).toBe(false);
      expect(() => requireScoredNetDiff(sig, 'f'.repeat(40))).toThrow(/unscored/);
    }
  });
});
