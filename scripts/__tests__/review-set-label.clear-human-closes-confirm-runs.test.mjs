import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeConfirmRunsAfterClearance } from '../review-set-label.mjs';

const REPO = 'web-everything/web-everything';
const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

const run = (id0, { pr = 7, repo = REPO, rev = HEAD, kind = 'confirm' } = {}) => ({
  v: 1, id: id0.startsWith('review-pr-') || id0 === 'other' ? id0 : `review-pr-${id0}`, op: 'review-pr', input: { pr, repo },
  findings: { read: { netBasis: { rev } } },
  pending: kind ? { kind, step: kind } : null,
});

describe('clear-human closes open confirm runs (live: #6381 #6595 #6637 #6633)', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'confirm-runs-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const put = r => writeFileSync(join(dir, `${r.id}.json`), JSON.stringify(r));

  it('abstains the confirm run of the cleared PR at the cleared head', () => {
    put(run('same'));
    const calls = [];
    const out = closeConfirmRunsAfterClearance({ repo: REPO, pr: 7, headSha: HEAD, dir, resume: id => { calls.push(id); return true; } });
    expect(calls).toEqual(['review-pr-same']);
    expect(out.closed).toEqual(['review-pr-same']);
  });

  it('leaves a confirm run on a different head, another PR, another repo, or a non-confirm pending ask open', () => {
    put(run('otherhead', { rev: OTHER }));
    put(run('otherpr', { pr: 8 }));
    put(run('otherrepo', { repo: 'x/y' }));
    put(run('effect', { kind: 'effect' }));
    put(run('done', { kind: null }));
    const calls = [];
    const out = closeConfirmRunsAfterClearance({ repo: REPO, pr: 7, headSha: HEAD, dir, resume: id => { calls.push(id); return true; } });
    expect(calls).toEqual([]);
    expect(out.closed).toEqual([]);
  });

  it('ignores a record whose id does not match its filename', () => {
    writeFileSync(join(dir, 'review-pr-forged.json'), JSON.stringify(run('other')));
    const calls = [];
    closeConfirmRunsAfterClearance({ repo: REPO, pr: 7, headSha: HEAD, dir, resume: id => { calls.push(id); return true; } });
    expect(calls).toEqual([]);
  });

  it('does nothing without a full head sha and reports a failed abstain as not closed', () => {
    put(run('same'));
    expect(closeConfirmRunsAfterClearance({ repo: REPO, pr: 7, headSha: '', dir, resume: () => true }).closed).toEqual([]);
    const out = closeConfirmRunsAfterClearance({ repo: REPO, pr: 7, headSha: HEAD, dir, resume: () => false });
    expect(out.closed).toEqual([]);
    expect(out.failed).toEqual(['review-pr-same']);
  });
});
