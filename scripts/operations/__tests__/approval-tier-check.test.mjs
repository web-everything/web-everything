import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { decideTier, main, FLOOR } from '../approval-tier-check.mjs';

const settings = JSON.parse(readFileSync(fileURLToPath(new NodeURL('../../settings/approval-tiers.json', import.meta.url)), 'utf8'));
const head = 'a'.repeat(40);
const facts = (extra = {}) => ({
  head, humanRequired: false, netDiffPaths: ['docs/example.md'],
  pathKinds: { 'docs/example.md': 'harmless' }, categories: [],
  c1: 'PASS', c3: 'PASS', c4: 'PASS', acceptance: 'PASS',
  redTeam: { result: { rev: head, findings: [] }, sendBack: [], held: [] },
  audit: { head, verdict: 'NOT WEAKENED', findings: [] }, explicitAsk: null,
  authorModelFamily: 'claude', judgeModelFamily: 'gpt',
  emergency: { blocking: false, knownKind: null, repeatedRefusals: 0, alreadyFixedReports: 0, noProgressMs: 0 },
  ...extra,
});
const run = (f = facts(), s = settings) => decideTier(f, s);
const weakened = { head, verdict: 'WEAKENED', findings: ['Incorrect arithmetic'] };

describe('thin approval-tier decision', () => {
  it('delegates clear standard facts', () => expect(run()).toMatchObject({ tier: 'standard', approvableBy: 'orchestrator' }));
  it('#6244 dispatch/scope code with WEAKENED stays operator', () => {
    expect(run(facts({ humanRequired: true, netDiffPaths: ['scripts/dispatch.mjs'], pathKinds: { 'scripts/dispatch.mjs': 'other' }, audit: weakened })))
      .toMatchObject({ tier: 'human', approvableBy: 'operator', emergencyEligible: false });
  });
  it('mutation guard: humanRequired alone prevents orchestrator approval', () => {
    expect(run(facts({ humanRequired: true }))).toMatchObject({ tier: 'elevated', approvableBy: 'elevated-judge' });
  });
  it('mutation guard: killSwitch prevents otherwise eligible elevated approval', () => {
    expect(run(facts({ humanRequired: true }), { ...settings, killSwitch: true })).toMatchObject({ tier: 'human' });
    expect(run(facts(), { ...settings, killSwitch: true }).tier).toBe('standard');
  });
  it.each(['.github/workflows/check.yml', 'nested/workflows/build.yml', 'scripts/forge-setup.mjs', 'scripts/settings/approval-tiers.json', 'scripts/operations/approval-tier-check-io.mjs', 'docs/agent/decision-rights-extra.md'])('immutable always-human path %s', path => {
    expect(run(facts({ netDiffPaths: [path], pathKinds: { [path]: 'harmless' } }))).toMatchObject({ tier: 'human', emergencyEligible: false });
  });
  it.each(FLOOR.categories)('immutable category %s', category => {
    expect(run(facts({ categories: [category] })).tier).toBe('human');
  });
  it.each([
    s => { s.alwaysHuman.pathGlobs.pop(); }, s => { s.alwaysHuman.categories = []; },
    s => { s.emergency1.securityFindingWords = []; }, s => { s.emergency1.repeatedRefusals = 2; },
    s => { s.emergency1.alreadyFixedReports = 1; }, s => { s.emergency1.noProgressMs = 1; },
    s => { s.requireDifferentModelFamily = false; }, s => { s.allowPreExistingCardedWeakened = true; },
    s => { s.killSwitch = 'false'; },
  ])('relaxing or invalid settings return unknown and CLI exit 2', async mutate => {
    const s = structuredClone(settings); mutate(s);
    expect(run(facts(), s).tier).toBe('unknown');
    expect(await main(['--pr=1', '--repo=web-everything/web-everything'], { settings: s, gatherFacts: async () => facts(), stdout: () => {}, stderr: () => {} })).toBe(2);
  });
  it('stale-head audit is unknown', () => expect(run(facts({ audit: { ...weakened, head: 'b'.repeat(40) } })).tier).toBe('unknown'));
  it('red-team label alone never clears', () => expect(run(facts({ redTeam: { labels: ['red-team:clear'] } })).tier).toBe('unknown'));
  it('unresolved or stale red-team results cannot delegate', () => {
    for (const redTeam of [{ result: { rev: head }, sendBack: [{}], held: [] }, { result: { rev: 'b'.repeat(40) }, sendBack: [], held: [] }])
      expect(run(facts({ redTeam })).approvableBy).toBe('operator');
  });
  it.each(['humanRequired', 'netDiffPaths', 'pathKinds', 'categories', 'c1', 'c3', 'c4', 'acceptance', 'redTeam', 'audit', 'explicitAsk', 'authorModelFamily', 'judgeModelFamily', 'emergency'])('missing %s fails closed', key => {
    const f = facts(); delete f[key]; expect(run(f).tier).toBe('unknown');
  });
  it('unknown or same model families cannot elevate', () => {
    for (const judgeModelFamily of [null, '', 'unknown', 'CLAUDE']) expect(run(facts({ humanRequired: true, judgeModelFamily })).approvableBy).toBe('operator');
  });
  it('elevated accounts for every path, never relaxing c1 or acceptance', () => {
    for (const extra of [{ c1: 'FAIL' }, { acceptance: 'FAIL' }, { pathKinds: { 'docs/example.md': 'other' } }])
      expect(run(facts({ humanRequired: true, ...extra })).tier).toBe('human');
    expect(run(facts({ c4: 'FAIL', pathKinds: { 'docs/example.md': 'security-critical' } })).tier).toBe('elevated');
  });
  it('direction-setting requires complete explicit ask evidence', () => {
    const ask = { quote: 'Implement this direction', timestamp: '2026-11-03T12:00:00Z', rulingId: 'R459' };
    expect(run(facts({ c3: 'FAIL', explicitAsk: ask })).tier).toBe('elevated');
    for (const key of Object.keys(ask)) { const incomplete = { ...ask }; delete incomplete[key]; expect(run(facts({ c3: 'FAIL', explicitAsk: incomplete })).tier).toBe('human'); }
  });
  it('explicit ask requirements follow configured tier knobs, retaining evidence', () => {
    const s = structuredClone(settings);
    s.explicitAsk.requireRulingId = false;
    const explicitAsk = { quote: 'Implement this direction', timestamp: '2026-11-03T12:00:00Z' };
    expect(run(facts({ c3: 'FAIL', explicitAsk }), s).tier).toBe('elevated');
    expect(run(facts({ c3: 'FAIL', explicitAsk: null }), s).tier).toBe('human');
  });
  it('no R455 exception even for structured pre-existing findings', () => {
    expect(run(facts({ audit: { ...weakened, findings: ['pre-existing; carded #123'], findingsStructured: [{ class: 'pre-existing' }] } })).tier).toBe('human');
  });
  it.each([
    [{}, false], [{ blocking: true }, false], [{ blocking: true, knownKind: 'non-converging-verdict' }, true],
    [{ blocking: true, knownKind: 'invented' }, false], [{ repeatedRefusals: 3 }, false],
    [{ blocking: true, repeatedRefusals: 2 }, false], [{ blocking: true, repeatedRefusals: 3 }, true],
    [{ blocking: true, alreadyFixedReports: 1 }, false], [{ blocking: true, alreadyFixedReports: 2 }, true],
    [{ blocking: true, noProgressMs: 7199999 }, false], [{ blocking: true, noProgressMs: 7200000 }, true],
  ])('EMERGENCY-1 truth table %j => %s', (extra, eligible) => {
    expect(run(facts({ audit: weakened, emergency: { ...facts().emergency, ...extra } })).emergencyEligible).toBe(eligible);
  });
  it('emergency requires WEAKENED as the sole blocker', () => {
    const emergency = { ...facts().emergency, blocking: true, repeatedRefusals: 3 };
    for (const extra of [{ humanRequired: true }, { c1: 'FAIL' }, { c3: 'FAIL' }, { c4: 'FAIL' }, { acceptance: 'FAIL' }, { categories: ['secrets-access'] }, { audit: facts().audit }])
      expect(run(facts({ audit: weakened, emergency, ...extra })).emergencyEligible).toBe(false);
  });
  it.each(FLOOR.securityWords)('security finding %s excludes emergency', word => {
    expect(run(facts({ audit: { ...weakened, findings: [`Finding ${word.toUpperCase()}`] }, emergency: { ...facts().emergency, blocking: true, repeatedRefusals: 3 } })).emergencyEligible).toBe(false);
  });
  it('oversized facts require operator review', () => {
    const result = run(facts({ netDiffPaths: Array(1025).fill('docs/example.md') }));
    expect(result.tier).toBe('unknown'); expect(result.reasons.join(' ')).toContain('operator');
  });
  it('extra protections and tighter emergency thresholds only restrict', () => {
    const s = structuredClone(settings);
    s.alwaysHuman.pathGlobs.push('docs/**');
    expect(run(facts(), s).tier).toBe('human');
    const strict = structuredClone(settings);
    strict.emergency1.repeatedRefusals = 4;
    strict.emergency1.securityFindingWords.push('arithmetic');
    expect(run(facts({ audit: weakened, emergency: { ...facts().emergency, blocking: true, repeatedRefusals: 3 } }), strict).emergencyEligible).toBe(false);
  });
  it('oversized settings fail closed', () => {
    const s = structuredClone(settings);
    s.alwaysHuman.pathGlobs.push(...Array(1025).fill('extra/**'));
    expect(run(facts(), s).tier).toBe('unknown');
  });
  it.each([[65536, 0], [1048576, 2]])('CLI production settings reader bounds reads to 64KiB plus one sentinel byte (input=%s)', async (size, exitCode) => {
    // Valid JSON followed by whitespace: removing the size guard must not merely cause a parse error.
    const payload = Buffer.from(JSON.stringify(settings).padEnd(size, ' '));
    const expectedFile = fileURLToPath(new NodeURL('../../settings/approval-tiers.json', import.meta.url));
    const reads = [];
    let consumed = 0;
    const settingsIO = {
      openSync: vi.fn(file => {
        if ((typeof file === 'string' ? file : fileURLToPath(file)) !== expectedFile) throw Object.assign(new Error('fixture: no platform override'), { code: 'ENOENT' });
        return 42;
      }),
      fstatSync: vi.fn(() => ({ isFile: () => true })),
      readSync: vi.fn((fd, buffer, offset, length, position) => {
        expect(fd).toBe(42);
        expect(position).toBeNull();
        expect(offset).toBeGreaterThanOrEqual(0);
        expect(offset + length).toBeLessThanOrEqual(buffer.length);
        const bytes = Math.min(length, 8192, payload.length - consumed);
        payload.copy(buffer, offset, consumed, consumed + bytes);
        reads.push({ start: consumed, requested: length, bytes, capacity: buffer.length });
        consumed += bytes;
        return bytes;
      }),
      closeSync: vi.fn(),
    };
    const stdout = vi.fn(), gatherFacts = vi.fn(async () => facts());
    expect(await main(['--pr=1', '--repo=web-everything/web-everything'], {
      settingsIO, gatherFacts, stdout, stderr: () => {},
    })).toBe(exitCode);
    expect(consumed).toBe(Math.min(size, 65537));
    expect(reads.length).toBeGreaterThan(1); // Exercise partial reads, not just the first allocation.
    for (const read of reads) {
      expect(read.capacity).toBe(65537);
      expect(read.start + read.requested).toBeLessThanOrEqual(65537);
      expect(read.start + read.bytes).toBeLessThanOrEqual(65537);
    }
    expect(settingsIO.closeSync).toHaveBeenCalledTimes(1);
    expect(settingsIO.closeSync).toHaveBeenCalledWith(42);
    const decision = JSON.parse(stdout.mock.calls[0][0]);
    if (exitCode === 2) {
      expect(decision).toMatchObject({ tier: 'unknown', approvableBy: 'operator', emergencyEligible: false });
      expect(decision.reasons.join(' ')).toContain('settings exceed 64KiB bound; operator review required');
      expect(gatherFacts).not.toHaveBeenCalled();
    } else {
      expect(decision.tier).toBe('standard');
      expect(gatherFacts).toHaveBeenCalledOnce();
    }
  });
  it('default CLI reports absent upstream gatherer, with exit 2', async () => {
    const output = [];
    expect(await main(['--pr=1', '--repo=web-everything/web-everything'], { settings, stdout: s => output.push(s), stderr: s => output.push(s) })).toBe(2);
    expect(output.join(' ')).toContain('d-r379-check.mjs');
  });
  it.each([['standard', 0], ['elevated', 0], ['human', 1], ['unknown', 2]])('CLI exit for %s', async (tier, code) => {
    const f = facts(tier === 'elevated' ? { humanRequired: true } : tier === 'human' ? { c1: 'FAIL' } : tier === 'unknown' ? { c1: undefined } : {});
    expect(await main(['--pr=1', '--repo=web-everything/web-everything'], { settings, gatherFacts: async () => f, stdout: () => {}, stderr: () => {} })).toBe(code);
  });
});
