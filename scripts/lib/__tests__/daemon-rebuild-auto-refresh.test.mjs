/**
 * @file scripts/lib/__tests__/daemon-rebuild-auto-refresh.test.mjs
 * @description xqz26k1 (x9diisp auto-refresh half) — a clone HELD because main moved onto its live overlays builds its
 *   own refresh candidate (last-good HEAD + origin/main) by a deterministic containment rule, checks it off-lock, and
 *   in shadow mode only logs what it would adopt. Live 2026-10-20: review held from 19:54Z, drain from 20:24Z, after
 *   main graduated #5755 / #5747 / #5770; each needed a hand merge of origin/main into its stack top.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { rebuildClone } from '../daemon-rebuild.mjs';
import { addOverlay, readOverlayState } from '../daemon-overlays.mjs';
import {
  lineChange, carriedBy, guardDiff, parseDiff3, resolveFileHunks, resolveAutoRefreshMode, readAutoRefreshRecord,
  AUTO_REFRESH_MODE_ENV,
} from '../daemon-rebuild/auto-refresh.mjs';

process.env.WE_DAEMON_REBUILD_SKIP_UNRELATED = '0';

const temps = [];
afterEach(() => { while (temps.length) rmSync(temps.pop(), { recursive: true, force: true }); });
const mktemp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); temps.push(d); return d; };
const gitOk = (cwd, args) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', timeout: 20_000 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
};
const write = (dir, name, content) => { mkdirSync(dirname(join(dir, name)), { recursive: true }); writeFileSync(join(dir, name), content); };
const isAncestor = (cwd, a, b) => spawnSync('git', ['merge-base', '--is-ancestor', a, b], { cwd }).status === 0;
const FILE = 'scripts/lib/thing.mjs';
const lines = (over = {}) => `${Array.from({ length: 12 }, (_, i) => over[i + 1] ?? `const line${i + 1} = 'original line ${i + 1}';`).join('\n')}\n`;

function fixture() {
  const base = mktemp('we-auto-refresh-');
  const origin = join(base, 'origin.git');
  const clone = join(base, 'clone');
  gitOk(base, ['init', '--bare', '-q', origin]);
  mkdirSync(clone);
  gitOk(clone, ['init', '-q', '-b', 'main']);
  write(clone, FILE, lines());
  gitOk(clone, ['add', '-A']);
  gitOk(clone, ['commit', '-q', '-m', 'init']);
  gitOk(clone, ['remote', 'add', 'origin', origin]);
  gitOk(clone, ['push', '-q', '-u', 'origin', 'main']);
  const author = join(base, 'author');
  gitOk(base, ['clone', '-q', origin, author]);
  const commit = (branch, from, files, msg = branch) => {
    gitOk(author, ['fetch', '-q', 'origin']);
    gitOk(author, ['checkout', '-q', '-B', branch, from]);
    for (const [n, c] of Object.entries(files)) write(author, n, c);
    gitOk(author, ['add', '-A']);
    gitOk(author, ['commit', '-q', '-m', msg]);
    gitOk(author, ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`]);
    return gitOk(author, ['rev-parse', 'HEAD']).trim();
  };
  const env = {
    ...process.env,
    WE_DAEMON_STATE_DIR: mktemp('we-auto-refresh-state-'),
    WE_DAEMON_CLONE_LOCK_ROOT: mktemp('we-auto-refresh-lock-'),
    WE_DAEMON_OVERLAY_DIR: mktemp('we-auto-refresh-overlay-'),
    [AUTO_REFRESH_MODE_ENV]: 'shadow',
  };
  gitOk(clone, ['fetch', '-q', 'origin']);
  return { clone, origin, env, commit };
}

const passSmoke = () => vi.fn(async () => ({ verdict: 'pass', attempts: 1, smoke: { results: [{ name: 'reconcile-dry-run', ok: true, ms: 10 }] } }));
const rebuild = (f, o = {}) => rebuildClone({
  root: f.clone, env: f.env, runSmoke: passSmoke(), prState: async () => 'OPEN', asJob: false, entries: ['fixture-daemon.mjs'], log: { error: () => {} }, ...o,
});
const head = (f) => gitOk(f.clone, ['rev-parse', 'HEAD']).trim();
const show = (f, rev, path) => gitOk(f.clone, ['show', `${rev}:${path}`]);

/** Live shape (#5755 gh-throttle): the overlay's change graduated to main in a commit with different context, and main
 *  then evolved the same line. The overlay also carries a change main never got (line 11). */
async function heldOnGraduation(f, mainEvolution = { 5: "const line5 = 'feature v1 (main evolved it)';" }) {
  f.commit('lane/feat', 'origin/main', { [FILE]: lines({ 5: "const line5 = 'feature v1';", 11: "const line11 = 'overlay only';" }) });
  addOverlay(f.clone, { ref: 'lane/feat' }, { env: f.env });
  const first = await rebuild(f);
  expect(first, JSON.stringify(first.alerts)).toMatchObject({ adopted: true });
  const lastGood = head(f);
  // graduation: same line-5 change, plus a header edit (so its patch-id differs and the overlay is not "in main")
  f.commit('main', 'origin/main', { [FILE]: lines({ 1: "const line1 = 'graduated header';", 5: "const line5 = 'feature v1';" }) }, 'graduate feat');
  const mainSha = f.commit('main', 'origin/main', { [FILE]: lines({ 1: "const line1 = 'graduated header';", ...mainEvolution }) }, 'main evolves');
  return { lastGood, mainSha };
}

describe('xqz26k1 pure hunk rule', () => {
  it('the overlay change already in main\'s hunk (or main\'s history) resolves to main; the mirror to the overlay', () => {
    const base = ['a', 'old line here'];
    const ov = ['a', 'new feature line'];
    const mainEvolved = ['a', 'new feature line, evolved by main'];
    const change = lineChange(base, ov);
    expect(change).toEqual({ removed: ['old line here'], runs: [['new feature line']] });
    expect(carriedBy(change, { base, other: mainEvolved })).toBe(false);
    expect(carriedBy(change, { base, other: mainEvolved, otherHistoryRuns: [['new feature line']] })).toBe(true);
    // a punctuation-only line is never proven by history alone
    expect(carriedBy(lineChange(['x'], ['x', '}']), { base: ['x'], other: ['x'], otherHistoryRuns: [['}']] })).toBe(false);
    const diff3 = ['top', '<<<<<<< overlay', ...ov, '||||||| base', ...base, '=======', ...mainEvolved, '>>>>>>> main', 'end'].join('\n');
    expect(parseDiff3(diff3)).toHaveLength(3);
    expect(resolveFileHunks({ diff3, mainRuns: [['new feature line']] })).toMatchObject({ ok: true, text: ['top', ...mainEvolved, 'end'].join('\n'), hunks: [{ to: 'main' }] });
    // mirror: main's change is held by the overlay, which built on it
    expect(resolveFileHunks({ diff3, overlayRuns: [['new feature line, evolved by main']] })).toMatchObject({ ok: true, hunks: [{ to: 'overlay' }] });
    expect(resolveFileHunks({ diff3 })).toMatchObject({ ok: false, hunks: [{ why: 'neither-side-carries-the-other' }] });
  });

  it('[A3] a hunk whose kept side drops a numeric cap the other carries is never auto-resolved (attempts 1 vs 3)', () => {
    expect(guardDiff(['x = { attempts: 3, runTimeoutMin: 30 }'], ['x = { attempts: 1 }'])).toEqual(['attempts=1']);
    expect(guardDiff(['v => v <= 120000'], ['v => v <= 60000'])).toEqual(['cmp:v => v <= 60000']);
    // whole expressions (never a truncated operand), and == / != are guards too
    expect(guardDiff(['if (attempts < limit * 3) retry();'], ['if (attempts < limit) retry();'])).toEqual(['cmp:if (attempts < limit) retry();']);
    expect(guardDiff(['if (mode) go();'], ["if (mode == 'strict') go();"])).toEqual(["cmp:if (mode == 'strict') go();"]);
    expect(guardDiff(['const f = (x) => x;'], ['const g = (y) => y;'])).toEqual([]); // an arrow is not a comparison
    expect(guardDiff(['  "attempts": 3,'], ['  "attempts": 1,'])).toEqual(['attempts=1']); // JSON settings too
    // a killed merge-file (empty output) is never a resolution
    expect(resolveFileHunks({ diff3: '' })).toMatchObject({ ok: false, hunks: [{ why: 'merge-file-no-conflict-output' }] });
    expect(guardDiff(['`attempts` defaults to 3;'], ['`attempts` defaults to 1 and has a hard upper bound of 1.'])).toContain('doc:attempts=1');
    const base = ['const D = { attempts: 3 };'];
    const ov = ['const D = { attempts: 1 };'];
    const mn = ['const D = { attempts: 3, runTimeoutMin: 30 };'];
    const diff3 = ['<<<<<<< overlay', ...ov, '||||||| base', ...base, '=======', ...mn, '>>>>>>> main'].join('\n');
    // even if main's history once added the overlay's line, taking main would drop attempts: 1
    const r = resolveFileHunks({ diff3, mainRuns: [['const D = { attempts: 1 };']] });
    expect(r.ok).toBe(false);
    expect(r.hunks[0].why).toMatch(/^guard-diff: .*attempts=1/);
    // docs/config never resolve without the per-file patch-id match
    expect(resolveFileHunks({ diff3, docsConfig: true }).hunks[0].why).toBe('docs-config-needs-patch-id-match');
  });

  it('the mode resolves through the cascade: standard off, tool shadow, env wins, invalid ignored', () => {
    const tmp = mktemp('we-auto-refresh-settings-');
    const p = join(tmp, 's.json');
    expect(resolveAutoRefreshMode({}, { settingsPath: p })).toEqual({ mode: 'off', source: 'standard' });
    writeFileSync(p, JSON.stringify({ rebuild: { autoRefresh: { mode: 'shadow' } } }));
    expect(resolveAutoRefreshMode({}, { settingsPath: p })).toEqual({ mode: 'shadow', source: 'tool' });
    expect(resolveAutoRefreshMode({ [AUTO_REFRESH_MODE_ENV]: 'on' }, { settingsPath: p }).mode).toBe('on');
    expect(resolveAutoRefreshMode({ [AUTO_REFRESH_MODE_ENV]: 'yes' }, { settingsPath: p }).mode).toBe('shadow');
    // the repo's own tool layer ships shadow
    expect(resolveAutoRefreshMode({}).mode).toBe('shadow');
  });
});

describe('xqz26k1 — a held clone builds and checks its own refresh candidate', () => {
  it('[A1 shadow] replays the 19:54Z review hold: candidate built clean (main for the graduated hunk), smoked, LOGGED, not adopted', async () => {
    const f = fixture();
    const { lastGood, mainSha } = await heldOnGraduation(f);
    gitOk(f.clone, ['fetch', '-q', 'origin']);
    const smoke = passSmoke();
    const r = await rebuild(f, { runSmoke: smoke });
    expect(r.reason).toBe('established-overlay-conflict');
    expect(head(f)).toBe(lastGood); // shadow: the clone never moves
    expect(r.autoRefresh).toMatchObject({ mode: 'shadow', verdict: 'clean', checkDue: true, check: { verdict: 'would-adopt', smoke: 'pass', tests: 'none' } });
    const cand = r.autoRefresh.candidate;
    expect(isAncestor(f.clone, lastGood, cand) && isAncestor(f.clone, mainSha, cand)).toBe(true);
    const text = show(f, cand, FILE);
    expect(text).toContain("const line5 = 'feature v1 (main evolved it)';"); // main's side of the graduated hunk
    expect(text).toContain("const line11 = 'overlay only';"); // the overlay's own change survives
    expect(text).toContain("const line1 = 'graduated header';");
    expect(text).not.toMatch(/^(<{7}|={7}|>{7})/m);
    expect(smoke).toHaveBeenCalledTimes(1);
    const built = r.alerts.find((a) => a.kind === 'auto-refresh-candidate');
    expect(built.detail.message).toMatch(new RegExp(`auto-refresh candidate ${cand.slice(0, 9)} .*: clean; resolved scripts/lib/thing.mjs→main; tests none; mode shadow — not adopted`));
    expect(readOverlayState(f.clone, { env: f.env }).overlays.map((o) => o.ref)).toEqual(['lane/feat']); // list untouched
    // one check per candidate: the next tick reuses the record and does not smoke again
    const smoke2 = passSmoke();
    const again = await rebuild(f, { runSmoke: smoke2 });
    expect(again.autoRefresh).toMatchObject({ candidate: cand, checkWanted: false, checkDue: false });
    expect(smoke2).not.toHaveBeenCalled();
    expect(again.alerts.some((a) => a.kind === 'auto-refresh-candidate')).toBe(false);
    expect(readAutoRefreshRecord(f.clone, f.env).check).toMatchObject({ status: 'passed' });
  });

  it('[A1 on] adopts: registers the refreshed top, and the next ordinary rebuild adopts a HEAD holding the overlay and main', async () => {
    const f = fixture();
    f.env[AUTO_REFRESH_MODE_ENV] = 'on';
    const { lastGood, mainSha } = await heldOnGraduation(f);
    gitOk(f.clone, ['fetch', '-q', 'origin']);
    const r = await rebuild(f);
    expect(r.autoRefresh.check).toMatchObject({ verdict: 'registered', registered: { ok: true } });
    const ref = r.autoRefresh.check.registered.ref;
    expect(ref).toMatch(/^lane\/auto-refresh-clone-[0-9a-f]{9}$/);
    const entry = readOverlayState(f.clone, { env: f.env }).overlays.find((o) => o.ref === ref);
    expect(entry.reason).toMatch(/^auto-refresh \(xqz26k1\)/);
    const next = await rebuild(f);
    expect(next, JSON.stringify(next.alerts)).toMatchObject({ adopted: true });
    const now = head(f);
    expect(isAncestor(f.clone, lastGood, now) && isAncestor(f.clone, mainSha, now)).toBe(true);
    expect(show(f, now, FILE)).toContain("const line11 = 'overlay only';");
  });

  it('[A2] a conflict main does NOT already carry keeps the hold and names the file; nothing is smoked or registered', async () => {
    const f = fixture();
    f.env[AUTO_REFRESH_MODE_ENV] = 'on';
    f.commit('lane/feat', 'origin/main', { [FILE]: lines({ 5: "const line5 = 'overlay idea';" }) });
    addOverlay(f.clone, { ref: 'lane/feat' }, { env: f.env });
    expect((await rebuild(f)).adopted).toBe(true);
    const lastGood = head(f);
    f.commit('main', 'origin/main', { [FILE]: lines({ 5: "const line5 = 'a different main idea';" }) }, 'main');
    gitOk(f.clone, ['fetch', '-q', 'origin']);
    const smoke = passSmoke();
    const r = await rebuild(f, { runSmoke: smoke });
    expect(r.reason).toBe('established-overlay-conflict');
    expect(r.autoRefresh).toMatchObject({ verdict: 'needs-human', candidate: null, checkWanted: false });
    const built = r.alerts.find((a) => a.kind === 'auto-refresh-candidate');
    expect(built.detail.unresolved).toEqual([{ path: FILE, why: 'neither-side-carries-the-other' }]);
    expect(built.detail.message).toMatch(/needs-human: scripts\/lib\/thing\.mjs \(neither-side-carries-the-other\)/);
    expect(smoke).not.toHaveBeenCalled();
    expect(head(f)).toBe(lastGood);
    expect(readOverlayState(f.clone, { env: f.env }).overlays.map((o) => o.ref)).toEqual(['lane/feat']);
  });

  it('[A3] the attempts<=1 case: main graduated the line but its version drops the overlay cap — stays held', async () => {
    const f = fixture();
    const cap1 = "const D = { attempts: 1, retryBackoffMin: 10 };";
    f.commit('lane/feat', 'origin/main', { [FILE]: lines({ 5: cap1 }) });
    addOverlay(f.clone, { ref: 'lane/feat' }, { env: f.env });
    expect((await rebuild(f)).adopted).toBe(true);
    f.commit('main', 'origin/main', { [FILE]: lines({ 1: "const line1 = 'graduated header';", 5: cap1 }) }, 'graduate');
    f.commit('main', 'origin/main', { [FILE]: lines({ 1: "const line1 = 'graduated header';", 5: "const D = { attempts: 3, retryBackoffMin: 10, runTimeoutMin: 30 };" }) }, 'main');
    gitOk(f.clone, ['fetch', '-q', 'origin']);
    const r = await rebuild(f);
    expect(r.autoRefresh).toMatchObject({ verdict: 'needs-human', candidate: null });
    expect(r.alerts.find((a) => a.kind === 'auto-refresh-candidate').detail.unresolved[0].why).toMatch(/^guard-diff: .*attempts=1/);
  });

  it('an overlay removed from the list voids the recorded candidate; shadow-passed candidates are re-checked once mode is on', async () => {
    const f = fixture();
    await heldOnGraduation(f);
    gitOk(f.clone, ['fetch', '-q', 'origin']);
    const shadow = await rebuild(f);
    expect(shadow.autoRefresh.check.verdict).toBe('would-adopt');
    f.env[AUTO_REFRESH_MODE_ENV] = 'on';
    const smokeOn = passSmoke();
    const on = await rebuild(f, { runSmoke: smokeOn });
    expect(on.autoRefresh).toMatchObject({ checkDue: true, check: { verdict: 'registered' } });
    expect(smokeOn).not.toHaveBeenCalled(); // one smoke per candidate sha: the shadow pass is reused

    const g = fixture();
    await heldOnGraduation(g);
    gitOk(g.clone, ['fetch', '-q', 'origin']);
    expect((await rebuild(g, { entries: undefined })).autoRefresh.verdict).toBe('clean');
    addOverlay(g.clone, { ref: 'lane/feat', pr: 77 }, { env: g.env }); // same branch name, now another PR
    const voided = await rebuild(g);
    expect(voided.autoRefresh).toMatchObject({ verdict: 'needs-human', checkDue: false });
    expect(voided.alerts.find((a) => a.kind === 'auto-refresh-candidate-voided')?.detail.reason).toMatch(/overlay-no-longer-registered: lane\/feat/);
  });

  it('round-2 audit: a guard inherited from the base that main relaxes OUTSIDE the conflict keeps the hold', async () => {
    const f = fixture();
    const CFG = 'scripts/lib/cfg.mjs';
    const cfg = (attempts, tail = 'const tail = 0;') => `export const D = { attempts: ${attempts} };\n\n\n\n\n${tail}\n`;
    f.commit('main', 'origin/main', { [CFG]: cfg(1) }, 'cfg');
    gitOk(f.clone, ['fetch', '-q', 'origin']);
    f.commit('lane/feat', 'origin/main', { [FILE]: lines({ 5: "const line5 = 'feature v1';" }), [CFG]: cfg(1, 'const tail = 7;') });
    addOverlay(f.clone, { ref: 'lane/feat' }, { env: f.env });
    expect((await rebuild(f)).adopted).toBe(true);
    f.commit('main', 'origin/main', { [FILE]: lines({ 1: "const line1 = 'graduated header';", 5: "const line5 = 'feature v1';" }) }, 'graduate');
    f.commit('main', 'origin/main', { [FILE]: lines({ 1: "const line1 = 'graduated header';", 5: "const line5 = 'feature v1 (main evolved it)';" }), [CFG]: cfg(3) }, 'main relaxes');
    gitOk(f.clone, ['fetch', '-q', 'origin']);
    const r = await rebuild(f);
    expect(r.autoRefresh).toMatchObject({ verdict: 'needs-human' });
    const why = r.alerts.find((a) => a.kind === 'auto-refresh-candidate').detail.unresolved;
    expect(why).toEqual([{ path: CFG, why: expect.stringMatching(/^guard-lost: .*attempts=1/) }]);
  });

  it('round-2 audit: tests cover cleanly merged files too, and marker lines brought in by the merge keep the hold', async () => {
    const f = fixture();
    const OTHER = 'scripts/lib/other.mjs';
    const TEST = 'scripts/lib/__tests__/other.test.mjs';
    f.commit('main', 'origin/main', { [TEST]: 'test\n', [OTHER]: 'a\n' }, 'add other');
    gitOk(f.clone, ['fetch', '-q', 'origin']);
    await heldOnGraduation(f);
    f.commit('main', 'origin/main', { [OTHER]: 'a\nb changed by main\n' }, 'main touches other');
    gitOk(f.clone, ['fetch', '-q', 'origin']);
    const r = await rebuild(f, { entries: undefined });
    expect(r.autoRefresh.verdict).toBe('clean');
    expect(r.autoRefresh.tests).toEqual([TEST]);

    const g = fixture();
    await heldOnGraduation(g);
    g.commit('main', 'origin/main', { 'notes.txt': '<<<<<<< ours\nx\n=======\ny\n>>>>>>> theirs\n' }, 'main commits markers');
    gitOk(g.clone, ['fetch', '-q', 'origin']);
    // markers main itself carries are not "added" by the refresh: the candidate holds no more than main
    expect((await rebuild(g, { entries: undefined })).autoRefresh.verdict).toBe('clean');
  });

  it('mode off: the plain x9diisp hold, no candidate', async () => {
    const f = fixture();
    f.env[AUTO_REFRESH_MODE_ENV] = 'off';
    await heldOnGraduation(f);
    gitOk(f.clone, ['fetch', '-q', 'origin']);
    const r = await rebuild(f);
    expect(r.reason).toBe('established-overlay-conflict');
    expect(r.autoRefresh).toBeUndefined();
    expect(readFileSync(join(f.env.WE_DAEMON_STATE_DIR, readdir(f.env.WE_DAEMON_STATE_DIR).find((n) => n.endsWith('.alerts.jsonl'))), 'utf8')).not.toContain('auto-refresh');
  });

  it('a foreground caller without daemon entries builds + logs but never runs the check', async () => {
    const f = fixture();
    await heldOnGraduation(f);
    gitOk(f.clone, ['fetch', '-q', 'origin']);
    const smoke = passSmoke();
    const r = await rebuild(f, { entries: undefined, runSmoke: smoke });
    expect(r.autoRefresh).toMatchObject({ verdict: 'clean', checkWanted: true, checkDue: false });
    expect(smoke).not.toHaveBeenCalled();
  });
});

function readdir(d) { return spawnSync('ls', [d], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean); }
