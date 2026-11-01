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
import { createLabelEnsurer, isLabelNotFoundError, parseLabelMemo, LABEL_MEMO_TTL_MS } from '../lib/label-memo.mjs';
import { applyDrainParkLabel, applyCiLifecycleLabelPlan } from '../merge-ai-prs.mjs';

const META = { color: 'aabbcc', description: 'd' };

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
