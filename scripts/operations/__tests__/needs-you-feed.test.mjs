import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { feedPath, diffFeed, itemsFromReport, parseFeedLine, appendLines, replay, unacknowledged, resolveSettings, runOnce, assertProducerCheckout } from '../needs-you-feed.mjs';
import { isReadOnlyOperation } from '../registry.mjs';
import { operatorSessionBootstrapOperation } from '../operator-session-bootstrap.mjs';
import { bootstrapPlan } from '../operator-session-bootstrap-io.mjs';
import { withRealRepo } from './helpers/real-repo.mjs';
const dirs = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'needs-feed-')); dirs.push(d); return d; };
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));
const at = '2026-10-15T12:00:00.000Z';
const item = { repo: 'owner/repo', pr: 12, head: 'abc', kind: 'needs-you', reason: 'ready', pick: 'pick 12' };
describe('feed', () => {
  it('opens, dedupes, clears and keeps previous keys on incomplete reports', () => {
    const first = diffFeed([], [item], at);
    expect(first.lines[0]).toMatch(/^NEEDS-YOU owner\/repo#12 needs-you: ready \| pick: pick 12 /);
    expect(parseFeedLine(first.lines[0])).toMatchObject({ ...item, at });
    expect(diffFeed(first.openKeys, [item], at).lines).toEqual([]);
    const partial = []; partial.incomplete = true;
    expect(diffFeed(first.openKeys, partial, at)).toEqual({ lines: [], openKeys: first.openKeys });
    const cleared = diffFeed(first.openKeys, [], at);
    expect(cleared.openKeys).toEqual([]);
    expect(cleared.lines[0]).toMatch(/^NEEDS-YOU-CLEARED /);
    expect(parseFeedLine(cleared.lines[0])).toMatchObject({ kind: 'cleared', was: 'needs-you', head: 'abc', pr: 12 });
    expect(diffFeed(first.openKeys, [{ ...item, head: 'def' }], at).lines).toHaveLength(2);
  });
  it('maps real queue row shapes and incomplete flag', () => {
    const row = { repo: item.repo, number: 12, head: 'abc' };
    const items = itemsFromReport({ incomplete: true, ready: [{ ...row, pick: 'pick' }], needsYourMerge: [{ ...row, command: 'merge' }], rulingNeeded: [{ ...row, findings: [{ reason: 'red-team-round-cap', summary: 'cap' }], redTeam: true }, { ...row, findings: [{ reason: 'dispute' }] }, row], stoodDown: [row] });
    expect(items.map(i => i.kind)).toEqual(['needs-you', 'needs-you', 'at-round-limit', 'escalated', 'ruling-needed', 'stood-down']);
    expect(items[1].command).toBe('merge'); expect(items.incomplete).toBe(true);
  });
  it('uses section reasons, preserves row reasons and commands, and shows the title separately', () => {
    const row = { repo: 'owner/repo', number: 12, title: 'A PR title' };
    const items = itemsFromReport({ ready: [row, { ...row, reason: 'Specific reason', command: 'custom review' }],
      needsYourMerge: [{ ...row, command: 'human merge' }], rulingNeeded: [row], stoodDown: [row] });
    expect(items.map(i => i.reason)).toEqual([
      'review:human + advisory:accepted, all gates pass — your review', 'Specific reason',
      'approved, only a person may enqueue',
      'review parked with confirmed findings — your block/card/not-real ruling',
      'fix agent asked a question — your judgment; no label changed',
    ]);
    const review = `node scripts/operations/run.mjs review-pr --pr=12 --repo=owner/repo`;
    for (const i of [items[0], items[3]]) {
      expect(i.command).toBe(review);
      expect(i.command).not.toContain('--cwd=');
      expect(i.command).not.toMatch(/(?:^|[\s='"])(?:\/|[A-Za-z]:[\\/])/);
    }
    expect(items[1].command).toBe('custom review');
    expect(items[2].command).toBe('human merge');
    expect(items[4].command).toBeUndefined();
    expect(items.every(i => i.title === row.title)).toBe(true);
    const line = diffFeed([], [items[0]], at).lines[0];
    expect(line.slice(0, line.indexOf(' {"at":'))).toContain(row.title);
    expect(line).toContain(`| pick: ${review}`);
    expect(parseFeedLine(line)).toMatchObject({ title: row.title, reason: items[0].reason });
  });
  it('resolves missing heads once per item before deduping and keeps supplied heads', async () => {
    const home = temp(), checkoutRoot = join(home, 'workspace/.lanes/we/lane-1');
    const exec = vi.fn(() => JSON.stringify({ ready: [
      { repo: 'r', number: 1, title: 'Lookup' }, { repo: 'r', number: 2, head: 'supplied' },
    ] }));
    const gh = vi.fn(() => JSON.stringify({ headRefOid: 'resolved' }));
    const opts = { exec, gh, home, checkoutRoot, env: {}, now: at, log: vi.fn() };
    const first = await runOnce(opts);
    expect(gh).toHaveBeenCalledTimes(1);
    expect(gh).toHaveBeenCalledWith('gh', ['pr', 'view', '1', '--repo', 'r', '--json', 'headRefOid'],
      expect.objectContaining({ cwd: checkoutRoot, encoding: 'utf8', maxBuffer: expect.any(Number), timeout: expect.any(Number) }));
    expect(first.openKeys).toEqual(['r#1@resolved:needs-you', 'r#2@supplied:needs-you']);
    expect(parseFeedLine(first.lines[0]).head).toBe('resolved');
    expect((await runOnce(opts)).lines).toEqual([]);
    gh.mockReturnValue(JSON.stringify({ headRefOid: 'new-head' }));
    expect((await runOnce(opts)).lines).toHaveLength(2);
  });
  it.each(['throws', 'invalid JSON', 'missing head'])('logs head lookup failure (%s) and continues the pass', async failure => {
    const home = temp(), checkoutRoot = join(home, 'workspace/.lanes/we/lane-1');
    const exec = () => JSON.stringify({ ready: [{ repo: 'r', number: 1 }, { repo: 'r', number: 2 }] });
    const gh = vi.fn().mockImplementationOnce(() => {
      if (failure === 'throws') throw Error('lookup failed');
      return failure === 'invalid JSON' ? 'invalid' : '{}';
    }).mockReturnValue(JSON.stringify({ headRefOid: 'second' }));
    const log = vi.fn();
    const result = await runOnce({ exec, gh, home, checkoutRoot, env: {}, now: at, log });
    expect(result.openKeys).toEqual(['r#1@:needs-you', 'r#2@second:needs-you']);
    expect(parseFeedLine(result.lines[0]).head).toBe('');
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/r#1.*head lookup failed/));
    expect(gh).toHaveBeenCalledTimes(2);
  });
  it('appends without replacing bytes and replays and acknowledges open events', () => {
    const path = join(temp(), 'events'); writeFileSync(path, 'existing\n');
    appendLines(path, diffFeed([], [item], at).lines);
    expect(readFileSync(path, 'utf8')).toMatch(/^existing\nNEEDS-YOU /);
    expect(replay({ path, since: at })).toHaveLength(1);
    expect(replay({ path, since: '2026-10-16' })).toEqual([]);
    const ackPath = join(dirname(path), 'ack');
    expect(unacknowledged({ path, ackPath })).toHaveLength(1);
    writeFileSync(ackPath, at); expect(unacknowledged({ path, ackPath })).toEqual([]);
    writeFileSync(ackPath, '2026-10-14');
    appendLines(path, diffFeed([`${item.repo}#12@abc:needs-you`], [], '2026-10-15T13:00:00Z').lines);
    expect(unacknowledged({ path, ackPath })).toEqual([]);
  });
  it('resolves settings env > file > defaults with source', () => {
    expect(resolveSettings({ env: {}, file: {} }).intervalMinutes).toEqual({ value: 2, source: 'default' });
    const s = resolveSettings({ env: { WE_NEEDS_YOU_FEED_INTERVAL_MINUTES: '3', WE_NEEDS_YOU_FEED_ENABLED: 'false' }, file: { intervalMinutes: 5, enabled: true } });
    expect(s.intervalMinutes).toEqual({ value: 3, source: 'env' }); expect(s.enabled.value).toBe(false);
    expect(resolveSettings({ env: {}, file: { intervalMinutes: 5 } }).intervalMinutes.source).toBe('settings');
  });
  it('refuses primary and accepts lane, registered daemon, pinned snapshot and override', () => {
    const home = temp(); const primary = join(home, 'workspace', 'web-everything');
    expect(() => assertProducerCheckout(primary, { env: {} })).toThrow(/primary/i);
    for (const root of [join(home, 'workspace/.lanes/web-everything/lane-1'), join(home, 'workspace/wev-health-watch')]) {
      expect(() => assertProducerCheckout(root, { env: {} })).not.toThrow();
    }
    expect(() => assertProducerCheckout(primary, { env: { WE_NEEDS_YOU_FEED_ALLOW_PRIMARY: '1' } })).not.toThrow();
    const snap = join(home, '.snapshots/code', 'a'.repeat(40)); mkdirSync(snap, { recursive: true }); writeFileSync(join(snap, '.snapshot-complete'), 'ok');
    expect(() => assertProducerCheckout(snap, { env: {} })).not.toThrow();
  });
  it('runs queue from producer checkout, consumes exit-1 JSON and persists partial state', async () => {
    const home = temp(), checkoutRoot = join(home, 'workspace/.lanes/we/lane-1');
    const exec = vi.fn(() => JSON.stringify({ ready: [{ repo: 'r', number: 1, head: 'h' }] }));
    const opts = { exec, home, checkoutRoot, env: {}, now: at, log: vi.fn() };
    await runOnce(opts);
    expect(exec.mock.calls[0][1]).toEqual([join(checkoutRoot, 'scripts/operations/operator-queue.mjs'), '--json']);
    expect(exec.mock.calls[0][2].cwd).toBe(checkoutRoot);
    exec.mockImplementation(() => { throw Object.assign(Error('partial'), { status: 1, stdout: JSON.stringify({ incomplete: true, ready: [] }) }); });
    await runOnce(opts);
    expect(replay({ path: feedPath({ home, env: {} }) })).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dirname(feedPath({ home, env: {} })), 'needs-you-feed-state.json'))).openKeys).toHaveLength(1);
    exec.mockImplementation(() => { throw Object.assign(Error('async partial'), { code: 1, stdout: JSON.stringify({ ready: [] }) }); });
    await runOnce(opts);
    expect(replay({ path: feedPath({ home, env: {} }) })).toHaveLength(1);
    expect(opts.log).toHaveBeenCalledWith(expect.stringContaining('intervalMinutes=2 source=default'));
    expect(opts.log).toHaveBeenCalledTimes(12);
  });
  it('bootstrap reads canonical prompt, quiet rules, monitor and pending events without changing the checkout', async () => {
    await withRealRepo(({ root: home, git }) => {
      const path = feedPath({ home, env: {} }); mkdirSync(dirname(path), { recursive: true });
      writeFileSync(join(dirname(path), 'handoff-webeverything-rules.md'), 'ordinary\nQUIET after ten\nquiet before seven\n');
      appendLines(path, diffFeed([], [item], at).lines);
      git(['add', '.']); // Track snapshot bytes so status also detects content changes.
      const before = git(['status', '--porcelain', '--untracked-files=all']);
      expect(isReadOnlyOperation(operatorSessionBootstrapOperation({ collect: () => bootstrapPlan({ home, env: {}, log: () => {} }) }))).toBe(true);
      const plan = bootstrapPlan({ home, env: {}, log: () => {} });
      expect(plan.cron.schedule).toBe('*/30 * * * *');
      expect(plan.cron.prompt).toContain(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../operator-session/pr-movement-sweep.prompt.md'), 'utf8').trim());
      expect(plan.cron.prompt).toContain('Quiet-hours rules (from handoff rules)');
      expect(plan.cron.prompt).toContain('QUIET after ten'); expect(plan.cron.prompt).not.toContain('ordinary');
      expect(plan.monitorCommand).toContain(path); expect(plan.monitorCommand).toContain('grep --line-buffered NEEDS-YOU');
      expect(plan.unacknowledged).toHaveLength(1); expect(plan.ackCommand).toContain('ack');
      expect(git(['status', '--porcelain', '--untracked-files=all'])).toBe(before);
    });
  });
});
