/**
 * @file scripts/conveyor/pr-events-worker/worker.mjs
 * @description The Cloudflare Worker shell for the PR-events receiver. All routing, signature and cursor logic
 * is in `./core.mjs` (unit-tested in Node); this file only binds it to Cloudflare:
 *   • `PrEventLog` — a SQLite-backed Durable Object, ONE instance (`idFromName('global')`). A single-threaded
 *     writer is what makes `seq` strictly monotonic with no locking; SQLite storage needs no pre-created
 *     resource (unlike D1/KV) — only the `[[migrations]]` entry in `wrangler.toml`.
 *   • `fetch` — hands `core.handleRequest` a log whose methods are RPC calls to that object.
 *
 * Bindings (see `wrangler.toml`): PR_EVENT_LOG (Durable Object), secrets GITHUB_WEBHOOK_SECRET and
 * PR_EVENTS_READ_TOKEN — set with `wrangler secret put`, never in code or config.
 */
import { DurableObject } from 'cloudflare:workers';
import { createEventLog, handleRequest } from './core.mjs';

function sqlStorage(storage) {
  const sql = storage.sql;
  sql.exec(`CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, delivery_id TEXT, at INTEGER NOT NULL, body TEXT NOT NULL)`);
  sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS events_delivery ON events(delivery_id) WHERE delivery_id IS NOT NULL`);
  sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`);
  sql.exec('CREATE TABLE IF NOT EXISTS projection (bucket TEXT, k TEXT, body TEXT NOT NULL, PRIMARY KEY (bucket, k))');
  return {
    transaction: (fn) => storage.transactionSync(fn),
    getProjection: (bucket, key) => JSON.parse(sql.exec('SELECT body FROM projection WHERE bucket = ? AND k = ?', bucket, key).toArray()[0]?.body || 'null'),
    putProjection: (bucket, key, value) => { sql.exec('INSERT INTO projection VALUES (?, ?, ?) ON CONFLICT(bucket, k) DO UPDATE SET body = excluded.body', bucket, key, JSON.stringify(value)); },
    listProjection: (bucket) => sql.exec('SELECT body FROM projection WHERE bucket = ? ORDER BY k', bucket).toArray().map((r) => JSON.parse(r.body)),
    getMeta: (k) => sql.exec('SELECT v FROM meta WHERE k = ?', k).toArray()[0]?.v ?? null,
    setMeta: (k, v) => { sql.exec('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, v); },
    hasDelivery: (id) => sql.exec('SELECT 1 FROM events WHERE delivery_id = ? LIMIT 1', id).toArray().length > 0,
    insert: (seq, id, at, body) => { sql.exec('INSERT INTO events (seq, delivery_id, at, body) VALUES (?, ?, ?, ?)', seq, id, at, body); },
    range: (after, limit) => sql.exec('SELECT body FROM events WHERE seq > ? ORDER BY seq LIMIT ?', after, limit).toArray().map((r) => r.body),
    minSeq: () => sql.exec('SELECT MIN(seq) AS m FROM events').toArray()[0]?.m ?? null,
    prune: (throughSeq, olderThanMs) => { sql.exec('DELETE FROM events WHERE seq <= ? OR at < ?', throughSeq, olderThanMs); },
  };
}

export class PrEventLog extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.storageAdapter = sqlStorage(ctx.storage);
    this.log = createEventLog(this.storageAdapter);
  }
  append(record, now) { return this.log.append(record, now); }
  readPrs(cursor, limit, now) { return this.log.readPrs(cursor, limit, now); }
  bootstrap(input, now) { return this.log.bootstrap(input, now); }
  touch(now) { return this.log.touch(now); }
  read(cursor, limit) { return this.log.read(cursor, limit); }
}

export default {
  async fetch(request, env) {
    const getLog = () => env.PR_EVENT_LOG.get(env.PR_EVENT_LOG.idFromName('global'));
    return handleRequest(request, env, { getLog });
  },
};
