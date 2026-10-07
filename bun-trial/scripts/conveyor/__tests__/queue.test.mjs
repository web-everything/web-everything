/**
 * @file scripts/conveyor/__tests__/queue.test.mjs
 * @description CLI roundtrip proof of the operator's clear-for-build command (WE #2613). Runs the real
 *   `queue.mjs {add|remove|list}` as a subprocess against a TEMP sidecar (via the `CONVEYOR_QUEUE_FILE` env
 *   override — the same resolver the readiness shells use), and asserts add/remove/list write & read the
 *   sidecar. Pins the #2613-review fixes: a `#`-prefixed id stores/dispatches as the bare id (req 1), and
 *   clearing a not-currently-ready id still adds but WARNS (req 2a). The roundtrip cases set
 *   `CONVEYOR_NO_READY_CHECK` to skip the build-queue subprocess (fast + hermetic); the warn case does not.
 */
import { describe, it, test, expect, beforeEach, afterEach } from 'bun:test';
const __ORIG_URL = new URL('../../../../scripts/conveyor/__tests__/queue.test.mjs', import.meta.url).href;
const __ORIG_FILE = new URL(__ORIG_URL).pathname;
const __ORIG_DIR = new URL('.', __ORIG_URL).pathname.replace(/\/$/, '');
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(__ORIG_URL));
const CLI = join(HERE, '..', 'queue.mjs');

let dir;
let SIDECAR;
// Roundtrip runs skip the readiness build-queue shell (fast + hermetic); pass {ready:true} to exercise it.
const run = (args, { ready = false } = {}) =>
  execFileSync('node', [CLI, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CONVEYOR_QUEUE_FILE: SIDECAR, ...(ready ? {} : { CONVEYOR_NO_READY_CHECK: '1' }) },
  });
const readSidecar = () => JSON.parse(readFileSync(SIDECAR, 'utf8'));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conveyor-queue-'));
  SIDECAR = join(dir, '.conveyor', 'queue.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('queue.mjs CLI — add/remove/list roundtrip against a temp sidecar', () => {
  it('add creates the sidecar and lists the cleared id (--json)', () => {
    const out = JSON.parse(run(['add', '2613', '--json']));
    expect(out.ok).toBe(true);
    expect(out.action).toBe('add');
    expect(out.already).toBe(false);
    expect(existsSync(SIDECAR)).toBe(true);
    expect(readSidecar()).toHaveLength(1);
    expect(readSidecar()[0].num).toBe('2613');
    expect(typeof readSidecar()[0].addedAt).toBe('string'); // Date.now stamp in the CLI

    const list = JSON.parse(run(['list', '--json']));
    expect(list.queue.map((e) => e.num)).toEqual(['2613']);
  });

  it('add is idempotent — a second add reports already:true and does not duplicate', () => {
    run(['add', '2613']);
    const again = JSON.parse(run(['add', '2613', '--json']));
    expect(again.already).toBe(true);
    expect(readSidecar()).toHaveLength(1);
  });

  it('remove drops the id; removing an absent id is a no-op (removed:false)', () => {
    run(['add', '2613']);
    run(['add', 'xqxpeac']);
    const rm = JSON.parse(run(['remove', '2613', '--json']));
    expect(rm.removed).toBe(true);
    expect(readSidecar().map((e) => e.num)).toEqual(['xqxpeac']);

    const noop = JSON.parse(run(['remove', '999', '--json']));
    expect(noop.removed).toBe(false);
    expect(readSidecar().map((e) => e.num)).toEqual(['xqxpeac']);
  });

  it('list on an empty/absent sidecar returns []', () => {
    const list = JSON.parse(run(['list', '--json']));
    expect(list.queue).toEqual([]);
  });

  it('a bad action exits non-zero', () => {
    expect(() => run(['frobnicate', '1'])).toThrow();
  });

  it("a `#`-prefixed id stores the BARE id so it matches a build-queue row (#2613 review req 1)", () => {
    const out = JSON.parse(run(['add', '#2613', '--json']));
    expect(out.num).toBe('2613'); // the `#` sigil is stripped
    expect(readSidecar()[0].num).toBe('2613');
    // idempotent across the sigil: adding the bare form is a no-op, not a duplicate
    const again = JSON.parse(run(['add', '2613', '--json']));
    expect(again.already).toBe(true);
    expect(readSidecar()).toHaveLength(1);
  });
});

describe('queue.mjs CLI — clearing a not-ready id still adds but WARNS (#2613 review req 2a)', () => {
  it('a nonexistent id is added AND flagged not-currently-ready (never a silent "✓ cleared")', () => {
    // No CONVEYOR_NO_READY_CHECK → the real build-queue is consulted. 9999999 is never a ready row, so this is
    // deterministic. The id is still stored (a blocked item should auto-arm later), but the operator is warned.
    const out = JSON.parse(run(['add', '9999999', '--json'], { ready: true }));
    expect(out.ok).toBe(true);
    expect(out.ready).toBe(false); // checked and NOT ready
    expect(readSidecar().map((e) => e.num)).toEqual(['9999999']); // still added
    // human output carries the warning (stderr+stdout are both captured by execFileSync's return on success is
    // stdout only; assert via the --json `ready:false` above, which is the machine signal the skill reads).
  });
});

describe('queue.mjs CLI — clearing a non-dispatchable kind (epic/decision) still adds but WARNS (#2646)', () => {
  let backlogDir;
  // Point kindOf at a fixture backlog dir (CONVEYOR_BACKLOG_DIR override) with one card per kind. Keep the
  // readiness shell OFF (default) so the non-dispatchable-kind warning is exercised in isolation.
  const card = (name, kind, extra = '') =>
    writeFileSync(join(backlogDir, name), `---\nkind: ${kind}\nstatus: open\n${extra}---\n\n# ${name}\n`);
  const runKind = (args) =>
    execFileSync('node', [CLI, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CONVEYOR_QUEUE_FILE: SIDECAR, CONVEYOR_NO_READY_CHECK: '1', CONVEYOR_BACKLOG_DIR: backlogDir },
    });

  beforeEach(() => {
    backlogDir = join(dir, 'backlog');
    mkdirSync(backlogDir, { recursive: true });
    card('2100-an-epic.md', 'epic');
    card('2101-a-decision.md', 'decision');
    card('2102-a-story.md', 'story');
    card('2103-landed-was-hash.md', 'epic', 'bornAs: xabc123\n');
  });

  it('an epic is added but flagged non-dispatchable (kind:epic → /slice)', () => {
    const out = JSON.parse(runKind(['add', '2100', '--json']));
    expect(out.ok).toBe(true);
    expect(out.kind).toBe('epic');
    expect(out.nonDispatchable).toBe(true);
    expect(readSidecar().map((e) => e.num)).toEqual(['2100']); // advisory — still added
  });

  it('a decision is added but flagged non-dispatchable (kind:decision → /prepare + /decision)', () => {
    const out = JSON.parse(runKind(['add', '2101', '--json']));
    expect(out.kind).toBe('decision');
    expect(out.nonDispatchable).toBe(true);
    expect(readSidecar().map((e) => e.num)).toEqual(['2101']);
  });

  it('a dispatchable kind (story) is NOT flagged non-dispatchable', () => {
    const out = JSON.parse(runKind(['add', '2102', '--json']));
    expect(out.kind).toBe('story');
    expect(out.nonDispatchable).toBe(false);
  });

  it('resolves a card cleared as its bornAs hash after it JIT-landed as a number', () => {
    const out = JSON.parse(runKind(['add', 'xabc123', '--json']));
    expect(out.kind).toBe('epic'); // matched via bornAs fallback
    expect(out.nonDispatchable).toBe(true);
    expect(readSidecar().map((e) => e.num)).toEqual(['xabc123']);
  });

  it('an unresolvable id is not flagged (kind check is best-effort, never blocks the add)', () => {
    const out = JSON.parse(runKind(['add', '8888888', '--json']));
    expect(out.kind).toBe(null);
    expect(out.nonDispatchable).toBe(false);
    expect(readSidecar().map((e) => e.num)).toEqual(['8888888']); // still added
  });

  it('the kind warning WINS over (suppresses) the generic not-ready warning, and renders its guidance', () => {
    // Readiness ON (no CONVEYOR_NO_READY_CHECK): the real build-queue is consulted. 90001 is a fixture epic id
    // that is never a ready build-queue row, so BOTH signals fire — not-ready AND non-dispatchable-kind. The
    // kind warning must take precedence: the human output shows the epic `/slice` guidance, NOT the generic
    // "not currently ready" note. Asserting stdout is the only way to prove the precedence + message text.
    card('90001-not-ready-epic.md', 'epic');
    const stdout = execFileSync('node', [CLI, 'add', '90001'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CONVEYOR_QUEUE_FILE: SIDECAR, CONVEYOR_BACKLOG_DIR: backlogDir }, // readiness ON
    });
    expect(stdout).toContain('kind:epic');
    expect(stdout).toContain('/slice');
    expect(stdout).not.toContain('not currently ready'); // generic warning suppressed
    expect(readSidecar().map((e) => e.num)).toEqual(['90001']); // still added
  });
});

describe('queue.mjs CLI — migrate-bornas (self-heal a stale JIT-hash row, live incident 2026-09-29)', () => {
  // The live shape: the operator cleared a card by its pre-number hash; the drain later JIT-numbered it,
  // stamping `bornAs: <hash>` on the landed card (#2288/#2392). `migrate-bornas` reads the REAL backlog loader
  // (`src/_data/backlog.js`, via `WE_BACKLOG_DIR` — the SAME override `dispatch-plan.mjs`/`conveyor-state.mjs`
  // use), so the fixture card below needs to satisfy that loader's parse, not just `kindOf`'s raw frontmatter
  // scan (hence `size`/`dateOpened`, mirroring `backlog-scoped-loader.test.mjs`'s fixture).
  let backlogDir;
  beforeEach(() => {
    backlogDir = join(dir, 'we-backlog');
    mkdirSync(backlogDir, { recursive: true });
    writeFileSync(
      join(backlogDir, '4290-drain-daemon-starved.md'),
      '---\nkind: story\nsize: 1\nstatus: open\ndateOpened: "2026-09-01"\nbornAs: x34h6a2\n---\n\n# Fix\n\nbody.\n',
    );
  });

  const runBornAs = (args) =>
    execFileSync('node', [CLI, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CONVEYOR_QUEUE_FILE: SIDECAR, WE_BACKLOG_DIR: backlogDir, CONVEYOR_NO_KIND_CHECK: '1', CONVEYOR_NO_READY_CHECK: '1' },
    });

  it('dry-run reports the rewrite without touching the sidecar; a real run applies it', () => {
    runBornAs(['add', 'x34h6a2', '--json']);
    expect(readSidecar().map((e) => e.num)).toEqual(['x34h6a2']);

    const dry = JSON.parse(runBornAs(['migrate-bornas', '--dry-run', '--json']));
    expect(dry.ok).toBe(true);
    expect(dry.dryRun).toBe(true);
    expect(dry.resolved).toEqual([{ from: 'x34h6a2', to: '4290' }]);
    expect(readSidecar().map((e) => e.num)).toEqual(['x34h6a2']); // unchanged — dry-run never writes

    const real = JSON.parse(runBornAs(['migrate-bornas', '--json']));
    expect(real.resolved).toEqual([{ from: 'x34h6a2', to: '4290' }]);
    expect(readSidecar().map((e) => e.num)).toEqual(['4290']); // rewritten on disk
  });

  it('is idempotent — a second run against an already-resolved queue reports nothing to migrate', () => {
    runBornAs(['add', 'x34h6a2', '--json']);
    runBornAs(['migrate-bornas', '--json']);
    const again = JSON.parse(runBornAs(['migrate-bornas', '--json']));
    expect(again.resolved).toEqual([]);
    expect(readSidecar().map((e) => e.num)).toEqual(['4290']);
  });

  it('a hash with no landed card yet (or a genuine typo) is left alone', () => {
    runBornAs(['add', 'xnotyet1', '--json']);
    const out = JSON.parse(runBornAs(['migrate-bornas', '--json']));
    expect(out.resolved).toEqual([]);
    expect(readSidecar().map((e) => e.num)).toEqual(['xnotyet1']);
  });
});
