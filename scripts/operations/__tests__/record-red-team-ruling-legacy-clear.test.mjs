// @vitest-environment node
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { planRedTeamRuling, recordRedTeamRulingOperation } from '../record-red-team-ruling.mjs';
import { createRecordRedTeamRulingSinks } from '../record-red-team-ruling-io.mjs';
import { main } from '../record-red-team-ruling-cli.mjs';
import { createMemoryRunStore } from '../run-store.mjs';
import { createMemoryCallLogStore } from '../call-log-store.mjs';
import { parseOperationArgv } from '../cli-adapter.mjs';
import { readRedTeamDisposition, redTeamMarker } from '../../lib/red-team-gate.mjs';
import { sealedStatusPath, sealedFromStatus } from '../../lib/red-team-sealed-status.mjs';
import { syncRedTeamStatusLabels } from '../../lib/red-team-status-labels.mjs';

const repo = 'o/r', pr = 6777, head = 'a'.repeat(40), op = { login: 'chalbert', type: 'User' };
const input = { repo, pr, ruling: 'legacy-clear', actor: 'chalbert', channel: 'chat', reason: 'Reviewed the legacy conflict.' };
let dir, saved, comments, status;
const write = () => { const f = sealedStatusPath({ repo, pr, head }); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(status)); };
const read = () => ({ head, identity: op, comments, labels: ['red-team:blocked'], now: '2026-11-14T22:00:00Z' });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'legacy-clear-')); saved = process.env.CONVEYOR_STATE_ROOT; process.env.CONVEYOR_STATE_ROOT = dir;
  comments = [{ author: { login: 'web-everything' }, body: `${redTeamMarker(pr, head)}\n### Post-accept red team — no break found` }];
  status = { repo, pr, head, status: 'finished', result: 'ran', sealedBreaks: [], legacyHoldPublished: true }; write();
});
afterEach(() => { if (saved === undefined) delete process.env.CONVEYOR_STATE_ROOT; else process.env.CONVEYOR_STATE_ROOT = saved; rmSync(dir, { recursive: true, force: true }); });

describe('legacy-clear operation (design 20–21)', () => {
  it('20 CLI accepts legacy-clear without a break selection', async () => {
    const declaration = recordRedTeamRulingOperation({ readRulingContext: read });
    const argv = Object.entries(input).map(([k,v]) => `--${k}=${v}`);
    expect(parseOperationArgv(declaration, argv).input.ruling).toBe('legacy-clear');
    expect(await main([...argv, '--preview'], { entry: () => ({ declaration, sinks: {} }) })).toBe(0);
  });
  it('20 refuses without a legacy hold', () => {
    delete status.legacyHoldPublished; write();
    expect(() => planRedTeamRuling(read(), input)).toThrow(/legacy hold/i);
  });
  it('20 refuses the acting judge and bot identities', () => {
    expect(() => planRedTeamRuling(read(), { ...input, actor: 'judge:r10' })).toThrow();
    expect(() => planRedTeamRuling({ ...read(), identity: { ...op, type: 'Bot' } }, input)).toThrow(/human/);
  });
  it('20 body round-trips fingerprints and 21 syncs blocked to clear after ruling', async () => {
    const plan = planRedTeamRuling(read(), input);
    const provider = { ensureLabel: vi.fn(), setLabels: vi.fn() };
    const syncLabels = () => syncRedTeamStatusLabels({ repo, pr, head, comments, live: { headRefOid: head, labels: ['red-team:blocked'] }, provider, standingRuling: null });
    expect(syncLabels().add).toBeNull();
    const sinks = createRecordRedTeamRulingSinks({ readThread: () => ({ headRefOid: head, labels: ['red-team:blocked'], comments }),
      resolveIdentity: () => op, readStandingRulingScope: () => null, syncLabels,
      post: (_repo, _pr, body) => comments.push({ author: op, body }) });
    await sinks[plan.effect](plan);
    const s = sealedFromStatus(status, head);
    const fp = createHash('sha256').update(JSON.stringify(s, Object.keys(s).sort())).digest('hex').slice(0, 16);
    expect(comments.at(-1).body).toContain(`- legacy-conflict hold cleared by the operator for seal ${fp}.`);
    expect(comments.at(-1).body).toContain(input.reason);
    expect(readRedTeamDisposition({ repo, pr, head, comments }).held).toEqual([]);
    expect(provider.setLabels).toHaveBeenLastCalledWith(repo, pr, { add: 'red-team:clear', remove: ['red-team:blocked'] });
  });
  it('covers every holding seal in a carry chain; missing coverage or a non-legacy origin holds', async () => {
    const origin = 'b'.repeat(40);
    const source = { ...status, head: origin, sealedBreaks: ['origin'] };
    const f = sealedStatusPath({ repo, pr, head: origin });
    writeFileSync(f, JSON.stringify(source));
    comments = [{ author: { login: 'web-everything' }, body: `${redTeamMarker(pr, origin)}\n### Post-accept red team — no break found` },
      { author: { login: 'web-everything' }, body: `<!-- review-verdict-carried from=${origin} to=${head} patch-id=${'c'.repeat(40)} -->\nReview verdict carried across an identical contribution.\n${comments[0].body}` }];
    const plan = planRedTeamRuling(read(), { ...input, 'acknowledge-omitted': true });
    expect(plan.fingerprints).toHaveLength(2);
    const sinks = createRecordRedTeamRulingSinks({ readThread: () => ({ headRefOid: head, labels: [], comments }),
      resolveIdentity: () => op, readStandingRulingScope: () => null, syncLabels: () => null,
      post: (_repo, _pr, body) => comments.push({ author: op, body }) });
    await sinks[plan.effect](plan);
    expect(comments.at(-1).body.match(/^- legacy-conflict/gm)).toHaveLength(2);
    expect(readRedTeamDisposition({ repo, pr, head, comments }).held).toEqual([]);
    const complete = comments.at(-1).body;
    comments.at(-1).body = complete.replace(/^- legacy-conflict[^\n]*\n/m, '');
    expect(readRedTeamDisposition({ repo, pr, head, comments }).held).toHaveLength(1);
    comments.at(-1).body = complete;
    source.legacyHoldPublished = false; writeFileSync(f, JSON.stringify(source));
    expect(readRedTeamDisposition({ repo, pr, head, comments }).held).toHaveLength(1);
    expect(() => planRedTeamRuling(read(), input)).toThrow(/every holding seal/);
  });
  it.each(['omitted', 'unsealed'])('refuses %s evidence without --acknowledge-omitted and round-trips an acknowledged clear', async kind => {
    if (kind === 'omitted') status.sealedBreaks = ['stored break'];
    else delete status.sealedBreaks;
    write();
    expect(() => planRedTeamRuling(read(), input)).toThrow(/--acknowledge-omitted/);
    const declaration = recordRedTeamRulingOperation({ readRulingContext: read });
    const argv = [...Object.entries(input).map(([k, v]) => `--${k}=${v}`), '--acknowledge-omitted'];
    const parsed = parseOperationArgv(declaration, argv);
    expect(parsed.errors).toEqual([]);
    expect(planRedTeamRuling(read(), parsed.input).effect).toBe('github.red-team-ruling-legacy-clear');
    const sinks = createRecordRedTeamRulingSinks({ readThread: () => ({ headRefOid: head, labels: [], comments }),
      resolveIdentity: () => op, readStandingRulingScope: () => null, syncLabels: () => null,
      post: (_repo, _pr, body) => comments.push({ author: op, body }) });
    expect(await main(argv, { entry: () => ({ declaration, sinks }),
      stores: { store: createMemoryRunStore(), callLog: createMemoryCallLogStore() } })).toBe(0);
    expect(comments.at(-1).body).toContain(`acknowledged omitted breaks=${kind === 'omitted' ? 1 : 0} keys=`);
    expect(readRedTeamDisposition({ repo, pr, head, comments }).held).toEqual([]);
  });
  it.each([{ comments: null }, { labels: null }, { head: 'unknown' }, { comments: [] }])('fails closed on incomplete evidence %j', over => {
    expect(() => planRedTeamRuling({ ...read(), ...over }, input)).toThrow(/unreadable|no red-team result/);
  });
  it('refuses a changed seal at the write boundary', async () => {
    const plan = planRedTeamRuling(read(), input), post = vi.fn();
    status.sealedBreaks = ['changed']; write();
    const sinks = createRecordRedTeamRulingSinks({ readThread: () => ({ headRefOid: head, labels: [], comments }), resolveIdentity: () => op, post });
    await expect(sinks[plan.effect](plan)).rejects.toThrow(/seal|evidence/i); expect(post).not.toHaveBeenCalled();
  });
});
