/**
 * @file scripts/__tests__/merge-ai-prs-net-diff-computation.test.mjs
 * @description Part of the merge-ai-prs.test.mjs split (originally one 4650-line file — see git history for the
 *   full-file description). This file covers the net-diff computation basis SHARED by the producer and drain
 *   (#2373/#2450/#2890/#2901/#1031/#3343): parseNumstat, computeNetDiffChangedFiles/Text/Paths,
 *   resolveNetDiffBasis, and computeNetDiffSignals — all exported from `scripts/merge-ai-prs.mjs` — plus their
 *   integration with `scoreEscalation`/`diffHunksFrom` from `scripts/lib/review-escalation.mjs`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { computeNetDiffPaths, parseNumstat, computeNetDiffChangedFiles, computeNetDiffText, resolveNetDiffBasis, computeNetDiffSignals } from '../merge-ai-prs.mjs';
import { scoreEscalation, diffHunksFrom } from '../lib/review-escalation.mjs';


describe('parseNumstat (#1821 — net two-dot diff for the review-escalation backstop)', () => {
  it('parses `<added>\\t<deleted>\\t<path>` lines into changedFiles + total diffLines', () => {
    const out = parseNumstat('3\t1\tscripts/merge-ai-prs.mjs\n0\t5\tbacklog/1821-foo.md\n');
    expect(out.changedFiles).toEqual(['scripts/merge-ai-prs.mjs', 'backlog/1821-foo.md']);
    expect(out.diffLines).toBe(9);
  });
  it('a net-unchanged file (already landed upstream) simply does not appear — nothing to parse for it', () => {
    // the whole point of #1821: the caller diffs `origin/main` vs the PR head directly, so a file whose
    // content is identical on both sides never shows up in `--numstat` output in the first place (unlike the
    // GitHub PR `files` list, which is a three-dot/merge-base diff and would still list it).
    const out = parseNumstat('2\t0\tscripts/only-real-change.mjs\n');
    expect(out.changedFiles).toEqual(['scripts/only-real-change.mjs']);
    expect(out.changedFiles).not.toContain('scripts/merge-ai-prs.mjs');
  });
  it('binary files use `-\\t-\\t<path>` — counted as 0 lines, path still included', () => {
    const out = parseNumstat('-\t-\tsrc/assets/logo.png\n1\t1\tREADME.md');
    expect(out.changedFiles).toEqual(['src/assets/logo.png', 'README.md']);
    expect(out.diffLines).toBe(2);
  });
  it('blank/empty input → empty result', () => {
    expect(parseNumstat('')).toEqual({ changedFiles: [], diffLines: 0 });
    expect(parseNumstat(null)).toEqual({ changedFiles: [], diffLines: 0 });
    expect(parseNumstat(undefined)).toEqual({ changedFiles: [], diffLines: 0 });
  });
});

describe('computeNetDiffChangedFiles (#2373 — SHARED net-diff basis, producer + drain)', () => {
  const fakeExec = (script = {}) => {
    const calls = [];
    const exec = (cmd, args, opts) => {
      // The stub key names WHICH TREES are compared, deliberately ignoring `--end-of-options` and
      // (#2890-review-r2 finding 2b) `--no-ext-diff`. Both are argv hygiene, not intent: encoding them in every
      // fixture key means adding one guard to one more call site reds 17 unrelated tests and tempts the author
      // to drop the guard instead of the fixtures. Each has its own dedicated assertion (`guards the git-diff
      // argv…`, `computeNetDiffText passes --no-ext-diff`), which is where a regression must fail.
      const intent = args.filter((a) => a !== '--end-of-options' && a !== '--verify' && a !== '--no-ext-diff');
      calls.push({ cmd, args, opts, key: `${cmd} ${intent.join(' ')}` });
      const h = script[`${cmd} ${intent.join(' ')}`];
      if (h && h.throw) throw new Error(h.throw);
      if (h && 'stdout' in h) return h.stdout;
      // Faithful to real git: an UNSTUBBED `git diff` against a ref this fake doesn't know throws
      // (unknown revision) rather than silently returning '' — so an invalid candidate (e.g. the producer's
      // `<remote>/<sha>`) fails fast and the fallthrough is exercised as it would be against real git.
      if (args[0] === 'diff') throw new Error('unknown revision (unstubbed)');
      // #3343 — same faithfulness for the ancestry probe (`git log <base>..<head>`): real git exits 128 on a
      // range whose refs it cannot resolve, it does not print an empty log. Returning '' here would hand
      // `resolveNetDiffBasis` a CONFIDENT empty file set for every fixture that never stubbed the probe —
      // an under-score, the one direction the basis must never take.
      if (args[0] === 'log') throw new Error('unknown revision range (unstubbed)');
      return '';
    };
    return { exec, calls };
  };

  // PR #1031 r4 finding 1 — `candidate` is the caller-supplied refname on the second resolution pass. Verified
  // on git 2.50.1: unguarded, `git diff --numstat <base> '--output=<path>'` exits 0 and WRITES that file. Worse
  // than the write — the swallowed numstat then reads EMPTY while the candidate still resolves, so this reports
  // ZERO blast radius for a PR the lander is about to merge.
  it('guards the git-diff argv with --end-of-options at EVERY position taking a caller-supplied ref', () => {
    const { exec, calls } = fakeExec({
      'git diff --numstat origin/main origin/lane/x': { stdout: '1\t0\tREADME.md\n' },
      'git diff --numstat a1b2c3d4e5f6 origin/lane/x': { stdout: '1\t0\tREADME.md\n' },
      'git diff origin/main origin/lane/x': { stdout: 'diff --git a/README.md b/README.md\n' },
    });
    computeNetDiffChangedFiles({ exec, rev: 'lane/x', baseRev: 'a1b2c3d4e5f6', fetchExtraRefs: ['lane/x'] });
    computeNetDiffText({ exec, rev: 'lane/x', fetchExtraRefs: ['lane/x'] });
    const diffs = calls.filter((c) => c.args[0] === 'diff');
    expect(diffs.length, 'no git diff calls made — the assertion would pass vacuously').toBeGreaterThan(2);
    for (const c of diffs) {
      const g = c.args.indexOf('--end-of-options');
      expect(g, `unguarded git diff argv: ${c.args.join(' ')}`).toBeGreaterThan(-1);
      const firstRef = c.args.findIndex((a, i) => i > 0 && !a.startsWith('-'));
      expect(g, `guard must PRECEDE the refs: ${c.args.join(' ')}`).toBeLessThan(firstRef);
    }
  });

  it('fetches BASE with an EXPLICIT destination refspec (never a bare `git fetch <remote> <base>`, which relies on the opportunistic tracking-ref update)', () => {
    const { exec, calls } = fakeExec({ 'git diff --numstat origin/main deadbeef': { stdout: '1\t0\tREADME.md\n' } });
    computeNetDiffChangedFiles({ exec, rev: 'deadbeef' });
    expect(calls.some((c) => c.args[0] === 'fetch' && c.args.includes('origin') && c.args.includes('+main:refs/remotes/origin/main'))).toBe(true);
  });

  it('diffs `<remote>/<base>` against `rev` directly (a plain two-tree comparison, content-only) and parses via parseNumstat', () => {
    const { exec } = fakeExec({ 'git diff --numstat origin/main deadbeef': { stdout: '3\t1\tscripts/pr-land.mjs\n' } });
    const r = computeNetDiffChangedFiles({ exec, rev: 'deadbeef' });
    expect(r).toEqual({ changedFiles: ['scripts/pr-land.mjs'], diffLines: 4, scored: true, humanBasisFiles: ['scripts/pr-land.mjs'] });
  });

  it('a file already landed upstream (net-identical) never appears — the false-positive #2373 exists to prevent', () => {
    // origin/main already carries the gate-fix commit, so its tree is identical to the PR head for that file:
    // `git diff --numstat` naturally omits it, regardless of whether the commit is in the PR's ancestry.
    const { exec } = fakeExec({ 'git diff --numstat origin/main deadbeef': { stdout: '1\t0\tbacklog/2373-x.md\n' } });
    const r = computeNetDiffChangedFiles({ exec, rev: 'deadbeef' });
    expect(r.changedFiles).not.toContain('scripts/merge-ai-prs.mjs');
    expect(r.changedFiles).not.toContain('scripts/lib/review-escalation.mjs');
  });

  it('the fetch failing degrades gracefully — still attempts the diff off whatever is locally cached', () => {
    const { exec, calls } = fakeExec({
      'git fetch origin +main:refs/remotes/origin/main --quiet': { throw: 'network unreachable' },
      'git diff --numstat origin/main deadbeef': { stdout: '1\t0\tREADME.md\n' },
    });
    const r = computeNetDiffChangedFiles({ exec, rev: 'deadbeef' });
    expect(r).toEqual({ changedFiles: ['README.md'], diffLines: 1, scored: true, humanBasisFiles: ['README.md'] });
    expect(calls.some((c) => c.args[0] === 'diff')).toBe(true);
  });

  it('#2373-review-r2 — the REMOTE-tracking candidate `<remote>/<rev>` is tried BEFORE the bare `rev` (dodges a stale-local-branch-name collision in the drain, where `rev` is `v.headRef`, a branch NAME)', () => {
    // Both candidates would "resolve" here; only the ORDER distinguishes them. origin/lane/x (freshly fetched)
    // carries the real diff; a stale local `lane/x` carries a WRONG/partial one. Remote-first must win.
    const { exec, calls } = fakeExec({
      'git diff --numstat origin/main origin/lane/x': { stdout: '2\t2\tscripts/merge-ai-prs.mjs\n' }, // fresh remote — correct
      'git diff --numstat origin/main lane/x': { stdout: '1\t0\tREADME.md\n' }, // stale local — WRONG, must not win
    });
    const r = computeNetDiffChangedFiles({ exec, rev: 'lane/x', fetchExtraRefs: ['lane/x'] });
    expect(r).toEqual({ changedFiles: ['scripts/merge-ai-prs.mjs'], diffLines: 4, scored: true, humanBasisFiles: ['scripts/merge-ai-prs.mjs'] });
    // Resolved on the FIRST diff attempt — the remote-tracking ref — so the stale-local candidate is never reached.
    const diffCalls = calls.filter((c) => c.args[0] === 'diff');
    expect(diffCalls.length).toBe(1);
    expect(diffCalls[0].key).toBe('git diff --numstat origin/main origin/lane/x');
  });

  it('resolves a foreign/sibling clone\'s PR via `<remote>/<rev>` when `rev` is not a local branch (the head ref was fetched by `fetchExtraRefs`)', () => {
    const { exec, calls } = fakeExec({
      'git diff --numstat origin/main origin/lane/x': { stdout: '2\t2\tscripts/merge-ai-prs.mjs\n' },
      // no local `lane/x` branch — the bare-rev candidate would throw (unstubbed) if ever reached
    });
    const r = computeNetDiffChangedFiles({ exec, rev: 'lane/x', fetchExtraRefs: ['lane/x'] });
    expect(r).toEqual({ changedFiles: ['scripts/merge-ai-prs.mjs'], diffLines: 4, scored: true, humanBasisFiles: ['scripts/merge-ai-prs.mjs'] });
    expect(calls.filter((c) => c.args[0] === 'diff').length).toBe(1);
  });

  it('#2373-review-r2 — PRODUCER path (`rev` is a resolved local SHA): `<remote>/<sha>` is an invalid ref that fails fast, then the bare SHA resolves — one extra cheap failed git call, no behavior change', () => {
    const { exec, calls } = fakeExec({
      // `origin/deadbeef` is NOT stubbed → the fake throws (unknown revision), mirroring real git on an invalid ref.
      'git diff --numstat origin/main deadbeef': { stdout: '3\t1\tscripts/pr-land.mjs\n' },
    });
    const r = computeNetDiffChangedFiles({ exec, rev: 'deadbeef' }); // producer: no fetchExtraRefs
    expect(r).toEqual({ changedFiles: ['scripts/pr-land.mjs'], diffLines: 4, scored: true, humanBasisFiles: ['scripts/pr-land.mjs'] });
    const diffCalls = calls.filter((c) => c.args[0] === 'diff');
    expect(diffCalls.map((c) => c.key)).toEqual([
      'git diff --numstat origin/main origin/deadbeef', // tried first, fails fast (invalid ref)
      'git diff --numstat origin/main deadbeef', // falls through to the real local SHA
    ]);
  });

  it('#2373-review — neither `rev` nor `<remote>/<rev>` resolves → scored:false (FETCH_HEAD is NOT a fallback candidate: it would resolve to `<remote>/<base>` — base is first in the fetch refspec — and "succeed" with a base-vs-base EMPTY diff, masking this real miss; scored:false lets the caller fall through to its GitHub files-list backstop)', () => {
    const { exec, calls } = fakeExec({
      'git diff --numstat origin/main lane/x': { throw: 'unknown revision' },
      'git diff --numstat origin/main origin/lane/x': { throw: 'unknown revision' },
      // A base-vs-base FETCH_HEAD diff would return '' (empty) and score true with zero changed files — the
      // exact false-negative #2373-review removes. It must NEVER be attempted; assertion below proves it isn't.
      'git diff --numstat origin/main FETCH_HEAD': { stdout: '' },
    });
    const r = computeNetDiffChangedFiles({ exec, rev: 'lane/x', fetchExtraRefs: ['lane/x'] });
    expect(r).toEqual({ changedFiles: [], diffLines: 0, scored: false, humanBasisFiles: [], reason: 'ref-unresolved' });
    expect(calls.some((c) => c.key === 'git diff --numstat origin/main FETCH_HEAD')).toBe(false);
  });

  it('#2373-review — FETCH_HEAD is never a diff candidate, with OR without fetchExtraRefs (it always points at `<remote>/<base>` → a spurious empty base-vs-base diff)', () => {
    const { exec, calls } = fakeExec({
      'git diff --numstat origin/main lane/x': { throw: 'unknown revision' },
      'git diff --numstat origin/main origin/lane/x': { throw: 'unknown revision' },
    });
    const r = computeNetDiffChangedFiles({ exec, rev: 'lane/x' }); // no fetchExtraRefs
    expect(r).toEqual({ changedFiles: [], diffLines: 0, scored: false, humanBasisFiles: [], reason: 'ref-unresolved' });
    expect(calls.some((c) => c.key === 'git diff --numstat origin/main FETCH_HEAD')).toBe(false);
  });

  it('no exec / no rev → scored:false without touching git at all', () => {
    expect(computeNetDiffChangedFiles({})).toEqual({ changedFiles: [], diffLines: 0, scored: false, humanBasisFiles: [] });
    const { exec, calls } = fakeExec();
    expect(computeNetDiffChangedFiles({ exec })).toEqual({ changedFiles: [], diffLines: 0, scored: false, humanBasisFiles: [] });
    expect(calls.length).toBe(0);
  });

  // #2952 — the fixable case: a caller-side `exec`-contract violation used to be BYTE-IDENTICAL to a legitimately
  // absent ref (both `{ scored: false }`, no signal) — reproduced live in the human review of WE PR #1063
  // (2026-08-06), where a shell-exec shaped `(cmd, opts) => execSync(cmd, opts)` was injected in place of the
  // documented `(cmd, args, opts) => execFileSync(cmd, args, opts)` contract. Called 3-arg, it received the ARGS
  // ARRAY in its `opts` position; Node's own `execSync` argument validation then throws
  // `TypeError [ERR_INVALID_ARG_TYPE]` for a non-object `options` — reproduced directly here without touching a
  // real subprocess, since the classification (`isExecContractError`) keys off `instanceof TypeError`, not the
  // specific message.
  it('#2952 — exec-contract: a wrongly-shaped `exec` (2-arity, treating the args ARRAY as the options object) throws a TypeError, and the degrade reports reason:"exec-contract" instead of looking identical to an absent ref', () => {
    const badExec = (cmd, optsShapedAsArgsArray) => {
      if (!optsShapedAsArgsArray || Array.isArray(optsShapedAsArgsArray)) {
        throw new TypeError('The "options" argument must be of type object. Received an instance of Array');
      }
      return '';
    };
    const r = computeNetDiffChangedFiles({ exec: badExec, rev: 'lane/x', fetchExtraRefs: ['lane/x'] });
    expect(r).toEqual({ changedFiles: [], diffLines: 0, scored: false, humanBasisFiles: [], reason: 'exec-contract' });
  });

  it('#2952 — a NORMAL git failure (unresolvable candidates) is classified "ref-unresolved", never "exec-contract" — a well-shaped exec throwing a plain Error (not TypeError) is the legitimately-absent-ref case', () => {
    const { exec } = fakeExec({
      'git diff --numstat origin/main lane/x': { throw: 'unknown revision' },
      'git diff --numstat origin/main origin/lane/x': { throw: 'unknown revision' },
    });
    const r = computeNetDiffChangedFiles({ exec, rev: 'lane/x', fetchExtraRefs: ['lane/x'] });
    expect(r.reason).toBe('ref-unresolved');
  });

  it('#2952 — additive only: a consumer that destructures just `scored` (the pre-#2952 contract) sees no behavior change — `reason` is a new field, every other field is untouched', () => {
    const { exec } = fakeExec({
      'git diff --numstat origin/main lane/x': { throw: 'unknown revision' },
      'git diff --numstat origin/main origin/lane/x': { throw: 'unknown revision' },
    });
    const r = computeNetDiffChangedFiles({ exec, rev: 'lane/x', fetchExtraRefs: ['lane/x'] });
    const { scored } = r; // a consumer that reads ONLY `scored`, exactly as every consumer did pre-#2952
    expect(scored).toBe(false);
    expect(r.changedFiles).toEqual([]);
    expect(r.diffLines).toBe(0);
    expect(r.humanBasisFiles).toEqual([]);
  });

  // PR #1031 review, finding 1 — `fetchExtraRefs` carries a branch name straight off the `gh` API, and a
  // dash-leading refname is LEGAL (`git check-ref-format 'refs/heads/--output=/tmp/pwn'` exits 0). Verified on
  // git 2.50.1: the unguarded form EXECUTES an injected `--upload-pack=<script>`, while the guarded form refuses
  // with `invalid refspec`. So the guard must PRECEDE every caller-supplied argv element, not merely be present.
  it('guards the fetch argv with --end-of-options BEFORE any caller-supplied value', () => {
    const { exec, calls } = fakeExec({ 'git diff --numstat origin/main deadbeef': { stdout: '1\t0\tREADME.md\n' } });
    computeNetDiffChangedFiles({ exec, rev: 'deadbeef', fetchExtraRefs: ['lane/x'] });
    const fetch = calls.find((c) => c.args[0] === 'fetch');
    const guard = fetch.args.indexOf('--end-of-options');
    expect(guard, 'the fetch argv carries no --end-of-options guard').toBeGreaterThan(-1);
    expect(guard).toBeLessThan(fetch.args.indexOf('origin'));
    expect(guard).toBeLessThan(fetch.args.indexOf('lane/x'));
  });

  it('honors a custom remote/base and passes fetchExtraRefs through to the fetch call', () => {
    const { exec, calls } = fakeExec({ 'git diff --numstat upstream/release deadbeef': { stdout: '1\t0\tREADME.md\n' } });
    computeNetDiffChangedFiles({ exec, remote: 'upstream', base: 'release', rev: 'deadbeef', fetchExtraRefs: ['lane/x'] });
    expect(calls[0]).toMatchObject({ args: ['fetch', '--quiet', '--end-of-options', 'upstream', '+release:refs/remotes/upstream/release', 'lane/x'] });
  });

  // #2390 — a STACKED lane records the SHA it was cut from (its predecessor's tip) as the manifest per-repo
  // `base`; scoring the SIZE from THAT base de-inflates the lane to its OWN delta, not the cumulative stack vs
  // main. #2390-review-fix — but the human-gate basis (`humanBasisFiles`) stays the cumulative origin/main…head,
  // and the base is trusted for the size de-inflation ONLY when it is a strict ancestor of head.
  it('#2390 — a stacked lane (baseRev = strict-ancestor manifest base) de-inflates SIZE to base…head, but humanBasisFiles stays the cumulative origin/main…head (keeps the ancestor gate-self edit)', () => {
    const { exec, calls } = fakeExec({
      // Cumulative diff INCLUDES an ancestor's gate-self edit; the own delta (from the base) does not.
      'git diff --numstat origin/main origin/lane/child': { stdout: '4\t2\tbacklog/2390-own.md\n2\t0\tscripts/lib/review-escalation.mjs\n' },
      'git diff --numstat a1b2c3d4e5f6 origin/lane/child': { stdout: '4\t2\tbacklog/2390-own.md\n' },
    });
    const r = computeNetDiffChangedFiles({ exec, rev: 'lane/child', baseRev: 'a1b2c3d4e5f6', fetchExtraRefs: ['lane/child'] });
    expect(r.changedFiles).toEqual(['backlog/2390-own.md']); // SIZE de-inflated to the own delta
    expect(r.diffLines).toBe(6);
    expect(r.scored).toBe(true);
    expect(r.humanBasisFiles).toEqual(['backlog/2390-own.md', 'scripts/lib/review-escalation.mjs']); // cumulative — gate file preserved
    const diffCalls = calls.filter((c) => c.args[0] === 'diff');
    expect(diffCalls.some((c) => c.key === 'git diff --numstat a1b2c3d4e5f6 origin/lane/child')).toBe(true); // own-delta off the base SHA
    expect(diffCalls.some((c) => c.key === 'git diff --numstat origin/main origin/lane/child')).toBe(true); // human basis off origin/main
  });

  it('#2390-review-fix — the base tracking-ref is ALWAYS fetched, even when stacked (the cumulative human-gate basis needs origin/main; a stacked base can never suppress it)', () => {
    const { exec, calls } = fakeExec({
      'git diff --numstat origin/main origin/lane/child': { stdout: '1\t0\tREADME.md\n' },
      'git diff --numstat a1b2c3d4e5f6 origin/lane/child': { stdout: '1\t0\tREADME.md\n' },
    });
    computeNetDiffChangedFiles({ exec, rev: 'lane/child', baseRev: 'a1b2c3d4e5f6', fetchExtraRefs: ['lane/child'] });
    const fetch = calls.find((c) => c.args[0] === 'fetch');
    expect(fetch.args).toEqual(['fetch', '--quiet', '--end-of-options', 'origin', '+main:refs/remotes/origin/main', 'lane/child']);
  });

  it('#2390 — a malformed (non-hex) baseRev is IGNORED — the origin/main basis serves BOTH size and the human gate, never an injected git arg', () => {
    const { exec, calls } = fakeExec({ 'git diff --numstat origin/main deadbeef': { stdout: '1\t0\tREADME.md\n' } });
    const r = computeNetDiffChangedFiles({ exec, rev: 'deadbeef', baseRev: '--upload-pack=evil' });
    expect(r).toEqual({ changedFiles: ['README.md'], diffLines: 1, scored: true, humanBasisFiles: ['README.md'] });
    expect(calls.some((c) => c.args.includes('--upload-pack=evil'))).toBe(false); // the poison value never reaches git
    expect(calls[0].args).toContain('+main:refs/remotes/origin/main'); // sibling basis restored
  });

  // ── #2390-review-fix — the CORE security guarantees: a self-declared / mis-set base can de-inflate SIZE but
  //    can NEVER narrow or suppress the gate-self / review:human trigger. ────────────────────────────────────
  it('#2390-review-fix — an ANCESTOR policy-core edit that drops out of the own-delta is STILL caught: it rides humanBasisFiles → scoreEscalation humanRequired:true', () => {
    const { exec } = fakeExec({
      // Cumulative origin/main…head carries the ancestor's edit to a policy-tier trust-chain file (the roster).
      'git diff --numstat origin/main origin/lane/child': { stdout: '2\t0\tbacklog/2390-child.md\n5\t1\tscripts/lib/gate-config.mjs\n' },
      // The own delta (base…head) does NOT — the gate-self edit was the ancestor's, before this lane's base.
      'git diff --numstat feedface origin/lane/child': { stdout: '2\t0\tbacklog/2390-child.md\n' },
    });
    const net = computeNetDiffChangedFiles({ exec, rev: 'lane/child', baseRev: 'feedface', fetchExtraRefs: ['lane/child'] });
    expect(net.changedFiles).not.toContain('scripts/lib/gate-config.mjs'); // SIZE de-inflated (the ancestor edit is out)
    expect(net.humanBasisFiles).toContain('scripts/lib/gate-config.mjs'); // but the human gate still sees it
    const score = scoreEscalation({ humanSurfaces: 'broad', changedFiles: net.changedFiles, diffLines: net.diffLines, humanBasisFiles: net.humanBasisFiles });
    expect(score.humanRequired).toBe(true); // THE FIX: a policy-core edit forces review:human even from an ancestor
  });

  it('#2390-review-fix — a mis-set base==head is REJECTED (rev-parse equal ⇒ not a strict ancestor): the own-delta falls back to the cumulative basis, so an empty base…head can never silently under-score', () => {
    const { exec, calls } = fakeExec({
      // The fixture is the ROSTER (a declarative-leash file, #2771/#2785): the point of this case is that a
      // mis-set base==head cannot under-score the HUMAN basis, so it needs a file that still forces a human.
      'git diff --numstat origin/main origin/lane/child': { stdout: '3\t0\tscripts/lib/gate-config.mjs\n' },
      'git rev-parse cafebabecafe': { stdout: 'cafebabecafe\n' },
      'git rev-parse origin/lane/child': { stdout: 'cafebabecafe\n' }, // head resolves to the SAME sha as base
    });
    const net = computeNetDiffChangedFiles({ exec, rev: 'lane/child', baseRev: 'cafebabecafe', fetchExtraRefs: ['lane/child'] });
    expect(net.changedFiles).toEqual(['scripts/lib/gate-config.mjs']); // fell back to cumulative — NOT an empty under-score
    expect(net.humanBasisFiles).toEqual(['scripts/lib/gate-config.mjs']);
    expect(calls.some((c) => c.key === 'git diff --numstat cafebabecafe origin/lane/child')).toBe(false); // own-delta never attempted
    expect(scoreEscalation({ humanSurfaces: 'broad', changedFiles: net.changedFiles, diffLines: net.diffLines, humanBasisFiles: net.humanBasisFiles }).humanRequired).toBe(true);
  });

  it('#2390-review-fix — a base that is NOT an ancestor of head is REJECTED (merge-base --is-ancestor non-zero): fall back to the cumulative origin/main basis rather than trust an unrelated-tree base', () => {
    const { exec, calls } = fakeExec({
      'git diff --numstat origin/main origin/lane/child': { stdout: '2\t0\tbacklog/x.md\n1\t0\tscripts/lib/gate-config.mjs\n' },
      'git merge-base --is-ancestor deadbeefdead origin/lane/child': { throw: 'not an ancestor' },
    });
    const net = computeNetDiffChangedFiles({ exec, rev: 'lane/child', baseRev: 'deadbeefdead', fetchExtraRefs: ['lane/child'] });
    expect(net.changedFiles).toEqual(['backlog/x.md', 'scripts/lib/gate-config.mjs']); // cumulative — a bad base never de-inflates
    expect(calls.some((c) => c.key === 'git diff --numstat deadbeefdead origin/lane/child')).toBe(false); // own-delta never attempted
    expect(scoreEscalation({ humanSurfaces: 'broad', changedFiles: net.changedFiles, diffLines: net.diffLines, humanBasisFiles: net.humanBasisFiles }).humanRequired).toBe(true);
  });

  // ── #2404 — twin of #2373: a FRESH base against an UN-REBASED head over-reports (PR #364 repro: a 2-file
  //    docs-only PR scored dozens of "changed" files that were purely upstream-advanced). The diff basis must
  //    be the lane's own fork point (`merge-base(origin/main, head)`), not the base tip directly. ────────────
  it('#2404 — a head BEHIND an advanced base diffs off `merge-base(origin/main, head)`, not the base tip, so upstream-only advances never appear as the PR\'s own changes', () => {
    const { exec, calls } = fakeExec({
      // origin/main has advanced past the lane's fork point with commits touching gate-self files; a bare
      // origin/main..head diff would sweep those in. merge-base finds the true fork point.
      'git merge-base origin/main origin/lane/x': { stdout: 'forkpoint1234\n' },
      'git diff --numstat forkpoint1234 origin/lane/x': { stdout: '2\t0\tbacklog/2404-x.md\n' },
      // Unused if the fix works — proves the cumulative-from-tip basis is NOT what gets diffed.
      'git diff --numstat origin/main origin/lane/x': { stdout: '2\t0\tbacklog/2404-x.md\n15\t58\tscripts/merge-ai-prs.mjs\n6\t13\tscripts/pr-land.mjs\n' },
    });
    const r = computeNetDiffChangedFiles({ exec, rev: 'lane/x', fetchExtraRefs: ['lane/x'] });
    expect(r).toEqual({ changedFiles: ['backlog/2404-x.md'], diffLines: 2, scored: true, humanBasisFiles: ['backlog/2404-x.md'] });
    expect(r.changedFiles).not.toContain('scripts/merge-ai-prs.mjs'); // no false gate-self hit
    expect(calls.some((c) => c.key === 'git diff --numstat origin/main origin/lane/x')).toBe(false); // the tip-basis diff is never attempted
    expect(scoreEscalation({ changedFiles: r.changedFiles, diffLines: r.diffLines, humanBasisFiles: r.humanBasisFiles }).humanRequired).toBe(false);
  });

  it('#2404 — a head already rebased onto origin/main is unaffected: merge-base(origin/main, head) == origin/main, so the diff basis is unchanged', () => {
    const { exec, calls } = fakeExec({
      'git merge-base origin/main deadbeef': { stdout: 'origin/main\n' },
      'git diff --numstat origin/main deadbeef': { stdout: '1\t0\tREADME.md\n' },
    });
    const r = computeNetDiffChangedFiles({ exec, rev: 'deadbeef' }); // producer: `<remote>/<sha>` fails fast first, falls through to the bare SHA (as in the pre-#2404 fallback-chain test)
    expect(r).toEqual({ changedFiles: ['README.md'], diffLines: 1, scored: true, humanBasisFiles: ['README.md'] });
    expect(calls.filter((c) => c.args[0] === 'diff').map((c) => c.key)).toEqual([
      'git diff --numstat origin/main origin/deadbeef', // tried first, fails fast (invalid ref)
      'git diff --numstat origin/main deadbeef', // falls through to the real local SHA, narrowed to the fork point (== origin/main here)
    ]);
  });

  it('#2404 — an unresolvable merge-base (no common history) degrades to the base tip itself — the prior, safe over-scoring behavior, never a scoring failure', () => {
    const { exec } = fakeExec({
      'git merge-base origin/main deadbeef': { throw: 'no common ancestors' },
      'git diff --numstat origin/main deadbeef': { stdout: '3\t1\tscripts/pr-land.mjs\n' },
    });
    const r = computeNetDiffChangedFiles({ exec, rev: 'deadbeef' });
    expect(r).toEqual({ changedFiles: ['scripts/pr-land.mjs'], diffLines: 4, scored: true, humanBasisFiles: ['scripts/pr-land.mjs'] });
  });

  // ── #3343 — the base-TIP fallback above is safe for SIZE and blast-radius (they buy reviewer attention) and
  //    NOT safe for the STATUTE / declarative-leash terms, which force `review:human`: `decideSetLabel` then
  //    refuses `accepted` on that PR and only the human ceremony clears it. One upstream commit touching
  //    `docs/agent/platform-decisions.md` is enough to spend a person on a PR of three backlog cards. So before
  //    settling for the base tip, the basis asks the ANCESTRY question instead — which needs no merge-base. ───
  it("#3343 — a FAILED merge-base lookup no longer falls straight back to the base TIP for the human-gate basis: the ancestry set (`origin/main..head`) is used, so a head merely BEHIND main is not scored on the upstream commits it lacks", () => {
    const { exec } = fakeExec({
      'git merge-base origin/main deadbeef': { throw: 'no common ancestors' },
      // The base-TIP diff — three cards this head really added, PLUS two files upstream advanced on while it sat
      // behind. `docs/agent/platform-decisions.md` is a STATUTE path, and any statute touch forces review:human.
      'git diff --numstat origin/main deadbeef': { stdout: '2\t0\tbacklog/a.md\n2\t0\tbacklog/b.md\n2\t0\tbacklog/c.md\n4\t4\tdocs/agent/platform-decisions.md\n3\t1\tscripts/guard-bash.mjs\n' },
      // The ANCESTRY set — the commits on this head and not on main. The three cards; nothing upstream-only.
      'git log --numstat --diff-merges=first-parent --pretty=format: origin/main..deadbeef --': { stdout: '2\t0\tbacklog/a.md\n2\t0\tbacklog/b.md\n2\t0\tbacklog/c.md\n' },
    });
    const basis = resolveNetDiffBasis({ exec, rev: 'deadbeef' });
    expect(basis.ok).toBe(true);
    expect(basis.basisKind).toBe('ancestry');
    expect(basis.basisNarrowed).toBe(true);
    expect(basis.humanBasis.changedFiles).toEqual(['backlog/a.md', 'backlog/b.md', 'backlog/c.md']);
    expect(basis.humanBasis.changedFiles).not.toContain('docs/agent/platform-decisions.md');
    // The whole point: no `review:human` on a PR of three backlog cards.
    const score = scoreEscalation({ changedFiles: basis.humanBasis.changedFiles, diffLines: basis.humanBasis.diffLines, humanBasisFiles: basis.humanBasis.changedFiles });
    expect(score.humanRequired).toBe(false);
  });

  it("#3343 NEGATIVE DIRECTION — a head that GENUINELY edits a statute file still earns review:human when the merge-base lookup fails: one of its own commits touches the file, so the ancestry set contains it", () => {
    const { exec } = fakeExec({
      'git merge-base origin/main deadbeef': { throw: 'no common ancestors' },
      'git diff --numstat origin/main deadbeef': { stdout: '2\t0\tbacklog/a.md\n9\t3\tdocs/agent/platform-decisions.md\n' },
      // This head's OWN commits include the statute edit — the ancestry set reports it, exactly as it must.
      'git log --numstat --diff-merges=first-parent --pretty=format: origin/main..deadbeef --': { stdout: '2\t0\tbacklog/a.md\n9\t3\tdocs/agent/platform-decisions.md\n' },
    });
    const basis = resolveNetDiffBasis({ exec, rev: 'deadbeef' });
    expect(basis.basisKind).toBe('ancestry');
    expect(basis.humanBasis.changedFiles).toContain('docs/agent/platform-decisions.md');
    const score = scoreEscalation({ humanSurfaces: 'broad', changedFiles: basis.humanBasis.changedFiles, diffLines: basis.humanBasis.diffLines, humanBasisFiles: basis.humanBasis.changedFiles });
    expect(score.humanRequired).toBe(true);
    expect(score.reasons.some((r) => r.startsWith('statute ('))).toBe(true);
  });

  it("#3343 NEGATIVE DIRECTION — a declarative-leash (gate-self) edit likewise still forces review:human off the ancestry basis", () => {
    const { exec } = fakeExec({
      'git merge-base origin/main deadbeef': { throw: 'no common ancestors' },
      'git diff --numstat origin/main deadbeef': { stdout: '5\t1\tscripts/lib/gate-config.mjs\n' },
      'git log --numstat --diff-merges=first-parent --pretty=format: origin/main..deadbeef --': { stdout: '5\t1\tscripts/lib/gate-config.mjs\n' },
    });
    const basis = resolveNetDiffBasis({ exec, rev: 'deadbeef' });
    expect(scoreEscalation({ humanSurfaces: 'broad', changedFiles: basis.humanBasis.changedFiles, humanBasisFiles: basis.humanBasis.changedFiles }).humanRequired).toBe(true);
  });

  it("#3343 — when the ancestry probe cannot answer either, the legacy base-TIP fallback is kept AND SAID: `basisKind:'base-tip'`, `basisNarrowed:false` — no longer byte-identical to a narrowed basis", () => {
    const { exec } = fakeExec({
      'git merge-base origin/main deadbeef': { throw: 'no common ancestors' },
      'git diff --numstat origin/main deadbeef': { stdout: '3\t1\tscripts/pr-land.mjs\n' },
      // `git log` deliberately unstubbed → this fake throws, as real git does on a range it cannot resolve.
    });
    const basis = resolveNetDiffBasis({ exec, rev: 'deadbeef' });
    expect(basis.ok).toBe(true); // still a basis — the fallback is not a scoring failure
    expect(basis.basisKind).toBe('base-tip');
    expect(basis.basisNarrowed).toBe(false);
    expect(basis.humanBasis.changedFiles).toEqual(['scripts/pr-land.mjs']); // unchanged over-scoring content
  });

  it("#3343 — a merge-base that RESOLVES is untouched: the ancestry probe never runs, and the basis reports `basisKind:'merge-base'`", () => {
    const { exec, calls } = fakeExec({
      'git merge-base origin/main deadbeef': { stdout: 'forkpoint1234\n' },
      'git diff --numstat forkpoint1234 deadbeef': { stdout: '2\t0\tbacklog/a.md\n' },
    });
    const basis = resolveNetDiffBasis({ exec, rev: 'deadbeef' });
    expect(basis.basisKind).toBe('merge-base');
    expect(basis.basisNarrowed).toBe(true);
    expect(calls.some((c) => c.args[0] === 'log')).toBe(false); // no extra subprocess on the hot path
  });

  it("#3343 — the ancestry set is DEDUPLICATED by path across commits (a file edited in two commits is one entry, its lines summed — churn, the over-scoring direction)", () => {
    const { exec } = fakeExec({
      'git merge-base origin/main deadbeef': { throw: 'no common ancestors' },
      'git diff --numstat origin/main deadbeef': { stdout: '1\t1\tbacklog/a.md\n' },
      'git log --numstat --diff-merges=first-parent --pretty=format: origin/main..deadbeef --': { stdout: '\n3\t1\tbacklog/a.md\n\n2\t0\tbacklog/a.md\n' },
    });
    const basis = resolveNetDiffBasis({ exec, rev: 'deadbeef' });
    expect(basis.humanBasis.changedFiles).toEqual(['backlog/a.md']);
    expect(basis.humanBasis.diffLines).toBe(6); // 3+1 then 2+0 — summed across commits, never a net count
  });

  it('#2404 — the merge-base narrowing benefits `own` too when a lane is ALSO stacked (baseRev): the strict-ancestor own-delta wins over the merge-base cumulative basis, as before', () => {
    const { exec } = fakeExec({
      'git merge-base origin/main origin/lane/child': { stdout: 'forkpoint\n' },
      'git diff --numstat forkpoint origin/lane/child': { stdout: '4\t2\tbacklog/2390-own.md\n2\t0\tscripts/lib/review-escalation.mjs\n' },
      'git diff --numstat a1b2c3d4e5f6 origin/lane/child': { stdout: '4\t2\tbacklog/2390-own.md\n' },
    });
    const r = computeNetDiffChangedFiles({ exec, rev: 'lane/child', baseRev: 'a1b2c3d4e5f6', fetchExtraRefs: ['lane/child'] });
    expect(r.changedFiles).toEqual(['backlog/2390-own.md']); // SIZE de-inflated via the strict-ancestor baseRev, unchanged
    expect(r.humanBasisFiles).toEqual(['backlog/2390-own.md', 'scripts/lib/review-escalation.mjs']); // cumulative narrowed to the fork point, gate file preserved
  });

  it('#2404-review — a `git merge-base` that prints MULTIPLE lines (criss-cross-merge history, several equally-valid best common ancestors) uses only the FIRST — an embedded newline would otherwise make an invalid single-arg revision', () => {
    const { exec } = fakeExec({
      'git merge-base origin/main deadbeef': { stdout: 'forkpoint1\nforkpoint2\n' },
      'git diff --numstat forkpoint1 deadbeef': { stdout: '1\t0\tREADME.md\n' },
    });
    const r = computeNetDiffChangedFiles({ exec, rev: 'deadbeef' });
    expect(r).toEqual({ changedFiles: ['README.md'], diffLines: 1, scored: true, humanBasisFiles: ['README.md'] });
  });
});

describe('computeNetDiffText (#2450 — reviewer-facing NET diff TEXT, SAME basis as the score)', () => {
  const fakeExec = (script = {}) => {
    const calls = [];
    const exec = (cmd, args, opts) => {
      // The stub key names WHICH TREES are compared, deliberately ignoring `--end-of-options` and
      // (#2890-review-r2 finding 2b) `--no-ext-diff`. Both are argv hygiene, not intent: encoding them in every
      // fixture key means adding one guard to one more call site reds 17 unrelated tests and tempts the author
      // to drop the guard instead of the fixtures. Each has its own dedicated assertion (`guards the git-diff
      // argv…`, `computeNetDiffText passes --no-ext-diff`), which is where a regression must fail.
      const intent = args.filter((a) => a !== '--end-of-options' && a !== '--verify' && a !== '--no-ext-diff');
      calls.push({ cmd, args, opts, key: `${cmd} ${intent.join(' ')}` });
      const h = script[`${cmd} ${intent.join(' ')}`];
      if (h && h.throw) throw new Error(h.throw);
      if (h && 'stdout' in h) return h.stdout;
      if (args[0] === 'diff') throw new Error('unknown revision (unstubbed)');
      // #3343 — same faithfulness for the ancestry probe (`git log <base>..<head>`): real git exits 128 on a
      // range whose refs it cannot resolve, it does not print an empty log. Returning '' here would hand
      // `resolveNetDiffBasis` a CONFIDENT empty file set for every fixture that never stubbed the probe —
      // an under-score, the one direction the basis must never take.
      if (args[0] === 'log') throw new Error('unknown revision range (unstubbed)');
      return '';
    };
    return { exec, calls };
  };

  it('shares the #2373/#2404 base resolution: force-fetches the base with an EXPLICIT refspec, then diffs two trees (never checks out the PR branch)', () => {
    const { exec, calls } = fakeExec({
      'git diff --numstat origin/main deadbeef': { stdout: '1\t0\tREADME.md\n' }, // the shared basis probe
      'git diff origin/main deadbeef': { stdout: 'diff --git a/README.md b/README.md\n@@ text @@\n' },
    });
    const r = computeNetDiffText({ exec, rev: 'deadbeef' });
    expect(r.scored).toBe(true);
    expect(r.text).toContain('diff --git a/README.md');
    expect(r.base).toBe('origin/main');
    expect(r.rev).toBe('deadbeef');
    // exact same fetch refspec computeNetDiffChangedFiles uses — proving ONE shared basis, no drift.
    expect(calls.some((c) => c.args[0] === 'fetch' && c.args.includes('+main:refs/remotes/origin/main'))).toBe(true);
    // #2336 — no checkout/switch of the PR branch, ever.
    expect(calls.some((c) => ['checkout', 'switch'].includes(c.args[0]))).toBe(false);
  });

  it('narrows the LEFT side to the #2404 fork point (merge-base) exactly as the score does, then returns that two-tree diff text', () => {
    const { exec, calls } = fakeExec({
      'git merge-base origin/main origin/lane/x': { stdout: 'forkpoint1234\n' },
      'git diff --numstat forkpoint1234 origin/lane/x': { stdout: '2\t0\tbacklog/2450-x.md\n' },
      'git diff forkpoint1234 origin/lane/x': { stdout: 'diff --git a/backlog/2450-x.md b/backlog/2450-x.md\n' },
    });
    const r = computeNetDiffText({ exec, rev: 'lane/x', fetchExtraRefs: ['lane/x'] });
    expect(r).toMatchObject({ base: 'forkpoint1234', rev: 'origin/lane/x', scored: true });
    expect(r.text).toContain('backlog/2450-x.md');
    // the phantom sibling-lane file only in the three-dot diff is NOT swept in — the tip-basis text is never diffed.
    expect(calls.some((c) => c.key === 'git diff origin/main origin/lane/x')).toBe(false);
  });

  it('degrades to scored:false (no checkout) when neither `<remote>/<rev>` nor the bare `rev` resolves — caller falls back to `gh pr diff`', () => {
    const { exec, calls } = fakeExec({
      'git diff --numstat origin/main origin/lane/x': { throw: 'unknown revision' },
      'git diff --numstat origin/main lane/x': { throw: 'unknown revision' },
    });
    const r = computeNetDiffText({ exec, rev: 'lane/x', fetchExtraRefs: ['lane/x'] });
    expect(r).toEqual({ text: '', base: null, rev: null, scored: false, reason: 'ref-unresolved' });
    expect(calls.some((c) => ['checkout', 'switch'].includes(c.args[0]))).toBe(false);
  });

  it('degrades to scored:false when the basis resolves but the TEXT diff itself fails (safe fallback, no checkout)', () => {
    const { exec } = fakeExec({
      'git diff --numstat origin/main deadbeef': { stdout: '1\t0\tREADME.md\n' }, // basis resolves
      'git diff origin/main deadbeef': { throw: 'diff exploded' }, // but the text diff fails
    });
    const r = computeNetDiffText({ exec, rev: 'deadbeef' });
    expect(r).toEqual({ text: '', base: null, rev: null, scored: false, reason: 'diff-failed' });
  });

  it('no exec / no rev → scored:false without touching git at all', () => {
    expect(computeNetDiffText({})).toEqual({ text: '', base: null, rev: null, scored: false });
    const { exec, calls } = fakeExec();
    expect(computeNetDiffText({ exec })).toEqual({ text: '', base: null, rev: null, scored: false });
    expect(calls.length).toBe(0);
  });

  // #2952 — the `reason` classification is shared (`resolveNetDiffBasis`), so it must show up identically here,
  // not just on `computeNetDiffChangedFiles`.
  it('#2952 — exec-contract propagates through computeNetDiffText too — same wrongly-shaped exec, same reason', () => {
    const badExec = (cmd, optsShapedAsArgsArray) => {
      if (!optsShapedAsArgsArray || Array.isArray(optsShapedAsArgsArray)) {
        throw new TypeError('The "options" argument must be of type object. Received an instance of Array');
      }
      return '';
    };
    const r = computeNetDiffText({ exec: badExec, rev: 'lane/x', fetchExtraRefs: ['lane/x'] });
    expect(r).toEqual({ text: '', base: null, rev: null, scored: false, reason: 'exec-contract' });
  });
});

// #2890-review-fix finding 3 — the PR's first cut called `computeNetDiffChangedFiles` and `computeNetDiffText`
// independently for the SAME ref, which re-ran the whole of `resolveNetDiffBasis`: measured 5 → 11 git
// subprocesses and 1 → 2 network fetches per `pr-land` PR open, under a comment claiming the two read off ONE
// fetch. `resolveNetDiffBasis` is now exported and both helpers accept the resolved object, so the claim is
// true by construction.
describe('resolveNetDiffBasis shared across both helpers (#2890-review-fix finding 3 — ONE fetch, one probe)', () => {
  const fakeExec = (script = {}) => {
    const calls = [];
    const exec = (cmd, args, opts) => {
      const intent = args.filter((a) => a !== '--end-of-options' && a !== '--verify' && a !== '--no-ext-diff');
      calls.push({ cmd, args, opts, key: `${cmd} ${intent.join(' ')}` });
      const h = script[`${cmd} ${intent.join(' ')}`];
      if (h && h.throw) throw new Error(h.throw);
      if (h && 'stdout' in h) return h.stdout;
      if (args[0] === 'diff') throw new Error('unknown revision (unstubbed)');
      // #3343 — same faithfulness for the ancestry probe (`git log <base>..<head>`): real git exits 128 on a
      // range whose refs it cannot resolve, it does not print an empty log. Returning '' here would hand
      // `resolveNetDiffBasis` a CONFIDENT empty file set for every fixture that never stubbed the probe —
      // an under-score, the one direction the basis must never take.
      if (args[0] === 'log') throw new Error('unknown revision range (unstubbed)');
      return '';
    };
    return { exec, calls };
  };
  const script = {
    'git merge-base origin/main origin/lane/x': { stdout: 'forkpoint\n' },
    'git diff --numstat forkpoint origin/lane/x': { stdout: '3\t1\tREADME.md\n' },
    'git diff forkpoint origin/lane/x': { stdout: 'diff --git a/README.md b/README.md\n@@ -1 +1 @@\n-a\n+b\n' },
  };

  it('sharing the basis makes ONE fetch and ONE candidate probe total, not two of each', () => {
    const { exec, calls } = fakeExec(script);
    const basis = resolveNetDiffBasis({ exec, rev: 'lane/x', fetchExtraRefs: ['lane/x'] });
    expect(basis.ok).toBe(true);
    computeNetDiffChangedFiles({ exec, rev: 'lane/x', fetchExtraRefs: ['lane/x'], basis });
    computeNetDiffText({ exec, rev: 'lane/x', fetchExtraRefs: ['lane/x'], basis });
    expect(calls.filter((c) => c.args[0] === 'fetch').length).toBe(1);
    expect(calls.filter((c) => c.args[0] === 'merge-base').length).toBe(1);
    expect(calls.filter((c) => c.key.startsWith('git diff --numstat')).length).toBe(1);
    expect(calls.length).toBe(4); // fetch + merge-base + numstat probe + the text diff
  });

  it('the UNSHARED path costs strictly more — the measurement the review made, pinned', () => {
    const { exec, calls } = fakeExec(script);
    computeNetDiffChangedFiles({ exec, rev: 'lane/x', fetchExtraRefs: ['lane/x'] });
    computeNetDiffText({ exec, rev: 'lane/x', fetchExtraRefs: ['lane/x'] });
    expect(calls.filter((c) => c.args[0] === 'fetch').length).toBe(2);
    expect(calls.length).toBeGreaterThan(4);
  });

  it('a shared basis yields byte-identical results to resolving independently', () => {
    const a = fakeExec(script);
    const basis = resolveNetDiffBasis({ exec: a.exec, rev: 'lane/x', fetchExtraRefs: ['lane/x'] });
    const sharedFiles = computeNetDiffChangedFiles({ exec: a.exec, rev: 'lane/x', fetchExtraRefs: ['lane/x'], basis });
    const sharedText = computeNetDiffText({ exec: a.exec, rev: 'lane/x', fetchExtraRefs: ['lane/x'], basis });
    const b = fakeExec(script);
    expect(sharedFiles).toEqual(computeNetDiffChangedFiles({ exec: b.exec, rev: 'lane/x', fetchExtraRefs: ['lane/x'] }));
    expect(sharedText).toEqual(computeNetDiffText({ exec: b.exec, rev: 'lane/x', fetchExtraRefs: ['lane/x'] }));
  });

  it('an UNRESOLVED shared basis still degrades with its reason — no silent scored:true', () => {
    const { exec } = fakeExec({}); // every diff probe throws ⇒ ref-unresolved
    const basis = resolveNetDiffBasis({ exec, rev: 'lane/gone' });
    expect(basis).toMatchObject({ ok: false, reason: 'ref-unresolved' });
    expect(computeNetDiffText({ exec, rev: 'lane/gone', basis }))
      .toEqual({ text: '', base: null, rev: null, scored: false, reason: 'ref-unresolved' });
    expect(computeNetDiffChangedFiles({ exec, rev: 'lane/gone', basis }))
      .toEqual({ changedFiles: [], diffLines: 0, scored: false, humanBasisFiles: [], reason: 'ref-unresolved' });
  });
});

// #2890-review-r2 finding 1 — the `basis` option overrides `rev`, `remote` AND `base` outright, and nothing
// checked the basis was resolved for the ref being asked about. Reproduced live against real git: a basis for
// `main` handed to `computeNetDiffText({rev: <lane>})` returned `{scored:true, rev:'origin/main', text:''}`,
// which `diffHunksFrom` maps to `''` — "COMPUTED, genuinely empty", the STRONGEST clearance the #2890 contract
// can express — beside an empty file list. That is round 1's blocker reached through the door round 1's own fix
// opened. No in-repo caller does it (both go through `computeNetDiffSignals`), but `resolveNetDiffBasis` is
// exported and `basis` is a documented public option on two exported helpers.
describe('#2890-review-r2 finding 1 — a basis resolved for a DIFFERENT request is REFUSED, never answered', () => {
  const fakeExec = (script = {}) => {
    const calls = [];
    const exec = (cmd, args, opts) => {
      const intent = args.filter((a) => a !== '--end-of-options' && a !== '--verify' && a !== '--no-ext-diff');
      calls.push({ cmd, args, opts, key: `${cmd} ${intent.join(' ')}` });
      const h = script[`${cmd} ${intent.join(' ')}`];
      if (h && h.throw) throw new Error(h.throw);
      if (h && 'stdout' in h) return h.stdout;
      if (args[0] === 'diff') throw new Error('unknown revision (unstubbed)');
      // #3343 — same faithfulness for the ancestry probe (`git log <base>..<head>`): real git exits 128 on a
      // range whose refs it cannot resolve, it does not print an empty log. Returning '' here would hand
      // `resolveNetDiffBasis` a CONFIDENT empty file set for every fixture that never stubbed the probe —
      // an under-score, the one direction the basis must never take.
      if (args[0] === 'log') throw new Error('unknown revision range (unstubbed)');
      return '';
    };
    return { exec, calls };
  };
  // `main` resolves to an EMPTY self-diff (the reviewer's repro shape); the lane has a real, large diff.
  const script = {
    'git merge-base origin/main origin/main': { stdout: 'mainsha\n' },
    'git diff --numstat mainsha origin/main': { stdout: '' },
    'git diff mainsha origin/main': { stdout: '' },
    'git merge-base origin/main origin/lane/x': { stdout: 'forkpoint\n' },
    'git diff --numstat forkpoint origin/lane/x': { stdout: '90\t10\tdocs/agent/platform-decisions.md\n' },
    'git diff forkpoint origin/lane/x': { stdout: 'diff --git a/docs/agent/platform-decisions.md b/docs/agent/platform-decisions.md\n@@ -1 +1 @@\n-old ruling\n+new ruling\n' },
  };

  it('the exact repro: a main-resolved basis asked about a lane is scored:false/basis-mismatch, NOT a scored EMPTY diff', () => {
    const { exec } = fakeExec(script);
    const mainBasis = resolveNetDiffBasis({ exec, rev: 'main' });
    expect(mainBasis.ok).toBe(true);

    const text = computeNetDiffText({ exec, rev: 'lane/x', basis: mainBasis });
    expect(text.scored).toBe(false);
    expect(text.reason).toBe('basis-mismatch');
    expect(text.rev).toBeNull(); // never reports origin/main as though it were the lane

    const files = computeNetDiffChangedFiles({ exec, rev: 'lane/x', basis: mainBasis });
    expect(files.scored).toBe(false);
    expect(files.reason).toBe('basis-mismatch');
  });

  it('and so the escalation verdict says NOT COMPUTED instead of clearing the lane', () => {
    const { exec } = fakeExec(script);
    const mainBasis = resolveNetDiffBasis({ exec, rev: 'main' });
    const text = computeNetDiffText({ exec, rev: 'lane/x', basis: mainBasis });
    const files = computeNetDiffChangedFiles({ exec, rev: 'lane/x', basis: mainBasis });
    const score = scoreEscalation({
      changedFiles: files.changedFiles,
      humanBasisFiles: files.humanBasisFiles,
      diffLines: files.diffLines,
      diffHunks: diffHunksFrom(text),
    });
    // The whole point: `null` (a detector must over-fire), never `''` (a detector may clear).
    expect(score.diffHunks).toBeNull();
    expect(score.diffHunks).not.toBe('');
    expect(score.diffHunksBasisFiles).toBeNull();
  });

  it('a mismatched REMOTE or BASE is refused too — the basis overrides those as well', () => {
    const { exec } = fakeExec(script);
    const basis = resolveNetDiffBasis({ exec, rev: 'lane/x' }); // origin / main
    expect(computeNetDiffText({ exec, rev: 'lane/x', remote: 'upstream', basis }).reason).toBe('basis-mismatch');
    expect(computeNetDiffText({ exec, rev: 'lane/x', base: 'release', basis }).reason).toBe('basis-mismatch');
    expect(computeNetDiffChangedFiles({ exec, rev: 'lane/x', base: 'release', basis }).reason).toBe('basis-mismatch');
  });

  it('a hand-built basis carrying no identity is refused — a gate does not trust an unidentifiable basis', () => {
    const { exec } = fakeExec(script);
    const forged = { ok: true, baseRef: 'origin/main', diffBase: 'mainsha', candidate: 'origin/main', humanBasis: { changedFiles: [], diffLines: 0 } };
    expect(computeNetDiffText({ exec, rev: 'lane/x', basis: forged }).reason).toBe('basis-mismatch');
    expect(computeNetDiffChangedFiles({ exec, rev: 'lane/x', basis: forged }).reason).toBe('basis-mismatch');
  });

  it('an UNRESOLVED basis for the wrong ref is refused rather than reported as THIS ref being gone', () => {
    // `ref-unresolved` means "this branch does not exist" — a different fact from "you asked with the wrong
    // basis", so the identity rides the failure shape too.
    const { exec } = fakeExec({});
    const gone = resolveNetDiffBasis({ exec, rev: 'lane/gone' });
    expect(gone.ok).toBe(false);
    expect(computeNetDiffText({ exec, rev: 'lane/x', basis: gone }).reason).toBe('basis-mismatch');
  });

  it('the MATCHING basis is unaffected — same results as resolving independently', () => {
    const { exec } = fakeExec(script);
    const basis = resolveNetDiffBasis({ exec, rev: 'lane/x' });
    const shared = computeNetDiffText({ exec, rev: 'lane/x', basis });
    expect(shared.scored).toBe(true);
    expect(shared.text).toContain('+new ruling');
    const b = fakeExec(script);
    expect(shared).toEqual(computeNetDiffText({ exec: b.exec, rev: 'lane/x' }));
  });
});

// #2890-review-r2 finding 3 — both production call sites hand-assembled basis → changed files → text →
// `diffHunksFrom`, and that assembly was pinned by NOTHING: removing `basis:` from all three call sites failed
// zero of the 551 tests, and the only guard on the `diffHunks` mapping was a source-level grep for one literal
// spelling. The assembly is now ONE exported function, so these are behaviour, not spelling.
describe('computeNetDiffSignals — the ONE net-diff derivation both call sites use (#2890-review-r2 finding 3)', () => {
  const fakeExec = (script = {}) => {
    const calls = [];
    const exec = (cmd, args, opts) => {
      const intent = args.filter((a) => a !== '--end-of-options' && a !== '--verify' && a !== '--no-ext-diff');
      calls.push({ cmd, args, opts, key: `${cmd} ${intent.join(' ')}` });
      const h = script[`${cmd} ${intent.join(' ')}`];
      if (h && h.throw) throw new Error(h.throw);
      if (h && 'stdout' in h) return h.stdout;
      if (args[0] === 'diff') throw new Error('unknown revision (unstubbed)');
      // #3343 — same faithfulness for the ancestry probe (`git log <base>..<head>`): real git exits 128 on a
      // range whose refs it cannot resolve, it does not print an empty log. Returning '' here would hand
      // `resolveNetDiffBasis` a CONFIDENT empty file set for every fixture that never stubbed the probe —
      // an under-score, the one direction the basis must never take.
      if (args[0] === 'log') throw new Error('unknown revision range (unstubbed)');
      return '';
    };
    return { exec, calls };
  };
  const script = {
    'git merge-base origin/main origin/lane/x': { stdout: 'forkpoint\n' },
    'git diff --numstat forkpoint origin/lane/x': { stdout: '3\t1\tREADME.md\n' },
    'git diff forkpoint origin/lane/x': { stdout: 'diff --git a/README.md b/README.md\n@@ -1 +1 @@\n-a\n+b\n' },
  };

  it('costs ONE fetch, ONE merge-base, ONE numstat probe and ONE text diff — the shared basis, pinned by cost', () => {
    const { exec, calls } = fakeExec(script);
    const sig = computeNetDiffSignals({ exec, rev: 'lane/x', fetchExtraRefs: ['lane/x'] });
    expect(sig.scored).toBe(true);
    expect(calls.filter((c) => c.args[0] === 'fetch').length).toBe(1);
    expect(calls.filter((c) => c.args[0] === 'merge-base').length).toBe(1);
    expect(calls.filter((c) => c.key.startsWith('git diff --numstat')).length).toBe(1);
    expect(calls.length).toBe(4);
  });

  it('returns the changed-file shape, the cumulative human basis, the text object AND the mapped hunks', () => {
    const { exec } = fakeExec(script);
    const sig = computeNetDiffSignals({ exec, rev: 'lane/x', fetchExtraRefs: ['lane/x'] });
    expect(sig.changedFiles).toEqual(['README.md']);
    expect(sig.diffLines).toBe(4);
    expect(sig.humanBasisFiles).toEqual(['README.md']);
    expect(sig.netDiffText.scored).toBe(true);          // the drain reuses this object for the gaming scan
    expect(sig.diffHunks).toBe(sig.netDiffText.text);
  });

  it('THE regression, as behaviour: a FAILED text diff yields diffHunks null while changedFiles still populates', () => {
    // This is round 1's blocker in the shape it actually reaches a detector — a real file list beside a content
    // signal that must say "I could not look", not "there was nothing to see".
    const { exec } = fakeExec({ ...script, 'git diff forkpoint origin/lane/x': { throw: 'diff exploded' } });
    const sig = computeNetDiffSignals({ exec, rev: 'lane/x', fetchExtraRefs: ['lane/x'] });
    expect(sig.changedFiles).toEqual(['README.md']);
    expect(sig.scored).toBe(true);
    expect(sig.diffHunks).toBeNull();
    expect(sig.diffHunks).not.toBe('');
    expect(scoreEscalation({ ...sig }).diffHunks).toBeNull();
  });

  it('a genuinely EMPTY but computed diff still comes through as \'\' — the other half of the contract', () => {
    const { exec } = fakeExec({ ...script, 'git diff forkpoint origin/lane/x': { stdout: '' } });
    const sig = computeNetDiffSignals({ exec, rev: 'lane/x', fetchExtraRefs: ['lane/x'] });
    expect(sig.diffHunks).toBe('');
    expect(sig.diffHunks).not.toBeNull();
  });

  it('an unresolvable ref degrades everything at once — no half-populated verdict', () => {
    const { exec } = fakeExec({});
    const sig = computeNetDiffSignals({ exec, rev: 'lane/gone' });
    expect(sig).toMatchObject({ changedFiles: [], diffLines: 0, humanBasisFiles: [], scored: false, diffHunks: null });
  });

  it('#2390 de-inflation is preserved: changedFiles narrows to baseRev…head, the hunks + human basis stay CUMULATIVE', () => {
    const { exec } = fakeExec({
      ...script,
      'git merge-base --is-ancestor abc1234 origin/lane/x': { stdout: '' },
      'git rev-parse abc1234': { stdout: 'abc1234\n' },
      'git rev-parse origin/lane/x': { stdout: 'headsha\n' },
      'git diff --numstat forkpoint origin/lane/x': { stdout: '3\t1\tREADME.md\n1\t0\tdocs/agent/platform-decisions.md\n' },
      'git diff --numstat abc1234 origin/lane/x': { stdout: '3\t1\tREADME.md\n' },
    });
    const sig = computeNetDiffSignals({ exec, rev: 'lane/x', baseRev: 'abc1234', fetchExtraRefs: ['lane/x'] });
    expect(sig.changedFiles).toEqual(['README.md']);
    expect(sig.humanBasisFiles).toEqual(['README.md', 'docs/agent/platform-decisions.md']);
    // and the verdict pairs the hunks with the CUMULATIVE list, never the de-inflated one (#2890 finding 4).
    expect(scoreEscalation({ ...sig }).diffHunksBasisFiles).toEqual(['README.md', 'docs/agent/platform-decisions.md']);
  });

  it('#3317 — publishes the CUMULATIVE line count beside the cumulative file list, off the same resolved basis', () => {
    const { exec, calls } = fakeExec(script);
    const sig = computeNetDiffSignals({ exec, rev: 'lane/x', fetchExtraRefs: ['lane/x'] });
    expect(sig.cumulativeDiffLines).toBe(4);          // 3 added + 1 deleted, merge-base…head
    expect(calls.filter((c) => c.key.startsWith('git diff --numstat')).length).toBe(1); // no extra subprocess
  });
  it('#3317 — a stacked lane de-inflates diffLines but NOT cumulativeDiffLines, so scoreEscalation still sees the honest size', () => {
    const { exec } = fakeExec({
      ...script,
      'git merge-base --is-ancestor abc1234 origin/lane/x': { stdout: '' },
      'git rev-parse abc1234': { stdout: 'abc1234\n' },
      'git rev-parse origin/lane/x': { stdout: 'headsha\n' },
      // the ancestor contributed 600 lines; the child's own delta is 4
      'git diff --numstat forkpoint origin/lane/x': { stdout: '3\t1\tREADME.md\n500\t100\tdocs/big.md\n' },
      'git diff --numstat abc1234 origin/lane/x': { stdout: '3\t1\tREADME.md\n' },
    });
    const sig = computeNetDiffSignals({ exec, rev: 'lane/x', baseRev: 'abc1234', fetchExtraRefs: ['lane/x'] });
    expect(sig.diffLines).toBe(4);                    // #2390 de-inflation, preserved
    expect(sig.cumulativeDiffLines).toBe(604);        // #3317 — the merge-base measurement, un-shrinkable
    const score = scoreEscalation({ ...sig });
    expect(score.escalate).toBe(true);
    expect(score.signals.size).toBe(604);
    // and it is an escalation, never a refusal (#3320) — agent-clearable
    expect(score.humanRequired).toBe(false);
  });
  it('#3317 — an unresolvable basis degrades to 0, which leaves the declared count alone rather than zeroing it', () => {
    const { exec } = fakeExec({});
    const sig = computeNetDiffSignals({ exec, rev: 'lane/gone' });
    expect(sig.cumulativeDiffLines).toBe(0);
    expect(scoreEscalation({ diffLines: 900, cumulativeDiffLines: sig.cumulativeDiffLines }).signals.size).toBe(900);
  });
  it('the drain\'s scoring loop reads the signal off this derivation, never assembling it inline', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'merge-ai-prs.mjs'), 'utf8');
    const loop = src.slice(src.indexOf('for (const v of verdicts)'));
    expect(loop).toMatch(/computeNetDiffSignals\(/);
    expect(loop.match(/diffHunks\s*[:=][^;\n]*\.text\b/)).toBeNull();
  });
});

// #2890-review-r2 finding 2b — `computeNetDiffText` shares the `diff.external` / `GIT_EXTERNAL_DIFF` exposure
// its write-time sibling had, and its output now feeds `diffHunks`, the reviewer panel AND the anti-test-gaming
// scan — three readers that must never see a user-configurable RENDERING of the diff.
describe('computeNetDiffText passes --no-ext-diff (#2890-review-r2 finding 2b)', () => {
  it('the flag is on the argv, ahead of --end-of-options', () => {
    const calls = [];
    const exec = (cmd, args) => {
      calls.push(args);
      if (args[0] === 'diff' && args.includes('--numstat')) return '1\t0\tREADME.md\n';
      return 'diff --git a/README.md b/README.md\n';
    };
    computeNetDiffText({ exec, rev: 'deadbeef' });
    const textDiff = calls.find((a) => a[0] === 'diff' && !a.includes('--numstat'));
    expect(textDiff).toContain('--no-ext-diff');
    expect(textDiff.indexOf('--no-ext-diff')).toBeLessThan(textDiff.indexOf('--end-of-options'));
  });
  it('but NOT --text: a whole-PR diff must not force binary assets into the reviewer-facing text', () => {
    const calls = [];
    const exec = (cmd, args) => {
      calls.push(args);
      if (args[0] === 'diff' && args.includes('--numstat')) return '1\t0\tREADME.md\n';
      return 'diff\n';
    };
    computeNetDiffText({ exec, rev: 'deadbeef' });
    expect(calls.find((a) => a[0] === 'diff' && !a.includes('--numstat'))).not.toContain('--text');
  });
});

describe('computeNetDiffPaths (#2901/#1031 — NET changed-file list as plain paths, SAME basis as the score/text)', () => {
  const fakeExec = (script = {}) => {
    const calls = [];
    const exec = (cmd, args, opts) => {
      const intent = args.filter((a) => a !== '--end-of-options' && a !== '--verify' && a !== '--no-ext-diff');
      calls.push({ cmd, args, opts, key: `${cmd} ${intent.join(' ')}` });
      const h = script[`${cmd} ${intent.join(' ')}`];
      if (h && h.throw) throw new Error(h.throw);
      if (h && 'stdout' in h) return h.stdout;
      if (args[0] === 'diff') throw new Error('unknown revision (unstubbed)');
      // #3343 — same faithfulness for the ancestry probe (`git log <base>..<head>`): real git exits 128 on a
      // range whose refs it cannot resolve, it does not print an empty log. Returning '' here would hand
      // `resolveNetDiffBasis` a CONFIDENT empty file set for every fixture that never stubbed the probe —
      // an under-score, the one direction the basis must never take.
      if (args[0] === 'log') throw new Error('unknown revision range (unstubbed)');
      return '';
    };
    return { exec, calls };
  };

  it('resolves the same basis as computeNetDiffText/computeNetDiffChangedFiles and returns plain NUL-separated paths', () => {
    const { exec } = fakeExec({
      'git diff --numstat origin/main deadbeef': { stdout: '1\t0\tREADME.md\n' },
      'git diff --name-only -z origin/main..deadbeef': { stdout: 'README.md\0' },
    });
    const r = computeNetDiffPaths({ exec, rev: 'deadbeef' });
    expect(r).toEqual({ paths: ['README.md'], base: 'origin/main', rev: 'deadbeef', scored: true });
  });

  it('#2952 — degrades with reason:"ref-unresolved" when neither candidate resolves (legitimately absent — a foreign/sibling clone with no head ref)', () => {
    const { exec } = fakeExec({
      'git diff --numstat origin/main lane/x': { throw: 'unknown revision' },
      'git diff --numstat origin/main origin/lane/x': { throw: 'unknown revision' },
    });
    const r = computeNetDiffPaths({ exec, rev: 'lane/x', fetchExtraRefs: ['lane/x'] });
    expect(r).toEqual({ paths: [], base: null, rev: null, scored: false, reason: 'ref-unresolved' });
  });

  it('#2952 — degrades with reason:"diff-failed" when the basis resolves but the name-only diff itself fails', () => {
    const { exec } = fakeExec({
      'git diff --numstat origin/main deadbeef': { stdout: '1\t0\tREADME.md\n' }, // basis resolves
      'git diff --name-only -z origin/main..deadbeef': { throw: 'diff exploded' }, // but this diff fails
    });
    const r = computeNetDiffPaths({ exec, rev: 'deadbeef' });
    expect(r).toEqual({ paths: [], base: null, rev: null, scored: false, reason: 'diff-failed' });
  });

  it('#2952 — exec-contract propagates through computeNetDiffPaths too — same wrongly-shaped exec, same reason', () => {
    const badExec = (cmd, optsShapedAsArgsArray) => {
      if (!optsShapedAsArgsArray || Array.isArray(optsShapedAsArgsArray)) {
        throw new TypeError('The "options" argument must be of type object. Received an instance of Array');
      }
      return '';
    };
    const r = computeNetDiffPaths({ exec: badExec, rev: 'lane/x', fetchExtraRefs: ['lane/x'] });
    expect(r).toEqual({ paths: [], base: null, rev: null, scored: false, reason: 'exec-contract' });
  });

  it('no exec / no rev → scored:false without touching git at all', () => {
    expect(computeNetDiffPaths({})).toEqual({ paths: [], base: null, rev: null, scored: false });
    const { exec, calls } = fakeExec();
    expect(computeNetDiffPaths({ exec })).toEqual({ paths: [], base: null, rev: null, scored: false });
    expect(calls.length).toBe(0);
  });
});
