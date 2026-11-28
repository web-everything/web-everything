import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as hold from '../../review-referral-hold.mjs';
import * as core from '../../reconcile-core.mjs';
import * as review from '../../../operations/review-pr.mjs';
import * as jury from '../../../lib/jury-core.mjs';
import b, { NOW, REPO, rawRun } from './review-human-escalated-head-no-advisory.mjs';
import { scanMultiRepo } from '../../../lib/multi-repo-scan.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Runtime policy reads use declared empty configuration in a private fixture, never checkout/host files.
const policyFixture = vi.hoisted(() => ({ root: null, file: null, unexpected: [] }));
vi.mock('node:fs', async original => {
  const fs = await original();
  return { ...fs, readFileSync(path, ...args) {
    if (!policyFixture.root) return fs.readFileSync(path, ...args);
    const name = String(path);
    if (name.startsWith(policyFixture.root + '/')) return fs.readFileSync(path, ...args);
    const configuration = name.includes('/scripts/') && name.endsWith('.json')
      || /\/\.claude\/(?:platform-preferences|operator-overrides)\.json$/.test(name);
    if (configuration) return fs.readFileSync(policyFixture.file, ...args);
    policyFixture.unexpected.push(name);
    throw Error('undeclared fixture read: ' + name);
  } };
});

describe('review-human-escalated-head-no-advisory', () => {
  beforeEach(() => {
    policyFixture.root = mkdtempSync(join(tmpdir(), 'escalated-policy-'));
    policyFixture.cwd = vi.spyOn(process, 'cwd').mockReturnValue(policyFixture.root);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    policyFixture.file = join(policyFixture.root, 'policy.json');
    policyFixture.unexpected = [];
    writeFileSync(policyFixture.file, '{}');
  });
  afterEach(() => {
    const { root, unexpected } = policyFixture;
    policyFixture.root = null;
    policyFixture.cwd.mockRestore();
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
    expect(unexpected).toEqual([]);
  });

  it('uses a repository-neutral fixture whose raw records retain their explicit repository', () => {
    // Scan the exported fixture value in memory: no checkout walk or source-file read.
    expect(scanMultiRepo(`const repo = ${JSON.stringify(REPO)};`)).toEqual([]);
    const record = rawRun({ jury });
    expect(record.input.repo).toBe(REPO);
    expect(hold.reviewRunEvidence(record).repo).toBe(REPO);
  });

  it('exercises historical caps on both head kinds, both ticks, partial publication, counted failures and conversion deferral', async () => {
    const report = await b.run({ api: { hold, core, review, jury } });
    expect(b.judge(report)).toEqual([]);
  });
});
