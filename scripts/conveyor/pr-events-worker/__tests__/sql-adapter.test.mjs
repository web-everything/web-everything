// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createMemoryStorage } from '../core.mjs';

// Only the platform superclass is replaced. The constructor, migration and SQL
// adapter below are imported from production, without extracting or copying them.
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { PrEventLog } from '../worker.mjs';

let DatabaseSync;
let sqliteUnavailable;
try {
  ({ DatabaseSync } = createRequire(import.meta.url)('node:sqlite'));
  if (!DatabaseSync) throw new Error('node:sqlite has no DatabaseSync');
} catch (error) {
  if (error.code !== 'ERR_UNKNOWN_BUILTIN_MODULE') throw error;
  sqliteUnavailable = `node:sqlite unavailable on ${process.version}: ${error.message}`;
  console.warn(`SKIP real SQLite adapter tests: ${sqliteUnavailable}; memory contract and SQL snapshots still run.`);
}

function sqliteFixture() {
  const db = new DatabaseSync(':memory:');
  const storage = {
    // Durable Object SQL executes at exec(), even if no cursor is consumed.
    sql: { exec(text, ...args) {
      const rows = db.prepare(text).all(...args);
      return { toArray: () => rows };
    } },
    transactionSync(fn) {
      db.exec('BEGIN');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return { db, storage, adapter: () => new PrEventLog({ storage }, {}).storageAdapter };
}

const cases = [
  { name: 'empty table returns zero', rows: [], limits: [2, 0, 2, 0], kept: [], highest: 0 },
  { name: 'exact caps retain every row',
    rows: [[1, 100, false], [2, 100, true], [3, 100, false], [4, 100, true]],
    limits: [2, 0, 2, 0], kept: [1, 2, 3, 4], highest: 0 },
  { name: 'OFFSET keeps exactly the newest N independently per class',
    rows: [[1, 100, true], [2, 100, false], [3, 100, true], [4, 100, false], [5, 100, true], [6, 100, false]],
    limits: [1, 0, 2, 0], kept: [3, 5, 6], highest: 4 },
  { name: 'fact count and age DELETE predicates never remove keep rows',
    rows: [[1, 10, true], [2, 100, false], [3, 10, true], [4, 100, false], [5, 10, false], [6, 100, false]],
    limits: [1, 50, 10, 0], kept: [1, 3, 6], highest: 5 },
  { name: 'zero runtime cap removes runtime rows but preserves facts',
    rows: [[1, 100, false], [2, 100, true], [3, 100, false], [4, 100, true]],
    limits: [2, 0, 0, 0], kept: [1, 3], highest: 4 },
  { name: 'strict class age cutoffs handle unordered timestamps and return max deleted seq',
    rows: [[1, 200, false], [2, 100, true], [3, 199, false], [4, 100, false], [5, 99, true], [6, 200, true]],
    limits: [10, 200, 10, 100], kept: [1, 2, 6], highest: 5 },
  { name: 'age and count combine across both classes',
    rows: [[1, 300, true], [2, 300, false], [3, 99, true], [4, 199, false], [5, 300, true], [6, 300, false]],
    limits: [2, 200, 2, 100], kept: [5, 6], highest: 4 },
];

function assertPrune(adapter, { rows, limits, kept, highest }) {
  for (const [seq, at, keep] of rows) adapter.insert(seq, `delivery-${seq}`, at, JSON.stringify({ seq, keep }), keep);
  expect(adapter.prune(...limits)).toBe(highest);
  expect(adapter.range(0, 100).map(JSON.parse)).toEqual(
    rows.filter(([seq]) => kept.includes(seq)).map(([seq, , keep]) => ({ seq, keep })),
  );
  expect(adapter.prune(...limits)).toBe(0);
}

describe.skipIf(!DatabaseSync)(`production adapter on real in-memory SQLite${sqliteUnavailable ? ` (${sqliteUnavailable})` : ''}`, () => {
  it('replay alone expires the default key and row windows through the production appendRuntime method', () => {
    const fixture = sqliteFixture();
    try {
      const event = { class: 'runtime', type: 'action-requested', repo: 'o/r', number: 1,
        head: 'a'.repeat(40), action: 'review', cause: 1, writer: { role: 'decider' } };
      const object = new PrEventLog({ storage: fixture.storage }, {});
      const boundary = 1 + 60 * 24 * 60 * 60_000;
      expect(object.appendRuntime(event, 1)).toEqual({ seq: 1, duplicate: false });
      expect(object.appendRuntime(event, boundary)).toEqual({ seq: null, duplicate: true });
      const reopened = new PrEventLog({ storage: fixture.storage }, {});
      expect(reopened.appendRuntime(event, boundary + 1)).toEqual({ seq: 2, duplicate: false });
      expect(reopened.appendRuntime(event, boundary + 2)).toEqual({ seq: null, duplicate: true });
      expect(reopened.read(0)).toMatchObject({ head: 2, gap: true, events: [{ ...event, seq: 2 }] });
      expect(fixture.db.prepare('SELECT seq FROM events').all()).toEqual([{ seq: 2 }]);
    } finally { fixture.db.close(); }
  });

  it('migrates a populated legacy table with no keep column, and reopening preserves both classes', () => {
    const fixture = sqliteFixture();
    try {
      fixture.db.exec('CREATE TABLE events (seq INTEGER PRIMARY KEY, delivery_id TEXT, at INTEGER NOT NULL, body TEXT NOT NULL)');
      fixture.db.prepare('INSERT INTO events VALUES (?, ?, ?, ?)').run(1, 'legacy', 100, JSON.stringify({ seq: 1 }));
      expect(fixture.db.prepare('PRAGMA table_info(events)').all().map((column) => column.name)).not.toContain('keep');
      const adapter = fixture.adapter();
      expect(fixture.db.prepare('PRAGMA table_info(events)').all()).toContainEqual(expect.objectContaining({ name: 'keep', notnull: 1, dflt_value: '0' }));
      expect(fixture.db.prepare('SELECT seq, delivery_id, at, body, keep FROM events').all()).toEqual([
        { seq: 1, delivery_id: 'legacy', at: 100, body: '{"seq":1}', keep: 0 },
      ]);
      adapter.insert(2, 'runtime', 100, '{"seq":2}', true);
      fixture.adapter(); // The guarded ALTER must not run again on an upgraded table.
      expect(fixture.db.prepare('SELECT seq, keep FROM events ORDER BY seq').all()).toEqual([{ seq: 1, keep: 0 }, { seq: 2, keep: 1 }]);
    } finally { fixture.db.close(); }
  });

  it.each(cases)('$name', (testCase) => {
    const fixture = sqliteFixture();
    try { assertPrune(fixture.adapter(), testCase); }
    finally { fixture.db.close(); }
  });
});

// These are deliberate fallback contract pins, not evidence of SQLite execution.
// Run them even when SQLite is available so both adapters use identical cases.
describe('existing memory adapter fallback', () => {
  it('defaults legacy inserts to facts and preserves explicit keep rows', () => {
    const adapter = createMemoryStorage();
    adapter.insert(1, 'legacy', 100, '{"seq":1}');
    adapter.insert(2, 'runtime', 100, '{"seq":2}', true);
    expect(adapter._rows().map(({ seq, keep }) => ({ seq, keep }))).toEqual([{ seq: 1, keep: false }, { seq: 2, keep: true }]);
    expect(adapter.prune(0, 200, 1, 0)).toBe(1);
    expect(adapter.range(0, 10)).toEqual(['{"seq":2}']);
  });
  it.each(cases)('$name', (testCase) => assertPrune(createMemoryStorage(), testCase));
});

// A recording cursor is only a SQL-text snapshot fallback; it does not pretend
// to execute SQL. Real schema and query semantics are tested by DatabaseSync above.
function recordingStorage(hasKeep) {
  const calls = [];
  return {
    calls,
    transactionSync: (fn) => fn(),
    sql: { exec(text, ...args) {
      calls.push([text, ...args]);
      let rows = [];
      if (text === 'PRAGMA table_info(events)') rows = hasKeep ? [{ name: 'keep' }] : [];
      if (text.startsWith('ALTER TABLE events')) hasKeep = true;
      if (text === 'SELECT v FROM meta WHERE k = ?') rows = [{ v: '1' }];
      if (text.startsWith('SELECT seq FROM events WHERE keep = 0')) rows = [{ seq: 4 }];
      if (text.startsWith('SELECT seq FROM events WHERE keep = 1')) rows = [{ seq: 3 }];
      if (text.startsWith('SELECT MAX(seq)')) rows = [{ m: 5 }];
      return { toArray: () => rows };
    } },
  };
}

it('snapshots production keep migration SQL and its guard on reopening', () => {
  const storage = recordingStorage(false);
  new PrEventLog({ storage }, {});
  expect(storage.calls.slice(0, 3)).toMatchInlineSnapshot(`
    [
      [
        "CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, delivery_id TEXT, at INTEGER NOT NULL, body TEXT NOT NULL, keep INTEGER NOT NULL DEFAULT 0)",
      ],
      [
        "PRAGMA table_info(events)",
      ],
      [
        "ALTER TABLE events ADD COLUMN keep INTEGER NOT NULL DEFAULT 0",
      ],
    ]
  `);
  storage.calls.length = 0;
  new PrEventLog({ storage }, {});
  expect(storage.calls.some(([sql]) => sql.startsWith('ALTER TABLE'))).toBe(false);
  expect(storage.calls).toContainEqual(['PRAGMA table_info(events)']);
});

it('snapshots production per-class OFFSET, highest-pruned-seq query and keep-predicate DELETE with bindings', () => {
  const storage = recordingStorage(true);
  const adapter = new PrEventLog({ storage }, {}).storageAdapter;
  storage.calls.length = 0;
  expect(adapter.prune(1, 200, 2, 100)).toBe(5);
  expect(storage.calls).toMatchInlineSnapshot(`
    [
      [
        "SELECT seq FROM events WHERE keep = 0 ORDER BY seq DESC LIMIT 1 OFFSET ?",
        1,
      ],
      [
        "SELECT seq FROM events WHERE keep = 1 ORDER BY seq DESC LIMIT 1 OFFSET ?",
        2,
      ],
      [
        "SELECT MAX(seq) AS m FROM events WHERE (keep = 0 AND (seq <= ? OR at < ?)) OR (keep = 1 AND (seq <= ? OR at < ?))",
        4,
        200,
        3,
        100,
      ],
      [
        "DELETE FROM events WHERE (keep = 0 AND (seq <= ? OR at < ?)) OR (keep = 1 AND (seq <= ? OR at < ?))",
        4,
        200,
        3,
        100,
      ],
    ]
  `);
});
