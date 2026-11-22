import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildChangeEvidence } from '../change-evidence/record.mjs';
import { writeChangeEvidenceForMerged, backfillChangeEvidence } from '../change-evidence/writer.mjs';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/change-evidence');
const read = name => JSON.parse(fs.readFileSync(path.join(fixtures, name), 'utf8'));
function input() {
  const pr = read('pr-7289.json'), config = read('policy.json');
  return { pr, config, configBytes: JSON.stringify(config), events: read('events-7289.json'),
    comments: read('comments-7289.json'), mergeCommit: read(`commit-${pr.mergeCommit.oid}.json`),
    commits: pr.commits.map(c => read(`commit-${c.oid}.json`)),
    checkRuns: read(`mcr-${pr.mergeCommit.oid}.json`).check_runs,
    branchRules: [{ type: 'required_status_checks', parameters: {
      required_status_checks: config.clauses.tested.requiredChecks.map(context => ({ context })) } }],
    branchProtection: { protected: true, protection: { enabled: false } },
    recordedAt: '2026-11-21T15:00:00Z', recorder: 'test' };
}
const verdict = (x, id) => buildChangeEvidence(x).predicate.clauses.find(c => c.clause === id).verdict;
const dirs = [];
afterEach(() => { vi.restoreAllMocks(); dirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })); });
function harness() {
  const x = input(), coordination = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-sendbacks-'));
  dirs.push(coordination);
  const repo = 'web-everything/web-everything';
  const gh = vi.fn(argv => {
    if (argv[0] === 'pr') return x.pr;
    const endpoint = argv[1];
    if (endpoint.includes('/rules/branches/')) return x.branchRules;
    if (endpoint.includes('/branches/')) return x.branchProtection;
    if (endpoint.includes('/pulls?')) return [{ number: x.pr.number, merged_at: x.pr.mergedAt, updated_at: x.pr.mergedAt }];
    if (endpoint.includes('/events?')) return x.events;
    if (endpoint.includes('/comments?')) return x.comments;
    if (endpoint.includes('/pulls/')) return x.commits;
    if (endpoint.includes('/check-runs?')) return { total_count: x.checkRuns.length, check_runs: x.checkRuns };
    if (endpoint.endsWith(`/commits/${x.pr.mergeCommit.oid}`)) return x.mergeCommit;
    throw Error(`unexpected read: ${endpoint}`);
  });
  const emit = vi.fn();
  return { x, gh, emit, coordination, options: { repo, gh, emit, coordination, mode: 'shadow',
    configBytes: x.configBytes, merged: [{ num: x.pr.number, repo: null }] } };
}

it.each(['app/plateau-reviewer', 'APP/PLATEAU-REVIEWER', ' plateau-reviewer[bot] '])(
  'author alias %s cannot independently review or approve through the reviewer bot', login => {
    const x = input(); x.pr.author.login = login;
    expect(verdict(x, 'reviewed').verdict).not.toBe('pass');
    expect(verdict(x, 'approved').verdict).not.toBe('pass');
  });
it.each([undefined, null, '', 'invalid'])(
  'an undated trusted rejection (%s) beats an otherwise passing review', created_at => {
    const x = input(), accepted = x.comments.find(c => c.body.startsWith('✅ review'));
    x.comments.unshift({ ...accepted, id: 999999, created_at, updated_at: created_at, body: '🔁 review — changes requested' });
    expect(verdict(x, 'reviewed').verdict).toBe('fail');
    expect(buildChangeEvidence(x).predicate.verdict.verdict).toBe('fail');
  });
it('a rejection with an unreadable edit time also beats a passing review', () => {
  const x = input(), accepted = x.comments.find(c => c.body.startsWith('✅ review'));
  x.comments.push({ ...accepted, updated_at: 'invalid', body: '🔁 review — changes requested' });
  expect(verdict(x, 'reviewed').verdict).toBe('fail');
});
it.each([undefined, null, ''])('a missing repository (%s) fails before any forge read', async repo => {
  const h = harness();
  await expect(writeChangeEvidenceForMerged({ ...h.options, repo })).rejects.toThrow(/identity|repo/);
  expect(h.gh).not.toHaveBeenCalled();
  expect(h.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'change-evidence-missing' }));
});
it('backfill requires an explicit repository before listing merges', async () => {
  const h = harness();
  await expect(backfillChangeEvidence({ ...h.options, repo: undefined, since: '2026-11-21' })).rejects.toThrow(/repo/);
  expect(h.gh).not.toHaveBeenCalled();
});
it.each([[undefined], [[]], [[{ type: 'required_status_checks', parameters: {} }]]])(
  'missing or incomplete branch protection cannot produce a tested pass: %j', branchRules => {
    const x = input(); x.branchRules = branchRules;
    expect(() => buildChangeEvidence(x)).toThrow(/required.check|protection/);
  });
it('a required check omitted from the policy snapshot fails closed in the collector', async () => {
  const h = harness();
  h.x.branchRules[0].parameters.required_status_checks.push({ context: 'new-required-check' });
  await expect(writeChangeEvidenceForMerged(h.options)).rejects.toThrow(/required.check|protection/);
  expect(JSON.parse(fs.readFileSync(path.join(h.coordination, 'change-evidence-pending.json')))).toHaveLength(1);
  expect(fs.existsSync(path.join(h.coordination, 'change-evidence/shadow'))).toBe(false);
});
it('an unreadable protection endpoint cannot produce a record', async () => {
  const h = harness(), read = h.gh.getMockImplementation();
  h.gh.mockImplementation(argv => { if (argv[1].includes('/rules/branches/')) throw Error('protection unavailable'); return read(argv); });
  await expect(writeChangeEvidenceForMerged(h.options)).rejects.toThrow(/protection unavailable/);
  expect(fs.existsSync(path.join(h.coordination, 'change-evidence/shadow'))).toBe(false);
});
it('a required check from another app cannot satisfy branch protection', () => {
  const x = input(); x.branchRules[0].parameters.required_status_checks[0].integration_id = 999999;
  expect(verdict(x, 'tested').verdict).not.toBe('pass');
});
it('classic protection requirements cannot be omitted from the snapshot', () => {
  const x = input(); x.branchProtection.protection = { required_status_checks: { contexts: ['classic-only-check'] } };
  expect(() => buildChangeEvidence(x)).toThrow(/required.check/);
});
it.each([[undefined], [{ protected: true }], [{ protected: true, protection: { required_status_checks: {} } }]])(
  'unreadable classic protection fails closed: %j', branchProtection => {
    const x = input(); x.branchProtection = branchProtection;
    expect(() => buildChangeEvidence(x)).toThrow(/protection/);
  });
it('collector failure rejects even when the event sink also fails', async () => {
  const h = harness(); h.gh.mockImplementation(() => { throw Error('forge unavailable'); });
  h.emit.mockRejectedValue(Error('event sink unavailable'));
  await expect(writeChangeEvidenceForMerged(h.options)).rejects.toThrow(/forge unavailable/);
  expect(JSON.parse(fs.readFileSync(path.join(h.coordination, 'change-evidence-pending.json')))).toHaveLength(1);
});
it('backfill propagates a per-merge collection failure instead of returning success', async () => {
  const h = harness(), read = h.gh.getMockImplementation();
  h.gh.mockImplementation(argv => { if (argv[0] === 'pr') throw Error('merge unreadable'); return read(argv); });
  await expect(backfillChangeEvidence({ ...h.options, since: '2026-11-21' })).rejects.toThrow(/merge unreadable/);
  expect(h.emit).not.toHaveBeenCalled();
});
it('the drain supplies its actual local repository and reports a rejected writer without aborting', async () => {
  const source = fs.readFileSync(path.resolve('scripts/merge-ai-prs.mjs'), 'utf8');
  const hook = source.slice(source.indexOf('  const queueFollowUpsClean ='), source.indexOf('  // #2222 — a healed tip'));
  const writer = vi.fn().mockRejectedValue(Error('evidence failed'));
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction('DRY_RUN', 'writeChangeEvidenceForMerged', 'mergeStrategy', 'queueFollowUps', 'merged',
    'localWriteRefusal', 'landedLocal', 'localSynced', 'numbered', 'resolveOnLandReport', 'derived', 'localSlug', hook)(
    false, writer, { confirmQueueFollowUps() {} }, [], [{ num: 7, repo: null }], false, false, true, {}, { failed: [] }, {}, 'other/project');
  expect(writer).toHaveBeenCalledWith({ merged: [{ num: 7, repo: null }], queueFollowUps: [], repo: 'other/project' });
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining('change-evidence-missing: evidence failed'));
});
