import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildChangeEvidence } from '../change-evidence/record.mjs';
import { writeChangeEvidenceForMerged, backfillChangeEvidence, resolveChangeEvidenceMode } from '../change-evidence/writer.mjs';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/change-evidence');
const read = name => JSON.parse(fs.readFileSync(path.join(fixtures, name), 'utf8'));
const pr = read('pr-7289.json'), sha = pr.mergeCommit.oid;
const configBytes = fs.readFileSync(path.join(fixtures, 'policy.json'));
const input = () => ({ pr: structuredClone(pr), events: read('events-7289.json'), comments: read('comments-7289.json'),
  mergeCommit: read(`commit-${sha}.json`), commits: pr.commits.map(c => read(`commit-${c.oid}.json`)),
  checkRuns: read(`mcr-${sha}.json`).check_runs, config: JSON.parse(configBytes), configBytes,
  recordedAt: '2026-11-21T15:00:00Z', recorder: 'https://everstandards.dev/ship/tools/change-evidence-build' });
const clause = (x, id) => buildChangeEvidence(x).predicate.clauses.find(c => c.clause === id).verdict;
const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function harness() {
  const coordination = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'change-evidence-')); dirs.push(coordination);
  const x = input(), emit = vi.fn();
  const gh = vi.fn(args => {
    if (args[0] === 'pr') return args[1] === 'list' ? [{ number: pr.number }] : x.pr;
    const endpoint = args[1];
    if (endpoint.includes('/events?')) return x.events;
    if (endpoint.includes('/comments?')) return x.comments;
    if (endpoint.includes('/pulls/') && endpoint.includes('/commits?')) return x.commits;
    if (endpoint.includes('/check-runs?')) return { total_count: x.checkRuns.length, check_runs: x.checkRuns };
    if (endpoint.endsWith(`/commits/${sha}`)) return x.mergeCommit;
    throw Error(`unexpected read ${args}`);
  });
  const options = { coordination, gh, emit, configBytes, mode: 'shadow', merged: [{ num: pr.number, repo: null }], queueFollowUps: [] };
  const dir = path.join(coordination, 'change-evidence/shadow/web-everything__web-everything');
  return { x, gh, emit, options, dir, file: path.join(dir, `${pr.number}-${sha}.json`),
    pending: () => JSON.parse(fs.readFileSync(path.join(coordination, 'change-evidence-pending.json'), 'utf8')) };
}
const scrub = value => JSON.parse(JSON.stringify(value, (k, v) => ['recordedAt', 'recorder', 'evaluatedAt'].includes(k) ? undefined : v));

it('writes one record per merge whose subject is the landed commit (#7289 fixture)', async () => {
  const h = harness(); await writeChangeEvidenceForMerged(h.options);
  const got = JSON.parse(fs.readFileSync(h.file)), expected = read('expected.json');
  expect(got.subject).toEqual(expected.subject);
  expect(scrub(got.predicate.clauses)).toEqual(scrub(expected.predicate.clauses));
  expect(got.predicate.change.merged.method).toBe('merge-queue');
  expect(fs.readdirSync(h.dir).filter(n => n.endsWith('.json'))).toHaveLength(1);
});
it('a failed read leaves the merge pending and writes no pass record', async () => {
  const h = harness(); h.gh.mockImplementation(() => { throw Error('unreadable'); });
  await writeChangeEvidenceForMerged(h.options);
  expect(h.pending()).toHaveLength(1); expect(fs.existsSync(h.file)).toBe(false);
  expect(h.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'change-evidence-missing' }));
});
it.each(['tested', 'reviewed', 'approved'])('%s passes with complete fixture evidence', id => {
  expect(clause(input(), id).verdict).toBe('pass');
});
it.each(['tested', 'reviewed', 'approved'])('%s is unknown(missing) without its evidence', id => {
  const x = input(); x[{ tested: 'checkRuns', reviewed: 'comments', approved: 'events' }[id]] = [];
  expect(clause(x, id)).toMatchObject({ verdict: 'unknown', reason: 'missing' });
});
it('tested fails on failure and is stale on another commit', () => {
  const x = input(); x.checkRuns.forEach(r => { r.head_sha = 'a'.repeat(40); });
  expect(clause(x, 'tested')).toMatchObject({ verdict: 'unknown', reason: 'stale' });
  x.checkRuns.forEach(r => { r.conclusion = 'failure'; }); expect(clause(x, 'tested').verdict).toBe('fail');
});
it('reviewed is stale when accepted evidence misses head', () => {
  const x = input(); x.pr.headRefOid = 'a'.repeat(40);
  expect(clause(x, 'reviewed')).toMatchObject({ verdict: 'unknown', reason: 'stale' });
});
it('approved fails when the authorized label was removed before merge', () => {
  const x = input(); x.events.push({ event: 'unlabeled', label: { name: 'review:accepted' }, created_at: x.pr.mergedAt });
  expect(clause(x, 'approved').verdict).toBe('fail');
});
it('ignores wrong-producer approval and review, including forged restamps', () => {
  const x = input(); x.events.forEach(e => { if (e.actor) e.actor.login = 'intruder'; });
  x.comments.forEach(c => { c.user.login = 'intruder'; });
  for (const id of ['approved', 'reviewed']) expect(clause(x, id)).toMatchObject({ verdict: 'unknown', reason: 'missing' });
});
it('chooses check runs by highest id, including an incomplete newer attempt', () => {
  const x = input(), run = x.checkRuns.find(r => r.name === x.config.clauses.tested.requiredChecks[0]);
  x.checkRuns.push({ ...run, id: Math.max(...x.checkRuns.map(r => r.id)) + 1, conclusion: 'failure', completed_at: '2020-01-01T00:00:00Z' });
  expect(clause(x, 'tested').verdict).toBe('fail');
  x.checkRuns.at(-1).status = 'in_progress';
  expect(clause(x, 'tested')).toMatchObject({ verdict: 'unknown', reason: 'missing' });
});
it('verifies the landed commit returned by the forge', () => {
  const x = input(); x.mergeCommit.sha = x.pr.headRefOid;
  expect(() => buildChangeEvidence(x)).toThrow(/landed/);
});
it('writes atomically and clears pending only after write and index', async () => {
  const h = harness(), order = [];
  const io = { ...fs, renameSync: (src, dst) => {
    if (dst === h.file) { expect(fs.existsSync(dst)).toBe(false); expect(h.pending()).toHaveLength(1); order.push('rename'); }
    fs.renameSync(src, dst);
  }, appendFileSync: (file, bytes) => {
    expect(fs.existsSync(h.file)).toBe(true); expect(h.pending()).toHaveLength(1); order.push('index'); fs.appendFileSync(file, bytes);
  } };
  await writeChangeEvidenceForMerged({ ...h.options, io });
  expect(order).toEqual(['rename', 'index']); expect(h.pending()).toEqual([]);
});
it('rolls back a record on index failure and retries pending idempotently', async () => {
  const h = harness(); await writeChangeEvidenceForMerged({ ...h.options, io: { ...fs, appendFileSync: () => { throw Error('disk full'); } } });
  expect(h.pending()).toHaveLength(1); expect(fs.existsSync(h.file)).toBe(false);
  await writeChangeEvidenceForMerged({ ...h.options, merged: [] });
  const bytes = fs.readFileSync(h.file, 'utf8'); h.gh.mockClear();
  await writeChangeEvidenceForMerged(h.options);
  expect(fs.readFileSync(h.file, 'utf8')).toBe(bytes);
  expect(fs.readFileSync(path.join(h.dir, 'index.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
  expect(h.pending()).toEqual([]);
});
it.each(['direct', 'queue'])('%s merge yields exactly one record despite duplicate follow-ups', async kind => {
  const h = harness(); if (kind === 'direct') h.x.events = h.x.events.filter(e => !e.event.includes('merge_queue'));
  await writeChangeEvidenceForMerged({ ...h.options, queueFollowUps: h.options.merged });
  expect(JSON.parse(fs.readFileSync(h.file)).predicate.change.merged.method).toBe(kind === 'queue' ? 'merge-queue' : 'merge');
  expect(fs.readFileSync(path.join(h.dir, 'index.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
});
it('off performs no IO and on remains shadow', async () => {
  const h = harness(); await writeChangeEvidenceForMerged({ ...h.options, mode: 'off' }); expect(h.gh).not.toHaveBeenCalled();
  await writeChangeEvidenceForMerged({ ...h.options, mode: 'on' }); expect(fs.existsSync(h.file)).toBe(true);
});
it('resolves setting precedence and reports provenance', () => {
  const resolved = resolveChangeEvidenceMode({ tool: { mode: 'off' }, platform: { mode: 'on' }, env: { WE_CHANGE_EVIDENCE_MODE: 'shadow' } });
  expect(resolved.value.mode).toBe('shadow'); expect(resolved.sources.mode).toBe('env');
});
it('a capped page fails closed with operator fallback', async () => {
  const h = harness(), original = h.gh.getMockImplementation();
  h.gh.mockImplementation(args => args[1]?.includes('/events?') ? Array.from({ length: 100 }, () => h.x.events[0]) : original(args));
  await writeChangeEvidenceForMerged({ ...h.options, maxPages: 1 });
  expect(fs.existsSync(h.file)).toBe(false); expect(h.pending()).toHaveLength(1);
  expect(h.emit.mock.calls[0][0].detail.reason).toMatch(/backfill|operator/);
});
it('backfills a bounded merged PR listing through the same writer', async () => {
  const h = harness(); await backfillChangeEvidence({ ...h.options, since: '2026-11-21' });
  expect(fs.existsSync(h.file)).toBe(true);
  expect(h.gh.mock.calls[0][0]).toContain('merged:>=2026-11-21');
});
it('backfill never emits daemon events and its call budget scales with the merge count', async () => {
  const h = harness(), original = h.gh.getMockImplementation();
  h.gh.mockImplementation(args => { if (args[1]?.includes('/events?')) throw Error('forge unavailable'); return original(args); });
  await backfillChangeEvidence({ ...h.options, since: '2026-11-21' });
  expect(h.emit).not.toHaveBeenCalled(); expect(h.pending()).toHaveLength(1);
  const ok = harness(); await backfillChangeEvidence({ ...ok.options, since: '2026-11-21', maxCalls: 1 });
  expect(fs.existsSync(ok.file)).toBe(true);
});
it.each(['/events?', '/comments?', '/check-runs?', `/commits/${sha}`, '/pulls/'])('failed %s read retains pending without a record', async endpoint => {
  const h = harness(), original = h.gh.getMockImplementation();
  h.gh.mockImplementation(args => { if (args[1]?.includes(endpoint)) throw Error('forge unavailable'); return original(args); });
  await writeChangeEvidenceForMerged(h.options);
  expect(fs.existsSync(h.file)).toBe(false); expect(h.pending()).toHaveLength(1);
  expect(h.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'change-evidence-missing', pr: pr.number }));
});
it('a failed atomic rename leaves no visible record or temporary file', async () => {
  const h = harness();
  await writeChangeEvidenceForMerged({ ...h.options, io: { ...fs, renameSync: (src, dst) => {
    if (dst === h.file) throw Error('rename refused'); fs.renameSync(src, dst);
  } } });
  expect(h.pending()).toHaveLength(1); expect(fs.readdirSync(h.dir)).toEqual([]);
});
it('a partial index append is rolled back before retry', async () => {
  const h = harness();
  await writeChangeEvidenceForMerged({ ...h.options, io: { ...fs, appendFileSync: (file, bytes) => {
    fs.appendFileSync(file, bytes.slice(0, 9)); throw Error('partial append');
  } } });
  expect(fs.existsSync(h.file)).toBe(false); expect(h.pending()).toHaveLength(1);
  await writeChangeEvidenceForMerged({ ...h.options, merged: [] });
  expect(JSON.parse(fs.readFileSync(path.join(h.dir, 'index.jsonl'), 'utf8')).pr).toBe(pr.number);
});
it('failed pending retirement rolls back the record and index', async () => {
  const h = harness();
  await writeChangeEvidenceForMerged({ ...h.options, io: { ...fs, renameSync: (src, dst) => {
    if (dst.endsWith('change-evidence-pending.json') && JSON.parse(fs.readFileSync(src)).length === 0) throw Error('pending write refused');
    fs.renameSync(src, dst);
  } } });
  expect(h.pending()).toHaveLength(1); expect(fs.existsSync(h.file)).toBe(false);
  expect(fs.readFileSync(path.join(h.dir, 'index.jsonl'), 'utf8')).toBe('');
});
it('a crash after record rename is reconciled without changing its bytes', async () => {
  const h = harness(); fs.mkdirSync(h.dir, { recursive: true });
  const bytes = JSON.stringify(buildChangeEvidence(input())); fs.writeFileSync(h.file, bytes);
  await writeChangeEvidenceForMerged(h.options);
  expect(fs.readFileSync(h.file, 'utf8')).toBe(bytes); expect(h.pending()).toEqual([]);
  expect(JSON.parse(fs.readFileSync(path.join(h.dir, 'index.jsonl'), 'utf8')).mergeSha).toBe(sha);
});
it('budget exhaustion preserves every remaining merge for retry', async () => {
  const h = harness(); await writeChangeEvidenceForMerged({ ...h.options, maxCalls: 1 });
  expect(h.gh).toHaveBeenCalledTimes(1); expect(fs.existsSync(h.file)).toBe(false); expect(h.pending()).toHaveLength(1);
});
it('different landed SHAs produce distinct records for the same PR', async () => {
  const h = harness(); await writeChangeEvidenceForMerged(h.options);
  const second = 'b'.repeat(40); h.x.pr.mergeCommit.oid = second; h.x.mergeCommit.sha = second;
  const original = h.gh.getMockImplementation();
  h.gh.mockImplementation(args => args[1]?.endsWith(`/commits/${second}`) ? h.x.mergeCommit : original(args));
  await writeChangeEvidenceForMerged(h.options);
  expect(fs.readdirSync(h.dir).filter(n => n.endsWith('.json'))).toHaveLength(2);
});
it('the drain has exactly one awaited hook immediately after follow-up confirmation', () => {
  const source = fs.readFileSync(path.resolve('scripts/merge-ai-prs.mjs'), 'utf8');
  expect(source.match(/await writeChangeEvidenceForMerged\(/g)).toHaveLength(1);
  expect(source).toMatch(/confirmQueueFollowUps\(queueFollowUps, \{ complete: queueFollowUpsClean \}\);\s+try \{ await writeChangeEvidenceForMerged\(\{ merged, queueFollowUps \}\); \}/);
});
it('binds governance to the exact shipped policy bytes and repo blob URI', async () => {
  const h = harness(); await writeChangeEvidenceForMerged({ ...h.options, configBytes: undefined });
  const record = JSON.parse(fs.readFileSync(h.file));
  const bytes = fs.readFileSync(path.resolve('scripts/lib/change-evidence/data/merge-policy.json'));
  expect(record.predicate.governance.digest.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  expect(record.predicate.governance.config).toBe(JSON.parse(bytes).id);
  expect(record.predicate.governance.config).toContain('/blob/main/scripts/lib/change-evidence/data/merge-policy.json');
});
