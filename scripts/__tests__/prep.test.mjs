import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyPath, classifyPaths } from '../lib/touch-class.mjs';
import { buildRecord, classify, covers, recordFromCard, recordHash, render, validate } from '../lib/prep-record.mjs';
import { parsePrep, prepVerdict } from '../lib/prep-block.mjs';
import { PREP_DEFAULTS, resolvePrepSettings } from '../lib/prep-settings.mjs';
import { createPrepIO, createPrepStore, loadPrepSettings } from '../operations/prep-io.mjs';
import { assessPrep, finishPrep, prepOperation, PREP_OP, PREP_STORE_EFFECT } from '../operations/prep.mjs';
import { createRegistry } from '../operations/registry.mjs';
import { startRun, advanceWhileRunning } from '../operations/engine.mjs';
import { buildCliSpec } from '../operations/cli-adapter.mjs';

const good = () => buildRecord({ id: 'card-123', source: 'backlog/123-example.md', baseSha: 'a'.repeat(40),
  acceptance: 'A complete record can be inspected.', preMortem: 'An omitted field could hide important context.',
  testPlan: 'Run the preparation unit test fixtures.', touchSet: ['docs/example.md'] });
const scratch = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'prep-s2-')); scratch.push(dir); return dir; };
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('touch classification', () => {
  it.each([
    ['scripts/guard-bash.mjs', 'guard'], ['.claude/settings.json', 'guard'],
    ['scripts/lib/lane-lease.mjs', 'guard'], ['scripts/lib/card-number-ledger.mjs', 'guard'],
    ['scripts/merge-ai-prs.mjs', 'merge'], ['scripts/operations/open-pr-io.mjs', 'merge'],
    ['scripts/lib/canonical-audit-gate.mjs', 'merge'], ['scripts/lib/merge-queue.mjs', 'merge'],
    ['scripts/lib/review-escalation.mjs', 'review'], ['scripts/review-set-label.mjs', 'review'],
    ['docs/agent/platform-decisions.md', 'review'], ['scripts/conveyor/new-module.mjs', 'daemon'],
    ['scripts/lib/daemon-state.mjs', 'daemon'], ['scripts/lib/review-labels.mjs', 'label'],
    ['scripts/apply-review-request.mjs', 'label'], ['scripts/lib/unrecognized-new-module.mjs', 'review'],
    ['scripts/lib/drain-merge-strategy.mjs', 'label'], ['scripts/conveyor/stand-down.mjs', 'label'],
    ['scripts/settings/new-config.json', 'review'], ['.github/new-config', 'review'],
    ['hooks/new-hook', 'unknown-sensitive'], ['.claude/hooks/new-hook', 'unknown-sensitive'],
  ])('%s includes %s', (path, name) => expect(classifyPath(path)).toContain(name));
  it('adds settings globs and preserves overlapping classes', () => {
    const cfg = structuredClone(PREP_DEFAULTS);
    cfg.classes.label.globs.push('custom/**');
    expect(classifyPath('custom/file', cfg)).toContain('label');
    expect(classifyPaths(['scripts/review-set-label.mjs'])).toEqual(expect.arrayContaining(['review', 'label', 'daemon']));
    expect(classifyPath('docs/guide.md')).toEqual([]);
  });
  it('fails closed for malformed paths', () => expect(classifyPath('../escape')).toEqual(['unknown-sensitive']));
});

describe('preparation records', () => {
  it.each(['acceptance', 'preMortem', 'testPlan', 'touchSet', 'baseSha', 'source'])('reports %s exactly once when missing or placeholder', field => {
    for (const value of [undefined, '', 'TBD', '<fill this in>']) {
      const record = good(); record[field] = value;
      expect(validate(record).missing.filter(k => k === field)).toHaveLength(1);
      expect(validate(record).ok).toBe(false);
    }
  });
  it('requires threat modeling for untrusted output', () => {
    const record = { ...good(), untrustedOutput: true };
    expect(validate(record).missing).toEqual(['threatModel']);
    expect(validate({ ...record, threatModel: 'Treat incoming content as inert data.' }).ok).toBe(true);
  });
  it('fails unknown sensitive paths closed to design review', () => {
    expect(classify({ ...good(), touchSet: ['hooks/unrecognized'] })).toMatchObject({ classes: ['unknown-sensitive'], flow: 'opus-design', designPassRequired: true });
  });
  it('keeps fast work within both bounds and rejects sensitive or unbounded glob work', () => {
    expect(classify({ ...good(), fastPath: { loc: 80 } }).flow).toBe('fast');
    expect(classify({ ...good(), fastPath: { loc: 81 } }).flow).toBe('standard');
    expect(classify({ ...good(), touchSet: ['a.md', 'b.md', 'c.md', 'd.md'], fastPath: { loc: 1 } }).flow).toBe('standard');
    expect(classify({ ...good(), touchSet: ['scripts/lib/new.mjs'], fastPath: { loc: 1 } }).flow).toBe('opus-design');
    expect(classify({ ...good(), touchSet: ['docs/**'], fastPath: { loc: 1 } }).flow).toBe('opus-design');
    expect(classify({ ...good(), acceptance: 'Inspect untrusted input for races.' }).flow).toBe('opus-design');
  });
  it('requires design review for untrusted output despite eligible fast-path evidence', () => {
    const record = { ...good(), fastPath: { loc: 1 }, untrustedOutput: true,
      threatModel: 'Incoming content remains inert data.' };
    expect(validate(record).ok).toBe(true);
    expect(classify(record)).toMatchObject({ classes: [], flow: 'opus-design', designPassRequired: true,
      reasons: expect.arrayContaining(['untrusted output requires threat modeling']) });
  });
  it.each(PREP_DEFAULTS.threatModelTriggers.flatMap(trigger =>
    ['acceptance', 'preMortem', 'testPlan', 'threatModel', 'brief'].map(field => [trigger, field])))
  ('preserves the %s design-review trigger in %s with eligible fast-path evidence', (trigger, field) => {
    const record = { ...good(), fastPath: { loc: 1 }, [field]: `Inspect the ${trigger} behavior carefully.` };
    expect(classify(record)).toMatchObject({ classes: [], flow: 'opus-design', designPassRequired: true,
      reasons: expect.arrayContaining([`threat-model trigger: ${trigger}`]) });
  });
  it('requires design review for invalid trigger settings despite eligible fast-path evidence', () => {
    expect(classify({ ...good(), fastPath: { loc: 1 } }, { ...PREP_DEFAULTS, threatModelTriggers: ['['] }))
      .toMatchObject({ flow: 'opus-design', designPassRequired: true,
        reasons: expect.arrayContaining(['invalid threat-model trigger; restore settings or request design review']) });
  });
  it('hashes canonical JSON without hashing its own hash', () => {
    const record = good();
    expect(recordHash(Object.fromEntries(Object.entries(record).reverse()))).toBe(record.hash);
    expect(recordHash({ ...record, hash: 'ignored' })).toBe(record.hash);
    expect(recordHash({ ...record, acceptance: 'Different acceptance criteria.' })).not.toBe(record.hash);
  });
  it('renders multiline card content without introducing parser section boundaries', () => {
    expect(prepVerdict(render({ ...good(), acceptance: '## Detailed acceptance\nComplete the recorded criteria.' })).ok).toBe(true);
  });
  it.each(['scope: ["we:docs/example.md"]', 'scope:\n  - we:docs/example.md'])('builds inline/block scope and round trips through PREP (%s)', scope => {
    const record = recordFromCard({ text: `---\n${scope}\n---\n## ACCEPTANCE\nComplete acceptance criteria here.\n## Risks\nMissing inputs can hide defects.\n## Test plan\nRun the preparation fixtures.\n`,
      cardPath: 'backlog/123-example.md', id: 'card-123', baseSha: 'a'.repeat(40) });
    expect(record.touchSet).toEqual(['docs/example.md']);
    expect(validate(record).ok).toBe(true);
    expect(render(record)).toMatch(/^## PREP:\nPrep-Id: card-123\n/);
    expect(parsePrep(render(record))).toMatchObject({ present: true, missing: [], empty: [] });
    expect(prepVerdict(render(record)).ok).toBe(true);
  });
  it('supports exact, segment, recursive, and directory glob coverage', () => {
    expect(covers(['a.txt', 'src/*.js', 'tests/**/case.mjs', 'docs/'],
      ['a.txt', 'src/a.js', 'tests/case.mjs', 'tests/nested/case.mjs', 'docs/a/b.md', 'src/nested/a.js', 'b.txt']))
      .toEqual({ covered: false, uncovered: ['src/nested/a.js', 'b.txt'] });
    expect(covers([], ['a.txt'])).toEqual({ covered: false, uncovered: ['a.txt'] });
  });
});

describe('settings and local IO', () => {
  it('fails invalid and unreadable settings closed without enabling enforcement', () => {
    for (const value of [null, {}, { ...PREP_DEFAULTS, fastPath: { maxLoc: 999, maxFiles: 999 } }]) {
      const result = resolvePrepSettings(value);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(classify(good(), result.config).flow).toBe('opus-design');
      expect(Object.values(result.config.enforce)).toEqual(['advise', 'advise', 'advise', 'advise']);
    }
    const result = loadPrepSettings({ readFile: () => { throw new Error('unreadable'); }, platform: {}, env: {}, log() {} });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(classify(good(), result.config).flow).toBe('opus-design');
  });
  it('resolves settings layers and exposes provenance without reading home paths', () => {
    const result = loadPrepSettings({ readFile: () => JSON.stringify(PREP_DEFAULTS), platform: { fastPath: { maxLoc: 1 } },
      env: { WE_PREP_STORE_DIR: 'test-prep-store' }, log() {} });
    expect(result.config.fastPath.maxLoc).toBe(80);
    expect(result.config.storeDir).toBe('test-prep-store');
    expect(result.errors).toEqual([]);
    expect(result.provenance).toBeTruthy();
  });
  it('atomically stores, reads, lists, and rejects unsafe ids including oversized input', () => {
    const store = createPrepStore({ storeDir: temp(), env: {} });
    expect(store.list()).toEqual([]);
    store.write(good());
    expect(store.read('card-123')).toEqual(good());
    expect(store.list()).toEqual(['card-123']);
    for (const id of ['../outside', 'a\n', '', 'a'.repeat(129)]) expect(() => store.write({ ...good(), id })).toThrow('Invalid prep id');
  });
  it('refuses mismatched persisted identities', () => {
    const root = temp();
    const store = createPrepStore({ storeDir: root, env: {} });
    writeFileSync(join(root, 'card-123.json'), JSON.stringify({ ...good(), id: 'other-record' }));
    expect(() => store.read('card-123')).toThrow('identity mismatch');
  });
  it('builds records from card paths, markdown briefs and explicit flags without home IO', () => {
    const root = temp();
    const store = createPrepStore({ storeDir: join(root, 'store'), env: {} });
    const settings = { config: PREP_DEFAULTS, errors: [] };
    const body = '---\nscope: ["we:docs/example.md"]\n---\n## Acceptance\nComplete acceptance criteria here.\n## Pre-mortem\nMissing inputs could hide defects.\n## Tests\nRun the preparation fixtures.\n';
    writeFileSync(join(root, 'card.md'), body);
    const io = createPrepIO({ env: {}, cwd: root, settings, store });
    const card = io.readContext({ action: 'new', id: 'card-321', card: 'card.md', baseSha: 'a'.repeat(40) });
    expect(validate(card.record).ok).toBe(true);
    const brief = io.readContext({ action: 'new', id: 'brief-example', brief: 'card.md', baseSha: 'a'.repeat(40) });
    expect(brief.record.touchSet).toEqual(['docs/example.md']);
    expect(validate(brief.record).ok).toBe(true);
  });
  it('constructs PR records through an injected read-only reader and never overwrites new records', () => {
    const store = createPrepStore({ storeDir: temp(), env: {} });
    const io = createPrepIO({ env: {}, settings: { config: PREP_DEFAULTS, errors: [] }, store,
      readPR: () => ({ body: render(good()), files: [{ path: 'docs/example.md' }], baseRefOid: 'a'.repeat(40) }) });
    const context = io.readContext({ action: 'new', pr: '123' });
    expect(context.record.id).toBe('pr-123');
    expect(context.record.acceptance).toBe(good().acceptance);
    io.sinks[PREP_STORE_EFFECT](context.record);
    expect(io.readContext({ action: 'new', pr: '123' }).errors.join(' ')).toContain('already exists');
    expect(io.readContext({ action: 'check', id: '../bad' }).errors.join(' ')).toContain('Invalid prep id');
  });
});

describe('declared prep operation', () => {
  it('registers once beside review-prep and derives flags from its declaration', () => {
    const declaration = prepOperation({ readContext: () => ({ record: good(), config: PREP_DEFAULTS }) });
    const registry = createRegistry(); registry.register(declaration);
    expect(declaration.name).toBe(PREP_OP);
    expect(buildCliSpec(declaration)).toBeTruthy();
    const runner = readFileSync(join(process.cwd(), 'scripts/operations/run.mjs'), 'utf8');
    expect(runner).toContain('[PREP_OP]:');
    const run = advanceWhileRunning(startRun({ op: PREP_OP, id: 'test-prep', input: { action: 'check', id: 'card-123' }, registry }), { registry });
    expect(run.verdict.flow).toBe('standard');
    expect(run.verdict.write).toBe(false);
    expect(finishPrep({ run, code: 1, lines: [], json: false }).code).toBe(0);
  });
  it('amends paths and fields, retaining the previous record and hash in history', () => {
    const original = good();
    const result = assessPrep({ action: 'amend', touchSet: 'docs/second.md', acceptance: 'Updated acceptance criteria.' }, { record: original, config: PREP_DEFAULTS });
    expect(result.record.touchSet).toContain('docs/second.md');
    expect(result.record.history[0]).toEqual({ hash: original.hash, record: original });
    expect(result.hash).not.toBe(original.hash);
    expect(original.history).toBeUndefined();
  });
  it('reports problems as advice and refuses a write on unreadable evidence', () => {
    expect(assessPrep({ action: 'new' }, { errors: ['Unreadable input'], config: PREP_DEFAULTS })).toEqual({ advice: ['Unreadable input'], write: false });
    expect(finishPrep({ run: { verdict: { advice: ['Missing acceptance'] } }, code: 1 }).code).toBe(0);
    const malformed = assessPrep({ action: 'check' }, { record: { ...good(), touchSet: 'not-an-array' }, config: PREP_DEFAULTS });
    expect(malformed.ok).toBe(false);
    expect(malformed.flow).toBe('opus-design');
    expect(malformed.write).toBe(false);
  });
});
