import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { checkApprovalTier, createApprovalDeps, main } from '../approval-tier-check.mjs';
import { createCheckDeps } from '../d-r379-check-io.mjs';
import { checkPr } from '../d-r379-check.mjs';
import { buildVerdictRecord } from '../../lib/verdict-ledger.mjs';
import { QUESTION_HASH } from '../codex-audit.mjs';

const repo = 'web-everything/web-everything', head = '6'.repeat(40), base = 'a'.repeat(40);
const load = name => JSON.parse(readFileSync(fileURLToPath(new NodeURL(`../../settings/${name}.json`, import.meta.url)), 'utf8'));
const policy = load('approval-tiers'), pathsPolicy = load('d-r379-protected-paths');
const clear = { head, base, at: '2026-11-02T10:00:00Z', verdict: 'NOT WEAKENED', questionHash: QUESTION_HASH, findings: [] };
const oldFinding = 'blocks/old.ts:12 pre-existing on main; unrelated to this change; tracked in backlog #123';
function deps({ paths = ['docs/examples/example.md'], humanRequired = false, settings = policy, audit = clear, ...extra } = {}) {
  return {
    readPr: async () => ({ headRefOid: head, baseRefName: 'main', title: 'Fix #6244', body: '' }),
    fetchNetDiff: vi.fn(async () => ({ paths, base })), readSettings: async () => pathsPolicy,
    readLabels: async () => ['review:accepted', 'red-team:clear'],
    readReviewLedger: async pr => [buildVerdictRecord({ repo, pr, headSha: head, verdict: 'accepted',
      at: clear.at, source: 'synthetic-fixture', writer: 'fixture' })],
    readAudits: async () => audit ? [audit] : [], readApprovalSettings: async () => structuredClone(settings),
    readRedTeam: async () => ({ head, result: 'clear' }),
    readShape: async () => ({ humanRequired }), readExplicitAsk: async () => null,
    readEmergency: async () => null, readAuthorModelFamily: async () => 'author',
    readJudgeModelFamily: async () => 'judge', stdout: vi.fn(), stderr: vi.fn(), ...extra,
  };
}
// Historical persisted policy cannot re-enable the removed exception.
const exceptionPolicy = () => {
  const settings = structuredClone(policy);
  settings.tiers.standard.allowPreExistingCardedWeakened = true;
  return settings;
};
const check = d => checkApprovalTier(6244, d, repo);
const weakened = findings => ({ ...clear, verdict: 'WEAKENED', findings });
const ask = { quote: 'Please implement this direction.', timestamp: clear.at, rulingId: 'R456' };

describe('approval tiers (synthetic, in-memory evidence)', () => {
  it.each([false, true])('R455 is deferred even with a persisted enabled setting (humanRequired=%s)', async humanRequired => {
    const r = await check(deps({ humanRequired, settings: exceptionPolicy(), audit: weakened([oldFinding]) }));
    expect(r).toMatchObject({ tier: 'human', approvableBy: 'operator' });
    expect(r.reasons.join(' ')).toContain('R455 exception deferred until the audit emits structured findings');
  });
  it.each([
    'scripts/settings/approval-tiers.json',
    'scripts/settings/d-r379-protected-paths.json',
    'scripts/operations/approval-tier-check.mjs',
    'scripts/operations/approval-tier-check-io.mjs',
    'scripts/operations/d-r379-check.mjs',
    'scripts/operations/d-r379-check-io.mjs',
    'scripts/operations/__tests__/approval-tier-check.test.mjs',
    'scripts/operations/__tests__/d-r379-check.test.mjs',
    'docs/agent/decision-rights.md',
    'docs/agent/decision-rights-extra.md',
  ])('approval-policy path %s requires the operator with all evidence clear', async path => {
    for (const humanRequired of [false, true]) {
      const r = await check(deps({ paths: [path], humanRequired, readExplicitAsk: async () => ask }));
      expect(r).toMatchObject({ tier: 'human', approvableBy: 'operator', emergencyEligible: false });
      expect(r.reasons.join(' ')).toContain(`always-human paths: ${path}`);
    }
  });
  it('R455 never passes punctuation-containing net paths mentioned beside an outside path', async () => {
    const path = 'docs/examples/my(file).md';
    const findings = [`${path}:3 and blocks/old.ts pre-existing; backlog #123`];
    const r = await check(deps({ paths: [path], audit: weakened(findings) }));
    expect(r).toMatchObject({ tier: 'human', approvableBy: 'operator' });
    expect(r.reasons.join(' ')).toContain('R455 exception deferred');
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
  it('R455 never reads cards to establish delegation', async () => {
    const cardExists = vi.fn(() => { throw Error('unreadable cards'); });
    const r = await check(deps({ settings: exceptionPolicy(), audit: weakened([oldFinding]), cardExists }));
    expect(r).toMatchObject({ tier: 'human', approvableBy: 'operator' });
    expect(r.reasons.join(' ')).toContain('R455 exception deferred');
    expect(cardExists).not.toHaveBeenCalled();
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
      ['docs/examples/my directory/file.md', 'docs/examples/my directory/file.md'],
    ]) {
      const findings = [`${citedPath}:3 pre-existing on main; backlog #123`];
      const r = await check(deps({ paths: [path], audit: weakened(findings) }));
      expect(r).toMatchObject({ tier: 'human', approvableBy: 'operator', emergencyEligible: false });
      expect(r.reasons.join(' ')).toContain('R455 exception deferred');
    }
  });
  it.each(['a/docs/examples/example.md', 'b/docs/examples/example.md',
    './docs/examples/example.md', './a/docs/examples/example.md', './b/docs/examples/example.md'])
    ('R455 regression: in-diff path alias %s cannot produce standard approval', async path => {
      const findings = [`${path}:3 pre-existing on main; backlog #123`];
      const r = await check(deps({ audit: weakened(findings) }));
      expect(r).toMatchObject({ tier: 'human', approvableBy: 'operator' });
      expect(r.reasons.join(' ')).toContain('R455 exception deferred');
    });
  it.each(['../docs/examples/example.md', 'docs/../docs/examples/example.md',
    '/docs/examples/example.md', 'docs//examples/example.md', 'docs\\examples\\example.md',
    'a/./docs/examples/example.md', '%2e%2e/docs/examples/example.md'])
    ('R455 regression: ambiguous path %s fails closed even beside a carded finding', async path => {
      const findings = [oldFinding, `${path}:3 pre-existing on main; backlog #123`];
      const r = await check(deps({ audit: weakened(findings) }));
      expect(r).toMatchObject({ tier: 'human', approvableBy: 'operator' });
      expect(r.reasons.join(' ')).toContain('R455 exception deferred');
    });
  it.each([
    [false, clear, 'standard'], [true, clear, 'elevated'],
    [false, weakened([oldFinding]), 'human'], [true, weakened([oldFinding]), 'human'],
    [false, weakened(['docs/examples/example.md:3 weakens scope']), 'human'],
    [true, weakened(['docs/examples/example.md:3 weakens scope']), 'human'],
  ])('R454/R455 humanRequired=%s audit=%j => %s', async (humanRequired, audit, tier) => {
    const r = await check(deps({ humanRequired, audit }));
    expect(r.tier).toBe(tier);
    if (audit.verdict === 'WEAKENED') expect(r.reasons.join(' ')).toContain('R455 exception deferred');
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
      const r = await check(deps({ audit: weakened([oldFinding, finding]) }));
      expect(r).toMatchObject({ tier: 'human', approvableBy: 'operator' });
      expect(r.reasons.join(' ')).toContain('R455 exception deferred');
    });
  it('R455 exception settings are removed and the deferral is documented', () => {
    expect(policy.tiers.standard).not.toHaveProperty('allowPreExistingCardedWeakened');
    expect(policy).not.toHaveProperty('preExistingException');
    expect(policy._doc).toContain('R455 exception deferred until the audit emits structured findings');
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
  it.each(['security', 'secret', 'credential', 'authentication', 'AUTHORIZATION', 'token', 'permission', 'access', 'injection', 'bypass', 'escalation', 'sanitization', 'csrf', 'xss', 'traversal', 'leak', 'password', 'key', 'crypto', 'guard', 'gate', 'verdict', 'label', 'approval'])('%s finding in diff prevents emergency', async word => {
    expect((await check(deps({ audit: weakened([`docs/examples/example.md:2 ${word} check removed`]),
      readEmergency: async () => ({ blocking: true, repeatedRefusals: 3 }) }))).emergencyEligible).toBe(false);
  });
  it.each([undefined, [], [''], Array(1001).fill('auth'), ['x'.repeat(4097)]])
    ('invalid or oversized security word settings require operator repair (%#)', async securityFindingWords => {
      const settings = structuredClone(policy);
      settings.emergency1.securityFindingWords = securityFindingWords;
      const r = await check(deps({ settings }));
      expect(r).toMatchObject({ tier: 'unknown', approvableBy: 'operator', emergencyEligible: false });
      expect(r.reasons.join(' ')).toContain('operator');
    });
  it('uses configured security words for emergency exclusion', async () => {
    const settings = structuredClone(policy);
    settings.emergency1.securityFindingWords = ['custom-risk'];
    expect(await check(deps({ settings, audit: weakened(['docs/examples/example.md:2 CUSTOM-RISK check removed']),
      readEmergency: async () => ({ blocking: true, repeatedRefusals: 3 }) })))
      .toMatchObject({ tier: 'human', emergencyEligible: false });
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
    ['labels unreadable', { readLabels: async () => { throw Error(); } }],
    ['emergency throws', { audit: weakened(['docs/examples/example.md:1 assertion removed']), readEmergency: async () => { throw Error(); } }],
    ['control character in diff path', { paths: ['docs/my\tfile.md'] }],
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
  it.each([false, true])('default setting never passes WEAKENED (humanRequired=%s)', async humanRequired => {
    const r = await check(deps({ humanRequired, audit: weakened([oldFinding]) }));
    expect(r).toMatchObject({ tier: 'human', approvableBy: 'operator' });
    expect(r.reasons.join(' ')).toContain('R455 exception deferred');
  });
  it.each(['NOT', 'never', 'no', "isn't", 'isn’t'])('deferred R455 refuses delegation with negation %s near required phrases', async negation => {
    for (const phrase of ['pre-existing on main', 'unrelated to this change']) {
      const finding = oldFinding.replace(phrase, `${negation} ${phrase}`);
      const r = await check(deps({ settings: exceptionPolicy(), audit: weakened([finding]) }));
      expect(r).toMatchObject({ tier: 'human', approvableBy: 'operator' });
      expect(r.reasons.join(' ')).toContain('R455 exception deferred');
    }
  });
  it('security findings outside the diff also exclude emergency approval', async () => {
    expect(await check(deps({ audit: weakened([`${oldFinding}; authentication check removed`]),
      readEmergency: async () => ({ blocking: true, repeatedRefusals: 3 }) })))
      .toMatchObject({ emergencyEligible: false });
  });
  it('unclassifiable WEAKENED prose still requires the operator', async () => {
    const r = await check(deps({ audit: weakened(['unclear']) }));
    expect(r).toMatchObject({ tier: 'human', approvableBy: 'operator', emergencyEligible: false });
    expect(r.reasons.join(' ')).toContain('R455 exception deferred');
  });
  it('uses configured emergency counts and kinds', async () => {
    const settings = structuredClone(policy);
    settings.emergency1.repeatedRefusalCount = 4;
    settings.emergency1.knownWontSelfResolveKinds = ['new-kind'];
    const d = extra => deps({ settings, audit: weakened(['docs/examples/example.md:1 assertion removed']),
      readEmergency: async () => ({ blocking: true, ...extra }) });
    expect((await check(d({ repeatedRefusals: 3 }))).emergencyEligible).toBe(false);
    expect((await check(d({ knownKind: 'new-kind' }))).emergencyEligible).toBe(true);
  });
});

describe('default approval IO', () => {
  it.each([createApprovalDeps, createCheckDeps])('malformed [confirmed] advisory plus later operator block is not clear (%#)', async createDeps => {
    const rows = [{ user: { login: 'chalbert' }, created_at: '2026-11-01T00:00:00Z',
      body: `<!-- we:red-team-advisory pr=6244 rev=${head} -->\n### Post-accept red team\nAdvisory only: this pass never blocks or unblocks the merge. Head \`${head.slice(0, 12)}\` · recorded verdict \`accept\`.\n\n1. [confirmed] (edge-case, degraded) \`scripts/example.mjs:1\` — Degraded behavior.` }];
    const readRedTeam = createDeps({ env: {}, exec: () => JSON.stringify(rows) }).readRedTeam;
    const d = deps({ readRedTeam });
    expect((await check(d)).tier).toBe('standard');
    rows.push({ user: { login: 'chalbert' }, created_at: '2026-11-02T00:00:00Z',
      body: `<!-- we:red-team-gate pr=6244 rev=${head} outcome=operator-block -->\n- 1 confirmed break(s) sent back to the fixer (#1).` });
    expect((await readRedTeam(6244, head)).result).not.toBe('clear');
    expect(await check(d)).toMatchObject({ tier: 'human', approvableBy: 'operator' });
    const reviewed = await checkPr(6244, d, repo);
    expect(reviewed.eligible).toBe(false);
    expect(reviewed.conditions.find(c => c.id === 2).status).toBe('FAIL');
  });
  it.each(['RED-TEAM needs operator review', 'WE:RED-TEAM malformed marker', 'SEND-BACK #1', 'BLOCK #1',
    `<!-- we:red-team-advisory pr=6244 rev=${base} -->`])('later unaccounted mention refuses clearance: %s', async body => {
    const advisory = { user: { login: 'chalbert' }, created_at: clear.at,
      body: `<!-- we:red-team-advisory pr=6244 rev=${head} -->\nAdvisory only: Head \`${head}\` · recorded verdict \`accept\`.` };
    const later = { user: { login: 'untrusted' }, created_at: '2026-11-03T00:00:00Z', body };
    const rows = [advisory, later];
    const readRedTeam = createApprovalDeps({ env: {}, exec: () => JSON.stringify(rows) }).readRedTeam;
    expect(readRedTeam(6244, head).result).toBe('unknown');
    rows.reverse(); // Timestamp order must win over input order.
    expect(readRedTeam(6244, head).result).toBe('unknown');
    rows.reverse();
    later.created_at = clear.at; // Equal timestamps must retain the later comment.
    expect(readRedTeam(6244, head).result).toBe('unknown');
    rows.push({ ...advisory, created_at: '2026-11-04T00:00:00Z' });
    expect(readRedTeam(6244, head).result).toBe('clear');
  });
  it.each([{ body: null, created_at: clear.at }, { body: 'ordinary comment' },
    { body: 'BLOCK', created_at: 'invalid' }, { body: 'ordinary comment', created_at: 123 }])('malformed comment requires operator review: %j', async malformed => {
    const rows = [{ user: { login: 'chalbert' }, created_at: clear.at,
      body: `<!-- we:red-team-advisory pr=6244 rev=${head} -->\nAdvisory only: Head \`${head}\` · recorded verdict \`accept\`.` }, malformed];
    const readRedTeam = createApprovalDeps({ env: {}, exec: () => JSON.stringify(rows) }).readRedTeam;
    const d = deps({ readRedTeam });
    expect(() => readRedTeam(6244, head)).toThrow(/operator review required/);
    expect(await check(d)).toMatchObject({ tier: 'unknown', approvableBy: 'operator' });
    expect((await checkPr(6244, d, repo)).eligible).toBe(false);
  });
  it.each(['sent-back', 'operator-block', 'round-cap'].flatMap(outcome =>
    ['approval-tier-check', 'D-R379 reviewed'].map(consumer => [outcome, consumer])))('advisory accept plus later %s is not clear in %s', async (outcome, consumer) => {
    const rows = [{ user: { login: 'chalbert' }, created_at: '2026-11-01T00:00:00Z',
      body: `<!-- we:red-team-advisory pr=6244 rev=${head} -->\n### Post-accept red team\nAdvisory only: this pass never blocks or unblocks the merge. Head \`${head.slice(0, 12)}\` · recorded verdict \`accept\`.\n\n1. [**confirmed**] (edge-case, degraded) \`scripts/example.mjs:1\` — Degraded behavior.` }];
    const readRedTeam = createApprovalDeps({ env: {}, exec: () => JSON.stringify(rows) }).readRedTeam;
    const d = deps({ readRedTeam });
    expect((await check(d)).tier).toBe('standard');
    expect((await checkPr(6244, d, repo)).conditions.find(c => c.id === 2).status).toBe('PASS');
    rows.push({ user: { login: 'chalbert' }, created_at: '2026-11-02T00:00:00Z',
      body: `<!-- we:red-team-gate pr=6244 rev=${head} outcome=${outcome} -->\n${outcome === 'round-cap'
        ? '- 1 confirmed break(s) NOT sent back: cap (#1).'
        : '- 1 confirmed break(s) sent back to the fixer (#1).'}` });
    if (consumer === 'approval-tier-check') {
      expect(await check(d)).toMatchObject({ tier: 'human', approvableBy: 'operator' });
    } else {
      const reviewed = (await checkPr(6244, d, repo)).conditions.find(c => c.id === 2);
      expect(reviewed.status).toBe('FAIL');
      expect(reviewed.evidence.join(' ')).toContain('red-team not clear');
    }
  });
  it.each([createApprovalDeps, createCheckDeps])('reads the newest trusted current-head red-team verdict through bounded gh api argv (%#)', async createDeps => {
    const record = (rev, verdict, created_at, login = 'chalbert') => ({ user: { login }, created_at,
      body: `<!-- we:red-team-advisory pr=6244 rev=${rev} -->\n### Post-accept red team\nAdvisory only: this comment changes no label itself; Head \`${rev.slice(0, 12)}\` · recorded verdict \`${verdict}\`.` });
    const rows = [record(head, 'accept', '2026-11-01T00:00:00Z'),
      record(head, 'changes', '2026-11-02T00:00:00Z'),
      record(base, 'accept', '2026-11-03T00:00:00Z'),
      record(head, 'accept', '2026-11-04T00:00:00Z', 'untrusted')];
    const exec = vi.fn(() => JSON.stringify(rows));
    const d = createDeps({ exec });
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
