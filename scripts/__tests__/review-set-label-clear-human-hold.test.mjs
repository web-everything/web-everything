import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { decideSetLabel, runReviewLabelCli, buildVerdictComment, defaultReadHumanOnlyHold, reassertHumanClearance } from '../review-set-label.mjs';
import { buildClearedHumanMarker, buildReviewedShaMarker } from '../lib/review-escalation.mjs';
const head = 'a'.repeat(40);
const labels = ['review:accepted', 'ready-to-merge'];
const clearance = { author: { login: 'web-everything' }, body: `${buildReviewedShaMarker(head)}\n${buildClearedHumanMarker('operator')}` };

describe('clear-human hold decision', () => {
  it('requires a label or proven hold', () => {
    expect(decideSetLabel({ to: 'clear-human', currentLabels: labels }).allowed).toBe(false);
    expect(decideSetLabel({ to: 'clear-human', currentLabels: labels, humanOnlyHold: true })).toMatchObject({ allowed: true, addLabel: 'review:accepted', keepsHuman: false, reason: expect.stringContaining('merge-gate human-only hold at the live head') });
  });
  it.each(['accepted', 'changes'])('does not affect %s', to => {
    const args = { to, currentLabels: labels };
    expect(decideSetLabel({ ...args, humanOnlyHold: true })).toEqual(decideSetLabel(args));
  });
});
describe('default human-only hold reader', () => {
  const read = (files, extra = {}) => defaultReadHumanOnlyHold({ headSha: head, baseRefName: 'release', comments: [], cwd: '.', exec: (_cmd, args) => args[0] === 'diff' ? files.join('\0') + '\0' : '', ...extra });
  it('detects workflows at the pinned head and base', () => {
    const exec = vi.fn((_cmd, args) => args[0] === 'diff' ? '.github/workflows/ci.yml\0' : '');
    expect(read([], { exec })).toBe(true);
    expect(exec.mock.calls[0][1]).toContain(head);
    expect(exec.mock.calls.at(-1)[1]).toContain(`refs/remotes/origin/release...${head}`);
  });
  it('ignores ordinary files', () => expect(read(['src/a.js'])).toBe(false));
  it('fails closed on fetch failure', () => expect(read([], { exec: () => { throw new Error('offline'); } })).toBe(false));
  it('honors trusted clearance at this head', () => expect(read(['.github/workflows/ci.yml'], { comments: [clearance] })).toBe(false));
});
describe('clear-human CLI hold ceremony', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'human-hold-'));
    const git = (...args) => execFileSync('git', args, { cwd: dir, env: { ...process.env, GIT_DIR: undefined }, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'f'), 'base');
    git('add', 'f');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base', '--no-gpg-sign');
    git('remote', 'add', 'origin', dir);
    vi.stubEnv('GIT_DIR', join(dir, '.git'));
    vi.stubEnv('WE_VERDICT_LEDGER_DIR', join(dir, 'ledger'));
    vi.stubEnv('WE_VERDICT_LEDGER_STORE', '');
    vi.stubEnv('WE_VERDICT_LEDGER_BOARD', '');
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });
  function run(hold, currentLabels = labels) {
    const provider = {
      currentRepo: () => 'o/n', name: 'stub',
      readPrState: () => ({ state: 'OPEN', headRefOid: head, headRefName: 'lane/x', baseRefName: 'release', labels: currentLabels, comments: [], body: '' }),
      readLabels: () => currentLabels, setLabels: vi.fn(), postComment: vi.fn(),
    };
    const readHumanOnlyHold = vi.fn(() => hold);
    const chunks = [];
    vi.spyOn(process, 'exit').mockImplementation(code => { throw Object.assign(new Error('exit'), { exitCode: code }); });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let exitCode = 0;
    try {
      runReviewLabelCli({ argv: ['7', '--repo=o/n', '--to=clear-human', '--actor=operator', '--reason=reviewed the workflow'], allowClearHuman: true, defaultActor: 'test', usage: 'test', provider, readHumanOnlyHold, buildComment: buildVerdictComment, successResult: o => ({ ok: true, ...o }), refusalResult: ({ decision }) => ({ error: decision.reason }), emit: s => chunks.push(s) });
    } catch (e) { if (typeof e.exitCode === 'number') exitCode = e.exitCode; else throw e; }
    return { provider, readHumanOnlyHold, exitCode, payload: JSON.parse(chunks.join('') || '{}') };
  }
  it('records clearance and reviewed SHA at the live head', () => {
    const r = run(true);
    expect(r.exitCode).toBe(0);
    expect(r.provider.setLabels).toHaveBeenCalled();
    const body = r.provider.postComment.mock.calls[0][2];
    expect(body).toContain(buildClearedHumanMarker('operator'));
    expect(body).toContain(buildReviewedShaMarker(head));
    expect(r.readHumanOnlyHold).toHaveBeenCalledWith({ headSha: head, baseRefName: 'release', comments: [] });
  });
  it('refuses an absent hold without writing', () => {
    const r = run(false);
    expect(r.exitCode).toBe(1);
    expect(r.payload.error).toContain('nothing to clear');
    expect(r.provider.setLabels).not.toHaveBeenCalled();
    expect(r.provider.postComment).not.toHaveBeenCalled();
  });
  // PR #5273 red team: a human-surface re-park that read before this ceremony lands `review:human` mid-ceremony.
  function race(when, park = ['review:human']) {
    let live = [...labels];
    let reads = 0;
    const repark = () => { live = [...live.filter(l => l !== 'review:accepted'), ...park]; };
    const provider = {
      currentRepo: () => 'o/n', name: 'stub',
      readPrState: () => {
        reads++;
        if (when === 'before-swap' && reads === 2) repark();
        return { state: 'OPEN', headRefOid: head, headRefName: 'lane/x', baseRefName: 'release', labels: [...live], comments: [], body: '' };
      },
      readLabels: () => [...live],
      setLabels: vi.fn((_r, _n, { add, remove = [] }) => { live = [...new Set([...live.filter(l => !remove.includes(l)), add])]; }),
      postComment: vi.fn(() => { if (when === 'during-comment') repark(); }),
    };
    vi.spyOn(process, 'exit').mockImplementation(code => { throw Object.assign(new Error('exit'), { exitCode: code }); });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      runReviewLabelCli({ argv: ['7', '--repo=o/n', '--to=clear-human', '--actor=operator', '--reason=reviewed the workflow'], allowClearHuman: true, defaultActor: 'test', usage: 'test', provider, readHumanOnlyHold: () => true, buildComment: buildVerdictComment, successResult: o => ({ ok: true, ...o }), refusalResult: ({ decision }) => ({ error: decision.reason }), emit: () => {} });
    } catch (e) { if (e.exitCode !== 0) throw e; }
    return live;
  }
  it.each(['before-swap', 'during-comment'])('removes a concurrent re-park landing %s', when => {
    const live = race(when);
    expect(live).toContain('review:accepted');
    expect(live).not.toContain('review:human');
  });
  it('leaves a concurrent review:changes bounce alone', () => {
    expect(race('during-comment', ['review:human', 'review:changes'])).toEqual(expect.arrayContaining(['review:human', 'review:changes']));
  });
  it('reports, without failing, an unreadable post-clearance state', () => {
    const warn = vi.fn();
    const provider = { readPrState: () => { throw new Error('offline'); }, setLabels: vi.fn() };
    expect(reassertHumanClearance({ provider, repo: 'o/n', pr: 7, headSha: head, warn })).toEqual({ reapplied: false, error: true });
    expect(warn.mock.calls[0][0]).toContain('offline');
    expect(provider.setLabels).not.toHaveBeenCalled();
  });
  it('does not re-apply at a moved head', () => {
    const provider = { readPrState: () => ({ headRefOid: 'b'.repeat(40), labels: ['review:human'] }), setLabels: vi.fn() };
    expect(reassertHumanClearance({ provider, repo: 'o/n', pr: 7, headSha: head })).toEqual({ reapplied: false });
    expect(provider.setLabels).not.toHaveBeenCalled();
  });
  it('does not read a hold when review:human is present', () => {
    const r = run(false, ['review:human']);
    expect(r.exitCode).toBe(0);
    expect(r.readHumanOnlyHold).not.toHaveBeenCalled();
  });
});
