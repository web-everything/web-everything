/** unaudited-tip — real Git plans and hermetic fix-ready evidence. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { planRebuild } from '../daemon-rebuild/plan.mjs';
import { makeGit } from '../daemon-rebuild/shared.mjs';
import { makeAuditedTipGate } from '../daemon-rebuild/audited-tip.mjs';
import { resolveOverlayFollowTip } from '../daemon-overlays.mjs';

// Same temp/Git helpers as overlay-pin; local tracking refs avoid network IO entirely.
const temps = [];
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const mktemp = () => { const d = mkdtempSync(join(tmpdir(), 'we-unaudited-tip-')); temps.push(d); return d; };
const gitOk = (cwd, args) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', timeout: 20_000 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
};
const write = (dir, name, content) => { mkdirSync(dirname(join(dir, name)), { recursive: true }); writeFileSync(join(dir, name), content); };
const ref = 'lane/moving';
const record = (sha, extra = {}) => ({ ref, sha, tests: 'green', audit: 'NOT WEAKENED', ...extra });
function evidence() {
  const dir = mktemp();
  const path = join(dir, 'fix-ready.jsonl');
  const platform = join(dir, 'platform.json');
  writeFileSync(platform, '{}');
  return { path, dir, env: {
    WE_FIX_READY_PATH: path, WE_PLATFORM_PREFERENCES_FILE: platform,
    WE_DAEMON_OVERLAY_FOLLOW_TIP: 'audited-only',
  }, save: (...rows) => writeFileSync(path, rows.map(r => JSON.stringify(r)).join('\n')) };
}
async function fixture() {
  const e = evidence();
  const root = join(e.dir, 'repo');
  mkdirSync(root);
  gitOk(root, ['init', '-q', '-b', 'main']);
  const commit = (content) => {
    write(root, 'moving.txt', content);
    gitOk(root, ['add', '-A']);
    gitOk(root, ['commit', '-q', '-m', content]);
    return gitOk(root, ['rev-parse', 'HEAD']);
  };
  const base = commit('base');
  gitOk(root, ['update-ref', 'refs/remotes/origin/main', base]);
  const a = commit('audited A');
  gitOk(root, ['update-ref', `refs/remotes/origin/${ref}`, a]);
  const git = makeGit({
    cwd: root, env: process.env,
    run: (args, opts) => spawnSync('git', args, { ...opts, encoding: 'utf8' }),
  });
  const args = { git, mainRef: 'origin/main', overlays: [{ ref, pr: 42 }], edgeResolve: false };
  e.save(record(a));
  const adopted = await planRebuild({ ...args, headSha: base, auditedTip: makeAuditedTipGate(e.env) });
  expect(adopted.ok).toBe(true);
  const b = commit('clean unaudited B');
  gitOk(root, ['update-ref', `refs/remotes/origin/${ref}`, b]);
  const plan = (extra = {}) => planRebuild({ ...args, headSha: adopted.finalSha, auditedTip: makeAuditedTipGate(e.env), ...extra });
  return { ...e, a, b, base, adopted, plan };
}

describe('unaudited-tip plans', () => {
  it('keeps audited adopted A when clean B has no record, even with noPin', async () => {
    const f = await fixture();
    const p = await f.plan({ noPin: new Set([ref]) });
    expect(p.ok).toBe(true);
    expect(p.applied).toEqual([{ ref, pr: 42, sha: f.a }]);
    expect(p.alerts).toContainEqual({ kind: 'overlay-unaudited-tip', detail: {
      ref, pr: 42, adopted: f.a, newTip: f.b,
      message: `overlay ${ref} keeps its audited adopted head ${f.a.slice(0, 10)}: new tip ${f.b.slice(0, 10)} has no fix-ready + audit record (unaudited-tip)`,
    } });
  });
  it('applies B when B has an audited fix-ready record', async () => {
    const f = await fixture();
    f.save(record(f.a), record(f.b));
    const p = await f.plan();
    expect(p.applied).toEqual([{ ref, pr: 42, sha: f.b }]);
    expect(p.alerts.some(a => a.kind === 'overlay-unaudited-tip')).toBe(false);
  });
  it('follow returns a null gate and applies B without evidence', async () => {
    const f = await fixture();
    const gate = makeAuditedTipGate({ ...f.env, WE_DAEMON_OVERLAY_FOLLOW_TIP: 'follow' });
    expect(gate).toBeNull();
    expect((await f.plan({ auditedTip: gate })).applied).toEqual([{ ref, pr: 42, sha: f.b }]);
  });
  it('does not strand a new registration without an adopted head or record', async () => {
    const f = await fixture();
    f.save();
    const p = await f.plan({ headSha: f.base });
    expect(p.applied).toEqual([{ ref, pr: 42, sha: f.b }]);
    expect(p.alerts.some(a => a.kind === 'overlay-unaudited-tip')).toBe(false);
  });
  it('leaves an established overlay unaffected without reading evidence', async () => {
    const f = await fixture();
    const live = await f.plan({ auditedTip: null });
    const gate = vi.fn(() => false);
    const p = await f.plan({ headSha: live.finalSha, auditedTip: gate });
    expect(p.applied).toEqual([{ ref, pr: 42, sha: f.b }]);
    expect(gate).not.toHaveBeenCalled();
  });
  it('unreadable evidence fails closed to adopted A', async () => {
    const f = await fixture();
    rmSync(f.path);
    expect((await f.plan()).applied).toEqual([{ ref, pr: 42, sha: f.a }]);
  });
});

describe('unaudited-tip evidence and policy', () => {
  it('defaults and invalid values are audited-only; resolves platform/tool/env cascade', () => {
    const f = evidence();
    const settingsPath = join(f.dir, 'settings.json');
    const env = { WE_PLATFORM_PREFERENCES_FILE: f.env.WE_PLATFORM_PREFERENCES_FILE };
    const resolve = (e = env) => resolveOverlayFollowTip(e, { settingsPath });
    expect(resolve()).toBe('audited-only');
    writeFileSync(env.WE_PLATFORM_PREFERENCES_FILE, JSON.stringify({ overlay: { followTip: 'follow' } }));
    expect(resolve()).toBe('follow');
    writeFileSync(settingsPath, JSON.stringify({ overlay: { followTip: 'audited-only' } }));
    expect(resolve()).toBe('audited-only');
    expect(resolve({ ...env, WE_DAEMON_OVERLAY_FOLLOW_TIP: 'follow' })).toBe('follow');
    expect(resolve({ ...env, WE_DAEMON_OVERLAY_FOLLOW_TIP: 'invalid' })).toBe('audited-only');
  });
  it('parses JSONL past bad lines, matches exact ref and case-insensitive sha/audit', () => {
    const f = evidence();
    writeFileSync(f.path, 'bad JSON\nnull\n{}\n' + JSON.stringify(record('ABC', { audit: 'not weakened' })));
    const gate = makeAuditedTipGate(f.env);
    expect(gate(ref, 'abc')).toBe(true);
    expect(gate('LANE/moving', 'abc')).toBe(false);
    expect(gate(ref, 'abd')).toBe(false);
    expect(gate(ref, undefined)).toBe(false);
  });
  it.each([
    { tests: 'red' }, { tests: null }, { audit: null }, { audit: 'NOT WEAKENED extra' },
    { audit: 'WEAKENED' }, { audit: 'WEAKENED', auditRuling: '' },
    { audit: 'WEAKENED', auditRuling: '  ' }, { audit: 'WEAKENED', auditRuling: true },
  ])('rejects incomplete or failing evidence %j', (extra) => {
    const f = evidence();
    f.save(record('abc', extra));
    expect(makeAuditedTipGate(f.env)(ref, 'abc')).toBe(false);
  });
  it('accepts WEAKENED only with a non-empty auditRuling string', () => {
    const f = evidence();
    f.save(record('abc', { audit: 'WEAKENED', auditRuling: 'operator accepted' }));
    expect(makeAuditedTipGate(f.env)(ref, 'abc')).toBe(true);
  });
  it('reads lazily once and fails closed on unreadable files', () => {
    const f = evidence();
    const gate = makeAuditedTipGate(f.env);
    f.save(record('abc'));
    expect(gate(ref, 'abc')).toBe(true);
    f.save(record('def'));
    expect(gate(ref, 'def')).toBe(false);
    const closed = makeAuditedTipGate({ ...f.env, WE_FIX_READY_PATH: f.dir });
    expect(closed(ref, 'abc')).toBe(false);
    expect(makeAuditedTipGate({ ...f.env, WE_FIX_READY_PATH: join(f.dir, 'missing') })(ref, 'abc')).toBe(false);
  });
});
