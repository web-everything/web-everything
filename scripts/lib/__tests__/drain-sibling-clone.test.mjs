/**
 * @file drain-sibling-clone.test.mjs
 * @description CLEAR-HUMAN-NOT-STICKY: the drain provisions the missing sibling clone so a constellation repo's net diff
 *   is READ (scored) instead of held as "no-clone". Negative cases first: an unreadable clone fails closed (null → the
 *   hold stays), a tampered diff still holds; only a readable, matching diff yields a scored, clean scan.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { ensureSiblingClone as ensureRaw, siblingCloneUrl, resetSiblingCloneFailures, describeUnverifiedDiffHold, CLONE_RETRY_COOLDOWN_MS } from '../drain-sibling-clone.mjs';
import { computeNetDiffSignals } from '../../merge-ai-prs.mjs';
import { scanTestTampering } from '../pr-merge-gate.mjs';

// Provisioning is off under vitest unless explicit. Pass it per call: a process.env write would leak into other
// suites sharing this worker and make them attempt real network clones.
const ON = { ...process.env, WE_DRAIN_SIBLING_CLONE: 'on' };
const ensureSiblingClone = (o) => ensureRaw({ env: ON, ...o });

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A real origin repo (main + one PR branch) served over file:// with partial-clone filters allowed. */
function makeOrigin(prFiles) {
  const root = mkdtempSync(join(tmpdir(), 'sibling-clone-'));
  const origin = join(root, 'origin');
  mkdirSync(origin);
  git(origin, 'init', '-q', '-b', 'main');
  git(origin, 'config', 'uploadpack.allowFilter', 'true');
  git(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  mkdirSync(join(origin, 'blocks/__tests__'), { recursive: true });
  writeFileSync(join(origin, 'README.md'), 'base\n');
  writeFileSync(join(origin, 'blocks/__tests__/a.test.ts'), "it('a', () => {});\nit('b', () => {});\n");
  git(origin, 'add', '-A'); git(origin, 'commit', '-q', '-m', 'base');
  git(origin, 'checkout', '-q', '-b', 'lane/pr');
  for (const [p, body] of Object.entries(prFiles)) {
    if (body === null) git(origin, 'rm', '-q', p);
    else { mkdirSync(join(origin, p, '..'), { recursive: true }); writeFileSync(join(origin, p), body); git(origin, 'add', p); }
  }
  git(origin, 'commit', '-q', '-m', 'pr');
  return { root, origin, head: git(origin, 'rev-parse', 'HEAD') };
}

describe('siblingCloneUrl', () => {
  it('reuses the local origin transport for another owner/repo', () => {
    expect(siblingCloneUrl('git@github.com:chalbert/web-everything.git', 'chalbert/frontierui')).toBe('git@github.com:chalbert/frontierui.git');
    expect(siblingCloneUrl('https://github.com/o/we', 'o/frontierui')).toBe('https://github.com/o/frontierui.git');
  });
  it.each([[null, 'a/b'], ['git@github.com:o/we.git', 'not a slug'], ['nonsense', 'a/b']])('cannot derive %j / %j', (o, s) => {
    expect(siblingCloneUrl(o, s)).toBeNull();
  });
});

describe('ensureSiblingClone fails closed', () => {
  beforeEach(() => resetSiblingCloneFailures());
  const base = { slug: 'o/frontierui', name: 'frontierui', parentDir: '/x/pool', localOrigin: 'git@github.com:o/we.git' };
  it('an unreadable remote yields null and is not retried inside the cooldown', () => {
    let calls = 0; let t = 1000;
    const o = { ...base, exists: () => false, exec: () => { calls++; throw new Error('auth'); }, now: () => t };
    expect(ensureSiblingClone(o)).toBeNull();
    expect(ensureSiblingClone(o)).toBeNull();
    expect(calls).toBe(1);
    t += CLONE_RETRY_COOLDOWN_MS + 1;
    expect(ensureSiblingClone(o)).toBeNull();
    expect(calls).toBe(2);
  });
  it('no derivable url, or a squatting non-clone directory, never runs git and never clobbers', () => {
    let calls = 0;
    expect(ensureSiblingClone({ ...base, localOrigin: null, exists: () => false, exec: () => { calls++; } })).toBeNull();
    expect(ensureSiblingClone({ ...base, exists: (p) => !p.endsWith('.git'), exec: () => { calls++; } })).toBeNull();
    expect(calls).toBe(0);
  });
  it('provisioning is off when disabled, and off under a test runner unless explicit', () => {
    let calls = 0;
    const o = { ...base, exists: () => false, exec: () => { calls++; } };
    expect(ensureSiblingClone({ ...o, env: { WE_DRAIN_SIBLING_CLONE: 'off' } })).toBeNull();
    expect(ensureSiblingClone({ ...o, env: { VITEST: 'true' } })).toBeNull();
    expect(calls).toBe(0);
  });
  it('an existing clone is used as is', () => {
    let calls = 0;
    expect(ensureSiblingClone({ ...base, exists: () => true, exec: () => { calls++; } })).toBe('/x/pool/frontierui');
    expect(calls).toBe(0);
  });
});

describe('the provisioned clone makes the drain read the diff (real git)', () => {
  beforeEach(() => resetSiblingCloneFailures());
  function readThroughProvisionedClone(prFiles) {
    const { root, origin, head } = makeOrigin(prFiles);
    const pool = join(root, 'pool');
    mkdirSync(pool);
    // `localOrigin` points the derived url at the on-disk origin: <root>/<x>/<y> → <root>/origin
    const dir = ensureSiblingClone({ slug: 'owner/origin', name: 'frontierui', parentDir: pool, localOrigin: `file://${root}/owner/we` , exec: (cmd, args, opts) => {
      const i = args.findIndex((a) => a.startsWith('file://'));
      const fixed = [...args]; fixed[i] = `file://${origin}`;
      return execFileSync(cmd, fixed, opts);
    } });
    return { dir, head, root };
  }
  const read = (dir, head) => {
    const exec = (cmd, args, opts) => execFileSync(cmd, args, { cwd: dir, ...opts });
    return computeNetDiffSignals({ exec, rev: head, baseRev: 'main', fetchExtraRefs: ['lane/pr'], pinRev: true });
  };

  it('a readable, matching diff is scored and clean', () => {
    const { dir, head } = readThroughProvisionedClone({ 'README.md': 'changed\n' });
    expect(dir && existsSync(join(dir, '.git'))).toBeTruthy();
    const sig = read(dir, head);
    expect(sig.netDiffText).toMatchObject({ scored: true, rev: head });
    const scan = scanTestTampering({ netDiffText: sig.netDiffText, pinnedHeadSha: head });
    expect(scan).toMatchObject({ tampered: false, evidenceIncomplete: false });
  });

  it('a tampered diff (a test file deleted) is still read and still holds', () => {
    const { dir, head } = readThroughProvisionedClone({ 'blocks/__tests__/a.test.ts': null });
    const sig = read(dir, head);
    expect(sig.netDiffText.scored).toBe(true);
    const scan = scanTestTampering({ netDiffText: sig.netDiffText, pinnedHeadSha: head });
    expect(scan.tampered).toBe(true);
    expect(scan.reasons.join(' ')).toMatch(/test-file-removed/);
  });

  it('a diff pinned to a different head is incomplete evidence and holds', () => {
    const { dir, head } = readThroughProvisionedClone({ 'README.md': 'changed\n' });
    const sig = read(dir, head);
    expect(scanTestTampering({ netDiffText: sig.netDiffText, pinnedHeadSha: 'f'.repeat(40) }).evidenceIncomplete).toBe(true);
  });
});

describe('describeUnverifiedDiffHold', () => {
  it('names the cause and the wake event, keeps the base sentence, and is stable per cause', () => {
    const base = 'net diff unverified (no-clone); restore diff access and rerun the drain';
    const a = describeUnverifiedDiffHold({ repo: 'o/frontierui', reason: 'no-clone', base });
    expect(a).toContain(base);
    expect(a).toMatch(/Cause:.*o\/frontierui.*no-clone/);
    expect(a).toMatch(/Wake event:.*next pass.*new head re-arms/);
    expect(a).toMatch(/clear-human does not override/);
    expect(describeUnverifiedDiffHold({ repo: 'o/frontierui', reason: 'no-clone', base })).toBe(a);
  });
});

describe('drain wiring', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'merge-ai-prs.mjs'), 'utf8');
  it('siblingCloneDir provisions through ensureSiblingClone instead of returning null for a missing clone', () => {
    const body = src.slice(src.indexOf('const siblingCloneDir = (repo) =>'));
    expect(body.slice(0, body.indexOf('};'))).toContain('ensureSiblingClone({ slug: repo');
  });
  it('the unscored hold still parks and carries the reasoned cause and wake event; a clearance never lifts it', () => {
    expect(src).toContain('describeUnverifiedDiffHold({ repo: v.repo || localSlug');
    expect(src).not.toContain('unverifiedCleared');
    expect(src).not.toContain('shouldReparkForUnverifiedDiff');
  });
});
