/**
 * @file scripts/__tests__/lane-drain-numbering.test.mjs
 * @description Integration proof of the drain's JIT numbering wire (#2288) — `numberPendingHashes`. Sets up
 * a throwaway git repo mimicking the post-WE-land main state (a PROVISIONAL hash item + a referrer that
 * blockedBy's it, and the queued token), then drives the numberer and asserts it: mints the next NNN from
 * `max+1`, renames the file, rewrites cross-refs via the ledger, and commits — the sole-writer id
 * assignment the whole scheme hinges on. Also covers the #2428 extension of the same blind rewrite to
 * `docs/agent/*.md` (the cite-able statute layer) and the #3100 extension to `agent-memory-src/*.md` (the
 * compiled agent-memory bundle every future session loads into context). The pure decider (`applyLedger`)
 * is unit-tested in scripts/backlog/__tests__/id.test.mjs; this proves the FS/git boundary.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { numberPendingHashes, landedNumberFor, cardPathInTree, hasPendingHashFiles, numberPendingHashesIfAny, finalizeLand } from '../lane-drain.mjs';
import { tryAcquireNumberingLock } from '../readiness/drain-lock.mjs';
import { checkFlow } from '../conveyor/flows/flow-model.mjs';
import { strandedHashesOnMain } from '../check-standards-rules.mjs';

const DRAIN_CLI = join(process.cwd(), 'scripts/lane-drain.mjs');

const QUEUED_REL = '.claude/skills/batch-backlog-items/queued.json';
const LEDGER_REL = '.claude/skills/batch-backlog-items/id-ledger.json';

let repo;
const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const write = (rel, txt) => { mkdirSync(join(repo, rel, '..'), { recursive: true }); writeFileSync(join(repo, rel), txt); };
const backlogNames = () => readdirSync(join(repo, 'backlog')).filter((f) => f.endsWith('.md')).sort();

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'drain-num-'));
  git('init', '-q');
  git('config', 'user.email', 'test@test'); git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  // The id-ledger is LOCAL-ONLY drain bookkeeping (gitignored in the real repo) — mirror that so the
  // whole-tree-clean assertion proves the numbering COMMIT landed without the untracked ledger dirtying it.
  write('.gitignore', '.claude/skills/batch-backlog-items/id-ledger.json\n');
});
afterEach(() => { try { rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ } });

// Observe real git subprocesses to guard the drain pass budget, as in #3383.
function withGitLog(run, { failBatch = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'git-shim-'));
  const log = join(dir, 'calls.log');
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(dir, 'git'), `#!/bin/sh\necho "$@" >> "${log}"\n${failBatch ? 'if [ "$1" = "cat-file" ]; then exit 1; fi\n' : ''}exec "${real}" "$@"\n`);
  execFileSync('chmod', ['+x', join(dir, 'git')]);
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath}`;
  try {
    run(() => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [],
      () => writeFileSync(log, ''));
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
}

function pendingReferences() {
  write(QUEUED_REL, JSON.stringify({ queued: [] }));
  write('backlog/xhash01-alpha.md', '---\nblockedBy: [xdead00, xdead01, xflight]\n---\n');
  git('add', '.'); git('commit', '-qm', 'pending references');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
}

describe('numberPendingHashes read source', () => {
  beforeEach(() => vi.stubEnv('WE_JIT_READ_SOURCE', undefined));
  afterEach(() => vi.unstubAllEnvs());

  function seed() {
    write(QUEUED_REL, JSON.stringify({ queued: [] }));
    write('backlog/2200-legacy.md', '---\nkind: story\n---\nLegacy — café\n');
    write('backlog/xhash01-alpha.md', '---\nkind: story\n---\nAlpha — café\n');
    write('docs/agent/rule.md', 'See #xhash01 — café\n');
    write('agent-memory-src/note.md', 'See #xhash01\n');
    write('scripts/conveyor/flows/example.flow.json', '{"cite":"backlog/xhash01-alpha.md"}\n');
    write('scripts/conveyor/soak/breaks/example.mjs', "export default { card: '#xhash01' };\n");
    git('add', '.'); git('commit', '-qm', 'seed read sources');
  }

  it('defaults to one HEAD batch with the same assignments and bytes as worktree', () => {
    seed();
    const base = git('rev-parse', 'HEAD').trim();
    const snapshot = () => Object.fromEntries(git('ls-files').trim().split('\n')
      .map((path) => [path, readFileSync(join(repo, path))]));
    let head;
    withGitLog((calls) => {
      head = numberPendingHashes(repo);
      expect(head.readSource).toBe('head');
      expect(calls().filter((line) => line === 'cat-file --batch')).toHaveLength(1);
      expect(calls().some((line) => line.includes(' HEAD -- . :!node_modules :!backlog'))).toBe(true);
    });
    expect(head.committed).toBe(true);
    const headFiles = snapshot();
    git('reset', '--hard', base);
    rmSync(join(repo, LEDGER_REL), { force: true });
    vi.stubEnv('WE_JIT_READ_SOURCE', 'worktree');
    const worktree = numberPendingHashes(repo);
    expect(worktree.readSource).toBe('worktree');
    expect(worktree.committed).toBe(true);
    expect(head.assigned).toEqual(worktree.assigned);
    expect(headFiles).toEqual(snapshot());
    expect(headFiles['backlog/2200-legacy.md']).toEqual(Buffer.from('---\nkind: story\n---\nLegacy — café\n'));
    expect(headFiles['backlog/2201-alpha.md'].toString()).toContain('Alpha — café\n');
  });

  it.each(['unstaged', 'staged'])('falls back to worktree for a %s tracked edit', (state) => {
    seed();
    write('backlog/xhash01-alpha.md', '---\nkind: story\n---\nEdited — café\n');
    if (state === 'staged') git('add', 'backlog/xhash01-alpha.md');
    const result = numberPendingHashes(repo);
    expect(result.readSource).toBe('worktree');
    expect(readFileSync(join(repo, 'backlog/2201-alpha.md'), 'utf8')).toContain('Edited — café');
  });

  it('still rewrites references in an untracked hash card under auto', () => {
    seed();
    write('backlog/xlocal1-local.md', '---\nblockedBy: [xhash01]\n---\nLocal — café\n');
    const result = numberPendingHashes(repo);
    expect(result.readSource).toBe('head');
    expect(result.assigned).toEqual([{ hash: 'xhash01', nnn: '2201' }]);
    expect(readFileSync(join(repo, 'backlog/xlocal1-local.md'), 'utf8'))
      .toBe('---\nblockedBy: [2201]\n---\nLocal — café\n');
  });

  it('can force HEAD on a dirty tree and read a staged path missing from HEAD from disk', () => {
    seed();
    write('docs/agent/new.md', 'See #xhash01 — café\n');
    git('add', 'docs/agent/new.md');
    vi.stubEnv('WE_JIT_READ_SOURCE', 'head');
    const result = numberPendingHashes(repo);
    expect(result.readSource).toBe('head');
    expect(result.committed).toBe(true);
    expect(readFileSync(join(repo, 'docs/agent/new.md'), 'utf8')).toBe('See #2201 — café\n');
  });

  it.each(['auto', 'head'])('falls back to worktree reads and precheck if the %s batch fails', (source) => {
    seed();
    vi.stubEnv('WE_JIT_READ_SOURCE', source);
    withGitLog((calls) => {
      const result = numberPendingHashes(repo);
      expect(result.readSource).toBe('worktree');
      expect(result.committed).toBe(true);
      expect(readFileSync(join(repo, 'docs/agent/rule.md'), 'utf8')).toBe('See #2201 — café\n');
      expect(calls().some((line) => line.includes(' HEAD -- . :!node_modules :!backlog'))).toBe(false);
    }, { failBatch: true });
  });

  it('holds a committed unswept path citation under HEAD', () => {
    seed();
    write('scripts/other.mjs', '// backlog/xhash01-alpha.md\n');
    git('add', '.'); git('commit', '-qm', 'unswept citation');
    const result = numberPendingHashes(repo);
    expect(result.readSource).toBe('head');
    expect(result.assigned).toEqual([]);
    expect(result.held).toEqual([{ hash: 'xhash01', citedBy: ['scripts/other.mjs'] }]);
    expect(result.committed).toBe(false);
  });
});

describe('numberPendingHashes — drain JIT numbering wire (#2288)', () => {
  it('numbers pending cards on main with soak-definition citations and repairs those citations atomically', () => {
    write('backlog/2200-legacy.md', '---\nkind: story\n---\n# Legacy\n');
    write('backlog/xhash01-alpha.md', '---\nkind: story\nstatus: open\n---\n# Alpha\n');
    const definition = 'scripts/conveyor/soak/breaks/regression.mjs';
    write(definition, "export default { card: 'we:backlog/xhash01-alpha.md (epic #2288)' };\n");
    const fixture = 'scripts/conveyor/soak/breaks/fixtures/input.mjs';
    write(fixture, "export const syntheticId = 'xhash01';\n");
    const testFile = 'scripts/conveyor/soak/breaks/regression.test.mjs';
    write(testFile, "// Synthetic fixture: we:backlog/xhash01-alpha.md\n");
    const untracked = 'scripts/conveyor/soak/breaks/local.mjs';
    write(QUEUED_REL, JSON.stringify({ queued: [] }));
    git('add', 'backlog', 'scripts', '.claude', '.gitignore'); git('commit', '-qm', 'land pending card');
    write(untracked, "export const localId = 'xhash01';\n");

    const paths = () => git('ls-tree', '-r', '--name-only', 'HEAD', '--', 'backlog/').trim().split('\n');
    const committedAt = Number(git('show', '-s', '--format=%ct', 'HEAD').trim());
    const pending = strandedHashesOnMain(paths(), {
      commitTimeFor: () => committedAt, now: () => committedAt + 40,
    });
    expect(pending.errors).toEqual([]); // legitimately pending on main within the JIT window
    expect(pending.warnings).toHaveLength(1);
    // Full history must still expose a real strand after the window; card status is irrelevant.
    expect(strandedHashesOnMain(paths(), {
      commitTimeFor: () => committedAt, now: () => committedAt + 3600,
    }).errors).toHaveLength(1);

    const before = git('rev-parse', 'HEAD').trim();
    const planned = numberPendingHashes(repo, { dryRun: true });
    expect(planned.assigned).toEqual([{ hash: 'xhash01', nnn: '2201' }]);
    expect(git('rev-parse', 'HEAD').trim()).toBe(before);
    expect(readFileSync(join(repo, definition), 'utf8')).toContain('xhash01-alpha');
    const res = numberPendingHashes(repo);
    expect(res.error).toBeUndefined();
    expect(res.committed).toBe(true);
    expect(git('rev-list', '--count', `${before}..HEAD`).trim()).toBe('1');
    expect(git('show', `HEAD:${definition}`)).toContain('we:backlog/2201-alpha.md (epic #2288)');
    expect(git('show', 'HEAD:backlog/2201-alpha.md')).toContain('status: open');
    expect(readFileSync(join(repo, fixture), 'utf8')).toContain('xhash01');
    expect(readFileSync(join(repo, testFile), 'utf8')).toContain('xhash01-alpha.md');
    expect(readFileSync(join(repo, untracked), 'utf8')).toContain('xhash01');
    expect(strandedHashesOnMain(paths())).toEqual({ errors: [], warnings: [] });
    expect(git('status', '--porcelain').trim()).toBe(`?? ${untracked}`);
  });

  it.each(['ledger', 'bornAs'])('preserves executable soak data while rewriting only card metadata via %s', (source) => {
    write('backlog/2200-legacy.md', '---\nbornAs: xold001\nkind: story\n---\n# Legacy\n');
    write('backlog/xhash01-alpha.md', '---\nkind: story\n---\n# Alpha\n');
    const definition = 'scripts/conveyor/soak/breaks/regression.mjs';
    const original = [
      '// Historical birth hashes: xhash01, xold001; #xold001 stays historical here.',
      "const HASH = 'xhash01';",
      "const fixture = { card: '#xhash01', bornAs: 'xold001' };",
      "const text = `card: 'xhash01'; bornAs: xold001; #xold001`;",
      "const pattern = /xhash01|xold001/;",
      "const report = 'reports/xhash01-evidence.md';",
      'export default {',
      '  "card":',
      '    `we:backlog/xhash01-alpha.md; #xold001; xold001`,',
      "  fixedBy: { where: 'lane/xhash01-fix', sha: 'xold001' },",
      "  run() { return { card: '#xhash01', HASH, fixture, text, pattern, report }; },",
      '};',
      '',
    ].join('\n');
    write(definition, original);
    write('reports/xhash01-evidence.md', 'Historical fixture xhash01\n');
    write(QUEUED_REL, JSON.stringify({ queued: [] }));
    git('add', '.'); git('commit', '-qm', 'seed executable soak');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    if (source === 'ledger') write(LEDGER_REL, JSON.stringify({ xold001: '2200' }));

    const result = numberPendingHashes(repo);
    expect(result.error).toBeUndefined();
    expect(result.committed).toBe(true);
    expect(result.unresolvedReferences ?? []).toEqual([]);
    expect(git('show', `HEAD:${definition}`)).toBe(original.replace(
      '`we:backlog/xhash01-alpha.md; #xold001; xold001`',
      '`we:backlog/2201-alpha.md; #2200; 2200`',
    ));
    expect(git('show', 'HEAD:reports/xhash01-evidence.md')).toBe('Historical fixture xhash01\n');
    expect(git('status', '--porcelain').trim()).toBe('');
  });

  it('keeps the real stale-hash queue scenario executable after a numbering pass with its historical ledger entry', () => {
    const definition = 'scripts/conveyor/soak/breaks/queue-cleared-hash-never-resolves-after-jit-number.mjs';
    const original = readFileSync(join(process.cwd(), definition), 'utf8');
    write(definition, original);
    write('backlog/4290-legacy.md', '---\nbornAs: x34h6a2\nkind: story\n---\n# Legacy\n');
    write('backlog/xhash01-alpha.md', '---\nkind: story\n---\n# Alpha\n');
    write(LEDGER_REL, JSON.stringify({ x34h6a2: '4290' }));
    git('add', '.'); git('commit', '-qm', 'seed real queue soak');

    expect(numberPendingHashes(repo).committed).toBe(true);
    expect(readFileSync(join(repo, definition), 'utf8')).toBe(original);
    const probe = `import scenario from ${JSON.stringify(pathToFileURL(join(repo, definition)).href)};
      console.log(JSON.stringify(scenario.judge(await scenario.run({ sourceRoot: ${JSON.stringify(process.cwd())} }))));`;
    expect(JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8' }))).toEqual([]);
  });

  it('refuses a pending path left outside card metadata in an otherwise rewritten soak definition', () => {
    write('backlog/2200-legacy.md', '---\nkind: story\n---\n');
    write('backlog/xhash01-alpha.md', '---\nkind: story\n---\n');
    const definition = 'scripts/conveyor/soak/breaks/regression.mjs';
    write(definition, "export default { card: 'we:backlog/xhash01-alpha.md', run() { return 'we:backlog/xhash01-alpha.md'; } };\n");
    write(QUEUED_REL, JSON.stringify({ queued: [] }));
    git('add', '.'); git('commit', '-qm', 'seed unswept executable path');

    const result = numberPendingHashes(repo);
    expect(result.committed).toBe(false);
    expect(result.error).toContain('hash-path citation outside the rewrite scope');
    expect(result.error).toContain(definition);
    expect(backlogNames()).toContain('xhash01-alpha.md');
    expect(git('status', '--porcelain').trim()).toBe('');
  });

  it.each([
    [undefined, undefined, 'fixture-slug', false],
    [undefined, undefined, 'real-slug', true],
    ['hash', undefined, 'fixture-slug', true],
    [undefined, 'pass', 'fixture-slug', false],
    [undefined, 'pass', 'real-slug', true],
    ['hash', 'pass', 'fixture-slug', true],
  ])('matches citations with match=%s policy=%s slug=%s (held=%s)', (match, policy, slug, held) => {
    vi.stubEnv('WE_JIT_UNSWEPT_CITE_MATCH', match);
    vi.stubEnv('WE_JIT_UNSWEPT_CITE_POLICY', policy);
    try {
      write('backlog/2200-legacy.md', '---\nkind: story\n---\n');
      write('backlog/xhash01-real-slug.md', '---\nkind: story\n---\n');
      write('scripts/other.mjs', `// backlog/xhash01-${slug}.md\n`);
      write(QUEUED_REL, JSON.stringify({ queued: [] }));
      git('add', '.'); git('commit', '-qm', 'seed citation match');
      const result = numberPendingHashes(repo);
      expect(result.committed).toBe(!held);
      expect(result.assigned).toEqual(held ? [] : [{ hash: 'xhash01', nnn: '2201' }]);
      expect(backlogNames()).toContain(held ? 'xhash01-real-slug.md' : '2201-real-slug.md');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('numbers when soak metadata is repaired and only a different slug remains', () => {
    write('backlog/2200-legacy.md', '---\nkind: story\n---\n');
    write('backlog/xhash01-real-slug.md', '---\nkind: story\n---\n');
    const definition = 'scripts/conveyor/soak/breaks/regression.mjs';
    write(definition, "export default { card: 'we:backlog/xhash01-real-slug.md', run() { return 'backlog/xhash01-fixture-slug.md'; } };\n");
    write(QUEUED_REL, JSON.stringify({ queued: [] }));
    git('add', '.'); git('commit', '-qm', 'seed partial sweep');
    const result = numberPendingHashes(repo);
    expect(result.assigned).toEqual([{ hash: 'xhash01', nnn: '2201' }]);
    expect(result.committed).toBe(true);
    expect(readFileSync(join(repo, definition), 'utf8')).toContain('we:backlog/2201-real-slug.md');
    expect(readFileSync(join(repo, definition), 'utf8')).toContain('backlog/xhash01-fixture-slug.md');
  });

  it('assigns max+1, renames the hash file, rewrites a referrer, and commits', () => {
    write('backlog/2200-legacy.md', '---\nkind: story\nstatus: resolved\n---\n# Legacy\n');
    write('backlog/xhash01-alpha.md', '---\nkind: story\nstatus: resolved\n---\n# Alpha\n\nBody mentions xhash01.\n');
    write('backlog/2201-referrer.md', '---\nkind: story\nblockedBy: ["xhash01"]\n---\n# Referrer\n');
    write(QUEUED_REL, JSON.stringify({ queued: [] })); // queue already empty (this was the last couple) → ledger resets
    git('add', 'backlog', '.claude', '.gitignore'); git('commit', '-qm', 'seed');

    const res = numberPendingHashes(repo);

    // max+1 over {2200, 2201} → 2202.
    expect(res.assigned).toEqual([{ hash: 'xhash01', nnn: '2202' }]);
    expect(res.committed).toBe(true);
    // The hash file is renamed; no hash file remains.
    const names = backlogNames();
    expect(names).toContain('2202-alpha.md');
    expect(names.some((n) => n.startsWith('xhash01'))).toBe(false);
    // Its own body ref is rewritten.
    expect(readFileSync(join(repo, 'backlog/2202-alpha.md'), 'utf8')).toContain('Body mentions 2202.');
    // The referrer's blockedBy is repaired.
    expect(readFileSync(join(repo, 'backlog/2201-referrer.md'), 'utf8')).toContain('blockedBy: ["2202"]');
    // A real commit landed the rename+rewrites (working tree clean afterwards).
    expect(git('status', '--porcelain').trim()).toBe('');
    // APPEND-ONLY ledger: retained even though the queue is empty (a still-in-flight lane may reference it).
    expect(JSON.parse(readFileSync(join(repo, LEDGER_REL), 'utf8'))).toEqual({ xhash01: '2202' });
  });

  it('--dry-run (#2319 number-stranded) reports the plan but leaves the tree + ledger untouched', () => {
    write('backlog/2200-legacy.md', '---\nkind: story\nstatus: resolved\n---\n# Legacy\n');
    write('backlog/xhash01-alpha.md', '---\nkind: story\nstatus: resolved\n---\n# Alpha\n\nBody mentions xhash01.\n');
    write('backlog/2201-referrer.md', '---\nkind: story\nblockedBy: ["xhash01"]\n---\n# Referrer\n');
    write(QUEUED_REL, JSON.stringify({ queued: [] }));
    git('add', 'backlog', '.claude', '.gitignore'); git('commit', '-qm', 'seed');

    const res = numberPendingHashes(repo, { dryRun: true });

    expect(res.dryRun).toBe(true);
    expect(res.committed).toBe(false);
    expect(res.assigned).toEqual([{ hash: 'xhash01', nnn: '2202' }]);
    expect(res.wouldRename).toEqual([{ from: 'xhash01-alpha', to: '2202-alpha' }]);
    // Nothing on disk changed: the hash file is still there, no rename, no commit, no ledger written.
    const names = backlogNames();
    expect(names).toContain('xhash01-alpha.md');
    expect(names).not.toContain('2202-alpha.md');
    expect(git('status', '--porcelain').trim()).toBe(''); // no working-tree churn
    expect(() => readFileSync(join(repo, LEDGER_REL), 'utf8')).toThrow(); // ledger not written
  });

  it('does NOT drop a ledger entry on queue-empty — a later dependent still resolves the blocker (PR #194)', () => {
    // Blocker A lands and EMPTIES the queue while dependent B is still in-flight (unqueued, not on main).
    write('backlog/2200-legacy.md', '---\nkind: story\n---\n# Legacy\n');
    write('backlog/xblkr01-a.md', '---\nkind: story\nstatus: resolved\n---\n# Blocker A\n');
    write(QUEUED_REL, JSON.stringify({ queued: [] })); // queue empty at A's land — B not queued yet
    git('add', 'backlog', '.claude', '.gitignore'); git('commit', '-qm', 'seed');
    const a = numberPendingHashes(repo);
    expect(a.assigned).toEqual([{ hash: 'xblkr01', nnn: '2201' }]);
    // Ledger must STILL carry xblkr01 (pre-fix it reset to {} here and stranded B's edge).
    expect(JSON.parse(readFileSync(join(repo, LEDGER_REL), 'utf8'))).toEqual({ xblkr01: '2201' });

    // Later: B lands referencing A by its OLD hash → its edge is repaired from the retained ledger.
    write('backlog/xdepb02-b.md', '---\nkind: story\nblockedBy: ["xblkr01"]\n---\n# Dependent B\n');
    git('add', 'backlog'); git('commit', '-qm', 'B lands');
    numberPendingHashes(repo);
    expect(readFileSync(join(repo, 'backlog/2202-b.md'), 'utf8')).toContain('blockedBy: ["2201"]');
  });

  it('repairs clone B references from clone A bornAs with an empty local ledger (#2903)', () => {
    write('backlog/2200-legacy.md', '---\nkind: story\n---\n# Legacy\n');
    write('backlog/xblkr01-blocker.md', '---\nkind: story\n---\n# Blocker\n');
    write(QUEUED_REL, JSON.stringify({ queued: [] }));
    git('add', '.'); git('commit', '-qm', 'blocker lands in clone A');
    expect(numberPendingHashes(repo).committed).toBe(true);
    expect(JSON.parse(readFileSync(join(repo, LEDGER_REL), 'utf8'))).toEqual({ xblkr01: '2201' });
    expect(readFileSync(join(repo, 'backlog/2201-blocker.md'), 'utf8')).toContain('bornAs: xblkr01');
    const cloneB = mkdtempSync(join(tmpdir(), 'drain-clone-b-'));
    try {
      execFileSync('git', ['clone', '-q', repo, cloneB]);
      const bg = (...args) => execFileSync('git', args, { cwd: cloneB, encoding: 'utf8' });
      bg('config', 'user.email', 'test@test'); bg('config', 'user.name', 'Test');
      bg('config', 'commit.gpgsign', 'false');
      // Pin the shared main tree regardless of the fixture runner's init.defaultBranch.
      bg('update-ref', 'refs/remotes/origin/main', 'HEAD');
      writeFileSync(join(cloneB, LEDGER_REL), '{}\n');
      writeFileSync(join(cloneB, 'backlog/xdep002-dependent.md'),
        '---\nkind: story\nblockedBy: ["xblkr01"]\nparent: xblkr01\nresolutionNote: "real commit title #xblkr01"\n---\n# Dependent\nSee #xblkr01 and /backlog/xblkr01/.\n| bornAs | `xblkr01` |\n');
      mkdirSync(join(cloneB, 'docs/agent'), { recursive: true });
      writeFileSync(join(cloneB, 'docs/agent/rule.md'), 'Build carried by #xblkr01.\n');
      bg('add', 'backlog', 'docs'); bg('commit', '-qm', 'dependent lands in clone B');
      const preview = numberPendingHashes(cloneB, { dryRun: true });
      expect(preview.unresolvedReferences).toEqual([]);
      expect(JSON.parse(readFileSync(join(cloneB, LEDGER_REL), 'utf8'))).toEqual({});
      expect(readFileSync(join(cloneB, 'backlog/xdep002-dependent.md'), 'utf8')).toContain('parent: xblkr01');
      const result = numberPendingHashes(cloneB);
      expect(result.committed).toBe(true);
      expect(result.unresolvedReferences).toEqual([]);
      const dependent = readFileSync(join(cloneB, 'backlog/2202-dependent.md'), 'utf8');
      expect(dependent).toContain('blockedBy: ["2201"]');
      expect(dependent).toContain('parent: 2201');
      expect(dependent).toContain('See #2201 and /backlog/2201/.');
      expect(dependent).toContain('resolutionNote: "real commit title #xblkr01"');
      expect(dependent).toContain('| bornAs | `xblkr01` |');
      expect(dependent).toContain('bornAs: xdep002');
      expect(readFileSync(join(cloneB, 'docs/agent/rule.md'), 'utf8')).toContain('#2201');
      expect(bg('status', '--porcelain').trim()).toBe('');
    } finally { rmSync(cloneB, { recursive: true, force: true }); }
  });

  it('reports in-flight and unresolvable references separately, including dry-run (#2903)', () => {
    write('backlog/2200-legacy.md', '---\nkind: story\n---\n# Legacy\n');
    write('backlog/xflight-in-flight.md', '---\nkind: story\n---\n# Flight\n');
    write(QUEUED_REL, JSON.stringify({ queued: [] }));
    git('add', '.'); git('commit', '-qm', 'in-flight branch');
    git('branch', 'lane/flight');
    git('rm', 'backlog/xflight-in-flight.md');
    write('backlog/xdep002-dependent.md', '---\nkind: story\nblockedBy:\n  - xflight\n  - xdead00\n---\n# Dependent\n');
    git('add', '.'); git('commit', '-qm', 'dependent lands');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const expected = [
      { hash: 'xflight', name: 'xdep002-dependent', status: 'in-flight' },
      { hash: 'xdead00', name: 'xdep002-dependent', status: 'unresolvable' },
    ];
    expect(numberPendingHashes(repo, { dryRun: true }).unresolvedReferences).toEqual(expected);
    expect(numberPendingHashes(repo).unresolvedReferences).toEqual(expected);
    expect(readFileSync(join(repo, 'backlog/2201-dependent.md'), 'utf8')).toContain('  - xdead00');
  });

  it.each([undefined, 'card', 'unknown'])('holds only the cited card with policy %s', (policy) => {
    const previous = process.env.WE_JIT_UNSWEPT_CITE_POLICY;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      if (policy === undefined) delete process.env.WE_JIT_UNSWEPT_CITE_POLICY;
      else process.env.WE_JIT_UNSWEPT_CITE_POLICY = policy;
      const alpha = '---\nkind: story\nstatus: open\n---\n# Alpha\n';
      const citation = "export const fixture = { filename: 'backlog/xhash01-alpha.md' };\n// backlog/xhash01-alpha.md\n";
      write('backlog/2200-legacy.md', '---\nblockedBy: [xhash01]\n---\n');
      write('backlog/xhash01-alpha.md', alpha);
      write('backlog/xhash02-beta.md', '---\nblockedBy: [xhash01]\n---\n# Beta cites #xhash01\n');
      write('scripts/other.mjs', citation);
      write(QUEUED_REL, JSON.stringify({ queued: [] }));
      git('add', '.'); git('commit', '-qm', 'seed per-card hold');
      const head = git('rev-parse', 'HEAD');
      const held = [{ hash: 'xhash01', citedBy: ['scripts/other.mjs'] }];
      const preview = numberPendingHashes(repo, { dryRun: true });
      expect(preview).toMatchObject({ assigned: [{ hash: 'xhash02', nnn: '2201' }], held, committed: false, dryRun: true });
      expect(git('status', '--porcelain').trim()).toBe('');
      expect(existsSync(join(repo, LEDGER_REL))).toBe(false);
      warn.mockClear();

      const result = numberPendingHashes(repo);
      expect(result).toMatchObject({ assigned: [{ hash: 'xhash02', nnn: '2201' }], committed: true, held });
      expect(result.unresolvedReferences).toContainEqual({ hash: 'xhash01', name: 'xhash02-beta', status: 'in-flight' });
      expect(backlogNames()).toEqual(['2200-legacy.md', '2201-beta.md', 'xhash01-alpha.md']);
      expect(readFileSync(join(repo, 'backlog/xhash01-alpha.md'), 'utf8')).toBe(alpha);
      expect(readFileSync(join(repo, 'scripts/other.mjs'), 'utf8')).toBe(citation);
      expect(readFileSync(join(repo, 'backlog/2200-legacy.md'), 'utf8')).toContain('blockedBy: [xhash01]');
      expect(readFileSync(join(repo, 'backlog/2201-beta.md'), 'utf8')).toContain('blockedBy: [xhash01]');
      expect(JSON.parse(readFileSync(join(repo, LEDGER_REL), 'utf8'))).toEqual({ xhash02: '2201' });
      expect(git('rev-parse', 'HEAD')).not.toBe(head);
      expect(git('status', '--porcelain').trim()).toBe('');
      expect(warn.mock.calls.filter(([line]) => line.startsWith('[numberPendingHashes] holding'))).toEqual([
        ['[numberPendingHashes] holding xhash01 — cited by path outside the rewrite scope: scripts/other.mjs; it stays pending (other cards number normally). Cite it as #xhash01 instead.'],
      ]);
    } finally {
      if (previous === undefined) delete process.env.WE_JIT_UNSWEPT_CITE_POLICY;
      else process.env.WE_JIT_UNSWEPT_CITE_POLICY = previous;
      warn.mockRestore();
    }
  });

  it('refuses unswept citations before any reference-resolution subprocesses', () => {
    pendingReferences();
    write('scripts/other.mjs', '// backlog/xhash01-alpha.md\n');
    git('add', '.'); git('commit', '-qm', 'unswept citation');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const previous = process.env.WE_JIT_UNSWEPT_CITE_POLICY;
    process.env.WE_JIT_UNSWEPT_CITE_POLICY = 'pass';
    write('backlog/xhash02-beta.md', '---\nkind: story\n---\n');
    git('add', '.'); git('commit', '-qm', 'another pending card');
    try {
      withGitLog((calls) => {
        const { phaseMs, readSource, ...result } = numberPendingHashes(repo, { dryRun: true });
        expect(readSource).toBe('head');
        expect(result).toEqual({ assigned: [], committed: false,
          error: 'hash-path citation outside the rewrite scope: scripts/other.mjs cites xhash01' });
        expect(calls().filter((c) => c.startsWith('rev-list') ||
          (c.startsWith('grep') && (c.includes('-l') || c.includes('bornAs'))))).toEqual([]);
        expect(phaseMs).toEqual({ read: expect.any(Number), precheck: expect.any(Number), resolve: 0, apply: 0, write: 0 });
        expect(warn).toHaveBeenCalledWith('[numberPendingHashes] refusing this pass — a citation outside the rewrite scope would ' +
          'dangle post-rename: scripts/other.mjs cites xhash01. Widen the sweep scope (scripts/lane-drain.mjs#numberPendingHashes) or ' +
          'fix the citation, then this hash numbers on the next pass.');
        expect(warn.mock.calls.filter(([line]) => line.startsWith('[numberPendingHashes] phaseMs'))).toHaveLength(1);
      });
    } finally {
      if (previous === undefined) delete process.env.WE_JIT_UNSWEPT_CITE_POLICY;
      else process.env.WE_JIT_UNSWEPT_CITE_POLICY = previous;
      warn.mockRestore();
    }
  });

  it('batches distinct bornAs lookups and preserves the first landed number', () => {
    write('backlog/012-first.md', '---\nbornAs: xdead00\n---\n');
    write('backlog/013-second.md', '---\nbornAs: xdead00\n---\n');
    pendingReferences();
    withGitLog((calls) => {
      const result = numberPendingHashes(repo);
      expect(result.committed).toBe(true);
      expect(calls().filter((c) => c.startsWith('grep') && c.includes('bornAs'))).toHaveLength(1);
      expect(readFileSync(join(repo, 'backlog/014-alpha.md'), 'utf8')).toContain('blockedBy: [012, xdead01, xflight]');
      expect(Object.keys(result.phaseMs)).toEqual(['read', 'precheck', 'resolve', 'apply', 'write']);
    });
  });

  it('reuses visibility across passes and incrementally walks new tips', () => {
    pendingReferences();
    withGitLog((calls, clear) => {
      const first = numberPendingHashes(repo, { dryRun: true });
      expect(calls().filter((c) => c.startsWith('rev-list'))).toHaveLength(1);
      clear();
      expect(numberPendingHashes(repo, { dryRun: true }).unresolvedReferences).toEqual(first.unresolvedReferences);
      expect(calls().filter((c) => c.startsWith('rev-list'))).toHaveLength(0);
      const head = git('rev-parse', 'HEAD').trim();
      git('checkout', '-qb', 'lane/flight');
      write('backlog/xflight-flight.md', '---\nstatus: open\n---\n');
      git('add', '.'); git('commit', '-qm', 'flight');
      git('checkout', '--detach', head);
      clear();
      const third = numberPendingHashes(repo, { dryRun: true });
      const walks = calls().filter((c) => c.startsWith('rev-list'));
      expect(walks).toHaveLength(1);
      expect(walks[0]).toContain('--not');
      expect(third.unresolvedReferences).toContainEqual({ hash: 'xflight', name: 'xhash01-alpha', status: 'in-flight' });
      git('branch', '-D', 'lane/flight');
      clear();
      expect(numberPendingHashes(repo, { dryRun: true }).unresolvedReferences).toEqual(third.unresolvedReferences);
      expect(calls().filter((c) => c.startsWith('rev-list'))).toHaveLength(0);
    });
  });

  it.each(['corrupt', 'version', 'missing-tip', 'unwritable'])('survives a %s visibility cache', (kind) => {
    pendingReferences();
    const cachePath = join(repo, '.git/we-jit-visible-hashes.json');
    if (kind === 'unwritable') mkdirSync(cachePath);
    else writeFileSync(cachePath, kind === 'corrupt' ? '{' : JSON.stringify({
      version: kind === 'version' ? 2 : 1, tips: ['f'.repeat(40)], hashes: [],
    }));
    withGitLog((calls) => {
      const result = numberPendingHashes(repo, { dryRun: true });
      expect(result.unresolvedReferences.map((r) => r.status)).toEqual(['unresolvable', 'unresolvable', 'unresolvable']);
      const walks = calls().filter((c) => c.startsWith('rev-list'));
      expect(walks).toHaveLength(kind === 'missing-tip' ? 2 : 1);
      expect(walks.at(-1)).not.toContain('--not');
      expect(readdirSync(join(repo, '.git')).filter((name) => name.endsWith('.tmp'))).toEqual([]);
      if (kind !== 'unwritable') expect(JSON.parse(readFileSync(cachePath, 'utf8')).version).toBe(1);
    });
  });

  it('does not print timings or resolve references when no hashes are pending', () => {
    write('backlog/001-numbered.md', '---\nstatus: open\n---\n');
    git('add', '.'); git('commit', '-qm', 'numbered');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(numberPendingHashes(repo)).toEqual({ assigned: [], committed: false });
      expect(warn).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  it('disables cache reads and writes with WE_JIT_VISIBLE_HASH_CACHE=0', () => {
    pendingReferences();
    const old = process.env.WE_JIT_VISIBLE_HASH_CACHE;
    process.env.WE_JIT_VISIBLE_HASH_CACHE = '0';
    try {
      withGitLog((calls) => {
        const first = numberPendingHashes(repo, { dryRun: true });
        expect(numberPendingHashes(repo, { dryRun: true }).unresolvedReferences).toEqual(first.unresolvedReferences);
        const walks = calls().filter((c) => c.startsWith('rev-list'));
        expect(walks).toHaveLength(2);
        expect(walks.every((c) => !c.includes('--not'))).toBe(true);
        expect(existsSync(join(repo, '.git/we-jit-visible-hashes.json'))).toBe(false);
      });
    } finally {
      if (old === undefined) delete process.env.WE_JIT_VISIBLE_HASH_CACHE;
      else process.env.WE_JIT_VISIBLE_HASH_CACHE = old;
    }
  });

  it('#3383 — the unresolved-reference fallback stays O(1) git subprocesses as the ref count grows, never O(refs)', () => {
    // The live incident this proves against: `resolveReference`'s fallback used to build its visibility
    // set with ONE `git ls-tree -r -- backlog/` subprocess PER visible ref (refs/heads/ + refs/remotes/) —
    // fine with a handful of refs, but a 2000+-ref constellation clone turned a single numbering pass into
    // a 10-14 minute wall-clock stall (measured live, #3383). Spy on the REAL `execFileSync` (still runs
    // git for real — behavior must stay correct, not just fast) and assert: however many refs exist,
    // `ls-tree` is called ZERO times (the O(refs) fan-out this item removes) and the replacement
    // `rev-list --objects` walk is called AT MOST once (memoized per `numberPendingHashes` call).
    write('backlog/2200-legacy.md', '---\nkind: story\n---\n# Legacy\n');
    write('backlog/xflight-in-flight.md', '---\nkind: story\n---\n# Flight\n');
    write(QUEUED_REL, JSON.stringify({ queued: [] }));
    git('add', '.'); git('commit', '-qm', 'in-flight branch');
    git('branch', 'lane/flight');
    // Simulate a mature constellation clone's ref pile-up: many MORE branches, none of which carry the
    // referenced hash — only `lane/flight` (created above) does. If the fallback were still O(refs), each
    // of these would cost its own `ls-tree -r` subprocess; the assertion below proves it no longer does.
    for (let i = 0; i < 30; i++) git('branch', `lane/decoy-${i}`);
    git('rm', 'backlog/xflight-in-flight.md');
    write('backlog/xdep002-dependent.md', '---\nkind: story\nblockedBy:\n  - xflight\n  - xdead00\n---\n# Dependent\n');
    git('add', '.'); git('commit', '-qm', 'dependent lands');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');

    // Node's built-in `child_process` module is not spy-able (its exports are non-configurable), so the
    // subprocess count is observed instead with a real PATH-shadowing `git` shim: every invocation is
    // logged to a file, then re-executed against the REAL git — behavior stays exactly real, only the
    // call log is new instrumentation.
    const shimDir = mkdtempSync(join(tmpdir(), 'git-shim-'));
    const logFile = join(shimDir, 'calls.log');
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    writeFileSync(join(shimDir, 'git'), `#!/bin/sh\necho "$@" >> "${logFile}"\nexec "${realGit}" "$@"\n`);
    execFileSync('chmod', ['+x', join(shimDir, 'git')]);
    const origPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${origPath}`;
    try {
      const res = numberPendingHashes(repo, { dryRun: true });
      // Correctness is unchanged (same fixture shape as the test above): xflight still resolves in-flight
      // via `lane/flight`, xdead00 still resolves unresolvable — proving the O(1) replacement answers the
      // SAME question, not a cheaper-but-wrong one.
      expect(res.unresolvedReferences).toEqual([
        { hash: 'xflight', name: 'xdep002-dependent', status: 'in-flight' },
        { hash: 'xdead00', name: 'xdep002-dependent', status: 'unresolvable' },
      ]);
      const calls = existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean) : [];
      const lsTreeCalls = calls.filter((l) => l.startsWith('ls-tree'));
      const revListCalls = calls.filter((l) => l.startsWith('rev-list'));
      expect(lsTreeCalls.length).toBe(0); // the O(refs) fan-out this item removes
      expect(revListCalls.length).toBeLessThanOrEqual(1); // the O(1) replacement, memoized per call
    } finally {
      process.env.PATH = origPath;
      rmSync(shimDir, { recursive: true, force: true });
    }
  });

  it('keeps the ledger entry when other couples are still queued (cross-lane repair later)', () => {
    write('backlog/2200-legacy.md', '---\nkind: story\n---\n# Legacy\n');
    write('backlog/xhash01-alpha.md', '---\nkind: story\nstatus: resolved\n---\n# Alpha\n');
    // Another couple still in flight → the ledger must retain xhash01→NNN so that couple's later land can
    // repair any edge that points at xhash01.
    write(QUEUED_REL, JSON.stringify({ queued: [{ num: 'xother2', at: null }] }));
    git('add', 'backlog', '.claude', '.gitignore'); git('commit', '-qm', 'seed');

    const res = numberPendingHashes(repo);
    expect(res.assigned).toEqual([{ hash: 'xhash01', nnn: '2201' }]);
    expect(JSON.parse(readFileSync(join(repo, LEDGER_REL), 'utf8'))).toEqual({ xhash01: '2201' });
  });

  it('resolves a dependent that references an already-numbered blocker via a pre-seeded ledger', () => {
    // Blocker already landed (its file is 2201-alpha, hash gone); its hash→NNN still sits in the ledger.
    write('backlog/2201-alpha.md', '---\nkind: story\nstatus: resolved\n---\n# Alpha\n');
    write('backlog/xdep002-beta.md', '---\nkind: story\nblockedBy: ["xblk001"]\n---\n# Beta\n');
    write(LEDGER_REL, JSON.stringify({ xblk001: '2201' }));
    write(QUEUED_REL, JSON.stringify({ queued: [] }));
    git('add', 'backlog', '.claude', '.gitignore'); git('commit', '-qm', 'seed');

    numberPendingHashes(repo); // beta lands → 2202, and its stale xblk001 edge → 2201
    const beta = readFileSync(join(repo, 'backlog/2202-beta.md'), 'utf8');
    expect(beta).toContain('blockedBy: ["2201"]');
    expect(backlogNames()).toContain('2202-beta.md');
  });

  it('numbers a couple PLUS a leftover scaffolded in its lane, in topological order (#2288)', () => {
    // A landed lane carries the couple's own item AND a leftover it scaffolded during close-out — both are
    // hash-keyed on main and both must be numbered; the leftover blockedBy the couple → numbered AFTER it.
    write('backlog/2200-legacy.md', '---\nkind: story\n---\n# Legacy\n');
    write('backlog/xcoupl1-main.md', '---\nkind: story\nstatus: resolved\n---\n# Main item\n');
    write('backlog/xleft02-followup.md', '---\nkind: task\nblockedBy: ["xcoupl1"]\n---\n# Leftover follow-up\n');
    write(QUEUED_REL, JSON.stringify({ queued: [] }));
    git('add', 'backlog', '.claude', '.gitignore'); git('commit', '-qm', 'seed');

    const res = numberPendingHashes(repo);
    // Blocker (xcoupl1) numbered first → 2201; dependent (xleft02) after → 2202.
    expect(res.assigned).toEqual([{ hash: 'xcoupl1', nnn: '2201' }, { hash: 'xleft02', nnn: '2202' }]);
    const names = backlogNames();
    expect(names).toContain('2201-main.md');
    expect(names).toContain('2202-followup.md');
    // The leftover's blockedBy edge to the couple is repaired to the couple's assigned number.
    expect(readFileSync(join(repo, 'backlog/2202-followup.md'), 'utf8')).toContain('blockedBy: ["2201"]');
    expect(git('status', '--porcelain').trim()).toBe('');
  });

  it('stamps bornAs:<hash> into the numbered item as the durable proof-of-land (#2392)', () => {
    write('backlog/2200-legacy.md', '---\nkind: story\n---\n# Legacy\n');
    write('backlog/xhash01-alpha.md', '---\nkind: story\nblockedBy: ["2100"]\n---\n# Alpha\n');
    write(QUEUED_REL, JSON.stringify({ queued: [] }));
    git('add', 'backlog', '.claude', '.gitignore'); git('commit', '-qm', 'seed');

    const res = numberPendingHashes(repo);
    expect(res.assigned).toEqual([{ hash: 'xhash01', nnn: '2201' }]);
    const alpha = readFileSync(join(repo, 'backlog/2201-alpha.md'), 'utf8');
    // The birth hash is stamped as the first frontmatter field and survives the numbering rewrite.
    expect(alpha).toContain('bornAs: xhash01');
    expect(alpha).not.toContain('bornAs: 2201');
  });

  it('landedNumberFor reads bornAs off origin/main: resolves a landed hash, null for an unlanded one (#2392)', () => {
    write('backlog/2201-alpha.md', '---\nbornAs: xhash01\nkind: story\n---\n# Alpha\n');
    git('add', 'backlog', '.gitignore'); git('commit', '-qm', 'seed');
    // No real remote — point the origin/main ref at HEAD so `git grep origin/main` resolves.
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');

    expect(landedNumberFor('xhash01', repo)).toBe('2201'); // landed → its assigned number
    expect(landedNumberFor('xnope99', repo)).toBe(null);   // never landed → no bornAs record
    expect(landedNumberFor('not-a-hash', repo)).toBe(null); // non-hash input → null, no git call
  });

  it('renames a relatedReport file whose stem embeds the hash + rewrites its internal refs (#2400, the #2387 regression)', () => {
    write('backlog/2200-legacy.md', '---\nkind: story\n---\n# Legacy\n');
    write('backlog/xepic01-overlap.md',
      '---\nkind: epic\nstatus: resolved\nrelatedReport: reports/2026-07-10-split-analysis-xepic01.md\n---\n# Overlap epic\n');
    write('reports/2026-07-10-split-analysis-xepic01.md', '# Split analysis\n\nFocused run: `/slice xepic01`. Candidate #xepic01.\n');
    write(QUEUED_REL, JSON.stringify({ queued: [] }));
    git('add', 'backlog', 'reports', '.claude', '.gitignore'); git('commit', '-qm', 'seed');

    const res = numberPendingHashes(repo);
    expect(res.assigned).toEqual([{ hash: 'xepic01', nnn: '2201' }]);
    expect(res.committed).toBe(true);
    // The item's relatedReport ref is rewritten to the number…
    expect(readFileSync(join(repo, 'backlog/2201-overlap.md'), 'utf8'))
      .toContain('relatedReport: reports/2026-07-10-split-analysis-2201.md');
    // …and the report FILE is renamed to match (no dangle, not hidden)…
    expect(() => readFileSync(join(repo, 'reports/2026-07-10-split-analysis-xepic01.md'), 'utf8')).toThrow();
    const report = readFileSync(join(repo, 'reports/2026-07-10-split-analysis-2201.md'), 'utf8');
    // …with its own internal hash refs rewritten too.
    expect(report).toContain('/slice 2201');
    expect(report).toContain('#2201');
    expect(report).not.toContain('xepic01');
    // Everything landed in the one numbering commit — working tree clean.
    expect(git('status', '--porcelain').trim()).toBe('');
  });

  it('rewrites a body /backlog/<hash>/ URL to the number with no report file to rename (#2400)', () => {
    write('backlog/2200-legacy.md', '---\nkind: story\n---\n# Legacy\n');
    write('backlog/xitem01-alpha.md', '---\nkind: story\nstatus: resolved\n---\n# Alpha\n\nSee /backlog/xitem01/ for context.\n');
    write(QUEUED_REL, JSON.stringify({ queued: [] }));
    git('add', 'backlog', '.claude', '.gitignore'); git('commit', '-qm', 'seed');

    numberPendingHashes(repo);
    expect(readFileSync(join(repo, 'backlog/2201-alpha.md'), 'utf8')).toContain('/backlog/2201/');
    expect(git('status', '--porcelain').trim()).toBe('');
  });

  it('REFUSES a traversal path-value ref — never writes/deletes outside the repo (#2400 containment)', () => {
    // A crafted relatedReport with `..` escapes would otherwise make the drain writeFileSync the rewritten
    // NEW path + `git rm` the OLD one, both OUTSIDE the tree — writing an arbitrary file and deleting a real
    // one. The victim below sits ABOVE the repo root and embeds the hash so the ref resolves to a real file
    // (existsSync true) — the exact condition the confinement check must veto. The item still numbers fine.
    const victimName = `pr385-victim-${Date.now()}-xevil01.md`;
    const victimPath = join(repo, '..', victimName);        // outside the repo root
    const numberedSibling = join(repo, '..', victimName.replace('xevil01', '2201'));
    writeFileSync(victimPath, '# I live outside the repo and must not be touched\n');
    try {
      write('backlog/2200-legacy.md', '---\nkind: story\n---\n# Legacy\n');
      write('backlog/xevil01-attack.md',
        `---\nkind: story\nstatus: resolved\nrelatedReport: ../${victimName}\n---\n# Attack\n`);
      write(QUEUED_REL, JSON.stringify({ queued: [] }));
      git('add', 'backlog', '.claude', '.gitignore'); git('commit', '-qm', 'seed');

      const res = numberPendingHashes(repo);
      // The item itself is still numbered — the malicious ref is simply not acted on as a file rename.
      expect(res.assigned).toEqual([{ hash: 'xevil01', nnn: '2201' }]);
      expect(backlogNames()).toContain('2201-attack.md');
      // The out-of-repo victim is untouched: original content intact, NOT deleted, no numbered sibling written.
      expect(existsSync(victimPath)).toBe(true);
      expect(readFileSync(victimPath, 'utf8')).toContain('must not be touched');
      expect(existsSync(numberedSibling)).toBe(false);
    } finally {
      try { rmSync(victimPath, { force: true }); } catch { /* best-effort */ }
      try { rmSync(numberedSibling, { force: true }); } catch { /* best-effort */ }
    }
  });

  it('rewrites a pending-hash citation in docs/agent/*.md — the statute layer (#2428)', () => {
    write('backlog/2200-legacy.md', '---\nkind: story\n---\n# Legacy\n');
    write('backlog/xhash01-alpha.md', '---\nkind: story\nstatus: resolved\n---\n# Alpha\n');
    write('docs/agent/platform-decisions.md', '# Platform decisions\n\nBuild carried by #xhash01.\n');
    write(QUEUED_REL, JSON.stringify({ queued: [] }));
    git('add', 'backlog', 'docs', '.claude', '.gitignore'); git('commit', '-qm', 'seed');

    const res = numberPendingHashes(repo);
    expect(res.assigned).toEqual([{ hash: 'xhash01', nnn: '2201' }]);
    expect(res.committed).toBe(true);
    // The statute doc's citation is rewritten to the landed number, in the SAME commit as the numbering.
    expect(readFileSync(join(repo, 'docs/agent/platform-decisions.md'), 'utf8')).toContain('Build carried by #2201.');
    expect(git('status', '--porcelain').trim()).toBe('');
  });

  it('leaves an untracked/absent docs/agent/*.md alone — never fatal when the dir has no match (#2428)', () => {
    write('backlog/2200-legacy.md', '---\nkind: story\n---\n# Legacy\n');
    write('backlog/xhash02-beta.md', '---\nkind: story\nstatus: resolved\n---\n# Beta\n');
    write(QUEUED_REL, JSON.stringify({ queued: [] }));
    git('add', 'backlog', '.claude', '.gitignore'); git('commit', '-qm', 'seed');
    // No docs/agent/ directory exists at all in this throwaway repo.

    const res = numberPendingHashes(repo);
    expect(res.assigned).toEqual([{ hash: 'xhash02', nnn: '2201' }]);
    expect(res.committed).toBe(true);
  });

  it('rewrites a pending-hash citation in agent-memory-src/*.md, in the SAME land commit (#3100)', () => {
    write('backlog/2200-legacy.md', '---\nkind: story\n---\n# Legacy\n');
    write('backlog/xhash01-alpha.md', '---\nkind: story\nstatus: resolved\n---\n# Alpha\n');
    write('agent-memory-src/some-note.md', '---\nname: some-note\n---\n\nFiled #xhash01, 2026-08-14.\n');
    write(QUEUED_REL, JSON.stringify({ queued: [] }));
    git('add', 'backlog', 'agent-memory-src', '.claude', '.gitignore'); git('commit', '-qm', 'seed');

    const res = numberPendingHashes(repo);
    expect(res.assigned).toEqual([{ hash: 'xhash01', nnn: '2201' }]);
    expect(res.committed).toBe(true);
    // The memory note's citation is rewritten to the landed number, in the SAME commit as the numbering —
    // proving the #3100 widening reaches agent-memory-src/ the same way #2428 reached docs/agent/.
    expect(readFileSync(join(repo, 'agent-memory-src/some-note.md'), 'utf8')).toContain('Filed #2201, 2026-08-14.');
    expect(git('status', '--porcelain').trim()).toBe('');
  });

  it('protects a bornAs: line in agent-memory-src/*.md from the blind rewrite — explicitly asserted, not assumed (#3100)', () => {
    // agent-memory-src/*.md files don't carry a `bornAs:` frontmatter field in practice (that convention is
    // backlog-item-only), but the guard in applyLedger is a per-LINE regex with no file-type awareness — this
    // proves it holds regardless of which directory fed the file in, per finding 2 of #3100's own grounding.
    write('backlog/2200-legacy.md', '---\nkind: story\n---\n# Legacy\n');
    write('backlog/xhash01-alpha.md', '---\nkind: story\nstatus: resolved\n---\n# Alpha\n');
    write('agent-memory-src/some-note.md', '---\nname: some-note\nbornAs: xhash01\n---\n\nFiled #xhash01, 2026-08-14.\n');
    write(QUEUED_REL, JSON.stringify({ queued: [] }));
    git('add', 'backlog', 'agent-memory-src', '.claude', '.gitignore'); git('commit', '-qm', 'seed');

    numberPendingHashes(repo);
    const note = readFileSync(join(repo, 'agent-memory-src/some-note.md'), 'utf8');
    // The `bornAs:` frontmatter line is preserved verbatim (the hash it names must survive the rewrite)…
    expect(note).toContain('bornAs: xhash01');
    // …while the OTHER citation on a different line is still rewritten.
    expect(note).toContain('Filed #2201, 2026-08-14.');
  });

  it('leaves an untracked/absent agent-memory-src/*.md alone — never fatal when the dir has no match (#3100)', () => {
    write('backlog/2200-legacy.md', '---\nkind: story\n---\n# Legacy\n');
    write('backlog/xhash03-gamma.md', '---\nkind: story\nstatus: resolved\n---\n# Gamma\n');
    write(QUEUED_REL, JSON.stringify({ queued: [] }));
    git('add', 'backlog', '.claude', '.gitignore'); git('commit', '-qm', 'seed');
    // No agent-memory-src/ directory exists at all in this throwaway repo.

    const res = numberPendingHashes(repo);
    expect(res.assigned).toEqual([{ hash: 'xhash03', nnn: '2201' }]);
    expect(res.committed).toBe(true);
  });

  it('rewrites a pending-hash citation in scripts/conveyor/flows/*.flow.json, in the SAME land commit (#4075/xmd4pfa)', () => {
    // Reproduces the live incident: a flow file cites a card's backlog file by its pre-numbering hash name
    // (`backlog/<hash>-slug.md:LINE`); without this sweep the cite dangles the instant the card lands
    // numbered — exactly how build-dispatch.flow.json's `backlog/xr05jjl-…` cite turned main's CI red.
    write('backlog/2200-legacy.md', '---\nkind: story\n---\n# Legacy\n');
    write('backlog/xhash01-alpha.md', '---\nkind: story\nstatus: resolved\n---\n# Alpha\n');
    write('scripts/conveyor/flows/build-dispatch.flow.json', JSON.stringify({
      id: 'build-dispatch',
      cite: 'backlog/xhash01-alpha.md:1',
    }));
    write(QUEUED_REL, JSON.stringify({ queued: [] }));
    git('add', 'backlog', 'scripts', '.claude', '.gitignore'); git('commit', '-qm', 'seed');

    const res = numberPendingHashes(repo);
    expect(res.assigned).toEqual([{ hash: 'xhash01', nnn: '2201' }]);
    expect(res.committed).toBe(true);
    // The flow's own citation is rewritten to the landed number, in the SAME commit as the numbering —
    // proving the #4075/xmd4pfa widening reaches scripts/conveyor/flows/ the same way #2428 reached
    // docs/agent/ and #3100 reached agent-memory-src/.
    const flow = JSON.parse(readFileSync(join(repo, 'scripts/conveyor/flows/build-dispatch.flow.json'), 'utf8'));
    expect(flow.cite).toBe('backlog/2201-alpha.md:1');
    expect(git('status', '--porcelain').trim()).toBe('');
  });

  it('rewrites a pending-hash `ack` value to "#NNN" (never bare NNN), and the flow checker accepts the result (#4247)', () => {
    // Reproduces the OTHER live incident (#4247, main red): a flow file's `ack` value is documented
    // (scripts/conveyor/flows/README.md) to accept ONLY "#NNNN" or a bare "xHASH" — never a bare NNN — so
    // it is authored bare while the card is still pending ("silent-failure": "xhash02"). The SAME blind
    // swap that correctly turns a docs/backlog hash reference into its landed form turned this into a bare
    // "2201", which the checker's own CARD_RE then rejects as `bad-ack`. normalizeFlowAckCardRefs repairs
    // it to "#2201" in the SAME land commit.
    write('backlog/2200-legacy.md', '---\nkind: story\n---\n# Legacy\n');
    write('backlog/xhash02-beta.md', '---\nkind: story\nstatus: resolved\n---\n# Beta\n');
    write('scripts/conveyor/flows/build-dispatch.flow.json', JSON.stringify({
      id: 'build-dispatch',
      states: [{
        id: 'session-spawn-failed',
        terminal: true,
        outcome: 'failure',
        escalation: null,
        ack: { 'silent-failure': 'xhash02' },
      }],
    }));
    write(QUEUED_REL, JSON.stringify({ queued: [] }));
    git('add', 'backlog', 'scripts', '.claude', '.gitignore'); git('commit', '-qm', 'seed');

    const res = numberPendingHashes(repo);
    expect(res.assigned).toEqual([{ hash: 'xhash02', nnn: '2201' }]);
    expect(res.committed).toBe(true);

    const flowPath = join(repo, 'scripts/conveyor/flows/build-dispatch.flow.json');
    const flow = JSON.parse(readFileSync(flowPath, 'utf8'));
    // The canonical form is "#NNN", never bare "NNN" — the exact incident the checker's own error message
    // names ("not a card id (#NNNN or xHASH)").
    expect(flow.states[0].ack['silent-failure']).toBe('#2201');
    expect(git('status', '--porcelain').trim()).toBe('');

    // And the checker itself — not just this test's own reading of the shape — accepts the rewritten form:
    // load the SAME file back through the real flow-model.mjs (the module real-flows.test.mjs / check.mjs
    // --ci both run) and assert it raises no `bad-ack` finding.
    const findings = checkFlow({ ...flow, _file: 'build-dispatch.flow.json' });
    expect(findings.filter((f) => f.rule === 'bad-ack')).toEqual([]);
  });

  it('leaves an untracked/absent scripts/conveyor/flows/*.flow.json alone — never fatal when the dir has no match (#4075/xmd4pfa)', () => {
    write('backlog/2200-legacy.md', '---\nkind: story\n---\n# Legacy\n');
    write('backlog/xhash04-delta.md', '---\nkind: story\nstatus: resolved\n---\n# Delta\n');
    write(QUEUED_REL, JSON.stringify({ queued: [] }));
    git('add', 'backlog', '.claude', '.gitignore'); git('commit', '-qm', 'seed');
    // No scripts/conveyor/flows/ directory exists at all in this throwaway repo.

    const res = numberPendingHashes(repo);
    expect(res.assigned).toEqual([{ hash: 'xhash04', nnn: '2201' }]);
    expect(res.committed).toBe(true);
  });

  it.each([
    'scripts/some-new-thing.mjs',
    'scripts/conveyor/soak/breaks/fixtures/input.mjs',
  ])('REFUSES to number when an unswept citation in %s would dangle (#4075 hardening)', (citationPath) => {
    // Replays today's incident for a DIFFERENT, still-unswept file type — proving the sweep-scope list
    // falling behind again can never again silently push a broken citation. A real recurrence would be a
    // NEW citing file kind nobody has taught the sweep about yet; this fixture stands in for that (a plain
    // script or a nested fixture) citing a card by its pre-numbering hash FILE PATH.
    write('backlog/2200-legacy.md', '---\nkind: story\n---\n# Legacy\n');
    write('backlog/xhash01-alpha.md', '---\nkind: story\nstatus: resolved\n---\n# Alpha\n');
    write(citationPath, '// see backlog/xhash01-alpha.md:1 for context\n');
    write(QUEUED_REL, JSON.stringify({ queued: [] }));
    git('add', 'backlog', 'scripts', '.claude', '.gitignore'); git('commit', '-qm', 'seed');

    const res = numberPendingHashes(repo);
    // Refused, not silently numbered-with-a-dangling-ref: nothing assigned, nothing committed.
    expect(res.assigned).toEqual([]);
    expect(res.committed).toBe(false);
    expect(res.error).toMatch(/hash-path citation outside the rewrite scope/);
    expect(res.error).toContain(citationPath);
    expect(res.held).toEqual([{ hash: 'xhash01', citedBy: [citationPath] }]);
    expect(existsSync(join(repo, LEDGER_REL))).toBe(false);
    // The tree is untouched — no partial rename, no rewrite, nothing staged.
    expect(git('status', '--porcelain').trim()).toBe('');
    expect(backlogNames()).toContain('xhash01-alpha.md');
  });

  it('numbers cleanly once the unswept citation is fixed — the very next pass (#4075 hardening)', () => {
    // Same setup as the refusal above, but the offending citation is gone before this pass runs — proving
    // the refusal is a DEFERRAL, not a permanent block: the hash numbers on the very next attempt.
    write('backlog/2200-legacy.md', '---\nkind: story\n---\n# Legacy\n');
    write('backlog/xhash01-alpha.md', '---\nkind: story\nstatus: resolved\n---\n# Alpha\n');
    write(QUEUED_REL, JSON.stringify({ queued: [] }));
    git('add', 'backlog', '.claude', '.gitignore'); git('commit', '-qm', 'seed');

    const res = numberPendingHashes(repo);
    expect(res.assigned).toEqual([{ hash: 'xhash01', nnn: '2201' }]);
    expect(res.committed).toBe(true);
  });

  it('does not refuse over a hash-path citation for a DIFFERENT hash that isn\'t pending this pass', () => {
    // The unswept-citation check is scoped to THIS pass's own ledgered hashes — an unrelated, already-landed
    // #NNN's stale prose mention of some other hash-shaped word must never block a real, unrelated numbering.
    write('backlog/2200-legacy.md', '---\nkind: story\n---\n# Legacy\n');
    write('backlog/xhash01-alpha.md', '---\nkind: story\nstatus: resolved\n---\n# Alpha\n');
    // Cites a hash that is NOT in this pass's ledger (no backlog/xnotone-*.md exists at all) — irrelevant noise.
    write('scripts/unrelated.mjs', '// once referenced backlog/xnotone-something.md, now gone\n');
    write(QUEUED_REL, JSON.stringify({ queued: [] }));
    git('add', 'backlog', 'scripts', '.claude', '.gitignore'); git('commit', '-qm', 'seed');

    const res = numberPendingHashes(repo);
    expect(res.assigned).toEqual([{ hash: 'xhash01', nnn: '2201' }]);
    expect(res.committed).toBe(true);
  });

  it('does not refuse over a HISTORICAL ledger hash cited by path — only this pass\'s own hashes gate it (PR #2757 review)', () => {
    // The ledger is append-only: a hash numbered in some past pass stays in it forever. A stale prose
    // mention of that old hash's path (its backlog file long renamed away) must not block an unrelated,
    // genuinely pending hash from numbering — else one historical mention would stall JIT numbering for good.
    write('backlog/2200-legacy.md', '---\nkind: story\n---\n# Legacy\n');
    write('backlog/xhash01-alpha.md', '---\nkind: story\nstatus: resolved\n---\n# Alpha\n');
    write('reports/old-note.md', 'Historical: see backlog/xblk001-old-card.md for the original write-up.\n');
    write(LEDGER_REL, JSON.stringify({ xblk001: '2150' }));
    write(QUEUED_REL, JSON.stringify({ queued: [] }));
    git('add', 'backlog', 'reports', '.claude', '.gitignore'); git('commit', '-qm', 'seed');

    const res = numberPendingHashes(repo);
    expect(res.assigned).toEqual([{ hash: 'xhash01', nnn: '2201' }]);
    expect(res.committed).toBe(true);
  });

  it('REFUSES when a pending hash-path citation follows an unrelated one on the SAME line (PR #2757 review)', () => {
    // Every citation on a line counts, not just the first: an unrelated hash path first must not hide the
    // pending one after it.
    write('backlog/2200-legacy.md', '---\nkind: story\n---\n# Legacy\n');
    write('backlog/xhash01-alpha.md', '---\nkind: story\nstatus: resolved\n---\n# Alpha\n');
    write('scripts/mixed.mjs', '// see backlog/xnotone-other.md and backlog/xhash01-alpha.md\n');
    write(QUEUED_REL, JSON.stringify({ queued: [] }));
    git('add', 'backlog', 'scripts', '.claude', '.gitignore'); git('commit', '-qm', 'seed');

    const res = numberPendingHashes(repo);
    expect(res.assigned).toEqual([]);
    expect(res.committed).toBe(false);
    expect(res.error).toContain('scripts/mixed.mjs cites xhash01');
    expect(backlogNames()).toContain('xhash01-alpha.md');
  });

  it('skips an UNTRACKED hash file (local cruft) instead of aborting the tracked couple (PR #194)', () => {
    write('backlog/2200-legacy.md', '---\nkind: story\n---\n# Legacy\n');
    write('backlog/xland01-item.md', '---\nkind: story\nstatus: resolved\n---\n# Landed item\n');
    write(QUEUED_REL, JSON.stringify({ queued: [] }));
    git('add', 'backlog', '.claude', '.gitignore'); git('commit', '-qm', 'seed');
    // An uncommitted scaffold sits in the checkout — NOT a landed item; a git rm on it would abort the pass.
    write('backlog/xcruft1-wip.md', '---\nkind: task\n---\n# Uncommitted work-in-progress\n');

    const res = numberPendingHashes(repo);
    // Only the tracked hash is numbered; the untracked one is left untouched, not aborted.
    expect(res.assigned).toEqual([{ hash: 'xland01', nnn: '2201' }]);
    expect(backlogNames()).toContain('2201-item.md');
    expect(backlogNames()).toContain('xcruft1-wip.md'); // untracked cruft left as-is
  });
});

describe('#2899 A1 — the card is located in the origin/main TREE, not the local INDEX', () => {
  // The defect: `readResolveReachable` resolved the card with `git ls-files backlog/<NNN>-*.md`, a query against
  // the LOCAL INDEX. A freshly JIT-numbered item's `<NNN>`-named file exists on main but has NEVER been in this
  // checkout's index, so the probe reported it absent, the read returned `null` ("couldn't tell"), and the
  // caller's `=== false` guard skipped the flip with no attempt and no warning. Reading the TREE is the fix.
  //
  // The setup below reproduces exactly that divergence: `origin/main` carries `backlog/2202-alpha.md` while the
  // local index still carries only the pre-numbering hash name.
  const seedDivergedRepo = () => {
    const origin = mkdtempSync(join(tmpdir(), 'drain-origin-'));
    execFileSync('git', ['init', '-q', '--bare'], { cwd: origin });
    git('remote', 'add', 'origin', origin);
    write('backlog/xhash01-alpha.md', '---\nkind: story\nstatus: active\n---\n# Alpha\n');
    git('add', 'backlog', '.gitignore'); git('commit', '-qm', 'pre-numbering');
    git('push', '-q', 'origin', 'HEAD:main');
    // main advances (a numbering commit landed there) while THIS checkout stays on the pre-numbering tree.
    const other = mkdtempSync(join(tmpdir(), 'drain-other-'));
    // `--branch main` is REQUIRED, not tidiness: a bare repo's HEAD follows the runner's `init.defaultBranch`,
    // which is `master` on the CI image and `main` on this machine. Without the pin, the clone checks out an
    // UNBORN branch and the `git mv` below dies with "fatal: bad source" — green locally, red on CI.
    execFileSync('git', ['clone', '-q', '--branch', 'main', origin, other]);
    const og = (...a) => execFileSync('git', a, { cwd: other, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    og('config', 'user.email', 'test@test'); og('config', 'user.name', 'Test'); og('config', 'commit.gpgsign', 'false');
    execFileSync('git', ['mv', 'backlog/xhash01-alpha.md', 'backlog/2202-alpha.md'], { cwd: other });
    og('commit', '-qm', 'drain: JIT-number xhash01→#2202 at land');
    og('push', '-q', 'origin', 'HEAD:main');
    git('fetch', '-q', 'origin');
    return origin;
  };

  it('cardPathInTree finds a freshly-numbered card that `git ls-files` cannot see', () => {
    seedDivergedRepo();
    // The old probe: the index has only the HASH name, so the numbered lookup comes back empty — this is the
    // exact input that made the old code return null and silently skip the flip.
    expect(git('ls-files', 'backlog/2202-*.md').trim()).toBe('');
    // The new probe reads origin/main's tree and finds it.
    expect(cardPathInTree(repo, '2202')).toBe('backlog/2202-alpha.md');
  });

  it('returns null for a card genuinely absent from the tree (no false positive)', () => {
    seedDivergedRepo();
    expect(cardPathInTree(repo, '9999')).toBe(null);
  });

  it('reads the tree it is asked for — a different ref is a different answer', () => {
    seedDivergedRepo();
    // HEAD is still the pre-numbering tree, so the numbered name is absent there and the hash name is present.
    expect(cardPathInTree(repo, '2202', { tree: 'HEAD' })).toBe(null);
    expect(cardPathInTree(repo, 'xhash01', { tree: 'HEAD' })).toBe('backlog/xhash01-alpha.md');
  });

  it('is a null-verdict, not a throw, when the tree cannot be read at all', () => {
    // No such ref → the git read fails → null ("couldn't tell"), never an exception that would unwind a land.
    expect(cardPathInTree(repo, '2202', { tree: 'no/such/ref' })).toBe(null);
  });
});

// #3914 — a lane that FILES a born-active (`--session`) card under a provisional hash AND delivers it in the
// same PR (`lane/<hash>-…`, no manifest — the #3459/#3492/#3638 shape) used to be JIT-numbered at land and left
// `active` forever: the non-manifest resolve-on-land extractor matched digits only, so the hash-led lane ref
// contributed nothing. This drives the drain's real land-time chain on a fixture main — numbering, the landed-id
// credit, and the resolve plan — and asserts the freshly-minted NNN is the one handed to the resolve writer,
// while a spin-off the same PR merely filed in passing is not.
describe('#3914 — resolve-on-land for a card filed AND delivered in the same hash-led lane PR', () => {
  it('credits the lane-ref hash, re-keys it to the minted NNN, and leaves the spin-off alone', async () => {
    const { landedIdsForCandidate, planResolveOnLand } = await import('../merge-ai-prs.mjs');
    write('backlog/2200-legacy.md', '---\nkind: story\nstatus: resolved\n---\n# Legacy\n');
    write('backlog/xaa7r2n-itemnumfromref.md', '---\nkind: story\nstatus: active\nscaffoldedBy: session\n---\n# Delivered here\n');
    write('backlog/xspin01-follow-up.md', '---\nkind: story\nstatus: open\n---\n# Filed in passing\n');
    write(QUEUED_REL, JSON.stringify({ queued: [] }));
    git('add', 'backlog', '.claude', '.gitignore'); git('commit', '-qm', 'land lane/xaa7r2n-itemnumfromref-attempt-tag');

    const n = numberPendingHashes(repo);
    const nnnOf = (h) => n.assigned.find((a) => a.hash === h).nnn;

    const landedPr = {
      hasManifest: false, item: null, repo: null, num: 1852,
      headRef: 'lane/xaa7r2n-itemnumfromref-attempt-tag',
      title: 'itemNumFromRef: parse a retried lane PR ref\'s attempt-tag letter (#xaa7r2n)',
    };
    const fetchGuardSignals = () => ({
      body: '',
      changedFiles: ['backlog/xaa7r2n-itemnumfromref.md', 'backlog/xspin01-follow-up.md', 'scripts/readiness/conveyor-state.mjs'],
    });
    // #xqpqyr2 — resolveHashNumber/fetchDiff stubbed inert (this fixture has no real origin/main to read a
    // bornAs record from, and this candidate's changedFiles are hash-named, never a numbered backlog file, so
    // fetchDiff would never legitimately fire anyway) — keeps this test hermetic, never touching real git/gh.
    const landedItems = landedIdsForCandidate(landedPr, { isLocalRepo: (r) => r == null, fetchGuardSignals, resolveHashNumber: () => null, fetchDiff: () => '' });
    const plan = planResolveOnLand({ landedItems, assigned: n.assigned });

    expect(plan.resolve).toEqual([nnnOf('xaa7r2n')]);            // failed before #3914: [] → stayed `active`
    expect(plan.resolve).not.toContain(nnnOf('xspin01'));        // a spin-off is never resolved by this PR
    expect(backlogNames()).toContain(`${nnnOf('xaa7r2n')}-itemnumfromref.md`); // the id the writer will flip exists
  });
});

describe('numberPendingHashesIfAny / hasPendingHashFiles — xb94mt5 (number on ANY pass that finds them)', () => {
  it('hasPendingHashFiles is false on a tree with only landed numeric items', () => {
    write('backlog/2200-legacy.md', '---\nkind: story\nstatus: resolved\n---\n# Legacy\n');
    git('add', 'backlog'); git('commit', '-qm', 'seed');
    expect(hasPendingHashFiles(repo)).toBe(false);
  });

  it('hasPendingHashFiles is true the instant a tracked hash-keyed file exists — no numbering run required first', () => {
    write('backlog/xhash01-alpha.md', '---\nkind: story\nstatus: resolved\n---\n# Alpha\n');
    git('add', 'backlog'); git('commit', '-qm', 'seed');
    expect(hasPendingHashFiles(repo)).toBe(true);
  });

  it('numberPendingHashesIfAny is a true no-op (attempted:false) when nothing is pending — no mutex, no git spawn beyond the cheap check', () => {
    write('backlog/2200-legacy.md', '---\nkind: story\nstatus: resolved\n---\n# Legacy\n');
    git('add', 'backlog'); git('commit', '-qm', 'seed');
    expect(numberPendingHashesIfAny(repo)).toEqual({ attempted: false });
  });

  it('LIVE REPRO (xb94mt5): a hash file left on main by an EARLIER failed push is numbered on a pass with NO merge at all', () => {
    // Simulate the incident: a couple's PR merged and its hash file already sits on "main" (this repo IS
    // main, from numberPendingHashesIfAny's point of view — it never asks "did I just land something"), but
    // an earlier push that should have numbered it was killed/failed, so it is still hash-named. THIS call
    // represents a later, unrelated pass that landed NOTHING new — the old `landedLocal`-gated caller would
    // never even look.
    write('backlog/2200-legacy.md', '---\nkind: story\nstatus: resolved\n---\n# Legacy\n');
    write('backlog/xhash01-alpha.md', '---\nkind: story\nstatus: resolved\n---\n# Alpha\n\nBody mentions xhash01.\n');
    write(QUEUED_REL, JSON.stringify({ queued: [] }));
    git('add', 'backlog', '.claude', '.gitignore'); git('commit', '-qm', 'seed (simulates an earlier failed-push land)');

    // Exercise the real mutex in this fixture, never the developer's shared drain lock.
    const out = numberPendingHashesIfAny(repo, { lockRoot: join(repo, '.git', 'drain-locks') });

    expect(out.attempted).toBe(true);
    expect(out.numbered.assigned).toEqual([{ hash: 'xhash01', nnn: '2201' }]); // max+1 over {2200} → 2201
    expect(out.numbered.committed).toBe(true);
    expect(backlogNames()).toContain('2201-alpha.md');
    expect(backlogNames().some((n) => n.startsWith('xhash01'))).toBe(false);
    // No remote is configured in this throwaway repo, so the publish step itself legitimately fails —
    // `pushed:false` is the honest, non-crashing outcome; the local numbering commit is real either way.
    expect(out.pushed).toBe(false);
    expect(git('log', '-1', '--format=%s')).toMatch(/drain: JIT-number xhash01→#2201 at land/);
  });

  it('xuqk1vp: NEVER numbers unlocked — a live holder makes this pass a clean no-op deferral, not a race', () => {
    write('backlog/xhash01-alpha.md', '---\nkind: story\nstatus: resolved\n---\n# Alpha\n');
    write(QUEUED_REL, JSON.stringify({ queued: [] }));
    git('add', 'backlog', '.claude', '.gitignore'); git('commit', '-qm', 'seed');

    const lockRoot = mkdtempSync(join(tmpdir(), 'drain-lock-ifany-'));
    try {
      expect(tryAcquireNumberingLock(lockRoot, 'someone-else:1:numbering', { nowMs: Date.now(), leaseMinutes: 5 }).ok).toBe(true);
      const out = numberPendingHashesIfAny(repo, { lockRoot, waitMs: 0, sleep: () => {} });
      expect(out).toMatchObject({ attempted: true, deferred: true, heldBy: 'someone-else:1:numbering' });
      // Refused to run — the file is untouched, still hash-named, exactly the safe "retry next pass" state.
      expect(backlogNames().some((n) => n.startsWith('xhash01'))).toBe(true);
      expect(git('status', '--porcelain').trim()).toBe(''); // no partial write, no stray commit
    } finally {
      rmSync(lockRoot, { recursive: true, force: true });
    }
  });

  it('PRODUCTION PATH (review #2668): a `lane-drain drain` pass with an EMPTY queue still numbers a stranded hash file', () => {
    // The real CLI entry point, not the helper: no couple is queued, so nothing merges this pass — the sweep
    // must still find and number the hash a prior failed push left behind. HOME is a throwaway dir so the
    // drain lease + numbering mutex live in a private lock root, never the machine-global one.
    write('scripts/pr-land.mjs', '// WE-root marker for the drain sanity check\n');
    write('backlog/2200-legacy.md', '---\nkind: story\nstatus: resolved\n---\n# Legacy\n');
    write('backlog/xhash01-alpha.md', '---\nkind: story\nstatus: resolved\n---\n# Alpha\n');
    write(QUEUED_REL, JSON.stringify({ queued: [] }));
    git('add', 'scripts', 'backlog', '.claude', '.gitignore'); git('commit', '-qm', 'seed (a hash stranded by an earlier failed push)');
    git('checkout', '-q', '-B', 'main'); // the sweep only runs on `main` — never depend on the host's init.defaultBranch
    const home = mkdtempSync(join(tmpdir(), 'drain-home-'));
    try {
      execFileSync('node', [DRAIN_CLI, 'drain', '--max-idle=0', '--json'], { cwd: repo, encoding: 'utf8', env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
      expect(backlogNames()).toContain('2201-alpha.md');
      expect(backlogNames().some((n) => n.startsWith('xhash01'))).toBe(false);
      expect(git('log', '-1', '--format=%s')).toMatch(/drain: JIT-number xhash01→#2201/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('finalizeLand under a contended numbering lock (review #2668)', () => {
  const seedLanded = () => {
    write('backlog/2200-legacy.md', '---\nkind: story\nstatus: resolved\n---\n# Legacy\n');
    write('backlog/xhash01-alpha.md', '---\nkind: story\nstatus: resolved\n---\n# Alpha\n');
    write(QUEUED_REL, JSON.stringify({ queued: [{ num: '2200', lane: 'lane/2200-legacy' }] }));
    git('add', 'backlog', '.claude', '.gitignore'); git('commit', '-qm', 'seed (couple merged, still queued)');
  };
  const unqueue = (CWD) => writeFileSync(join(CWD, QUEUED_REL), JSON.stringify({ queued: [] }));

  it('still publishes the already-committed unqueue commit, but never numbers unlocked', () => {
    seedLanded();
    const lockRoot = mkdtempSync(join(tmpdir(), 'drain-lock-fin-'));
    try {
      expect(tryAcquireNumberingLock(lockRoot, 'someone-else:1:numbering', { nowMs: Date.now(), leaseMinutes: 5 }).ok).toBe(true);
      const published = [];
      const fin = finalizeLand(repo, '2200', {
        unqueue, publish: (CWD) => { published.push(git('log', '-1', '--format=%s').trim()); return true; },
        lockOpts: { lockRoot, waitMs: 0, sleep: () => {} },
      });
      expect(fin.unqueued).toBe(true);
      expect(published).toEqual(['drain: unqueue + cleanup card 2200 lane manifest post-land (#2175)']); // unqueue went out this pass; #2779-incident — `card N`, never `#N`, for the item number (commit-message-safety.mjs)
      expect(fin.pushed).toBe(true);
      expect(fin.numbered).toEqual({ assigned: [], committed: false });
      // The strict contract held: nothing was numbered while another holder owned the section.
      expect(backlogNames().some((n) => n.startsWith('xhash01'))).toBe(true);
    } finally {
      rmSync(lockRoot, { recursive: true, force: true });
    }
  });

  it('with the lock free, numbers AND publishes in one section (the normal path)', () => {
    seedLanded();
    const lockRoot = mkdtempSync(join(tmpdir(), 'drain-lock-fin-'));
    try {
      let pubs = 0;
      const fin = finalizeLand(repo, '2200', { unqueue, publish: () => { pubs++; return true; }, lockOpts: { lockRoot } });
      expect(fin.numbered.committed).toBe(true);
      expect(fin.pushed).toBe(true);
      expect(pubs).toBe(1);
      expect(backlogNames()).toContain('2201-alpha.md');
    } finally {
      rmSync(lockRoot, { recursive: true, force: true });
    }
  });
});

describe('xsjn0uf-incident — a bornAs already numbered on origin/main is never minted a second number', () => {
  const BODY = '# Same card\n\nIdentical body.\n';
  const seedMain = () => {
    write(QUEUED_REL, JSON.stringify({ queued: [] }));
    write('backlog/5319-same-card.md', `---\nbornAs: xdup001\nkind: story\nstatus: open\n---\n${BODY}`);
    write('backlog/5320-other.md', '---\nkind: story\nstatus: open\nblockedBy: [xdup001]\n---\nOther\n');
    git('add', '.'); git('commit', '-qm', 'card numbered on main');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  };

  it('drops an identical re-landed hash copy: no second NNN, one bornAs on the tree, refs point at the original', () => {
    seedMain();
    write('backlog/xdup001-same-card.md', `---\nkind: story\nstatus: open\n---\n${BODY}`);
    write('backlog/xnew002-fresh.md', '---\nkind: story\nstatus: open\nblockedBy: [xdup001]\n---\nFresh\n');
    git('add', '.'); git('commit', '-qm', 'second PR re-lands the same card + a new one');
    const r = numberPendingHashes(repo);
    expect(r.committed).toBe(true);
    expect(r.droppedDuplicates.map((d) => d.hash)).toEqual(['xdup001']);
    expect(r.assigned.map((a) => a.hash)).toEqual(['xnew002']); // the genuinely new card still numbers
    expect(r.assigned[0].nnn).toBe('5321');
    expect(backlogNames()).toEqual(['5319-same-card.md', '5320-other.md', '5321-fresh.md']);
    expect(readFileSync(join(repo, 'backlog/5321-fresh.md'), 'utf8')).toContain('blockedBy: [5319]');
    expect(git('status', '--porcelain').trim()).toBe('');
  });

  it('holds (does not drop, does not mint) a copy whose body differs from the numbered card', () => {
    seedMain();
    write('backlog/xdup001-same-card.md', '---\nkind: story\nstatus: open\n---\n# Same card\n\nDIFFERENT.\n');
    git('add', '.'); git('commit', '-qm', 'divergent re-land');
    const r = numberPendingHashes(repo);
    expect(r.assigned).toEqual([]);
    expect(r.held.map((h) => h.hash)).toEqual(['xdup001']);
    expect(backlogNames()).toEqual(['5319-same-card.md', '5320-other.md', 'xdup001-same-card.md']);
  });
});
