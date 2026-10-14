import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideDrainReviewGate, buildDrainVerdicts } from '../merge-ai-prs.mjs';

// #6021 — decision table for decideDrainReviewGate: every review label × workflow / non-workflow change list,
// with the intended drain action pinned, plus the "is this listing trusted?" cases the hold depends on.
const REPO = 'web-everything/web-everything';
const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const WORKFLOW = ['.github/workflows/ci.yml', 'docs/readme.md'];
const PLAIN = ['docs/readme.md', 'scripts/example.mjs'];
const LABELS = {
  changes: ['review:changes'], pending: ['review:pending'], human: ['review:human'],
  accepted: ['review:accepted'], none: [],
};

/** A `gh pr view` response whose acceptance comment stamps `head`; `git diff` returns `diff` NUL-joined. */
function execFor({ head = HEAD, diff = PLAIN, calls = [] } = {}) {
  return (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === 'gh') return JSON.stringify({ headRefOid: head, headRefName: 'lane/x',
      comments: [{ viewerDidAuthor: true, body: `<!-- reviewed-sha: ${head} -->` }] });
    return args[0] === 'diff' ? `${diff.join('\0')}\0` : '';
  };
}
const gate = (labels, options = {}) => decideDrainReviewGate({ labels, escalate: true },
  { pr: 6021, repo: REPO, local: true, cwd: '/fixture', exec: execFor(), ...options });
const trusted = (files, extra = {}) => ({ files, filesComplete: true, listedHeadSha: HEAD, ...extra });

describe('decideDrainReviewGate — review label × workflow edit', () => {
  // [label, non-workflow action, label written]. A workflow edit is held for a human BEFORE
  // the label rules run (N1: the hold is not moved after decideReviewGate), so it parks review:human on every
  // label — even `changes`, which on its own would wait for the author — so its row is the same for every label.
  const TABLE = [
    ['changes', 'wait-author', null],
    ['pending', 'park', 'review:pending'],
    ['human', 'park', 'review:human'],
    ['accepted', 'merge', null],
    ['none', 'park', 'review:pending'],
  ];
  for (const [label, plainAction, plainLabel] of TABLE) {
    it(`${label}: non-workflow → ${plainAction}${plainLabel ? ` (${plainLabel})` : ''}`, () => {
      const result = gate(LABELS[label], trusted(PLAIN));
      expect(result.action).toBe(plainAction);
      expect(result.applyLabel ?? null).toBe(plainLabel);
      expect(result.workflowEditHold).toBeUndefined();
    });
    it(`${label}: workflow → park review:human (human-only hold)`, () => {
      const result = gate(LABELS[label], trusted(WORKFLOW, { exec: execFor({ diff: WORKFLOW }) }));
      expect(result.action).toBe('park');
      expect(result).toMatchObject({ workflowEditHold: true, applyLabel: 'review:human', humanRequired: true });
    });
  }
  it('none, with escalation off: a non-workflow diff merges', () => {
    expect(decideDrainReviewGate({ labels: [], escalate: false },
      { pr: 6021, repo: REPO, local: true, cwd: '/fixture', exec: execFor(), ...trusted(PLAIN) }).action).toBe('merge');
  });
  it('the setting off lifts the hold for a workflow diff on an accepted PR', () => {
    expect(gate(LABELS.accepted, trusted(WORKFLOW, { workflowEditSetting: 'off' })).action).toBe('merge');
  });
});

describe('decideDrainReviewGate — a listing is trusted only with explicit completeness and a matching head', () => {
  const pinnedRead = (calls) => calls.find(([cmd, args]) => cmd === 'git' && args[0] === 'diff');

  it('files-only shape (no flag, no head): not trusted, defers when no pinned read is possible', () => {
    const calls = [];
    const result = gate(LABELS.none, { files: PLAIN, local: false, exec: execFor({ calls }) });
    expect(result).toMatchObject({ action: 'defer', applyLabel: null });
    expect(calls).toEqual([]);
  });
  it('files-only shape on an accepted PR: takes the pinned read and parks when it shows a workflow edit', () => {
    const calls = [];
    const result = gate(LABELS.accepted, { files: PLAIN, exec: execFor({ diff: WORKFLOW, calls }) });
    expect(pinnedRead(calls)?.[1].join(' ')).toContain(HEAD);
    expect(result).toMatchObject({ action: 'park', workflowEditHold: true });
  });
  it('files-only shape on an accepted PR: a pinned read of a plain diff merges', () => {
    const calls = [];
    expect(gate(LABELS.accepted, { files: PLAIN, exec: execFor({ calls }) }).action).toBe('merge');
    expect(pinnedRead(calls)).toBeDefined();
  });
  it('a failed pinned read defers, never merges', () => {
    const exec = vi.fn((cmd, args) => {
      if (cmd === 'git') throw new Error('bad object');
      return JSON.stringify({ headRefOid: HEAD, comments: [{ viewerDidAuthor: true, body: `<!-- reviewed-sha: ${HEAD} -->` }] });
    });
    expect(gate(LABELS.accepted, { files: PLAIN, exec })).toMatchObject({ action: 'defer', applyLabel: null,
      reason: expect.stringContaining('workflow-edit change list unreadable') });
  });
  it.each([
    ['filesComplete absent', { files: PLAIN, listedHeadSha: HEAD }],
    ['filesComplete false', { files: PLAIN, filesComplete: false, listedHeadSha: HEAD }],
    ['filesComplete truthy but not true', { files: PLAIN, filesComplete: 1, listedHeadSha: HEAD }],
    ['listedHeadSha undefined', { files: PLAIN, filesComplete: true }],
    ['listedHeadSha null', { files: PLAIN, filesComplete: true, listedHeadSha: null }],
    ['listedHeadSha empty', { files: PLAIN, filesComplete: true, listedHeadSha: '' }],
    ['files not an array', { files: undefined, filesComplete: true, listedHeadSha: HEAD }],
  ])('%s → pinned read at the acceptance head (accepted)', (_name, options) => {
    const calls = [];
    gate(LABELS.accepted, { ...options, exec: execFor({ calls }) });
    expect(pinnedRead(calls)).toBeDefined();
  });
  it.each([
    ['listedHeadSha undefined', { files: PLAIN, filesComplete: true }],
    ['listedHeadSha empty', { files: PLAIN, filesComplete: true, listedHeadSha: '' }],
    ['filesComplete absent', { files: PLAIN, listedHeadSha: HEAD, local: false }],
  ])('%s, label none (no acceptance read, so no head to pin to) → defer, no merge', (_name, options) => {
    expect(gate(LABELS.none, { ...options, exec: execFor() })).toMatchObject({ action: 'defer', applyLabel: null });
  });
  it('a complete listing at the stamped head is trusted: no git read', () => {
    const calls = [];
    expect(gate(LABELS.accepted, { ...trusted(PLAIN), exec: execFor({ calls }) }).action).toBe('merge');
    expect(pinnedRead(calls)).toBeUndefined();
  });
  it('accepted: a listing from a different head than the acceptance head is re-read at the pinned head', () => {
    const calls = [];
    const result = gate(LABELS.accepted, { files: PLAIN, filesComplete: true, listedHeadSha: OTHER,
      exec: execFor({ diff: WORKFLOW, calls }) });
    expect(pinnedRead(calls)?.[1].join(' ')).toContain(HEAD);
    expect(result).toMatchObject({ action: 'park', workflowEditHold: true });
  });
  it('accepted: the head comparison is case-insensitive', () => {
    const calls = [];
    gate(LABELS.accepted, { ...trusted(PLAIN, { listedHeadSha: HEAD.toUpperCase() }), exec: execFor({ calls }) });
    expect(pinnedRead(calls)).toBeUndefined();
  });
  it('the bare sweep (workflowOnly) does not merge a files-only listing, even a plain one', () => {
    // Old default-trust code merged this: a plain listing with no completeness flag passed the bare-sweep pre-check.
    const result = gate(LABELS.none, { workflowOnly: true, files: PLAIN, exec: execFor() });
    expect(result).toMatchObject({ action: 'defer', applyLabel: null });
  });
  it('the bare sweep (workflowOnly) merges a complete plain listing', () => {
    expect(gate(LABELS.none, { workflowOnly: true, ...trusted(PLAIN) }).action).toBe('merge');
  });
});

// Wiring: the production listing (buildDrainVerdicts) carries the strict evidence the gate now requires, so a
// real, complete listing at the live head is still trusted (no extra git read) and the drain callers pass it on.
describe('decideDrainReviewGate — production wiring', () => {
  const verdictFor = (files) => buildDrainVerdicts({ prsByRepo: new Map([[REPO, [{ number: 6021, headRefOid: HEAD,
    labels: ['ready-to-merge', 'review:accepted'], files }]]]), repos: [REPO], readOf: () => ({}) })[0];
  it('a complete listing from buildDrainVerdicts carries filesComplete === true and the live head', () => {
    const v = verdictFor(PLAIN);
    expect(v.listedFilesComplete).toBe(true);
    expect(v.listedHeadSha).toBe(HEAD);
    const calls = [];
    const result = gate(LABELS.accepted, { files: v.listedFiles, filesComplete: v.listedFilesComplete,
      listedHeadSha: v.listedHeadSha, exec: execFor({ calls }) });
    expect(result.action).toBe('merge');
    expect(calls.some(([cmd]) => cmd === 'git')).toBe(false);
  });
  it('a listing with a rename row is incomplete: it is re-read at the pinned head', () => {
    const v = verdictFor([{ path: 'docs/ci.yml.bak', changeType: 'RENAMED' }]);
    expect(v.listedFilesComplete).toBe(false);
    const calls = [];
    gate(LABELS.accepted, { files: v.listedFiles, filesComplete: v.listedFilesComplete,
      listedHeadSha: v.listedHeadSha, exec: execFor({ diff: WORKFLOW, calls }) });
    expect(calls.some(([cmd, args]) => cmd === 'git' && args[0] === 'diff')).toBe(true);
  });
  it('both drain call sites pass the listing evidence through workflowReadOptions', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'merge-ai-prs.mjs'), 'utf8');
    expect(src).toMatch(/const workflowReadOptions = \(v\) => \(\{ files: v\.listedFiles, filesComplete: v\.listedFilesComplete,\s*listedHeadSha: v\.listedHeadSha,/);
    expect(src.match(/\.\.\.workflowReadOptions\(v\)/g)).toHaveLength(2);
  });
});
