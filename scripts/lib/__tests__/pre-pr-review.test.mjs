/**
 * @file pre-pr-review.test.mjs — the pre-PR review gate (perf sweep card 2): risk rule, knob, receipt, and the
 * open-pr runner refusing a risky head without a receipt. Real git sandboxes; no gh, no network.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyPrRisk, decidePrePrReview, resolvePrePrSettings, loadPrePrSettings, checkPrePrReview, isPreparedCard,
  buildReceipt, gitDirOf, treeOf, workingTreeOf, readDiffFiles, codeSpan, renderBypassNote, RECEIPT_FILE, BUILT_IN_PRE_PR_SETTINGS,
} from '../pre-pr-review.mjs';
import { createPrLandRunner } from '../../operations/open-pr-io.mjs';
import { planOpen } from '../../operations/open-pr.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = join(ROOT, 'scripts', 'converge-cli.mjs');
const S = BUILT_IN_PRE_PR_SETTINGS;
const f = (path, n = 10) => ({ path, additions: n, deletions: 0 });

describe('risk rule', () => {
  it('card-only PRs are never gated, whatever the builder', () => {
    const r = classifyPrRisk({ files: [f('backlog/1.md', 900), f('backlog/2.md')], hasPreparedCard: false, operatorAgent: true });
    expect(r).toMatchObject({ gated: false, cardOnly: true });
  });
  it('a small prepared conveyor code PR is low risk', () => {
    const r = classifyPrRisk({ files: [f('scripts/a.mjs'), f('scripts/__tests__/a.test.mjs')], hasPreparedCard: true, operatorAgent: false });
    expect(r.gated).toBe(false);
  });
  it.each([
    ['lines > 264', { files: [f('scripts/a.mjs', 265)], hasPreparedCard: true, operatorAgent: false }, /265 lines/],
    ['subsystems > 2', { files: [f('scripts/a/x.mjs'), f('docs/b/y.md'), f('skills-src/c/z.md')], hasPreparedCard: true, operatorAgent: false }, /3 subsystems/],
    ['files > 5', { files: ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => f(`scripts/${n}.mjs`)), hasPreparedCard: true, operatorAgent: false }, /6 files/],
    ['no prepared card', { files: [f('scripts/a.mjs')], hasPreparedCard: false, operatorAgent: false }, /no prepared card/],
    ['operator agent', { files: [f('scripts/a.mjs')], hasPreparedCard: true, operatorAgent: true }, /operator agent/],
  ])('gates on %s', (_n, input, re) => {
    const r = classifyPrRisk(input);
    expect(r.gated).toBe(true);
    expect(r.reasons.join(' ')).toMatch(re);
  });
  it('264 lines exactly is NOT over the line threshold', () => {
    expect(classifyPrRisk({ files: [f('scripts/a.mjs', 264)], hasPreparedCard: true, operatorAgent: false }).gated).toBe(false);
  });
  it('isPreparedCard rejects a preparedDate outside the leading frontmatter block', () => {
    const unprepared = '---\nstatus: open\n---\n\n# Title\n\n```yaml\npreparedDate: 2026-10-01\n```\n';
    expect(isPreparedCard(unprepared)).toBe(false);
    expect(isPreparedCard('# No frontmatter\npreparedDate: 2026-10-01\n')).toBe(false);
    expect(isPreparedCard('preparedDate: 2026-10-01\n---\nstatus: open\n---\n')).toBe(false); // the block must OPEN the file
    expect(isPreparedCard('---\nstatus: open\npreparedDate: 2026-10-01\n---\nbody\n')).toBe(true);
    expect(isPreparedCard('---\r\nstatus: open\r\npreparedDate: 2026-10-01\r\n---\r\nbody\r\n')).toBe(true);
    expect(isPreparedCard('---\nstatus: open\n')).toBe(false); // an unterminated block is not frontmatter
  });
  it('isPreparedCard reads preparedDate', () => {
    expect(isPreparedCard('---\npreparedDate: "2026-06-12"\n---')).toBe(true);
    expect(isPreparedCard('---\nstatus: open\n---')).toBe(false);
  });
});

describe('knob and decision', () => {
  const risky = { gated: true, cardOnly: false, reasons: ['300 lines changed (> 264)'] };
  it('product default is advise; this repo ships enforce; bad values are ignored', () => {
    expect(BUILT_IN_PRE_PR_SETTINGS.mode).toBe('advise');
    expect(loadPrePrSettings().settings.mode).toBe('enforce');
    expect(loadPrePrSettings({ path: '/nonexistent' }).settings.mode).toBe('enforce'); // a missing file fails closed
    const r = resolvePrePrSettings({ mode: 'sometimes', maxLines: -1 });
    expect(r.settings.mode).toBe('advise');
    expect(r.ignored).toEqual(['mode', 'maxLines']);
  });
  it('a missing, unreadable or broken settings file fails CLOSED to enforce and says why', () => {
    const enoent = Object.assign(new Error('nope'), { code: 'ENOENT' });
    const eacces = Object.assign(new Error('denied'), { code: 'EACCES' });
    const load = (read) => loadPrePrSettings({ path: '/x.json', read });
    // the file ships with the repo, so a missing one is a broken install — never a silent downgrade to advise
    expect(load(() => { throw enoent; })).toMatchObject({ settings: { mode: 'enforce' }, error: expect.stringMatching(/missing.*failing closed to enforce/) });
    expect(load(() => '{ "mode": "enforce", ')).toMatchObject({ settings: { mode: 'enforce' }, error: expect.stringMatching(/not valid JSON/) });
    expect(load(() => { throw eacces; })).toMatchObject({ settings: { mode: 'enforce' }, error: expect.stringMatching(/unreadable/) });
    expect(load(() => '{"mode":"enforse"}')).toMatchObject({ settings: { mode: 'enforce' }, error: expect.stringMatching(/no valid `mode` \(got "enforse"/) });
    expect(load(() => 'null')).toMatchObject({ settings: { mode: 'enforce' }, error: expect.stringMatching(/not a JSON object/) });
    expect(load(() => '[]')).toMatchObject({ settings: { mode: 'enforce' } });
    // a present file must name a valid `mode` and only understood keys/values: these lenient reads were fail-open
    expect(load(() => '{}')).toMatchObject({ settings: { mode: 'enforce' }, error: expect.stringMatching(/no valid `mode`/) });
    expect(load(() => '{"prePrReview":{"mode":"off"}}')).toMatchObject({ settings: { mode: 'enforce' } });
    expect(load(() => '{"Mode":"off"}')).toMatchObject({ settings: { mode: 'enforce' } });
    expect(load(() => '{"mode":"advise","maxLines":"264"}')).toMatchObject({ settings: { mode: 'enforce' }, error: expect.stringMatching(/maxLines/) });
    expect(load(() => '{"mode":"advise","maxFile":5}')).toMatchObject({ settings: { mode: 'enforce' }, error: expect.stringMatching(/maxFile/) });
    expect(load(() => '{"mode":"advise","maxLines":100}')).toMatchObject({ settings: { mode: 'advise', maxLines: 100 }, error: '' });
    expect(load(() => '{"mode":"off"}')).toMatchObject({ settings: { mode: 'off' }, error: '' }); // a deliberate off still works
  });
  it('enforce refuses a risky head with no receipt, with a clear message', () => {
    const d = decidePrePrReview({ settings: { ...S, mode: 'enforce' }, risk: risky, receipt: null, headTree: 't1' });
    expect(d.action).toBe('refuse');
    expect(d.message).toMatch(/pre-PR review required.*converge-cli\.mjs receipt.*--skipPrePrReview/s);
  });
  it('a receipt for another tree is stale and refused', () => {
    const d = decidePrePrReview({ settings: { ...S, mode: 'enforce' }, risk: risky, receipt: { tree: 't0', verdict: 'land' }, headTree: 't1' });
    expect(d).toMatchObject({ action: 'refuse', why: 'receipt-stale' });
  });
  it('a receipt for the head tree admits; advise warns; off ignores; bypass needs a reason', () => {
    const e = { ...S, mode: 'enforce' };
    expect(decidePrePrReview({ settings: e, risk: risky, receipt: { tree: 't1', base: 'b1', verdict: 'land' }, headTree: 't1', baseSha: 'b1' }).action).toBe('pass');
    expect(decidePrePrReview({ settings: { ...S, mode: 'advise' }, risk: risky, receipt: null, headTree: 't1' }).action).toBe('advise');
    expect(decidePrePrReview({ settings: { ...S, mode: 'off' }, risk: risky, receipt: null, headTree: 't1' }).action).toBe('pass');
    expect(decidePrePrReview({ settings: e, risk: risky, receipt: null, headTree: 't1', skip: '   ' }).action).toBe('refuse');
    expect(decidePrePrReview({ settings: e, risk: risky, receipt: null, headTree: 't1', skip: 'hotfix' }).why).toBe('bypass');
  });
  it('a rename carries its source path: moving code under backlog/ is NOT card-only, and both ends count as subsystems', () => {
    const moved = classifyPrRisk({ files: [{ path: 'backlog/gate.md', from: 'scripts/gate.mjs', additions: 0, deletions: 0 }], hasPreparedCard: true, operatorAgent: false });
    expect(moved).toMatchObject({ gated: false, cardOnly: false, subsystems: 2 });
    const noCard = classifyPrRisk({ files: [{ path: 'backlog/gate.md', from: 'scripts/gate.mjs' }], hasPreparedCard: false, operatorAgent: false });
    expect(noCard).toMatchObject({ gated: true, cardOnly: false });
    const three = classifyPrRisk({ files: [{ path: 'backlog/a.md', from: 'scripts/a/x.mjs' }, f('docs/b/y.md')], hasPreparedCard: true, operatorAgent: false });
    expect(three.subsystems).toBe(3);
    expect(three.reasons.join(' ')).toMatch(/3 subsystems/);
    // a card renamed to a card is still card-only
    expect(classifyPrRisk({ files: [{ path: 'backlog/b.md', from: 'backlog/a.md' }] }).cardOnly).toBe(true);
  });
  it('card-only and low-risk pass untouched', () => {
    const e = { ...S, mode: 'enforce' };
    expect(decidePrePrReview({ settings: e, risk: { gated: false, cardOnly: true }, headTree: 't' }).why).toBe('card-only');
    expect(decidePrePrReview({ settings: e, risk: { gated: false, cardOnly: false }, headTree: 't' }).why).toBe('low-risk');
  });
});

describe('lane sandbox: checkPrePrReview + open-pr runner', () => {
  let dir;
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  const commit = (files) => {
    for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), c); }
    git('add', '-A'); git('-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'x');
  };
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'pre-pr-')));
    git('init', '-q', '-b', 'main'); commit({ 'README.md': 'x\n' });
    git('checkout', '-q', '-b', 'lane/x');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const enforce = { ...S, mode: 'enforce' };
  const OPERATOR = { PATH: process.env.PATH }; // no WE_CONVEYOR_WORKER => operator agent

  it('a risky code PR is refused without a receipt and admitted with one for the head tree', () => {
    commit({ 'scripts/big.mjs': 'x\n'.repeat(400) });
    const no = checkPrePrReview({ cwd: dir, env: OPERATOR, settings: enforce });
    expect(no.action).toBe('refuse');
    writeFileSync(join(gitDirOf(dir), RECEIPT_FILE), JSON.stringify(buildReceipt({ tree: treeOf(dir), head: 'h', envelope: {}, base: git('merge-base', 'main', 'HEAD').trim() })));
    expect(checkPrePrReview({ cwd: dir, env: OPERATOR, settings: enforce })).toMatchObject({ action: 'pass', why: 'receipt' });
    commit({ 'scripts/more.mjs': 'y\n' }); // a new head tree invalidates the receipt
    expect(checkPrePrReview({ cwd: dir, env: OPERATOR, settings: enforce }).why).toBe('receipt-stale');
  });
  it('a card-only PR passes untouched, no receipt', () => {
    commit({ 'backlog/9.md': '---\nstatus: open\n---\n'.repeat(50) });
    expect(checkPrePrReview({ cwd: dir, env: OPERATOR, settings: enforce })).toMatchObject({ action: 'pass', why: 'card-only' });
  });
  it('a small prepared conveyor-worker PR is unaffected', () => {
    commit({ 'backlog/9.md': '---\npreparedDate: "2026-10-01"\n---\n', 'scripts/a.mjs': 'x\n' });
    const r = checkPrePrReview({ cwd: dir, env: { WE_CONVEYOR_WORKER: '1' }, settings: enforce });
    expect(r).toMatchObject({ action: 'pass', why: 'low-risk' });
  });
  it('the open-pr runner refuses before spawning pr-land, and a recorded bypass admits', () => {
    commit({ 'scripts/big.mjs': 'x\n'.repeat(400) });
    process.env.WE_PRE_PR_BYPASS_DIR = join(dir, 'bypass-records');
    const spawned = [];
    let sentBody = ''; // the temp body copy is removed once the spawn returns, so read it inside the spawn
    const spawn = (...a) => {
      spawned.push(a);
      const bf = a[1].find((x) => x.startsWith('--body-file='));
      if (bf) sentBody = readFileSync(bf.slice(12), 'utf8');
      return { status: 0, stdout: '{"pr":1,"url":"u"}\n', stderr: '' };
    };
    const run = createPrLandRunner({ spawn, cwd: dir, env: OPERATOR });
    const argv = ['--ref=lane/x', '--base=main', '--body-file=/tmp/b.md', '--label-on-green'];
    const out = run({ argv });
    expect(out).toMatchObject({ outcome: 'refused', reason: 'pre-pr-review-missing' });
    expect(spawned).toHaveLength(0);
    // worker bypass is refused, even with an actor and an instruction
    const w = createPrLandRunner({ spawn, cwd: dir, env: { WE_CONVEYOR_WORKER: '1' } });
    expect(w({ argv, skipPrePrReview: 'x', actor: 'nic', operatorInstruction: 'ok it' })).toMatchObject({ outcome: 'refused', reason: 'pre-pr-review-missing' });
    // an interactive bypass with no operator instruction is refused
    expect(run({ argv, skipPrePrReview: 'emergency hotfix' })).toMatchObject({ outcome: 'refused' });
    expect(run({ argv, skipPrePrReview: 'emergency hotfix', actor: 'nic' })).toMatchObject({ outcome: 'refused' });
    expect(spawned).toHaveLength(0);
    const body = join(dir, 'b.md'); writeFileSync(body, 'body\n');
    const argv2 = ['--ref=lane/x', '--base=main', `--body-file=${body}`, '--label-on-green'];
    const ok = run({ argv: argv2, skipPrePrReview: 'emergency hotfix', actor: 'nic', operatorInstruction: 'operator said: ship the hotfix' });
    expect(ok.outcome).toBe('opened');
    expect(sentBody).toMatch(/bypassed.*nic.*ship the hotfix/s);
    expect(readFileSync(join(gitDirOf(dir), 'pre-pr-review-bypass.log'), 'utf8')).toMatch(/ship the hotfix/);
    expect(readdirSync(join(dir, 'bypass-records'))).toHaveLength(1);
    delete process.env.WE_PRE_PR_BYPASS_DIR;
    expect(spawned).toHaveLength(1);
    expect(spawned[0][1].join(' ')).not.toMatch(/skipPrePrReview/);
    expect(spawned[0][1].join(' ')).not.toMatch(/skipPrePrReview|operatorInstruction/);
    expect(readFileSync(join(gitDirOf(dir), 'pre-pr-review-bypass.log'), 'utf8')).toMatch(/emergency hotfix/);
  });
});

describe('gate hardening (PR #4271 review)', () => {
  let dir; let tmpBefore;
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
  const commit = (files) => {
    for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), c); }
    git('add', '-A'); git('-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'x');
  };
  const bypassTmp = () => readdirSync(tmpdir()).filter((n) => n.startsWith('open-pr-bypass-'));
  const OPERATOR = { PATH: process.env.PATH };
  const enforceSettings = () => ({ settings: { ...S, mode: 'enforce' }, error: '' });
  const okSpawn = (spawned) => (...a) => { spawned.push(a); return { status: 0, stdout: '{"pr":1,"url":"u"}\n', stderr: '' }; };
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'pre-pr-h-')));
    git('init', '-q', '-b', 'main'); commit({ 'README.md': 'x\n' });
    git('checkout', '-q', '-b', 'lane/x');
    tmpBefore = new Set(bypassTmp());
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.WE_PRE_PR_BYPASS_DIR; });

  describe('fail closed', () => {
    it('refuses before spawning pr-land when the enforced pre-review check throws', () => {
      const spawned = [];
      const run = createPrLandRunner({ prePrReview: () => { throw new Error('boom'); }, loadSettings: enforceSettings, spawn: okSpawn(spawned), cwd: dir, env: OPERATOR });
      expect(run({ argv: ['--ref=lane/x', '--base=main'] })).toMatchObject({ outcome: 'refused', reason: 'pre-pr-review-error', detail: expect.stringMatching(/boom.*fail closed/s) });
      expect(spawned).toHaveLength(0);
    });
    it('refuses before spawning pr-land when the check returns no usable decision (null, {}, an unknown action)', () => {
      for (const result of [null, undefined, {}, { action: 'bogus' }, { action: 'PASS' }]) {
        const spawned = [];
        const run = createPrLandRunner({ prePrReview: () => result, loadSettings: enforceSettings, spawn: okSpawn(spawned), cwd: dir, env: OPERATOR });
        expect(run({ argv: ['--ref=lane/x', '--base=main'] }), JSON.stringify(result)).toMatchObject({ outcome: 'refused', reason: 'pre-pr-review-error' });
        expect(spawned).toHaveLength(0);
      }
    });
    it('refuses (never throws, never spawns) when even the settings read on the failure path throws', () => {
      const spawned = [];
      const run = createPrLandRunner({
        prePrReview: () => { throw new Error('boom'); }, loadSettings: () => { throw new Error('settings exploded'); },
        spawn: okSpawn(spawned), cwd: dir, env: OPERATOR,
      });
      expect(run({ argv: ['--ref=lane/x', '--base=main'] })).toMatchObject({ outcome: 'refused', reason: 'pre-pr-review-error', detail: expect.stringMatching(/boom.*settings exploded/s) });
      expect(spawned).toHaveLength(0);
    });
    it('refuses a thrown check when the mode on the failure path is anything but advise/off (unknown means enforce)', () => {
      for (const loadSettings of [() => ({ settings: {} }), () => ({ settings: { mode: 'enforse' } }), () => ({})]) {
        const spawned = [];
        const run = createPrLandRunner({ prePrReview: () => { throw new Error('boom'); }, loadSettings, spawn: okSpawn(spawned), cwd: dir, env: OPERATOR });
        expect(run({ argv: ['--ref=lane/x', '--base=main'] })).toMatchObject({ outcome: 'refused', reason: 'pre-pr-review-error' });
        expect(spawned).toHaveLength(0);
      }
    });
    it('under advise/off a thrown check proceeds, loudly', () => {
      const spawned = [];
      const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        for (const mode of ['advise', 'off']) {
          const run = createPrLandRunner({ prePrReview: () => { throw new Error('boom'); }, loadSettings: () => ({ settings: { ...S, mode }, error: '' }), spawn: okSpawn(spawned), cwd: dir, env: OPERATOR });
          expect(run({ argv: ['--ref=lane/x'] }).outcome).toBe('opened');
        }
        expect(err.mock.calls.map((c) => c[0]).join('')).toMatch(/advisory — the pre-PR review check itself failed \(`` boom ``\)/);
      } finally { err.mockRestore(); }
      expect(spawned).toHaveLength(2);
    });
    it('a REAL check error (unresolvable --base) refuses under the repo\'s enforce setting', () => {
      commit({ 'scripts/big.mjs': 'x\n'.repeat(400) });
      const spawned = [];
      const run = createPrLandRunner({ spawn: okSpawn(spawned), cwd: dir, env: OPERATOR });
      expect(run({ argv: ['--ref=lane/x', '--base=no-such-base'] })).toMatchObject({ outcome: 'refused', reason: 'pre-pr-review-error' });
      expect(spawned).toHaveLength(0);
    });
    it('a settings file that cannot be trusted warns on stderr (the gate result carries settingsError)', () => {
      const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const run = createPrLandRunner({ prePrReview: () => ({ action: 'pass', why: 'x', settingsError: 'settings broken' }), spawn: okSpawn([]), cwd: dir, env: OPERATOR });
        run({ argv: ['--ref=lane/x'] });
        expect(err.mock.calls.map((c) => c[0]).join('')).toMatch(/WARNING — settings broken/);
      } finally { err.mockRestore(); }
    });
    it('a bypass whose audit log cannot be written is refused, not admitted', () => {
      commit({ 'scripts/big.mjs': 'x\n'.repeat(400) });
      mkdirSync(join(gitDirOf(dir), 'pre-pr-review-bypass.log')); // appendFileSync -> EISDIR
      const spawned = [];
      const run = createPrLandRunner({ loadSettings: enforceSettings, spawn: okSpawn(spawned), cwd: dir, env: OPERATOR });
      const body = join(dir, 'b.md'); writeFileSync(body, 'body\n');
      expect(run({ argv: ['--ref=lane/x', '--base=main', `--body-file=${body}`], skipPrePrReview: 'hotfix', actor: 'nic', operatorInstruction: 'ship it' }))
        .toMatchObject({ outcome: 'refused', reason: 'pre-pr-review-error' });
      expect(spawned).toHaveLength(0);
    });
  });

  it('refuses when the daily bypass audit cannot be written, even though the per-checkout log can', () => {
    commit({ 'scripts/big.mjs': 'x\n'.repeat(400) });
    const blocker = join(dir, 'not-a-dir'); writeFileSync(blocker, 'a file where the audit directory should go\n');
    process.env.WE_PRE_PR_BYPASS_DIR = join(blocker, 'records'); // mkdir -> ENOTDIR
    const spawned = [];
    const run = createPrLandRunner({ loadSettings: enforceSettings, spawn: okSpawn(spawned), cwd: dir, env: OPERATOR });
    const body = join(dir, 'b.md'); writeFileSync(body, 'body\n');
    expect(run({ argv: ['--ref=lane/x', '--base=main', `--body-file=${body}`], skipPrePrReview: 'hotfix', actor: 'nic', operatorInstruction: 'ship it' }))
      .toMatchObject({ outcome: 'refused', reason: 'pre-pr-review-error' });
    expect(spawned).toHaveLength(0);
  });

  it('a --dry-run is never gated: a refusing or throwing check is not consulted and pr-land is still spawned', () => {
    for (const prePrReview of [() => { throw new Error('must not run'); }, () => ({ action: 'refuse', reason: 'pre-pr-review-missing', message: 'no' })]) {
      const spawned = [];
      const run = createPrLandRunner({ prePrReview, loadSettings: enforceSettings, spawn: okSpawn(spawned), cwd: dir, env: OPERATOR });
      expect(run({ argv: ['--ref=lane/x', '--dry-run'] })).toMatchObject({ outcome: 'opened' });
      expect(spawned).toHaveLength(1);
    }
  });

  describe('gate and push are bound to one commit', () => {
    it('judges --sha, not the checkout HEAD: an explicit risky sha is refused while HEAD is on main', () => {
      commit({ 'scripts/big.mjs': 'x\n'.repeat(400) });
      const risky = git('rev-parse', 'HEAD');
      git('checkout', '-q', 'main');
      const r = checkPrePrReview({ cwd: dir, sha: risky, env: OPERATOR, settings: { ...S, mode: 'enforce' } });
      expect(r).toMatchObject({ action: 'refuse', sha: risky });
      expect(r.risk.lines).toBeGreaterThan(264);
    });
    it('pins --sha to the judged commit in the argv pr-land receives (HEAD is resolved once)', () => {
      commit({ 'scripts/big.mjs': 'x\n'.repeat(400) });
      const head = git('rev-parse', 'HEAD');
      writeFileSync(join(gitDirOf(dir), RECEIPT_FILE), JSON.stringify(buildReceipt({ tree: treeOf(dir), head, envelope: {}, base: git('merge-base', 'main', 'HEAD') })));
      const spawned = [];
      const run = createPrLandRunner({ loadSettings: enforceSettings, spawn: okSpawn(spawned), cwd: dir, env: OPERATOR });
      expect(run({ argv: ['--ref=lane/x', '--base=main'] }).outcome).toBe('opened');
      expect(spawned[0][1].filter((a) => a.startsWith('--sha='))).toEqual([`--sha=${head}`]);
      // an explicit short/symbolic --sha is replaced by the full judged commit, never passed twice
      spawned.length = 0;
      run({ argv: ['--ref=lane/x', '--base=main', '--sha=lane/x'] });
      expect(spawned[0][1].filter((a) => a.startsWith('--sha='))).toEqual([`--sha=${head}`]);
    });
    it('an unresolvable --sha is a check error and refuses under enforce', () => {
      const run = createPrLandRunner({ loadSettings: enforceSettings, spawn: okSpawn([]), cwd: dir, env: OPERATOR });
      expect(run({ argv: ['--ref=lane/x', '--base=main', '--sha=deadbeef'] })).toMatchObject({ outcome: 'refused', reason: 'pre-pr-review-error' });
    });
  });

  describe('renames', () => {
    it('readDiffFiles reports a rename with its source, so a code file moved into backlog/ is not card-only', () => {
      git('checkout', '-q', 'main'); commit({ 'scripts/gate.mjs': 'export const gate = 1;\n'.repeat(5) });
      git('checkout', '-q', 'lane/x'); git('merge', '-q', '--ff-only', 'main');
      mkdirSync(join(dir, 'backlog')); git('mv', 'scripts/gate.mjs', 'backlog/gate.md');
      git('-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'move');
      const { files } = readDiffFiles({ cwd: dir, base: 'main' });
      expect(files).toEqual([expect.objectContaining({ path: 'backlog/gate.md', from: 'scripts/gate.mjs' })]);
      expect(classifyPrRisk({ files, hasPreparedCard: false, operatorAgent: false })).toMatchObject({ cardOnly: false, gated: true });
    });
    it('a plain deletion of code is not card-only either', () => {
      git('checkout', '-q', 'main'); commit({ 'scripts/gate.mjs': 'export const gate = 1;\n' });
      git('checkout', '-q', 'lane/x'); git('merge', '-q', '--ff-only', 'main');
      git('rm', '-q', 'scripts/gate.mjs'); git('-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'rm');
      const { files } = readDiffFiles({ cwd: dir, base: 'main' });
      expect(files).toEqual([expect.objectContaining({ path: 'scripts/gate.mjs', deletions: 1 })]);
      expect(classifyPrRisk({ files, hasPreparedCard: true }).cardOnly).toBe(false);
    });
  });

  describe('bypass record in the PR body', () => {
    it('renders every dynamic part as a single-line code span (newline, CR, U+2028, backtick, NFKC look-alikes)', () => {
      const evil = 'line1\n# Forged heading\r\n- [x] approved by @owner\u2028<!-- hide --> `` `rm` ｀';
      const note = renderBypassNote({ actor: 'nic\n## admin', reason: evil, operatorInstruction: evil });
      const lines = note.trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(note).not.toMatch(/[\r\p{Zl}\p{Zp}]/u);
      // the only backticks are the span delimiters: 3 spans x 2 delimiters of two backticks
      expect((note.match(/`/g) || []).length).toBe(12);
      expect(codeSpan('a`b')).toBe("`` a'b ``");
      // invisible/format characters (bidi override, zero-width) and a lone surrogate left by the length cut
      expect(codeSpan('x\u202Ey\u200Bz')).toBe('`` x y z ``');
      expect(codeSpan('ab\u{1F600}', 3)).toBe('`` ab ``');
      expect(codeSpan('x'.repeat(5000), 10)).toBe(`\`\` ${'x'.repeat(10)} \`\``);
    });
    it('records the bypass in a copy of the body, never edits the original, and removes the temp copy', () => {
      commit({ 'scripts/big.mjs': 'x\n'.repeat(400) });
      process.env.WE_PRE_PR_BYPASS_DIR = join(dir, 'records');
      const body = join(dir, 'b.md'); writeFileSync(body, 'body\n');
      const spawned = []; let sentBody = '';
      const spawn = (...a) => { spawned.push(a); sentBody = readFileSync(a[1].find((x) => x.startsWith('--body-file=')).slice(12), 'utf8'); return { status: 0, stdout: '{"pr":1}\n' }; };
      const run = createPrLandRunner({ loadSettings: enforceSettings, spawn, cwd: dir, env: OPERATOR });
      const out = run({ argv: ['--ref=lane/x', '--base=main', `--body-file=${body}`], skipPrePrReview: 'hotfix', actor: 'nic', operatorInstruction: 'ship it\n# forged' });
      expect(out.outcome).toBe('opened');
      expect(sentBody).toMatch(/^body\n\n\n\*\*Pre-PR review bypassed\*\* by `` nic `` — reason: `` hotfix ``\. Operator instruction: `` ship it # forged ``\n$/);
      expect(readFileSync(body, 'utf8')).toBe('body\n');
      expect(bypassTmp().filter((n) => !tmpBefore.has(n))).toEqual([]);
    });
    it('refuses (and spawns nothing, leaks nothing) when the body note cannot be written', () => {
      commit({ 'scripts/big.mjs': 'x\n'.repeat(400) });
      process.env.WE_PRE_PR_BYPASS_DIR = join(dir, 'records');
      const spawned = [];
      const run = createPrLandRunner({ loadSettings: enforceSettings, spawn: okSpawn(spawned), cwd: dir, env: OPERATOR });
      const bypass = { skipPrePrReview: 'hotfix', actor: 'nic', operatorInstruction: 'ship it' };
      expect(run({ argv: ['--ref=lane/x', '--base=main', `--body-file=${join(dir, 'missing.md')}`], ...bypass })).toMatchObject({ outcome: 'refused', reason: 'pre-pr-review-bypass-unrecorded' });
      expect(run({ argv: ['--ref=lane/x', '--base=main'], ...bypass })).toMatchObject({ outcome: 'refused', reason: 'pre-pr-review-bypass-unrecorded', detail: expect.stringMatching(/no --body-file/) });
      expect(spawned).toHaveLength(0);
      expect(bypassTmp().filter((n) => !tmpBefore.has(n))).toEqual([]);
    });
  });
});

describe('open-pr plan', () => {
  it('carries the bypass reason in the plan and keeps it out of the pr-land argv', () => {
    const p = planOpen({ ref: 'lane/x', base: 'main', bodyFile: '/b.md', mode: 'label-on-green', skipPrePrReview: '  why  ' });
    expect(p.skipPrePrReview).toBe('why');
    expect(p.argv.join(' ')).not.toMatch(/skip/i);
  });
});

describe('gate cannot be evaded (PR #4271 review round 4)', () => {
  let dir;
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
  const commit = (files) => {
    for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), c); }
    git('add', '-A'); git('-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'x');
  };
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'pre-pr-r4-')));
    git('init', '-q', '-b', 'main'); commit({ 'README.md': 'x\n' });
    git('checkout', '-q', '-b', 'lane/x');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const enforce = { ...S, mode: 'enforce' };
  const OPERATOR = { PATH: process.env.PATH };

  describe('1. an empty or unparseable diff fails closed, never reads as card-only', () => {
    it('classifyPrRisk gates an empty file list, with a reason that names it', () => {
      const r = classifyPrRisk({ files: [], hasPreparedCard: true, operatorAgent: false });
      expect(r).toMatchObject({ gated: true, cardOnly: false });
      expect(r.reasons.join(' ')).toMatch(/no readable diff/);
    });
    it('readDiffFiles throws when numstat output is non-empty but yields no files', () => {
      expect(() => readDiffFiles({ cwd: dir, git: (a) => (a.includes('diff') ? 'garbage that is not numstat\0' : '') })).toThrow(/unparseable/);
    });
    it('readDiffFiles throws on ANY unparseable part, even beside parseable ones (a partial parse is not a parse)', () => {
      expect(() => readDiffFiles({ cwd: dir, git: (a) => (a.includes('diff') ? '1\t0\tok.mjs\0not numstat\0' : '') })).toThrow(/unparseable/);
    });
    it('a lane with an empty diff against its base is refused under enforce, not admitted as card-only', () => {
      const r = checkPrePrReview({ cwd: dir, env: OPERATOR, settings: enforce });
      expect(r).toMatchObject({ action: 'refuse' });
      expect(r.why).not.toBe('card-only');
    });
    it('a numstat shape the parser does not know refuses the whole check under enforce (a throw, never a pass)', () => {
      commit({ 'scripts/big.mjs': 'x\n'.repeat(400) });
      expect(() => readDiffFiles({ cwd: dir, base: 'main', git: (a) => (a.includes('diff') ? '12 34 file.mjs\0' : '') })).toThrow(/unparseable/);
    });
  });

  describe('2. the lane\'s own .gitattributes cannot zero the line count', () => {
    for (const attrs of ['* -diff\n', '*.mjs -diff\n', '* binary\n', '* diff=nope\n']) {
      it(`counts real lines with ${JSON.stringify(attrs.trim())} committed`, () => {
        commit({ '.gitattributes': attrs, 'scripts/big.mjs': 'x\n'.repeat(400) });
        const { files } = readDiffFiles({ cwd: dir, base: 'main' });
        expect(files.find((x) => x.path === 'scripts/big.mjs')).toMatchObject({ additions: 400 });
        const r = checkPrePrReview({ cwd: dir, env: { WE_CONVEYOR_WORKER: '1' }, settings: enforce });
        expect(r.risk.lines).toBeGreaterThan(400);
        expect(r.risk.reasons.join(' ')).toMatch(/lines changed/);
        expect(r.action).toBe('refuse');
      });
    }
    it('a user-level attributes file cannot zero it either', () => {
      const attrs = join(dir, '..', `user-attrs-${Date.now()}`);
      writeFileSync(attrs, '* -diff\n');
      git('config', 'core.attributesFile', attrs);
      commit({ 'scripts/big.mjs': 'x\n'.repeat(400) });
      try { expect(readDiffFiles({ cwd: dir, base: 'main' }).files[0]).toMatchObject({ additions: 400 }); } finally { rmSync(attrs, { force: true }); }
    });
    it('an image-only PR is not gated for being binary, but a NUL byte planted in a code file (hiding its size) is', () => {
      commit({ 'docs/img/a.png': '\u0000\n'.repeat(30) });
      const png = readDiffFiles({ cwd: dir, base: 'main' }).files;
      expect(png[0]).toMatchObject({ path: 'docs/img/a.png', unmeasured: true });
      expect(classifyPrRisk({ files: png, hasPreparedCard: true, operatorAgent: false }).gated).toBe(false);
      commit({ 'scripts/hidden.mjs': `\u0000${'x\n'.repeat(400)}` });
      const code = readDiffFiles({ cwd: dir, base: 'main' }).files;
      const risk = classifyPrRisk({ files: code, hasPreparedCard: true, operatorAgent: false });
      expect(risk.gated).toBe(true);
      expect(risk.reasons.join(' ')).toMatch(/unmeasured/);
    });
    it('a base or sha that looks like a git option is refused, never passed to git (no --output=<file> injection)', () => {
      commit({ 'scripts/a.mjs': 'x\n' });
      const target = join(dir, 'pwned');
      expect(() => readDiffFiles({ cwd: dir, base: `--output=${target}` })).toThrow(/looks like a git option/);
      expect(() => readDiffFiles({ cwd: dir, base: 'main', sha: '--output=x' })).toThrow(/looks like a git option/);
      expect(() => checkPrePrReview({ cwd: dir, base: `--output=${target}`, env: OPERATOR, settings: enforce })).toThrow();
      expect(existsSync(target)).toBe(false);
    });
    it('a row whose count git could not measure (`-\\t-`) is gated, never counted as zero', () => {
      const r = readDiffFiles({ cwd: dir, git: (a) => (a.includes('diff') ? '-\t-\tscripts/blob.bin\0' : '') });
      expect(r.files[0]).toMatchObject({ path: 'scripts/blob.bin', unmeasured: true });
      const risk = classifyPrRisk({ files: r.files, hasPreparedCard: true, operatorAgent: false });
      expect(risk.gated).toBe(true);
      expect(risk.reasons.join(' ')).toMatch(/unmeasur/);
    });
  });

  describe('3. the receipt is bound to the reviewed base', () => {
    const setup = () => {
      git('branch', 'old'); // the older base, at the first commit
      git('checkout', '-q', 'main'); commit({ 'scripts/small.mjs': 'a\n' });
      git('checkout', '-q', 'lane/x'); git('merge', '-q', '--ff-only', 'main');
      commit({ 'scripts/big.mjs': 'x\n'.repeat(400) });
    };
    const stamp = (extra = {}) => writeFileSync(join(gitDirOf(dir), RECEIPT_FILE), JSON.stringify(buildReceipt({ tree: treeOf(dir), head: 'h', envelope: {}, base: git('merge-base', 'main', 'HEAD'), ...extra })));
    it('the receipt records the merge-base it was stamped against', () => {
      setup();
      expect(buildReceipt({ tree: 't', head: 'h', envelope: {}, base: 'abc' })).toMatchObject({ base: 'abc' });
    });
    it('a receipt stamped against main admits against main', () => {
      setup(); stamp();
      expect(checkPrePrReview({ cwd: dir, base: 'main', env: OPERATOR, settings: enforce })).toMatchObject({ action: 'pass', why: 'receipt' });
    });
    it('the SAME head tree opened against an older base is refused: the receipt reviewed a different diff', () => {
      setup(); stamp();
      const r = checkPrePrReview({ cwd: dir, base: 'old', env: OPERATOR, settings: enforce });
      expect(r).toMatchObject({ action: 'refuse', why: 'receipt-base-mismatch' });
      expect(r.message).toMatch(/base/);
    });
    it('a receipt that records no base (stamped before this check) is refused, not trusted', () => {
      setup(); writeFileSync(join(gitDirOf(dir), RECEIPT_FILE), JSON.stringify({ tree: treeOf(dir), head: 'h', verdict: 'land' }));
      expect(checkPrePrReview({ cwd: dir, base: 'main', env: OPERATOR, settings: enforce })).toMatchObject({ action: 'refuse', why: 'receipt-base-mismatch' });
    });
    it('decidePrePrReview needs the base to match as well as the tree', () => {
      const risky = { gated: true, cardOnly: false, reasons: ['x'] };
      const e = { ...S, mode: 'enforce' };
      expect(decidePrePrReview({ settings: e, risk: risky, receipt: { tree: 't', base: 'b1', verdict: 'land' }, headTree: 't', baseSha: 'b1' }).action).toBe('pass');
      expect(decidePrePrReview({ settings: e, risk: risky, receipt: { tree: 't', base: 'b1', verdict: 'land' }, headTree: 't', baseSha: 'b2' }).why).toBe('receipt-base-mismatch');
      expect(decidePrePrReview({ settings: e, risk: risky, receipt: { tree: 't', base: 'b1', verdict: 'land' }, headTree: 't' }).why).toBe('receipt-base-mismatch');
    });
  });
});

describe('converge-cli receipt', () => {
  let dir; let state;
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'pre-pr-cli-')));
    git('init', '-q', '-b', 'main'); writeFileSync(join(dir, 'a'), 'x');
    git('add', '-A'); git('-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'x');
    state = join(dir, '..', `state-${Date.now()}.json`);
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); rmSync(state, { force: true }); });
  const cli = (...a) => spawnSync(process.execPath, [CLI, ...a], { encoding: 'utf8' });

  const st = { round: 2, careLevel: 'elevated', activeLenses: ['correctness'], dismissed: [] };
  const landed = (extra = {}) => ({ ctx: { laneRoot: dir, baseRef: 'main' }, state: st, final: 'land', reviewed: { lane: dir, tree: workingTreeOf(dir) }, ...extra });
  const commitAll = (name, body) => { writeFileSync(join(dir, name), body); git('add', '-A'); git('-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', name); };

  it('refuses a run that did not land, and stamps the head tree for one that did', () => {
    writeFileSync(state, JSON.stringify(landed({ final: 'escalate' })));
    const bad = cli('receipt', `--state=${state}`, `--lane=${dir}`);
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toMatch(/did not end in `land`/);
    writeFileSync(state, JSON.stringify(landed()));
    const ok = cli('receipt', `--state=${state}`, `--lane=${dir}`);
    expect(ok.status).toBe(0);
    const rec = JSON.parse(readFileSync(join(dir, '.git', RECEIPT_FILE), 'utf8'));
    expect(rec).toMatchObject({ tree: treeOf(dir), verdict: 'land', rounds: 2 });
  });
  it('stamps the merge-base of the base the panel diffed against, and refuses when it cannot be computed', () => {
    git('checkout', '-q', '-b', 'lane/y'); commitAll('b.txt', 'b\n');
    writeFileSync(state, JSON.stringify(landed()));
    expect(cli('receipt', `--state=${state}`, `--lane=${dir}`).status).toBe(0);
    const rec = JSON.parse(readFileSync(join(dir, '.git', RECEIPT_FILE), 'utf8'));
    expect(rec.base).toBe(git('merge-base', 'main', 'HEAD').trim());
    rmSync(join(dir, '.git', RECEIPT_FILE));
    writeFileSync(state, JSON.stringify(landed({ ctx: { laneRoot: dir, baseRef: 'no-such-ref' } })));
    const bad = cli('receipt', `--state=${state}`, `--lane=${dir}`);
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toMatch(/base/);
    expect(existsSync(join(dir, '.git', RECEIPT_FILE))).toBe(false);
  });
  it('refuses receipt issuance for a tree different from the landed review (work committed after the review)', () => {
    writeFileSync(state, JSON.stringify(landed()));
    commitAll('more.txt', 'added after the panel landed\n');
    const r = cli('receipt', `--state=${state}`, `--lane=${dir}`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/not the content the panel reviewed/);
    expect(existsSync(join(dir, '.git', RECEIPT_FILE))).toBe(false);
  });
  it('refuses a state file that reviewed another lane (cross-lane reuse), including via the default --lane', () => {
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'pre-pr-other-')));
    try {
      execFileSync('git', ['-C', other, 'init', '-q', '-b', 'main']); writeFileSync(join(other, 'a'), 'x');
      execFileSync('git', ['-C', other, 'add', '-A']); execFileSync('git', ['-C', other, '-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'x']);
      writeFileSync(state, JSON.stringify(landed({ reviewed: { lane: other, tree: workingTreeOf(dir) } })));
      const r = cli('receipt', `--state=${state}`, `--lane=${dir}`);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/review was of lane/);
      expect(existsSync(join(dir, '.git', RECEIPT_FILE))).toBe(false);
    } finally { rmSync(other, { recursive: true, force: true }); }
  });
  it('refuses with an explicit message when untracked files are left uncommitted (not a misleading "changed")', () => {
    writeFileSync(state, JSON.stringify(landed()));
    writeFileSync(join(dir, 'scratch.txt'), 'left behind\n');
    const r = cli('receipt', `--state=${state}`, `--lane=${dir}`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/untracked files.*scratch\.txt.*Commit or delete/s);
    expect(existsSync(join(dir, '.git', RECEIPT_FILE))).toBe(false);
  });
  it('refuses a landed state that records no reviewed lane/content (hand-written or pre-binding)', () => {
    const { reviewed: _drop, ...bare } = landed();
    writeFileSync(state, JSON.stringify(bare));
    const r = cli('receipt', `--state=${state}`, `--lane=${dir}`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/records no reviewed lane/);
  });
  it('workingTreeOf equals the committed tree once the reviewed content (incl. untracked files) is committed, and leaves the lane\'s index alone', () => {
    writeFileSync(join(dir, 'a'), 'edited'); writeFileSync(join(dir, 'fresh.txt'), 'untracked\n');
    const before = git('status', '--porcelain');
    const reviewed = workingTreeOf(dir);
    expect(git('status', '--porcelain')).toBe(before); // nothing staged by the hash
    git('add', '-A'); git('-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'reviewed');
    expect(treeOf(dir)).toBe(reviewed);
  });
  it('converge scratch files (.converge-*) inside the lane are not reviewed content: the hash and the receipt ignore them', () => {
    const clean = workingTreeOf(dir);
    writeFileSync(join(dir, '.converge-state.json'), '{"n":1}');
    writeFileSync(join(dir, '.converge-obs-1.json'), '{}');
    expect(workingTreeOf(dir)).toBe(clean);
    writeFileSync(join(dir, '.converge-state.json'), '{"n":2}'); // `step` rewrites it after hashing
    expect(workingTreeOf(dir)).toBe(clean);
    writeFileSync(join(dir, 'real.txt'), 'real work\n');         // a non-scratch untracked file still counts
    expect(workingTreeOf(dir)).not.toBe(clean);
  });
  it('the brief\'s other sanctioned in-lane scratch (.commit-msg.txt, .pr-body.md) is skipped too, but a TRACKED file of that name counts', () => {
    const clean = workingTreeOf(dir);
    writeFileSync(join(dir, '.commit-msg.txt'), 'msg\n'); writeFileSync(join(dir, '.pr-body.md'), 'body\n');
    expect(workingTreeOf(dir)).toBe(clean);
    writeFileSync(join(dir, '.commit-msg.txt'), 'msg\n');
    git('add', '-f', '.commit-msg.txt'); git('-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'tracked scratch');
    const tracked = workingTreeOf(dir);
    writeFileSync(join(dir, '.commit-msg.txt'), 'edited\n');
    expect(workingTreeOf(dir)).not.toBe(tracked); // tracked content is never hidden
  });
  it('the brief\'s literal flow works: state file INSIDE the lane (plus obs/material scratch) still yields a receipt', () => {
    const inLane = join(dir, '.converge-state.json');
    writeFileSync(join(dir, '.converge-obs-1.json'), '{}'); writeFileSync(join(dir, '.converge-material-1.txt'), 'diff');
    writeFileSync(inLane, JSON.stringify(landed()));
    writeFileSync(inLane, JSON.stringify({ ...landed(), rewrittenAfterHash: true })); // step rewrites state after computing reviewed.tree
    const ok = cli('receipt', `--state=${inLane}`, `--lane=${dir}`);
    expect(ok.status, ok.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, '.git', RECEIPT_FILE), 'utf8'))).toMatchObject({ tree: treeOf(dir), verdict: 'land' });
  });
  it('refuses when tracked files are dirty', () => {
    writeFileSync(state, JSON.stringify(landed()));
    writeFileSync(join(dir, 'a'), 'changed');
    expect(cli('receipt', `--state=${state}`, `--lane=${dir}`).stderr).toMatch(/uncommitted/);
    expect(existsSync(join(dir, '.git', RECEIPT_FILE))).toBe(false);
  });
});
