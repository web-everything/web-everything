import { describe, it, expect, afterEach, vi } from 'vitest';
import { join, resolve } from 'node:path';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import * as storeModule from '../run-scorecard-store.mjs';
import {
  validateScorecard, readStore, writeStore, appendScorecard, meanScore,
  resolveScorecardStorePath, LEGACY_IN_TREE_STORE, LEGACY_MIGRATION_ID,
  mergeLegacyStores, migrateLegacyStore, readLegacyStoreTexts,
} from '../run-scorecard-store.mjs';

const baseRow = () => ({
  rubricVersion: '2026-09-13.1',
  provider: 'codex',
  model: 'gpt-6-astra',
  effort: 'medium',
  item: '3388',
  handle: 'build-3388-a1',
  subjectClass: 'work-agent',
  dispatchKind: 'fix',
  criteriaEvaluated: 5,
  deductions: [],
  score: 100,
});

function memIo(initial = { version: 1, records: [] }) {
  let store = initial;
  return {
    read: () => JSON.stringify(store),
    write: (_p, s) => { store = JSON.parse(s); },
    exists: () => true,
  };
}

describe('validateScorecard', () => {
  it('accepts a well-formed row', () => {
    expect(validateScorecard(baseRow()).ok).toBe(true);
  });
  it('requires provider AND model — never a bare model string', () => {
    const { provider, ...rest } = baseRow();
    expect(validateScorecard(rest).ok).toBe(false);
  });
  it('requires rubricVersion', () => {
    const row = baseRow(); delete row.rubricVersion;
    expect(validateScorecard(row).ok).toBe(false);
  });
  it('refuses score:100 when criteriaEvaluated is 0 — never 100 on an empty read', () => {
    expect(validateScorecard({ ...baseRow(), criteriaEvaluated: 0, score: 100 }).ok).toBe(false);
    expect(validateScorecard({ ...baseRow(), criteriaEvaluated: 0, score: null }).ok).toBe(true);
  });
  it('refuses an out-of-range score', () => {
    expect(validateScorecard({ ...baseRow(), score: 150 }).ok).toBe(false);
    expect(validateScorecard({ ...baseRow(), score: -1 }).ok).toBe(false);
  });
  it('requires subjectClass to be exactly work-agent or driver', () => {
    expect(validateScorecard({ ...baseRow(), subjectClass: 'something-else' }).ok).toBe(false);
  });
  it('refuses a deduction whose evidence still fails the scrub — defence in depth', () => {
    const row = { ...baseRow(), deductions: [{ criterion: 'x', weight: 1, count: 1, evidence: '/Users/x/workspace/webeverything/secret.env' }] };
    expect(validateScorecard(row).ok).toBe(false);
  });
});

describe('readStore/writeStore — IO shell', () => {
  it('readStore degrades to empty on a missing file', () => {
    expect(readStore({ exists: () => false }).records).toEqual([]);
  });
  it('readStore degrades to empty on malformed JSON, never throws', () => {
    expect(() => readStore({ exists: () => true, read: () => 'not json' })).not.toThrow();
    expect(readStore({ exists: () => true, read: () => 'not json' }).records).toEqual([]);
  });
  it('round-trips through the injected write/read pair', () => {
    const io = memIo();
    writeStore({ version: 1, records: [baseRow()] }, io);
    expect(readStore(io).records).toHaveLength(1);
  });
});

describe('appendScorecard', () => {
  it('appends a valid row and stamps v/outcome/scoredAt', () => {
    const io = memIo();
    const stored = appendScorecard(baseRow(), io);
    expect(stored.v).toBe(1);
    expect(stored.outcome).toBeNull();
    expect(typeof stored.scoredAt).toBe('string');
    expect(readStore(io).records).toHaveLength(1);
  });
  it('refuses (throws) an invalid row — never silently coerces or drops', () => {
    const io = memIo();
    expect(() => appendScorecard({ ...baseRow(), provider: '' }, io)).toThrow(/refusing/);
    expect(readStore(io).records).toHaveLength(0);
  });
  it('accumulates multiple rows across calls', () => {
    const io = memIo();
    appendScorecard(baseRow(), io);
    appendScorecard({ ...baseRow(), item: '3389' }, io);
    expect(readStore(io).records).toHaveLength(2);
  });
});

describe('meanScore — the required-rubricVersion/provider/model aggregate, never a per-run headline', () => {
  it('requires rubricVersion, provider, and model', () => {
    expect(() => meanScore({ provider: 'codex', model: 'gpt-6-astra' })).toThrow(/rubricVersion/);
    expect(() => meanScore({ rubricVersion: 'v1', model: 'gpt-6-astra' })).toThrow(/provider/);
    expect(() => meanScore({ rubricVersion: 'v1', provider: 'codex' })).toThrow(/model/);
  });

  it('averages only matching rows, defaulting subjectClass to work-agent', () => {
    const io = memIo();
    appendScorecard({ ...baseRow(), score: 90 }, io);
    appendScorecard({ ...baseRow(), score: 70 }, io);
    appendScorecard({ ...baseRow(), score: 10, subjectClass: 'driver' }, io); // excluded by default
    const { mean, n } = meanScore({ rubricVersion: '2026-09-13.1', provider: 'codex', model: 'gpt-6-astra' }, io);
    expect(n).toBe(2);
    expect(mean).toBe(80);
  });

  it('NEVER blends two different models — a future model upgrade starts its own average', () => {
    const io = memIo();
    appendScorecard({ ...baseRow(), score: 90 }, io);
    appendScorecard({ ...baseRow(), score: 0, model: 'gpt-7-hypothetical' }, io);
    const { mean, n } = meanScore({ rubricVersion: '2026-09-13.1', provider: 'codex', model: 'gpt-6-astra' }, io);
    expect(n).toBe(1);
    expect(mean).toBe(90);
  });

  it('never blends across rubricVersion', () => {
    const io = memIo();
    appendScorecard({ ...baseRow(), score: 90 }, io);
    appendScorecard({ ...baseRow(), score: 0, rubricVersion: '2099-01-01.1' }, io);
    const { n } = meanScore({ rubricVersion: '2026-09-13.1', provider: 'codex', model: 'gpt-6-astra' }, io);
    expect(n).toBe(1);
  });

  it('excludes null-score rows from the average rather than treating them as 0', () => {
    const io = memIo();
    appendScorecard({ ...baseRow(), score: 90 }, io);
    appendScorecard({ ...baseRow(), score: null, criteriaEvaluated: 0 }, io);
    const { mean, n } = meanScore({ rubricVersion: '2026-09-13.1', provider: 'codex', model: 'gpt-6-astra' }, io);
    expect(n).toBe(1);
    expect(mean).toBe(90);
  });

  it('returns null/0 when nothing matches, rather than throwing or returning NaN', () => {
    const io = memIo();
    const { mean, n } = meanScore({ rubricVersion: 'nope', provider: 'codex', model: 'gpt-6-astra' }, io);
    expect(mean).toBeNull();
    expect(n).toBe(0);
  });
});

// #4155 — live 2026-09-25: a review round's codex advisory seat appended a row to the TRACKED in-tree store
// inside the review-daemon clone; its self-sync refused the dirty clone, it fell behind main, and every review
// dispatch refused as STALE. The store now lives outside every git tree, whatever checkout writes it.
describe('resolveScorecardStorePath — one shared file outside every git tree (#4155)', () => {
  const savedEnv = { ...process.env };
  afterEach(() => {
    for (const k of ['CONVEYOR_STATE_ROOT', 'WE_DAEMON_STATE_DIR']) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('defaults to the conveyor state root under the daemon state dir — never a path inside this checkout', () => {
    const path = resolveScorecardStorePath({ WE_DAEMON_STATE_DIR: '/tmp/daemon-state' });
    expect(path).toBe(join('/tmp/daemon-state', 'conveyor-state', '.conveyor', 'run-scorecards.json'));
    const repoRoot = join(import.meta.dirname, '..', '..', '..');
    expect(path.startsWith(repoRoot)).toBe(false);
  });

  it('the unset default is under ~/.claude, not the repo', () => {
    const path = resolveScorecardStorePath({ HOME: process.env.HOME });
    expect(path).toMatch(/\.claude[\\/]daemon-self-sync-state[\\/]conveyor-state[\\/]\.conveyor[\\/]run-scorecards\.json$/);
    expect(path.endsWith(LEGACY_IN_TREE_STORE)).toBe(false);
  });

  it('CONVEYOR_STATE_ROOT (#4052) still pins it', () => {
    const path = resolveScorecardStorePath({ CONVEYOR_STATE_ROOT: '/tmp/op', WE_DAEMON_STATE_DIR: '/tmp/d' });
    expect(path).toBe(join('/tmp/op', '.conveyor', 'run-scorecards.json'));
  });

  it('readStore/writeStore honor the live env (not a frozen import-time default)', () => {
    process.env.CONVEYOR_STATE_ROOT = '/tmp/never-actually-touched-because-io-is-injected';
    const writes = [];
    writeStore({ version: 1, records: [] }, { write: (p) => writes.push(p) });
    expect(writes[0]).toBe(join('/tmp/never-actually-touched-because-io-is-injected', '.conveyor', 'run-scorecards.json'));
  });

  it('the default writer creates the out-of-tree directory on first write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scorecard-store-'));
    try {
      const path = join(dir, 'conveyor-state', '.conveyor', 'run-scorecards.json');
      writeStore({ version: 1, records: [{ x: 1 }] }, { path });
      expect(JSON.parse(readFileSync(path, 'utf8')).records).toEqual([{ x: 1 }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a write keeps the migration stamp', () => {
    const io = memIo({ version: 1, records: [], migrations: [LEGACY_MIGRATION_ID] });
    appendScorecard(baseRow(), io);
    expect(JSON.parse(io.read()).migrations).toEqual([LEGACY_MIGRATION_ID]);
  });
});

describe('mergeLegacyStores — union, never clobber (#4155)', () => {
  const legacy = JSON.stringify({ version: 1, records: [{ a: 1 }, { b: 2 }] });

  it('seeds an absent shared store from the legacy history and stamps it', () => {
    const { store, added } = mergeLegacyStores(null, [legacy], ['stamp-a']);
    expect(store.records).toEqual([{ a: 1 }, { b: 2 }]);
    expect(store.migrations).toEqual(['stamp-a']);
    expect(added).toBe(2);
  });

  it('records a stamp even when the source carried no rows', () => {
    const { store, added } = mergeLegacyStores({ version: 1, records: [{ c: 3 }], migrations: [] }, [], ['stamp-a']);
    expect(store).toEqual({ version: 1, records: [{ c: 3 }], migrations: ['stamp-a'] });
    expect(added).toBe(0);
  });

  it('keeps every row the shared store already has, adds only the missing legacy rows, first', () => {
    const { store, added } = mergeLegacyStores({ version: 1, records: [{ b: 2 }, { c: 3 }], migrations: [] }, [legacy, legacy]);
    expect(store.records).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
    expect(added).toBe(1);
  });

  it('returns null (no stamp) when no legacy text parses', () => {
    expect(mergeLegacyStores(null, ['not json'])).toBeNull();
    expect(mergeLegacyStores(null, [])).toBeNull();
  });
});

describe('migrateLegacyStore — against a real git repo whose store was untracked (#4155)', () => {
  let dir, repo, target;
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  function setup({ untrack }) {
    dir = mkdtempSync(join(tmpdir(), 'scorecard-migrate-'));
    repo = join(dir, 'repo');
    target = join(dir, 'state', '.conveyor', 'run-scorecards.json');
    mkdirSync(join(repo, 'scripts', 'conveyor'), { recursive: true });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, LEGACY_IN_TREE_STORE), JSON.stringify({ version: 1, records: [{ legacy: 1 }, { legacy: 2 }] }));
    git('add', '.'); git('commit', '-qm', 'tracked store');
    if (untrack) { git('rm', '-q', LEGACY_IN_TREE_STORE); git('commit', '-qm', 'untrack store'); }
  }

  it('recovers the history from the untracking commit\'s parent even though the file is gone from disk', () => {
    setup({ untrack: true });
    expect(existsSync(join(repo, LEGACY_IN_TREE_STORE))).toBe(false);
    expect(readLegacyStoreTexts({ repoRoot: repo })).toHaveLength(1);
    const result = migrateLegacyStore({ path: target, repoRoot: repo });
    expect(result).toMatchObject({ migrated: true, added: 2 });
    const store = JSON.parse(readFileSync(target, 'utf8'));
    expect(store.records).toEqual([{ legacy: 1 }, { legacy: 2 }]);
    expect(store.migrations).toEqual([storeModule.legacyGitStamp(repo)]);
  });

  it('merges into a shared store that already has rows, and runs once', () => {
    setup({ untrack: true });
    mkdirSync(join(dir, 'state', '.conveyor'), { recursive: true });
    writeFileSync(target, JSON.stringify({ version: 1, records: [{ legacy: 2 }, { fresh: 1 }] }));
    expect(migrateLegacyStore({ path: target, repoRoot: repo })).toMatchObject({ migrated: true, added: 1 });
    expect(JSON.parse(readFileSync(target, 'utf8')).records).toEqual([{ legacy: 1 }, { legacy: 2 }, { fresh: 1 }]);
    expect(migrateLegacyStore({ path: target, repoRoot: repo })).toMatchObject({ migrated: false, reason: 'already-migrated' });
  });

  it('carries an on-disk copy an older process modified, on top of the committed history', () => {
    setup({ untrack: false });
    writeFileSync(join(repo, LEGACY_IN_TREE_STORE), JSON.stringify({ version: 1, records: [{ legacy: 1 }, { legacy: 2 }, { late: 1 }] }));
    expect(migrateLegacyStore({ path: target, repoRoot: repo })).toMatchObject({ migrated: true, added: 3 });
  });

  it('never overwrites a shared store it cannot parse', () => {
    setup({ untrack: true });
    mkdirSync(join(dir, 'state', '.conveyor'), { recursive: true });
    writeFileSync(target, 'corrupt');
    expect(migrateLegacyStore({ path: target, repoRoot: repo })).toMatchObject({ migrated: false, reason: 'shared-store-unparsable' });
    expect(readFileSync(target, 'utf8')).toBe('corrupt');
  });

  it('leaves the store unstamped when the checkout is not a git repo (git could not answer — retry later)', () => {
    setup({ untrack: true });
    const empty = join(dir, 'not-a-repo');
    mkdirSync(empty);
    expect(migrateLegacyStore({ path: target, repoRoot: empty })).toMatchObject({ migrated: false, reason: 'no-legacy-history' });
    expect(existsSync(target)).toBe(false);
  });
});

// Review of PR #2684 (review:changes, 2026-09-25): four findings against the migration above.
describe('migrateLegacyStore — review findings on PR #2684', () => {
  let dir;
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  function makeRepo(name, records) {
    const repo = join(dir, name);
    mkdirSync(join(repo, 'scripts', 'conveyor'), { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't'); git(repo, 'config', 'commit.gpgsign', 'false');
    if (records) {
      writeFileSync(join(repo, LEGACY_IN_TREE_STORE), JSON.stringify({ version: 1, records }));
      git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'tracked store');
      git(repo, 'rm', '-q', LEGACY_IN_TREE_STORE); git(repo, 'commit', '-qm', 'untrack store');
    } else {
      writeFileSync(join(repo, 'README'), 'x');
      git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'no store ever');
    }
    return repo;
  }
  const newDir = () => { dir = mkdtempSync(join(tmpdir(), 'scorecard-review-')); return join(dir, 'state', '.conveyor', 'run-scorecards.json'); };
  const records = (p) => JSON.parse(readFileSync(p, 'utf8')).records;

  it('migration preserves an append made during legacy-history retrieval (no lost update)', () => {
    const target = newDir();
    const repo = makeRepo('repo', [{ legacy: 1 }]);
    mkdirSync(join(dir, 'state', '.conveyor'), { recursive: true });
    writeFileSync(target, JSON.stringify({ version: 1, records: [{ before: 1 }] }));
    const realGit = (args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    let appended = false;
    const slowGit = (args) => {
      // Another process's append lands while this one is still reading the legacy history out of git.
      if (!appended && args[0] === 'show') { appended = true; appendScorecard({ ...baseRow(), score: 90 }, { path: target }); }
      return realGit(args);
    };
    expect(migrateLegacyStore({ path: target, repoRoot: repo, git: slowGit })).toMatchObject({ migrated: true });
    expect(appended).toBe(true);
    const after = records(target);
    expect(after.map((r) => r.score ?? null)).toContain(90);
    expect(after).toContainEqual({ legacy: 1 });
    expect(after).toContainEqual({ before: 1 });
  });

  it('imports distinct legacy rows from a second checkout after the first migration', () => {
    const target = newDir();
    const repoA = makeRepo('a', [{ fromA: 1 }]);
    const repoB = makeRepo('b', [{ fromB: 1 }]);
    expect(migrateLegacyStore({ path: target, repoRoot: repoA })).toMatchObject({ migrated: true, added: 1 });
    expect(migrateLegacyStore({ path: target, repoRoot: repoB })).toMatchObject({ migrated: true, added: 1 });
    expect(records(target)).toEqual([{ fromB: 1 }, { fromA: 1 }]);
    expect(migrateLegacyStore({ path: target, repoRoot: repoA })).toMatchObject({ migrated: false, reason: 'already-migrated' });
    expect(migrateLegacyStore({ path: target, repoRoot: repoB })).toMatchObject({ migrated: false, reason: 'already-migrated' });
  });

  it('stamps a checkout with no legacy history, so git is not spawned again', () => {
    const target = newDir();
    const repo = makeRepo('repo', null);
    mkdirSync(join(dir, 'state', '.conveyor'), { recursive: true });
    writeFileSync(target, JSON.stringify({ version: 1, records: [{ fresh: 1 }] }));
    let gitCalls = 0;
    const countingGit = (args) => { gitCalls += 1; return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); };
    migrateLegacyStore({ path: target, repoRoot: repo, git: countingGit });
    const callsAfterFirst = gitCalls;
    expect(callsAfterFirst).toBeGreaterThan(0);
    expect(migrateLegacyStore({ path: target, repoRoot: repo, git: countingGit })).toMatchObject({ migrated: false, reason: 'already-migrated' });
    expect(gitCalls).toBe(callsAfterFirst);
    expect(records(target)).toEqual([{ fresh: 1 }]);
  });

  it('re-imports an on-disk copy an older process kept appending to', () => {
    const target = newDir();
    const repo = makeRepo('repo', [{ legacy: 1 }]);
    const onDisk = join(repo, LEGACY_IN_TREE_STORE);
    mkdirSync(join(repo, 'scripts', 'conveyor'), { recursive: true });
    writeFileSync(onDisk, JSON.stringify({ version: 1, records: [{ legacy: 1 }, { late: 1 }] }));
    expect(migrateLegacyStore({ path: target, repoRoot: repo })).toMatchObject({ migrated: true, added: 2 });
    writeFileSync(onDisk, JSON.stringify({ version: 1, records: [{ legacy: 1 }, { late: 1 }, { later: 1 }] }));
    expect(migrateLegacyStore({ path: target, repoRoot: repo })).toMatchObject({ migrated: true, added: 1 });
    expect(records(target)).toEqual([{ later: 1 }, { legacy: 1 }, { late: 1 }]);
  });
});

describe('readStore() — the lazy first-read migration of the DEFAULT store (#4155)', () => {
  const saved = process.env.CONVEYOR_STATE_ROOT;
  let dir;
  afterEach(() => {
    if (saved === undefined) delete process.env.CONVEYOR_STATE_ROOT; else process.env.CONVEYOR_STATE_ROOT = saved;
    rmSync(dir, { recursive: true, force: true });
    vi.resetModules();
  });

  it('runs the migration on the first no-argument read, once per process', async () => {
    dir = mkdtempSync(join(tmpdir(), 'scorecard-lazy-'));
    process.env.CONVEYOR_STATE_ROOT = dir;
    vi.resetModules();
    const fresh = await import('../run-scorecard-store.mjs');
    const path = fresh.resolveScorecardStorePath();
    expect(existsSync(path)).toBe(false);
    fresh.readStore();
    // This checkout is a git repo, so the migration examined its history and stamped it, whatever it held.
    const moduleRepoRoot = resolve(import.meta.dirname, '..', '..', '..');
    expect(JSON.parse(readFileSync(path, 'utf8')).migrations).toContain(fresh.legacyGitStamp(moduleRepoRoot));
    rmSync(path);
    fresh.readStore();
    expect(existsSync(path)).toBe(false);
  }, 30_000); // real `git rev-list` over this checkout's history

  it('never migrates when the caller injects IO', async () => {
    dir = mkdtempSync(join(tmpdir(), 'scorecard-lazy-'));
    process.env.CONVEYOR_STATE_ROOT = dir;
    vi.resetModules();
    const fresh = await import('../run-scorecard-store.mjs');
    fresh.readStore({ exists: () => false });
    expect(existsSync(fresh.resolveScorecardStorePath())).toBe(false);
  });
});


it('#4439 appends a launch trial once under concurrent file-store writers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'judge-race-'));
  try {
    const io = { path: join(dir, 'store.json') };
    const row = { ...baseRow(), dispatchKind: 'probation-trial', pr: 101 };
    expect(storeModule.appendScorecardUnlessJudged(row, io)).toMatchObject(row);
    expect(storeModule.appendScorecardUnlessJudged(row, io)).toBeNull();
    const { spawn } = await import('node:child_process');
    const moduleUrl = resolve(import.meta.dirname, '../run-scorecard-store.mjs');
    const run = () => new Promise((ok, fail) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e',
        `import { appendScorecardUnlessJudged } from ${JSON.stringify(moduleUrl)}; appendScorecardUnlessJudged(${JSON.stringify({ ...row, pr: 102 })}, ${JSON.stringify(io)});`], { stdio: ['ignore', 'pipe', 'pipe'] });
      let err = ''; child.stderr.on('data', chunk => { err += chunk; });
      child.on('error', fail); child.on('exit', code => code === 0 ? ok() : fail(Error(err)));
    });
    await Promise.all(Array.from({ length: 8 }, run));
    expect(readStore(io).records.map(r => r.pr)).toEqual([101, 102]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('#3996 validates nullable footprint counts and preserves them on each trial', () => {
  const io = memIo();
  for (const field of ['newLoc', 'modifiedLoc', 'newFiles', 'modifiedFiles']) {
    for (const value of [null, 0, 17]) {
      const row = { ...baseRow(), [field]: value };
      expect(validateScorecard(row).ok).toBe(true);
      appendScorecard(row, io);
      expect(readStore(io).records.at(-1)[field]).toBe(value);
    }
    for (const value of [-1, 1.5, '2', true, {}, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(validateScorecard({ ...baseRow(), [field]: value }).ok).toBe(false);
    }
    // the stated bound is a SAFE integer: the largest one is accepted, the next is not
    expect(validateScorecard({ ...baseRow(), [field]: Number.MAX_SAFE_INTEGER }).ok).toBe(true);
  }
});
