import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { decideSetLabel, runReviewLabelCli, buildVerdictComment, defaultReadHumanOnlyHold, reassertHumanClearance, isHumanSurfacePark, HUMAN_SURFACE_REPARK_RE, buildMechanicalHandoffMarker, withdrawParkOnLiveClearance } from '../review-set-label.mjs';
import { buildHumanSurfaceReparkComment } from '../conveyor/human-surface-repark.mjs';
import { buildClearedHumanMarker, buildReviewedShaMarker } from '../lib/review-escalation.mjs';
import { renderRedTeamComment } from '../operations/review-extra-seats.mjs';
import { CONFIRMED_BREAKS_DEFAULTS, readRedTeamDisposition, redTeamGateMarker, redTeamRulingNeeded } from '../lib/red-team-gate.mjs';
const head = 'a'.repeat(40);
const labels = ['review:accepted', 'ready-to-merge'];
const clearance = { author: { login: 'chalbert' }, body: `${buildReviewedShaMarker(head)}\n${buildClearedHumanMarker('operator')}` };

describe('clear-human hold decision', () => {
  it('requires a label or proven hold', () => {
    expect(decideSetLabel({ to: 'clear-human', currentLabels: labels }).allowed).toBe(false);
    expect(decideSetLabel({ to: 'clear-human', currentLabels: labels, humanOnlyHold: true })).toMatchObject({ allowed: true, addLabel: 'review:accepted', keepsHuman: false, reason: expect.stringContaining('merge-gate human-only hold at the live head') });
  });
  it('a red-team round-cap ruling is a hold the ceremony clears', () => {
    expect(decideSetLabel({ to: 'clear-human', currentLabels: labels, redTeamRulingHold: true })).toMatchObject({ allowed: true, addLabel: 'review:accepted', reason: expect.stringContaining('red-team round-cap ruling') });
  });
  it.each(['accepted', 'changes'])('does not affect %s', to => {
    const args = { to, currentLabels: labels };
    expect(decideSetLabel({ ...args, humanOnlyHold: true })).toEqual(decideSetLabel(args));
    expect(decideSetLabel({ ...args, redTeamRulingHold: true })).toEqual(decideSetLabel(args));
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
  function run(hold, currentLabels = labels, comments = [], thread = comments) {
    const provider = {
      currentRepo: () => 'o/n', name: 'stub',
      readPrState: () => ({ state: 'OPEN', headRefOid: head, headRefName: 'lane/x', baseRefName: 'release', labels: currentLabels, comments, body: '' }),
      readComments: () => thread,
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
  // PR #5482 red team: RULING NEEDED advertises `--to=clear-human` as the not-real ruling for a red-team break held
  // at the round cap, on an accepted PR that carries no review:human. That command must work and must release it.
  describe('a red-team round-cap ruling on an accepted PR', () => {
    const bot = { author: { login: 'web-everything' } };
    const result = { ...bot, createdAt: '2026-10-18T01:00:00Z', body: renderRedTeamComment({ pr: 7, rev: head, provider: 'codex', model: 'm', recheckStatus: 'ok', foldedVerdict: 'changes',
      findings: [{ summary: 'two writers', category: 'edge-case', impactIfUnfixed: 'broken', file: 'a.mjs', line: 1, confirmedByRecheck: true }] }) };
    const capped = { ...bot, createdAt: '2026-10-18T02:00:00Z', body: redTeamGateMarker(7, head, 'round-cap') };
    const pr = (comments, prLabels = labels) => ({ number: 7, headRefOid: head, labels: prLabels, comments });
    it('clears it through the advertised command, and the posted ruling releases the held break', () => {
      expect(redTeamRulingNeeded(pr([result, capped]))).not.toBeNull();
      const r = run(false, labels, [result, capped]);
      expect(r.exitCode).toBe(0);
      expect(r.provider.setLabels).toHaveBeenCalled();
      const ruling = { author: { login: 'chalbert' }, createdAt: '2026-10-18T03:00:00Z', body: r.provider.postComment.mock.calls[0][2] };
      expect(redTeamRulingNeeded(pr([result, capped, ruling]))).toBeNull();
      expect(readRedTeamDisposition({ comments: [result, capped, ruling], pr: 7, head, setting: CONFIRMED_BREAKS_DEFAULTS }).held).toEqual([]);
    });
    it('reads the complete thread when the first page is full (a round-capped thread is long)', () => {
      const page = Array.from({ length: 100 }, (_, i) => ({ ...bot, body: `round ${i}` }));
      const r = run(false, labels, page, [...page, result, capped]);
      expect(r.exitCode).toBe(0);
      expect(r.provider.postComment).toHaveBeenCalled();
    });
    it('still refuses with no held break, under review:changes, or where no acceptance exists to keep', () => {
      for (const [prLabels, comments] of [[labels, [result]], [labels, [result, { ...capped, author: { login: 'mallory' } }]], [['review:changes'], [result, capped]],
        [['review:pending'], [result, capped]], [[], [result, capped]]]) {
        vi.restoreAllMocks();
        const r = run(false, prLabels, comments);
        expect(r.exitCode).toBe(1);
        expect(r.provider.postComment).not.toHaveBeenCalled();
      }
    });
  });
  it('refuses an absent hold without writing', () => {
    const r = run(false);
    expect(r.exitCode).toBe(1);
    expect(r.payload.error).toContain('nothing to clear');
    expect(r.provider.setLabels).not.toHaveBeenCalled();
    expect(r.provider.postComment).not.toHaveBeenCalled();
  });
  // PR #5273 red team: a human-surface re-park that read before this ceremony lands `review:human` mid-ceremony.
  function race(when, park = ['review:human'], { marked = true, keepAccepted = false } = {}) {
    let live = [...labels];
    let reads = 0;
    let swaps = 0;
    const thread = [];
    const repark = () => {
      // The sweep posts its marked comment, then swaps labels.
      if (marked) thread.push({ author: { login: 'web-everything' }, body: buildHumanSurfaceReparkComment({ headSha: head, hits: [{ file: '.github/workflows/ci.yml', category: 'workflow' }] }) });
      live = [...new Set([...live.filter(l => keepAccepted || l !== 'review:accepted'), ...park])];
    };
    const provider = {
      currentRepo: () => 'o/n', name: 'stub',
      readPrState: () => {
        reads++;
        if (when === 'before-swap' && reads === 2) repark();
        return { state: 'OPEN', headRefOid: head, headRefName: 'lane/x', baseRefName: 'release', labels: [...live], comments: [], body: '' };
      },
      readComments: () => [...thread],
      readLabels: () => [...live],
      setLabels: vi.fn((_r, _n, { add, remove = [] }) => {
        // `inside-swap`: the park lands between the swap's own fresh read and its write.
        if (when === 'inside-swap' && ++swaps === 1) repark();
        live = [...new Set([...live.filter(l => !remove.includes(l)), add])];
      }),
      postComment: vi.fn((_r, _n, body) => { thread.push({ author: { login: 'web-everything' }, body }); if (when === 'during-comment') repark(); }),
    };
    vi.spyOn(process, 'exit').mockImplementation(code => { throw Object.assign(new Error('exit'), { exitCode: code }); });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      runReviewLabelCli({ argv: ['7', '--repo=o/n', '--to=clear-human', '--actor=operator', '--reason=reviewed the workflow'], allowClearHuman: true, defaultActor: 'test', usage: 'test', provider, readHumanOnlyHold: () => true, buildComment: buildVerdictComment, successResult: o => ({ ok: true, ...o }), refusalResult: ({ decision }) => ({ error: decision.reason }), emit: () => {} });
    } catch (e) { if (e.exitCode !== 0) throw e; }
    return live;
  }
  it.each(['before-swap', 'inside-swap', 'during-comment'])('removes a concurrent human-surface re-park landing %s', when => {
    const live = race(when);
    expect(live).toContain('review:accepted');
    expect(live).not.toContain('review:human');
  });
  it('leaves a concurrent review:changes bounce alone', () => {
    expect(race('during-comment', ['review:human', 'review:changes'])).toEqual(expect.arrayContaining(['review:human', 'review:changes']));
  });
  it.each([
    ['an unmarked park', { marked: false }],
    ['an unmarked park that keeps review:accepted (manifest-tamper shape)', { marked: false, keepAccepted: true }],
  ])('leaves %s alone', (_name, opts) => {
    for (const when of ['before-swap', 'during-comment']) expect(race(when, ['review:human'], opts)).toContain('review:human');
  });
  it('recognises exactly the marker the sweep stamps', () => {
    const body = buildHumanSurfaceReparkComment({ headSha: head, hits: [] });
    expect([...body.matchAll(HUMAN_SURFACE_REPARK_RE)].map(m => m[1])).toEqual([head]);
    expect(isHumanSurfacePark({ provider: {}, labels: ['review:human'], headSha: head, comments: [{ author: { login: 'web-everything' }, body }] })).toBe(true);
    expect(isHumanSurfacePark({ provider: {}, labels: ['review:human'], headSha: 'b'.repeat(40), comments: [{ author: { login: 'web-everything' }, body }] })).toBe(false);
    expect(isHumanSurfacePark({ provider: {}, labels: ['review:human'], headSha: head, comments: [{ author: { login: 'outsider' }, body }] })).toBe(false);
    expect(isHumanSurfacePark({ provider: { readComments: () => { throw new Error('offline'); } }, labels: ['review:human'], headSha: head, comments: [{ author: { login: 'web-everything' }, body }] })).toBe(false);
  });
  it('recognises the mechanical-hold hand-off park by its marker', () => {
    const body = `🧑‍⚖️ review — mechanical hold handed to the operator\n\n${buildMechanicalHandoffMarker(head)}`;
    expect(isHumanSurfacePark({ provider: {}, labels: ['review:human'], headSha: head, comments: [{ author: { login: 'web-everything' }, body }] })).toBe(true);
  });
  describe('post-park clearance re-check (the park side of the race)', () => {
    const state = (l, comments = [clearance]) => ({ readPrState: () => ({ headRefOid: head, labels: l, comments }), setLabels: vi.fn() });
    it('withdraws a park that landed after a clearance of this head', () => {
      const p = state(['review:human']);
      expect(withdrawParkOnLiveClearance({ provider: p, repo: 'o/n', pr: 7, headSha: head })).toBe(true);
      expect(p.setLabels).toHaveBeenCalledWith('o/n', 7, { add: 'review:accepted', remove: ['review:human'] });
    });
    it('prefers the complete thread over the state page', () => {
      const p = { ...state(['review:human'], []), readComments: () => [clearance] };
      expect(withdrawParkOnLiveClearance({ provider: p, repo: 'o/n', pr: 7, headSha: head })).toBe(true);
    });
    it.each([
      ['no clearance', state(['review:human'], [])],
      ['a bounce', state(['review:human', 'review:changes'])],
      ['no review:human', state(['review:accepted'])],
      ['a moved head', { readPrState: () => ({ headRefOid: 'b'.repeat(40), labels: ['review:human'], comments: [clearance] }), setLabels: vi.fn() }],
    ])('keeps the hold with %s', (_n, p) => {
      expect(withdrawParkOnLiveClearance({ provider: p, repo: 'o/n', pr: 7, headSha: head })).toBe(false);
      expect(p.setLabels).not.toHaveBeenCalled();
    });
    it('keeps the hold and warns on a failed read', () => {
      const warn = vi.fn();
      const p = { readPrState: () => { throw new Error('offline'); }, setLabels: vi.fn() };
      expect(withdrawParkOnLiveClearance({ provider: p, repo: 'o/n', pr: 7, headSha: head, warn })).toBe(false);
      expect(warn.mock.calls[0][0]).toContain('offline');
    });
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
