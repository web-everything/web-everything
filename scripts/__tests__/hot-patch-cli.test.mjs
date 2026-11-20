/**
 * R1100 MVP implementation contract (all exports live in ../hot-patch.mjs):
 * main(argv, { ghJson, spawn, loads, state, stdout, stderr, env }) -> exit code;
 * easternIso(value); verifyPr(prEvidence, { pr, sha });
 * verifyRuleset({ sha, ghJson }); ensureRef({ sha, ghJson });
 * buildLoadArgs({ daemon, sha, pr }) -> prototype-load argument vector.
 * ghJson(argv) returns parsed JSON or throws; spawn(command, argv, options) returns
 * {status}; loads()/state() supply urgent-loads/sweep records (no old S2 ledger).
 * These are deliberate seams for the missing MVP, salvaged from the archived CLI;
 * force-watch, allowlists, wake, rejection ledger and rebuild changes are excluded.
 */
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { main, easternIso, verifyPr, verifyRuleset, ensureRef, buildLoadArgs, reserveHotPatch } from '../hot-patch.mjs';

const homes = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
const repo = 'web-everything/web-everything', prefix = `repos/${repo}`;
const sha = 'a'.repeat(40), other = 'b'.repeat(40), branch = `hotpatch/${sha}`;
const pr = () => ({ number: 42, state: 'OPEN', headRefOid: sha, headRefName: 'lane/repair', baseRefName: 'main',
  headRepository: { nameWithOwner: repo }, isCrossRepository: false });
const rules = () => ['update', 'deletion', 'non_fast_forward'].map(type => ({ type, ruleset_id: 27726920 }));
const liveRuleset = () => ({ id: 27726920, enforcement: 'active', current_user_can_bypass: 'never', bypass_actors: [] });
const ref = (value = sha) => ({ ref: `refs/heads/${branch}`, object: { sha: value } });
function github({ ruleRows = rules(), ruleset = liveRuleset(), evidence = pr(), createError = null, readback = ref() } = {}) {
  return vi.fn(async args => {
    // Every GitHub invocation is explicitly scoped, including api invocations.
    expect(args).toContain('--repo');
    expect(args[args.indexOf('--repo') + 1]).toBe(repo);
    expect(args.join(' ')).not.toMatch(/\{(?:owner|repo)\}/);
    if (args[0] === 'pr') return evidence;
    const path = args.find(a => a.startsWith('repos/'));
    expect(path?.startsWith(`${prefix}/`)).toBe(true);
    if (path === `${prefix}/rules/branches/${branch}`) return ruleRows;
    if (path === `${prefix}/rulesets/27726920`) return ruleset;
    if (path === `${prefix}/git/refs`) {
      expect(args).toContain('POST');
      expect(args).toContain(`ref=refs/heads/${branch}`);
      expect(args).toContain(`sha=${sha}`);
      if (createError) throw createError;
      return ref();
    }
    if (path === `${prefix}/git/ref/heads/${branch}`) return readback;
    throw new Error(`unexpected gh path: ${path}`);
  });
}
function cli(ghJson = github()) {
  let out = '', err = '';
  const io = { ghJson, spawn: vi.fn(() => ({ status: 0 })), loads: () => [], state: () => [], env: { HOME: (() => { const home = mkdtempSync(join(tmpdir(), 'hotpatch-cli-')); homes.push(home); return home; })() },
    stdout: s => { out += s; }, stderr: s => { err += s; } };
  return { io, output: () => out, error: () => err };
}
const request = ['request', '--daemon=review', '--pr=42'];

describe('hot-patch MVP CLI', () => {
  it.each(['CLOSED', 'MERGED'])('refuses PR state %s before ref creation or prototype-load', async state => {
    const ghJson = github({ evidence: { ...pr(), state } }), f = cli(ghJson);
    expect(await main(request, f.io)).toBe(1);
    expect(f.error()).toMatch(/open/i);
    expect(f.io.spawn).not.toHaveBeenCalled();
    expect(ghJson.mock.calls.some(([args]) => args.includes(`${prefix}/git/refs`))).toBe(false);
  });
  it('refuses PR head mismatch against the requested exact sha', async () => {
    await expect(Promise.resolve().then(() => verifyPr({ ...pr(), headRefOid: other }, { pr: 42, sha }))).rejects.toThrow(/head|sha|exact/i);
  });
  it.each([
    ['base', { baseRefName: 'release' }],
    ['foreign repository', { headRepository: { nameWithOwner: 'other/repo' }, isCrossRepository: true }],
  ])('refuses PR %s', async (_, change) => {
    const f = cli(github({ evidence: { ...pr(), ...change } }));
    expect(await main(request, f.io)).toBe(1);
    expect(f.io.spawn).not.toHaveBeenCalled();
  });
  it('verifies active immutable rules with valid matching ruleset ids', async () => {
    const ghJson = github();
    await verifyRuleset({ sha, ghJson });
    expect(ghJson.mock.calls.map(([args]) => args.find(a => a.startsWith('repos/')))).toEqual([
      `${prefix}/rules/branches/${branch}`, `${prefix}/rulesets/27726920`,
    ]);
  });
  it.each([
    ['missing update', { ruleRows: rules().filter(r => r.type !== 'update') }],
    ['missing deletion', { ruleRows: rules().filter(r => r.type !== 'deletion') }],
    ['missing non_fast_forward', { ruleRows: rules().filter(r => r.type !== 'non_fast_forward') }],
    ['inactive', { ruleset: { ...liveRuleset(), enforcement: 'disabled' } }],
    ['bypassable', { ruleset: { ...liveRuleset(), current_user_can_bypass: 'always' } }],
    ['id mismatch', { ruleset: { ...liveRuleset(), id: 27726921 } }],
  ])('refuses ruleset %s on its own field (other ids remain valid)', async (_, change) => {
    await expect(verifyRuleset({ sha, ghJson: github(change) })).rejects.toThrow(/rule|protect|immutable/i);
  });
  it.each([{ actors: [{ actor_id: 1, actor_type: 'Team', bypass_mode: 'always' }] }, { actors: undefined }, { actors: null }])('refuses nonempty or unreadable bypass actors: %j', async ({ actors }) => {
    await expect(verifyRuleset({ sha, ghJson: github({ ruleset: { ...liveRuleset(), bypass_actors: actors } }) })).rejects.toThrow(/bypass|immutable/i);
  });
  it.each([0, 1])('allows only one concurrent request and releases reservation after spawn status %s', async status => {
    const f = cli();
    let release, entered;
    const started = new Promise(r => { entered = r; });
    f.io.spawn = vi.fn(async () => { if (f.io.spawn.mock.calls.length === 1) { entered(); await new Promise(r => { release = r; }); } return { status }; });
    const first = main(request, f.io);
    await started;
    expect(await main(request, f.io)).toBe(1);
    expect(f.error()).toMatch(/reservation|progress|locked/i);
    release();
    expect(await first).toBe(status);
    f.io.spawn = vi.fn(() => ({ status: 0 }));
    expect(await main(request, f.io)).toBe(0);
  });
  it('hands the held reservation to its child while excluding direct requests', async () => {
    const f = cli();
    f.io.spawn = vi.fn((command, _args, options) => {
      const moduleUrl = pathToFileURL(join(process.cwd(), 'scripts/hot-patch.mjs')).href;
      const program = `import { reserveHotPatch } from ${JSON.stringify(moduleUrl)};
        const r = reserveHotPatch({env:process.env, inherited:true}); r.release();`;
      execFileSync(command, ['--input-type=module', '-e', program], { env: options.env, timeout: 10000 });
      expect(() => reserveHotPatch({ env: f.io.env })).toThrow(/reservation/i);
      return { status: 0 };
    });
    expect(await main(request, f.io)).toBe(0);
    const next = reserveHotPatch({ env: f.io.env }); next.release();
  });
  it('refuses forged inherited reservation ownership without releasing its lock', () => {
    const f = cli(), owner = reserveHotPatch({ env: f.io.env });
    try {
      for (const token of [owner.token, 'wrong-token']) {
        expect(() => reserveHotPatch({ env: { ...f.io.env, WE_HOT_PATCH_RESERVATION: token }, inherited: true })).toThrow(/owner/i);
      }
      expect(() => reserveHotPatch({ env: f.io.env })).toThrow(/reservation/i);
    } finally { owner.release(); }
  });
  it('refuses unreadable rules evidence', async () => {
    await expect(verifyRuleset({ sha, ghJson: async () => { throw Error('HTTP 503'); } })).rejects.toThrow();
  });
  it('creates the immutable ref at exactly the sha', async () => {
    const ghJson = github();
    await ensureRef({ sha, ghJson });
    expect(ghJson).toHaveBeenCalledTimes(1);
  });
  it.each([sha, other])('422 already-exists read-back at %s is accepted only at exact sha', async value => {
    const ghJson = github({ createError: Object.assign(Error('Command failed: gh api -X POST .../git/refs\ngh: Reference already exists (HTTP 422)'), {
      status: 1, stderr: Buffer.from('gh: Reference already exists (HTTP 422)\n'),
    }), readback: ref(value) });
    if (value === sha) await ensureRef({ sha, ghJson });
    else await expect(ensureRef({ sha, ghJson })).rejects.toThrow('immutable ref readback sha mismatch');
    expect(ghJson).toHaveBeenCalledTimes(2);
    expect(ghJson.mock.calls[1][0]).toContain(`${prefix}/git/ref/heads/${branch}`);
  });
  it.each([
    ['non-422', 'Reference already exists (HTTP 503)'],
    ['422 without already-exists evidence', 'Validation failed (HTTP 422)'],
  ])('does not read back a status-1 %s creation failure', async (_, detail) => {
    const createError = Object.assign(Error(`Command failed: gh api -X POST .../git/refs\ngh: ${detail}`), {
      status: 1, stderr: Buffer.from(`gh: ${detail}\n`),
    });
    const ghJson = github({ createError });
    await expect(ensureRef({ sha, ghJson })).rejects.toBe(createError);
    expect(ghJson).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['stderr only', 'Command failed: gh api -X POST .../git/refs', 'gh: Reference already exists (HTTP 422)'],
    ['split evidence', 'Command failed: gh api -X POST .../git/refs (HTTP 422)', 'gh: Reference already exists'],
  ])('reads back an existing ref using %s', async (_, message, stderr) => {
    const ghJson = github({ createError: Object.assign(Error(message), { status: 1, stderr: Buffer.from(stderr) }) });
    await ensureRef({ sha, ghJson });
    expect(ghJson).toHaveBeenCalledTimes(2);
    expect(ghJson.mock.calls[1][0]).toContain(`${prefix}/git/ref/heads/${branch}`);
  });
  it('builds the exact prototype-load argv without shell quoting', () => {
    expect(buildLoadArgs({ daemon: 'review', sha, pr: 42 })).toEqual([
      '--daemon=review', `--branch=${branch}`, `--sha=${sha}`, '--urgent', '--reason=R1100 hot-patch PR #42',
    ]);
  });
  it('request uses canonical explicit gh scope, literal API paths and the exact prototype-load argv', async () => {
    const ghJson = github(), f = cli(ghJson);
    expect(await main(request, f.io)).toBe(0);
    expect(ghJson.mock.calls.some(([args]) => args[0] === 'pr' && args.includes('42'))).toBe(true);
    expect(ghJson.mock.calls.some(([args]) => args.includes(`${prefix}/rules/branches/${branch}`))).toBe(true);
    expect(ghJson.mock.calls.some(([args]) => args.includes(`${prefix}/git/refs`))).toBe(true);
    expect(f.io.spawn).toHaveBeenCalledTimes(1);
    const [command, args] = f.io.spawn.mock.calls[0];
    expect(command).toBe(process.execPath);
    expect(args).toEqual(['scripts/operations/run.mjs', 'prototype-load', ...buildLoadArgs({ daemon: 'review', sha, pr: 42 })]);
  });
  it('status prints urgent load and sweep timestamps in ET', async () => {
    const f = cli();
    f.io.loads = () => [{ type: 'prototype-load.urgent', trackingId: 'hot-42', ref: branch, sha, hotPatch: { pr: 42 }, at: '2026-07-15T12:00:00Z' }];
    f.io.state = () => [{ trackingId: 'hot-42', ref: branch, sha, status: 'monitoring-green', at: '2026-07-15T12:05:00Z' }];
    expect(await main(['status'], f.io)).toBe(0);
    expect(f.output()).toContain('2026-07-15T08:00:00-04:00');
    expect(f.output()).toContain('2026-07-15T08:05:00-04:00');
    expect(f.output()).toContain(branch);
    expect(f.output()).toContain('monitoring-green');
    expect(f.io.ghJson).not.toHaveBeenCalled();
  });
  it('easternIso uses date-specific winter and summer offsets', () => {
    expect(easternIso('2026-01-15T12:00:00Z')).toBe('2026-01-15T07:00:00-05:00');
    expect(easternIso('2026-07-15T12:00:00Z')).toBe('2026-07-15T08:00:00-04:00');
  });
});
