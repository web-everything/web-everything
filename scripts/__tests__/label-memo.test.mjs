/**
 * @file scripts/__tests__/label-memo.test.mjs
 * @description Perf item 6 — the drain's persisted "label exists" memo: survives a restart, expires by TTL, and
 *   heals when a memoised label was deleted on GitHub (no PR goes unlabelled because of a stale memo).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { createLabelEnsurer, isLabelNotFoundError, parseLabelMemo, LABEL_MEMO_TTL_MS } from '../lib/label-memo.mjs';
import { applyDrainParkLabel, applyCiLifecycleLabelPlan } from '../merge-ai-prs.mjs';

const META = { color: 'aabbcc', description: 'd' };

// Exercise the CLI's actual provisioning/retry closures, with only the gh transport replaced.
// This also covers addPrLabel, which is private to the CLI rather than an exported helper.
describe('implicit repository label wiring', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'we-label-repo-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const wire = (path, effectiveRepo, { localSlug = 'alice/fork', env = { GH_REPO: effectiveRepo }, repoReadError = null } = {}) => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'merge-ai-prs.mjs'), 'utf8');
    const setup = src.slice(src.indexOf('  const repoFlag ='), src.indexOf('  // #gh-graphql-budget'));
    const provision = src.slice(src.indexOf('  const ensuredLabels ='), src.indexOf('  // #2263'));
    const calls = [];
    const labels = new Set();
    const exec = (cmd, args) => {
      expect(cmd).toBe('gh');
      const target = args.includes('--repo') ? args[args.indexOf('--repo') + 1] : effectiveRepo;
      calls.push({ args, target });
      if (args[0] === 'repo') {
        if (repoReadError) throw repoReadError;
        return effectiveRepo + '\n';
      }
      if (args[0] === 'label') labels.add(`${target}::${args[2]}`);
      if (args.includes('--add-label') && !labels.has(`${target}::${args.at(-1)}`)) {
        throw Object.assign(new Error('missing label'), { stderr: "'review:human' not found" });
      }
    };
    const api = runInNewContext(`${setup}\n${provision}\n({ memoRepo, labelEnsurer, healLabelNotFoundIn, addPrLabel })`, {
      localSlug, process: { env: { ...env, WE_DRAIN_LABEL_MEMO_PATH: path }, cwd: () => '/checkout' },
      REVIEW_LABEL_META: { 'review:human': META }, CI_LIFECYCLE_LABEL_META: { 'ci:failed': META },
      execFileSync: exec, createLabelEnsurer, isLabelNotFoundError,
    });
    return { ...api, calls, labels, exec };
  };

  it.each(['upstream/project', 'https://github.example.com/upstream/project'])(
    'provisions, memoises and heals in gh\'s effective repository %s instead of origin', (effectiveRepo) => {
      const path = join(dir, 'memo.json');
      const api = wire(path, effectiveRepo);
      const repo = api.memoRepo(null);
      api.labelEnsurer.ensure(repo, 'review:human', META);
      expect(api.calls.find(c => c.args[0] === 'label').target).toBe(effectiveRepo);
      expect(parseLabelMemo(readFileSync(path, 'utf8'))[`${effectiveRepo}::review:human`]).toBeTypeOf('number');
      const restarted = wire(path, effectiveRepo);
      restarted.labelEnsurer.ensure(restarted.memoRepo(null), 'review:human', META);
      expect(restarted.calls).toEqual([]);
      api.labels.clear(); // Deleted after provisioning: all three production add-label paths must recover.
      expect(() => api.addPrLabel(null, 7, 'review:human')).not.toThrow();
      api.labels.clear();
      expect(applyDrainParkLabel({ gate: { applyLabel: 'review:human' }, labels: [], dryRun: false, pr: 7,
        repo: null, onLabelNotFound: api.healLabelNotFoundIn(null) }, { exec: api.exec }).added).toBe(true);
      api.labels.clear();
      expect(applyCiLifecycleLabelPlan({ plan: { toAdd: ['ci:failed'], toRemove: [] }, pr: 7,
        repo: null, exec: api.exec, signal: () => {}, onLabelNotFound: api.healLabelNotFoundIn(null) })).toBe(true);
      expect(api.calls.filter(c => c.args[0] === 'label').map(c => c.target)).toEqual(Array(4).fill(effectiveRepo));
      expect(api.calls.filter(c => c.args.includes('--add-label'))).toHaveLength(6);
    });

  it('explicit repository takes precedence over GH_REPO for provisioning, memo and retry', () => {
    const api = wire(join(dir, 'memo.json'), 'upstream/project');
    const repo = 'other/project';
    expect(api.memoRepo(repo)).toBe(repo);
    api.labelEnsurer.ensure(api.memoRepo(repo), 'review:human', META);
    api.labels.clear();
    expect(() => api.addPrLabel(repo, 7, 'review:human')).not.toThrow();
    expect(api.calls.every(c => c.target === repo)).toBe(true);
  });

  it.each(['alice/fork', null])('resolves gh\'s default repository once instead of guessing from origin %s', (localSlug) => {
    const effectiveRepo = 'https://github.example.com/upstream/project';
    const api = wire(join(dir, 'memo.json'), effectiveRepo, { env: {}, localSlug });
    expect(api.memoRepo(null)).toBe(effectiveRepo);
    api.labelEnsurer.ensure(api.memoRepo(null), 'review:human', META);
    api.labels.clear();
    expect(() => api.addPrLabel(null, 7, 'review:human')).not.toThrow();
    expect(api.calls.filter(c => c.args[0] === 'repo')).toHaveLength(1);
    expect(api.calls.filter(c => c.args[0] === 'label').every(c => c.target === effectiveRepo)).toBe(true);
  });

  it('refuses an empty default repository read before provisioning or memoising', () => {
    const api = wire(join(dir, 'memo.json'), '', { env: { GH_REPO: '' } });
    expect(() => api.labelEnsurer.ensure(api.memoRepo(null), 'review:human', META)).toThrow('Cannot resolve implicit label repository');
    expect(api.calls.map(c => c.args[0])).toEqual(['repo']);
    expect(api.labelEnsurer.memo).toEqual({});
  });

  it('propagates a failed repository read without provisioning in origin', () => {
    const api = wire(join(dir, 'memo.json'), 'unused', { env: {}, repoReadError: new Error('HTTP 502') });
    expect(() => api.labelEnsurer.ensure(api.memoRepo(null), 'review:human', META)).toThrow('HTTP 502');
    expect(api.calls.map(c => c.args[0])).toEqual(['repo']);
    expect(api.labelEnsurer.memo).toEqual({});
  });

  it.each(['CI_LIFECYCLE_LABEL_META', 'REVIEW_LABEL_META'])(
    '%s mint loop contains repository lookup failures and retries on a later pass', (family) => {
      const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'merge-ai-prs.mjs'), 'utf8');
      const start = src.indexOf(`for (const [name, meta] of Object.entries(${family})) {`);
      expect(start).toBeGreaterThan(-1);
      const indent = src.slice(src.lastIndexOf('\n', start) + 1, start);
      const loop = src.slice(start, src.indexOf(`\n${indent}}`, start) + indent.length + 2);
      const names = ['first', 'second'];
      const calls = [];
      const ensurer = createLabelEnsurer({ path: join(dir, 'memo.json'), run: (args) => calls.push(args[2]) });
      let failing = true;
      const mint = runInNewContext(`(repo) => { ${loop} }`, {
        [family]: Object.fromEntries(names.map((name) => [name, META])),
        ensuredLabels: new Set(), labelEnsurer: ensurer,
        memoRepo: () => { if (failing) throw new Error('HTTP 502'); return 'o/r'; },
      });
      expect(() => mint(null)).not.toThrow();
      expect(calls).toEqual([]);
      expect(ensurer.memo).toEqual({});
      failing = false;
      mint(null);
      expect(calls).toEqual(names);
      mint(null);
      expect(calls).toEqual(names);
    });
});

describe('label memo — persisted ensure', () => {
  let dir, path, clock, calls;
  const run = (args, repo) => { calls.push([args[0], args[2], repo]); };
  const make = (runFn = run) => createLabelEnsurer({ path, run: runFn, now: () => clock });
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'we-label-memo-')); path = join(dir, 'memo.json'); clock = 1_000_000; calls = []; });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('mints once, then a restarted process does not re-mint', () => {
    make().ensure('o/r', 'review:human', META);
    make().ensure('o/r', 'review:human', META);
    expect(calls).toHaveLength(1);
  });
  it('is keyed by repo', () => {
    const e = make();
    e.ensure('o/a', 'x', META); e.ensure('o/b', 'x', META);
    expect(calls).toHaveLength(2);
  });
  it('re-mints after the TTL', () => {
    make().ensure('o/r', 'x', META);
    clock += LABEL_MEMO_TTL_MS + 1;
    make().ensure('o/r', 'x', META);
    expect(calls).toHaveLength(2);
  });
  it('forget() makes the next ensure mint again (label deleted on GitHub)', () => {
    const e = make();
    e.ensure('o/r', 'x', META);
    e.forget('o/r', 'x');
    make().ensure('o/r', 'x', META);
    expect(calls).toHaveLength(2);
  });
  it('treats "already exists" as ensured but a transport failure as not ensured', () => {
    make(() => { throw Object.assign(new Error('x'), { stderr: 'label already exists' }); }).ensure('o/r', 'x', META);
    expect(parseLabelMemo(readFileSync(path, 'utf8'))['o/r::x']).toBe(clock);
    rmSync(path);
    make(() => { throw Object.assign(new Error('x'), { stderr: 'HTTP 502' }); }).ensure('o/r', 'x', META);
    make().ensure('o/r', 'x', META);
    expect(calls).toHaveLength(1);
  });
  it('a corrupt memo file reads as empty', () => {
    writeFileSync(path, '{nope');
    make().ensure('o/r', 'x', META);
    expect(calls).toHaveLength(1);
  });
  it('recognises gh not-found errors', () => {
    expect(isLabelNotFoundError({ stderr: "could not add label: 'review:human' not found" })).toBe(true);
    expect(isLabelNotFoundError({ stderr: 'HTTP 502' })).toBe(false);
  });
});

describe('applyDrainParkLabel — label deleted after it was memoised', () => {
  const gate = { applyLabel: 'review:human', humanRequired: true };
  it('re-mints via onLabelNotFound and retries once, so the PR still gets labelled', () => {
    const seen = [];
    let deleted = true;
    const exec = (cmd, args) => {
      seen.push(args.join(' '));
      if (args.includes('--add-label') && deleted) throw Object.assign(new Error('fail'), { stderr: "'review:human' not found" });
    };
    const res = applyDrainParkLabel({
      gate, labels: [], dryRun: false, pr: 7, repo: 'o/r',
      onLabelNotFound: (name) => { expect(name).toBe('review:human'); deleted = false; return true; },
    }, { exec });
    expect(res.added).toBe(true);
    expect(seen.filter((a) => a.includes('--add-label'))).toHaveLength(2);
  });
  it('does not retry on a non-not-found failure', () => {
    const exec = () => { throw Object.assign(new Error('fail'), { stderr: 'HTTP 502' }); };
    const res = applyDrainParkLabel({ gate, labels: [], dryRun: false, pr: 7, repo: 'o/r', onLabelNotFound: () => { throw new Error('no'); } }, { exec });
    expect(res.added).toBe(false);
  });
});

describe('applyCiLifecycleLabelPlan — lifecycle label deleted after it was memoised', () => {
  it('heals on not-found and retries once', () => {
    let deleted = true; const adds = [];
    const exec = (c, args) => { if (args.includes('--add-label')) { adds.push(args.at(-1)); if (deleted) throw Object.assign(new Error('f'), { stderr: "'ci:failed' not found" }); } };
    const ok = applyCiLifecycleLabelPlan({ plan: { toAdd: ['ci:failed'], toRemove: [] }, pr: 3, repo: 'o/r', exec, signal: () => {}, onLabelNotFound: () => { deleted = false; return true; } });
    expect(ok).toBe(true);
    expect(adds).toEqual(['ci:failed', 'ci:failed']);
  });
});

describe('merge-ai-prs wiring — addPrLabel', () => {
  it('shells gh itself (no self-recursion) and every add-label write site is a healed one', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'merge-ai-prs.mjs'), 'utf8');
    const body = src.slice(src.indexOf('const addPrLabel ='), src.indexOf('const addPrLabel =') + 500);
    expect(body).toMatch(/const add = \(\) => execFileSync\('gh', \['pr', 'edit'/);
    expect(body).not.toMatch(/const add = \(\) => addPrLabel/);
    // Exactly three add-label writers, each healing on not-found: addPrLabel, applyDrainParkLabel, applyCiLifecycleLabelPlan.
    expect(src.match(/'--add-label'/g).length).toBe(3);
  });
});
