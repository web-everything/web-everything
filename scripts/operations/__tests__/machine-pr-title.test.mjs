import { describe, it, expect } from 'vitest';
import { machinePrTitle, readMainCard, assertMachineTitle, preventionCardTitle, publicationTitle, MACHINE_TITLE_KINDS, visualBaselineTitle } from '../machine-pr-title.mjs';
import { groupPrsByDeliveredItem } from '../../conveyor/duplicate-pr-watch.mjs';
import { isAnnotationPr } from '../../backlog-stranded-sweep.mjs';
import { deliveredItemNumsFromPr, deliveredHashFromPr, itemNumsFromPr } from '../../lib/open-pr-items.mjs';

const card = { title: 'Planner build: plan schema and routing inputs' };
describe('machine PR titles', () => {
  it.each(['prepare', 'build', 'gate-fix'])('keeps identity and %s before the card title', (kind) => {
    expect(machinePrTitle({ item: 4427, kind, card })).toBe(`WE #4427: ${kind} — ${card.title}`);
  });
  it.each(MACHINE_TITLE_KINDS)('requires a subject slot for %s', (kind) => {
    expect(() => assertMachineTitle(machinePrTitle({ item: 42, kind }))).toThrow(/subject/);
    const a = machinePrTitle({ item: 42, kind, subject: 'Reject malformed flags' });
    const b = machinePrTitle({ item: 42, kind, subject: 'Preserve review ownership' });
    expect(assertMachineTitle(a)).toContain('Reject malformed flags');
    expect(b).toContain('Preserve review ownership');
    expect(a).not.toBe(b);
  });
  it('strips control, bidi, shell/markup characters and caps Unicode titles', () => {
    const title = machinePrTitle({ repo: 'PLATEAU', item: 'xabcdef', kind: 'build',
      card: { title: 'A\n\u0000\u202e`$<>\\ B ' + '😀'.repeat(80) } });
    expect(title).toMatch(/^PLATEAU #xabcdef: build — A B /);
    expect(Array.from(title)).toHaveLength(70);
    expect(title.endsWith('…')).toBe(true);
  });
  it('summarizes prevention without confusing guarded PRs with backlog ids', () => {
    const title = machinePrTitle({ item: 'xjhjcjn', kind: 'prevention', card: {
      title: "File the prevention guard(s) owed by web-everything/web-everything#3158's independent review",
      raw: '1. `we:scripts/a.mjs:918` — Reject malformed flags\n2. Another guard',
    } });
    expect(title).toBe('WE #xjhjcjn: prevention — Reject malformed flags (from #3158 review)');
    expect(itemNumsFromPr('lane/xjhjcjn-prevention-card', title)).not.toContain('3158');
    expect(deliveredHashFromPr('lane/xjhjcjn-prevention-card', title)).toBeNull();
  });
  it('derives a guard card title without the placeholder when the card has no numbered finding', () => {
    const title = machinePrTitle({ item: 4410, kind: 'prepare', card: {
      title: "File the prevention guard(s) owed by chalbert/web-everything#2855's independent review",
      raw: '# File the prevention guard(s) owed by chalbert/web-everything#2855\n\nFiled mechanically on approval.',
    } });
    expect(title).toBe('WE #4410: prepare — prevention guards owed (from #2855 review)');
    expect(() => assertMachineTitle(title)).not.toThrow();
  });
  it('retains duplicate grouping and hash delivery without crediting a cited PR', () => {
    const title = machinePrTitle({ item: 4333, kind: 'build', card });
    const groups = groupPrsByDeliveredItem([{ number: 1, title }, { number: 2, title }]);
    expect(groups.get('4333')).toEqual([1, 2]);
    const hashTitle = machinePrTitle({ item: 'xabcdef', kind: 'build', card });
    expect(deliveredHashFromPr('', hashTitle)).toBe('xabcdef');
  });

  it('preserves prepare detection and build delivery even with misleading card prose', () => {
    for (const kind of ['prepare', 'prevention', 'build', 'gate-fix']) {
      const title = machinePrTitle({ item: 4333, kind, card: { title: 'File checks: prepare scope' } });
      const annotation = ['prepare', 'prevention'].includes(kind);
      expect(isAnnotationPr({ title })).toBe(annotation);
      expect(deliveredItemNumsFromPr('', title)).toEqual(annotation ? [] : ['4333']);
    }
  });
});

describe('origin/main card metadata', () => {
  it('reads the exact remote card, never the worktree or HEAD', () => {
    const calls = [];
    const git = (args) => { calls.push(args); return args[0] === 'ls-tree'
      ? 'backlog/4427-card.md\nbacklog/44270-other.md\n' : '---\nstatus: open\n---\n# Planner build\n'; };
    expect(readMainCard(4427, git)?.title).toBe('Planner build');
    expect(calls[1]).toEqual(['show', 'origin/main:backlog/4427-card.md']);
  });
  it.each(['missing', 'ambiguous', 'unreadable', 'no-heading'])('falls back for %s metadata', (failure) => {
    const git = (args) => {
      if (failure === 'unreadable') throw new Error('unavailable');
      if (args[0] === 'show') return 'no heading';
      return failure === 'missing' ? '' : failure === 'ambiguous'
        ? 'backlog/42-one.md\nbacklog/42-two.md' : 'backlog/42-one.md';
    };
    expect(() => assertMachineTitle(machinePrTitle({ item: 42, kind: 'build', card: readMainCard(42, git) }))).toThrow(/subject/);
  });
});


describe('publication and prevention filing', () => {
  it('uses the finding before the provenance, reserving space for both', () => {
    const title = preventionCardTitle({ repo: 'web-everything/web-everything', pr: 2828,
      digest: '1. `we:scripts/a.mjs:2` — Reject malformed flags' });
    expect(title).toBe('Prevention — Reject malformed flags (from web-everything/web-everything#2828 review)');
    const prTitle = machinePrTitle({ item: 'xjhjcjn', kind: 'prevention', card: { title } });
    expect(prTitle).toBe('WE #xjhjcjn: prevention — Reject malformed flags (from #2828 review)');
    const long = machinePrTitle({ item: 'xjhjcjn', kind: 'prevention', card: {
      title: preventionCardTitle({ repo: 'o/r', pr: 2828, subject: 'Guard '.repeat(100) }) } });
    expect(Array.from(long)).toHaveLength(70);
    expect(long).toMatch(/… \(from #2828 review\)$/);
  });
  it.each(['WE', 'FUI', 'PLATEAU'])('repairs legacy %s boilerplate from metadata or refuses', (repo) => {
    const title = `${repo} #4291: delivery build`;
    expect(publicationTitle({ title, card: { title: 'Probation launcher for doc-fix builds' } }))
      .toBe(`${repo} #4291: build — Probation launcher for doc-fix builds`);
    expect(() => publicationTitle({ title })).toThrow(/subject/);
  });
  it('does not lose annotation semantics when a card title describes a build', () => {
    for (const kind of ['prepare-stamp', 'review-prep', 'file', 'findings', 'auto-resolve', 'auto-route', 'release']) {
      const title = machinePrTitle({ item: 4291, kind, card });
      expect(deliveredItemNumsFromPr('', title)).toEqual([]);
      expect(isAnnotationPr({ title })).toBe(true);
    }
  });
  it('refuses unknown kinds so new templates must join the subject-slot contract', () => {
    expect(() => machinePrTitle({ item: 42, kind: 'new-template', card })).toThrow(/unknown/);
  });
});


it('does not reclassify a delivery because its subject mentions preparation', () => {
  const title = publicationTitle({ title: 'WE #4291: repair prepare worker routing' });
  expect(title).toBe('WE #4291: build — repair prepare worker routing');
  expect(deliveredItemNumsFromPr('', title)).toEqual(['4291']);
});
it.each(['Merge pull request #1 from lane/4291', 'WE #4291: fix — <specific correction>',
  'WE #4291: ci-heal — <failing check and repair>'])('refuses unresolved title %s', (title) => {
  expect(() => assertMachineTitle(title)).toThrow(/subject/);
  expect(() => publicationTitle({ title })).toThrow(/subject/);
});
it('uses the guard text when the finding has no cited file', () => {
  expect(preventionCardTitle({ repo: 'o/r', pr: 1, digest: '1. (no file cited) — Reject missing scope' }))
    .toBe('Prevention — Reject missing scope (from o/r#1 review)');
});


it('names changed baseline subjects and opens nothing for an empty diff', () => {
  expect(visualBaselineTitle([])).toBeNull();
  const title = visualBaselineTitle(['snapshots/home-chromium-linux.png', 'snapshots/nav-chromium-linux.png']);
  expect(title).toBe('WE #2238: baselines — linux home (+1)');
  expect(deliveredItemNumsFromPr('', title)).toEqual([]);
});

it('executes the workflow title step on actual changed files and feeds both publication fields', async () => {
  const { load } = await import('js-yaml');
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const workflow = load(readFileSync(join(root, '.github/workflows/update-visual-baselines.yml'), 'utf8'));
  const steps = workflow.jobs['update-baselines'].steps;
  const generate = steps.find(s => s.id === 'baseline-title');
  const publish = steps.find(s => s.name === 'Open baseline-refresh PR');
  expect(publish.with.title).toBe('${{ steps.baseline-title.outputs.title }}');
  expect(publish.with['commit-message']).toBe(publish.with.title);
  expect(publish.if).toBe("steps.baseline-title.outputs.title != ''");
  const dir = mkdtempSync(join(tmpdir(), 'baseline-title-'));
  try {
    execFileSync('git', ['init', '-q', dir]);
    symlinkSync(join(root, 'scripts'), join(dir, 'scripts'));
    const snapshots = join(dir, 'tests/visual/rendered-site-visual.spec.ts-snapshots');
    mkdirSync(snapshots, { recursive: true });
    writeFileSync(join(snapshots, 'home-chromium-linux.png'), 'fixture');
    const output = join(dir, 'github-output');
    execFileSync('bash', ['-c', generate.run], { cwd: dir, env: { ...process.env, GITHUB_OUTPUT: output } });
    expect(readFileSync(output, 'utf8')).toBe('title=WE #2238: baselines — linux home\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
