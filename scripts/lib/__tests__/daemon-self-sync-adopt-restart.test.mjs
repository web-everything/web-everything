/**
 * @file scripts/lib/__tests__/daemon-self-sync-adopt-restart.test.mjs
 * @description Live 2026-11-04 (fix daemon): a smoke-passed ready candidate (recorded by a rebuild job whose queuing
 *   pid had since restarted) was never adopted. The record is adopted by whichever tick next holds the write lock, so
 *   the restart is not the blocker; the superseded rule was. The running build listed `lane/author-lookup-defer-m2`
 *   as live, the daemon had since retired it with an `auto-retired` event (PR merged, content in main), and the
 *   candidate (which rightly no longer carries it) was refused as `superseded-omits-live-overlay`. The retired overlay
 *   must count as graduated when the event carries its own proof AND the build's tree independently contains it.
 *   A conflict hold naming an overlay that is no longer registered must not matter either: the hold is derived from
 *   the plan's registered overlays, so a removed one cannot re-create it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { matchReadyCandidate, overlayGraduated } from '../daemon-rebuild/adopt.mjs';

const temps = [];
afterEach(() => { while (temps.length) rmSync(temps.pop(), { recursive: true, force: true }); });

function sh(cwd, args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', timeout: 20_000 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

/** main + an overlay branch; `build` is a later main that already holds the overlay's content (squash-merged). */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'adopt-restart-'));
  temps.push(dir);
  sh(dir, ['init', '-q', '-b', 'main']);
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  sh(dir, ['add', 'a.txt']);
  sh(dir, ['commit', '-q', '-m', 'base']);
  sh(dir, ['checkout', '-q', '-b', 'overlay']);
  writeFileSync(join(dir, 'b.txt'), 'overlay content\n');
  sh(dir, ['add', 'b.txt']);
  sh(dir, ['commit', '-q', '-m', 'overlay']);
  const sha = sh(dir, ['rev-parse', 'HEAD']);
  sh(dir, ['checkout', '-q', 'main']);
  writeFileSync(join(dir, 'b.txt'), 'overlay content\n'); // squash: same content, different commit
  sh(dir, ['add', 'b.txt']);
  sh(dir, ['commit', '-q', '-m', 'squash of overlay']);
  const build = sh(dir, ['rev-parse', 'HEAD']);
  const git = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  return { dir, sha, build, git };
}

const REF = 'lane/author-lookup-defer-m2';
const retired = (over = {}) => ({
  at: '2026-11-04T20:11:35.508Z', kind: 'auto-retired', ref: REF, pr: null, by: 'prototype-load', reason: 'pr-merged',
  tip: null, evidence: { unique: 0, merges: 1, cleanMerges: true, contentInMain: true, prVia: 'merge-ref-base', prState: 'MERGED' }, ...over,
});
const READY_AT = '2026-11-04T21:52:24.136Z';

describe('overlayGraduated — an auto-retired overlay counts as graduated (live 2026-11-04)', () => {
  it.each(['pr-merged', 'in-main'])('accepts an auto-retired %s event whose evidence says the content is in main and the tree agrees', (reason) => {
    const f = fixture();
    expect(overlayGraduated({
      ref: REF, sha: f.sha, build: f.build, registered: () => false, events: [retired({ tip: f.sha, reason })], git: f.git, readyAt: READY_AT,
    })).toBe(true);
  });

  it('refuses when the event names a different tip than the live overlay sha', () => {
    const f = fixture();
    expect(overlayGraduated({
      ref: REF, sha: f.sha, build: f.build, registered: () => false, events: [retired({ tip: 'f'.repeat(40) })], git: f.git, readyAt: READY_AT,
    })).toBe(false);
  });

  it('refuses an auto-retired event with an unsupported reason despite matching tip and affirmative evidence', () => {
    const f = fixture();
    expect(overlayGraduated({
      ref: REF, sha: f.sha, build: f.build, registered: () => false,
      events: [retired({ tip: f.sha, reason: 'pr-closed' })], git: f.git, readyAt: READY_AT,
    })).toBe(false);
  });

  it.each([
    ['missing contentInMain', { cleanMerges: true }],
    ['false contentInMain', { cleanMerges: true, contentInMain: false }],
    ['missing cleanMerges', { contentInMain: true }],
    ['false cleanMerges', { cleanMerges: false, contentInMain: true }],
    ['missing evidence', undefined],
  ])('refuses an auto-retired event with %s', (_name, evidence) => {
    const f = fixture();
    expect(overlayGraduated({
      ref: REF, sha: f.sha, build: f.build, registered: () => false,
      events: [retired({ tip: f.sha, evidence })], git: f.git, readyAt: READY_AT,
    })).toBe(false);
  });

  it('refuses a retirement recorded after the candidate passed, a still-registered overlay, an unreadable log and a build lacking the content', () => {
    const f = fixture();
    const base = { ref: REF, sha: f.sha, build: f.build, registered: () => false, git: f.git, readyAt: READY_AT };
    expect(overlayGraduated({ ...base, events: [retired({ tip: f.sha, at: '2026-11-04T22:00:00.000Z' })] })).toBe(false);
    expect(overlayGraduated({ ...base, events: [retired({ tip: f.sha, at: 'not-a-date' })] })).toBe(false);
    expect(overlayGraduated({ ...base, registered: () => true, events: [retired({ tip: f.sha })] })).toBe(false);
    expect(overlayGraduated({ ...base, events: null })).toBe(false);
    const bare = sh(f.dir, ['rev-parse', 'main~1']); // a build WITHOUT the overlay content
    expect(overlayGraduated({ ...base, build: bare, events: [retired({ tip: f.sha })] })).toBe(false);
  });
});

describe('matchReadyCandidate — a ready record written by a job from before a daemon restart is adopted', () => {
  const BASE = '6f2f0e69383fb2a35209cd92eb7b7ecad2ccf3d8';
  const CAND = 'd9cefdbf7d428814ff01c69d21ab0275146fa904';
  const ready = () => ({
    kind: 'candidate', prevHead: BASE, tree: 'tree-a', passedAt: READY_AT,
    adopt: { finalSha: CAND, inputsKey: 'k1', mainSha: 'm1', applied: [{ ref: 'lane/fresh-plan-read-r3', sha: 'r3' }] },
  });
  const plan = { finalSha: 'planned-on-newer-main', inputsKey: 'k2', mainSha: 'm2', applied: [] };

  function match(f, events) {
    return matchReadyCandidate({
      ready: ready(), plan, prevHead: BASE, treeOf: () => 'other-tree',
      stillWanted: (r) => r === 'lane/fresh-plan-read-r3', registered: (r) => r === 'lane/fresh-plan-read-r3',
      verifyBuilt: () => true,
      liveApplied: [{ ref: 'lane/fresh-plan-read-m2', sha: 'm2sha' }, { ref: REF, sha: f.sha }],
      carries: (sha) => sha === 'm2sha', // the replaced m2 is inside the candidate; the retired one is not
      leftForMain: (a) => overlayGraduated({ ref: a.ref, sha: a.sha, build: f.build, registered: () => false, events, git: f.git, readyAt: READY_AT }),
      nowMs: Date.parse('2026-11-04T22:20:00Z'), maxAgeMs: 2 * 60 * 60_000,
    });
  }

  it('adopts the candidate (superseded) when the only overlay it omits was retired with proof', () => {
    const f = fixture();
    const m = match(f, [retired({ tip: f.sha })]);
    expect(m.adopt?.finalSha).toBe(CAND);
    expect(m.match).toBe('superseded');
  });

  it('still refuses (fail closed) when the omitted overlay has no retirement proof', () => {
    const f = fixture();
    const m = match(f, []);
    expect(m.adopt).toBeNull();
    expect(m.reason).toMatch(/^superseded-omits-live-overlay: lane\/author-lookup-defer-m2/);
  });

  it('a replaced overlay (stale hold target) that is no longer registered does not block: its sha is carried', () => {
    const f = fixture();
    const m = match(f, [retired({ tip: f.sha }), { kind: 'replaced', ref: 'lane/fresh-plan-read-m2', replacedBy: 'lane/fresh-plan-read-r3' }]);
    expect(m.adopt?.finalSha).toBe(CAND);
  });
});
