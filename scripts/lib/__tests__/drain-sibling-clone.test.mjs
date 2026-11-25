/**
 * @file drain-sibling-clone.test.mjs
 * @description CLEAR-HUMAN-NOT-STICKY: the drain provisions the missing sibling clone so a constellation repo's net diff
 *   is READ (scored) instead of held as "no-clone". Negative cases first: an unreadable clone fails closed (null → the
 *   hold stays), a tampered diff still holds; only a readable, matching diff yields a scored, clean scan.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSiblingClone as ensureRaw, siblingCloneUrl, slugOfRemote, siblingCloneRejection, createSiblingCloneDir, describeDiffEvidenceHold, resetSiblingCloneFailures, describeUnverifiedDiffHold, CLONE_RETRY_COOLDOWN_MS } from '../drain-sibling-clone.mjs';
import { computeNetDiffSignals } from '../../merge-ai-prs.mjs';
import { scanTestTampering } from '../pr-merge-gate.mjs';

// Provisioning is off under vitest unless explicit. Pass it per call: a process.env write would leak into other
// suites sharing this worker and make them attempt real network clones.
const ON = { ...process.env, WE_DRAIN_SIBLING_CLONE: 'on' };
const ensureSiblingClone = (o) => ensureRaw({ env: ON, isGitDir: () => true, originOf: () => 'git@github.com:o/frontierui.git', ...o });

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A real origin repo (main + one PR branch) served over file:// with partial-clone filters allowed. */
function makeOrigin(prFiles) {
  const root = mkdtempSync(join(tmpdir(), 'sibling-clone-'));
  const origin = join(root, 'owner', 'origin.git'); // the url ensureSiblingClone derives for slug owner/origin
  mkdirSync(origin, { recursive: true });
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

const poolHas = (p) => p === '/x/pool/plateau-app/.git'; // a pool root that already holds another sibling clone

describe('ensureSiblingClone fails closed', () => {
  beforeEach(() => resetSiblingCloneFailures());
  const base = { slug: 'o/frontierui', name: 'frontierui', parentDir: '/x/pool', localOrigin: 'git@github.com:o/we.git' };
  it('an unreadable remote yields null and is not retried inside the cooldown', () => {
    let calls = 0; let t = 1000;
    const o = { ...base, exists: poolHas, clone: () => { calls++; throw new Error('auth'); }, now: () => t };
    expect(ensureSiblingClone(o)).toBeNull();
    expect(ensureSiblingClone(o)).toBeNull();
    expect(calls).toBe(1);
    t += CLONE_RETRY_COOLDOWN_MS + 1;
    expect(ensureSiblingClone(o)).toBeNull();
    expect(calls).toBe(2);
  });
  it('no derivable url never runs git', () => {
    let calls = 0;
    expect(ensureSiblingClone({ ...base, localOrigin: null, exists: poolHas, clone: () => { calls++; } })).toBeNull();
    expect(calls).toBe(0);
  });
  it('a squatting non-clone directory is never clobbered (fresh cooldown state, so the occupancy guard is what stops it)', () => {
    let calls = 0; let renames = 0;
    expect(ensureSiblingClone({ ...base, exists: (p) => poolHas(p) || p === '/x/pool/frontierui', clone: () => { calls++; }, rename: () => { renames++; }, now: () => 5 })).toBeNull();
    expect(calls + renames).toBe(0);
    // a free directory with the same inputs DOES clone: proves the occupancy check is the only thing that stopped it
    resetSiblingCloneFailures();
    expect(ensureSiblingClone({ ...base, exists: (p) => poolHas(p) || (p === '/x/pool/frontierui/.git' && calls > 0), clone: () => { calls++; }, rename: () => {}, now: () => 5 })).toBe('/x/pool/frontierui');
    expect(calls).toBe(1);
  });
  it('an existing clone whose origin is another owner is rejected with a reason (fail closed)', () => {
    for (const origin of ['git@github.com:evil/frontierui.git', null]) {
      let calls = 0;
      expect(ensureSiblingClone({ ...base, exists: () => true, originOf: () => origin, clone: () => { calls++; } })).toBeNull();
      expect(siblingCloneRejection('o/frontierui')).toMatch(/origin-mismatch/);
      expect(calls).toBe(0);
    }
  });
  it('an existing clone matching the slug case-insensitively is accepted', () => {
    expect(ensureSiblingClone({ ...base, exists: () => true, originOf: () => 'https://github.com/O/FrontierUI' })).toBe('/x/pool/frontierui');
  });
  it('an existing .git that is not a real git dir is rejected', () => {
    expect(ensureSiblingClone({ ...base, exists: () => true, isGitDir: () => false })).toBeNull();
    expect(siblingCloneRejection('o/frontierui')).toBe('not-a-git-dir');
  });
  it('a pool sibling with an empty/invalid .git does not make the parent a pool', () => {
    let calls = 0;
    expect(ensureSiblingClone({ ...base, exists: poolHas, isGitDir: () => false, clone: () => { calls++; } })).toBeNull();
    expect(calls).toBe(0);
  });
  it('dry-run reports would-provision and never clones', () => {
    let calls = 0; const logs = [];
    expect(ensureSiblingClone({ ...base, exists: poolHas, dryRun: true, log: (m) => logs.push(m), clone: () => { calls++; } })).toBeNull();
    expect(calls).toBe(0);
    expect(logs.join(' ')).toMatch(/would provision/);
  });
  it('provisioning is off when disabled, and off under a test runner unless explicit', () => {
    let calls = 0;
    const o = { ...base, exists: poolHas, clone: () => { calls++; } };
    expect(ensureSiblingClone({ ...o, env: { WE_DRAIN_SIBLING_CLONE: 'off' } })).toBeNull();
    expect(ensureSiblingClone({ ...o, env: { VITEST: 'true' } })).toBeNull();
    expect(calls).toBe(0);
  });
  it('a parent that is not a lane pool (no other sibling clone) never triggers a clone', () => {
    let calls = 0;
    expect(ensureSiblingClone({ ...base, exists: () => false, clone: () => { calls++; } })).toBeNull();
    expect(calls).toBe(0);
  });
  it('an existing clone is used as is', () => {
    let calls = 0;
    expect(ensureSiblingClone({ ...base, exists: () => true, clone: () => { calls++; } })).toBe('/x/pool/frontierui');
    expect(calls).toBe(0);
  });
});

describe('the provisioned clone makes the drain read the diff (real git)', () => {
  beforeEach(() => resetSiblingCloneFailures());
  function readThroughProvisionedClone(prFiles) {
    const { root, origin, head } = makeOrigin(prFiles);
    const pool = join(root, 'pool');
    mkdirSync(join(pool, 'plateau-app', '.git'), { recursive: true }); // a real pool root already holds a sibling
    // The REAL default clone: localOrigin's transport + slug owner/origin → file://<root>/owner/origin.git (the origin repo).
    const dir = ensureSiblingClone({ slug: 'owner/origin', name: 'frontierui', parentDir: pool, localOrigin: `file://${root}/owner/we` });
    return { dir, head, root, origin };
  }
  const read = (dir, head) => {
    const exec = (cmd, args, opts) => execFileSync(cmd, args, { cwd: dir, ...opts });
    return computeNetDiffSignals({ exec, rev: head, baseRev: 'main', fetchExtraRefs: ['lane/pr'], pinRev: true });
  };

  it('a readable, matching diff is scored and clean', () => {
    const { dir, head } = readThroughProvisionedClone({ 'README.md': 'changed\n' });
    expect(dir && existsSync(join(dir, '.git'))).toBeTruthy();
    expect(git(dir, 'config', 'remote.origin.partialclonefilter')).toBe('blob:none'); // blobless
    expect(existsSync(join(dir, 'README.md'))).toBe(false); // no checkout
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

describe('slugOfRemote', () => {
  it.each([['git@github.com:Chalbert/FrontierUI.git', 'chalbert/frontierui'], ['https://github.com/o/n/', 'o/n'], ['junk', null]])('%j', (u, e) => expect(slugOfRemote(u)).toBe(e));
});

describe('drain wiring (real call path)', () => {
  const local = (r) => r === 'o/we';
  const name = (r) => r.split('/')[1];
  it('createSiblingCloneDir passes dry-run through, skips local repos, and caches a verified clone', () => {
    const seen = [];
    const ensure = (o) => { seen.push(o); return '/pool/' + o.name; };
    const dir = createSiblingCloneDir({ isLocalRepo: local, siblingCloneName: name, readOrigin: () => 'git@github.com:o/we.git', dryRun: true, ensure });
    expect(dir('o/we')).toBeNull();
    expect(dir('o/frontierui')).toBe('/pool/frontierui');
    expect(dir('o/frontierui')).toBe('/pool/frontierui');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ slug: 'o/frontierui', dryRun: true, localOrigin: 'git@github.com:o/we.git' });
  });
  it('an unreadable local origin still resolves (null origin → ensure fails closed itself)', () => {
    const dir = createSiblingCloneDir({ isLocalRepo: local, siblingCloneName: name, readOrigin: () => { throw new Error('x'); }, ensure: (o) => (o.localOrigin === null ? null : 'bad') });
    expect(dir('o/frontierui')).toBeNull();
  });
  const unscored = { scored: false, reason: 'no-clone' };
  it('an unscored diff parks with the reasoned cause, whatever else is true; a clean scored diff does not', () => {
    const hold = describeDiffEvidenceHold({ netDiffText: unscored, gaming: {}, repo: 'o/frontierui' });
    expect(hold.reasons[0]).toMatch(/Cause:.*no-clone/);
    expect(hold.reasons[0]).toMatch(/Wake event/);
    expect(describeDiffEvidenceHold({ netDiffText: { scored: true }, gaming: { evidenceIncomplete: false }, repo: 'o/frontierui' })).toBeNull();
  });
  it('a clearance (tamperRepark=false) never lifts an unscored diff', () => {
    expect(describeDiffEvidenceHold({ netDiffText: unscored, gaming: {}, tamperRepark: false })).not.toBeNull();
  });
  it('a rejected clone origin is named in the hold', () => {
    const hold = describeDiffEvidenceHold({ netDiffText: unscored, gaming: {}, repo: 'o/frontierui', rejection: 'origin-mismatch (evil/frontierui is not o/frontierui)' });
    expect(hold.reasons[0]).toContain('origin-mismatch');
  });
  it('incomplete or tampered scored evidence still parks; a workflow hold does not double-park', () => {
    expect(describeDiffEvidenceHold({ netDiffText: { scored: true }, gaming: { evidenceIncomplete: true, reasons: ['x'] } }).reasons).toEqual(['x']);
    expect(describeDiffEvidenceHold({ netDiffText: { scored: true }, gaming: {}, tamperRepark: true })).not.toBeNull();
    expect(describeDiffEvidenceHold({ netDiffText: unscored, gaming: {}, workflowHoldRepark: true })).toBeNull();
  });
});
