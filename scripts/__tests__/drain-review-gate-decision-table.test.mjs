import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideDrainReviewGate, buildDrainVerdicts, drainPinnedCwd } from '../merge-ai-prs.mjs';
import drainSource from '../merge-ai-prs.mjs?raw';

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
  const verdictFor = (files) => buildDrainVerdicts({ defaultBranchOf: () => 'main', prsByRepo: new Map([[REPO, [{ number: 6021, headRefOid: HEAD,
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

describe('decideDrainReviewGate — cross-repo listing with a rename (FUI-DRAIN-CHANGED-FILES)', () => {
  const XREPO = 'frontier-ui/frontierui';
  let root, SIB, localCwd, elsewhere, cwdSpy;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'drain-pinned-cwd-'));
    SIB = join(root, 'frontierui');
    localCwd = join(root, 'web-everything');
    elsewhere = join(root, 'elsewhere');
    for (const dir of [SIB, localCwd, elsewhere, join(root, 'scripts')]) mkdirSync(dir);
    // Import the code under test as data, then inject it into a temporary repo; no checkout reads in this suite.
    writeFileSync(join(root, 'scripts/merge-ai-prs.mjs'), drainSource);
  });
  beforeEach(() => {
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(localCwd);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-27T12:00:00Z'));
  });
  afterEach(() => { cwdSpy.mockRestore(); vi.useRealTimers(); });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const untrusted = { repo: XREPO, local: false, cwd: undefined, files: PLAIN, filesComplete: false, listedHeadSha: HEAD };
  const trustedWf = { repo: XREPO, local: false, cwd: undefined, files: WORKFLOW, filesComplete: true, listedHeadSha: HEAD };
  const pinnedRead = (calls) => calls.find(([cmd, args]) => cmd === 'git' && args[0] === 'diff');
  const fetchCall = (calls) => calls.find(([cmd, args]) => cmd === 'git' && args[0] === 'fetch');
  const recording = (calls, opts = {}) => (cmd, args, o) => { calls.push([cmd, args, o]); return execFor(opts)(cmd, args); };

  // Initial read of an untrusted listing (Ruling 4a).
  it('C1 verified sibling + known base: pinned read in that clone at the head, plain diff merges', () => {
    const calls = [];
    const result = gate(LABELS.accepted, { ...untrusted, pinnedCwd: SIB, defaultBranch: 'main', exec: recording(calls) });
    const read = pinnedRead(calls);
    expect(read?.[2]?.cwd).toBe(SIB);
    expect(read[1].join(' ')).toContain(HEAD);
    expect(read[1]).toContain('--no-renames');
    expect(result.action).toBe('merge');
  });
  it('C2 the pinned read shows a workflow path → park for a human, never merge', () => {
    expect(gate(LABELS.accepted, { ...untrusted, pinnedCwd: SIB, defaultBranch: 'main', exec: execFor({ diff: WORKFLOW }) }))
      .toMatchObject({ action: 'park', workflowEditHold: true });
  });
  it('C3 a failed pinned read in the sibling clone defers, never merges', () => {
    const exec = vi.fn((cmd, args) => { if (cmd === 'git') throw new Error('bad object'); return execFor()(cmd, args); });
    expect(gate(LABELS.accepted, { ...untrusted, pinnedCwd: SIB, defaultBranch: 'main', exec }))
      .toMatchObject({ action: 'defer', reason: expect.stringContaining('workflow-edit change list unreadable') });
  });
  it('C4 a non-main base is fetched and diffed as given', () => {
    const calls = [];
    gate(LABELS.accepted, { ...untrusted, pinnedCwd: SIB, defaultBranch: 'develop', exec: recording(calls) });
    expect(fetchCall(calls)?.[1]).toContain('+refs/heads/develop:refs/remotes/origin/develop');
    expect(fetchCall(calls)?.[2]?.cwd).toBe(SIB);
  });
  it('C5 the acceptance head wins over a different listed head', () => {
    const calls = [];
    gate(LABELS.accepted, { ...untrusted, listedHeadSha: OTHER, pinnedCwd: SIB, defaultBranch: 'main', exec: recording(calls) });
    expect(pinnedRead(calls)[1].join(' ')).toContain(HEAD);
    expect(pinnedRead(calls)[1].join(' ')).not.toContain(OTHER);
  });
  it('C6 no head to pin to (no acceptance, no listed head) → defer, no git call, never merge', () => {
    const calls = [];
    const result = gate(LABELS.none, { ...untrusted, listedHeadSha: null, pinnedCwd: SIB, defaultBranch: 'main', exec: recording(calls) });
    expect(calls.some(([cmd]) => cmd === 'git')).toBe(false);
    expect(result).toMatchObject({ action: 'defer', applyLabel: null });
  });
  it.each([
    ['C7a no pinnedCwd (bare cwd only)', () => ({ cwd: localCwd })],
    ['C7b pinnedCwd but unknown base', () => ({ pinnedCwd: SIB, defaultBranch: null })],
    ['C7c pinnedCwd empty', () => ({ pinnedCwd: '', defaultBranch: 'main' })],
  ])('%s → no git read, defer with the no-file-count reason', (_name, extra) => {
    const calls = [];
    const result = gate(LABELS.accepted, { ...untrusted, ...extra(), exec: recording(calls) });
    expect(pinnedRead(calls)).toBeUndefined();
    expect(result).toMatchObject({ action: 'defer', applyLabel: null, reason: expect.stringContaining('no file count') });
  });
  it('C8 policy off: no pinned read and no workflow hold (existing exception kept)', () => {
    const calls = [];
    const result = gate(LABELS.accepted, { ...untrusted, pinnedCwd: SIB, defaultBranch: 'main', workflowEditSetting: 'off', exec: recording(calls) });
    expect(pinnedRead(calls)).toBeUndefined();
    expect(result.action).toBe('merge');
  });

  // Recheck of a trusted listing that shows a workflow path (Ruling 4b): only a good, non-empty net diff replaces it.
  it('R1 net diff plain and non-empty → the listing hold clears in the sibling clone', () => {
    const calls = [];
    const result = gate(LABELS.accepted, { ...trustedWf, pinnedCwd: SIB, defaultBranch: 'main', exec: recording(calls, { diff: PLAIN }) });
    expect(pinnedRead(calls)?.[2]?.cwd).toBe(SIB);
    expect(result.action).toBe('merge');
  });
  it.each([
    ['R2 net diff shows the workflow path', { exec: execFor({ diff: WORKFLOW }) }],
    ['R3 net diff empty', { exec: execFor({ diff: [] }) }],
    ['R4 net diff read fails', { exec: vi.fn((cmd, args) => { if (cmd === 'git') throw new Error('bad object'); return execFor()(cmd, args); }) }],
  ])('%s → the listing hold stands: park, never merge', (_name, extra) => {
    expect(gate(LABELS.accepted, { ...trustedWf, pinnedCwd: SIB, defaultBranch: 'main', ...extra }))
      .toMatchObject({ action: 'park', workflowEditHold: true });
  });
  it('R5 unknown base: no recheck, the listing hold stands', () => {
    const calls = [];
    expect(gate(LABELS.accepted, { ...trustedWf, pinnedCwd: SIB, defaultBranch: null, exec: recording(calls, { diff: PLAIN }) }))
      .toMatchObject({ action: 'park', workflowEditHold: true });
    expect(pinnedRead(calls)).toBeUndefined();
  });

  it('L1 local repo behaviour is unchanged: pinnedCwd is ignored when local', () => {
    const calls = [];
    gate(LABELS.accepted, { files: PLAIN, filesComplete: false, listedHeadSha: HEAD, local: true, cwd: localCwd, pinnedCwd: elsewhere, exec: recording(calls) });
    expect(pinnedRead(calls)?.[2]?.cwd).toBe(localCwd);
  });

  // Production wiring (Acceptance 2): the drain passes only the verified sibling, through both gate call sites.
  it('W1 drainPinnedCwd: local → none (sibling not asked); absent / origin-mismatch / provision-failed (null) → none; present → its dir', () => {
    const sib = vi.fn(() => SIB);
    expect(drainPinnedCwd('web-everything/web-everything', { isLocalRepo: () => true, siblingCloneDir: sib })).toBeUndefined();
    expect(sib).not.toHaveBeenCalled();
    expect(drainPinnedCwd(XREPO, { isLocalRepo: () => false, siblingCloneDir: () => null })).toBeUndefined();
    expect(drainPinnedCwd(XREPO, { isLocalRepo: () => false, siblingCloneDir: () => '' })).toBeUndefined();
    expect(drainPinnedCwd(XREPO, { isLocalRepo: () => false, siblingCloneDir: () => SIB })).toBe(SIB);
  });
  it('W2 workflowReadOptions carries pinnedCwd from drainPinnedCwd, and both gate call sites still spread it', () => {
    const src = readFileSync(join(root, 'scripts/merge-ai-prs.mjs'), 'utf8');
    const body = src.match(/const workflowReadOptions = \(v\) => \(\{[\s\S]*?\}\);/)?.[0] ?? '';
    expect(body).toContain('pinnedCwd: drainPinnedCwd(v.repo, { isLocalRepo, siblingCloneDir })');
    expect(src.match(/\.\.\.workflowReadOptions\(v\)/g)).toHaveLength(2);
  });
});
