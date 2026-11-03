import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { checkApprovalTier, classifyFindings as classify, createApprovalDeps, main } from '../approval-tier-check.mjs';
import { buildVerdictRecord } from '../../lib/verdict-ledger.mjs';
import { QUESTION_HASH } from '../codex-audit.mjs';

const repo = 'web-everything/web-everything', head = '6'.repeat(40), base = 'a'.repeat(40);
const load = name => JSON.parse(readFileSync(fileURLToPath(new NodeURL(`../../settings/${name}.json`, import.meta.url)), 'utf8'));
const policy = load('approval-tiers'), pathsPolicy = load('d-r379-protected-paths');
const clear = { head, base, at: '2026-11-02T10:00:00Z', verdict: 'NOT WEAKENED', questionHash: QUESTION_HASH, findings: [] };
const classifyFindings = (findings, paths) => classify(findings, paths, policy.preExistingException?.requiredPhrases);
const oldFinding = 'blocks/old.ts:12 pre-existing on main; unrelated to this change; tracked in backlog #123';
function deps({ paths = ['docs/examples/example.md'], humanRequired = false, settings = policy, audit = clear, ...extra } = {}) {
  return {
    readPr: async () => ({ headRefOid: head, baseRefName: 'main', title: 'Fix #6244', body: '' }),
    fetchNetDiff: vi.fn(async () => ({ paths, base })), readSettings: async () => pathsPolicy,
    readLabels: async () => ['review:accepted', 'red-team:clear'],
    readReviewLedger: async pr => [buildVerdictRecord({ repo, pr, headSha: head, verdict: 'accepted',
      at: clear.at, source: 'synthetic-fixture', writer: 'fixture' })],
    readAudits: async () => audit ? [audit] : [], readApprovalSettings: async () => structuredClone(settings),
    readRedTeam: async () => ({ head, result: 'clear' }), cardExists: async () => true,
    readShape: async () => ({ humanRequired }), readExplicitAsk: async () => null,
    readEmergency: async () => null, readAuthorModelFamily: async () => 'author',
    readJudgeModelFamily: async () => 'judge', stdout: vi.fn(), stderr: vi.fn(), ...extra,
  };
}
const check = d => checkApprovalTier(6244, d, repo);
const weakened = findings => ({ ...clear, verdict: 'WEAKENED', findings });
const ask = { quote: 'Please implement this direction.', timestamp: clear.at, rulingId: 'R456' };

describe('approval tiers (synthetic, in-memory evidence)', () => {
  it('R455 never passes punctuation-containing net paths mentioned beside an outside path', async () => {
    const path = 'docs/examples/my(file).md';
    const findings = [`${path}:3 and blocks/old.ts pre-existing; backlog #123`];
    expect(classifyFindings(findings, [path]).status).not.toBe('PASS');
    expect((await check(deps({ paths: [path], audit: weakened(findings) }))).approvableBy).toBe('operator');
  });
  it.each([false, true])('red-team:clear label cannot replace current-head evidence (elevated=%s)', async humanRequired => {
    for (const [evidence, tier] of [[null, 'unknown'], [{ head: base, result: 'clear' }, 'human'],
      [{ head, result: 'held' }, 'human'], [{ head }, 'human']]) {
      const readRedTeam = vi.fn(async () => evidence);
      expect(await check(deps({ humanRequired, readRedTeam }))).toMatchObject({ tier, approvableBy: 'operator' });
      expect(readRedTeam).toHaveBeenCalledWith(6244, head);
    }
    for (const readRedTeam of [undefined, async () => { throw Error('unreadable red team'); }]) {
      expect(await main(['--pr=6244', `--repo=${repo}`], deps({ humanRequired, readRedTeam }))).toBe(2);
    }
  });
  it('R455 requires an existing card', async () => {
    const cardExists = vi.fn(async () => false);
    expect((await check(deps({ audit: weakened([oldFinding]), cardExists }))).tier).toBe('human');
    expect(cardExists).toHaveBeenCalledWith('123');
    expect((await check(deps({ audit: weakened([oldFinding]), cardExists: async () => { throw Error('unreadable cards'); } }))).tier).toBe('unknown');
  });
  it.each([
    ['secrets-access', 'SECRET access', 'title'],
    ['forge-root-deploy', 'ROOT deployment', 'body'],
    ['irreversible-deletion', 'IRREVERSIBLE removal', 'body'],
    ['pricing-licensing', 'PRICING update', 'title'],
    ['forge-root-deploy', 'docs/examples/DEPLOY.md', 'path'],
  ])('always-human category %s matches %s in %s', async (category, value, field) => {
    const d = deps({ ...(field === 'path' ? { paths: [value] } : {}),
      readPr: async () => ({ headRefOid: head, baseRefName: 'main', title: field === 'title' ? `Fix #6244 ${value}` : 'Fix #6244', body: field === 'body' ? value : '' }) });
    const r = await check(d);
    expect(r).toMatchObject({ tier: 'human', emergencyEligible: false });
    expect(r.reasons.join(' ')).toContain(category);
  });
  it('rejects missing, empty, oversized and unconfigured category keyword lists', async () => {
    for (const categoryKeywords of [undefined, {}, { ...policy.alwaysHuman.categoryKeywords, 'secrets-access': [] },
      { ...policy.alwaysHuman.categoryKeywords, 'secrets-access': Array(1001).fill('secret') },
      { ...policy.alwaysHuman.categoryKeywords, extra: ['extra'] }]) {
      const settings = structuredClone(policy);
      settings.alwaysHuman.categoryKeywords = categoryKeywords;
      expect((await check(deps({ settings }))).tier).toBe('unknown');
    }
  });
  it('R455 rejects whitespace-containing in-diff paths', async () => {
    for (const [path, citedPath] of [
      ['docs/my file.md', 'docs/my file.md'],
      ['docs/my file.md', 'a/docs/my file.md'],
      ['docs/my file.md', './docs/my file.md'],
      ['docs/my file.md', '`docs/my file.md`'],
      ['docs/my directory/file.md', 'docs/my directory/file.md'],
      ['docs/my\tfile.md', 'docs/my\tfile.md'],
    ]) {
      const findings = [`${citedPath}:3 pre-existing on main; backlog #123`];
      expect(classifyFindings(findings, [path]).status, citedPath).toBe('UNKNOWN');
      expect(await check(deps({ paths: [path], audit: weakened(findings) })))
        .toMatchObject({ tier: 'unknown', approvableBy: 'operator', emergencyEligible: false });
    }
  });
  it.each(['a/docs/examples/example.md', 'b/docs/examples/example.md',
    './docs/examples/example.md', './a/docs/examples/example.md', './b/docs/examples/example.md'])
    ('R455 regression: in-diff path alias %s cannot produce standard approval', async path => {
      const findings = [`${path}:3 pre-existing on main; backlog #123`];
      expect(classifyFindings(findings, ['docs/examples/example.md']).status).toBe('FAIL');
      expect(await check(deps({ audit: weakened(findings) })))
        .toMatchObject({ tier: 'human', approvableBy: 'operator' });
    });
  it.each(['../docs/examples/example.md', 'docs/../docs/examples/example.md',
    '/docs/examples/example.md', 'docs//examples/example.md', 'docs\\examples\\example.md',
    'a/./docs/examples/example.md', '%2e%2e/docs/examples/example.md'])
    ('R455 regression: ambiguous path %s fails closed even beside a carded finding', async path => {
      const findings = [oldFinding, `${path}:3 pre-existing on main; backlog #123`];
      expect(classifyFindings(findings, ['docs/examples/example.md']).status).toBe('UNKNOWN');
      expect(await check(deps({ audit: weakened(findings) })))
        .toMatchObject({ tier: 'unknown', approvableBy: 'operator' });
    });
  it.each([
    [false, clear, 'standard'], [true, clear, 'elevated'],
    [false, weakened([oldFinding]), 'standard'], [true, weakened([oldFinding]), 'elevated'],
    [false, weakened(['docs/examples/example.md:3 weakens scope']), 'human'],
    [true, weakened(['docs/examples/example.md:3 weakens scope']), 'human'],
  ])('R454/R455 humanRequired=%s audit=%j => %s', async (humanRequired, audit, tier) => {
    const r = await check(deps({ humanRequired, audit }));
    expect(r.tier).toBe(tier);
    expect(r.approvableBy).toBe(tier === 'standard' ? 'orchestrator' : tier === 'elevated' ? 'elevated-judge' : 'operator');
  });
  it('mutation guard: changing only humanRequired removes orchestrator authority', async () => {
    expect((await check(deps())).approvableBy).toBe('orchestrator');
    expect((await check(deps({ humanRequired: true }))).approvableBy).not.toBe('orchestrator');
  });
  it.each([true, false])('#6244 dispatch/scope code never delegates to orchestrator (humanRequired=%s)', async humanRequired => {
    const r = await check(deps({ humanRequired, paths: ['scripts/dispatch.mjs'],
      audit: weakened(['scripts/dispatch.mjs:3 scope guard removed']) }));
    expect(r.approvableBy).toBe('operator');
    expect(r.tier).toBe('unknown');
  });
  it('mutation guard: changing only killSwitch disables elevated delegation', async () => {
    const settings = structuredClone(policy);
    expect((await check(deps({ humanRequired: true, settings }))).tier).toBe('elevated');
    settings.tiers.elevated.killSwitch = true;
    expect(await check(deps({ humanRequired: true, settings }))).toMatchObject({ tier: 'human', approvableBy: 'operator' });
  });
  it.each([true, false])('always-human paths cannot delegate (humanRequired=%s)', async humanRequired => {
    expect(await check(deps({ humanRequired, paths: ['scripts/forge-setup.mjs'] })))
      .toMatchObject({ tier: 'human', approvableBy: 'operator', emergencyEligible: false });
  });
  it.each([
    ['direction with explicit ask', { readExplicitAsk: async () => ask }, 'elevated'],
    ['missing ask', {}, 'human'],
    ['missing quote', { readExplicitAsk: async () => ({ ...ask, quote: '' }) }, 'human'],
    ['missing timestamp', { readExplicitAsk: async () => ({ ...ask, timestamp: null }) }, 'human'],
    ['missing ruling', { readExplicitAsk: async () => ({ ...ask, rulingId: '' }) }, 'human'],
    ['same family', { readExplicitAsk: async () => ask, readJudgeModelFamily: async () => 'author' }, 'human'],
    ['unknown family', { readExplicitAsk: async () => ask, readJudgeModelFamily: undefined }, 'human'],
  ])('%s => %s', async (_name, extra, tier) => {
    const r = await check(deps({ paths: ['standards/example.test.ts', 'scripts/example-guard.mjs'], ...extra }));
    expect(r.tier).toBe(tier);
    if (tier === 'human') expect(r.reasons.length).toBeGreaterThan(0);
  });
  it.each(['scripts/example-guard.mjs', 'tests/example.spec.ts', 'custom/protected.mjs'])
    ('mixed diff with protected %s names every unknown runtime path and requires human review', async protectedPath => {
      const readSettings = vi.fn(async () => ({ ...pathsPolicy,
        protectedPaths: [...pathsPolicy.protectedPaths, 'custom/protected.mjs'] }));
      const r = await check(deps({ paths: [protectedPath, 'blocks/runtime.ts', 'scripts/runtime.mjs'], readSettings }));
      expect(r).toMatchObject({ tier: 'human', approvableBy: 'operator' });
      expect(r.reasons.join(' ')).toContain('blocks/runtime.ts');
      expect(r.reasons.join(' ')).toContain('scripts/runtime.mjs');
      expect(readSettings).toHaveBeenCalledTimes(1);
    });
  it('an explicit direction ask cannot exempt an unclassified direction path', async () => {
    const r = await check(deps({ paths: ['docs/agent/platform-decisions.md', 'scripts/example-guard.mjs'],
      readExplicitAsk: async () => ask }));
    expect(r.tier).toBe('human');
    expect(r.reasons.join(' ')).toContain('docs/agent/platform-decisions.md');
  });
  it('elevates protected paths mixed only with harmless docs, tests and images', async () => {
    expect((await check(deps({ paths: ['scripts/example-guard.mjs', 'docs/examples/example.md',
      'tests/example.spec.ts', 'assets/example.png'] }))).tier).toBe('elevated');
  });
  it.each(['pre-existing on main', 'unrelated to this change', 'pre-existing; this patch uses it',
    'pre-existing on main; this patch builds on it', 'pre-existing on main; needed for this change'])
    ('R455 refuses incomplete independence evidence: %s', async prose => {
      const finding = `blocks/old.ts:12 ${prose}; backlog #123`;
      expect(classifyFindings([finding], ['docs/examples/example.md']).status).toBe('FAIL');
      expect(classifyFindings([oldFinding, finding], ['docs/examples/example.md']).status).toBe('FAIL');
      expect((await check(deps({ audit: weakened([oldFinding, finding]) }))).tier).toBe('human');
    });
  it('R455 uses every configured required phrase', async () => {
    const settings = structuredClone(policy);
    settings.preExistingException = { requiredPhrases: ['pre-existing on main', 'unrelated to this change', 'independently confirmed'] };
    expect((await check(deps({ settings, audit: weakened([oldFinding]) }))).tier).toBe('human');
    expect((await check(deps({ settings, audit: weakened([`${oldFinding}; independently confirmed`]) }))).tier).toBe('standard');
  });
  it.each([undefined, {}, { requiredPhrases: [] }, { requiredPhrases: [''] },
    { requiredPhrases: Array(1001).fill('phrase') }, { requiredPhrases: ['x'.repeat(4097)] }])
    ('R455 invalid or oversized phrase settings require operator repair (case %#)', async preExistingException => {
      const settings = { ...policy, preExistingException };
      const d = deps({ settings });
      expect(await main(['--pr=6244', `--repo=${repo}`, '--json'], d)).toBe(2);
      expect(JSON.parse(d.stdout.mock.calls[0][0]).reasons.join(' ')).toContain('operator');
    });
  it('elevates a guard path with head-bound red-team acceptance', async () => {
    expect((await check(deps({ paths: ['scripts/example-guard.mjs'] }))).tier).toBe('elevated');
    expect((await check(deps({ paths: ['scripts/example-guard.mjs'], readLabels: async () => ['review:accepted'] }))).tier).toBe('human');
  });
  it.each([
    [{ blocking: true, repeatedRefusals: 3 }, true],
    [{ blocking: true, alreadyFixedReports: 2 }, true],
    [{ blocking: true, noProgressMs: 2 * 3600_000 }, true],
    [{ blocking: true, knownKind: 'approval-gate' }, true],
    [{ blocking: true, knownKind: 'unlisted' }, false],
    [{ blocking: true, repeatedRefusals: 2, alreadyFixedReports: 1, noProgressMs: 7199999 }, false],
    [{ blocking: false, repeatedRefusals: 3 }, false],
    [null, false],
  ])('EMERGENCY-1 %j => %s without changing tier', async (emergency, expected) => {
    expect(await check(deps({ audit: weakened(['docs/examples/example.md:2 assertion removed']),
      readEmergency: async () => emergency }))).toMatchObject({ tier: 'human', emergencyEligible: expected });
  });
  it.each(['security', 'secret', 'credential'])('%s finding in diff prevents emergency', async word => {
    expect((await check(deps({ audit: weakened([`docs/examples/example.md:2 ${word} check removed`]),
      readEmergency: async () => ({ blocking: true, repeatedRefusals: 3 }) }))).emergencyEligible).toBe(false);
  });
  it('clear audit never grants emergency eligibility', async () => {
    expect((await check(deps({ readEmergency: async () => ({ blocking: true, repeatedRefusals: 3 }) }))).emergencyEligible).toBe(false);
  });
  it('red-team hold prevents emergency eligibility', async () => {
    expect(await check(deps({ audit: weakened(['docs/examples/example.md:2 guard removed']),
      readLabels: async () => ['review:accepted', 'red-team:held'],
      readEmergency: async () => ({ blocking: true, repeatedRefusals: 3 }) })))
      .toMatchObject({ tier: 'human', emergencyEligible: false });
  });
  it.each([
    ['shape throws', { readShape: async () => { throw Error('shape failed'); } }],
    ['shape incomplete', { readShape: async () => ({}) }],
    ['malformed audit', { audit: { ...clear, findings: null } }],
    ['stale audit', { audit: { ...clear, head: 'f'.repeat(40) } }],
    ['wrong base', { audit: { ...clear, base: 'b'.repeat(40) } }],
    ['no audit', { audit: null }],
    ['unclassifiable finding', { audit: weakened(['unclear']) }],
    ['labels unreadable', { readLabels: async () => { throw Error(); } }],
    ['emergency throws', { audit: weakened(['docs/examples/example.md:1 guard removed']), readEmergency: async () => { throw Error(); } }],
    ['oversized diff; operator reviews full diff', { paths: Array(10001).fill('x') }],
  ])('fail closed: %s', async (_name, overrides) => {
    const d = deps(overrides);
    expect(await main(['--pr=6244', `--repo=${repo}`, '--json'], d)).toBe(2);
    expect(JSON.parse(d.stdout.mock.calls[0][0])).toMatchObject({ tier: 'unknown', approvableBy: 'operator', emergencyEligible: false });
  });
  it.each([{}, { ...policy, version: 2 }, { ...policy, securityCriticalGlobs: [42] },
    { ...policy, emergency1: { ...policy.emergency1, fallbackNoProgressHours: -1 } }])('invalid settings => exit 2: %j', async settings => {
    expect(await main(['--pr=6244', `--repo=${repo}`], deps({ settings }))).toBe(2);
  });
  it.each([['--pr=6244', '--repo=other/repo'], ['--pr=6244'], ['--pr=0', `--repo=${repo}`]])('rejects unsupported CLI %j', async (...argv) => {
    const d = deps();
    expect(await main(argv, d)).toBe(2);
    expect(d.fetchNetDiff).not.toHaveBeenCalled();
  });
  it.each([[false, 0], [true, 0]])('CLI delegable exit for humanRequired=%s', async (humanRequired, code) => {
    expect(await main(['--pr=6244', `--repo=${repo}`, '--json'], deps({ humanRequired }))).toBe(code);
  });
  it('CLI human exit and single net-diff snapshot', async () => {
    const d = deps({ readPr: async () => ({ headRefOid: head, baseRefName: 'main', title: 'No citation', body: '' }) });
    expect(await main(['--pr=6244', `--repo=${repo}`], d)).toBe(1);
    expect(d.fetchNetDiff).toHaveBeenCalledTimes(1);
  });
  it('ignores stale audits when there is a current-head clear audit', async () => {
    expect((await check(deps({ readAudits: async () => [clear,
      { ...clear, head: 'f'.repeat(40), verdict: 'WEAKENED', findings: ['bad'], at: '2026-11-03T00:00:00Z' }] }))).tier).toBe('standard');
  });
  it('settings can disable the R455 exception', async () => {
    const settings = structuredClone(policy);
    settings.tiers.standard.allowPreExistingCardedWeakened = false;
    expect((await check(deps({ settings, audit: weakened([oldFinding]) }))).tier).toBe('human');
  });
  it('uses configured emergency counts and kinds', async () => {
    const settings = structuredClone(policy);
    settings.emergency1.repeatedRefusalCount = 4;
    settings.emergency1.knownWontSelfResolveKinds = ['new-kind'];
    const d = extra => deps({ settings, audit: weakened(['docs/examples/example.md:1 guard removed']),
      readEmergency: async () => ({ blocking: true, ...extra }) });
    expect((await check(d({ repeatedRefusals: 3 }))).emergencyEligible).toBe(false);
    expect((await check(d({ knownKind: 'new-kind' }))).emergencyEligible).toBe(true);
  });
});

describe('finding classification and default shape IO', () => {
  it.each(['a/blocks/old.ts', 'b/blocks/old.ts', './blocks/old.ts'])
    ('R455 accepts supported outside-diff path form %s', path => {
      expect(classifyFindings([`${path}:12 pre-existing on main; unrelated to this change; backlog #123`],
        ['docs/examples/example.md']).status).toBe('PASS');
    });
  it('R455 retains real a/ and b/ directories when checking Git-prefix ambiguity', () => {
    for (const path of ['a/blocks/old.ts', 'b/blocks/old.ts']) {
      expect(classifyFindings([`${path}:12 pre-existing on main; unrelated to this change; backlog #123`], [path]).status).toBe('FAIL');
    }
  });
  it.each([
    [[oldFinding], 'PASS'], [[oldFinding, 'unclassifiable'], 'UNKNOWN'],
    [['blocks/old.ts:1 pre-existing but uncarded'], 'FAIL'],
    [['blocks/old.ts:1 pre-existing; backlog pending'], 'FAIL'],
    [['docs/examples/example.md:1 pre-existing #123'], 'FAIL'], [[], 'UNKNOWN'],
  ])('classifies every finding: %j', (findings, status) => {
    expect(classifyFindings(findings, ['docs/examples/example.md']).status).toBe(status);
  });
  it('reads the newest trusted current-head red-team verdict through bounded gh api argv', async () => {
    const record = (rev, verdict, created_at, login = 'chalbert') => ({ user: { login }, created_at,
      body: `<!-- we:red-team-advisory pr=6244 rev=${rev} -->\n### Post-accept red team\nAdvisory only: this comment changes no label itself; Head \`${rev.slice(0, 12)}\` · recorded verdict \`${verdict}\`.` });
    const rows = [record(head, 'accept', '2026-11-01T00:00:00Z'),
      record(head, 'changes', '2026-11-02T00:00:00Z'),
      record(base, 'accept', '2026-11-03T00:00:00Z'),
      record(head, 'accept', '2026-11-04T00:00:00Z', 'untrusted')];
    const exec = vi.fn(() => JSON.stringify(rows));
    const d = createApprovalDeps({ exec });
    expect(await d.readRedTeam(6244, head)).toEqual({ head, result: 'changes' });
    rows.push(record(head, 'accept', '2026-11-05T00:00:00Z'));
    expect(await d.readRedTeam(6244, head)).toEqual({ head, result: 'clear' });
    expect(exec).toHaveBeenCalledWith('gh', ['api', `repos/${repo}/issues/6244/comments?per_page=100&page=1`],
      expect.objectContaining({ timeout: 60_000, maxBuffer: 1024 * 1024 }));
    expect(await createApprovalDeps({ exec: () => JSON.stringify([record(base, 'accept', clear.at)]) }).readRedTeam(6244, head)).toBeNull();
    expect(await createApprovalDeps({ exec: () => JSON.stringify([{ ...rows[0], body: `quoted marker: ${rows[0].body}` }]) }).readRedTeam(6244, head)).toBeNull();
  });
  it('red-team incomplete, unreadable, oversized and page-capped comments require operator repair', async () => {
    for (const exec of [() => { throw Error('offline'); }, () => '{}',
      () => JSON.stringify([{ body: null }]), () => 'x'.repeat(1024 * 1024 + 1),
      () => JSON.stringify(Array.from({ length: 100 }, () => ({ body: '' })))]) {
      const d = deps({ readRedTeam: createApprovalDeps({ exec }).readRedTeam });
      expect(await main(['--pr=6244', `--repo=${repo}`], d)).toBe(2);
      expect((await check(d)).reasons.join(' ')).toContain('operator');
    }
    const exec = vi.fn(() => JSON.stringify(Array.from({ length: 100 }, () => ({ body: '' }))));
    expect(() => createApprovalDeps({ exec }).readRedTeam(6244, head)).toThrow(/page cap/);
    expect(exec).toHaveBeenCalledTimes(10);
  });
  it('default cardExists checks a real matching backlog file in the selected checkout', () => {
    const entry = (name, file = true) => ({ name, isFile: () => file });
    const readdirSync = vi.fn(() => [entry('123-old.md'), entry('456-directory.md', false), entry('789-other.txt')]);
    const d = createApprovalDeps({ cwd: 'fixture-checkout', fs: { readdirSync } });
    expect(d.cardExists('123')).toBe(true);
    for (const id of ['12', '456', '789', '999']) expect(d.cardExists(id)).toBe(false);
    expect(readdirSync).toHaveBeenCalledWith('fixture-checkout/backlog', { withFileTypes: true });
    expect(() => d.cardExists('../123')).toThrow();
    expect(() => createApprovalDeps({ fs: { readdirSync: () => { throw Error('unreadable'); } } }).cardExists('123')).toThrow('unreadable');
  });
  it('uses bounded argv-only shape invocation through injectable IO', async () => {
    const exec = vi.fn(async () => JSON.stringify({ humanRequired: true }));
    const d = createApprovalDeps({ exec });
    expect(await d.readShape(['scripts/a.mjs', 'scripts/b.mjs'])).toEqual({ humanRequired: true });
    expect(exec).toHaveBeenCalledWith(process.execPath,
      ['scripts/review-core-cli.mjs', 'shape', '--files=scripts/a.mjs,scripts/b.mjs', '--json'],
      expect.objectContaining({ timeout: expect.any(Number), maxBuffer: expect.any(Number) }));
  });
  it('refuses lossy comma-delimited shape input', async () => {
    const exec = vi.fn();
    await expect(createApprovalDeps({ exec }).readShape(['scripts/a,b.mjs'])).rejects.toThrow();
    expect(exec).not.toHaveBeenCalled();
  });
});
