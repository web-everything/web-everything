import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { classifyCardOnly, isCardPath } from '../ci-card-only.mjs';
import { REVIEW_HOLD_LABELS } from '../lib/review-escalation.mjs';

describe('ci-card-only detection', () => {
  it('card-only PR is light', () => {
    expect(classifyCardOnly({ event: 'pull_request', files: ['backlog/001-x.md', 'backlog/zz9.md'] }).light).toBe(true);
  });
  it('any code file makes a PR full', () => {
    for (const f of ['scripts/foo.mjs', '.github/workflows/ci.yml', 'package.json', 'docs/a.md']) {
      expect(classifyCardOnly({ event: 'pull_request', files: ['backlog/001-x.md', f] }).light).toBe(false);
    }
  });
  it('a push is always full, even for card-only files', () => {
    expect(classifyCardOnly({ event: 'push', files: ['backlog/001-x.md'] }).light).toBe(false);
    expect(classifyCardOnly({ event: 'workflow_dispatch', files: ['backlog/001-x.md'] }).light).toBe(false);
  });
  it('fails closed on empty or missing file lists and path tricks', () => {
    expect(classifyCardOnly({ event: 'pull_request', files: [] }).light).toBe(false);
    expect(classifyCardOnly({ event: 'pull_request' }).light).toBe(false);
    expect(isCardPath('backlog-tools/x.mjs')).toBe(false);
    expect(isCardPath('backlog/../scripts/x.mjs')).toBe(false);
    expect(isCardPath('backlog/')).toBe(false);
  });
});

describe('review-gate workflow label fast path', () => {
  it('its shell hold-label list matches REVIEW_HOLD_LABELS', () => {
    const yml = readFileSync(resolve(process.cwd(), '.github/workflows/review-gate.yml'), 'utf8');
    const m = yml.match(/HOLD_LABELS_LIST='([^']*)'/);
    expect(m).toBeTruthy();
    expect(m[1].split(',').sort()).toEqual([...REVIEW_HOLD_LABELS].sort());
  });
});
