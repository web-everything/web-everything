/**
 * @file scripts/conveyor/__tests__/ci-heal-mark.test.mjs
 * @description Pins the PURE CI-heal durable-count helpers (WE #2666). Each completed CI-heal posts exactly ONE
 *   comment whose leading line is `CI_HEAL_COMMENT_MARKER`; `countCiHealComments` recovers the auto-CI-heal attempt
 *   count from the PR's own comment thread, so the retry cap survives a conveyor restart (the #2643 design, applied
 *   to the CI-health axis). Also pins that the marker leads the built comment body (posting and counting can never
 *   drift) and that only a LEADING marker counts (a human quoting it never inflates the tally). #3383 — also pins
 *   that ONLY a trusted author (automation or the repo operator) counts at all.
 */
import { describe, it, test, expect } from 'bun:test';
const __ORIG_URL = new URL('../../../../scripts/conveyor/__tests__/ci-heal-mark.test.mjs', import.meta.url).href;
const __ORIG_FILE = new URL(__ORIG_URL).pathname;
const __ORIG_DIR = new URL('.', __ORIG_URL).pathname.replace(/\/$/, '');
import { chmodSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  countCiHealComments, countChargeableCiHealComments, resolveCiHealBudgetRestore, readAttributedWindows, buildCiHealComment, CI_HEAL_COMMENT_MARKER, spawnCiHealRearm, sanitizeForPublicComment, redactSecrets, spawnCiHealRestamp, postOrOweCiHealComment, resolveHealHead,
} from '../../../../scripts/conveyor/ci-heal-mark.mjs';
import { buildRebaseOntoMainComment } from '../../../../scripts/conveyor/main-red-recovery.mjs';
import { readOwedWrites, owedWriteAlreadyLive } from '../../../../scripts/conveyor/ci-heal-owed.mjs';
import { budgetBlockedMessage } from '../../../../scripts/lib/gh-throttle.mjs';

import * as reviewLabel from '../../../../scripts/review-set-label.mjs';

const AUTOMATION = { login: 'web-everything' };

describe('countCiHealComments — the durable, restart-surviving CI-heal attempt count (#2666)', () => {
  it('counts one per comment whose LEADING line is the marker', () => {
    expect(countCiHealComments([
      { body: `${CI_HEAL_COMMENT_MARKER}\n\nrebased & re-pushed once`, author: AUTOMATION },
      { body: 'an unrelated human comment', author: AUTOMATION },
      { body: `${CI_HEAL_COMMENT_MARKER}\n\nand again`, author: AUTOMATION },
    ])).toBe(2);
  });

  it('tolerates a bare-string comment array as a SHAPE — but it carries no author, so it never counts (#3383)', () => {
    expect(countCiHealComments([`${CI_HEAL_COMMENT_MARKER}\nx`, 'noise'])).toBe(0);
  });

  it('does NOT count a comment that merely QUOTES the marker mid-body (no inflation)', () => {
    expect(countCiHealComments([{ body: `> ${CI_HEAL_COMMENT_MARKER}\na human quoting it in a reply`, author: AUTOMATION }])).toBe(0);
  });

  it('returns 0 for a non-array / empty input', () => {
    expect(countCiHealComments(null)).toBe(0);
    expect(countCiHealComments(undefined)).toBe(0);
    expect(countCiHealComments([])).toBe(0);
  });

  // #3383 — adversarial coverage review, 2026-09-24: before this item's fix, ANY GitHub account could post this
  // exact leading line and inflate a PR's CI-heal round cap toward exhaustion.
  it('a forged CI-heal marker from a random commenter ("mallory") does not count', () => {
    expect(countCiHealComments([{ body: `${CI_HEAL_COMMENT_MARKER}\n\nrebased`, author: { login: 'mallory' } }])).toBe(0);
  });

  it('a CI-heal marker posted by the repo operator still counts', () => {
    expect(countCiHealComments([{ body: `${CI_HEAL_COMMENT_MARKER}\n\nrebased`, author: { login: 'chalbert' } }])).toBe(1);
  });
});

describe('buildCiHealComment — the durable comment body (#2666)', () => {
  it('leads with the marker so posting and counting share ONE source of truth', () => {
    const body = buildCiHealComment({ reason: 'red-ci' });
    expect(body.split('\n')[0]).toBe(CI_HEAL_COMMENT_MARKER);
    expect(countCiHealComments([{ body, author: AUTOMATION }])).toBe(1); // round-trips: what we post, we count
  });

  it('distinguishes the CI repair record from the subsequent acceptance re-arm', () => {
    const body = buildCiHealComment({ reason: 'behind' });
    expect(body).toContain('review:human');
    expect(body).toContain('a live `review:accepted` may be re-armed separately');
    expect(body).not.toContain('was NOT touched');
  });
});

// #2811 — a CI-heal rebases and re-pushes the head, so a live `review:accepted` it finds is now stale. This
// hand-back re-arms it through the EXISTING `rearm-review.mjs` swap (never a second, hand-rolled label write).
describe('spawnCiHealRearm — hand a stale review:accepted back through rearm-review.mjs (#2811)', () => {
  const spy = (status = 0, stdout = '') => {
    const calls = [];
    const spawn = (cmd, argv, opts) => { calls.push({ cmd, argv, opts }); return { status, stdout, stderr: '' }; };
    return { calls, spawn };
  };

  it('shells THIS checkout\'s rearm-review.mjs with the pr, actor, and repo', () => {
    const { calls, spawn } = spy();
    const out = spawnCiHealRearm({ pr: 2811, repo: 'web-everything/web-everything', cwd: '/ws/we', spawn });
    expect(out).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].argv[0]).toMatch(/scripts\/conveyor\/rearm-review\.mjs$/);
    expect(calls[0].argv).toContain('2811');
    expect(calls[0].argv).toContain('--actor=conveyor CI-heal agent');
    expect(calls[0].argv).toContain('--repo=web-everything/web-everything');
    expect(calls[0].opts.cwd).toBe('/ws/we');
  });

  it('spawnCiHealRearm passes --only-if=accepted by default and omits it when onlyIfAccepted:false', () => {
    const a = spy();
    spawnCiHealRearm({ pr: 2811, repo: 'web-everything/web-everything', spawn: a.spawn });
    expect(a.calls[0].argv).toContain('--only-if=accepted');
    const b = spy();
    spawnCiHealRearm({ pr: 2811, repo: 'web-everything/web-everything', onlyIfAccepted: false, spawn: b.spawn });
    expect(b.calls[0].argv).not.toContain('--only-if=accepted');
  });

  it('a refused re-arm (nothing to re-arm — the common, no-accepted-label case) is reported, not thrown', () => {
    const { spawn } = spy(1, JSON.stringify({ ok: false, pr: 2811, reason: 'neither review:changes nor review:accepted is live' }));
    const out = spawnCiHealRearm({ pr: 2811, repo: 'web-everything/web-everything', spawn });
    expect(out.ok).toBe(false);
  });

  it('a spawn failure never throws — reported as {ok:false, reason}', () => {
    const thrower = () => { throw new Error('spawn ENOENT'); };
    expect(spawnCiHealRearm({ pr: 2811, repo: 'web-everything/web-everything', spawn: thrower })).toEqual({ ok: false, reason: 'spawn ENOENT' });
  });
});

// we:backlog/4352 — a budget-refused heal comment is recorded OWED (head-scoped), never silently dropped.
describe('#4352 — head-scoped heal comment + owed-on-budget-refusal', () => {
  const HEAD = 'abcdef0123456789abcdef0123456789abcdef01';
  const REPO = { key: 'we', slug: 'web-everything/web-everything' };
  const budgetError = () => {
    const stderr = budgetBlockedMessage({ resource: 'graphql', until: '2026-09-27T23:00:00Z' });
    return Object.assign(new Error(`Command failed: gh pr comment\n${stderr}`), { status: 1, stderr });
  };

  it('buildCiHealComment carries `head: <sha>` on its SECOND line; the marker still leads and still counts once', () => {
    const body = buildCiHealComment({ reason: 'red-ci', headSha: HEAD.toUpperCase() });
    expect(body.split('\n').slice(0, 2)).toEqual([CI_HEAL_COMMENT_MARKER, `head: ${HEAD}`]);
    expect(countCiHealComments([{ body, author: AUTOMATION }])).toBe(1);
    expect(buildCiHealComment({ reason: 'red-ci' })).not.toMatch(/^head:/m); // no sha → no line, never `head: `
  });

  it('a budget-refused post writes an owed record carrying the head sha and returns commented:false', () => {
    const owed = [];
    const out = postOrOweCiHealComment({
      pr: 2821, body: 'b', headSha: HEAD, repo: REPO,
      post: () => { throw budgetError(); }, owe: (r) => { owed.push(r); return r; },
    });
    expect(out.commented).toBe(false);
    expect(owed).toEqual([{ repo: 'we', slug: 'web-everything/web-everything', pr: 2821, kind: 'ci-heal', headSha: HEAD, body: 'b' }]);
  });

  it('a NON-budget failure still throws (nothing owed) — a retry would not fix it', () => {
    const owe = () => { throw new Error('must not owe'); };
    expect(() => postOrOweCiHealComment({
      pr: 1, body: 'b', headSha: HEAD, repo: REPO, post: () => { throw new Error('HTTP 404: Not Found'); }, owe,
    })).toThrow(/404/);
  });

  it('with no head sha (no dedupe key) a budget refusal still throws rather than owing an undedupable write', () => {
    expect(() => postOrOweCiHealComment({
      pr: 1, body: 'b', headSha: '', repo: REPO, post: () => { throw budgetError(); }, owe: () => ({}),
    })).toThrow(/rate limit/);
  });

  it('resolveHealHead — --head wins; else local `git rev-parse HEAD`; else empty', () => {
    expect(resolveHealHead({ headFlag: HEAD, exec: () => { throw new Error('unused'); } })).toBe(HEAD);
    expect(resolveHealHead({ exec: () => `${HEAD}\n` })).toBe(HEAD);
    expect(resolveHealHead({ exec: () => { throw new Error('not a repo'); } })).toBe('');
    const calls = [];
    expect(resolveHealHead({ headFlag: HEAD.slice(0, 9), cwd: '/repo', exec: (...args) => { calls.push(args); return HEAD; } })).toBe(HEAD);
    expect(calls[0][1]).toEqual(['rev-parse', '--verify', `${HEAD.slice(0, 9)}^{commit}`]);
    expect(calls[0][2].cwd).toBe('/repo');
    expect(resolveHealHead({ headFlag: HEAD.slice(0, 9), exec: () => { throw new Error('unresolvable prefix'); } })).toBe('');
    expect(resolveHealHead({ headFlag: 'bad-head', exec: () => HEAD })).toBe('');
  });

  it('REAL CLI PATH: a budget-blocked `gh` → owed record on disk (with head), exit 0, not a bare failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-heal-mark-owed-'));
    try {
      const bin = join(dir, 'bin');
      mkdirSync(bin, { recursive: true });
      // A `gh` that refuses exactly like gh-throttle's budget_blocked outcome does, for every call.
      writeFileSync(join(bin, 'gh'), `#!/bin/sh\nprintf '%s' ${JSON.stringify(budgetBlockedMessage({ resource: 'graphql', until: 'soon' }))} >&2\nexit 1\n`);
      chmodSync(join(bin, 'gh'), 0o755);
      const lockRoot = join(dir, 'lock');
      const r = spawnSync(process.execPath, [
        join(dirname(fileURLToPath(__ORIG_URL)), '..', 'ci-heal-mark.mjs'), '2821', '--repo=web-everything/web-everything', '--reason=red-ci', `--head=${HEAD}`,
      ], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, WE_GH_THROTTLE_LOCK_ROOT: lockRoot } });
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout.trim().split('\n').pop())).toMatchObject({ ok: true, pr: 2821, commented: false, owed: true });
      const owed = readOwedWrites({ dir: join(lockRoot, 'ci-heal-owed') });
      expect(owed).toEqual([expect.objectContaining({ repo: 'we', slug: 'web-everything/web-everything', pr: 2821, kind: 'ci-heal', headSha: HEAD })]);
      // The owed body IS the comment that will be posted — and it dedupes against itself once live.
      expect(owedWriteAlreadyLive([{ body: owed[0].body, author: AUTOMATION }], owed[0])).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});


// #xan09na: real Git histories and real children; only the remote forge is simulated.
describe('CI-heal acceptance replay through the actual CLI', () => {
  it.each(['unchanged', 'changed', 'missing', 'prefix', 'human', 'head-race', 'verdict-race', 'soak'])('%s heal reaches the actual guarded restamp and fallback', (scenario) => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-heal-carry-'));
    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    try {
      git('init', '-b', 'main');
      git('config', 'user.name', 'Replay');
      git('config', 'user.email', 'replay@example.test');
      writeFileSync(join(dir, 'source.js'), 'export const value = 1;\n');
      git('add', '.'); git('commit', '-m', 'base');
      const reviewedBase = git('rev-parse', 'HEAD');
      git('checkout', '-b', 'lane');
      writeFileSync(join(dir, 'source.js'), 'export const value = 2;\n');
      git('commit', '-am', 'contribution');
      const reviewedHead = git('rev-parse', 'HEAD');
      const reviewedDiff = git('diff', reviewedBase, reviewedHead);
      git('checkout', 'main');
      writeFileSync(join(dir, 'upstream.txt'), 'upstream only\n');
      git('add', '.'); git('commit', '-m', 'base movement');
      const healedBase = git('rev-parse', 'HEAD');
      git('checkout', 'lane'); git('rebase', 'main');
      if (scenario === 'changed') {
        writeFileSync(join(dir, 'source.js'), 'export const value = 3;\n');
        git('commit', '-am', 'CI repair changes contribution');
      }
      const healedHead = git('rev-parse', 'HEAD');
      git('remote', 'add', 'origin', dir);
      const { buildVerdictComment } = reviewLabel;
      const state = { state: 'OPEN', headRefOid: healedHead, headRefName: 'lane', labels: [{ name: 'review:accepted' }],
        comments: [{ author: AUTOMATION, body: buildVerdictComment({ to: 'accepted', actor: 'reviewer', headSha: reviewedHead, reviewedDiff, ...(scenario === 'human' ? { to: 'clear-human', clearerId: 'operator' } : {}) }) }] };
      if (scenario === 'missing') state.comments = [];
      writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
      mkdirSync(join(dir, 'bin'));
      writeFileSync(join(dir, 'bin', 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const a = process.argv.slice(2);
const s = JSON.parse(fs.readFileSync('state.json', 'utf8'));
fs.appendFileSync('calls.jsonl', JSON.stringify(a) + '\\n');
if (a[0] === 'pr' && a[1] === 'view') {
 s.reads = (s.reads || 0) + 1;
 if (s.reads === 3 && ${JSON.stringify(scenario)} === 'head-race') s.headRefOid = 'f'.repeat(40);
 if (s.reads === 3 && ${JSON.stringify(scenario)} === 'verdict-race') s.labels = [{name:'review:changes'}];
 console.log(JSON.stringify(s));
}
else if (a[0] === 'pr' && a[1] === 'comment') {
 const body = a.includes('--body-file') ? fs.readFileSync(a[a.indexOf('--body-file') + 1], 'utf8') : a[a.indexOf('--body') + 1];
 s.comments.push({author:{login:'web-everything'}, body});
} else if (a[0] === 'pr' && a[1] === 'edit') {
 for(let i=0;i<a.length;i++) { if(a[i]==='--remove-label') s.labels=s.labels.filter(l=>l.name!==a[i+1]);
 if(a[i]==='--add-label' && !s.labels.some(l=>l.name===a[i+1])) s.labels.push({name:a[i+1]}); }
} else { console.error('unexpected gh call', a); process.exit(1); }
fs.writeFileSync('state.json', JSON.stringify(s));
`);
      chmodSync(join(dir, 'bin', 'gh'), 0o755);
      const r = spawnSync(process.execPath, [join(dirname(fileURLToPath(__ORIG_URL)), '..', 'ci-heal-mark.mjs'), '42', '--repo=web-everything/web-everything', `--head=${scenario === 'prefix' ? healedHead.slice(0, 10) : healedHead}`],
        { cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, WE_VERDICT_LEDGER_DIR: join(dir, 'ledger'), WE_GH_THROTTLE_LOCK_ROOT: join(dir, 'lock') } });
      const final = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
      const proof = { reviewedBase, reviewedHead, healedBase, healedHead, result: r.stdout, labels: final.labels, comments: final.comments, calls: readFileSync(join(dir, 'calls.jsonl'), 'utf8') };
      expect(r.status, r.stderr).toBe(0);
      const carried = ['unchanged', 'prefix', 'human', 'soak'].includes(scenario);
      const rearmed = !carried && scenario !== 'verdict-race';
      const outcome = JSON.parse(r.stdout.trim().split('\n').pop());
      expect(outcome, JSON.stringify(proof)).toMatchObject({ restamped: carried, rearmed });
      if (!carried) expect(outcome.carryReason).toEqual(expect.any(String));
      expect(final.labels).toEqual([{ name: carried ? 'review:accepted' : rearmed ? 'review:pending' : 'review:changes' }]);
      const added = final.comments.slice(state.comments.length);
      expect(added[0].body).toContain(CI_HEAL_COMMENT_MARKER);
      expect(added[0].body).toContain(`head: ${healedHead}`);
      expect(added.filter(c => c.body.includes('acceptance re-stamped'))).toHaveLength(carried ? 1 : 0);
      expect(added.filter(c => c.body.includes('re-armed for re-review'))).toHaveLength(rearmed ? 1 : 0);
      if (carried) {
        expect(added[1].body).toContain(`reviewed-sha: ${healedHead}`);
        expect(added[1].body).toContain(reviewedHead);
        expect(added[1].body).toContain('ci-heal');
        expect(added[1].body.includes('cleared-human:')).toBe(scenario === 'human');
      } else expect(added.every(c => !c.body.includes('reviewed-sha:') && !c.body.includes('cleared-human:'))).toBe(true);
      const calls = proof.calls.trim().split('\n').map(JSON.parse);
      expect(calls[0].slice(0, 2)).toEqual(['pr', 'comment']);
      expect(calls.filter(c => c[1] === 'edit')).toHaveLength(rearmed ? 1 : 0);
      expect(calls.every(c => c.includes('web-everything/web-everything') || c.includes('--repo=web-everything/web-everything'))).toBe(true);
      if (scenario === 'unchanged') console.info('CI-heal proven replay', JSON.stringify(proof));
      if (scenario === 'soak') {
        let previousHead = healedHead;
        for (let round = 2; round <= 4; round++) {
          git('checkout', 'main');
          writeFileSync(join(dir, 'upstream.txt'), `base movement ${round}\n`);
          git('commit', '-am', `base movement ${round}`);
          git('checkout', 'lane'); git('rebase', 'main');
          const nextHead = git('rev-parse', 'HEAD');
          const live = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
          live.headRefOid = nextHead;
          writeFileSync(join(dir, 'state.json'), JSON.stringify(live));
          const next = spawnSync(process.execPath, [join(dirname(fileURLToPath(__ORIG_URL)), '..', 'ci-heal-mark.mjs'),
            '42', '--repo=web-everything/web-everything', `--head=${nextHead}`],
          { cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
            WE_VERDICT_LEDGER_DIR: join(dir, 'ledger'), WE_GH_THROTTLE_LOCK_ROOT: join(dir, 'lock') } });
          expect(next.status, next.stderr).toBe(0);
          expect(JSON.parse(next.stdout.trim().split('\n').pop())).toMatchObject({ restamped: true, rearmed: false });
          const after = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
          expect(after.labels).toEqual([{ name: 'review:accepted' }]);
          expect(after.comments).toHaveLength(1 + 2 * round);
          expect(after.comments.at(-1).body).toContain(`reviewed-sha: ${nextHead}`);
          expect(after.comments.at(-1).body).toContain(previousHead);
          previousHead = nextHead;
        }
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});


describe('CI-heal carry child arguments', () => {
  it('binds the full head, provenance, repo and cwd without claiming equality', () => {
    const calls = [];
    const headSha = 'a'.repeat(40);
    expect(spawnCiHealRestamp({ pr: 42, repo: 'o/r', cwd: '/repo', headSha,
      spawn: (...args) => { calls.push(args); return { status: 0 }; } })).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual(expect.arrayContaining(['42', '--repo=o/r', `--expect-head=${headSha}`, '--channel=ci-heal']));
    expect(calls[0][1].join(' ')).not.toContain('content-preserving');
    expect(calls[0][2].cwd).toBe('/repo');
    expect(spawnCiHealRestamp({ headSha: headSha.slice(0, 10), spawn: () => { throw new Error('must not spawn'); } }).ok).toBe(false);
    expect(spawnCiHealRestamp({ headSha, spawn: () => ({ status: 1, stdout: 'proof refused' }) })).toEqual({ ok: false, reason: 'proof refused' });
    expect(spawnCiHealRestamp({ headSha, spawn: () => { throw new Error('spawn failed'); } })).toEqual({ ok: false, reason: 'spawn failed' });
  });
});

// xe8y12n: observed timelines had CI labels, never a review verdict. Replay the
// completion CLI, then the drain's green-CI cleanup that removed the last label.
describe('CI-heal missing routing label incident replay', () => {
  const head = '1807e6dc53937a98d6104df6f1c5fa2d5ff7a670';
  const scenarios = [
    ...['source.js', 'README.md', 'config.toml', 'data.json'].map(file => ({ name: `xe8y12n #3239 ${file}`, pr: 3239, labels: [], file, expected: ['review:pending'] })),
    { name: 'xe8y12n withheld write #3239', labels: [], writeIgnored: true, expected: [], healthProof: true },
    ...['source.js', 'README.md', 'config.toml', 'data.json'].flatMap(file => [
      { name: `${file} malformed child labels`, labels: [], race: { labels: null }, expected: [] },
      { name: `${file} missing child state`, labels: [], race: { state: null }, expected: [] },
      { name: `${file} missing child head`, labels: [], race: { headRefOid: null }, expected: [] },
      { name: `${file} concurrent verdict`, labels: [], race: { labels: [{ name: 'review:human' }] }, expected: ['review:human'] },
      { name: `${file} child read fails`, labels: [], childReadFails: true, expected: [] },
      { name: `${file} verification read fails`, labels: [], refetchFails: true, expected: ['review:pending'] },
    ].map(scenario => ({ ...scenario, file, guardCase: true }))),
    { name: '#3463 prepare (2026-10-02 05:06:38Z)', pr: 3463, labels: ['ci:failed', 'review-status:fixing'], expected: ['review:pending'] },
    { name: '#3389 prevention (2026-10-01 22:17:17Z)', pr: 3389, head: '99d53bf598f9292ea964cad68d985f038e425cdc', labels: ['checking', 'review-status:fixing'], expected: ['review:pending'] },
    { name: 'existing prevention merge path', labels: ['ready-to-merge', 'checking'], expected: ['ready-to-merge'] },
    // The final pre-write read is the child's THIRD view (parent observation, child initial read, pre-write read).
    { name: 'verdict arrives at the pre-write read', file: 'source.js', guardCase: true, labels: [], raceAt: 3, race: { labels: [{ name: 'review:human' }] }, expected: ['review:human'] },
    { name: 'ready-to-merge arrives at the pre-write read', file: 'source.js', guardCase: true, labels: [], raceAt: 3, race: { labels: [{ name: 'ready-to-merge' }] }, expected: ['ready-to-merge'] },
    { name: 'draft arrives at the pre-write read', file: 'source.js', guardCase: true, labels: [], raceAt: 3, race: { isDraft: true }, expected: [] },
    { name: 'draft status unknown at the pre-write read', file: 'source.js', guardCase: true, labels: [], raceAt: 3, race: { isDraft: null }, expected: [] },
    { name: 'draft status unknown at the hand-back read', file: 'source.js', guardCase: true, labels: [], isDraftUnknown: true, expected: [] },
    ...['review:human', 'review:changes', 'review:pending', 'review:unknown'].map(label => ({ name: label, labels: [label], expected: [label] })),
    ...['review:human', 'review:changes', 'review:accepted', 'review:unknown'].map(label => ({ name: `concurrent ${label}`, labels: [], race: { labels: [{ name: label }] }, expected: [label] })),
    { name: 'concurrent head move', labels: [], race: { headRefOid: 'f'.repeat(40) }, expected: [] },
    { name: 'closed', labels: [], state: 'CLOSED', expected: [] },
    { name: 'draft', labels: [], isDraft: true, expected: [] },
    { name: 'missing labels', labels: null, expected: [] },
    { name: 'malformed labels', labels: [null], expected: [] },
    { name: 'read fails', labels: [], readFails: true, expected: [] },
    { name: 'write fails', labels: [], writeFails: true, expected: [] },
    { name: 'write is not observed', labels: [], writeIgnored: true, expected: [] },
    { name: 'post-write stale landing signal appears', labels: [], afterWrite: { labels: [{ name: 'review:pending' }, { name: 'ready-to-merge' }, { name: 'redteam:accepted' }] }, expected: ['review:pending', 'ready-to-merge', 'redteam:accepted'] },
    { name: 'post-write head changes', labels: [], afterWrite: { headRefOid: 'f'.repeat(40) }, expected: ['review:pending'] },
  ];
  const restoreOnlyScenarios = [
    { name: 'unlabelled open PR', pr: 42, labels: [], expected: ['review:pending'] },
    { name: 'accepted', labels: ['review:accepted'], expected: ['review:accepted'] },
    { name: 'merged', labels: [], state: 'MERGED', expected: [] },
    ...scenarios.filter(scenario => !scenario.file && !scenario.healthProof),
  ].map(scenario => ({ ...scenario, name: `restore-only: ${scenario.name}`, restoreOnly: true }));
  it.each([...scenarios, ...restoreOnlyScenarios])('$name', async (scenario) => {
    let healHead = scenario.head || head;
    const dir = mkdtempSync(join(tmpdir(), 'ci-heal-routing-'));
    try {
      if ((scenario.file && !scenario.guardCase) || scenario.healthProof) {
        const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
        git('init', '-b', 'lane');
        git('config', 'user.name', 'Synthetic heal'); git('config', 'user.email', 'heal@example.test');
        writeFileSync(join(dir, scenario.file || 'source.js'), 'synthetic healed content\n');
        git('add', scenario.file || 'source.js'); git('commit', '-m', 'synthetic CI heal');
        git('init', '--bare', 'remote.git');
        git('remote', 'add', 'origin', join(dir, 'remote.git'));
        git('push', 'origin', 'HEAD:refs/heads/lane');
        healHead = git('rev-parse', 'HEAD');
        expect(git('--git-dir=remote.git', 'rev-parse', 'refs/heads/lane')).toBe(healHead);
      }
      const labels = scenario.labels?.map(name => name === null ? null : ({ name }));
      const state = { state: scenario.state || 'OPEN', isDraft: scenario.isDraftUnknown ? undefined : scenario.isDraft || false, headRefOid: healHead, labels, comments: [], files: scenario.file ? [{ path: scenario.file }] : [] };
      writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
      mkdirSync(join(dir, 'bin'));
      writeFileSync(join(dir, 'bin', 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const a = process.argv.slice(2), scenario = ${JSON.stringify(scenario)};
const s = JSON.parse(fs.readFileSync('state.json', 'utf8'));
fs.appendFileSync('calls.jsonl', JSON.stringify(a) + '\\n');
if (a[0] === 'pr' && a[1] === 'view') {
 if (scenario.readFails || (scenario.childReadFails && s.reads >= 1) || (scenario.refetchFails && s.written)) process.exit(1);
 s.reads = (s.reads || 0) + 1;
 if (s.reads === (scenario.raceAt || 2) && scenario.race) Object.assign(s, scenario.race);
 if (s.written && scenario.afterWrite) Object.assign(s, scenario.afterWrite);
 console.log(JSON.stringify(s));
} else if (a[0] === 'pr' && a[1] === 'comment') {
 s.comments.push({body: a.includes('--body-file') ? fs.readFileSync(a[a.indexOf('--body-file') + 1], 'utf8') : a[a.indexOf('--body') + 1]});
} else if (a[0] === 'pr' && a[1] === 'edit') {
 if (scenario.writeFails) process.exit(1);
 if (scenario.writeIgnored) process.exit(0);
 s.written = true;
 for (let i = 0; i < a.length; i++) {
  if (a[i] === '--add-label' && !s.labels.some(l => l.name === a[i + 1])) s.labels.push({name: a[i + 1]});
  if (a[i] === '--remove-label') s.labels = s.labels.filter(l => l.name !== a[i + 1]);
 }
} else { console.error('unexpected gh call', a); process.exit(1); }
fs.writeFileSync('state.json', JSON.stringify(s));
`);
      chmodSync(join(dir, 'bin', 'gh'), 0o755);
      const entry = pathToFileURL(join(dirname(fileURLToPath(__ORIG_URL)), '..', 'ci-heal-mark.mjs'));
      // Opt-in historical execution uses the preparation SHA's actual CLI, with imports anchored to
      // its original location. No alternate production entrypoint or helper file is created.
      const historical = process.env.XE8Y12N_PREPARATION === '1'
        ? execFileSync('git', ['show', '026425e9e4a9c067851692c796ec0620879dabcb:scripts/conveyor/ci-heal-mark.mjs'], { encoding: 'utf8' })
          .replace(/from (['"])(\.[^'"]+)\1/g, (_m, quote, path) => `from ${quote}${new URL(path, entry).href}${quote}`)
          .replaceAll('__ORIG_URL', JSON.stringify(entry.href)) : null;
      const result = spawnSync(process.execPath, [...(historical ? ['--input-type=module', '--eval', historical, '--'] : []), fileURLToPath(entry),
        String(scenario.pr || 42), '--repo=web-everything/web-everything',
        // Restore-only must use the remote head, ignoring even a conflicting explicit heal head.
        `--head=${scenario.restoreOnly ? 'b'.repeat(40) : healHead}`,
        ...(scenario.restoreOnly ? ['--restore-routing-only'] : [])],
      { cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, WE_GH_THROTTLE_LOCK_ROOT: join(dir, 'lock') } });
      const failed = scenario.readFails || scenario.writeFails || scenario.writeIgnored || scenario.afterWrite || scenario.refetchFails;
      expect(result.status, result.stderr).toBe(scenario.restoreOnly && failed ? 1 : 0);
      const final = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
      const { planCiLifecycleLabelUpdate } = await import('../../../../scripts/merge-ai-prs.mjs');
      const validLabels = (final.labels || []).filter(Boolean);
      const cleanup = planCiLifecycleLabelUpdate({ currentLabels: validLabels, desired: 'ready-to-merge', owned: ['checking', 'ci:failed', 'blocked'] });
      // fix-end removes its activity badge; drain removes stale CI labels on green.
      const afterGreen = validLabels.map(l => l.name).filter(l => l !== 'review-status:fixing' && !cleanup.toRemove.includes(l));
      expect(afterGreen, JSON.stringify({ pushedSha: healHead, result: result.stdout, calls: readFileSync(join(dir, 'calls.jsonl'), 'utf8'), labels: final.labels })).toEqual(scenario.expected);
      const calls = readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      expect(calls.every(c => c.includes('web-everything/web-everything') || c.includes('--repo=web-everything/web-everything'))).toBe(true);
      const edits = calls.filter(c => c[1] === 'edit');
      if (scenario.restoreOnly) {
        expect(final.comments.some(c => c.body.includes(CI_HEAL_COMMENT_MARKER))).toBe(false);
        expect(final.comments).toEqual(scenario.pr ? [{ body: 'Review routing restored: this PR had lost all routing labels after an earlier CI heal (fixed by #3475); added review:pending so review picks it up.' }] : []);
        expect(calls.map(c => c[1])).toEqual(scenario.pr ? ['view', 'view', 'edit', 'view', 'comment']
          : scenario.readFails ? ['view']
          : failed ? ['view', 'view', 'edit', ...(scenario.writeFails ? [] : ['view'])]
          : ['view', 'view']);
        if (failed) return;
        const outcome = JSON.parse(result.stdout.trim());
        expect(outcome).toEqual({ pr: scenario.pr || 42,
          ...(scenario.pr ? { restored: 'review:pending' } : { skipped: true }), reason: expect.any(String) });
        expect(outcome.reason.length).toBeGreaterThan(0);
        if (!scenario.pr) expect(edits).toHaveLength(0);
        return;
      }
      const outcome = JSON.parse(result.stdout.trim().split('\n').pop());
      if (scenario.healthProof) {
        const { default: smell } = await import('../../../../scripts/conveyor/health-smells/review-label-missing.mjs');
        const { emptyHealthState, stepEpisodes } = await import('../../../../scripts/conveyor/health-watch-core.mjs');
        let memory = emptyHealthState();
        const transitions = [], samples = [];
        for (let n = 0; n < 10; n++) {
          const time = Date.parse('2026-10-03T12:00:00Z') + n * 900000;
          const results = smell.evaluate({ prs: [{ repo: 'web-everything/web-everything', number: 3239,
            reviewObservation: { ...final, commits: [{ authors: [{ name: 'Claude' }] }], observedAt: time } }] },
            { now: time, lastTick: memory.lastTick });
          const next = stepEpisodes(memory, [{ smell, results }], time);
          transitions.push(...next.transitions.map(t => t.type));
          samples.push({ observedAt: time, transitions: next.transitions.map(t => t.type) });
          memory = JSON.parse(JSON.stringify({ ...next.state, lastTick: { completedAt: time } }));
        }
        expect(transitions).toEqual(['opened']);
        expect(Object.keys(memory.episodes)).toHaveLength(1);
        console.info('xe8y12n withheld-write completion soak', JSON.stringify({ pushedSha: healHead, result: outcome, calls, labels: final.labels, samples }));
      }
      if (scenario.file && !scenario.guardCase) {
        const { planReconcile } = await import('../../../../scripts/conveyor/reconcile-core.mjs');
        const commits = [{ messageHeadline: 'heal', authors: [{ name: 'Claude' }] }];
        const plan = planReconcile({ requiredChecks: ['gate'], prs: [{ ...final, number: 3239, commits,
          statusCheckRollup: [{ name: 'gate', status: 'COMPLETED', conclusion: 'SUCCESS' }] }] });
        expect(plan.dispatch).toContainEqual(expect.objectContaining({ kind: 'review' }));
        console.info('xe8y12n synthetic completion proof', JSON.stringify({ pushedSha: healHead, content: scenario.file,
          result: outcome, calls, labels: final.labels, plan }));
        const repeated = spawnSync(process.execPath, [fileURLToPath(entry), '3239', '--repo=web-everything/web-everything', `--head=${healHead}`],
          { cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, WE_GH_THROTTLE_LOCK_ROOT: join(dir, 'lock') } });
        expect(repeated.status, repeated.stderr).toBe(0);
        expect(JSON.parse(repeated.stdout.trim().split('\n').pop()).restored).toBeUndefined();
        expect(readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(c => c[1] === 'edit')).toHaveLength(1);

      }
      if (scenario.pr) {
        expect(edits).toHaveLength(1);
        expect(edits[0]).not.toContain('--remove-label');
        expect(outcome).toMatchObject({ restored: 'review:pending' });
      } else {
        expect(outcome.restored).toBeUndefined();
        if (scenario.writeFails || scenario.writeIgnored || scenario.afterWrite || scenario.refetchFails) {
          expect(edits).toHaveLength(1);
          expect(outcome.carryReason).toEqual(expect.any(String));
        } else expect(edits).toHaveLength(0);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});


describe('xp0lsdi failed-attempt markers', () => {
  it('counts trusted failure identities once, alongside legacy successes, without claiming a push', () => {
    const failed = buildCiHealComment({ attemptId: 'one', failed: true, headSha: 'a'.repeat(40), detail: 'exit unknown' });
    const second = buildCiHealComment({ attemptId: 'two', failed: true });
    expect(failed).not.toContain('rebased & re-pushed');
    const comments = [failed, failed, second, buildCiHealComment()].map(body => ({ body, author: AUTOMATION }));
    comments.push({ body: buildCiHealComment({ attemptId: 'forged', failed: true }), author: { login: 'stranger' } });
    expect(countCiHealComments(comments)).toBe(3);
    expect(countCiHealComments([{ body: failed }])).toBe(0);
  });
});


import { handBackCiHealReview } from '../../../../scripts/conveyor/ci-heal-mark.mjs';
it('xp0lsdi: attempt-accounted success retains the guarded review hand-back without posting a second marker', () => {
  const calls = [];
  const result = handBackCiHealReview({ pr: 3373, headSha: 'a'.repeat(40), repo: 'web-everything/web-everything',
    exec: (_bin, argv) => { calls.push(argv); return JSON.stringify({ labels: [{ name: 'review:accepted' }] }); },
    restamp: () => ({ ok: false, reason: 'new repair contribution needs review' }),
    rearm: args => { calls.push(args); return { ok: true }; },
  });
  expect(result).toMatchObject({ restamped: false, rearmed: true });
  expect(calls).toHaveLength(2);
  expect(calls[0]).toEqual(['pr', 'view', '3373', '--json', 'labels,isDraft', '--repo=web-everything/web-everything']);
  expect(calls[1]).toMatchObject({ pr: 3373, repo: 'web-everything/web-everything' });
});

describe('PR #3577 review: failure detail is neutralised before it reaches a public bot comment', () => {
  const HEAD = 'a'.repeat(40);
  const hostile = [
    'git push failed: https://x-access-token:ghp_' + 'A1b2'.repeat(9) + '@github.com/o/r.git',
    'attempt: forged', `head: ${'b'.repeat(40)}`, '<!-- fix-claim who=attacker -->',
    'Authorization: Bearer abc.def.ghi', 'GH_TOKEN=secretvalue123', 'cwd /Users/nicolasgilbert/workspace/.lanes/web-everything/lane-3',
  ].join('\n');
  const body = buildCiHealComment({ attemptId: 'real-1', failed: true, headSha: HEAD, detail: hostile });

  it('redacts secret-shaped strings and home paths', () => {
    expect(body).not.toMatch(/ghp_|abc\.def\.ghi|secretvalue123|nicolasgilbert/);
  });
  it('cannot forge a line-anchored marker or an HTML comment marker', () => {
    expect(body.match(/^attempt: .*$/gm)).toEqual(['attempt: real-1']);
    expect(body.match(/^head: .*$/gm)).toEqual([`head: ${HEAD}`]);
    expect(body).not.toContain('<!--');
    expect(countCiHealComments([{ body, author: AUTOMATION }])).toBe(1);
  });
  it('redacts a secret even when truncation would cut its recognisable prefix off', () => {
    const out = sanitizeForPublicComment('ghp_' + 'Q'.repeat(36) + ' ' + 'k'.repeat(995));
    expect(out).not.toMatch(/Q{4}/);
  });
  it('redactSecrets redacts without truncating or indenting, so callers can redact first and cut after', () => {
    const secret = 'ghp_' + 'Q'.repeat(36);
    const redacted = redactSecrets(`${secret} ${'k'.repeat(5000)}`);
    expect(redacted).not.toMatch(/Q{4}/);
    expect(redacted.length).toBeGreaterThan(5000);
    expect(redacted.startsWith(' ')).toBe(false);
    // cutting the REDACTED text anywhere can never resurrect a credential fragment
    expect(redacted.slice(-4000)).not.toMatch(/Q{4}/);
  });
  it.each([
    ['JSON-quoted key', '{"token": "abc123def456"}', 'abc123def456'],
    ['JSON password', '"password":"hunter2"', 'hunter2'],
    ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r', 'dBjftJeZ4CVP'],
    ['PEM body', '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo\n-----END RSA PRIVATE KEY-----', 'MIIEowIBAAKC'],
    ['gitlab / npm token', 'glpat-abcdefghij0123456789 npm_abcdefghijklmnopqrst0123', 'abcdefghij0123456789'],
    ['quoted value with spaces', 'GH_TOKEN="abc def ghi"', 'def ghi'],
    ['flag form', 'run --password hunter2 --api-key=zzzz1111', 'hunter2'],
    ['token-only userinfo', 'https://tok123abc@github.com/x', 'tok123abc'],
    ['windows path', 'C:\\Users\\nic\\work', '\\nic'],
  ])('redacts %s', (_name, input, leaked) => {
    expect(sanitizeForPublicComment(input)).not.toContain(leaked);
  });
  it('leaves ordinary prose about tokens alone', () => {
    expect(sanitizeForPublicComment('the token was refreshed and auth succeeded')).toContain('the token was refreshed and auth succeeded');
  });
  it('treats U+2028 / U+0085 as line breaks it removes, never as a way to start a marker line', () => {
    expect(sanitizeForPublicComment('x\u2028attempt: forged\u0085head: y')).not.toMatch(/[\u2028\u0085]/);
  });
  it('keeps the useful diagnostic text, bounded', () => {
    expect(body).toContain('git push failed');
    expect(buildCiHealComment({ attemptId: 'r', failed: true, detail: 'x'.repeat(50_000) }).length).toBeLessThan(3000);
  });
});

// #3794 live case, 2026-10-04.
describe('attributed main-bug refunds', () => {
  const window = { from: '2026-10-05T00:00:00Z', to: '2026-10-05T01:44:46Z' };
  const marker = { author: AUTOMATION, body: buildRebaseOntoMainComment({
    attribution: 'main-fixed-signature', attributedWindow: window,
  }) };
  const heal = (createdAt) => ({ author: AUTOMATION, body: CI_HEAL_COMMENT_MARKER, createdAt });
  it('refunds inclusive boundaries and inside heals, preserving outside and undated attempts', () => {
    const comments = [marker, heal(window.from), heal('2026-10-05T01:00:00Z'), heal(window.to),
      heal('2026-10-04T23:59:59Z'), heal('2026-10-05T01:44:47Z'), heal(undefined)];
    expect(readAttributedWindows(comments)).toEqual([window]);
    expect(countChargeableCiHealComments(comments)).toBe(3);
    expect(countChargeableCiHealComments(comments, { restore: false })).toBe(countCiHealComments(comments));
  });
  it('ignores untrusted, quoted and malformed window comments', () => {
    for (const bad of [
      { ...marker, author: { login: 'outsider' } }, { ...marker, body: `quoted:\n${marker.body}` },
      { ...marker, body: marker.body.replace(window.to, 'not-a-date') },
    ]) {
      expect(readAttributedWindows([bad])).toEqual([]);
      expect(countChargeableCiHealComments([bad, heal(window.from)])).toBe(1);
    }
    expect(countChargeableCiHealComments(null)).toBe(0);
  });
});

it('enables budget restoration unless the environment explicitly disables it', () => {
  for (const value of [undefined, '', '1', 'true', 'anything']) expect(resolveCiHealBudgetRestore({ WE_CI_HEAL_BUDGET_RESTORE: value })).toBe(true);
  for (const value of ['0', 'false', 'FALSE']) expect(resolveCiHealBudgetRestore({ WE_CI_HEAL_BUDGET_RESTORE: value })).toBe(false);
});
