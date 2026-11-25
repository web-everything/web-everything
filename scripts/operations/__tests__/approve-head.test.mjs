import { describe, it, expect, vi } from 'vitest';
import { runApproveHead, rulingExistsIn } from '../approve-head.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const A = 'c'.repeat(40);
const mk = (over = {}) => {
  const gh = vi.fn((args) => args.includes('--jq') && args[1].includes('pulls') ? A : args[1] === 'user' ? 'chalbert' : '1');
  return { gh, exec: vi.fn(() => 'chalbert'), resolveBin: vi.fn(() => '/real/gh'), env: {},
    readRulings: () => 'R474 guard config\nR475 other\n', ...over };
};
const posted = gh => gh.mock.calls.some(c => c[0].includes('POST'));

describe('approve-head', () => {
  it.each(['R55 — plain', '- R55 — list', '- **R55** — bold', '## R55 — heading', '- **R55-R59** — range',
    '### **R55–R59** — range', '## R55—R59 — range'])('recognises declaration shape: %s', text => {
    const exists = rulingExistsIn(text);
    expect(exists('R55')).toBe(true);
    if (text.includes('R59')) {
      expect(exists('R57')).toBe(true);
      expect(exists('R59')).toBe(true);
    }
    expect(exists('R5')).toBe(false);
    expect(exists('R60')).toBe(false);
  });
  it.each(['## R55X', 'mentions R55', '## R55-R59X', '- **R59-R55**', '## R55-R999999999999999999999'])
    ('refuses non-declarations and malformed ranges: %s', text => {
      expect(rulingExistsIn(text)('R55')).toBe(false);
    });
  it('uses the real gh with personal credentials for identity and the App channel for writes', () => {
    const env = { PATH: '/shim:/real', GH_TOKEN: 'app', GITHUB_TOKEN: 'app', GH_ENTERPRISE_TOKEN: 'app',
      GITHUB_ENTERPRISE_TOKEN: 'app', WE_GH_AUTH_SOURCE: 'app', WE_GH_AUTH_TOKEN_HASH: 'hash', KEEP: 'yes' };
    const exec = vi.fn(() => 'chalbert\n');
    const resolveBin = vi.fn(() => '/real/gh');
    const deps = mk({ env, exec, resolveBin });
    expect(runApproveHead(['--repo=o/r', '--pr=5', '--ruling=R474'], deps).ok).toBe(true);
    expect(resolveBin).toHaveBeenCalledWith({ pathEnv: env.PATH });
    expect(exec).toHaveBeenCalledWith('/real/gh', ['api', '--hostname', 'github.com', 'user', '--jq', '.login'],
      expect.objectContaining({ env: { PATH: env.PATH, KEEP: 'yes' }, timeout: 60_000, maxBuffer: 1024 * 1024 }));
    expect(deps.gh.mock.calls.some(([args]) => args.includes('user'))).toBe(false);
    expect(posted(deps.gh)).toBe(true);
    expect(env.GH_TOKEN).toBe('app');
  });
  it('dry run reads personal identity and probes the App without posting', () => {
    const deps = mk();
    expect(runApproveHead(['--repo=o/r', '--pr=5', '--ruling=R474', '--dry-run'], deps))
      .toMatchObject({ ok: true, dryRun: true, headSha: A });
    expect(deps.gh.mock.calls.some(([args]) => args[1]?.includes('installation/repositories'))).toBe(true);
    expect(posted(deps.gh)).toBe(false);
  });
  it('accepts a ruling declared as a markdown heading', () => {
    const deps = mk({ readRulings: () => '## R1111 — operator ruling\n' });
    expect(runApproveHead(['--repo=o/r', '--pr=5', '--ruling=R1111'], deps).ok).toBe(true);
    expect(posted(deps.gh)).toBe(true);
  });
  it('unknown ruling id writes nothing', () => {
    const deps = mk();
    expect(runApproveHead(['--repo=o/r', '--pr=5', '--ruling=R999'], deps).ok).toBe(false);
    expect(posted(deps.gh)).toBe(false);
  });
  it('a ruling id that only prefixes a known one is unknown', () => {
    const deps = mk();
    expect(runApproveHead(['--repo=o/r', '--pr=5', '--ruling=R47'], deps).ok).toBe(false);
    expect(posted(deps.gh)).toBe(false);
  });
  it('a ruling id followed by letters or digits does not match (exact, anchored)', () => {
    for (const text of ['R474X guard config\n', 'x mentions R474 in passing\n', 'R4745 other\n']) {
      const deps = mk({ readRulings: () => text });
      expect(runApproveHead(['--repo=o/r', '--pr=5', '--ruling=R474'], deps).ok).toBe(false);
      expect(posted(deps.gh)).toBe(false);
    }
    expect(runApproveHead(['--repo=o/r', '--pr=5', '--ruling=R474'], mk({ readRulings: () => '- **R474** (operator): x\n' })).ok).toBe(true);
  });
  it('a non-operator login writes nothing', () => {
    const deps = mk({ exec: vi.fn(() => 'mallory') });
    expect(runApproveHead(['--repo=o/r', '--pr=5', '--ruling=R474'], deps).ok).toBe(false);
    expect(posted(deps.gh)).toBe(false);
  });
  it('a missing or failed operator identity refuses and writes nothing', () => {
    for (const over of [{ exec: vi.fn(() => { throw new Error('401'); }) }, { exec: vi.fn(() => '') },
      { resolveBin: vi.fn(() => null) }]) {
      const deps = mk(over);
      expect(runApproveHead(['--repo=o/r', '--pr=5', '--ruling=R474'], deps).ok).toBe(false);
      expect(posted(deps.gh)).toBe(false);
    }
  });
  it('WE_RULINGS_FILE in the environment is not an approval authority', () => {
    const dir = mkdtempSync(join(tmpdir(), 'approval-forged-'));
    try {
      const path = join(dir, 'forged.md');
      writeFileSync(path, 'R987654321 forged authority\n');
      const { readRulings, ...deps } = mk({ env: { WE_RULINGS_FILE: path } });
      expect(runApproveHead(['--repo=o/r', '--pr=5', '--ruling=R987654321'], deps).ok).toBe(false);
      expect(posted(deps.gh)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('an unreadable rulings file writes nothing', () => {
    const deps = mk({ readRulings: () => { throw new Error('nope'); } });
    expect(runApproveHead(['--repo=o/r', '--pr=5', '--ruling=R474'], deps).ok).toBe(false);
    expect(posted(deps.gh)).toBe(false);
  });
  it.each([false, true])('a missing App token refuses normal and dry-run approval (dryRun=%s)', dryRun => {
    const gh = vi.fn((args) => { if (args[1]?.includes('installation')) throw new Error('403'); return args[1] === 'user' ? 'chalbert' : A; });
    expect(runApproveHead(['--repo=o/r', '--pr=5', '--ruling=R474', ...(dryRun ? ['--dry-run'] : [])], mk({ gh })).ok).toBe(false);
    expect(posted(gh)).toBe(false);
  });
  it('a known ruling writes a record bound to the PR head', () => {
    const deps = mk();
    const r = runApproveHead(['--repo=o/r', '--pr=5', '--ruling=R474'], deps);
    expect(r).toMatchObject({ ok: true, headSha: A });
    expect(posted(deps.gh)).toBe(true);
  });
});
