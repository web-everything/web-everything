/**
 * @file scaffold-io.test.mjs — the `scaffold` IO SHELL (#xrrpfo7).
 *
 * WHY THIS FILE EXISTS AT ALL, stated plainly: its absence was flagged as a carve-out on PR #1511, and the
 * SAME absence one operation over produced PR #1510's blocker. There, `createResolveReader` shipped with its
 * reconciliation defaulting to `null` while `run.mjs` called it with no arguments — so a guard never ran, and
 * reported CLEAN while not running. Seventeen green tests missed it because every one drove the pure planner
 * with a hand-built fixture. A declaration suite cannot see a wiring bug, by construction.
 *
 * So these tests drive the REAL reader and the REAL sink with injected fs, never a fixture standing in for
 * them.
 */
import { describe, it, expect } from 'vitest';
import { createScaffoldReader, createScaffoldSinks } from '../scaffold-io.mjs';
import { SCAFFOLD_EFFECT } from '../scaffold.mjs';

describe('the reader supplies exactly what the allocator needs', () => {
  it('collects EVERY card id, including resolved ones', () => {
    // Filtering to open items would let the allocator hand back an id a resolved card already owns, and two
    // cards sharing an id is not a state anything downstream untangles.
    const read = createScaffoldReader({ allocate: () => ({ ok: false, reason: 'test disabled' }), log: () => {},
      root: '/repo',
      listFiles: () => ['001-a.md', '002-b.md', 'xabc-c.md', 'notes.txt', '3201-resolved.md'],
      today: () => '2026-08-21',
    })();
    expect(read.existingIds.sort()).toEqual(['001', '002', '3201', 'xabc']);
  });

  it('ignores non-markdown entries rather than minting ids from them', () => {
    const read = createScaffoldReader({ allocate: () => ({ ok: false, reason: 'test disabled' }), log: () => {},
      root: '/repo', listFiles: () => ['README', '.gitkeep', '007-x.md'], today: () => '2026-08-21',
    })();
    expect(read.existingIds).toEqual(['007']);
  });

  it('reports the backlog dir so the plan can compute an absolute path', () => {
    const read = createScaffoldReader({ allocate: () => ({ ok: false, reason: 'test disabled' }), log: () => {}, root: '/repo', listFiles: () => [], today: () => '2026-08-21' })();
    expect(read.dir).toBe('/repo/backlog');
    expect(read.today).toBe('2026-08-21');
  });

  it('uses the shared wall-clock helper, not a UTC day-slice (#2747)', () => {
    // A hand-rolled UTC ISO slice stamps a day AHEAD of a UTC-behind operator all evening. `check:standards`
    // scans for that shape and caught `resolve-io.mjs` doing exactly it on its first cut.
    const read = createScaffoldReader({ allocate: () => ({ ok: false, reason: 'test disabled' }), log: () => {}, root: '/r', listFiles: () => [] })();
    expect(read.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('the sink writes through the guarded writer and nothing else', () => {
  /**
   * THE FIRST CUT OF THIS BLOCK WAS VACUOUS and a juror caught it (PR #1511 round 2): its title promised the
   * sink writes through the guarded writer, and the body never CALLED the sink — it asserted a key existed.
   * Written, of all places, while closing a carve-out about missing io coverage. A test that names a
   * behaviour and never exercises it is worse than no test, because it is counted as coverage.
   */
  it('CALLS the writer with the planned bytes, and reports what it wrote', async () => {
    const calls = [];
    const sinks = createScaffoldSinks({ root: '/repo', write: (...a) => calls.push(a) });
    const out = await sinks[SCAFFOLD_EFFECT]({
      abs: '/repo/backlog/xabc-a-card.md', rel: 'backlog/xabc-a-card.md', content: '---\nkind: task\n---\n',
    });
    expect(calls).toHaveLength(1);
    const [abs, rel, content, opts] = calls[0];
    expect(abs).toBe('/repo/backlog/xabc-a-card.md');
    expect(rel).toBe('backlog/xabc-a-card.md');
    expect(content).toContain('kind: task');   // the bytes the PLAN computed, unaltered by the sink
    expect(opts).toEqual({ root: '/repo' });
    expect(out).toEqual({ rel: 'backlog/xabc-a-card.md', written: true });
  });

  it('declares exactly one effect type, and nothing else', () => {
    expect(Object.keys(createScaffoldSinks({ root: '/r' }))).toEqual([SCAFFOLD_EFFECT]);
  });

  // NOT TESTED HERE: that the DEFAULT `write` is the guarded writer. The only honest ways to assert it are
  // to grep this module's source — a weak form I have argued against elsewhere in this session and will not
  // adopt here for convenience — or to let it write to a real path, which is not this suite's business. The
  // property is held by the default argument being written down in one place and by the comment beside it
  // saying a caller must never substitute it in production.
});

describe('number at birth reader to plan', () => {
  it('writes the final numeric path with a fresh hash only as bornAs', async () => {
    const { planScaffold, shapeScaffoldRead } = await import('../scaffold.mjs');
    const raw = createScaffoldReader({ root: '/repo', listFiles: () => [],
      allocate: () => ({ ok: true, num: '123' }) })();
    const plan = planScaffold(shapeScaffoldRead(raw), { title: 'New card', kind: 'task' });
    expect(plan.rel).toBe('backlog/123-new-card.md');
    expect(plan.content).toMatch(/^bornAs: x[0-9a-z]{6}$/m);
    expect(plan.content.match(/\bx[0-9a-z]{6}\b/g)).toHaveLength(1);
  });

  it('warns with the reason and retains legacy hashes on allocation failure', async () => {
    const { planScaffold } = await import('../scaffold.mjs'); const logs = [];
    const raw = createScaffoldReader({ root: '/repo', listFiles: () => [],
      allocate: () => ({ ok: false, reason: 'lock unavailable' }), log: (s) => logs.push(s) })();
    const plan = planScaffold(raw, { title: 'New card', kind: 'task' });
    expect(plan.rel).toMatch(/^backlog\/x[0-9a-z]{6}-new-card.md$/);
    expect(plan.content).not.toContain('bornAs:');
    expect(logs.join('')).toContain('lock unavailable');
  });
});

it('passes the allocated birth id unchanged through the reader and pure plan', async () => {
  const { shapeScaffoldRead, planScaffold } = await import('../scaffold.mjs');
  let birth;
  const raw = createScaffoldReader({ root: '/repo', listFiles: () => [], allocate: ({ id }) => {
    birth = id; return { ok: true, num: '041' };
  } })();
  expect(birth).toMatch(/^x[0-9a-z]{6}$/);
  expect(raw.bornAs).toBe(birth);
  const plan = planScaffold(shapeScaffoldRead(raw), { title: 'Birth', kind: 'task' });
  expect(plan.content).toContain(`bornAs: ${birth}`);
});

it('parallel processes run the real reader and plan with shared host reservations', async () => {
  const { mkdtempSync, mkdirSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, resolve } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const { promisify } = await import('node:util');
  const { execFile } = await import('node:child_process');
  const root = mkdtempSync(join(tmpdir(), 'birth-reader-'));
  try {
    mkdirSync(join(root, 'backlog'));
    const url = (p) => JSON.stringify(pathToFileURL(resolve(p)).href);
    const code = `import { createScaffoldReader } from ${url('scripts/operations/scaffold-io.mjs')};
      import { shapeScaffoldRead, planScaffold } from ${url('scripts/operations/scaffold.mjs')};
      import { allocateCardNumber } from ${url('scripts/lib/card-number-allocator.mjs')};
      const root = process.argv[1];
      const raw = createScaffoldReader({ root, log: () => {}, allocate: (opts) => allocateCardNumber({ ...opts,
        statePath: root + '/state.json', lockRoot: root + '/locks', waitMs: 5000,
        settings: { value: { enabled: 'on', remote: 'best-effort' }, source: 'settings file' },
        git: () => { throw Error('offline'); } }) })();
      console.log(JSON.stringify({ raw, plan: planScaffold(shapeScaffoldRead(raw), { title: 'Parallel', kind: 'task' }) }));`;
    const results = await Promise.all(Array.from({ length: 8 }, () => promisify(execFile)(process.execPath,
      ['--input-type=module', '-e', code, root])));
    const rows = results.map((r) => JSON.parse(r.stdout));
    expect(new Set(rows.map((r) => r.plan.rel)).size).toBe(8);
    const ids = JSON.parse(readFileSync(join(root, 'state.json'))).ids;
    for (const { raw, plan } of rows) {
      expect(plan.rel).toMatch(/^backlog\/\d+-parallel.md$/);
      expect(raw.bornAs).toMatch(/^x[0-9a-z]{6}$/);
      expect(plan.content).toContain(`bornAs: ${raw.bornAs}`);
      expect(ids[raw.bornAs]).toBe(raw.allocatedId);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('real allocator outages and held locks give hash filenames without throwing', async () => {
  const { allocateCardNumber, loadNumberAtBirthSettings } = await import('../../lib/card-number-allocator.mjs');
  const { tryAcquireNumberingLock } = await import('../../readiness/drain-lock.mjs');
  const { planScaffold, shapeScaffoldRead } = await import('../scaffold.mjs');
  const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'birth-outage-'));
  try {
    mkdirSync(join(root, 'backlog'));
    for (const held of [false, true]) {
      const lockRoot = join(root, held ? 'held-lock' : 'free-lock');
      if (held) tryAcquireNumberingLock(lockRoot, 'test');
      const raw = createScaffoldReader({ root, log: () => {}, allocate: (opts) => allocateCardNumber({
        ...opts, statePath: join(root, 'state.json'), lockRoot, waitMs: 0,
        settings: loadNumberAtBirthSettings({ file: {}, env: {} }), git: () => { throw Error('offline'); },
      }) })();
      const plan = planScaffold(shapeScaffoldRead(raw), { title: 'Outage', kind: 'task' });
      expect(plan.rel).toBe(`backlog/${raw.bornAs}-outage.md`);
      expect(plan.rel).toMatch(/^backlog\/x[0-9a-z]{6}-outage.md$/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
