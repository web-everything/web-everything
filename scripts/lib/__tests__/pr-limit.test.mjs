/**
 * @file scripts/lib/__tests__/pr-limit.test.mjs
 * @description Unit proof of the open-PR backpressure limit's PURE core (we:xniq7xs, parent #4075): the
 *   five behaviours the operator's brief names — over-limit refuses, an infra-only changeset is exempt,
 *   global off allows, a per-branch allow-list entry allows, and under-limit allows — plus the smaller
 *   pure helpers (limit resolution, exemption matching, AI/label counting, override-state parse/expiry).
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isCardOnlyDiff } from '../../ci-card-only.mjs';
import {
  PR_LIMIT_DEFAULTS, PR_LIMIT_ENV, resolvePrLimit,
  EXEMPT_PATH_PREFIXES, isExemptPath, isExemptChangeset,
  countBackpressurePrs, decideOpenPr,
  emptyLimitState, parseLimitState, serializeLimitState, parseDurationMs,
  setGlobalOff, clearGlobalOff, allowBranch, normalizeBranchName,
  isGlobalOffNow, isBranchAllowedNow,
  fetchOpenPrs, fetchPrCommits, countOpenPrsForRepo,
  createAuthorshipCache, countOpenPrsForDispatch, DISPATCH_PR_COUNT_API_CAP, AUTHORSHIP_FAILURE_COOLDOWN_MS,
  PR_LIMIT_SCOPE_DEFAULTS, resolvePrLimitScope, readPrLimitScope, isStackedAwaitingBasePr,
  authoriseAllow, runPrLimitCli, readLimitState,
} from '../pr-limit.mjs';

describe('resolvePrLimit', () => {
  it('defaults to the operator-set per-repo caps', () => {
    expect(resolvePrLimit('we')).toBe(15);
    expect(resolvePrLimit('frontierui')).toBe(5);
    expect(resolvePrLimit('plateau-app')).toBe(5);
    expect(PR_LIMIT_DEFAULTS).toEqual({ we: 15, frontierui: 5, 'plateau-app': 5 });
  });

  it('an env override wins, per repo, independently', () => {
    expect(resolvePrLimit('we', { [PR_LIMIT_ENV.we]: '3' })).toBe(3);
    expect(resolvePrLimit('frontierui', { [PR_LIMIT_ENV.we]: '3' })).toBe(5); // unaffected by WE's override
  });

  it('ignores a non-numeric or negative override', () => {
    expect(resolvePrLimit('we', { [PR_LIMIT_ENV.we]: 'nope' })).toBe(15);
    expect(resolvePrLimit('we', { [PR_LIMIT_ENV.we]: '-1' })).toBe(15);
  });

  it('an unknown repo key has no cap (Infinity — nothing principled to enforce)', () => {
    expect(resolvePrLimit('unknown-repo', {})).toBe(Infinity);
  });
});

describe('isExemptPath / isExemptChangeset', () => {
  it('matches every listed prefix, both a bare file and a directory', () => {
    expect(isExemptPath('scripts/pr-land.mjs')).toBe(true);
    expect(isExemptPath('scripts/conveyor/tick-core.mjs')).toBe(true);
    expect(isExemptPath('skills-src/conveyor/runner.mjs')).toBe(true);
    expect(isExemptPath('scripts/lib/pr-limit.mjs')).toBe(true);
  });

  it('does not match an ordinary feature file', () => {
    expect(isExemptPath('src/components/widget.ts')).toBe(false);
    expect(isExemptPath('scripts/lib/some-unrelated-lib.mjs')).toBe(false);
  });

  it('a changeset entirely within exempt paths is exempt', () => {
    expect(isExemptChangeset(['scripts/conveyor/tick-core.mjs', 'scripts/pr-land.mjs'])).toBe(true);
  });

  it('one non-exempt file in the mix disqualifies the whole changeset', () => {
    expect(isExemptChangeset(['scripts/conveyor/tick-core.mjs', 'src/components/widget.ts'])).toBe(false);
  });

  it('an empty changeset is never exempt', () => {
    expect(isExemptChangeset([])).toBe(false);
    expect(isExemptChangeset(undefined)).toBe(false);
  });
});

describe('countBackpressurePrs', () => {
  const aiCommit = { authors: [{ name: 'Claude', email: 'noreply@anthropic.com' }], messageBody: '' };
  const humanCommit = { authors: [{ name: 'A Human', email: 'human@example.com' }], messageBody: '' };
  const commitsPage = (c) => JSON.stringify([{ data: { repository: { pullRequest: { commits: { nodes: c.map((commit) => ({ commit: { ...commit, authors: { nodes: commit.authors } } })) } } } } }]);

  it('counts an AI-generated, not-yet-accepted PR', () => {
    const prs = [{ number: 1, commits: [aiCommit], labels: [] }];
    expect(countBackpressurePrs(prs).map((p) => p.number)).toEqual([1]);
  });

  it('excludes a PR already labelled review:accepted', () => {
    const prs = [{ number: 1, commits: [aiCommit], labels: [{ name: 'review:accepted' }] }];
    expect(countBackpressurePrs(prs)).toEqual([]);
  });

  it('excludes a human-authored PR', () => {
    const prs = [{ number: 1, commits: [humanCommit], labels: [] }];
    expect(countBackpressurePrs(prs)).toEqual([]);
  });
});

describe('decideOpenPr — the five required behaviours', () => {
  const base = { repoKey: 'plateau-app', limit: 5 };

  it('OVER THE LIMIT refuses', () => {
    const d = decideOpenPr({ ...base, openCount: 5 });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/backpressure limit reached for plateau-app: 5\/5/);
  });

  it('an EXEMPT (infra-only) changeset is allowed even over the limit', () => {
    const d = decideOpenPr({ ...base, openCount: 9, changedFiles: ['scripts/conveyor/tick-core.mjs'] });
    expect(d.allowed).toBe(true);
    expect(d.exempt).toBe(true);
  });

  it('a CARD-ONLY changeset may OPEN even over the limit — it is not counted, so it cannot raise the count (xbxahvf)', () => {
    const d = decideOpenPr({ ...base, openCount: 17, changedFiles: ['backlog/xfyhz2z-a.md', 'backlog/x9dscc7-b.md'] });
    expect(d.allowed).toBe(true);
    expect(d.exempt).toBe(true);
    expect(d.reason).toMatch(/card-only/);
  });

  it('a card-only changeset still meets the limit when excludeCardOnly is OFF (the toggle gates the open exemption too)', () => {
    const d = decideOpenPr({ ...base, openCount: 17, changedFiles: ['backlog/xfyhz2z-a.md'], excludeCardOnly: false });
    expect(d.allowed).toBe(false);
    expect(d.exempt).toBe(false);
    expect(decideOpenPr({ ...base, openCount: 17, changedFiles: ['backlog/xfyhz2z-a.md'], excludeCardOnly: true }).allowed).toBe(true);
    // omitted → the built-in default (exclude)
    expect(decideOpenPr({ ...base, openCount: 17, changedFiles: ['backlog/xfyhz2z-a.md'] }).allowed).toBe(true);
  });

  it('a card plus any non-card file, or an unreadable (empty) changeset, still meets the limit', () => {
    expect(decideOpenPr({ ...base, openCount: 17, changedFiles: ['backlog/xfyhz2z-a.md', 'docs/x.md'] }).allowed).toBe(false);
    expect(decideOpenPr({ ...base, openCount: 17, changedFiles: [] }).allowed).toBe(false);
  });

  it('GLOBAL OFF allows even over the limit', () => {
    const d = decideOpenPr({ ...base, openCount: 9, globalOff: true });
    expect(d.allowed).toBe(true);
    expect(d.overridden).toBe(true);
  });

  it('a PER-BRANCH allow-list entry allows even over the limit', () => {
    const d = decideOpenPr({ ...base, openCount: 9, branch: 'lane/4080-x', branchAllowed: true });
    expect(d.allowed).toBe(true);
    expect(d.overridden).toBe(true);
  });

  it('UNDER THE LIMIT allows', () => {
    const d = decideOpenPr({ ...base, openCount: 4 });
    expect(d.allowed).toBe(true);
    expect(d.reason).toMatch(/under limit \(4\/5\)/);
  });

  it('--force-open with a reason allows even over the limit', () => {
    const d = decideOpenPr({ ...base, openCount: 9, forceOpen: true, forceReason: 'operator asked in chat' });
    expect(d.allowed).toBe(true);
    expect(d.overridden).toBe(true);
    expect(d.reason).toContain('operator asked in chat');
  });

  it('an unavailable live count (gh read failed) fails OPEN, never blocks', () => {
    const d = decideOpenPr({ ...base, openCount: null });
    expect(d.allowed).toBe(true);
  });

  it('exemption is checked before overrides and before the limit', () => {
    const d = decideOpenPr({ ...base, openCount: 5, changedFiles: ['scripts/pr-land.mjs'], globalOff: false });
    expect(d.exempt).toBe(true);
    expect(d.allowed).toBe(true);
  });
});

describe('fetchOpenPrs / fetchPrCommits / countOpenPrsForRepo — the IO shell', () => {
  const aiCommit = { authors: [{ name: 'Claude', email: 'noreply@anthropic.com' }], messageBody: '' };
  const humanCommit = { authors: [{ name: 'A Human', email: 'human@example.com' }], messageBody: '' };
  const commitsPage = (c) => JSON.stringify([{ data: { repository: { pullRequest: { commits: { nodes: c.map((commit) => ({ commit: { ...commit, authors: { nodes: commit.authors } } })) } } } } }]);

  it('fetchOpenPrs asks for number,labels,headRefName,headRefOid,files — deliberately NOT commits (the GraphQL node-limit footgun)', () => {
    const exec = (args) => { expect(args).toEqual(expect.arrayContaining(['--json', 'number,labels,headRefName,headRefOid,baseRefName,files'])); expect(args).not.toContain('commits'); return '[]'; };
    expect(fetchOpenPrs('o/n', { exec })).toEqual([]);
  });

  it('fetchOpenPrs degrades to null (never throws) on a gh failure or unparsable output', () => {
    expect(fetchOpenPrs('o/n', { exec: () => { throw new Error('gh: not found'); } })).toBeNull();
    expect(fetchOpenPrs('o/n', { exec: () => 'not json' })).toBeNull();
  });

  it('fetchPrCommits fetches ONE PR at a time via the metered GraphQL read', () => {
    const exec = (args) => { expect(args.slice(0, 2)).toEqual(['api', 'graphql']); expect(args).toContain('number=42'); return commitsPage([aiCommit]); };
    expect(fetchPrCommits('o/n', 42, { exec })).toEqual([aiCommit]);
  });

  it('fetchPrCommits degrades to null (never []) on failure — unknown authorship is never assumed empty', () => {
    expect(fetchPrCommits('o/n', 42, { exec: () => { throw new Error('boom'); } })).toBeNull();
    expect(fetchPrCommits('o/n', 42, { exec: () => '{}' })).toBeNull();
  });

  it('countOpenPrsForRepo: one list call + one commits call per not-yet-accepted PR, then applies the AI/label rubric', () => {
    const calls = [];
    const exec = (args) => {
      calls.push(args);
      if (args[1] === 'list') return JSON.stringify([{ number: 1, labels: [] }, { number: 2, labels: [{ name: 'review:accepted' }] }, { number: 3, labels: [] }]);
      if (args[0] === 'api' && args[1] === 'graphql') {
        const num = args.find((a) => a.startsWith('number='));
        if (num === 'number=1') return commitsPage([aiCommit]);
        if (num === 'number=3') return commitsPage([humanCommit]);
      }
      throw new Error(`unexpected call: ${JSON.stringify(args)}`);
    };
    const result = countOpenPrsForRepo('we', { exec, env: {} });
    expect(result).toEqual({ repoKey: 'we', slug: 'web-everything/web-everything', count: 1, prNumbers: [1], limit: 15, unavailable: false, unresolved: 0, apiFetches: 2, excludeCardOnly: true, cardOnly: 0, cardOnlyPrNumbers: [], stacked: 0, stackedPrNumbers: [], accepted: 1, acceptedPrNumbers: [2] });
    // Exactly one list call + one commits call per NOT-accepted PR (#2 is skipped — already accepted).
    expect(calls.filter((a) => a[1] === 'list')).toHaveLength(1);
    expect(calls.filter((a) => a[0] === 'api' && a[1] === 'graphql')).toHaveLength(2);
  });

  it('countOpenPrsForRepo reports PRs whose commits could not be read as unresolved — an undercount is never silent', () => {
    const exec = (args) => {
      if (args[1] === 'list') return JSON.stringify([{ number: 1, labels: [] }, { number: 3, labels: [] }]);
      if (args[0] === 'api' && args[1] === 'graphql' && args.includes('number=1')) return commitsPage([aiCommit]);
      throw new Error('commits unreadable');
    };
    expect(countOpenPrsForRepo('we', { exec, env: {} })).toMatchObject({ count: 1, prNumbers: [1], unavailable: false, unresolved: 1 });
  });

  it('countOpenPrsForRepo is unavailable when the list call fails, and unknown for an unrecognized repo key', () => {
    expect(countOpenPrsForRepo('we', { exec: () => { throw new Error('boom'); }, env: {} }).unavailable).toBe(true);
    expect(countOpenPrsForRepo('not-a-repo', { env: {} })).toEqual({ repoKey: 'not-a-repo', slug: null, count: null, prNumbers: [], limit: Infinity, unavailable: true, unresolved: 0 });
  });
});

describe('card-only exclusion (operator ruling 2026-10-09 ~17:05 ET)', () => {
  const aiCommit = { authors: [{ name: 'Claude', email: 'noreply@anthropic.com' }], messageBody: '' };
  const commitsPage = (c) => JSON.stringify([{ data: { repository: { pullRequest: { commits: { nodes: c.map((commit) => ({ commit: { ...commit, authors: { nodes: commit.authors } } })) } } } } }]);
  const card = (n) => ({ number: n, labels: [], files: [{ path: `backlog/${n}-card.md` }] });
  const code = (n) => ({ number: n, labels: [], files: [{ path: 'scripts/x.mjs' }, { path: 'backlog/x.md' }] });
  const execFor = (rows, calls = []) => (args) => {
    calls.push(args);
    if (args[1] === 'list') return JSON.stringify(rows);
    if (args[0] === 'api' && args[1] === 'graphql') return commitsPage([aiCommit]);
    throw new Error(`unexpected call: ${JSON.stringify(args)}`);
  };

  it('defaults to excluding card-only PRs; the tool layer and env override it, in that order', () => {
    expect(PR_LIMIT_SCOPE_DEFAULTS).toEqual({ excludeCardOnly: true, excludeStackedAwaitingBase: true });
    expect(resolvePrLimitScope({})).toMatchObject({ excludeCardOnly: true, source: { excludeCardOnly: 'default' } });
    expect(resolvePrLimitScope({ tool: { excludeCardOnly: false } })).toMatchObject({ excludeCardOnly: false, source: { excludeCardOnly: 'tool' } });
    expect(resolvePrLimitScope({ tool: { excludeCardOnly: 'no' } }).excludeCardOnly).toBe(true);
    expect(resolvePrLimitScope({ tool: { excludeCardOnly: false }, env: { WE_PR_LIMIT_EXCLUDE_CARD_ONLY: 'true' } })).toMatchObject({ excludeCardOnly: true, source: { excludeCardOnly: 'env' } });
  });

  it('the shipped settings file states the ruling (excludeCardOnly: true)', () => {
    expect(readPrLimitScope({ env: {} })).toMatchObject({ excludeCardOnly: true, source: { excludeCardOnly: 'tool' } });
  });

  it('excludeStackedAwaitingBase resolves through the same cascade, and the shipped file sets it (operator ruling option c)', () => {
    expect(resolvePrLimitScope({ platform: { excludeStackedAwaitingBase: false } })).toMatchObject({
      excludeStackedAwaitingBase: false, source: { excludeStackedAwaitingBase: 'platform' } });
    expect(resolvePrLimitScope({ platform: { excludeStackedAwaitingBase: false }, env: { WE_PR_LIMIT_EXCLUDE_STACKED_AWAITING_BASE: '1' } }))
      .toMatchObject({ excludeStackedAwaitingBase: true, source: { excludeStackedAwaitingBase: 'env' } });
    expect(readPrLimitScope({ env: {} })).toMatchObject({ excludeStackedAwaitingBase: true, source: { excludeStackedAwaitingBase: 'tool' } });
  });

  it('a stacked draft awaiting its base PR is not counted; a stacked PR without the label, or on main, still is', () => {
    const awaiting = (n, base) => ({ ...code(n), baseRefName: base, labels: [{ name: 'review-status:awaiting-base' }] });
    const baseRow = { ...code(9), headRefName: 'lane/settings-cascade-audit' };
    const rows = [awaiting(6, 'lane/settings-cascade-audit'), { ...code(7), baseRefName: 'lane/x' }, awaiting(8, 'main'), code(3), baseRow];
    const r = countOpenPrsForRepo('we', { exec: execFor(rows), env: {}, scope: { excludeCardOnly: true, excludeStackedAwaitingBase: true } });
    expect(r).toMatchObject({ count: 4, stacked: 1, stackedPrNumbers: [6] });
    const off = countOpenPrsForRepo('we', { exec: execFor(rows), env: {}, scope: { excludeCardOnly: true, excludeStackedAwaitingBase: false } });
    expect(off).toMatchObject({ count: 5, stacked: 0 });
  });

  it('a labelled draft whose base is NOT the head of another open PR still counts (the label and a scratch base are not enough)', () => {
    const awaiting = (n, base) => ({ ...code(n), baseRefName: base, labels: [{ name: 'review-status:awaiting-base' }] });
    const rows = [awaiting(6, 'scratch/not-a-pr'), awaiting(7, 'lane/real-base'), { ...code(9), headRefName: 'lane/real-base' }];
    const r = countOpenPrsForRepo('we', { exec: execFor(rows), env: {}, scope: { excludeCardOnly: true, excludeStackedAwaitingBase: true } });
    expect(r).toMatchObject({ count: 2, stacked: 1, stackedPrNumbers: [7] });
    expect(isStackedAwaitingBasePr(awaiting(6, 'scratch/not-a-pr'), new Set(['lane/real-base']))).toBe(false);
    expect(isStackedAwaitingBasePr(awaiting(7, 'lane/real-base'), new Set(['lane/real-base']))).toBe(true);
    // fail-closed: no open-heads set → not stacked
    expect(isStackedAwaitingBasePr(awaiting(7, 'lane/real-base'))).toBe(false);
  });

  it('a labelled draft whose base PR is itself excluded (card-only / accepted) or part of a cycle still counts; a chain that ends at a counted PR does not', () => {
    const awaiting = (n, base, head) => ({ ...code(n), headRefName: head ?? `lane/d${n}`, baseRefName: base, labels: [{ name: 'review-status:awaiting-base' }] });
    const scope = { excludeCardOnly: true, excludeStackedAwaitingBase: true };
    const count = (rows) => countOpenPrsForRepo('we', { exec: execFor(rows), env: {}, scope });
    const cardBase = { number: 50, labels: [], headRefName: 'lane/card-base', headRefOid: 'o50', baseRefName: 'main', files: [{ path: 'backlog/x.md' }] };
    // a card-only base shields nobody: both drafts hang off an uncounted PR and are counted
    expect(count([cardBase, awaiting(6, 'lane/card-base'), awaiting(7, 'lane/card-base')])).toMatchObject({ count: 2, stacked: 0, cardOnly: 1 });
    // an accepted base likewise
    const acceptedBase = { ...code(51), headRefName: 'lane/acc-base', labels: [{ name: 'review:accepted' }] };
    expect(count([acceptedBase, awaiting(6, 'lane/acc-base')])).toMatchObject({ count: 1, stacked: 0, accepted: 1 });
    // a two-PR cycle (each the other's base) shields neither
    expect(count([awaiting(6, 'lane/d7'), awaiting(7, 'lane/d6')])).toMatchObject({ count: 2, stacked: 0 });
    // a chain d8 → d7 → real counted base: both drafts are excluded
    const real = { ...code(9), headRefName: 'lane/real' };
    expect(count([real, awaiting(7, 'lane/real'), awaiting(8, 'lane/d7')])).toMatchObject({ count: 1, stacked: 2, stackedPrNumbers: [7, 8] });
    // the same chain over a card-only root counts both
    expect(count([cardBase, awaiting(7, 'lane/card-base'), awaiting(8, 'lane/d7')])).toMatchObject({ count: 2, stacked: 0 });
  });

  it('an unavailable count still reports the resolved excludeCardOnly (so pr-land does not fall back to the default)', () => {
    const r = countOpenPrsForRepo('we', { exec: () => { throw new Error('boom'); }, env: {}, scope: { excludeCardOnly: false, excludeStackedAwaitingBase: true } });
    expect(r).toMatchObject({ unavailable: true, excludeCardOnly: false });
  });

  it('fetchOpenPrs requests baseRefName on both the direct and the shared-snapshot read (the stacked test needs it)', () => {
    const exec = (args) => { expect(args[args.indexOf('--json') + 1].split(',')).toContain('baseRefName'); return '[]'; };
    expect(fetchOpenPrs('o/n', { exec })).toEqual([]);
    let fields = null;
    fetchOpenPrs('o/n', { exec: () => '[]', readShared: (o) => { fields = o.fields; return []; } });
    expect(fields.split(',')).toContain('baseRefName');
  });

  it('fetchOpenPrs asks for files (the card-only test needs them)', () => {
    const exec = (args) => { expect(args[args.indexOf('--json') + 1].split(',')).toContain('files'); return '[]'; };
    expect(fetchOpenPrs('o/n', { exec })).toEqual([]);
  });

  it('countOpenPrsForRepo excludes card-only PRs, never spends a commits read on them, and reports the split', () => {
    const calls = [];
    const rows = [card(1), card(2), code(3), { ...code(4), labels: [{ name: 'review:accepted' }] }];
    const r = countOpenPrsForRepo('we', { exec: execFor(rows, calls), env: {} });
    expect(r).toMatchObject({ count: 1, prNumbers: [3], cardOnly: 2, cardOnlyPrNumbers: [1, 2], accepted: 1, acceptedPrNumbers: [4] });
    expect(calls.filter((a) => a[0] === 'api')).toHaveLength(1);
  });

  it('a PR with no file list is never card-only (fail-closed: it counts)', () => {
    const r = countOpenPrsForRepo('we', { exec: execFor([{ number: 5, labels: [] }]), env: {} });
    expect(r).toMatchObject({ count: 1, cardOnly: 0 });
  });

  it('the setting OFF counts card-only PRs again', () => {
    const r = countOpenPrsForRepo('we', { exec: execFor([card(1), code(3)]), env: {}, scope: { excludeCardOnly: false } });
    expect(r).toMatchObject({ count: 2, cardOnly: 0, excludeCardOnly: false });
    // wiring: pr-land feeds this resolved value into decideOpenPr, so the open exemption follows the same toggle
    expect(decideOpenPr({ repoKey: 'we', limit: 2, openCount: r.count, excludeCardOnly: r.excludeCardOnly, changedFiles: ['backlog/x.md'] }).allowed).toBe(false);
  });

  it('the refusal reports "N counted (M card-only excluded, K accepted excluded)"', () => {
    const d = decideOpenPr({ repoKey: 'we', limit: 15, openCount: 15, cardOnlyExcluded: 6, acceptedExcluded: 2, stackedExcluded: 3 });
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('15 counted (6 card-only excluded, 3 stacked awaiting-base excluded, 2 accepted excluded)');
    const ok = decideOpenPr({ repoKey: 'we', limit: 15, openCount: 9, cardOnlyExcluded: 6, acceptedExcluded: 0 });
    expect(ok.allowed).toBe(true);
    expect(ok.reason).toContain('9 counted (6 card-only excluded, 0 stacked awaiting-base excluded, 0 accepted excluded)');
  });
});

describe('override-state parse/serialize', () => {
  it('parses a corrupt/empty store as the empty (enforced) state — fails OPEN to enforcement', () => {
    expect(parseLimitState('')).toEqual(emptyLimitState());
    expect(parseLimitState('not json')).toEqual(emptyLimitState());
    expect(parseLimitState('[1,2,3]')).toEqual(emptyLimitState());
  });

  it('round-trips through serialize/parse', () => {
    const s = setGlobalOff(emptyLimitState(), { reason: 'review system down', by: 'nic' }, 0);
    const round = parseLimitState(serializeLimitState(s));
    expect(round.global.off).toBe(true);
    expect(round.global.reason).toBe('review system down');
    expect(round.global.by).toBe('nic');
  });

  it('every override is logged with actor + reason in history', () => {
    let s = emptyLimitState();
    s = setGlobalOff(s, { reason: 'r1', by: 'nic' }, 0);
    s = allowBranch(s, 'lane/4080-x', { reason: 'r2', by: 'nic' }, 0);
    expect(s.history).toHaveLength(2);
    expect(s.history[0]).toMatchObject({ action: 'off', actor: 'nic', reason: 'r1' });
    expect(s.history[1]).toMatchObject({ action: 'allow-branch', actor: 'nic', reason: 'r2', target: 'lane/4080-x' });
  });
});

describe('parseDurationMs', () => {
  it('parses minutes/hours/days', () => {
    expect(parseDurationMs('30m')).toBe(30 * 60_000);
    expect(parseDurationMs('2h')).toBe(2 * 3_600_000);
    expect(parseDurationMs('1d')).toBe(86_400_000);
  });
  it('returns null for garbage / absent input', () => {
    expect(parseDurationMs('nope')).toBeNull();
    expect(parseDurationMs(undefined)).toBeNull();
  });
});

describe('global off expiry (--for=<duration>)', () => {
  it('is in effect before expiry and auto-clears after', () => {
    const untilMs = parseDurationMs('2h');
    const s = setGlobalOff(emptyLimitState(), { reason: 'x', untilMs }, 1_000_000);
    expect(isGlobalOffNow(s, 1_000_000 + 60_000)).toBe(true); // 1 min later — still off
    expect(isGlobalOffNow(s, 1_000_000 + untilMs + 1)).toBe(false); // past expiry — auto re-armed
  });

  it('with no --for, stays off until explicitly cleared', () => {
    const s = setGlobalOff(emptyLimitState(), { reason: 'x' }, 0);
    expect(isGlobalOffNow(s, Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(isGlobalOffNow(clearGlobalOff(s))).toBe(false);
  });
});

describe('branch allow-list matching', () => {
  it('matches with or without the lane/ prefix', () => {
    const s = allowBranch(emptyLimitState(), '4080-foo', { reason: 'x' }, 0);
    expect(isBranchAllowedNow(s, '4080-foo')).toBe(true);
    expect(isBranchAllowedNow(s, 'lane/4080-foo')).toBe(true);
    expect(isBranchAllowedNow(s, 'lane/9999-bar')).toBe(false);
  });

  it('normalizeBranchName strips a leading lane/', () => {
    expect(normalizeBranchName('lane/123-x')).toBe('123-x');
    expect(normalizeBranchName('123-x')).toBe('123-x');
  });

  it('an expired per-branch allow no longer applies', () => {
    const s = allowBranch(emptyLimitState(), '4080-foo', { reason: 'x', untilMs: 1000 }, 0);
    expect(isBranchAllowedNow(s, '4080-foo', 500)).toBe(true);
    expect(isBranchAllowedNow(s, '4080-foo', 1001)).toBe(false);
  });
});

describe('bounded networked count (dispatch round) — the GitHub-call budget the fallback may spend', () => {
  const aiCommit = { authors: [{ name: 'Claude', email: 'noreply@anthropic.com' }], messageBody: '' };
  const commitsPage = (c) => JSON.stringify([{ data: { repository: { pullRequest: { commits: { nodes: c.map((commit) => ({ commit: { ...commit, authors: { nodes: commit.authors } } })) } } } } }]);
  // Stacked PRs (base is not `main`) are never resolvable from local git, so each needs a GraphQL read the first time.
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ number: i + 1, labels: [], headRefName: `lane/p${i + 1}`, headRefOid: `oid${i + 1}`, baseRefName: 'lane/base' }));
  const harness = (open, failing = new Set()) => {
    const calls = [];
    const exec = (args) => {
      calls.push(args);
      if (args[1] === 'list') return JSON.stringify(open);
      if (args[0] === 'api' && args[1] === 'graphql') {
        const number = Number(args.find((a) => a.startsWith('number=')).slice(7));
        if (failing.has(number)) throw new Error('commits unreadable');
        return commitsPage([aiCommit]);
      }
      throw new Error(`unexpected call: ${JSON.stringify(args)}`);
    };
    // The host-shared snapshot: warm (served from cache, no gh) vs cold (null → localOnly reports unavailable).
    let warm = true;
    const readShared = ({ cacheOnly }) => (warm || !cacheOnly ? open : null);
    return { calls, exec, readShared, setWarm: (v) => { warm = v; }, graphql: () => calls.filter((a) => a[0] === 'api').length, lists: () => calls.filter((a) => a[1] === 'list').length };
  };
  const tmpCache = () => createAuthorshipCache({ path: join(mkdtempSync(join(tmpdir(), 'pr-authorship-')), 'cache.json') });

  it('countOpenPrsForDispatch: persistently failing leading PRs do not starve trailing PRs', () => {
    const h = harness(rows(7), new Set([1, 2, 3]));
    const path = join(mkdtempSync(join(tmpdir(), 'pr-authorship-')), 'cache.json');
    const now = 1_000_000;
    const spent = [];
    for (let round = 0; round < 4; round++) {
      const before = h.graphql();
      // Reload each round: failure markers must survive separate dispatcher processes.
      const r = countOpenPrsForDispatch('we', { ...h, authorshipCache: createAuthorshipCache({ path }), now });
      spent.push(h.graphql() - before);
      expect(spent.at(-1)).toBeLessThanOrEqual(DISPATCH_PR_COUNT_API_CAP);
      if (round >= 2) expect(r).toMatchObject({ count: 4, unresolved: 3 });
    }
    expect(spent).toEqual([3, 3, 1, 0]);
    for (const number of [1, 2, 3]) {
      expect(h.calls.filter((args) => args.includes(`number=${number}`))).toHaveLength(1);
      expect(createAuthorshipCache({ path }).get(`web-everything/web-everything#${number}@oid${number}`)).toEqual({ failedAt: now });
    }
  });

  it('a failed read is retried after the cooldown expires', () => {
    const h = harness(rows(1), new Set([1]));
    const authorshipCache = tmpCache();
    const now = 1_000_000;
    expect(AUTHORSHIP_FAILURE_COOLDOWN_MS).toBe(15 * 60 * 1000);
    for (const [offset, expected] of [[0, 1], [1000, 0], [AUTHORSHIP_FAILURE_COOLDOWN_MS, 1]]) {
      h.calls.length = 0;
      const r = countOpenPrsForDispatch('we', { ...h, authorshipCache, now: now + offset });
      expect(h.graphql()).toBe(expected);
      expect(r).toMatchObject({ count: 0, unresolved: 1, apiFetches: expected });
      expect(authorshipCache.get('web-everything/web-everything#1@oid1')).toEqual({ failedAt: now + (expected ? offset : 0) });
    }
  });

  it('a PR left unresolved by the spent budget is not negative-cached', () => {
    const h = harness(rows(6));
    const authorshipCache = tmpCache();
    const o = { ...h, authorshipCache, now: 1_000_000 };
    expect(countOpenPrsForRepo('we', { ...o, maxApiFetches: 2 })).toMatchObject({ count: 2, unresolved: 4 });
    for (const number of [3, 4, 5, 6]) expect(authorshipCache.get(`web-everything/web-everything#${number}@oid${number}`)).toBeUndefined();
    h.calls.length = 0;
    expect(countOpenPrsForRepo('we', { ...o, maxApiFetches: Infinity })).toMatchObject({ count: 6, unresolved: 0 });
    expect(h.graphql()).toBe(4);
  });

  it('a new head oid clears a failure marker', () => {
    const open = rows(1);
    const h = harness(open, new Set([1]));
    const authorshipCache = tmpCache();
    countOpenPrsForDispatch('we', { ...h, authorshipCache, now: 1_000_000 });
    open[0].headRefOid = 'moved';
    h.calls.length = 0;
    countOpenPrsForDispatch('we', { ...h, authorshipCache, now: 1_001_000 });
    expect(h.graphql()).toBe(1);
    expect(authorshipCache.get('web-everything/web-everything#1@oid1')).toBeUndefined();
    expect(authorshipCache.get('web-everything/web-everything#1@moved')).toEqual({ failedAt: 1_001_000 });
  });

  it('local git can resolve a PR during its failure cooldown', () => {
    const open = rows(1);
    const h = harness(open, new Set([1]));
    const authorshipCache = tmpCache();
    countOpenPrsForDispatch('we', { ...h, authorshipCache, now: 1_000_000 });
    open[0].baseRefName = 'main';
    h.calls.length = 0;
    const git = (_command, args) => {
      if (args[0] === 'remote') return 'https://github.com/web-everything/web-everything.git';
      if (args[0] === 'check-ref-format') return '';
      if (args[0] === 'rev-parse') return args[1] === '--is-shallow-repository' ? 'false' : 'oid1';
      if (args[0] === 'log') return ['oid1', 'Claude', 'noreply@anthropic.com', 'Implement feature', '', ''].join('\0');
      throw new Error(`unexpected git call: ${args}`);
    };
    expect(countOpenPrsForDispatch('we', { ...h, git, authorshipCache, now: 1_001_000 })).toMatchObject({ count: 1, unresolved: 0, apiFetches: 0, fallback: false });
    expect(h.graphql()).toBe(0);
    expect(authorshipCache.get('web-everything/web-everything#1@oid1')).toBe(true);
  });

  it('local-only unresolved PRs are not negative-cached', () => {
    const h = harness(rows(1));
    const authorshipCache = tmpCache();
    expect(countOpenPrsForRepo('we', { ...h, authorshipCache, localOnly: true, now: 1_000_000 })).toMatchObject({ unresolved: 1, apiFetches: 0 });
    expect(authorshipCache.get('web-everything/web-everything#1@oid1')).toBeUndefined();
    expect(h.graphql()).toBe(0);
    expect(countOpenPrsForRepo('we', { ...h, authorshipCache, now: 1_001_000 })).toMatchObject({ count: 1, unresolved: 0, apiFetches: 1 });
  });

  it('maxApiFetches caps the per-PR GraphQL reads and reports the rest as unresolved', () => {
    const h = harness(rows(6));
    const r = countOpenPrsForRepo('we', { exec: h.exec, readShared: h.readShared, env: {}, maxApiFetches: 2 });
    expect(h.graphql()).toBe(2);
    expect(r).toMatchObject({ count: 2, unresolved: 4, apiFetches: 2 });
  });

  it('an authorship verdict is cached per (PR, head oid): the next read spends nothing, even local-only', () => {
    const h = harness(rows(3));
    const cache = tmpCache();
    countOpenPrsForRepo('we', { exec: h.exec, readShared: h.readShared, env: {}, authorshipCache: cache });
    expect(h.graphql()).toBe(3);
    h.calls.length = 0;
    const again = countOpenPrsForRepo('we', { exec: h.exec, readShared: h.readShared, env: {}, authorshipCache: cache, localOnly: true });
    expect(h.calls).toEqual([]);
    expect(again).toMatchObject({ count: 3, unresolved: 0 });
  });

  it('a new head oid invalidates the cached verdict (authorship is re-read for the new commits)', () => {
    const open = rows(1);
    const h = harness(open);
    const cache = tmpCache();
    countOpenPrsForRepo('we', { exec: h.exec, readShared: h.readShared, env: {}, authorshipCache: cache });
    open[0] = { ...open[0], headRefOid: 'moved' };
    h.calls.length = 0;
    countOpenPrsForRepo('we', { exec: h.exec, readShared: h.readShared, env: {}, authorshipCache: cache });
    expect(h.graphql()).toBe(1);
  });

  it('the authorship cache file survives a reload and is pruned to the live open PRs', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'pr-authorship-')), 'cache.json');
    const first = createAuthorshipCache({ path });
    first.set('o/n#1@a', true); first.set('o/n#2@b', false);
    first.flush(new Set(['o/n#1@a', 'o/n#2@b']));
    const reread = createAuthorshipCache({ path });
    expect(reread.get('o/n#1@a')).toBe(true);
    expect(reread.get('o/n#2@b')).toBe(false);
    reread.flush(new Set(['o/n#1@a']));
    expect(createAuthorshipCache({ path }).get('o/n#2@b')).toBeUndefined();
  });

  it('an unreadable or corrupt cache file degrades to a miss, never a throw', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-authorship-'));
    const path = join(dir, 'cache.json');
    writeFileSync(path, '{not json');
    const cache = createAuthorshipCache({ path });
    expect(cache.get('o/n#1@a')).toBeUndefined();
    cache.set('o/n#1@a', true);
    expect(() => cache.flush(new Set(['o/n#1@a']))).not.toThrow();
  });

  it('countOpenPrsForDispatch: warm snapshot + warm cache stays entirely local (zero gh calls)', () => {
    const h = harness(rows(DISPATCH_PR_COUNT_API_CAP));
    const cache = tmpCache();
    countOpenPrsForDispatch('we', { exec: h.exec, readShared: h.readShared, env: {}, authorshipCache: cache }); // cold cache → bounded fallback
    h.calls.length = 0;
    const r = countOpenPrsForDispatch('we', { exec: h.exec, readShared: h.readShared, env: {}, authorshipCache: cache });
    expect(h.calls).toEqual([]);
    expect(r).toMatchObject({ fallback: false, count: DISPATCH_PR_COUNT_API_CAP, unresolved: 0 });
  });

  it('countOpenPrsForDispatch: the fallback spends at most DISPATCH_PR_COUNT_API_CAP GraphQL reads per round, and converges across rounds', () => {
    const n = DISPATCH_PR_COUNT_API_CAP * 2 + 1;
    const h = harness(rows(n));
    const cache = tmpCache();
    const spent = [];
    for (let round = 0; round < 4; round++) {
      h.calls.length = 0;
      countOpenPrsForDispatch('we', { exec: h.exec, readShared: h.readShared, env: {}, authorshipCache: cache });
      spent.push(h.graphql());
    }
    expect(Math.max(...spent)).toBeLessThanOrEqual(DISPATCH_PR_COUNT_API_CAP);
    expect(spent).toEqual([DISPATCH_PR_COUNT_API_CAP, DISPATCH_PR_COUNT_API_CAP, 1, 0]);
  });

  it('countOpenPrsForDispatch: a cold snapshot costs one list call (not one per PR) when every verdict is already cached', () => {
    const h = harness(rows(DISPATCH_PR_COUNT_API_CAP));
    const cache = tmpCache();
    countOpenPrsForDispatch('we', { exec: h.exec, readShared: h.readShared, env: {}, authorshipCache: cache });
    h.setWarm(false);
    h.calls.length = 0;
    const r = countOpenPrsForDispatch('we', { exec: h.exec, readShared: h.readShared, env: {}, authorshipCache: cache });
    expect(h.graphql()).toBe(0);
    expect(r).toMatchObject({ fallback: true, count: DISPATCH_PR_COUNT_API_CAP, unresolved: 0 });
  });
});

// xfaz7ho — `allow` is the operator's exception to grant. Twice on 2026-10-10 a worker ran
// `pr-limit.mjs allow --branch=<its own branch>` and opened its PR past the limit (#4786, #4779).
describe('allow is operator-only (xfaz7ho)', () => {
  const QUOTE = 'ok, let 4786 open past the limit';
  const operatorEnv = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'main-session' };
  const primary = '/Users/op/workspace/webeverything';
  const lane = '/Users/op/workspace/.lanes/web-everything/lane-7';
  const tmpState = () => join(mkdtempSync(join(tmpdir(), 'pr-limit-allow-')), 'pr-limit.json');
  const silent = () => ({ write: () => true });

  it('refuses a dispatched worker session (WE_CONVEYOR_WORKER=1), even with a quote', () => {
    const d = authoriseAllow({ branch: 'lane/x', operatorQuote: QUOTE, env: { ...operatorEnv, WE_CONVEYOR_WORKER: '1' }, cwdReal: primary });
    expect(d.ok).toBe(false);
    expect(d.channel).toBe('worker');
    expect(d.refusal).toMatch(/stop and report/);
  });

  it('refuses an unrecognised worker marker (fail closed)', () => {
    const d = authoriseAllow({ branch: 'lane/x', operatorQuote: QUOTE, env: { ...operatorEnv, WE_CONVEYOR_WORKER: 'true' }, cwdReal: primary });
    expect(d.ok).toBe(false);
    expect(d.channel).toBe('unknown');
  });

  it('refuses an agent working inside a lane clone, even with a quote', () => {
    const d = authoriseAllow({ branch: 'lane/other', operatorQuote: QUOTE, env: operatorEnv, cwdReal: lane });
    expect(d.ok).toBe(false);
    expect(d.channel).toBe('lane');
  });

  it("refuses allow-listing the caller's OWN checked-out branch", () => {
    const d = authoriseAllow({ branch: '4786-x', operatorQuote: QUOTE, env: operatorEnv, cwdReal: primary, ownBranch: 'origin/lane/4786-x' });
    expect(d.ok).toBe(false);
    expect(d.refusal).toMatch(/own branch/);
  });

  it('refuses a missing or blank --operator-quote', () => {
    for (const q of [undefined, '', '   ', true]) {
      const d = authoriseAllow({ branch: 'lane/x', operatorQuote: q, env: operatorEnv, cwdReal: primary });
      expect(d.ok).toBe(false);
      expect(d.refusal).toMatch(/--operator-quote/);
    }
  });

  it('accepts the operator channel with a quote (orchestrator session or a bare terminal)', () => {
    expect(authoriseAllow({ branch: 'lane/x', operatorQuote: QUOTE, env: operatorEnv, cwdReal: primary })).toMatchObject({ ok: true, channel: 'operator-session' });
    expect(authoriseAllow({ branch: 'lane/x', operatorQuote: QUOTE, env: {}, cwdReal: primary })).toMatchObject({ ok: true, channel: 'terminal' });
  });

  it('CLI: a worker session is refused with a non-zero exit, nothing allow-listed, and the refusal logged', () => {
    const path = tmpState();
    const code = runPrLimitCli(['allow', '--branch=lane/4786-x', '--reason=need it', `--operator-quote=${QUOTE}`],
      { env: { ...operatorEnv, WE_CONVEYOR_WORKER: '1' }, cwd: primary, path, ownBranch: '', stderr: silent(), stdout: silent() });
    expect(code).not.toBe(0);
    const st = readLimitState(path);
    expect(isBranchAllowedNow(st, 'lane/4786-x')).toBe(false);
    expect(st.history.at(-1)).toMatchObject({ action: 'allow-refused', target: '4786-x' });
  });

  it('CLI: missing quote is refused; operator channel with a quote is accepted and records the quote verbatim', () => {
    const path = tmpState();
    const deps = { env: operatorEnv, cwd: primary, path, ownBranch: '', stderr: silent(), stdout: silent() };
    expect(runPrLimitCli(['allow', '--branch=lane/4786-x', '--reason=r'], deps)).not.toBe(0);
    expect(isBranchAllowedNow(readLimitState(path), 'lane/4786-x')).toBe(false);
    expect(runPrLimitCli(['allow', '--branch=lane/4786-x', '--reason=r', `--operator-quote=${QUOTE}`], deps)).toBe(0);
    const st = readLimitState(path);
    expect(isBranchAllowedNow(st, 'lane/4786-x')).toBe(true);
    expect(st.branches['lane/4786-x']).toMatchObject({ operatorQuote: QUOTE, channel: 'operator-session' });
  });

  it('existing allow-list entries written before this rule (no quote, no channel) are still honoured', () => {
    const legacy = parseLimitState(JSON.stringify({ branches: { '4779-y': { reason: 'old', by: 'nic', at: '2026-10-10T10:00:00.000Z', until: null } } }));
    expect(isBranchAllowedNow(legacy, 'lane/4779-y')).toBe(true);
  });
});

// The card-only open exemption (xbxahvf) is only as honest as its changed-file list: `isCardOnlyDiff` documents that it
// needs the `--no-renames` list (both sides of a rename), or a code file moved into backlog/ reads as card-only.
describe('pr-land card-only open exemption — the changed-file list keeps both sides of a rename', () => {
  it('git’s default rename detection hides a code file moved into backlog/; --no-renames does not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-limit-rename-'));
    const git = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    mkdirSync(join(dir, 'scripts')); mkdirSync(join(dir, 'backlog'));
    const body = Array.from({ length: 40 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n';
    writeFileSync(join(dir, 'scripts', 'foo.mjs'), body);
    git('add', '-A'); git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD').trim();
    git('mv', 'scripts/foo.mjs', 'backlog/foo.md'); git('commit', '-qm', 'move');
    const list = (...flags) => git('diff', '--name-only', ...flags, `${base}...HEAD`).split('\n').filter(Boolean);
    expect(isCardOnlyDiff(list())).toBe(true); // the hole: the default list shows only backlog/foo.md
    expect(list('--no-renames').sort()).toEqual(['backlog/foo.md', 'scripts/foo.mjs']);
    expect(isCardOnlyDiff(list('--no-renames'))).toBe(false);
  });

  it('pr-land builds the open-limit changed-file list with --no-renames (source-level pin)', () => {
    const src = readFileSync(resolve(process.cwd(), 'scripts/pr-land.mjs'), 'utf8');
    const m = src.match(/changedFilesForLimit = gitC\((\[[^\]]*\])\)/);
    expect(m, 'changedFilesForLimit git invocation not found').not.toBeNull();
    expect(m[1]).toContain("'--no-renames'");
  });
});
